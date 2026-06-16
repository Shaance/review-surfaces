import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CollectionResult } from "../src/collector/collect";
import { ConversationEvent } from "../src/conversation/events";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { validateEvidenceRef, EvidenceValidationContext } from "../src/evidence/validate";
import { IntentModel } from "../src/intent/intent";
import { MethodologyModel } from "../src/methodology/methodology";
import { mockProvider, ReasoningProvider, StructuredResult } from "../src/llm/provider";
import { runMethodologyReasoning } from "../src/llm/reasoning";
import { buildRiskReviewFocus, RisksModel } from "../src/risks/risks";

function stubProvider(byStage: Record<string, unknown>): ReasoningProvider {
  return {
    name: "ai-sdk",
    async generateStructured(stage): Promise<StructuredResult> {
      return stage in byStage ? { ok: true, data: byStage[stage] } : { ok: false, reason: "no_stub" };
    }
  };
}

// A UNIQUE temp cwd per call so the per-conversation ai-sdk audit cache (issue #95)
// never carries over between tests (these stubs use the "ai-sdk" name, which the
// cache is active for) — each test sees a cold cache.
let cwdCounter = 0;
function freshFixtureCwd(): string {
  const dir = path.join(os.tmpdir(), "rs-mau-fixture", `${process.pid}-${cwdCounter++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function collectionWithEvents(events: ConversationEvent[], changed: string[] = ["src/uploader.ts"]): CollectionResult {
  const cwd = freshFixtureCwd();
  return {
    cwd,
    outputDir: path.join(cwd, ".review-surfaces"),
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
  const many: ConversationEvent[] = Array.from({ length: 300 }, (_value, index) => ({
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

test("review-surfaces.METHODOLOGY.7 a non-ok provider adds no truncation flag (nothing was analyzed)", async () => {
  const many: ConversationEvent[] = Array.from({ length: 300 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `t${index}`, raw_index: index }));
  const methodology = methodologyDegraded();
  // stub with no methodology-audit data -> generateStructured returns {ok:false}.
  await runMethodologyReasoning(stubProvider({}), { collection: collectionWithEvents(many), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(!methodology.quality_flags.includes("conversation_truncated"));
  assert.ok(methodology.quality_flags.includes("methodology_analysis_degraded"));
});

test("review-surfaces.METHODOLOGY.7 an ok-but-empty audit payload does not clear the degraded flag", async () => {
  const methodology = methodologyDegraded();
  await runMethodologyReasoning(stubProvider({ "methodology-audit": {} }), { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(methodology.quality_flags.includes("methodology_analysis_degraded"));
  assert.deepEqual(methodology.workflow_findings, []);
});

test("review-surfaces.METHODOLOGY.7 a workflow-soundness finding borrows the skipped-step anchors so it stays evidence-bound", async () => {
  const methodology = methodologyDegraded();
  await runMethodologyReasoning(stubProvider({ "methodology-audit": FAKE_AUDIT }), { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const soundness = methodology.workflow_findings.find((f) => f.signal_kind === "workflow_soundness");
  assert.ok(soundness);
  assert.ok(soundness.evidence.some((ref) => ref.validation_status === "valid"));
});

test("review-surfaces.METHODOLOGY.5 workflow findings feed the risk review focus", () => {
  const withFindings = { ...methodologyDegraded(), workflow_findings: [{ id: "WF-001", signal_kind: "impl_no_test" as const, summary: "x", severity: "medium" as const, advisory: true, evidence: [] }] };
  const focus = buildRiskReviewFocus(withFindings);
  assert.ok(focus.some((line) => /workflow finding/.test(line)));
  // Empty on the deterministic path (no findings) -> no extra line (byte-stable).
  assert.ok(!buildRiskReviewFocus(methodologyDegraded()).some((line) => /workflow finding/.test(line)));
});

test("review-surfaces.METHODOLOGY.7 an event id beyond the audit cap is not a valid anchor", async () => {
  const many: ConversationEvent[] = Array.from({ length: 300 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `t${index}`, raw_index: index }));
  const methodology = methodologyDegraded();
  const audit = {
    unchallenged: [
      { text: "anchored within the cap", anchors: { event_ids: ["e5"] } },
      { text: "anchored beyond the cap", anchors: { event_ids: ["e250"] } }
    ]
  };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(many, []), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const findings = methodology.workflow_findings.filter((f) => f.signal_kind === "unchallenged_assumption");
  const beyond = findings.find((f) => /beyond the cap/.test(f.summary));
  assert.match(beyond?.summary ?? "", /unverified anchor.*e250/);
  const within = findings.find((f) => /within the cap/.test(f.summary));
  assert.ok(within?.evidence.some((ref) => ref.validation_status === "valid"));
});

test("review-surfaces.METHODOLOGY.7 a sound workflow assessment clears the degraded flag", async () => {
  const methodology = methodologyDegraded();
  await runMethodologyReasoning(stubProvider({ "methodology-audit": { workflow_assessment: { soundness: "sound", summary: "workflow is sound" } } }), { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(!methodology.quality_flags.includes("methodology_analysis_degraded"));
});

test("review-surfaces.METHODOLOGY.7 a command-transcript id is not a valid CONVERSATION anchor", async () => {
  const collection = collectionWithEvents(THREE_EVENTS);
  (collection as { commandTranscripts: unknown[] }).commandTranscripts = [
    { id: "CMD-X", command: "pnpm run test", status: "passed", exit_code: 0, truncated: false, source_path: "x" }
  ];
  const methodology = methodologyDegraded();
  const audit = { unchallenged: [{ text: "cites a command id as a conversation event", anchors: { event_ids: ["CMD-X"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection, intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const finding = methodology.workflow_findings.find((f) => f.signal_kind === "unchallenged_assumption");
  assert.match(finding?.summary ?? "", /unverified anchor.*CMD-X/);
});

test("review-surfaces.METHODOLOGY.7 (D3) map-reduce dedups findings across chunks deterministically", async () => {
  // 160 events -> 2 chunks of 80; the stub returns the same finding for each chunk,
  // so the deterministic merge must dedup to ONE finding, not two.
  const many: ConversationEvent[] = Array.from({ length: 160 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `t${index}`, raw_index: index }));
  const audit = { unchallenged: [{ text: "assumed retries are idempotent", anchors: { event_ids: ["e0"] } }] };
  const run = async (): Promise<MethodologyModel> => {
    const methodology = methodologyDegraded();
    await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(many, []), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
    return methodology;
  };
  const methodology = await run();
  const unchallenged = methodology.workflow_findings.filter((f) => f.signal_kind === "unchallenged_assumption");
  assert.equal(unchallenged.length, 1, "duplicate findings across chunks must merge to one");
  // Deterministic across reruns.
  assert.equal(JSON.stringify(await run()), JSON.stringify(methodology));
});

test("review-surfaces.METHODOLOGY.7 (D3) salience keeps a late high-value tool_call over chit-chat", async () => {
  // 300 low-salience messages + one high-salience tool_call (touches a changed
  // file) at index 290. The budget is 240, so by raw_index alone e290 would be
  // dropped; salience must keep it (anchor validates) while a late chit-chat event
  // (e250) is dropped (anchor demoted).
  const events: ConversationEvent[] = Array.from({ length: 300 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `chatter ${index}`, raw_index: index }));
  events[290] = { id: "e290", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", file: "src/uploader.ts", raw_index: 290 };
  const methodology = methodologyDegraded();
  const audit = {
    research: [{ text: "ran the suite (high-salience late tool call)", anchors: { event_ids: ["e290"] } }],
    unchallenged: [{ text: "cites a dropped chit-chat event", anchors: { event_ids: ["e250"] } }]
  };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  // The late high-salience tool_call was analyzed -> its research item is surfaced.
  assert.ok(methodology.research.some((r) => r.includes("high-salience late tool call")));
  // The dropped chit-chat anchor is demoted.
  const dropped = methodology.workflow_findings.find((f) => /dropped chit-chat/.test(f.summary));
  assert.match(dropped?.summary ?? "", /unverified anchor.*e250/);
});

function countingStub(perCall: (unknown | undefined)[]): ReasoningProvider {
  let i = 0;
  return {
    name: "ai-sdk",
    async generateStructured(stage): Promise<StructuredResult> {
      if (stage !== "methodology-audit") return { ok: false, reason: "no" };
      const data = perCall[i];
      i += 1;
      return data === undefined ? { ok: false, reason: "batch_fail" } : { ok: true, data };
    }
  };
}

test("review-surfaces.METHODOLOGY.7 (D3) a failed batch flags a partial audit", async () => {
  const many: ConversationEvent[] = Array.from({ length: 160 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `t${index}`, raw_index: index }));
  const methodology = methodologyDegraded();
  // batch 0 ok, batch 1 fails.
  const provider = countingStub([{ unchallenged: [{ text: "assumed thing", anchors: { event_ids: ["e0"] } }] }, undefined]);
  await runMethodologyReasoning(provider, { collection: collectionWithEvents(many, []), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(methodology.quality_flags.includes("conversation_truncated"));
  assert.ok(methodology.skipped_checks.some((line) => /batch did not respond/.test(line)));
  // The successful batch still produced a finding.
  assert.ok(methodology.workflow_findings.some((f) => f.signal_kind === "unchallenged_assumption"));
});

test("review-surfaces.METHODOLOGY.7 (D3) workflow soundness takes the WORST verdict across chunks with its anchor", async () => {
  const many: ConversationEvent[] = Array.from({ length: 160 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `t${index}`, raw_index: index }));
  const methodology = methodologyDegraded();
  // chunk 0 (e0..e79) = sound; chunk 1 (e80..e159) = unsound, anchored to e80.
  const provider = countingStub([
    { workflow_assessment: { soundness: "sound", summary: "looks fine" } },
    { workflow_assessment: { soundness: "unsound", summary: "no tests at all", anchors: { event_ids: ["e80"] } } }
  ]);
  await runMethodologyReasoning(provider, { collection: collectionWithEvents(many, []), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const soundness = methodology.workflow_findings.find((f) => f.signal_kind === "workflow_soundness");
  assert.ok(soundness);
  assert.equal(soundness.severity, "high");
  assert.match(soundness.summary, /no tests at all/);
  assert.ok(soundness.evidence.some((ref) => ref.validation_status === "valid"));
});

test("review-surfaces.METHODOLOGY.7 (D3) skipped steps are preserved even without a soundness verdict", async () => {
  const methodology = methodologyDegraded();
  const provider = countingStub([{ workflow_assessment: { skipped_steps: [{ text: "no regression test", anchors: { event_ids: ["a2"] } }] } }]);
  await runMethodologyReasoning(provider, { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(methodology.workflow_findings.some((f) => f.signal_kind === "skipped_step" && /no regression test/.test(f.summary)));
});

test("review-surfaces.METHODOLOGY.7 (D3) the partial-audit note reports the ACTUAL analyzed event count", async () => {
  const many: ConversationEvent[] = Array.from({ length: 300 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `t${index}`, raw_index: index }));
  const methodology = methodologyDegraded();
  // 300 events -> 240 selected -> 3 batches; the middle batch fails -> 160 analyzed.
  const provider = countingStub([{ unchallenged: [{ text: "x", anchors: { event_ids: ["e0"] } }] }, undefined, { unchallenged: [{ text: "y", anchors: { event_ids: ["e160"] } }] }]);
  await runMethodologyReasoning(provider, { collection: collectionWithEvents(many, []), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(methodology.skipped_checks.some((line) => /160 of 300/.test(line)), methodology.skipped_checks.join(" | "));
});

test("review-surfaces.METHODOLOGY.7 (D3) salience boosts a shell command that names a changed file", async () => {
  const events: ConversationEvent[] = Array.from({ length: 300 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `chatter ${index}`, raw_index: index }));
  events[295] = { id: "e295", actor: "assistant", kind: "tool_call", summary: "ran a diff", tool: "Bash", command: "git diff src/uploader.ts", raw_index: 295 };
  const methodology = methodologyDegraded();
  const audit = { research: [{ text: "diffed the changed file", anchors: { event_ids: ["e295"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(methodology.research.some((r) => r.includes("diffed the changed file")));
});

test("review-surfaces.METHODOLOGY.7 (D3) duplicate finding evidence is unioned across chunks", async () => {
  const many: ConversationEvent[] = Array.from({ length: 160 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `t${index}`, raw_index: index }));
  const methodology = methodologyDegraded();
  // Same finding text, anchored to e0 in chunk 1 and e80 in chunk 2.
  const provider = countingStub([
    { unchallenged: [{ text: "assumed idempotent", anchors: { event_ids: ["e0"] } }] },
    { unchallenged: [{ text: "assumed idempotent", anchors: { event_ids: ["e80"] } }] }
  ]);
  await runMethodologyReasoning(provider, { collection: collectionWithEvents(many, []), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const finding = methodology.workflow_findings.find((f) => f.signal_kind === "unchallenged_assumption");
  assert.ok(finding);
  const eventIds = finding.evidence.filter((e) => e.validation_status === "valid").map((e) => e.event_id);
  assert.ok(eventIds.includes("e0") && eventIds.includes("e80"), `expected both anchors, got ${eventIds.join(",")}`);
  assert.ok(!/unverified anchor/.test(finding.summary));
});

test("review-surfaces.METHODOLOGY.7 (D3) an impl_no_test flag is contextualized when a test actually ran", async () => {
  const methodology = methodologyDegraded();
  // The changed file is edited (raw 0), THEN a test runs (raw 1) — a post-change
  // test reconciles the impl_no_test flag.
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "a2", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.match(impl.summary, /test execution was observed elsewhere/);
});

test("review-surfaces.METHODOLOGY.7 (D3) merely READING a test file does not count as a test run", async () => {
  const events: ConversationEvent[] = [
    { id: "u1", actor: "user", kind: "message", summary: "change the uploader", raw_index: 0 },
    { id: "r1", actor: "assistant", kind: "tool_call", summary: "Read(tests/uploader.test.ts)", tool: "Read", command: "tests/uploader.test.ts", raw_index: 1 },
    { id: "a1", actor: "assistant", kind: "message", summary: "done", raw_index: 2 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "a test-file READ must not reconcile the impl_no_test flag");
});

test("review-surfaces.METHODOLOGY.7 (D3) a monorepo-filtered test command counts as a test run (Codex P2)", async () => {
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "a1", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm --filter api test)", tool: "Bash", command: "pnpm --filter api test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.match(impl.summary, /test execution was observed elsewhere/, "a `pnpm --filter` selector test run must reconcile the impl_no_test flag");
});

test("review-surfaces.METHODOLOGY.7 (D3) a test-related skipped_step is reconciled when a test ran in another chunk (Codex P2)", async () => {
  const methodology = methodologyDegraded();
  // The changed file is edited (raw 0), then a test runs (raw 1); a chunk that
  // emitted "no regression test" from a partial view is contextualized post-change.
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "a2", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const audit = { workflow_assessment: { skipped_steps: [{ text: "no regression test was added", anchors: { event_ids: ["a2"] } }] } };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const skipped = methodology.workflow_findings.find((f) => f.signal_kind === "skipped_step");
  assert.ok(skipped);
  assert.match(skipped.summary, /test execution was observed elsewhere/);
});

test("review-surfaces.METHODOLOGY.7 (D3) a non-test skipped_step is NOT spuriously reconciled by a test run (Codex P2)", async () => {
  const methodology = methodologyDegraded();
  const audit = { workflow_assessment: { skipped_steps: [{ text: "no design review before the refactor", anchors: { event_ids: ["a2"] } }] } };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const skipped = methodology.workflow_findings.find((f) => f.signal_kind === "skipped_step");
  assert.ok(skipped);
  assert.ok(!/test execution was observed/.test(skipped.summary), "an unrelated skipped step must not get the test-reconciliation note");
});

test("review-surfaces.METHODOLOGY.7 (D3) salience-ordered batches keep a late high-value event when a later batch fails", async () => {
  const events: ConversationEvent[] = Array.from({ length: 300 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `chatter ${index}`, raw_index: index }));
  events[295] = { id: "e295", actor: "assistant", kind: "tool_call", summary: "edited the file", tool: "Edit", file: "src/uploader.ts", raw_index: 295 };
  const methodology = methodologyDegraded();
  // 3 selected batches; the LAST one fails. e295 is high-salience so it must be in
  // an early (analyzed) batch, not the dropped last one.
  const provider = countingStub([
    { research: [{ text: "edited the changed file", anchors: { event_ids: ["e295"] } }] },
    { research: [{ text: "edited the changed file", anchors: { event_ids: ["e295"] } }] },
    undefined
  ]);
  await runMethodologyReasoning(provider, { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(methodology.research.some((r) => r.includes("edited the changed file")));
});

test("review-surfaces.METHODOLOGY.7 (D3) a validation command in event.command raises salience", async () => {
  const events: ConversationEvent[] = Array.from({ length: 300 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `chatter ${index}`, raw_index: index }));
  // generic summary, but the actual validation command is in event.command.
  events[295] = { id: "e295", actor: "assistant", kind: "tool_call", summary: "ran a command", tool: "Bash", command: "pytest tests/unit.py", raw_index: 295 };
  const methodology = methodologyDegraded();
  const audit = { research: [{ text: "ran the test suite", anchors: { event_ids: ["e295"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, []), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(methodology.research.some((r) => r.includes("ran the test suite")));
});

test("review-surfaces.METHODOLOGY.7 (D3) an analyzed-but-empty chunk is reported", async () => {
  const many: ConversationEvent[] = Array.from({ length: 160 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `t${index}`, raw_index: index }));
  const methodology = methodologyDegraded();
  // chunk 0 returns an empty payload; chunk 1 returns a real finding.
  const provider = countingStub([{}, { unchallenged: [{ text: "assumed thing", anchors: { event_ids: ["e80"] } }] }]);
  await runMethodologyReasoning(provider, { collection: collectionWithEvents(many, []), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(methodology.skipped_checks.some((line) => /1 of 2 analyzed chunk\(s\) returned no recognizable audit content/.test(line)), methodology.skipped_checks.join(" | "));
});

test("review-surfaces.METHODOLOGY.7 (D3) a Windows-separated changed-file path earns the salience boost (Codex P2)", async () => {
  // 245 generic tool_calls (salience 4) + one tool_call whose event.file uses
  // backslashes for the changed file. Only if the path is normalized does it reach
  // salience 6; sitting at the LAST raw_index it would otherwise tie at 4 and be
  // dropped by the 240 budget, so its research only surfaces when the boost applies.
  const events: ConversationEvent[] = Array.from({ length: 245 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "tool_call", summary: "Bash(ls)", tool: "Bash", command: "ls", raw_index: index }));
  events.push({ id: "win", actor: "assistant", kind: "tool_call", summary: "edited the file", tool: "Edit", file: "src\\uploader.ts", raw_index: 245 });
  const methodology = methodologyDegraded();
  const audit = { research: [{ text: "edited the changed file via a Windows path", anchors: { event_ids: ["win"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  assert.ok(methodology.research.some((r) => r.includes("Windows path")), "a backslash-separated changed-file path must earn the salience boost and be analyzed");
});

test("review-surfaces.METHODOLOGY.7 (D3) per-chunk soundness verdicts merge to one worst finding (Codex P2)", async () => {
  const many: ConversationEvent[] = Array.from({ length: 160 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `t${index}`, raw_index: index }));
  const methodology = methodologyDegraded();
  // 160 events -> 2 chunks; each returns a different non-sound overall verdict.
  const provider = countingStub([
    { workflow_assessment: { soundness: "questionable", summary: "some concerns", skipped_steps: [] } },
    { workflow_assessment: { soundness: "unsound", summary: "no tests at all", skipped_steps: [] } }
  ]);
  await runMethodologyReasoning(provider, { collection: collectionWithEvents(many, []), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const soundness = methodology.workflow_findings.filter((f) => f.signal_kind === "workflow_soundness");
  assert.equal(soundness.length, 1, "all chunk soundness verdicts must merge into one overall finding");
  assert.equal(soundness[0].severity, "high", "the worst (unsound) verdict wins");
  assert.match(soundness[0].summary, /no tests at all/);
});

test("review-surfaces.METHODOLOGY.7 (D3) a command that only MENTIONS a runner is not a test run (Codex P2)", async () => {
  const events: ConversationEvent[] = [
    { id: "u1", actor: "user", kind: "message", summary: "change the uploader", raw_index: 0 },
    { id: "g1", actor: "assistant", kind: "tool_call", summary: "Bash(grep pytest pyproject.toml)", tool: "Bash", command: "grep pytest pyproject.toml", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "grep-ing for a runner name must not count as a test run");
});

test("review-surfaces.METHODOLOGY.7 (D3) an adjacent same-kind tool event is NOT pulled in as a partner (Codex P2)", async () => {
  // c1 (raw 0) and the high-salience fillers touch the changed file + run a test;
  // c2 (raw 1) is a low-salience generic tool_call ranked last under the budget. c2
  // is only selected if it is wrongly pulled in as c1's "partner" — but a tool_call's
  // partner must be a tool_RESULT, so c2 stays out and an audit anchored to it is
  // reported as unverified.
  const events: ConversationEvent[] = [
    { id: "c1", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test src/uploader.ts)", tool: "Bash", command: "pnpm run test src/uploader.ts", raw_index: 0 },
    { id: "c2", actor: "assistant", kind: "tool_call", summary: "Bash(ls)", tool: "Bash", command: "ls", raw_index: 1 }
  ];
  for (let i = 2; i < 245; i += 1) {
    events.push({ id: `f${i}`, actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test src/uploader.ts)", tool: "Bash", command: "pnpm run test src/uploader.ts", raw_index: i });
  }
  const methodology = methodologyDegraded();
  const audit = { unchallenged: [{ text: "assumed the ls output mattered", anchors: { event_ids: ["c2"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const finding = methodology.workflow_findings.find((f) => f.signal_kind === "unchallenged_assumption");
  assert.ok(finding);
  assert.match(finding.summary, /unverified anchor\(s\): c2/, "c2 must not be selected via a same-kind partner pull");
});

test("review-surfaces.METHODOLOGY.7 (D3) the merged soundness verdict keeps its OWN anchor, not the loser's (Codex P2)", async () => {
  const many: ConversationEvent[] = Array.from({ length: 160 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `t${index}`, raw_index: index }));
  const methodology = methodologyDegraded();
  // chunk 0: a LOWER-severity questionable verdict WITH a valid anchor (e0);
  // chunk 1: the WORST verdict (unsound) with NO anchor. The merged finding must not
  // borrow e0 and present the unsound verdict as evidence-bound.
  const provider = countingStub([
    { workflow_assessment: { soundness: "questionable", summary: "some concerns", anchors: { event_ids: ["e0"] }, skipped_steps: [] } },
    { workflow_assessment: { soundness: "unsound", summary: "no tests at all", skipped_steps: [] } }
  ]);
  await runMethodologyReasoning(provider, { collection: collectionWithEvents(many, []), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const soundness = methodology.workflow_findings.filter((f) => f.signal_kind === "workflow_soundness");
  assert.equal(soundness.length, 1);
  assert.match(soundness[0].summary, /no tests at all/, "the worst (unsound) verdict wins");
  assert.ok(!soundness[0].evidence.some((ref) => ref.event_id === "e0" && ref.validation_status === "valid"), "the unsound verdict must not borrow the questionable chunk's anchor");
});

test("review-surfaces.METHODOLOGY.7 (D3) a chained test command (not first) counts as a test run (Codex P2)", async () => {
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "a1", actor: "assistant", kind: "tool_call", summary: "Bash(cd api && pnpm test)", tool: "Bash", command: "cd api && pnpm test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.match(impl.summary, /test execution was observed elsewhere/, "a test in a later shell segment must reconcile the impl_no_test flag");
});

test("review-surfaces.METHODOLOGY.7 (D3) a test that ran BEFORE the change does not reconcile a no-test finding (Codex P2)", async () => {
  // A baseline test at index 0, then the edit to the changed file at index 1. The
  // test predates the change, so it cannot cover it and must NOT reconcile.
  const beforeEvents: ConversationEvent[] = [
    { id: "t0", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 0 },
    { id: "e1", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 1 }
  ];
  const before = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(beforeEvents, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology: before, risks: risks() }, {});
  const implBefore = before.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(implBefore);
  assert.ok(!/test execution was observed/.test(implBefore.summary), "a pre-change test must not reconcile a no-test finding");

  // The mirror: the edit at index 0, then the test at index 1 (after) DOES reconcile.
  const afterEvents: ConversationEvent[] = [
    { id: "e0", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "t1", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const after = methodologyDegraded();
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(afterEvents, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology: after, risks: risks() }, {});
  const implAfter = after.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(implAfter);
  assert.match(implAfter.summary, /test execution was observed elsewhere/, "a post-change test must reconcile the finding");
});

test("review-surfaces.METHODOLOGY.7 (D3) a changed-file mention in message text earns the salience boost (Codex P2)", async () => {
  // 245 generic user messages (salience 2) + one user instruction that names the
  // changed file in its summary. Only if the summary is matched does it reach
  // salience 4 and outrank the chatter; at the LAST index it would otherwise tie at
  // 2 and be dropped by the 240 budget, demoting its anchor.
  const events: ConversationEvent[] = Array.from({ length: 245 }, (_v, index) => ({ id: `u${index}`, actor: "user", kind: "message", summary: `chatter ${index}`, raw_index: index }));
  events.push({ id: "req", actor: "user", kind: "message", summary: "change src/uploader.ts but keep the API stable", raw_index: 245 });
  const methodology = methodologyDegraded();
  const audit = { unchallenged: [{ text: "assumed the API stays stable", anchors: { event_ids: ["req"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const finding = methodology.workflow_findings.find((f) => f.signal_kind === "unchallenged_assumption");
  assert.ok(finding);
  assert.ok(!/unverified anchor/.test(finding.summary), "a user instruction naming the changed file must be kept by the salience boost");
});

test("review-surfaces.METHODOLOGY.7 (D3) no selected event touches the changed file -> ordering unknown, no reconciliation (Codex P2)", async () => {
  // A test runs but NOTHING in the stream touches the changed file, so the selected
  // slice cannot establish the test ran after the change; do not reconcile.
  const events: ConversationEvent[] = [
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 0 },
    { id: "a", actor: "assistant", kind: "message", summary: "done", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "with no changed-file touch the order is unknown, so do not reconcile");
});

test("review-surfaces.METHODOLOGY.7 (D3) a .tsx mention does not count as touching the .ts changed file (Codex P2)", async () => {
  // The only file-ish mention is src/uploader.tsx (a DIFFERENT file). With a
  // boundary-aligned match no change touch is established, so the post-change test
  // ordering is unknown and the finding is not reconciled.
  const events: ConversationEvent[] = [
    { id: "r", actor: "assistant", kind: "tool_call", summary: "Bash(cat src/uploader.tsx)", tool: "Bash", command: "cat src/uploader.tsx", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "a .tsx mention must not be treated as touching the .ts changed file");
});

test("review-surfaces.METHODOLOGY.7 (D3) a newline-separated test command counts as a test run (Codex P2)", async () => {
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "a1", actor: "assistant", kind: "tool_call", summary: "Bash(cd api ; pnpm test)", tool: "Bash", command: "cd api\npnpm test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.match(impl.summary, /test execution was observed elsewhere/, "a newline-separated test command must reconcile the impl_no_test flag");
});

test("review-surfaces.METHODOLOGY.7 (D3) an equal-severity soundness tie prefers the grounded verdict (Codex P2)", async () => {
  const many: ConversationEvent[] = Array.from({ length: 160 }, (_v, index) => ({ id: `e${index}`, actor: "assistant", kind: "message", summary: `t${index}`, raw_index: index }));
  const methodology = methodologyDegraded();
  // Both chunks return a same-severity questionable verdict; chunk 0 is unanchored,
  // chunk 1 cites a valid event. The tie must resolve to the grounded verdict.
  const provider = countingStub([
    { workflow_assessment: { soundness: "questionable", summary: "first concern", skipped_steps: [] } },
    { workflow_assessment: { soundness: "questionable", summary: "second concern", anchors: { event_ids: ["e80"] }, skipped_steps: [] } }
  ]);
  await runMethodologyReasoning(provider, { collection: collectionWithEvents(many, []), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const soundness = methodology.workflow_findings.filter((f) => f.signal_kind === "workflow_soundness");
  assert.equal(soundness.length, 1);
  assert.ok(soundness[0].evidence.some((ref) => ref.event_id === "e80" && ref.validation_status === "valid"), "the grounded verdict's anchor is kept on a severity tie");
});

test("review-surfaces.METHODOLOGY.7 (D3) a test before the EDIT (after only a mention) does not reconcile (Codex P2)", async () => {
  // The file is mentioned (raw 0), a baseline test runs (raw 1), THEN the file is
  // edited (raw 2). The ordering anchor must be the EDIT, so the baseline test is
  // pre-change and does not reconcile.
  const events: ConversationEvent[] = [
    { id: "u1", actor: "user", kind: "message", summary: "please change src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 },
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 2 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "a test after only a mention but before the edit must not reconcile");
});

test("review-surfaces.METHODOLOGY.7 (D3) an edit to a DIFFERENT repo-relative path is not the changed file (Codex P2)", async () => {
  // `packages/api/src/uploader.ts` merely ends with the changed `src/uploader.ts`
  // but is a different file; suffix-matching it would start the ordering clock on
  // the wrong file. Only an absolute path may suffix-match.
  const diffEvents: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(packages/api/src/uploader.ts)", tool: "Edit", file: "packages/api/src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const diff = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(diffEvents, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology: diff, risks: risks() }, {});
  const implDiff = diff.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(implDiff);
  assert.ok(!/test execution was observed/.test(implDiff.summary), "a different repo-relative path must not be treated as the changed file");

  // An ABSOLUTE path ending with the changed path IS the changed file.
  const absEvents: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(/Users/me/repo/src/uploader.ts)", tool: "Edit", file: "/Users/me/repo/src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const abs = methodologyDegraded();
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(absEvents, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology: abs, risks: risks() }, {});
  const implAbs = abs.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(implAbs);
  assert.match(implAbs.summary, /test execution was observed elsewhere/, "an absolute path ending with the changed path is the changed file");
});

test("review-surfaces.METHODOLOGY.7 (D3) a python-wrapped test runner counts as a test run (Codex P3)", async () => {
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(python -m pytest)", tool: "Bash", command: "python -m pytest tests/", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.match(impl.summary, /test execution was observed elsewhere/, "`python -m pytest` must count as a test run");
});

test("review-surfaces.METHODOLOGY.7 (D3) prose like 'password' does not earn the validation salience boost (Codex P3)", async () => {
  // 245 generic user messages (salience 2) + one whose text merely contains
  // 'password' (NOT a validation event). Only an unbounded keyword match would lift
  // it to salience 4; with whole-word bounding it ties at 2 and is dropped.
  const events: ConversationEvent[] = Array.from({ length: 245 }, (_v, index) => ({ id: `u${index}`, actor: "user", kind: "message", summary: `chatter ${index}`, raw_index: index }));
  events.push({ id: "pw", actor: "user", kind: "message", summary: "reviewing the password handling logic", raw_index: 245 });
  const methodology = methodologyDegraded();
  const audit = { unchallenged: [{ text: "assumed password handling is fine", anchors: { event_ids: ["pw"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const finding = methodology.workflow_findings.find((f) => f.signal_kind === "unchallenged_assumption");
  assert.ok(finding);
  assert.match(finding.summary, /unverified anchor\(s\): pw/, "'password' must not earn the validation boost and survive the budget");
});

test("review-surfaces.METHODOLOGY.7 (D3) pulling a low-salience partner never evicts a higher-ranked event (Codex P2)", async () => {
  // 121 high-salience changed-file/test tool_calls (sal 8) each followed by a
  // low-salience tool_result (sal 3): 242 events, budget 240. The greedy old pull
  // filled the budget at 120 calls + 120 results, dropping call #121; winner-based
  // selection keeps all 121 calls (the results rank below them).
  const events: ConversationEvent[] = [];
  for (let i = 0; i < 121; i += 1) {
    events.push({ id: `c${i}`, actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test src/uploader.ts)", tool: "Bash", command: "pnpm run test src/uploader.ts", raw_index: i * 2 });
    events.push({ id: `r${i}`, actor: "tool", kind: "tool_result", summary: "ok", raw_index: i * 2 + 1 });
  }
  const methodology = methodologyDegraded();
  const audit = { unchallenged: [{ text: "assumed the last call mattered", anchors: { event_ids: ["c120"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const finding = methodology.workflow_findings.find((f) => f.signal_kind === "unchallenged_assumption");
  assert.ok(finding);
  assert.ok(!/unverified anchor/.test(finding.summary), "the 121st high-salience call must not be evicted by earlier results");
});

test("review-surfaces.METHODOLOGY.7 (D3) an untyped tool_result carrying a file is NOT treated as an edit (Codex P2)", async () => {
  // A read/inspect tool_result with a file but no tool name must not start the
  // post-change clock, so a later test does not reconcile a no-test finding.
  const events: ConversationEvent[] = [
    { id: "tr", actor: "tool", kind: "tool_result", summary: "read src/uploader.ts", file: "src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "an untyped tool_result with a file is not an edit");
});

test("review-surfaces.METHODOLOGY.7 (D3) post-change test ordering is tracked PER changed file (Codex P2)", async () => {
  // Edit a.ts (raw 0), run tests (raw 1), THEN edit b.ts (raw 2). The test post-dates
  // a.ts's edit but PRE-dates b.ts's, so only a.ts's no-test finding reconciles.
  const events: ConversationEvent[] = [
    { id: "ea", actor: "assistant", kind: "tool_call", summary: "Edit(src/a.ts)", tool: "Edit", file: "src/a.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 },
    { id: "eb", actor: "assistant", kind: "tool_call", summary: "Edit(src/b.ts)", tool: "Edit", file: "src/b.ts", raw_index: 2 }
  ];
  const methodology = methodologyDegraded();
  const audit = {
    cross_ref_flags: [
      { signal: "impl_no_test", text: "a.ts changed without a test", anchors: { paths: ["src/a.ts"] } },
      { signal: "impl_no_test", text: "b.ts changed without a test", anchors: { paths: ["src/b.ts"] } }
    ]
  };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/a.ts", "src/b.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const aFinding = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test" && /a\.ts/.test(f.summary));
  const bFinding = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test" && /b\.ts/.test(f.summary));
  assert.ok(aFinding && bFinding);
  assert.match(aFinding.summary, /test execution was observed elsewhere/, "a.ts was edited before the test, so it reconciles");
  assert.ok(!/test execution was observed/.test(bFinding.summary), "b.ts was edited AFTER the test, so it must not reconcile");
});

test("review-surfaces.METHODOLOGY.7 (D3) a 'no validation was run' skipped step reconciles when validation followed (Codex P2)", async () => {
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { workflow_assessment: { skipped_steps: [{ text: "no validation was run for the change", anchors: { event_ids: ["edit"] } }] } };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const skipped = methodology.workflow_findings.find((f) => f.signal_kind === "skipped_step");
  assert.ok(skipped);
  assert.match(skipped.summary, /test execution was observed elsewhere/, "'no validation was run' must be recognized as a missing-validation concern");
});

test("review-surfaces.METHODOLOGY.7 (D3) a read-only NotebookRead is not treated as an edit (Codex P2)", async () => {
  // `NotebookRead` contains 'notebook' but is a READ; it must not start the edit
  // clock, so a later test does not reconcile a no-test finding.
  const events: ConversationEvent[] = [
    { id: "nr", actor: "assistant", kind: "tool_call", summary: "NotebookRead(src/uploader.ts)", tool: "NotebookRead", file: "src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "a read-only tool whose name contains 'notebook' is not an edit");
});

test("review-surfaces.METHODOLOGY.7 (D3) a test between two edits of the same file does not reconcile (Codex P2)", async () => {
  // edit (raw 0) -> test (raw 1) -> edit again (raw 2): the test predates the FINAL
  // edit, so it cannot cover the latest change.
  const events: ConversationEvent[] = [
    { id: "e1", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 },
    { id: "e2", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 2 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "a test before the FINAL edit must not reconcile");
});

test("review-surfaces.METHODOLOGY.7 (D3) a patch-style edit naming the file only in the body establishes the edit clock (#96)", async () => {
  // apply_patch carries the path in the body, not event.file.
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "apply_patch", tool: "apply_patch", command: "*** Update File: src/uploader.ts\n+  retry()", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.match(impl.summary, /test execution was observed elsewhere/, "an apply_patch body naming the changed file is an edit");
});

test("review-surfaces.METHODOLOGY.7 (D3) a patch naming a DIFFERENT repo-relative path is not the changed file (#96)", async () => {
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "apply_patch", tool: "apply_patch", command: "*** Update File: packages/api/src/uploader.ts\n+  retry()", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "packages/api/src/uploader.ts is a different file");
});

test("review-surfaces.METHODOLOGY.7 (D3) a heredoc body containing a test command is not a test run (#96)", async () => {
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(write notes)", tool: "Bash", command: "cat > notes.txt <<EOF\npnpm test\nEOF", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "a `pnpm test` line inside a heredoc body is input, not an executed test");
});

test("review-surfaces.METHODOLOGY.7 (D3) a multi-file finding reconciles only when EVERY cited file was tested post-change (#96)", async () => {
  // a.ts edited (0), test (1), b.ts edited later (2). A finding citing BOTH must not
  // reconcile, because b.ts has no post-change test.
  const events: ConversationEvent[] = [
    { id: "ea", actor: "assistant", kind: "tool_call", summary: "Edit(src/a.ts)", tool: "Edit", file: "src/a.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 },
    { id: "eb", actor: "assistant", kind: "tool_call", summary: "Edit(src/b.ts)", tool: "Edit", file: "src/b.ts", raw_index: 2 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "a.ts and b.ts changed without tests", anchors: { paths: ["src/a.ts", "src/b.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/a.ts", "src/b.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "b.ts edited after the test means not every cited file is covered");
});

test("review-surfaces.METHODOLOGY.7 (D3) an edit body that merely MENTIONS another file does not reset that file's edit clock (#96)", async () => {
  // Edit uploader (0), test (1), THEN Write docs/notes.md (2) whose body mentions
  // uploader. The structured target is docs/notes.md, so uploader's clock stays at 0
  // and the post-change test still reconciles.
  const events: ConversationEvent[] = [
    { id: "e", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 },
    { id: "w", actor: "assistant", kind: "tool_call", summary: "Write(docs/notes.md)", tool: "Write", file: "docs/notes.md", command: "see src/uploader.ts for the retry", raw_index: 2 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.match(impl.summary, /test execution was observed elsewhere/, "a later write to a different file must not reset uploader's edit clock");
});

test("review-surfaces.METHODOLOGY.7 (D3) a heredoc body test command is conservatively NOT a test run (#96)", async () => {
  // Heredoc bodies are ambiguous (inert input / stdin / interpreter-executed); the
  // advisory note errs toward NOT firing rather than parsing the shell precisely.
  const events: ConversationEvent[] = [
    { id: "e", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(run script)", tool: "Bash", command: "bash <<EOF\npnpm test\nEOF", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "a test command inside a heredoc body is conservatively not counted");
});

test("review-surfaces.METHODOLOGY.7 (D3) a git unified-diff body (not apply_patch control lines) is conservatively not an edit (#96)", async () => {
  // Only apply_patch `*** ... File:` control lines are parsed; a raw `diff --git`
  // body (git's format, not the apply_patch tool) is not, so the clock stays unknown.
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "apply_patch", tool: "apply_patch", command: "diff --git a/src/uploader.ts b/src/uploader.ts\n+  retry()", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "a raw git diff body is not parsed as an apply_patch edit");
});

test("review-surfaces.METHODOLOGY.7 (D3) a cited changed file with NO observed edit is treated as unreconciled (#96)", async () => {
  // a.ts edited (0), test (1); b.ts is also cited and changed but never edited in the
  // selected slice — its coverage is unknown, so the finding does not reconcile.
  const events: ConversationEvent[] = [
    { id: "ea", actor: "assistant", kind: "tool_call", summary: "Edit(src/a.ts)", tool: "Edit", file: "src/a.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "a.ts and b.ts changed without tests", anchors: { paths: ["src/a.ts", "src/b.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/a.ts", "src/b.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "b.ts cited but never edited -> unknown coverage -> no reconcile");
});

test("review-surfaces.METHODOLOGY.7 (D3) a ./-prefixed cited path is normalized in the every-file check (#96)", async () => {
  // The finding cites `src/a.ts` and `./src/b.ts`; b.ts is edited AFTER the test, so
  // normalizing `./src/b.ts` to `src/b.ts` keeps it in the check and blocks reconcile.
  const events: ConversationEvent[] = [
    { id: "ea", actor: "assistant", kind: "tool_call", summary: "Edit(src/a.ts)", tool: "Edit", file: "src/a.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 },
    { id: "eb", actor: "assistant", kind: "tool_call", summary: "Edit(src/b.ts)", tool: "Edit", file: "src/b.ts", raw_index: 2 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "a and b changed", anchors: { paths: ["src/a.ts", "./src/b.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/a.ts", "src/b.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "./src/b.ts must not be dropped from the every-file check");
});

test("review-surfaces.METHODOLOGY.7 (D3) apply_patch Move-to and space-containing paths are captured (#96)", async () => {
  // `*** Move to:` names the new path; the whole rest of the line is captured so a
  // path with spaces is not truncated.
  const moveEvents: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "apply_patch", tool: "apply_patch", command: "*** Move to: src/uploader.ts\n+  retry()", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const moveM = methodologyDegraded();
  const moveAudit = { cross_ref_flags: [{ signal: "impl_no_test", text: "moved file untested", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": moveAudit }), { collection: collectionWithEvents(moveEvents, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology: moveM, risks: risks() }, {});
  const moveImpl = moveM.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(moveImpl);
  assert.match(moveImpl.summary, /test execution was observed elsewhere/, "*** Move to: names the edited file");

  const spaceEvents: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "apply_patch", tool: "apply_patch", command: "*** Update File: docs/api notes.md\n+  text", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const spaceM = methodologyDegraded();
  const spaceAudit = { cross_ref_flags: [{ signal: "impl_no_test", text: "doc untested", anchors: { paths: ["docs/api notes.md"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": spaceAudit }), { collection: collectionWithEvents(spaceEvents, ["docs/api notes.md"]), intent: intent(), evaluation: evaluation(), methodology: spaceM, risks: risks() }, {});
  const spaceImpl = spaceM.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(spaceImpl);
  assert.match(spaceImpl.summary, /test execution was observed elsewhere/, "a path with spaces is captured whole, not truncated at the first space");
});

test("review-surfaces.METHODOLOGY.7 (D3) a heredoc WRITTEN to a .sh file is not executed (#96)", async () => {
  // `cat > run-tests.sh <<EOF ... pnpm test ... EOF` writes a script; the `.sh`
  // filename must not be mistaken for an interpreter invocation.
  const events: ConversationEvent[] = [
    { id: "e", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(write script)", tool: "Bash", command: "cat > run-tests.sh <<EOF\npnpm test\nEOF", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "writing a heredoc into run-tests.sh is not a test run");
});

test("review-surfaces.METHODOLOGY.7 (D3) a real b/ directory path outside a diff is NOT the changed file (#96)", async () => {
  // `b/src/uploader.ts` named in a NON-diff command is a real path under a top-level
  // `b/` dir, not a diff prefix — it must not start the edit clock for src/uploader.ts.
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "apply_patch", tool: "apply_patch", command: "rewrote b/src/uploader.ts in the b workspace", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "b/src/uploader.ts outside a diff header is a different file");
});

test("review-surfaces.METHODOLOGY.7 (D3) a heredoc piped to an interpreter WITH a script arg is stdin, not commands (#96)", async () => {
  // `bash run.sh <<EOF ... pnpm test ... EOF` feeds the body as stdin to run.sh.
  const events: ConversationEvent[] = [
    { id: "e", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(run script)", tool: "Bash", command: "bash run.sh <<EOF\npnpm test\nEOF", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "a heredoc fed to `bash run.sh` is stdin, not executed commands");
});

test("review-surfaces.METHODOLOGY.7 (D3) a patch editing a DIFFERENT file whose body mentions the changed file does not reset its clock (#96)", async () => {
  // Edit uploader (0), test (1), then apply_patch to docs/notes.md (2) whose body
  // mentions uploader. Targets come from patch HEADERS, so uploader's clock stays at 0.
  const events: ConversationEvent[] = [
    { id: "e", actor: "assistant", kind: "tool_call", summary: "Edit(src/uploader.ts)", tool: "Edit", file: "src/uploader.ts", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 },
    { id: "p", actor: "assistant", kind: "tool_call", summary: "apply_patch", tool: "apply_patch", command: "*** Update File: docs/notes.md\n+ see src/uploader.ts for the retry", raw_index: 2 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.match(impl.summary, /test execution was observed elsewhere/, "a patch to docs/notes.md must not reset uploader's edit clock");
});

test("review-surfaces.METHODOLOGY.7 (D3) an apply_patch header naming a real b/ path is not the changed file (#96)", async () => {
  // `*** Update File: b/src/uploader.ts` is a real path under a `b/` dir, not a diff
  // operand — it must not be stripped to src/uploader.ts.
  const events: ConversationEvent[] = [
    { id: "edit", actor: "assistant", kind: "tool_call", summary: "apply_patch", tool: "apply_patch", command: "*** Update File: b/src/uploader.ts\n+ retry()", raw_index: 0 },
    { id: "t", actor: "assistant", kind: "tool_call", summary: "Bash(pnpm run test)", tool: "Bash", command: "pnpm run test", raw_index: 1 }
  ];
  const methodology = methodologyDegraded();
  const audit = { cross_ref_flags: [{ signal: "impl_no_test", text: "uploader changed without a test", anchors: { paths: ["src/uploader.ts"] } }] };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(events, ["src/uploader.ts"]), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
  const impl = methodology.workflow_findings.find((f) => f.signal_kind === "impl_no_test");
  assert.ok(impl);
  assert.ok(!/test execution was observed/.test(impl.summary), "an apply_patch `*** Update File: b/src/...` keeps b/ (a real path)");
});
