// review-surfaces.METHODOLOGY.8 (D6, Phase 3a): the DETERMINISTIC cross-reference
// audit. Where the Phase-2 LLM leaf PROPOSES the four absence signals (and only when
// a provider runs), this fires them OFFLINE by cross-referencing the diff with the
// conversation: a changed-file CATEGORY with NO corresponding discussion. Each signal
// is ADVISORY (the absence heuristic alone never moves the verdict, D5) UNLESS an
// INDEPENDENT deterministic check on the diff also fires (a secret finding, a deleted
// test, a removed/renamed surface, a moved lockfile) — then it is promoted to a
// non-advisory finding. Output appends to methodology.workflow_findings, the same
// surface the LLM leaf and the human review already consume; it never writes
// risks.items (which would duplicate the risk-lens findings).
import { CollectionResult } from "../collector/collect";
import { ConversationEvent } from "../conversation/events";
import { EvidenceRef } from "../evidence/evidence";
import { isTestPath } from "../scope/pr-scope";
import { PacketSeverity, PacketWorkflowSignalKind } from "../schema/review-packet-contract";
import { WorkflowFinding } from "./methodology";

interface ChangedFileLike {
  path: string;
  status: string;
}

// Keyword sets a conversation must mention for the matching signal NOT to fire — a
// single hit anywhere (any turn's summary or command) counts as "discussed". Broad
// on purpose: the goal is to suppress the flag whenever the topic was raised at all.
const SECURITY_KEYWORDS = [
  "security",
  "vulnerab",
  "crypto",
  "auth",
  "password",
  "secret",
  "token",
  "credential",
  "permission",
  "sanitiz",
  "escape",
  "injection",
  "encrypt"
];
const TEST_KEYWORDS = ["test", "spec", "coverage", "assert", "pytest", "jest", "vitest", "mocha"];
const COMPAT_KEYWORDS = ["backward", "compat", "breaking", "deprecat", "migration", "semver", "major version"];
const RATIONALE_KEYWORDS = ["depend", "dependency", "package", "upgrade", "bump", "version", "install", "lockfile", "rationale", "because"];

const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json"]);

function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
}

function isLockfile(filePath: string): boolean {
  return LOCKFILES.has(basename(filePath));
}

// A security-sensitive source/config file by path convention (auth, crypto, secrets,
// session, input sanitization). Conservative whole-word-ish matching to avoid e.g.
// "author.ts" matching "auth".
function isSecuritySensitive(filePath: string): boolean {
  return /(^|[/_.-])(auth|authn|authz|crypto|secret|secrets|security|login|logout|session|token|jwt|oauth|password|sanitize|escape|permission|acl|rbac)([/_.-]|$)/i.test(
    filePath
  );
}

// A public-surface file whose change can break consumers: a type-declaration file, a
// JSON schema, or anything under a schemas/ directory.
function isApiOrSchemaFile(filePath: string): boolean {
  return (
    filePath.endsWith(".d.ts") ||
    /(^|\/)schemas?\//.test(filePath) ||
    (filePath.endsWith(".json") && /schema/i.test(basename(filePath)))
  );
}

// A dependency/CI/config file whose change usually wants a stated reason: manifests,
// lockfiles, CI workflows, container/build config, and TS/tooling config.
function isDepOrConfigFile(filePath: string): boolean {
  const name = basename(filePath);
  return (
    name === "package.json" ||
    isLockfile(filePath) ||
    /(^|\/)\.github\//.test(filePath) ||
    /(^|\/)Dockerfile([._-][\w.-]+)?$/i.test(filePath) ||
    /(^|\/)tsconfig(\.[\w.-]+)?\.json$/.test(filePath) ||
    /\.config\.(?:js|cjs|mjs|ts|json|ya?ml)$/.test(name)
  );
}

// An implementation source file: TS/JS that is NOT a test, NOT a type declaration,
// and NOT a dep/config file (those have their own signals).
function isImplFile(filePath: string): boolean {
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePath) || filePath.endsWith(".d.ts")) {
    return false;
  }
  return !isTestPath(filePath) && !isDepOrConfigFile(filePath);
}

// The lowercased conversation text the discussion checks scan: every turn's summary
// and command. The events are already redacted (Phase 1), so this carries no secret.
function conversationHaystack(events: ConversationEvent[]): string {
  return events.map((event) => `${event.summary ?? ""} ${event.command ?? ""}`).join("\n").toLowerCase();
}

