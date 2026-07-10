import test from "node:test";
import assert from "node:assert/strict";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import type { CommandTranscript } from "../src/commands/transcripts";
import { buildConversationReview } from "../src/conversation/review";
import type { PrRiskModel } from "../src/pr/contract";
import {
  EVENTS,
  candidate,
  retryDeletionDiff,
  stageProvider
} from "./helpers/conversation-review";

test("review-surfaces.CONVERSATION_REVIEW.3 validation accepts only events represented in the first-pass analysis", async () => {
  const staged = stageProvider([
    candidate({ conversation_event_ids: ["uncited-event"] })
  ]);
  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: [
      ...EVENTS,
      { id: "uncited-event", actor: "assistant", kind: "message", summary: "Unrelated raw turn.", raw_index: 3 }
    ],
    diff: retryDeletionDiff()
  });

  assert.deepEqual(result.insights, []);
  assert.ok(result.analysis.quality_flags.includes("conversation_review_citations_rejected"));
});

test("review-surfaces.CONVERSATION_REVIEW.3 exact citation capabilities are never trimmed into matches", async () => {
  const staged = stageProvider([
    candidate({
      root_cause_key: "padded-event",
      title: "Padded event id",
      conversation_event_ids: [" user-final "]
    }),
    candidate({
      root_cause_key: "padded-path",
      title: "Padded changed path",
      paths: [" src/retry.ts "]
    }),
    candidate({
      root_cause_key: "padded-anchor",
      title: " Padded diff anchor ",
      diff_anchors: [{
        path: " src/retry.ts ",
        line_kind: "delete",
        line: 10,
        contains: " retryWithBackoff(send) "
      }]
    })
  ]);

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: retryDeletionDiff()
  });

  assert.equal(result.insights.length, 1);
  assert.equal(result.insights[0].title, "Padded diff anchor");
  assert.equal(result.insights[0].evidence_state, "unverified");
  assert.ok(result.insights[0].evidence.every((ref) => ref.kind !== "diff"));
  assert.ok(result.analysis.quality_flags.includes("conversation_review_citations_rejected"));
});

test("review-surfaces.CONVERSATION_REVIEW.3 a raw secret anchor cannot become a prompt-visible redaction-marker match", async () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  const diff = parseStructuredDiff([
    "diff --git a/src/retry.ts b/src/retry.ts",
    "--- a/src/retry.ts",
    "+++ b/src/retry.ts",
    "@@ -1,0 +1,1 @@",
    `+export const token = "${secret}";`
  ].join("\n"));
  const staged = stageProvider([candidate({
    diff_anchors: [{
      path: "src/retry.ts",
      line_kind: "add",
      line: 1,
      contains: secret
    }]
  })]);

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff
  });

  assert.equal(result.insights.length, 1);
  assert.equal(result.insights[0].evidence_state, "unverified");
  assert.ok(result.insights[0].evidence.every((ref) => ref.kind !== "diff"));
  assert.ok(result.analysis.quality_flags.includes("conversation_review_output_redacted"));
  assert.ok(result.analysis.quality_flags.includes("conversation_review_citations_rejected"));
});

test("review-surfaces.CONVERSATION_REVIEW.3 hidden changed line 221 cannot validate an exact anchor the model was not shown", async () => {
  const diff = parseStructuredDiff([
    "diff --git a/src/long.ts b/src/long.ts",
    "index 1111111..2222222 100644",
    "--- a/src/long.ts",
    "+++ b/src/long.ts",
    "@@ -0,0 +1,221 @@",
    ...Array.from({ length: 221 }, (_, index) => `+visible-line-${index + 1}`)
  ].join("\n"));
  const staged = stageProvider([
    candidate({
      paths: ["src/long.ts"],
      diff_anchors: [{ path: "src/long.ts", line_kind: "add", line: 221, contains: "visible-line-221" }]
    })
  ]);
  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff
  });

  assert.equal(result.insights[0].evidence_state, "unverified");
  assert.ok(result.insights[0].evidence.every((ref) => ref.kind !== "diff"));
  assert.ok(result.analysis.quality_flags.includes("conversation_review_diff_truncated"));
  assert.ok(result.analysis.quality_flags.includes("conversation_review_citations_rejected"));
});

