// review-surfaces.METHODOLOGY.8 (D6, Phase 3a): the DETERMINISTIC cross-reference
// audit. Where the Phase-2 LLM leaf PROPOSES the four absence signals (and only when
// a provider runs), this fires them OFFLINE by cross-referencing the diff — and the
// deterministic semantic/dependency/config FACTS computed on the collection — with
// the conversation: a changed-file CATEGORY with NO corresponding NATURAL-LANGUAGE
// discussion. Each signal is ADVISORY (the absence heuristic alone never moves the
// verdict, D5) UNLESS an INDEPENDENT deterministic FACT also fires (a secret finding,
// a backward-incompatible API/schema change, a test-weakening, a real dependency/
// config change) — then it is promoted to a non-advisory finding. Output appends to
// methodology.workflow_findings; it never writes risks.items (which would duplicate
// the risk-lens findings).
import { CollectionResult } from "../collector/collect";
import { commandLooksLikeTestCommand } from "../commands/classify";
import { ConversationEvent } from "../conversation/events";
import { EvidenceRef } from "../evidence/evidence";
import { ConfigFact, ConfigFactKind } from "../risks/config-facts";
import { SemanticChangeFacts } from "../risks/semantic-diff";
import { isTestPath } from "../scope/pr-scope";
import { PacketSeverity, PacketWorkflowSignalKind } from "../schema/review-packet-contract";
import { WorkflowFinding } from "./methodology";

interface ChangedFileLike {
  path: string;
  status: string;
}

// Keyword sets a conversation must mention for the matching signal NOT to fire — a
// single hit in any NATURAL-LANGUAGE turn counts as "discussed". Broad on purpose:
// the goal is to suppress the flag whenever the topic was genuinely raised.
const SECURITY_KEYWORDS = ["security", "vulnerab", "crypto", "auth", "password", "secret", "token", "credential", "permission", "sanitiz", "escape", "injection", "encrypt"];
const TEST_KEYWORDS = ["test", "spec", "coverage", "assert", "pytest", "jest", "vitest", "mocha"];
const COMPAT_KEYWORDS = ["backward", "compat", "breaking", "deprecat", "migration", "semver", "major version"];
const RATIONALE_KEYWORDS = ["depend", "dependency", "package", "upgrade", "bump", "version", "install", "lockfile", "rationale", "because"];

const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json"]);

// Config-fact classes that are themselves SECURITY-relevant (a changed permission /
// secret reference / pipe-to-shell / destructive SQL), used both to FIRE and to
// PROMOTE risky_no_security beyond filename heuristics.
const SECURITY_CONFIG_KINDS = new Set<ConfigFactKind>([
  "ci_permissions_broadened",
  "ci_new_secret_reference",
  "ci_pull_request_target_added",
  "docker_curl_pipe_shell",
  "sql_destructive_statement"
]);

function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
}

// A file's NAME stem with extension and any test/spec marker stripped, used to
// correlate a test file with an implementation file (`uploader.ts` and
// `uploader.test.ts` share the stem `uploader`).
function fileStem(filePath: string): string {
  let name = basename(filePath).toLowerCase();
  name = name.replace(/\.(?:test|spec)\.[^.]+$/, ""); // uploader.test.ts -> uploader
  name = name.replace(/\.[^.]+$/, ""); // strip a remaining extension
  name = name.replace(/[._-](?:test|spec)$/, ""); // uploader_test -> uploader
  return name;
}

// A public-contract surface whose removal/rename is inherently breaking even when
// the structural diff produced no schema/api fact (a pure delete/rename has no
// property-level diff): a JSON schema, a schemas/ file, or a type declaration.
function isPublicSurfacePath(filePath: string): boolean {
  return (
    filePath.endsWith(".d.ts") ||
    /(^|\/)schemas?\//.test(filePath) ||
    (filePath.endsWith(".json") && /schema/i.test(basename(filePath)))
  );
}

function isLockfile(filePath: string): boolean {
  return LOCKFILES.has(basename(filePath));
}

// A security-sensitive source/config file by path convention (auth, crypto, secrets,
// session, input sanitization). Conservative whole-word-ish matching so e.g.
// "author.ts" does not match "auth".
function isSecuritySensitive(filePath: string): boolean {
  return /(^|[/_.-])(auth|authn|authz|crypto|secret|secrets|security|login|logout|session|token|jwt|oauth|password|sanitize|escape|permission|acl|rbac)([/_.-]|$)/i.test(
    filePath
  );
}

// An implementation SOURCE file across common languages (not only JS/TS), excluding
// tests and type declarations — so impl_no_test is not silently JS/TS-only.
function isImplSourceFile(filePath: string): boolean {
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|m)$/i.test(filePath)) {
    return false;
  }
  return !isTestPath(filePath);
}

