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
import { commandLooksLikeBroadTestCommand } from "../commands/classify";
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
  old_path?: string;
}

// Keyword sets that prove the matching topic was actually REASONED ABOUT (so the
// signal does NOT fire). These are REVIEW/REASONING words, NOT the domain nouns that
// merely NAME the changed category — otherwise just saying "changed the auth flow" or
// "updated package.json and the lockfile" would count as discussion and suppress the
// very signal it should raise (Codex P2). Matched at a word boundary (prefix), so
// "vulnerab" still catches "vulnerability" while "test" never matches "latest".
// Suppressor keywords prove the topic was reasoned about. "authoriz"/"permission" are
// KEPT (an explicit "reviewed the authorization/permission model" IS a security
// discussion — Codex #110), but the colliding "unit" was dropped from TEST_KEYWORDS (it
// matches inside "unity"/"united"/"reunite" and is redundant with "test") (#109).
const SECURITY_KEYWORDS = ["security", "secure", "threat", "vulnerab", "exploit", "attack", "sanitiz", "escape", "injection", "xss", "csrf", "permission", "authoriz", "encrypt", "harden", "validate input", "input validation"];
const TEST_KEYWORDS = ["test", "tested", "coverage", "assert", "pytest", "jest", "vitest", "mocha", "regression"];
const COMPAT_KEYWORDS = ["backward", "compat", "breaking", "deprecat", "migration", "semver", "major version"];
// Suppress deps_no_rationale only on EXPLANATORY language (a stated reason), never on
// the descriptive nouns that just name the change (depend/package/version/lockfile).
const RATIONALE_KEYWORDS = ["because", "rationale", "reason", "needed", "in order to", "so that", "to fix", "to avoid", "required by", "cve", "justif", "upgrade to fix", "security patch"];

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
// correlate a test file with an implementation file across conventions:
// `uploader.test.ts`, `uploader_test.go`, `test_uploader.py`, `UploaderTest.java`
// all reduce to `uploader` (the impl `uploader.ts`'s stem).
function fileStem(filePath: string): string {
  const raw = basename(filePath).replace(/\.[^.]+$/, ""); // strip extension, keep case
  let name = raw.toLowerCase();
  name = name.replace(/\.(?:test|spec)$/, ""); // uploader.test -> uploader
  name = name.replace(/^(?:test|spec)[._-]/, ""); // test_uploader -> uploader
  name = name.replace(/[._-](?:test|spec)$/, ""); // uploader_test -> uploader
  // PascalCase suffix (Java/Scala `UploaderTest`/`UploaderSpec`): strip a trailing
  // Test/Spec ONLY when the ORIGINAL name actually used the capitalized convention,
  // so an ordinary word like `contest`/`protest`/`latest` keeps its stem (Codex P2).
  if (/(?:Test|Spec)$/.test(raw)) {
    name = name.replace(/(?:test|spec)$/, "");
  }
  // Drop a trailing test qualifier so a multipart test name still correlates with
  // its impl (`payments.integration` -> `payments`) — Codex P2.
  name = name.replace(/\.(?:integration|unit|e2e|browser|node|api|smoke|acceptance|contract)$/, "");
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

// A security-sensitive source/config file by path convention — auth, crypto,
// secrets, session, AND input-validation/sanitization (D6 explicitly calls out
// input-validation changes, Codex P2). Conservative whole-word-ish matching so e.g.
// "author.ts" does not match "auth".
function isSecuritySensitive(filePath: string): boolean {
  // The whole-word tokens (auth, authn, authz, ...) require a boundary on both
  // sides so "author.ts" does not match; the auth* family is matched as a PREFIX so
  // "authentication/provider.ts" and "authorization/policy.ts" DO (Codex P2).
  return (
    /(^|[/_.-])(authenticat|authoriz)/i.test(filePath) ||
    /(^|[/_.-])(auth|authn|authz|crypto|secret|secrets|security|login|logout|session|token|jwt|oauth|password|sanitize|sanitizer|escape|permission|acl|rbac|validate|validator|validation|validators)([/_.-]|$)/i.test(
      filePath
    )
  );
}

// A test file across conventions, including colocated NON-JS tests (`foo_test.go`,
// `test_foo.py`, `foo_test.py`, `foo_spec.rb`, `FooTest.java`, `foo_test.rs`) that
// `isTestPath` (tests/ + .test./.spec.) does not recognize, so a test-only change in
// those languages is not misread as implementation (Codex P2).
function isTestFile(filePath: string): boolean {
  if (isTestPath(filePath)) {
    return true;
  }
  const name = basename(filePath);
  return (
    /(^|\/)(tests?|__tests__|spec)\//.test(filePath) || // a tests/ or spec/ directory
    /(^|[._-])(test|spec)[._-]/i.test(name) || // test_foo.py, spec.foo
    /(^|[._-])(test|spec)\.[^.]+$/i.test(name) || // foo.test.ts, foo_test.go, foo-spec.rb
    /(?:Test|Spec)\.[^.]+$/.test(name) // FooTest.java, FooSpec.scala (boundary via the capital)
    // NOTE: an UNanchored `test`/`spec` is intentionally NOT matched — `latest.ts`,
    // `contest.py`, `request.ts` are implementation, not tests (Codex P2).
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
  return !isTestFile(filePath);
}

// A dependency/CI/config file by path — the fallback that lets deps_no_rationale fire
// even when the fact detectors found nothing structured to report.
// Non-Node dependency manifests/lockfiles whose structured detectors do not run, so
// a change to them still raises the advisory deps_no_rationale signal (Codex P2).
const NON_NODE_MANIFESTS = new Set([
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "requirements.txt",
  "requirements-dev.txt",
  "pyproject.toml",
  "pipfile",
  "pipfile.lock",
  "poetry.lock",
  "gemfile",
  "gemfile.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "composer.lock"
]);

function isDepOrConfigFile(filePath: string): boolean {
  const name = basename(filePath);
  return (
    name === "package.json" ||
    isLockfile(filePath) ||
    NON_NODE_MANIFESTS.has(name.toLowerCase()) ||
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

// Word-boundary (prefix) match so a domain noun embedded in a larger word does not
// count and a reasoning prefix still matches its inflections ("vulnerab" ->
// "vulnerability", "deprecat" -> "deprecated"); a multi-word phrase matches verbatim.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function discusses(haystack: string, keywords: string[]): boolean {
  return keywords.some((keyword) => new RegExp(`\\b${escapeRegExp(keyword)}`).test(haystack));
}

// True when a REASONING keyword co-occurs with a TOPIC in the SAME discussion unit (a
// conversation turn or sentence) — so the rationale / test discussion is ABOUT the
// changed dependency or file, not unrelated reasoning elsewhere in the conversation
// (Codex P2, #109). The haystack is already lowercased. `exactTopics` (package names)
// match at WORD boundaries so a short package (`ms`/`qs`) is recognized without
// matching inside `milliseconds`; `substringTopics` (filenames, dependency/config
// nouns) match as substrings but must be >= 3 chars to avoid spurious anchors. Sentence
// boundaries require whitespace after the punctuation so a `package.json`/`v2.0` dot
// does not split the unit.
function discussesNear(haystack: string, keywords: string[], exactTopics: string[], substringTopics: string[]): boolean {
  const topicMatchers = [
    // Package-token boundaries (not `\b`, which fails on a leading `@` or trailing `/`):
    // bounded by anything that is NOT part of a package identifier, so `@types/node` and
    // `ms` both match without `ms` matching inside `items` (Codex #110).
    ...exactTopics.map((topic) => topic.trim().toLowerCase()).filter(Boolean).map((topic) => new RegExp(`(?<![\\w@./-])${escapeRegExp(topic)}(?![\\w@./-])`)),
    ...substringTopics.map((topic) => topic.trim().toLowerCase()).filter((topic) => topic.length >= 3).map((topic) => new RegExp(escapeRegExp(topic)))
  ];
  if (topicMatchers.length === 0) {
    return false;
  }
  const keywordMatchers = keywords.map((keyword) => new RegExp(`\\b${escapeRegExp(keyword)}`));
  return haystack
    .split(/\n+|[.!?;]+\s+/)
    .some((segment) => topicMatchers.some((re) => re.test(segment)) && keywordMatchers.some((re) => re.test(segment)));
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

  // 1. risky_no_security: a changed auth/crypto/secrets file, a security-relevant
  // config fact, OR a secret finding on ANY changed file (a secret in `src/client.ts`
  // is a security-relevant change even without a security-named path — Codex P2), with
  // no security discussion. Promoted by a secret finding or a security config fact.
  const securityFiles = changed.filter((file) => isSecuritySensitive(file.path));
  const secretChangedPaths = changed.filter((file) => secretPaths.has(file.path)).map((file) => file.path);
  if ((securityFiles.length > 0 || securityConfig.length > 0 || secretChangedPaths.length > 0) && !discusses(haystack, SECURITY_KEYWORDS)) {
    const promoted = secretChangedPaths.length > 0 || securityConfig.length > 0;
    const loci = [...new Set([...securityFiles.map((file) => file.path), ...secretChangedPaths, ...securityConfig.map((fact) => fact.path)])];
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
  // coverage and no test discussion. Coverage is evaluated PER impl file (Codex P2):
  // an impl file is covered by a captured passing test run (broad evidence) OR by a
  // CORRELATED non-weakened test edit (a test whose name stem matches THAT file). So a
  // PR that changes two modules but only tests one still flags the untested one.
  // Promoted by a concrete test-weakening fact.
  const implFiles = changed.filter((file) => isImplSourceFile(file.path));
  const weakenedTestPaths = new Set(facts.test_weakening.map((signal) => signal.path));
  const coveringTestStems = new Set(
    changed.filter((file) => isTestFile(file.path) && file.status !== "D" && !weakenedTestPaths.has(file.path)).map((file) => fileStem(file.path))
  );
  // Only a CURRENT-HEAD, BROAD passing test run is GLOBAL coverage: a focused run
  // (`node --test dist/tests/foo.test.js`, `pnpm run test:api`) exercised only its
  // target, not every changed file, and a transcript from an older commit cannot have
  // exercised this diff at all (Codex P2, mirrors the PR-risk broad/focused +
  // staleness rules). A focused run is left to the per-file stem correlation below.
  const headSha = collection.git?.head_sha ?? "";
  const broadTestRun =
    headSha !== "" &&
    (collection.commandTranscripts ?? []).some(
      (transcript) =>
        transcript.status === "passed" &&
        transcript.exit_code === 0 &&
        transcript.head_sha === headSha &&
        typeof transcript.command === "string" &&
        commandLooksLikeBroadTestCommand(transcript.command, collection.commandRules ?? [])
    );
  // Stems shared by more than one impl file (e.g. two `index.ts`) are AMBIGUOUS: a
  // "tests for index" mention cannot be attributed to one of them, so a stem-correlated
  // discussion only clears a file's gap when its stem is UNIQUE among the impl set
  // (Codex #110). A real covering test file or a broad run still clears any of them.
  const implStemCounts = new Map<string, number>();
  for (const file of implFiles) {
    const stem = fileStem(file.path);
    implStemCounts.set(stem, (implStemCounts.get(stem) ?? 0) + 1);
  }
  const uncoveredImpl = broadTestRun
    ? []
    : implFiles.filter((file) => {
        const stem = fileStem(file.path);
        if (coveringTestStems.has(stem)) {
          return false; // a colocated / added test by name stem covers it
        }
        // A test DISCUSSION only clears THIS file's gap when it references the file (its
        // UNIQUE name stem in the same sentence/turn as a test keyword) — a generic
        // "added tests" mention must not clear every per-file gap at once (Codex P2, #109).
        if (stem.length >= 3 && implStemCounts.get(stem) === 1 && discussesNear(haystack, TEST_KEYWORDS, [stem], [])) {
          return false;
        }
        return true;
      });
  if (uncoveredImpl.length > 0) {
    // Promote on a test-weakening RELATED to an uncovered file (its name stem
    // matches) — an unrelated weakening elsewhere should not escalate this gap
    // (Codex P2). A DELETED colocated test (any language, e.g. `foo_test.go`) is also
    // a concrete weakening even though the JS-oriented semantic detector emits no
    // test_weakening fact for it (Codex P2).
    const uncoveredStems = new Set(uncoveredImpl.map((file) => fileStem(file.path)));
    const relatedWeakening = facts.test_weakening.find((signal) => uncoveredStems.has(fileStem(signal.path)));
    const deletedRelatedTest = changed.find(
      (file) => file.status === "D" && isTestFile(file.path) && uncoveredStems.has(fileStem(file.path))
    );
    const promoted = relatedWeakening !== undefined || deletedRelatedTest !== undefined;
    emit(
      "impl_no_test",
      promoted,
      `Implementation changed with no test coverage evidence or test discussion: ${fileList(uncoveredImpl.map((file) => file.path))}.${
        relatedWeakening
          ? ` A related test-weakening change was also detected (${relatedWeakening.kind}).`
          : deletedRelatedTest
            ? ` A related test file was deleted (${deletedRelatedTest.path}).`
            : ""
      }`,
      uncoveredImpl[0].path
    );
  }

  // 3. api_no_compat: an exported API surface or JSON-schema changed with no
  // backward-compatibility discussion. Fires from the semantic api/schema facts AND
  // from a removed/renamed public-contract surface (a pure delete/rename yields no
  // structural fact, so it must be its own TRIGGER, not just a promotion flag —
  // Codex P2). Promoted by a backward-INCOMPATIBLE structural change or any
  // removed/renamed surface.
  const apiFactPaths = [...facts.api_changes.map((change) => change.path), ...facts.schema_changes.map((change) => change.path)];
  const removedSurfacePaths = changed.flatMap((file) => {
    if (file.status === "D" && isPublicSurfacePath(file.path)) {
      return [file.path];
    }
    if (file.status.startsWith("R")) {
      // A rename REMOVES the public surface from its OLD location (a consumer
      // referencing the old schema/declaration path breaks), even when the NEW path
      // is not itself public (#103) — but ONLY if the OLD location was public. We do
      // NOT fall back to the new path's public-ness when old_path is absent: it is
      // absent either because it was never captured OR because collect redacted an
      // ignored source, and in BOTH cases a public NEW path signals a rename INTO
      // public scope (an ADD, not a removal). Using it would false-fire a breaking
      // api_no_compat on `archive/old.txt -> schemas/public.schema.json` (#103 round-6).
      return file.old_path !== undefined && isPublicSurfacePath(file.old_path) ? [file.old_path] : [];
    }
    return [];
  });
  const apiTriggerPaths = [...new Set([...apiFactPaths, ...removedSurfacePaths])];
  if (apiTriggerPaths.length > 0 && !discusses(haystack, COMPAT_KEYWORDS)) {
    const breaking = hasBreakingSemanticChange(facts) || removedSurfacePaths.length > 0;
    // The anchor becomes file evidence stamped `validation_status: "valid"`, so it
    // must be a path that actually exists in the changed set. apiFactPaths and a
    // D-deletion path are changed-file paths, but a renamed surface's trigger is the
    // REMOVED old_path (absent from changedFiles) — anchoring there would publish a
    // "valid" link to a non-existent file. Anchor to the first trigger that is a real
    // changed path, else the rename DESTINATION the old_path maps to (#103 round-4).
    const changedPathSet = new Set(changed.map((file) => file.path));
    const renameDestForOldPath = new Map(
      changed
        .filter((file) => file.status.startsWith("R") && file.old_path !== undefined)
        .map((file) => [file.old_path as string, file.path] as const)
    );
    const apiAnchorPath =
      apiTriggerPaths.find((path) => changedPathSet.has(path))
      ?? apiTriggerPaths.map((path) => renameDestForOldPath.get(path)).find((path): path is string => path !== undefined)
      ?? apiTriggerPaths[0];
    emit(
      "api_no_compat",
      breaking,
      `API/schema surface changed with no backward-compatibility discussion: ${fileList(apiTriggerPaths)}.${
        breaking ? " A backward-incompatible change (a removed export/property/surface, a required field, or a signature change) was detected." : ""
      }`,
      apiAnchorPath
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
  // Scope the rationale to the dependency/config TOPIC so a rationale stated about
  // something ELSE in the conversation does not suppress THIS gap (Codex P2, #109).
  // Exact (word-boundary) topics: package names and the short `ci` token. Substring
  // topics: changed dep/config filenames plus dependency AND config nouns (a CI/Docker/
  // config-only change is often described as "the workflow"/"the pipeline", not by its
  // filename).
  const depExactTopics = [
    ...dependencyFacts.map((fact) => fact.package).filter((pkg): pkg is string => typeof pkg === "string"),
    "ci"
  ];
  const depSubstringTopics = [
    ...uniqueDepConfigPaths.map(basename),
    // Dependency/config NOUNS only — NOT generic verbs like "upgrade"/"bump", which
    // co-occur with rationale words by nature and would suppress unrelated changes
    // (Codex #110).
    "dependenc", "lockfile", "package.json", "workflow", "pipeline", "docker", "migration", "config", "environment"
  ];
  if (uniqueDepConfigPaths.length > 0 && !discussesNear(haystack, RATIONALE_KEYWORDS, depExactTopics, depSubstringTopics)) {
    // Any deterministic dependency OR config fact (not just security ones) is an
    // independent check that moves the signal off advisory — a CI/Docker/env/SQL
    // fact is as concrete as a dependency change (Codex P2, METHODOLOGY.8).
    const promoted = dependencyFacts.length > 0 || configFacts.length > 0 || changed.some((file) => isLockfile(file.path));
    emit(
      "deps_no_rationale",
      promoted,
      `Dependency/CI/config change with no rationale in the conversation: ${fileList(uniqueDepConfigPaths)}.${
        promoted ? " A concrete dependency or CI/Docker/config fact was also detected." : ""
      }`,
      uniqueDepConfigPaths[0]
    );
  }

  return findings;
}
