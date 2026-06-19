// review-surfaces.CONFIG_FACTS.4/.5 — deterministic Apple config + project-structure
// facts: high-signal Info.plist / entitlement / privacy-manifest / xcconfig changes,
// and Xcode target / scheme / test-plan / generator-drift changes. Bounded and
// conservative: a binary plist infers no absence; uncertain XcodeGen-vs-generated
// drift is advisory, never a blocker (goal contract D10). Reuses the ConfigFact
// shape + the existing lenses via configFactLens.

import { ConfigFact } from "./config-facts";
import { StructuredDiff } from "../pr/contract";
import { isAppleGeneratedPath } from "../collector/source-kind";
import { redactSecrets } from "../privacy/secrets";
import { readPlist } from "../collector/apple-project/plist";
import { parseXcodegenProject } from "../collector/apple-project/xcodegen";
import { parsePbxproj } from "../collector/apple-project/pbxproj";
import { parseScheme } from "../collector/apple-project/scheme";
import { parseTestPlan } from "../collector/apple-project/test-plan";
import { AppleTarget } from "../collector/apple-project/model";

export interface ComputeAppleConfigFactsInput {
  diff: StructuredDiff;
  readBase: (filePath: string) => string | undefined;
  readHead: (filePath: string) => string | undefined;
}

// Build settings whose change a reviewer must see (xcconfig + project.yml).
const WATCHED_BUILD_SETTINGS = [
  "IPHONEOS_DEPLOYMENT_TARGET",
  "MACOSX_DEPLOYMENT_TARGET",
  "SWIFT_VERSION",
  "SWIFT_STRICT_CONCURRENCY",
  "ENABLE_TESTABILITY",
  "APPLICATION_EXTENSION_API_ONLY",
  "CODE_SIGN_ENTITLEMENTS",
  "SWIFT_ACTIVE_COMPILATION_CONDITIONS",
  "OTHER_SWIFT_FLAGS"
];

// Info.plist keys that carry privacy/transport/capability signal (Info.plist also
// holds many benign keys, so only these are diffed).
const PRIVACY_PLIST_KEY = /UsageDescription$|^NSAppTransportSecurity$|^CFBundleURLTypes$|^UIBackgroundModes$|^NSPrivacyTracking$|^NSPrivacyTrackingDomains$|^NSPrivacyAccessedAPITypes$|^NSPrivacyCollectedDataTypes$/;

function isPlistPath(p: string): boolean {
  return /\.plist$/i.test(p) && !/\.entitlements$/i.test(p);
}
function isEntitlementsPath(p: string): boolean {
  return /\.entitlements$/i.test(p);
}
function isPrivacyManifestPath(p: string): boolean {
  return /(^|\/)PrivacyInfo\.xcprivacy$/.test(p) || /\.xcprivacy$/i.test(p);
}
function isXcconfigPath(p: string): boolean {
  return /\.xcconfig$/i.test(p);
}
function isXcodegenPath(p: string): boolean {
  return /(^|\/)project\.ya?ml$/.test(p);
}
function isPbxprojPath(p: string): boolean {
  return p.endsWith(".xcodeproj/project.pbxproj");
}
function isSchemePath(p: string): boolean {
  return /\.xcscheme$/.test(p);
}
function isTestPlanPath(p: string): boolean {
  return /\.xctestplan$/.test(p);
}