// A dependency/CI/config file by path — the fallback that lets deps_no_rationale fire
// even when the fact detectors found nothing structured to report.
function isDepOrConfigFile(filePath: string): boolean {
  const name = basename(filePath);
  return (
    name === "package.json" ||
    isLockfile(filePath) ||
    /(^|\/)\.github\//.test(filePath) ||
    /(^|\/)Dockerfile([._-][\w.-]+)?$/i.test(filePath) ||
    filePath.toLowerCase().endsWith(".dockerfile") ||
    /(^|\/)tsconfig(\.[\w.-]+)?\.json$/.test(filePath) ||
    /\.config\.(?:js|cjs|mjs|ts|json|ya?ml)$/.test(name) ||
    /(^|\/)\.env(\.[\w.-]+)?$/.test(filePath) ||
    /(^|\/)migrations?\//.test(filePath) ||
    filePath.endsWith(".sql")
  );
}

// Tool turns carry a file path in their summary/command (`Edit(src/auth/login.ts)`),
// so counting them as discussion would let merely TOUCHING a file suppress the very
// signal it should raise (Codex P2). EVERY OTHER kind is natural language — message,
// decision, heading, and any tolerant/unknown kind a normalized log carries — and
// MUST be scanned, so a `kind: "decision"` summary saying "reviewed security" counts.
const TOOL_KINDS = new Set(["tool_call", "tool_result"]);

// The lowercased text the discussion checks scan: every NON-tool turn's summary. The
// events are already redacted (Phase 1).
function conversationHaystack(events: ConversationEvent[]): string {
  return events
    .filter((event) => !TOOL_KINDS.has(event.kind))
    .map((event) => event.summary ?? "")
    .join("\n")
    .toLowerCase();
}

function discusses(haystack: string, keywords: string[]): boolean {
  return keywords.some((keyword) => haystack.includes(keyword));
}