function discusses(haystack: string, keywords: string[]): boolean {
  return keywords.some((keyword) => haystack.includes(keyword));
}

function fileList(files: ChangedFileLike[]): string {
  const shown = files.slice(0, 3).map((file) => file.path);
  const extra = files.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} (+${extra} more)` : shown.join(", ");
}

// review-surfaces.METHODOLOGY.8: compute the four deterministic cross-reference
// signals. `startSeq` continues finding-id numbering; the result is appended to
// methodology.workflow_findings in a FIXED signal order so two runs are byte-stable.
export function computeCrossReferenceSignals(collection: CollectionResult, events: ConversationEvent[]): WorkflowFinding[] {
  const changed = (collection.changedFiles ?? []) as ChangedFileLike[];
  if (changed.length === 0) {
    return [];
  }
  const haystack = conversationHaystack(events);
  const secretPaths = new Set((collection.privacy?.secret_findings ?? []).map((finding) => finding.path));
  const findings: WorkflowFinding[] = [];
  let seq = 0;

  const emit = (
    kind: PacketWorkflowSignalKind,
    promoted: boolean,
    summary: string,
    anchorPath: string
  ): void => {
    seq += 1;
    const evidence: EvidenceRef[] = [
      { kind: "file", path: anchorPath, confidence: "medium", validation_status: "valid" }
    ];
    const severity: PacketSeverity = promoted ? "high" : "medium";
    findings.push({ id: `XREF-${String(seq).padStart(3, "0")}`, signal_kind: kind, summary, severity, advisory: !promoted, evidence });
  };

  // 1. risky_no_security: a changed auth/crypto/secrets file with no security talk.
  // Promoted when an independent secret scan flagged a changed file.
  const securityFiles = changed.filter((file) => isSecuritySensitive(file.path));
  if (securityFiles.length > 0 && !discusses(haystack, SECURITY_KEYWORDS)) {
    const promoted = securityFiles.some((file) => secretPaths.has(file.path));
    emit(
      "risky_no_security",
      promoted,
      `Security-sensitive file(s) changed with no security discussion: ${fileList(securityFiles)}.${
        promoted ? " A secret scan also flagged a changed file." : ""
      }`,
      securityFiles[0].path
    );
  }

  // 2. impl_no_test: implementation changed but no (non-deleted) test changed and no
  // test talk. Promoted when a test file was DELETED (a concrete test-weakening).
  const implFiles = changed.filter((file) => isImplFile(file.path));
  const testFiles = changed.filter((file) => isTestPath(file.path));
  const addedOrModifiedTest = testFiles.some((file) => file.status !== "D");
  if (implFiles.length > 0 && !addedOrModifiedTest && !discusses(haystack, TEST_KEYWORDS)) {
    const deletedTest = testFiles.some((file) => file.status === "D");
    emit(
      "impl_no_test",
      deletedTest,
      `Implementation changed with no accompanying test change or test discussion: ${fileList(implFiles)}.${
        deletedTest ? " A test file was also deleted in this change." : ""
      }`,
      implFiles[0].path
    );
  }

  // 3. api_no_compat: a type/schema surface changed with no backward-compat talk.
  // Promoted when a surface file was REMOVED or RENAMED (an inherently breaking change).
  const apiFiles = changed.filter((file) => isApiOrSchemaFile(file.path));
  if (apiFiles.length > 0 && !discusses(haystack, COMPAT_KEYWORDS)) {
    const breaking = apiFiles.some((file) => file.status === "D" || file.status.startsWith("R"));
    emit(
      "api_no_compat",
      breaking,
      `API/schema surface changed with no backward-compatibility discussion: ${fileList(apiFiles)}.${
        breaking ? " A surface file was removed or renamed (an inherently breaking change)." : ""
      }`,
      apiFiles[0].path
    );
  }

  // 4. deps_no_rationale: a dependency/CI/config file changed with no rationale.
  // Promoted when a LOCKFILE moved (the resolved dependency set actually changed).
  const depFiles = changed.filter((file) => isDepOrConfigFile(file.path));
  if (depFiles.length > 0 && !discusses(haystack, RATIONALE_KEYWORDS)) {
    const lockChanged = depFiles.some((file) => isLockfile(file.path));
    emit(
      "deps_no_rationale",
      lockChanged,
      `Dependency/CI/config file(s) changed with no rationale in the conversation: ${fileList(depFiles)}.${
        lockChanged ? " A lockfile changed (the resolved dependency set moved)." : ""
      }`,
      depFiles[0].path
    );
  }

  return findings;
}