export function computeAppleConfigFacts(input: ComputeAppleConfigFactsInput): ConfigFact[] {
  const facts: ConfigFact[] = [];
  const base = (file: { path: string; old_path?: string }): string | undefined => input.readBase(file.old_path ?? file.path);
  const head = (file: { path: string }): string | undefined => input.readHead(file.path);

  for (const file of input.diff.files) {
    // A generated Apple bundle (e.g. `Build/App.xcarchive/Info.plist`,
    // `TestResults.xcresult/Info.plist`) is build output — never a review-focus config
    // change, so it must not produce a high-priority privacy/ATS item.
    if (isAppleGeneratedPath(file.path)) {
      continue;
    }
    const b = base(file);
    const h = head(file);
    if (isPrivacyManifestPath(file.path)) {
      facts.push(...privacyManifestFacts(file.path, b, h));
    } else if (isEntitlementsPath(file.path)) {
      facts.push(...entitlementFacts(file.path, b, h));
    } else if (isPlistPath(file.path)) {
      facts.push(...infoPlistFacts(file.path, b, h));
    } else if (isXcconfigPath(file.path)) {
      facts.push(...xcconfigFacts(file.path, b, h));
    } else if (isXcodegenPath(file.path)) {
      facts.push(...xcodegenStructureFacts(file.path, b, h));
    } else if (isPbxprojPath(file.path)) {
      facts.push(...pbxStructureFacts(file.path, b, h));
    } else if (isSchemePath(file.path)) {
      facts.push(...schemeFacts(file.path, b, h));
    } else if (isTestPlanPath(file.path)) {
      facts.push(...testPlanFacts(file.path, b, h));
    }
  }
  facts.push(...driftFacts(input));
  facts.sort((a, b2) => (a.path < b2.path ? -1 : a.path > b2.path ? 1 : 0) || (a.kind < b2.kind ? -1 : a.kind > b2.kind ? 1 : 0) || (a.detail < b2.detail ? -1 : 1));
  return facts;
}

function diffSets<T>(base: Set<T>, head: Set<T>): { added: T[]; removed: T[] } {
  return {
    added: [...head].filter((x) => !base.has(x)).sort(),
    removed: [...base].filter((x) => !head.has(x)).sort()
  };
}

// --- Info.plist (CONFIG_FACTS.4) --------------------------------------------

// A binary plist (or any unreadable side) must carry an explicit UNKNOWN diagnostic, not
// silently look like "no change" (goal contract D10).
function binaryPlistDiagnostic(path: string, baseView: { binary: boolean } | undefined, headView: { binary: boolean } | undefined): ConfigFact[] {
  if (baseView?.binary || headView?.binary) {
    return [{ kind: "ios_config_unparsed", path, detail: `\`${path}\` is a BINARY plist — its keys/values could not be inspected; review the change manually (no key absence is inferred).` }];
  }
  return [];
}

function infoPlistFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  const baseView = baseText !== undefined ? readPlist(baseText) : undefined;
  const headView = headText !== undefined ? readPlist(headText) : undefined;
  const diagnostic = binaryPlistDiagnostic(path, baseView, headView);
  if (diagnostic.length > 0) {
    return diagnostic; // binary on a side: do not infer absence, but surface the gap.
  }
  const facts: ConfigFact[] = [];
  const baseKeys = new Set([...(baseView?.keys ?? [])].filter((k) => PRIVACY_PLIST_KEY.test(k)));
  const headKeys = new Set([...(headView?.keys ?? [])].filter((k) => PRIVACY_PLIST_KEY.test(k)));
  const { added, removed } = diffSets(baseKeys, headKeys);
  for (const key of added) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `Info.plist adds privacy/transport key \`${key}\`` });
  }
  for (const key of removed) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `Info.plist removes privacy/transport key \`${key}\`` });
  }
  // A change UNDER an existing watched key (e.g. a new entry in NSPrivacyAccessedAPITypes,
  // an added domain) — key set unchanged, value fingerprint differs.
  for (const key of [...baseKeys].filter((k) => headKeys.has(k)).sort()) {
    if (baseView?.valueFingerprint(key) !== headView?.valueFingerprint(key)) {
      facts.push({ kind: "ios_privacy_capability_change", path, detail: `Info.plist changes the value of privacy/transport key \`${key}\`` });
    }
  }
  // App Transport Security: arbitrary loads turned on is a transport broadening.
  const baseAts = baseView?.bool("NSAllowsArbitraryLoads");
  const headAts = headView?.bool("NSAllowsArbitraryLoads");
  if (headAts === true && baseAts !== true) {
    facts.push({ kind: "ios_ats_broadened", path, detail: "App Transport Security NSAllowsArbitraryLoads enabled — arbitrary HTTP loads are now allowed" });
  }
  return facts;
}

// --- entitlements (CONFIG_FACTS.4) ------------------------------------------

function entitlementFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  const baseView = baseText !== undefined ? readPlist(baseText) : undefined;
  const headView = headText !== undefined ? readPlist(headText) : undefined;
  const diagnostic = binaryPlistDiagnostic(path, baseView, headView);
  if (diagnostic.length > 0) {
    return diagnostic;
  }
  const baseKeys = baseView?.keys ?? new Set<string>();
  const headKeys = headView?.keys ?? new Set<string>();
  const { added, removed } = diffSets(baseKeys, headKeys);
  const facts: ConfigFact[] = [];
  for (const key of added) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `entitlement \`${key}\` added` });
  }
  for (const key of removed) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `entitlement \`${key}\` removed` });
  }
  // A change to an existing entitlement's value (a new app group / keychain group /
  // associated domain under the same key).
  for (const key of [...baseKeys].filter((k) => headKeys.has(k)).sort()) {
    if (baseView?.valueFingerprint(key) !== headView?.valueFingerprint(key)) {
      facts.push({ kind: "ios_privacy_capability_change", path, detail: `entitlement \`${key}\` value changed` });
    }
  }
  return facts;
}

// --- privacy manifest (CONFIG_FACTS.4) --------------------------------------

function privacyManifestFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  const baseView = baseText !== undefined ? readPlist(baseText) : undefined;
  const headView = headText !== undefined ? readPlist(headText) : undefined;
  const diagnostic = binaryPlistDiagnostic(path, baseView, headView);
  if (diagnostic.length > 0) {
    return diagnostic;
  }
  const facts: ConfigFact[] = [];
  const baseTracking = baseView?.bool("NSPrivacyTracking");
  const headTracking = headView?.bool("NSPrivacyTracking");
  if (headTracking !== undefined && headTracking !== baseTracking) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `privacy manifest NSPrivacyTracking ${baseTracking ? "true" : "false/unset"} → ${headTracking ? "true" : "false"}` });
  }
  const baseKeys = baseView?.keys ?? new Set<string>();
  const headKeys = headView?.keys ?? new Set<string>();
  const watched = (k: string): boolean => /Tracking|AccessedAPI|CollectedData/.test(k);
  const { added, removed } = diffSets(baseKeys, headKeys);
  for (const key of added.filter(watched)) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `privacy manifest adds \`${key}\`` });
  }
  for (const key of removed.filter(watched)) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `privacy manifest removes \`${key}\`` });
  }
  // A changed REASON/entry under an existing required-reason / collected-data key.
  for (const key of [...baseKeys].filter((k) => headKeys.has(k) && watched(k)).sort()) {
    if (baseView?.valueFingerprint(key) !== headView?.valueFingerprint(key)) {
      facts.push({ kind: "ios_privacy_capability_change", path, detail: `privacy manifest changes entries under \`${key}\`` });
    }
  }
  return facts;
}

// --- xcconfig build settings (CONFIG_FACTS.4) -------------------------------

function parseXcconfig(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split("\n")) {
    // The setting name may carry an Xcode condition suffix (`SETTING[sdk=iphoneos*]`);
    // key the change on the BASE setting name (the condition is part of the value detail).
    const match = /^\s*([A-Z][A-Z0-9_]*)(\[[^\]]*\])?\s*=\s*(.*?)\s*$/.exec(line.replace(/\/\/.*$/, ""));
    if (match) {
      const key = match[1];
      const value = `${match[2] ?? ""}${match[2] ? " " : ""}${match[3]}`.trim();
      // Concatenate multiple conditional assignments of the same setting so any change is
      // observed (e.g. a per-sdk override changing).
      result.set(key, result.has(key) ? `${result.get(key)} ; ${value}` : value);
    }
  }
  return result;
}

function xcconfigFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  const base = baseText !== undefined ? parseXcconfig(baseText) : new Map<string, string>();
  const head = headText !== undefined ? parseXcconfig(headText) : new Map<string, string>();
  const facts: ConfigFact[] = [];
  for (const key of WATCHED_BUILD_SETTINGS) {
    const b = base.get(key);
    const h = head.get(key);
    if (b !== h && (b !== undefined || h !== undefined)) {
      // Values can carry credential-like tokens (`OTHER_SWIFT_FLAGS = -DAPI_KEY=…`), so
      // redact before the detail is persisted/posted.
      facts.push({ kind: "ios_build_setting_change", path, detail: `${key} ${redactSecrets(b ?? "unset").text} → ${redactSecrets(h ?? "unset").text}` });
    }
  }
  return facts;
}

// --- XcodeGen project.yml structure + settings (CONFIG_FACTS.5/.4) ----------

