import test from "node:test";
import assert from "node:assert/strict";
import { computeCrossReferenceSignals } from "../src/methodology/cross-reference";
import { CollectionResult } from "../src/collector/collect";
import { ConversationEvent } from "../src/conversation/events";
import { SemanticChangeFacts } from "../src/risks/semantic-diff";

function file(path: string, status = "M"): { path: string; status: string; source: string } {
  return { path, status, source: "working_tree" };
}

interface CollOpts {
  secretPaths?: string[];
  transcripts?: Array<{ command: string; status: string; exit_code: number }>;
  semanticFacts?: Partial<SemanticChangeFacts>;
  dependencyFacts?: Array<{ kind: string; package: string; detail: string; source_path: string }>;
  configFacts?: Array<{ kind: string; path: string; detail: string }>;
}

function collection(changed: ReturnType<typeof file>[], opts: CollOpts = {}): CollectionResult {
  return {
    changedFiles: changed,
    privacy: { secret_findings: (opts.secretPaths ?? []).map((path) => ({ path, kinds: ["aws_key"] })) },
    commandTranscripts: opts.transcripts ?? [],
    semanticChangeFacts: { schema_changes: [], api_changes: [], test_weakening: [], ...(opts.semanticFacts ?? {}) },
    dependencyFacts: opts.dependencyFacts ?? [],
    configFacts: opts.configFacts ?? []
  } as unknown as CollectionResult;
}

// A NATURAL-LANGUAGE turn (kind "message"): the only kind the discussion check scans.
function talk(summary: string): ConversationEvent[] {
  return [{ id: "e0", actor: "user", kind: "message", summary, raw_index: 0 }];
}

// A TOOL turn whose summary carries a file path — must NOT count as discussion.
function toolTurn(summary: string): ConversationEvent[] {
  return [{ id: "t0", actor: "assistant", kind: "tool_call", summary, tool: "Edit", raw_index: 0 }];
}

type Findings = ReturnType<typeof computeCrossReferenceSignals>;

function signal(findings: Findings, kind: string): Findings[number] | undefined {
  return findings.find((finding) => finding.signal_kind === kind);
}

test("review-surfaces.METHODOLOGY.8 risky_no_security fires (advisory) for an auth change with no security discussion", () => {
  const sig = signal(computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), talk("refactored the upload flow")), "risky_no_security");
  assert.ok(sig);
  assert.equal(sig.advisory, true);
  assert.equal(sig.severity, "medium");
});

test("review-surfaces.METHODOLOGY.8 risky_no_security is PROMOTED by a secret finding on a changed file", () => {
  const sig = signal(
    computeCrossReferenceSignals(collection([file("src/auth/login.ts")], { secretPaths: ["src/auth/login.ts"] }), talk("a refactor")),
    "risky_no_security"
  );
  assert.ok(sig);
  assert.equal(sig.advisory, false);
  assert.equal(sig.severity, "high");
});

test("review-surfaces.METHODOLOGY.8 risky_no_security fires + is PROMOTED by a security-relevant config fact", () => {
  const sig = signal(
    computeCrossReferenceSignals(
      collection([file(".github/workflows/ci.yml")], { configFacts: [{ kind: "ci_new_secret_reference", path: ".github/workflows/ci.yml", detail: "x" }] }),
      talk("pipeline tweak")
    ),
    "risky_no_security"
  );
  assert.ok(sig, "a CI secret-reference fact raises a security signal even without an auth-named file");
  assert.equal(sig.advisory, false);
});

test("review-surfaces.METHODOLOGY.8 risky_no_security does NOT fire when security was discussed", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), talk("reviewed the auth token handling for security"));
  assert.equal(signal(findings, "risky_no_security"), undefined);
});

test("review-surfaces.METHODOLOGY.8 a tool turn naming the changed file does NOT count as discussion (Codex P2)", () => {
  // The only turn is a tool call `Edit(src/auth/login.ts)` — its path contains "auth"
  // but it is not a security DISCUSSION, so the signal must still fire.
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), toolTurn("Edit(src/auth/login.ts)"));
  assert.ok(signal(findings, "risky_no_security"), "tool path text must not suppress the signal");
});

test("review-surfaces.METHODOLOGY.8 impl_no_test fires when impl changed with no test change/run/talk", () => {
  const sig = signal(computeCrossReferenceSignals(collection([file("src/uploader.ts")]), talk("implemented the retry")), "impl_no_test");
  assert.ok(sig);
  assert.equal(sig.advisory, true);
});

test("review-surfaces.METHODOLOGY.8 impl_no_test fires for a non-JS source file (Codex P2)", () => {
  const sig = signal(computeCrossReferenceSignals(collection([file("src/app.py")]), talk("implemented it")), "impl_no_test");
  assert.ok(sig, "Python/Go/Rust sources are implementation too");
});