test("review-surfaces.CONVERSATION_REVIEW.3 diff truncation detects omitted lines after an exactly full hunk", async () => {
  const firstFile = [
    "diff --git a/src/full.ts b/src/full.ts",
    "--- a/src/full.ts",
    "+++ b/src/full.ts",
    "@@ -0,0 +1,220 @@",
    ...Array.from({ length: 220 }, (_, index) => `+full-line-${index + 1}`)
  ];
  const secondFile = [
    "diff --git a/src/omitted.ts b/src/omitted.ts",
    "--- a/src/omitted.ts",
    "+++ b/src/omitted.ts",
    "@@ -0,0 +1,1 @@",
    "+omitted-line-221"
  ];
  const staged = stageProvider([]);
  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: parseStructuredDiff([...firstFile, ...secondFile].join("\n"))
  });

  const prompt = staged.prompts.get("conversation_review_insights") ?? "";
  assert.ok(result.analysis.quality_flags.includes("conversation_review_diff_truncated"));
  assert.doesNotMatch(prompt, /omitted-line-221/);
});

test("review-surfaces.CONVERSATION_REVIEW.3 an exactly full visible diff is not mislabeled truncated", async () => {
  const staged = stageProvider([]);
  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: parseStructuredDiff([
      "diff --git a/src/full.ts b/src/full.ts",
      "--- a/src/full.ts",
      "+++ b/src/full.ts",
      "@@ -0,0 +1,220 @@",
      ...Array.from({ length: 220 }, (_, index) => `+full-line-${index + 1}`)
    ].join("\n"))
  });

  assert.ok(!result.analysis.quality_flags.includes("conversation_review_diff_truncated"));
});

test("review-surfaces.CONVERSATION_REVIEW.3 a bounded long diff line is disclosed as partial review context", async () => {
  const staged = stageProvider([]);
  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: parseStructuredDiff([
      "diff --git a/src/long.ts b/src/long.ts",
      "--- a/src/long.ts",
      "+++ b/src/long.ts",
      "@@ -0,0 +1,1 @@",
      `+${"x".repeat(300)}`
    ].join("\n"))
  });

  assert.ok(result.analysis.quality_flags.includes("conversation_review_diff_truncated"));
});

test("review-surfaces.CONVERSATION_REVIEW.3 command 31 cannot validate when only the first 30 commands were in the prompt", async () => {
  const commands: CommandTranscript[] = Array.from({ length: 31 }, (_, index) => ({
    id: `cmd-${index + 1}`,
    command: `test-command-${index + 1}`,
    status: "passed",
    head_sha: "head-123",
    truncated: false,
    source_path: `.review-surfaces/commands/${index + 1}.json`
  }));
  const staged = stageProvider([
    candidate({ command_ids: ["cmd-31"] })
  ]);
  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: retryDeletionDiff(),
    commandTranscripts: commands,
    headSha: "head-123"
  });

  assert.deepEqual(result.insights[0].command_ids, []);
  assert.ok(result.analysis.quality_flags.includes("conversation_review_citations_rejected"));
  assert.ok(result.analysis.quality_flags.includes("conversation_review_commands_truncated"));
  assert.doesNotMatch(staged.prompts.get("conversation_review_insights") ?? "", /cmd-31|test-command-31/);
  assert.match(staged.prompts.get("conversation_review_insights") ?? "", /"command_context_truncated":true/);
});

test("review-surfaces.CONVERSATION_REVIEW.3 current-head commands are retained ahead of stale records at the command cap", async () => {
  const commands: CommandTranscript[] = [
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `stale-${index + 1}`,
      command: `stale-command-${index + 1}`,
      status: "passed" as const,
      head_sha: "old-head",
      truncated: false,
      source_path: `.review-surfaces/commands/stale-${index + 1}.json`
    })),
    {
      id: "current-focused",
      command: "current-focused-command",
      status: "passed",
      head_sha: "head-123",
      truncated: false,
      source_path: ".review-surfaces/commands/current.json"
    }
  ];
  const staged = stageProvider([
    candidate({ command_ids: ["current-focused"] })
  ]);
  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: retryDeletionDiff(),
    commandTranscripts: commands,
    headSha: "head-123"
  });

  const prompt = staged.prompts.get("conversation_review_insights") ?? "";
  assert.deepEqual(result.insights[0].command_ids, ["current-focused"]);
  assert.match(prompt, /current-focused-command/);
  assert.doesNotMatch(prompt, /stale-command-30/);
  assert.ok(result.analysis.quality_flags.includes("conversation_review_commands_truncated"));
});