function targetMap(targets: AppleTarget[]): Map<string, AppleTarget> {
  return new Map(targets.map((t) => [t.name, t]));
}

// Project-level build settings (CONFIG_FACTS.4) parsed directly from the project text:
// pbxproj `KEY = value;` in XCBuildConfiguration, XcodeGen `KEY: value` under settings.
// Multiple assignments of a setting are concatenated so any change is observed.
function projectBuildSettings(text: string, yaml: boolean): Map<string, string> {
  const result = new Map<string, string>();
  for (const key of WATCHED_BUILD_SETTINGS) {
    const re = yaml ? new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*(.+)`, "g") : new RegExp(`\\b${key}\\s*=\\s*([^;\\n]+)`, "g");
    const values = [...text.matchAll(re)].map((m) => m[1].trim().replace(/^["']|["',;]+$/g, "").trim());
    if (values.length > 0) {
      result.set(key, [...new Set(values)].sort().join(" ; "));
    }
  }
  return result;
}

function buildSettingFacts(path: string, baseText: string | undefined, headText: string | undefined, yaml: boolean): ConfigFact[] {
  const base = baseText !== undefined ? projectBuildSettings(baseText, yaml) : new Map<string, string>();
  const head = headText !== undefined ? projectBuildSettings(headText, yaml) : new Map<string, string>();
  const facts: ConfigFact[] = [];
  for (const key of WATCHED_BUILD_SETTINGS) {
    const b = base.get(key);
    const h = head.get(key);
    if (b !== h && (b !== undefined || h !== undefined)) {
      facts.push({ kind: "ios_build_setting_change", path, detail: `${key} ${redactSecrets(b ?? "unset").text} → ${redactSecrets(h ?? "unset").text}` });
    }
  }
  return facts;
}

function xcodegenStructureFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  const baseParse = baseText !== undefined ? parseXcodegenProject(path, baseText) : undefined;
  const headParse = headText !== undefined ? parseXcodegenProject(path, headText) : undefined;
  const basePresentUnparsed = baseText !== undefined && !baseParse?.isXcodegen;
  const headPresentUnparsed = headText !== undefined && !headParse?.isXcodegen;
  if (basePresentUnparsed && headPresentUnparsed) {
    return []; // not an XcodeGen project on either side — no structure facts.
  }
  if (basePresentUnparsed || headPresentUnparsed) {
    // One side parses, the other present side does not — never infer all-removed/added.
    return [{ kind: "ios_config_unparsed", path, detail: `\`${path}\` could not be parsed as XcodeGen on one side — target/structure changes were not inferred.` }];
  }
  const base = targetMap(baseParse?.targets ?? []);
  const head = targetMap(headParse?.targets ?? []);
  return [...structureFactsFromTargets(path, base, head), ...buildSettingFacts(path, baseText, headText, true)];
}

function pbxStructureFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  const baseParse = baseText !== undefined ? parsePbxproj(path, baseText) : undefined;
  const headParse = headText !== undefined ? parsePbxproj(path, headText) : undefined;
  const basePresentUnparsed = baseText !== undefined && !baseParse?.parsed;
  const headPresentUnparsed = headText !== undefined && !headParse?.parsed;
  if (basePresentUnparsed || headPresentUnparsed) {
    // A present pbxproj that the bounded parser could not read — emit an UNKNOWN
    // diagnostic rather than treating every target as removed/added (goal contract D10).
    return [{ kind: "ios_config_unparsed", path, detail: `\`${path}\` could not be parsed — target/structure changes were not inferred.` }];
  }
  const base = targetMap(baseParse?.targets ?? []);
  const head = targetMap(headParse?.targets ?? []);
  return [...structureFactsFromTargets(path, base, head), ...buildSettingFacts(path, baseText, headText, false)];
}

