// review-surfaces.CONFIG_FACTS.4/.5 — deterministic Apple config + project-structure
// facts: high-signal Info.plist / entitlement / privacy-manifest / xcconfig changes,
// and Xcode target / scheme / test-plan / generator-drift changes. Bounded and
// conservative: a binary plist infers no absence; uncertain XcodeGen-vs-generated
// drift is advisory, never a blocker (goal contract D10). Reuses the ConfigFact
// shape + the existing lenses via configFactLens.

import { ConfigFact } from "./config-facts";
import { StructuredDiff } from "../pr/contract";
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
  return p === "project.yml" || p.endsWith("/project.yml");
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

function infoPlistFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  const baseView = baseText !== undefined ? readPlist(baseText) : undefined;
  const headView = headText !== undefined ? readPlist(headText) : undefined;
  // A binary plist on either side: do not infer absence (no fact).
  if (baseView?.binary || headView?.binary) {
    return [];
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
  if (baseView?.binary || headView?.binary) {
    return [];
  }
  const { added, removed } = diffSets(baseView?.keys ?? new Set<string>(), headView?.keys ?? new Set<string>());
  const facts: ConfigFact[] = [];
  for (const key of added) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `entitlement \`${key}\` added` });
  }
  for (const key of removed) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `entitlement \`${key}\` removed` });
  }
  return facts;
}

// --- privacy manifest (CONFIG_FACTS.4) --------------------------------------

function privacyManifestFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  const baseView = baseText !== undefined ? readPlist(baseText) : undefined;
  const headView = headText !== undefined ? readPlist(headText) : undefined;
  if (baseView?.binary || headView?.binary) {
    return [];
  }
  const facts: ConfigFact[] = [];
  const baseTracking = baseView?.bool("NSPrivacyTracking");
  const headTracking = headView?.bool("NSPrivacyTracking");
  if (headTracking !== undefined && headTracking !== baseTracking) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `privacy manifest NSPrivacyTracking ${baseTracking ? "true" : "false/unset"} → ${headTracking ? "true" : "false"}` });
  }
  const { added, removed } = diffSets(baseView?.keys ?? new Set<string>(), headView?.keys ?? new Set<string>());
  for (const key of added.filter((k) => /Tracking|AccessedAPI|CollectedData/.test(k))) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `privacy manifest adds \`${key}\`` });
  }
  for (const key of removed.filter((k) => /Tracking|AccessedAPI|CollectedData/.test(k))) {
    facts.push({ kind: "ios_privacy_capability_change", path, detail: `privacy manifest removes \`${key}\`` });
  }
  return facts;
}

// --- xcconfig build settings (CONFIG_FACTS.4) -------------------------------

function parseXcconfig(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line.replace(/\/\/.*$/, ""));
    if (match) {
      result.set(match[1], match[2]);
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
      facts.push({ kind: "ios_build_setting_change", path, detail: `${key} ${b ?? "unset"} → ${h ?? "unset"}` });
    }
  }
  return facts;
}

// --- XcodeGen project.yml structure + settings (CONFIG_FACTS.5/.4) ----------

function targetMap(targets: AppleTarget[]): Map<string, AppleTarget> {
  return new Map(targets.map((t) => [t.name, t]));
}

function xcodegenStructureFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  const base = baseText !== undefined ? targetMap(parseXcodegenProject(path, baseText).targets) : new Map<string, AppleTarget>();
  const head = headText !== undefined ? targetMap(parseXcodegenProject(path, headText).targets) : new Map<string, AppleTarget>();
  return structureFactsFromTargets(path, base, head);
}

function pbxStructureFacts(path: string, baseText: string | undefined, headText: string | undefined): ConfigFact[] {
  const base = baseText !== undefined ? targetMap(parsePbxproj(path, baseText).targets) : new Map<string, AppleTarget>();
  const head = headText !== undefined ? targetMap(parsePbxproj(path, headText).targets) : new Map<string, AppleTarget>();
  return structureFactsFromTargets(path, base, head);
}

function structureFactsFromTargets(path: string, base: Map<string, AppleTarget>, head: Map<string, AppleTarget>): ConfigFact[] {
  const facts: ConfigFact[] = [];
  for (const name of new Set([...base.keys(), ...head.keys()])) {
    const b = base.get(name);
    const h = head.get(name);
    const isTestKind = (t: AppleTarget | undefined): boolean => t?.kind === "unit_test" || t?.kind === "ui_test";
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
    if (b && h && b.kind !== h.kind) {
      facts.push({ kind: "ios_target_structure_change", path, detail: `target \`${name}\` kind ${b.kind} → ${h.kind}` });
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
  return facts;
}

// --- XcodeGen-vs-generated drift (CONFIG_FACTS.5) ---------------------------

function driftFacts(input: ComputeAppleConfigFactsInput): ConfigFact[] {
  // Compare HEAD project.yml intent against HEAD pbxproj observed output when BOTH
  // are in the diff. A target only in one side is advisory possible drift.
  const ymlFile = input.diff.files.find((f) => isXcodegenPath(f.path));
  const pbxFile = input.diff.files.find((f) => isPbxprojPath(f.path));
  if (!ymlFile || !pbxFile) {
    return [];
  }
  const ymlText = input.readHead(ymlFile.path);
  const pbxText = input.readHead(pbxFile.path);
  if (ymlText === undefined || pbxText === undefined) {
    return [];
  }
  const intent = new Set(parseXcodegenProject(ymlFile.path, ymlText).targets.map((t) => t.name));
  const observed = new Set(parsePbxproj(pbxFile.path, pbxText).targets.map((t) => t.name));
  if (intent.size === 0 || observed.size === 0) {
    return [];
  }
  const facts: ConfigFact[] = [];
  for (const name of [...intent].filter((n) => !observed.has(n)).sort()) {
    facts.push({ kind: "ios_generator_drift", path: ymlFile.path, detail: `target \`${name}\` is in project.yml but not the generated project — possible generated-project drift; run the repository drift check` });
  }
  for (const name of [...observed].filter((n) => !intent.has(n)).sort()) {
    facts.push({ kind: "ios_generator_drift", path: pbxFile.path, detail: `target \`${name}\` is in the generated project but not project.yml — possible generated-project drift; run the repository drift check` });
  }
  return facts;
}