test("review-surfaces.METHODOLOGY.8 impl_no_test does NOT fire when a captured test run passed (Codex P2)", () => {
  const findings = computeCrossReferenceSignals(
    collection([file("src/uploader.ts")], { transcripts: [{ command: "pnpm run test", status: "passed", exit_code: 0 }] }),
    talk("implemented the retry")
  );
  assert.equal(signal(findings, "impl_no_test"), undefined, "a passing transcripted test run is coverage evidence");
});

test("review-surfaces.METHODOLOGY.8 impl_no_test does NOT fire when a test was added alongside the impl", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/uploader.ts"), file("tests/uploader.test.ts", "A")]), talk("implemented and tested"));
  assert.equal(signal(findings, "impl_no_test"), undefined);
});

test("review-surfaces.METHODOLOGY.8 impl_no_test is PROMOTED by a test-weakening fact, and a weakened test is not coverage (Codex P2)", () => {
  const sig = signal(
    computeCrossReferenceSignals(
      collection([file("src/uploader.ts"), file("tests/uploader.test.ts", "M")], {
        semanticFacts: { test_weakening: [{ kind: "removed_assertion", path: "tests/uploader.test.ts", detail: "dropped 2 assertions" }] }
      }),
      talk("simplified the flow")
    ),
    "impl_no_test"
  );
  assert.ok(sig, "a weakened (modified) test must not count as coverage");
  assert.equal(sig.advisory, false, "the test-weakening fact promotes the signal");
});

test("review-surfaces.METHODOLOGY.8 api_no_compat fires from a SOURCE export change (not only .d.ts/schema) (Codex P2)", () => {
  const sig = signal(
    computeCrossReferenceSignals(
      collection([file("src/api.ts")], { semanticFacts: { api_changes: [{ path: "src/api.ts", exports_added: ["newThing"], exports_removed: [], signatures_changed: [] }] } }),
      talk("added a helper")
    ),
    "api_no_compat"
  );
  assert.ok(sig, "an exported-symbol change in ordinary source emits the signal");
  assert.equal(sig.advisory, true, "a pure addition is compatible (advisory)");
});

test("review-surfaces.METHODOLOGY.8 api_no_compat is PROMOTED by a backward-incompatible export removal", () => {
  const sig = signal(
    computeCrossReferenceSignals(
      collection([file("src/api.ts")], { semanticFacts: { api_changes: [{ path: "src/api.ts", exports_added: [], exports_removed: ["oldThing"], signatures_changed: [] }] } }),
      talk("cleaned up")
    ),
    "api_no_compat"
  );
  assert.ok(sig);
  assert.equal(sig.advisory, false, "a removed export is backward-incompatible");
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale fires for a config change with no rationale", () => {
  const sig = signal(computeCrossReferenceSignals(collection([file(".github/workflows/ci.yml")]), talk("tweaked the pipeline")), "deps_no_rationale");
  assert.ok(sig);
  assert.equal(sig.advisory, true);
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale fires for a SQL migration / config-fact class (Codex P2)", () => {
  const sig = signal(
    computeCrossReferenceSignals(
      collection([file("db/migrations/001_init.sql")], { configFacts: [{ kind: "sql_destructive_statement", path: "db/migrations/001_init.sql", detail: "DROP TABLE" }] }),
      talk("schema work")
    ),
    "deps_no_rationale"
  );
  assert.ok(sig, "config-fact classes beyond the path allowlist still raise the signal");
  assert.equal(sig.advisory, false, "a risky config fact promotes it");
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale is PROMOTED when a lockfile moves", () => {
  const sig = signal(computeCrossReferenceSignals(collection([file("package.json"), file("pnpm-lock.yaml")]), talk("build config")), "deps_no_rationale");
  assert.ok(sig);
  assert.equal(sig.advisory, false);
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale does NOT fire when the change was explained", () => {
  const findings = computeCrossReferenceSignals(collection([file("package.json")]), talk("bumped the dependency to fix a CVE, rationale in the PR"));
  assert.equal(signal(findings, "deps_no_rationale"), undefined);
});

test("review-surfaces.METHODOLOGY.8 every cross-reference finding anchors to a changed file with a distinct id", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), []);
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    assert.ok(finding.evidence.some((ref) => ref.kind === "file" && ref.validation_status === "valid"));
    assert.ok(finding.id.startsWith("XREF-"));
  }
});

test("review-surfaces.METHODOLOGY.8 an empty diff yields no cross-reference findings", () => {
  assert.deepEqual(computeCrossReferenceSignals(collection([]), talk("anything")), []);
});

test("review-surfaces.METHODOLOGY.8 with no conversation, the diff-based signals still fire (deterministic shell)", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), []);
  assert.ok(signal(findings, "risky_no_security"));
});
