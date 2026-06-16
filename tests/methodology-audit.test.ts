import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { CollectionResult } from "../src/collector/collect";
import { ConversationEvent } from "../src/conversation/events";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { validateEvidenceRef, EvidenceValidationContext } from "../src/evidence/validate";
import { IntentModel } from "../src/intent/intent";
import { MethodologyModel } from "../src/methodology/methodology";
import { mockProvider, ReasoningProvider, StructuredResult } from "../src/llm/provider";
import { runMethodologyReasoning } from "../src/llm/reasoning";
import { RisksModel } from "../src/risks/risks";

function stubProvider(byStage: Record<string, unknown>): ReasoningProvider {
  return {
    name: "ai-sdk",
    async generateStructured(stage): Promise<StructuredResult> {
      return stage in byStage ? { ok: true, data: byStage[stage] } : { ok: false, reason: "no_stub" };
    }
  };
}

function collectionWithEvents(events: ConversationEvent[], changed: string[] = ["src/uploader.ts"]): CollectionResult {
  return {
    cwd: "/tmp/fixture",
    outputDir: "/tmp/fixture/.review-surfaces",
    manifest: { tool_version: "0.1.0", repo: "fixture", base_ref: "HEAD", head_ref: "HEAD", head_sha: "abc", run_mode: "local", input_hashes: [] },
    specIndex: { schema_version: "review-surfaces.specs.index.v1", specs: [] },
    changedFiles: changed.map((p) => ({ path: p, status: "M", source: "working_tree" })),
    docs: [],
    tests: [],
    feedback: [],
    commandTranscripts: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    repositoryFiles: changed,
    repoIndex: { files: [], ecosystems: [], clusters: [] },
    privacy: { ignore_file: ".review-surfacesignore", ignore_patterns: [], ignored_changed_files: [], diff_redactions: [], remote_provider_blocked: false, secret_findings: [] },
    git: { repo: "fixture", base_ref: "HEAD", head_ref: "HEAD", head_sha: "abc" },
    conversationEvents: events
  } as unknown as CollectionResult;
}

function methodologyDegraded(): MethodologyModel {
  return {
    summary: "Methodology extracted 3 event(s).",
    missing_logs: false,
    considered: [],
    research: [],
    decisions: [],
    unchallenged_assumptions: [],
    skipped_checks: [],
    claims_without_evidence: [],
    verified_claims: [],
    quality_flags: ["methodology_analysis_degraded"],
    evidence: [],
    workflow_findings: []
  };
}

function intent(): IntentModel {
  return {
    summary: "intent",
    spec_mode: "acai",
    requirements: [],
    constraints: [],
    non_goals: [],
    assumptions: [],
    open_questions: [],
    sources: []
  };
}

function evaluation(): EvaluationModel {
  return { summary: "", results: [], overreach: [], acai_coverage: {} };
}

function risks(): RisksModel {
  return { summary: "", items: [], test_evidence: [], test_gaps: [], missing_automatic_tests: [], missing_manual_checks: [], review_focus: [] };
}

const THREE_EVENTS: ConversationEvent[] = [
  { id: "a1", actor: "assistant", kind: "message", summary: "considered backoff", raw_index: 0 },
  { id: "a2", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 },
  { id: "u1", actor: "user", kind: "message", summary: "add retry", raw_index: 2 }
];

const FAKE_AUDIT = {
  considered: [{ text: "backoff vs fixed delay", anchors: { event_ids: ["a1"] } }],
  research: [{ text: "ran the test suite", anchors: { event_ids: ["a2"] } }],
  unchallenged: [{ text: "assumed retries are idempotent", anchors: { event_ids: ["u1"] } }],
  workflow_assessment: {
    summary: "implementation changed with no regression test",
    soundness: "questionable",
    skipped_steps: [{ text: "no regression test for the retry path", anchors: { event_ids: ["a2"] } }]
  },
  cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }]
};

test("review-surfaces.METHODOLOGY.7 the FAKE-provider leaf surfaces considered/research and emits validated advisory workflow_findings", async () => {
  const methodology = methodologyDegraded();
  await runMethodologyReasoning(stubProvider({ "methodology-audit": FAKE_AUDIT }), { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});

  // Item 4a/4b are SURFACED (not dead fields).
  assert.ok(methodology.considered.some((item) => item.includes("backoff vs fixed delay")));
  assert.ok(methodology.research.some((item) => item.includes("ran the test suite")));

  const kinds = methodology.workflow_findings.map((finding) => finding.signal_kind);
  assert.ok(kinds.includes("unchallenged_assumption"));
  assert.ok(kinds.includes("skipped_step"));
  assert.ok(kinds.includes("workflow_soundness"));
  assert.ok(kinds.includes("impl_no_test"));
  assert.ok(methodology.workflow_findings.every((finding) => finding.advisory === true));

  // The cross-ref path anchor validated against the changed-file set.
  const impl = methodology.workflow_findings.find((finding) => finding.signal_kind === "impl_no_test");
  assert.ok(impl?.evidence.some((ref) => ref.kind === "file" && ref.path === "src/uploader.ts" && ref.validation_status === "valid"));

  // The deep audit RAN -> the degraded marker is cleared.
  assert.ok(!methodology.quality_flags.includes("methodology_analysis_degraded"));
});

