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
import { buildRiskReviewFocus, RisksModel } from "../src/risks/risks";

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
  // THREE_EVENTS includes a `pnpm run test` tool_call, so the impl_no_test flag is reconciled.
  await runMethodologyReasoning(stubProvider({ "methodology-audit": FAKE_AUDIT }), { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
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
    { id: "u1", actor: "user", kind: "message", summary: "change the uploader", raw_index: 0 },
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
  // THREE_EVENTS runs `pnpm run test`; a chunk that emitted "no regression test" from a
  // partial view is contextualized across chunks, not surfaced as fact.
  const audit = { workflow_assessment: { skipped_steps: [{ text: "no regression test was added", anchors: { event_ids: ["a2"] } }] } };
  await runMethodologyReasoning(stubProvider({ "methodology-audit": audit }), { collection: collectionWithEvents(THREE_EVENTS), intent: intent(), evaluation: evaluation(), methodology, risks: risks() }, {});
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