function structureFactsFromTargets(path: string, base: Map<string, AppleTarget>, head: Map<string, AppleTarget>): ConfigFact[] {
  const facts: ConfigFact[] = [];
  const isTestKind = (t: AppleTarget | undefined): boolean => t?.kind === "unit_test" || t?.kind === "ui_test";
  for (const name of new Set([...base.keys(), ...head.keys()])) {
    const b = base.get(name);
    const h = head.get(name);
    if (b && !h) {
      if (isTestKind(b)) {
        facts.push({ kind: "ios_test_structure_change", path, detail: `test target \`${name}\` removed` });
      } else {
        facts.push({ kind: "ios_target_structure_change", path, detail: `target \`${name}\` removed` });
      }
      continue;
    }
    if (!b && h) {
      facts.push({ kind: "ios_target_structure_change", path, detail: `target \`${name}\` added (${h.kind})` });
      continue;
    }
    if (!b || !h) {
      continue;
    }
    if (b.kind !== h.kind) {
      facts.push({ kind: "ios_target_structure_change", path, detail: `target \`${name}\` kind ${b.kind} → ${h.kind}` });
    }
    // review-surfaces.CONFIG_FACTS.5: a source REMOVED from a target, or an app<->test
    // DEPENDENCY dropped, is a structure regression even when the kind is unchanged.
    const src = diffSets(new Set(b.source_paths), new Set(h.source_paths));
    if (src.added.length > 0 || src.removed.length > 0) {
      facts.push({ kind: isTestKind(h) ? "ios_test_structure_change" : "ios_target_structure_change", path, detail: `target \`${name}\` source membership changed (added ${src.added.length}, removed ${src.removed.length})` });
    }
    const dep = diffSets(new Set(b.dependency_target_ids), new Set(h.dependency_target_ids));
    if (dep.added.length > 0 || dep.removed.length > 0) {
      // A TEST target dropping a dependency (e.g. on the app under test) is test-evidence
      // relevant, not just architecture.
      facts.push({ kind: isTestKind(h) ? "ios_test_structure_change" : "ios_target_structure_change", path, detail: `target \`${name}\` dependencies changed: ${[...dep.added.map((d) => `+${d}`), ...dep.removed.map((d) => `-${d}`)].join(" ")}` });
    }
  }
  return facts;
}

// --- scheme + test-plan test structure (CONFIG_FACTS.5) ---------------------

function schemeFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  const base = baseText !== undefined ? parseScheme(path, baseText) : undefined;
  const head = headText !== undefined ? parseScheme(path, headText) : undefined;
  const facts: ConfigFact[] = [];
  const baseTargets = new Set(base?.test_target_ids ?? []);
  const headTargets = new Set(head?.test_target_ids ?? []);
  for (const removed of [...baseTargets].filter((t) => !headTargets.has(t)).sort()) {
    facts.push({ kind: "ios_test_structure_change", path, detail: `scheme test target \`${removed}\` removed from the test action` });
  }
  const basePlans = new Set(base?.test_plan_paths ?? []);
  const headPlans = new Set(head?.test_plan_paths ?? []);
  for (const removed of [...basePlans].filter((p) => !headPlans.has(p)).sort()) {
    facts.push({ kind: "ios_test_structure_change", path, detail: `scheme test plan \`${removed}\` removed` });
  }
  return facts;
}

function testPlanFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  // A present side that is not valid JSON is an unsupported/malformed test plan — emit an
  // UNKNOWN diagnostic rather than letting the empty parse look like "all targets removed".
  const malformed = (text: string | undefined): boolean => {
    if (text === undefined || text.trim() === "") {
      return false;
    }
    try {
      JSON.parse(text);
      return false;
    } catch {
      return true;
    }
  };
  if (malformed(baseText) || malformed(headText)) {
    return [{ kind: "ios_config_unparsed", path, detail: `\`${path}\` is not valid JSON — test-plan changes were not inferred.` }];
  }
  const base = baseText !== undefined ? parseTestPlan(path, baseText) : undefined;
  const head = headText !== undefined ? parseTestPlan(path, headText) : undefined;
  const facts: ConfigFact[] = [];
  const baseTargets = new Set(base?.test_target_ids ?? []);
  const headTargets = new Set(head?.test_target_ids ?? []);
  for (const removed of [...baseTargets].filter((t) => !headTargets.has(t)).sort()) {
    facts.push({ kind: "ios_test_structure_change", path, detail: `test plan selected target \`${removed}\` removed or disabled` });
  }
  const baseSkips = new Set(base?.skipped_tests ?? []);
  const headSkips = new Set(head?.skipped_tests ?? []);
  for (const added of [...headSkips].filter((s) => !baseSkips.has(s)).sort()) {
    facts.push({ kind: "ios_test_structure_change", path, detail: `test plan newly skips \`${added}\`` });
  }
  // review-surfaces.CONFIG_FACTS.5: a newly-added `selectedTests` entry NARROWS the run
  // to a subset (a focus) even with the same enabled target and no new skips.
  const baseSelected = new Set(base?.selected_tests ?? []);
  const headSelected = new Set(head?.selected_tests ?? []);
  for (const added of [...headSelected].filter((s) => !baseSelected.has(s)).sort()) {
    facts.push({ kind: "ios_test_structure_change", path, detail: `test plan now narrows the run to selected test \`${added}\` (focused selection)` });
  }
  return facts;
}