test("review-surfaces.CONVERSATION_REVIEW.3 ambiguous duplicate command ids are omitted from prompt and validation", async () => {
  const staged = stageProvider([
    candidate({ command_ids: ["duplicate-command"] })
  ]);
  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: retryDeletionDiff(),
    headSha: "head-123",
    commandTranscripts: [
      {
        id: "duplicate-command",
        command: "first-passing-command",
        status: "passed",
        head_sha: "head-123",
        truncated: false,
        source_path: ".review-surfaces/commands/first.json"
      },
      {
        id: "duplicate-command",
        command: "second-failing-command",
        status: "failed",
        head_sha: "head-123",
        truncated: false,
        source_path: ".review-surfaces/commands/second.json"
      }
    ]
  });

  const prompt = staged.prompts.get("conversation_review_insights") ?? "";
  assert.deepEqual(result.insights[0].command_ids, []);
  assert.ok(result.analysis.quality_flags.includes("conversation_review_commands_truncated"));
  assert.ok(result.analysis.quality_flags.includes("conversation_review_citations_rejected"));
  assert.doesNotMatch(prompt, /first-passing-command|second-failing-command/);
  assert.match(prompt, /"command_transcripts_included":0/);
  assert.match(prompt, /"command_transcripts_total":2/);
});

test("review-surfaces.CONVERSATION_REVIEW.3 truncated command context demotes absence-based validation conclusions", async () => {
  const commands: CommandTranscript[] = Array.from({ length: 31 }, (_, index) => ({
    id: `cmd-${index + 1}`,
    command: `test-command-${index + 1}`,
    status: "passed",
    head_sha: "head-123",
    truncated: false,
    source_path: `.review-surfaces/commands/${index + 1}.json`
  }));
  const staged = stageProvider([
    candidate({
      root_cause_key: "validation-absence",
      category: "validation_gap",
      evidence_state: "contradicted",
      diff_anchors: [{ path: "src/retry.ts", line_kind: "delete", line: 10, contains: "retryWithBackoff(send)" }]
    })
  ]);
  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: retryDeletionDiff(),
    commandTranscripts: commands,
    headSha: "head-123"
  });

  assert.equal(result.insights[0].evidence_state, "unverified");
  assert.equal(result.insights[0].basis, "ai_reconciliation");
});

test("review-surfaces.CONVERSATION_REVIEW.3 bounded requirements, risks, and coverage are explicit and demote only absence-sensitive categories", async () => {
  const requirementIds = Array.from({ length: 201 }, (_, index) => `req-${String(index).padStart(3, "0")}`);
  const riskCandidates: PrRiskModel["candidates"] = Array.from({ length: 60 }, (_, index) => ({
    id: `risk-low-${String(index).padStart(3, "0")}`,
    rule: "large_diff" as const,
    category: "maintainability" as const,
    severity: "low" as const,
    summary: `Low risk ${index}`,
    evidence: [],
    suggested_checks: []
  }));
  riskCandidates.push({
    id: "critical-last",
    rule: "large_diff",
    category: "maintainability",
    severity: "critical",
    summary: "Critical risk supplied last",
    evidence: [],
    suggested_checks: []
  });
  const coverageDeltas = Array.from({ length: 41 }, (_, index) => ({
    requirement_id: requirementIds[index],
    acai_id: requirementIds[index],
    base_status: "satisfied" as const,
    head_status: "satisfied" as const,
    delta: "unchanged" as const,
    reasons: [],
    head_evidence: [],
    missing_evidence: []
  }));
  const exactAnchor = [{
    path: "src/retry.ts",
    line_kind: "delete" as const,
    line: 10,
    contains: "retryWithBackoff(send)"
  }];
  const staged = stageProvider([
    candidate({
      root_cause_key: "bounded-scope",
      category: "scope_surprise",
      title: "Scope conclusion depends on bounded evidence",
      diff_anchors: exactAnchor
    }),
    candidate({
      root_cause_key: "direct-intent-conflict",
      category: "intent_mismatch",
      title: "Direct intent conflict remains anchored",
      diff_anchors: exactAnchor
    })
  ]);

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: retryDeletionDiff(),
    requirementIds,
    scope: {
      base_ref: "base",
      head_ref: "head",
      head_sha: "head-sha",
      diff_source: "range",
      changed_files: [],
      affected_areas: [],
      affected_requirements: [{
        requirement_id: "scope-priority",
        acai_id: "scope-priority",
        reasons: []
      }],
      out_of_scope_changed_files: []
    },
    risks: {
      summary: "Bounded deterministic risks.",
      candidates: riskCandidates
    },
    coverage: {
      base_available: true,
      summary: "Bounded coverage deltas.",
      in_scope_count: coverageDeltas.length,
      deltas: coverageDeltas,
      counts: {
        improved: 0,
        regressed: 0,
        unchanged: coverageDeltas.length,
        new_requirement: 0,
        removed_requirement: 0,
        newly_in_scope: 0
      }
    }
  });

  const scopeInsight = result.insights.find((item) => item.title.startsWith("Scope conclusion"));
  const intentInsight = result.insights.find((item) => item.title.startsWith("Direct intent"));
  assert.equal(scopeInsight?.evidence_state, "unverified");
  assert.equal(scopeInsight?.basis, "ai_reconciliation");
  assert.equal(intentInsight?.evidence_state, "contradicted");
  assert.equal(intentInsight?.basis, "validated_anchors");
  assert.ok(result.analysis.quality_flags.includes("conversation_review_requirements_truncated"));
  assert.ok(result.analysis.quality_flags.includes("conversation_review_risks_truncated"));
  assert.ok(result.analysis.quality_flags.includes("conversation_review_coverage_truncated"));

  const prompt = staged.prompts.get("conversation_review_insights") ?? "";
  assert.match(prompt, /"requirements_included":200,"requirements_total":202,"requirement_context_truncated":true/);
  assert.match(prompt, /"risks_included":60,"risks_total":61,"risk_context_truncated":true/);
  assert.match(prompt, /"coverage_deltas_included":40,"coverage_deltas_total":41,"coverage_delta_context_truncated":true/);
  assert.match(prompt, /scope-priority/);
  assert.match(prompt, /critical-last/);
  assert.doesNotMatch(prompt, /risk-low-059/);
  assert.match(prompt, /do not infer that an omitted requirement, risk, risk path, or coverage delta does not exist/);
});

