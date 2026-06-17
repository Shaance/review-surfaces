import test from "node:test";
import assert from "node:assert/strict";
import { CollectionResult } from "../src/collector/collect";
import { ConversationEvent } from "../src/conversation/events";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { IntentModel } from "../src/intent/intent";
import { MethodologyModel } from "../src/methodology/methodology";
import { ReasoningProvider, StructuredResult } from "../src/llm/provider";
import { runConversationGapReasoning } from "../src/llm/reasoning";
import { RisksModel } from "../src/risks/risks";

function stub(data: unknown): ReasoningProvider {
  return {
    name: "ai-sdk",
    async generateStructured(stage: string): Promise<StructuredResult> {
      return stage === "conversation-test-gaps" ? { ok: true, data } : { ok: false, reason: "n/a" };
    }
  };
}

interface CollectionOpts {
  events?: ConversationEvent[];
  changed?: string[];
  passingTest?: boolean;
  passedTestCommand?: boolean;
}

function collection(opts: CollectionOpts = {}): CollectionResult {
  const events = opts.events ?? EVENTS;
  return {
    cwd: "/tmp/fixture",
    outputDir: "/tmp/fixture/.review-surfaces",
    manifest: { tool_version: "0.1.0", repo: "fixture", base_ref: "HEAD", head_ref: "HEAD", head_sha: "abc", run_mode: "local", input_hashes: [] },
    specIndex: { schema_version: "review-surfaces.specs.index.v1", specs: [] },
    changedFiles: (opts.changed ?? ["src/uploader.ts"]).map((p) => ({ path: p, status: "M", source: "working_tree" })),
    docs: [],
    tests: [],
    feedback: [],
    commandTranscripts: opts.passedTestCommand ? [{ id: "c1", command: "pnpm run test", status: "passed", exit_code: 0, truncated: false, source_path: "x" }] : [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    repositoryFiles: [],
    repoIndex: { files: [], ecosystems: [], clusters: [] },
    privacy: { ignore_file: ".review-surfacesignore", ignore_patterns: [], ignored_changed_files: [], diff_redactions: [], remote_provider_blocked: false, secret_findings: [] },
    git: { repo: "fixture", base_ref: "HEAD", head_ref: "HEAD", head_sha: "abc" },
    testResults: { cases: opts.passingTest ? [{ name: "uploads", status: "passed" }] : [], suites: [], totals: { passed: opts.passingTest ? 1 : 0, failed: 0, skipped: 0 } },
    conversationEvents: events
  } as unknown as CollectionResult;
}

const EVENTS: ConversationEvent[] = [
  { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
  { id: "a1", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 },
  { id: "a2", actor: "user", kind: "message", summary: "ship it", raw_index: 2 }
];

function methodology(): MethodologyModel {
  return {
    summary: "m", missing_logs: false, considered: [], research: [], decisions: [], unchallenged_assumptions: [],
    skipped_checks: [], claims_without_evidence: [], verified_claims: [], quality_flags: ["methodology_test_gap_degraded"], evidence: [], workflow_findings: []
  };
}
function intent(): IntentModel {
  return { summary: "i", spec_mode: "acai", requirements: [], constraints: [], non_goals: [], assumptions: [], open_questions: [], sources: [] };
}
function evaluation(): EvaluationModel {
  return { summary: "", results: [], overreach: [], acai_coverage: {} };
}
function risks(): RisksModel {
  return { summary: "", items: [], test_evidence: [], test_gaps: [], missing_automatic_tests: [], missing_manual_checks: [], review_focus: [] };
}

function run(provider: ReasoningProvider, coll: CollectionResult, m: MethodologyModel, r: RisksModel): Promise<void> {
  return runConversationGapReasoning(provider, { collection: coll, intent: intent(), evaluation: evaluation(), methodology: m, risks: r }, {});
}

test("review-surfaces.RISK.6 a CONV-GAP record lands in exactly one missing-list and never in test_gaps", async () => {
  const r = risks();
  const m = methodology();
  const data = {
    gaps: [
      { summary: "uploader changed, only run by hand", kind: "automatic", suggested_test: "add an upload retry test", tested_how: "manual", anchors: { event_ids: ["a1"] } },
      { summary: "UI flow needs human review", kind: "manual", manual_check: "click through the upload UI", tested_how: "none", anchors: { event_ids: ["a1"] } }
    ]
  };
  await run(stub(data), collection(), m, r);

  const autoIds = (r.missing_automatic_tests ?? []).map((g) => g.id);
  const manualIds = (r.missing_manual_checks ?? []).map((g) => g.id);
  const convAuto = (r.missing_automatic_tests ?? []).filter((g) => g.id.startsWith("CONV-GAP-"));
  const convManual = (r.missing_manual_checks ?? []).filter((g) => g.id.startsWith("CONV-GAP-"));

  assert.equal(convAuto.length, 1, "the automatic gap is in missing_automatic_tests");
  assert.equal(convManual.length, 1, "the manual gap is in missing_manual_checks");
  // exactly one list each: a CONV-GAP id never appears in both, never in test_gaps
  for (const id of [...autoIds, ...manualIds].filter((x) => x.startsWith("CONV-GAP-"))) {
    const inBoth = autoIds.includes(id) && manualIds.includes(id);
    assert.ok(!inBoth, `${id} must not be in both lists`);
    assert.ok(!r.test_gaps.some((g) => g.id === id), `${id} must not be in test_gaps`);
  }
  // the valid event_id is bound as conversation evidence
  assert.ok(convAuto[0].evidence?.some((e) => e.kind === "conversation" && e.event_id === "a1" && e.validation_status === "valid"));
  // a real CONV-GAP cleared the degraded flag
  assert.ok(!m.quality_flags.includes("methodology_test_gap_degraded"));
});

test("review-surfaces.RISK.6 an unknown event_id demotes the gap to advisory (unverified anchor)", async () => {
  const r = risks();
  const data = {
    gaps: [{ summary: "claims a ghost event", kind: "automatic", suggested_test: "x", tested_how: "none", anchors: { event_ids: ["GHOST"] } }]
  };
  await run(stub(data), collection(), methodology(), r);
  const gap = (r.missing_automatic_tests ?? []).find((g) => g.id.startsWith("CONV-GAP-"));
  assert.ok(gap);
  assert.match(gap.summary, /unverified anchor\(s\): GHOST/, "an unknown event_id is named as unverified");
  assert.ok(gap.evidence?.every((e) => e.validation_status !== "valid"), "no valid evidence -> advisory");
  assert.ok(gap.evidence?.some((e) => e.llm_proposed === true), "advisory gaps carry llm-proposed fallback evidence");
});

test("review-surfaces.RISK.7 a proposed tested_how of unit is downgraded to unknown without a real test artifact", async () => {
  const r = risks();
  const data = { gaps: [{ summary: "claims unit coverage", kind: "manual", manual_check: "review", tested_how: "unit", anchors: { event_ids: ["a1"] } }] };
  // No passing test case and no passed test command in the collection.
  await run(stub(data), collection({ passingTest: false, passedTestCommand: false }), methodology(), r);
  const gap = (r.missing_manual_checks ?? []).find((g) => g.id.startsWith("CONV-GAP-"));
  assert.ok(gap);
  assert.equal(gap.tested_how, "unknown", "unit is not trusted without a confirming test artifact");
});

test("review-surfaces.RISK.7 a proposed tested_how of unit is TRUSTED when a real test artifact confirms it", async () => {
  const r = risks();
  const data = { gaps: [{ summary: "really has unit coverage", kind: "manual", manual_check: "review", tested_how: "unit", anchors: { event_ids: ["a1"] } }] };
  await run(stub(data), collection({ passingTest: true }), methodology(), r);
  const gap = (r.missing_manual_checks ?? []).find((g) => g.id.startsWith("CONV-GAP-"));
  assert.ok(gap);
  assert.equal(gap.tested_how, "unit", "a passing test case confirms unit");
});

test("review-surfaces.RISK.7 a passed test COMMAND also confirms unit/integration", async () => {
  const r = risks();
  const data = { gaps: [{ summary: "integration via a test command", kind: "manual", manual_check: "review", tested_how: "integration", anchors: { event_ids: ["a1"] } }] };
  await run(stub(data), collection({ passedTestCommand: true }), methodology(), r);
  const gap = (r.missing_manual_checks ?? []).find((g) => g.id.startsWith("CONV-GAP-"));
  assert.ok(gap);
  assert.equal(gap.tested_how, "integration", "a passed test command confirms integration");
});

test("review-surfaces.RISK.7 tested_how confirmation is tied to the gap: an unrelated test does not confirm a non-code gap", async () => {
  const r = risks();
  // The gap cites a1 (a test-run turn that does NOT touch a changed file). Even with
  // a passing test artifact, an unrelated test must not confirm this gap's unit claim.
  const data = { gaps: [{ summary: "claims unit on a non-code turn", kind: "manual", manual_check: "review", tested_how: "unit", anchors: { event_ids: ["a2"] } }] };
  await run(stub(data), collection({ passingTest: true }), methodology(), r);
  const gap = (r.missing_manual_checks ?? []).find((g) => g.id.startsWith("CONV-GAP-"));
  assert.ok(gap);
  assert.equal(gap.tested_how, "unknown", "a passing test not tied to the gap's reviewed-code work must not confirm unit");
});

test("review-surfaces.RISK.6 a gap citing ANY invalid event id is demoted to advisory (not partially grounded)", async () => {
  const r = risks();
  // mixes a real (a1) and a hallucinated (GHOST) event id.
  const data = { gaps: [{ summary: "mixed anchors", kind: "automatic", suggested_test: "x", tested_how: "none", anchors: { event_ids: ["a1", "GHOST"] } }] };
  await run(stub(data), collection(), methodology(), r);
  const gap = (r.missing_automatic_tests ?? []).find((g) => g.id.startsWith("CONV-GAP-"));
  assert.ok(gap);
  assert.match(gap.summary, /unverified anchor\(s\): GHOST/);
  assert.ok(gap.evidence?.every((e) => e.validation_status !== "valid"), "an unclean anchor set is not evidence-grounded");
  assert.ok(gap.evidence?.some((e) => e.llm_proposed === true), "demoted to advisory");
});

test("review-surfaces.RISK.6 an OK payload with no gaps array keeps the degraded flag (agent-file other-stage object)", async () => {
  const r = risks();
  const m = methodology();
  // An agent-file object meant for another stage: ok + record, but no `gaps` array.
  await run(stub({ review_focus: ["x"] }), collection(), m, r);
  assert.ok(m.quality_flags.includes("methodology_test_gap_degraded"), "an unrecognized payload must not mark the gap audit as run");
});

test("review-surfaces.RISK.6 a successful EMPTY gap audit clears the degraded flag", async () => {
  const r = risks();
  const m = methodology();
  await run(stub({ gaps: [] }), collection(), m, r);
  assert.equal((r.missing_automatic_tests ?? []).filter((g) => g.id.startsWith("CONV-GAP-")).length, 0);
  assert.ok(!m.quality_flags.includes("methodology_test_gap_degraded"), "a fully-covered conversation is analyzed, not degraded");
});

test("review-surfaces.RISK.6 appending CONV-GAP records augments the risk summary", async () => {
  const r = risks();
  r.summary = "0 test gap(s).";
  const data = { gaps: [{ summary: "a gap", kind: "automatic", suggested_test: "x", tested_how: "none", anchors: { event_ids: ["a1"] } }] };
  await run(stub(data), collection(), methodology(), r);
  assert.match(r.summary, /conversation-derived test gap/, "the summary reflects the appended CONV-GAP records");
});

test("review-surfaces.RISK.6 a malformed/missing kind is skipped, not defaulted into a gap", async () => {
  const r = risks();
  const data = {
    gaps: [
      { summary: "bogus kind", kind: "automaic", suggested_test: "x", anchors: { event_ids: ["a1"] } },
      { summary: "no kind at all", suggested_test: "x", anchors: { event_ids: ["a1"] } }
    ]
  };
  await run(stub(data), collection(), methodology(), r);
  assert.equal((r.missing_automatic_tests ?? []).filter((g) => g.id.startsWith("CONV-GAP-")).length, 0, "a typo'd kind is not coerced to automatic");
  assert.equal((r.missing_manual_checks ?? []).filter((g) => g.id.startsWith("CONV-GAP-")).length, 0);
});

test("review-surfaces.RISK.6 a path-only anchor is advisory (only event_ids count as evidence)", async () => {
  const r = risks();
  const data = { gaps: [{ summary: "cites a changed file, no event", kind: "automatic", suggested_test: "x", anchors: { paths: ["src/uploader.ts"] } }] };
  await run(stub(data), collection(), methodology(), r);
  const gap = (r.missing_automatic_tests ?? []).find((g) => g.id.startsWith("CONV-GAP-"));
  assert.ok(gap);
  assert.ok(gap.evidence?.every((e) => e.validation_status !== "valid"), "a path anchor is not accepted as valid conversation evidence");
  assert.ok(gap.evidence?.some((e) => e.llm_proposed === true), "path-only -> advisory llm-proposed fallback");
});

test("review-surfaces.RISK.7 a status:failed transcript (even exit_code 0) does not confirm tested_how", async () => {
  const r = risks();
  const coll = collection();
  (coll as unknown as { commandTranscripts: unknown[] }).commandTranscripts = [
    { id: "c1", command: "pnpm run test", status: "failed", exit_code: 0, truncated: false, source_path: "x" }
  ];
  const data = { gaps: [{ summary: "claims unit", kind: "manual", manual_check: "review", tested_how: "unit", anchors: { event_ids: ["a1"] } }] };
  await run(stub(data), coll, methodology(), r);
  const gap = (r.missing_manual_checks ?? []).find((g) => g.id.startsWith("CONV-GAP-"));
  assert.ok(gap);
  assert.equal(gap.tested_how, "unknown", "a failed test transcript must not confirm unit");
});

test("review-surfaces.RISK.7 a passed non-JS test command (pytest) confirms tested_how", async () => {
  const r = risks();
  const coll = collection();
  (coll as unknown as { commandTranscripts: unknown[] }).commandTranscripts = [
    { id: "c1", command: "pytest tests/", status: "passed", exit_code: 0, truncated: false, source_path: "x" }
  ];
  const data = { gaps: [{ summary: "py integration", kind: "manual", manual_check: "review", tested_how: "integration", anchors: { event_ids: ["a1"] } }] };
  await run(stub(data), coll, methodology(), r);
  const gap = (r.missing_manual_checks ?? []).find((g) => g.id.startsWith("CONV-GAP-"));
  assert.ok(gap);
  assert.equal(gap.tested_how, "integration", "a passed pytest run is a real test artifact");
});

test("review-surfaces.RISK.6 mock provider is a no-op (no CONV-GAP, degraded flag stays)", async () => {
  const r = risks();
  const m = methodology();
  await runConversationGapReasoning({ name: "mock", async generateStructured() { return { ok: false, reason: "mock" }; } }, { collection: collection(), intent: intent(), evaluation: evaluation(), methodology: m, risks: r }, {});
  assert.equal((r.missing_automatic_tests ?? []).filter((g) => g.id.startsWith("CONV-GAP-")).length, 0);
  assert.ok(m.quality_flags.includes("methodology_test_gap_degraded"), "the degraded flag survives a mock run");
});