// --- XcodeGen-vs-generated drift (CONFIG_FACTS.5) ---------------------------

function driftFacts(input: ComputeAppleConfigFactsInput): ConfigFact[] {
  // Compare HEAD project.yml intent against the generated pbxproj observed output, PAIRED
  // BY PROJECT DIRECTORY so an unrelated `mac/Mac.xcodeproj` is never compared against
  // `ios/project.yml`. (Detecting drift when only ONE side is in the diff needs the full
  // repo file list, which this fact path does not receive — bounded to changed pairs.)
  const ymlDir = (p: string): string => p.replace(/(?:^|\/)project\.ya?ml$/, "");
  const pbxDir = (p: string): string => p.replace(/(?:^|\/)[^/]+\.xcodeproj\/project\.pbxproj$/, "");
  const ymls = input.diff.files.filter((f) => isXcodegenPath(f.path));
  const pbxs = input.diff.files.filter((f) => isPbxprojPath(f.path));
  const facts: ConfigFact[] = [];
  // The set of drifting target names for a given yml/pbxproj content pair, or undefined
  // when a side is missing/unparseable (no drift guess).
  const driftOf = (ymlPath: string, pbxPath: string, ymlText: string | undefined, pbxText: string | undefined): { intentOnly: Set<string>; observedOnly: Set<string> } | undefined => {
    if (ymlText === undefined || pbxText === undefined) {
      return undefined;
    }
    const intentParse = parseXcodegenProject(ymlPath, ymlText);
    const observedParse = parsePbxproj(pbxPath, pbxText);
    if (!intentParse.isXcodegen || !observedParse.parsed) {
      return undefined;
    }
    const intent = new Set(intentParse.targets.map((t) => t.name));
    const observed = new Set(observedParse.targets.map((t) => t.name));
    if (intent.size === 0 || observed.size === 0) {
      return undefined;
    }
    return {
      intentOnly: new Set([...intent].filter((n) => !observed.has(n))),
      observedOnly: new Set([...observed].filter((n) => !intent.has(n)))
    };
  };
  for (const ymlFile of ymls) {
    const dir = ymlDir(ymlFile.path);
    const pbxFile = pbxs.find((p) => pbxDir(p.path) === dir);
    if (!pbxFile) {
      continue;
    }
    const headDrift = driftOf(ymlFile.path, pbxFile.path, input.readHead(ymlFile.path), input.readHead(pbxFile.path));
    if (!headDrift) {
      continue;
    }
    // Only report drift this PR INTRODUCED — drift already present in the base (the repo
    // was already out of sync) is not this change's regression.
    const baseDrift = driftOf(ymlFile.path, pbxFile.path, input.readBase(ymlFile.old_path ?? ymlFile.path), input.readBase(pbxFile.old_path ?? pbxFile.path));
    for (const name of [...headDrift.intentOnly].filter((n) => !baseDrift?.intentOnly.has(n)).sort()) {
      facts.push({ kind: "ios_generator_drift", path: ymlFile.path, detail: `target \`${name}\` is in ${ymlFile.path} but not the generated project (${pbxFile.path}) — possible generated-project drift; run the repository drift check` });
    }
    for (const name of [...headDrift.observedOnly].filter((n) => !baseDrift?.observedOnly.has(n)).sort()) {
      facts.push({ kind: "ios_generator_drift", path: pbxFile.path, detail: `target \`${name}\` is in the generated project (${pbxFile.path}) but not ${ymlFile.path} — possible generated-project drift; run the repository drift check` });
    }
  }
  return facts;
}