test("review-surfaces.CONVERSATION_REVIEW.3 an unrelated deterministic risk cannot upgrade an AI reconciliation", async () => {
  const staged = stageProvider([
    candidate({ evidence_state: "contradicted", risk_ids: ["PR-RISK-001"] })
  ]);
  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: retryDeletionDiff(),
    risks: {
      summary: "One unrelated risk.",
      candidates: [{
        id: "PR-RISK-001",
        rule: "large_diff",
        category: "maintainability",
        severity: "medium",
        summary: "A different file makes the overall diff large.",
        evidence: [{ kind: "diff", path: "src/other.ts", confidence: "high", validation_status: "valid" }],
        suggested_checks: []
      }]
    }
  });

  assert.equal(result.insights[0].evidence_state, "unverified");
  assert.equal(result.insights[0].basis, "ai_reconciliation");
});

test("review-surfaces.CONVERSATION_REVIEW.3 deterministic risks corroborate only their exact prompt-visible bounded paths", async () => {
  const riskPaths = Array.from({ length: 13 }, (_, index) =>
    `src/risk-${String(index).padStart(2, "0")}.ts`
  );
  const diff = parseStructuredDiff(riskPaths.flatMap((path, index) => [
    `diff --git a/${path} b/${path}`,
    "--- a/" + path,
    "+++ b/" + path,
    "@@ -1,1 +1,1 @@",
    `-export const value${index} = "old";`,
    `+export const value${index} = "new";`
  ]).join("\n"));
  const staged = stageProvider([
    candidate({
      root_cause_key: "shown-risk-path",
      title: "Shown risk path corroborates the conflict",
      paths: [riskPaths[0]],
      risk_ids: ["PR-RISK-BOUND"]
    }),
    candidate({
      root_cause_key: "hidden-risk-path",
      title: "Hidden risk path cannot corroborate the conflict",
      paths: [riskPaths[12]],
      risk_ids: ["PR-RISK-BOUND"]
    })
  ]);

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff,
    risks: {
      summary: "One risk with bounded path evidence.",
      candidates: [{
        id: "PR-RISK-BOUND",
        rule: "large_diff",
        category: "maintainability",
        severity: "high",
        summary: "The changed files share one deterministic risk.",
        evidence: riskPaths.map((path) => ({
          kind: "diff" as const,
          path,
          confidence: "high" as const,
          validation_status: "valid" as const
        })),
        suggested_checks: []
      }]
    }
  });

  const shown = result.insights.find((item) => item.title.startsWith("Shown risk"));
  const hidden = result.insights.find((item) => item.title.startsWith("Hidden risk"));
  assert.equal(shown?.evidence_state, "contradicted");
  assert.equal(shown?.basis, "validated_anchors");
  assert.equal(hidden?.evidence_state, "unverified");
  assert.equal(hidden?.basis, "ai_reconciliation");
  assert.ok(result.analysis.quality_flags.includes("conversation_review_risk_paths_truncated"));

  const prompt = staged.prompts.get("conversation_review_insights") ?? "";
  const riskContext = prompt.slice(
    prompt.indexOf('"deterministic_risks"'),
    prompt.indexOf(',"command_transcripts"')
  );
  assert.match(riskContext, /src\/risk-00\.ts/);
  assert.doesNotMatch(riskContext, /src\/risk-12\.ts/);
  assert.match(riskContext, /"path_evidence_included":12,"path_evidence_total":13,"path_context_truncated":true/);
  assert.match(prompt, /"risk_paths_included":12,"risk_paths_total":13,"risk_path_context_truncated":true/);
});