function fileList(paths: string[]): string {
  const shown = paths.slice(0, 3);
  const extra = paths.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} (+${extra} more)` : shown.join(", ");
}

// A backward-INCOMPATIBLE semantic change: a removed export, a changed signature, a
// removed/now-required schema property, a type change, or a removed enum member.
// (Pure additions are compatible and do not promote.)
function hasBreakingSemanticChange(facts: SemanticChangeFacts): boolean {
  const apiBreaking = facts.api_changes.some(
    (change) => change.exports_removed.length > 0 || change.signatures_changed.length > 0
  );
  const schemaBreaking = facts.schema_changes.some(
    (change) =>
      change.properties_removed.length > 0 ||
      change.required_added.length > 0 ||
      change.type_changes.length > 0 ||
      change.enum_changes.some((enumChange) => enumChange.removed.length > 0)
  );
  return apiBreaking || schemaBreaking;
}

// review-surfaces.METHODOLOGY.8: compute the four deterministic cross-reference
// signals from the diff, the semantic/dependency/config facts, the command
// transcripts, and the (natural-language) conversation. Emitted in a FIXED signal
// order so two runs are byte-stable; each anchors to a changed file.
export function computeCrossReferenceSignals(collection: CollectionResult, events: ConversationEvent[]): WorkflowFinding[] {
  const changed = (collection.changedFiles ?? []) as ChangedFileLike[];
  if (changed.length === 0) {
    return [];
  }
  const haystack = conversationHaystack(events);
  const secretPaths = new Set((collection.privacy?.secret_findings ?? []).map((finding) => finding.path));
  const facts: SemanticChangeFacts = collection.semanticChangeFacts ?? { schema_changes: [], api_changes: [], test_weakening: [] };
  const dependencyFacts = collection.dependencyFacts ?? [];
  const configFacts: ConfigFact[] = collection.configFacts ?? [];
  const securityConfig = configFacts.filter((fact) => SECURITY_CONFIG_KINDS.has(fact.kind));
  const findings: WorkflowFinding[] = [];
  let seq = 0;

  const emit = (kind: PacketWorkflowSignalKind, promoted: boolean, summary: string, anchorPath: string): void => {
    seq += 1;
    const evidence: EvidenceRef[] = [{ kind: "file", path: anchorPath, confidence: "medium", validation_status: "valid" }];
    const severity: PacketSeverity = promoted ? "high" : "medium";
    findings.push({ id: `XREF-${String(seq).padStart(3, "0")}`, signal_kind: kind, summary, severity, advisory: !promoted, evidence });
  };

  // 1. risky_no_security: a changed auth/crypto/secrets file OR a security-relevant
  // config fact, with no security discussion. Promoted by a secret finding on a
  // changed file or any security-relevant config fact.
  const securityFiles = changed.filter((file) => isSecuritySensitive(file.path));
  if ((securityFiles.length > 0 || securityConfig.length > 0) && !discusses(haystack, SECURITY_KEYWORDS)) {
    const promoted = securityFiles.some((file) => secretPaths.has(file.path)) || securityConfig.length > 0;
    const loci = [...securityFiles.map((file) => file.path), ...securityConfig.map((fact) => fact.path)];
    emit(
      "risky_no_security",
      promoted,
      `Security-sensitive change with no security discussion: ${fileList(loci)}.${
        promoted ? " An independent check (a secret finding or a CI/Docker/SQL security fact) also fired." : ""
      }`,
      loci[0]
    );
  }

  // 2. impl_no_test: implementation source changed (any language) with no test
  // coverage evidence and no test discussion. Coverage = a CORRELATED non-weakened
  // test edit (its name stem matches a changed impl file, so an UNRELATED test edit
  // does not count, Codex P2) OR a captured passing test run (broad evidence).
  // Promoted by a concrete test-weakening fact.
  const implFiles = changed.filter((file) => isImplSourceFile(file.path));
  const implStems = new Set(implFiles.map((file) => fileStem(file.path)));
  const weakenedTestPaths = new Set(facts.test_weakening.map((signal) => signal.path));
  const correlatedTest = changed.some(
    (file) => isTestPath(file.path) && file.status !== "D" && !weakenedTestPaths.has(file.path) && implStems.has(fileStem(file.path))
  );
  const passedTestRun = (collection.commandTranscripts ?? []).some(
    (transcript) =>
      transcript.status === "passed" &&
      transcript.exit_code === 0 &&
      typeof transcript.command === "string" &&
      commandLooksLikeTestCommand(transcript.command)
  );
  if (implFiles.length > 0 && !correlatedTest && !passedTestRun && !discusses(haystack, TEST_KEYWORDS)) {
    const weakened = facts.test_weakening.length > 0;
    emit(
      "impl_no_test",
      weakened,
      `Implementation changed with no test coverage evidence or test discussion: ${fileList(implFiles.map((file) => file.path))}.${
        weakened ? ` A test-weakening change was also detected (${facts.test_weakening[0].kind}).` : ""
      }`,
      implFiles[0].path
    );
  }

  // 3. api_no_compat: an exported API surface or JSON-schema changed with no
  // backward-compatibility discussion. Fires from the semantic api/schema facts AND
  // from a removed/renamed public-contract surface (a pure delete/rename yields no
  // structural fact, so it must be its own TRIGGER, not just a promotion flag —
  // Codex P2). Promoted by a backward-INCOMPATIBLE structural change or any
  // removed/renamed surface.
  const apiFactPaths = [...facts.api_changes.map((change) => change.path), ...facts.schema_changes.map((change) => change.path)];
  const removedSurfacePaths = changed
    .filter((file) => (file.status === "D" || file.status.startsWith("R")) && isPublicSurfacePath(file.path))
    .map((file) => file.path);
  const apiTriggerPaths = [...new Set([...apiFactPaths, ...removedSurfacePaths])];
  if (apiTriggerPaths.length > 0 && !discusses(haystack, COMPAT_KEYWORDS)) {
    const breaking = hasBreakingSemanticChange(facts) || removedSurfacePaths.length > 0;
    emit(
      "api_no_compat",
      breaking,
      `API/schema surface changed with no backward-compatibility discussion: ${fileList(apiTriggerPaths)}.${
        breaking ? " A backward-incompatible change (a removed export/property/surface, a required field, or a signature change) was detected." : ""
      }`,
      apiTriggerPaths[0]
    );
  }

  // 4. deps_no_rationale: a dependency/CI/config change with no rationale. Fires from
  // the dependency/config facts (or a dep/config path fallback). Promoted by a real
  // resolved dependency change or a risky CI/Docker/SQL config fact.
  const depConfigPaths = [
    ...dependencyFacts.map((fact) => fact.source_path),
    ...configFacts.map((fact) => fact.path),
    ...changed.filter((file) => isDepOrConfigFile(file.path)).map((file) => file.path)
  ];
  const uniqueDepConfigPaths = [...new Set(depConfigPaths)];
  if (uniqueDepConfigPaths.length > 0 && !discusses(haystack, RATIONALE_KEYWORDS)) {
    const promoted = dependencyFacts.length > 0 || securityConfig.length > 0 || changed.some((file) => isLockfile(file.path));
    emit(
      "deps_no_rationale",
      promoted,
      `Dependency/CI/config change with no rationale in the conversation: ${fileList(uniqueDepConfigPaths)}.${
        promoted ? " A concrete dependency-set change or a risky config fact was also detected." : ""
      }`,
      uniqueDepConfigPaths[0]
    );
  }

  return findings;
}
