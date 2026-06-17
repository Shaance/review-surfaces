import test from "node:test";
import assert from "node:assert/strict";
import { computeCrossReferenceSignals } from "../src/methodology/cross-reference";
import { CollectionResult } from "../src/collector/collect";
import { ConversationEvent } from "../src/conversation/events";

function file(path: string, status = "M"): { path: string; status: string; source: string } {
  return { path, status, source: "working_tree" };
}

function collection(
  changed: ReturnType<typeof file>[],
  secretPaths: string[] = []
): CollectionResult {
  return {
    changedFiles: changed,
    privacy: { secret_findings: secretPaths.map((path) => ({ path, kinds: ["aws_key"] })) }
  } as unknown as CollectionResult;
}

function talk(summary: string): ConversationEvent[] {
  return [{ id: "e0", actor: "user", kind: "message", summary, raw_index: 0 }];
}

type Findings = ReturnType<typeof computeCrossReferenceSignals>;

function signal(findings: Findings, kind: string): Findings[number] | undefined {
  return findings.find((finding) => finding.signal_kind === kind);
}

test("review-surfaces.METHODOLOGY.8 risky_no_security fires (advisory) for an auth change with no security discussion", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), talk("refactored the upload flow"));
  const sig = signal(findings, "risky_no_security");
  assert.ok(sig, "the signal fires");
  assert.equal(sig.advisory, true, "advisory until a deterministic check corroborates");
  assert.equal(sig.severity, "medium");
});

test("review-surfaces.METHODOLOGY.8 risky_no_security is PROMOTED when a secret scan also flags a changed file", () => {
  const findings = computeCrossReferenceSignals(
    collection([file("src/auth/login.ts")], ["src/auth/login.ts"]),
    talk("just a refactor")
  );
  const sig = signal(findings, "risky_no_security");
  assert.ok(sig);
  assert.equal(sig.advisory, false, "an independent deterministic check (secret finding) promotes it");
  assert.equal(sig.severity, "high");
});

test("review-surfaces.METHODOLOGY.8 risky_no_security does NOT fire when security was discussed", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), talk("reviewed the auth token handling for security"));
  assert.equal(signal(findings, "risky_no_security"), undefined);
});

test("review-surfaces.METHODOLOGY.8 impl_no_test fires when impl changed with no test change or test talk", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/uploader.ts")]), talk("implemented the retry"));
  const sig = signal(findings, "impl_no_test");
  assert.ok(sig);
  assert.equal(sig.advisory, true);
});

test("review-surfaces.METHODOLOGY.8 impl_no_test is PROMOTED when a test file was deleted", () => {
  const findings = computeCrossReferenceSignals(
    collection([file("src/uploader.ts"), file("tests/uploader.test.ts", "D")]),
    talk("dropped the old flow")
  );
  const sig = signal(findings, "impl_no_test");
  assert.ok(sig);
  assert.equal(sig.advisory, false, "a deleted test (test-weakening) promotes the signal");
});

test("review-surfaces.METHODOLOGY.8 impl_no_test does NOT fire when a test was added alongside the impl", () => {
  const findings = computeCrossReferenceSignals(
    collection([file("src/uploader.ts"), file("tests/uploader.test.ts", "A")]),
    talk("implemented and tested the retry")
  );
  assert.equal(signal(findings, "impl_no_test"), undefined);
});

test("review-surfaces.METHODOLOGY.8 api_no_compat fires for a schema change with no compat discussion", () => {
  const findings = computeCrossReferenceSignals(collection([file("schemas/review_packet.schema.json")]), talk("added a field"));
  const sig = signal(findings, "api_no_compat");
  assert.ok(sig);
  assert.equal(sig.advisory, true);
});

test("review-surfaces.METHODOLOGY.8 api_no_compat is PROMOTED when a surface file is removed", () => {
  const findings = computeCrossReferenceSignals(collection([file("types/public.d.ts", "D")]), talk("removed the old type"));
  const sig = signal(findings, "api_no_compat");
  assert.ok(sig);
  assert.equal(sig.advisory, false, "a removed/renamed surface is inherently breaking");
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale fires for a config change with no rationale", () => {
  const findings = computeCrossReferenceSignals(collection([file(".github/workflows/ci.yml")]), talk("tweaked the pipeline"));
  const sig = signal(findings, "deps_no_rationale");
  assert.ok(sig);
  assert.equal(sig.advisory, true);
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale is PROMOTED when a lockfile moves", () => {
  const findings = computeCrossReferenceSignals(
    collection([file("package.json"), file("pnpm-lock.yaml")]),
    talk("updated build config")
  );
  const sig = signal(findings, "deps_no_rationale");
  assert.ok(sig);
  assert.equal(sig.advisory, false, "a moved lockfile is a concrete dependency-set change");
});

test("review-surfaces.METHODOLOGY.8 deps_no_rationale does NOT fire when the dependency change was explained", () => {
  const findings = computeCrossReferenceSignals(collection([file("package.json")]), talk("bumped the dependency to fix a CVE, rationale in the PR"));
  assert.equal(signal(findings, "deps_no_rationale"), undefined);
});

test("review-surfaces.METHODOLOGY.8 every cross-reference finding anchors to a changed file (grounded, not advisory-noise)", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), []);
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    assert.ok(finding.evidence.some((ref) => ref.kind === "file" && ref.validation_status === "valid"), "anchored to a changed file");
    assert.ok(finding.id.startsWith("XREF-"), "deterministic findings carry a distinct id prefix");
  }
});

test("review-surfaces.METHODOLOGY.8 an empty diff yields no cross-reference findings", () => {
  assert.deepEqual(computeCrossReferenceSignals(collection([]), talk("anything")), []);
});

test("review-surfaces.METHODOLOGY.8 with no conversation, the diff-based signals still fire (deterministic shell)", () => {
  const findings = computeCrossReferenceSignals(collection([file("src/auth/login.ts")]), []);
  assert.ok(signal(findings, "risky_no_security"), "an empty transcript is maximal 'no discussion'");
});