test("review-surfaces.METHODOLOGY.7 the leaf output is byte-stable across reruns", async () => {
  const run = async (): Promise<MethodologyModel> => {
    const methodology = methodologyDegraded();
    await runMethodologyReasoning(stubProvider({ "methodology-audit": FAKE_AUDIT }), { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
    return methodology;
  };
  assert.equal(JSON.stringify(await run()), JSON.stringify(await run()));
});

test("review-surfaces.METHODOLOGY.7 an invalid anchor demotes (does not drop) the finding", async () => {
  const methodology = methodologyDegraded();
  const audit = {
    unchallenged: [{ text: "assumed thing", anchors: { event_ids: ["NOPE"] } }],
    cross_ref_flags: [{ signal: "impl_no_test", text: "changed", anchors: { paths: ["src/does-not-exist.ts"] } }]
  };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});

  const unchallenged = methodology.workflow_findings.find((finding) => finding.signal_kind === "unchallenged_assumption");
  assert.ok(unchallenged, "finding is not dropped");
  assert.match(unchallenged.summary, /unverified anchor.*NOPE/);
  // No valid anchor -> the fallback evidence is llm_proposed (can never count as proof).
  assert.ok(unchallenged.evidence.every((ref) => ref.llm_proposed === true));

  const impl = methodology.workflow_findings.find((finding) => finding.signal_kind === "impl_no_test");
  assert.match(impl?.summary ?? "", /unverified anchor.*does-not-exist/);
});

test("review-surfaces.METHODOLOGY.7 the mock provider leaves the degraded fallback intact (no deep audit)", async () => {
  const methodology = methodologyDegraded();
  await runMethodologyReasoning(mockProvider, { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(methodology.quality_flags.includes("methodology_analysis_degraded"));
  assert.deepEqual(methodology.workflow_findings, []);
});

test("review-surfaces.METHODOLOGY.7 exceeding the event budget sets conversation_truncated, never silent", async () => {
  const many: ConversationEvent[] = Array.from({ length: 120 }, (_value, index) => ({
    id: `e${index}`,
    actor: "assistant",
    kind: "message",
    summary: `turn ${index}`,
    raw_index: index
  }));
  const methodology = methodologyDegraded();
  await runMethodologyReasoning(stubProvider({ "methodology-audit": {} }), { collection: collectionWithEvents(many), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(methodology.quality_flags.includes("conversation_truncated"));
  assert.ok(methodology.skipped_checks.some((line) => /audit was partial|only the first/i.test(line)));
});

// review-surfaces.METHODOLOGY.7 (D5): the event_id validation branch + the closed
// conversation-kind path-fall-through.
test("review-surfaces.METHODOLOGY.7 validateEvidenceRef binds event_id to the known-event-id set", () => {
  const context: EvidenceValidationContext = {
    cwd: path.resolve("."),
    knownEventIds: new Set(["a1", "CMD-TEST"]),
    knownPaths: new Set(["src/uploader.ts"])
  };

  // A known event_id on a conversation ref validates.
  assert.equal(validateEvidenceRef({ kind: "conversation", event_id: "a1", confidence: "low" }, context).validation_status, "valid");
  // An unknown event_id is invalid.
  assert.equal(validateEvidenceRef({ kind: "conversation", event_id: "ghost", confidence: "low" }, context).validation_status, "invalid");
  // A conversation ref with a KNOWN path but NO event_id no longer validates on
  // path membership alone (the closed fall-through).
  assert.equal(validateEvidenceRef({ kind: "conversation", path: "src/uploader.ts", confidence: "low" }, context).validation_status, "invalid");
  // The event_id branch also guards non-conversation kinds.
  assert.equal(validateEvidenceRef({ kind: "command", command: "pnpm run test", event_id: "CMD-TEST", confidence: "low" }, context).validation_status, "valid");
  assert.equal(validateEvidenceRef({ kind: "command", command: "pnpm run test", event_id: "CMD-GHOST", confidence: "low" }, context).validation_status, "invalid");
});

test("review-surfaces.METHODOLOGY.8 a path anchor that is not a CHANGED file is rejected (demoted)", async () => {
  const methodology = methodologyDegraded();
  // src/uploader.ts is changed (valid); src/unchanged.ts exists in the repo set
  // but is NOT in changedFiles, so it must be rejected as an audit anchor.
  const collection = collectionWithEvents(THREE_EVENTS, ["src/uploader.ts"]);
  (collection as { repositoryFiles: string[] }).repositoryFiles = ["src/uploader.ts", "src/unchanged.ts"];
  const audit = {
    cross_ref_flags: [
      { signal: "impl_no_test", text: "changed file", anchors: { paths: ["src/uploader.ts"] } },
      { signal: "api_no_compat", text: "unchanged file cited", anchors: { paths: ["src/unchanged.ts"] } }
    ]
  };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection, intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});

  const changed = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(changed?.evidence.some((e) => e.kind === "file" && e.validation_status === "valid"));
  const unchanged = methodology.workflow_findings.find((f) => f.signal_kind === "api_no_compat");
  assert.match(unchanged?.summary ?? "", /unverified anchor.*src\/unchanged\.ts/);
});

test("review-surfaces.METHODOLOGY.7 considered/research are surfaced only when their anchors validate", async () => {
  const methodology = methodologyDegraded();
  const audit = {
    considered: [
      { text: "anchored alternative", anchors: { event_ids: ["a1"] } },
      { text: "hallucinated alternative", anchors: { event_ids: ["GHOST"] } }
    ],
    research: [{ text: "ungrounded research with no anchors" }]
  };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});

  assert.ok(methodology.considered.some((c) => c.includes("anchored alternative")));
  assert.ok(!methodology.considered.some((c) => c.includes("hallucinated alternative")));
  assert.ok(!methodology.research.some((r) => r.includes("ungrounded research")));
});
