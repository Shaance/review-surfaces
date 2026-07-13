// Human-reviewer value polish uplift (docs/history/HUMAN_VALUE_POLISH_GOAL.md).
// Each test pins one new behavior that raises signal-to-noise on a surface a
// human reviewer reads, and carries its Acai ID so the evaluator records exact
// test evidence for the requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HUMAN_REVIEW_SCHEMA_VERSION } from "../src/human/contract";
import type { HumanReviewModel } from "../src/human/contract";
import { buildHumanReview } from "../src/human/human-review";
import { ReviewPacket } from "../src/render/packet";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { minimalReviewPacket } from "./helpers/review-packet";
import {
  renderHumanReviewMarkdown,
  renderSuggestedCommentsMarkdown,
  renderReviewRoutesMarkdown,
  renderRiskLensesMarkdown
} from "../src/human/render";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { renderStickySummary } from "../src/render/sticky-summary";
import { notAssessedConversationAnalysis } from "../src/conversation/analysis";
import {
  HOSTILE_CONVERSATION_RAW_CONTROLS,
  HOSTILE_CONVERSATION_NEUTRALIZED_ENTITIES,
  HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS,
  ORDINARY_CONVERSATION_VALUE,
  hostileConversationBackslashRun,
  hostileConversationControlSurvives,
  hostileConversationAnalysis,
  hostileConversationInsight,
  hostileConversationTitleClosesEmphasis
} from "./helpers/conversation-review";
import { decisionSurface } from "./helpers/decision-projection";

function model(overrides: Partial<HumanReviewModel> = {}): HumanReviewModel {
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: "pr",
    spec_mode: "acai",
    narrative: { source: "fallback", provider: "mock", validated_at_head: "abc", claims: [] },
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    change_graph: { nodes: [], halo_nodes: [], edges: [], clusters: [], overview: { groups: [], halo_count: 0, edges: [] } },
    reading_order: { legs: [] },
    verdict: { decision: "reviewable_with_attention", confidence: "medium", reasons: [] },
    summary: "Two files changed; one impl file lacks a focused test.",
    conversation_analysis: notAssessedConversationAnalysis("mock"),
    review_insights: [],
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [],
      invalid_evidence: [],
      confidence_summary: "Medium confidence."
    },
    risk_lens_findings: [],
    methodology_audit: { quality_flags: [], considered: [], research: [], workflow_findings: [] },
    intent_mismatch: { expected_by_spec: [], observed_in_diff: [], possible_mismatches: [], possible_overreach: [], missing_intent: [] },
    review_routes: [],
    since_last_review: {
      improved: [],
      regressed: [],
      new_risks: [],
      resolved_risks: [],
      new_overreach: [],
      resolved_overreach: [],
      still_open: [],
      count_deltas: {
        satisfied: { before: 0, after: 0, delta: 0 },
        partial: { before: 0, after: 0, delta: 0 },
        missing: { before: 0, after: 0, delta: 0 },
        unknown: { before: 0, after: 0, delta: 0 },
        invalid_evidence: { before: 0, after: 0, delta: 0 }
      }
    },
    coverage_evidence: { status: "no_report", files: [] },
    review_plan: { enabled: false, read: [], skim: [], defer: [] },
    evidence_cards: [],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "deadbeef",
      uncommitted_files: 0
    },
    ...overrides
  };
}

function queueItem(overrides: Partial<HumanReviewModel["review_queue"][number]>): HumanReviewModel["review_queue"][number] {
  return {
    id: "REVIEW-001",
    rank: 1,
    title: "Changed file",
    path: "src/a.ts",
    reviewer_action: "Inspect it.",
    reason: "It changed.",
    evidence: [{ kind: "file", path: "src/a.ts", confidence: "medium" }],
    requirement_ids: [],
    risk_ids: [],
    ranking_reasons: ["ranked by high risk severity with a precise diff anchor"],
    confidence: "high",
    priority: "high",
    ...overrides
  };
}

function analyzedConversation(): NonNullable<HumanReviewModel["conversation_analysis"]> {
  return {
    status: "analyzed",
    provider: "ai-sdk",
    summary: "The author refined the goal from a broad redesign to a focused reviewer workflow.",
    intent: [{ text: "Give reviewers clear, conversation-aware findings.", event_ids: ["evt-2"] }],
    refinements: [],
    decisions: [],
    constraints: [],
    non_goals: [],
    rejected_alternatives: [],
    claims: [],
    validation_claims: [],
    known_gaps: [],
    quality_flags: []
  };
}

function conversationInsight(index: number): NonNullable<HumanReviewModel["review_insights"]>[number] {
  return {
    id: `CONV-INSIGHT-${index}`,
    category: "intent_mismatch",
    title: `Conversation finding ${index}`,
    summary: `The reviewed change diverges from refinement ${index}.`,
    why_it_matters: "A reviewer could approve behavior the author explicitly narrowed.",
    reviewer_action: `Check the cited change ${index}.`,
    priority: index === 1 ? "high" : "medium",
    evidence_state: index === 1 ? "contradicted" : "unverified",
    basis: index === 1 ? "validated_anchors" : "ai_reconciliation",
    conversation_event_ids: [`evt-${index}`],
    paths: [`src/finding-${index}.ts`],
    requirement_ids: [],
    risk_ids: [],
    command_ids: [],
    evidence: []
  };
}

test("review-surfaces.CONVERSATION_REVIEW.4 conversation-aware insights lead the reviewer surface, stay capped, and expose evidence state without changing verdict", () => {
  const review = model({
    conversation_analysis: analyzedConversation(),
    review_insights: [1, 2, 3, 4].map(conversationInsight)
  });
  const markdown = renderHumanReviewMarkdown(review);
  const html = renderHumanReviewHtml(review);

  assert.ok(markdown.indexOf("## Verdict") < markdown.indexOf("## Conversation-aware insights"));
  assert.ok(markdown.indexOf("## Conversation-aware insights") < markdown.indexOf("## Review first"));
  assert.ok(markdown.indexOf("## Conversation-aware insights") < markdown.indexOf("## Reading order"));
  assert.match(markdown, /\*\*Analyzed\.\*\*/);
  assert.match(markdown, /AI synopsis: The author refined the goal/);
  assert.match(markdown, /\[Conflicts with intent · high\] Conversation finding 1/);
  assert.match(markdown, /Stated goal.*Give reviewers clear, conversation-aware findings/);
  assert.match(markdown, /Why it matters: A reviewer could approve behavior/);
  assert.match(markdown, /Review: Check the cited change 1\./);
  assert.match(markdown, /events `evt-1`; paths `src\/finding-1\.ts`/);
  assert.match(markdown, /Conversation finding 3/);
  assert.doesNotMatch(markdown, /Conversation finding 4/);

  assert.ok(html.indexOf('id="conversation-insights"') < html.indexOf('id="queue"'));
  assert.ok(html.indexOf('id="conversation-insights"') < html.indexOf('id="reading-order"'));
  assert.match(html, /AI synopsis: The author refined the goal/);
  assert.match(html, /badge contradicted[^>]*>Conflicts with intent</);
  assert.match(html, /<strong>Why it matters:<\/strong> A reviewer could approve behavior/);
  assert.match(html, /<strong>Review:<\/strong> Check the cited change 1\./);
  assert.doesNotMatch(html, /Conversation finding 4/);
  assert.equal(review.verdict.decision, "reviewable_with_attention");
});

test("review-surfaces.CONVERSATION_REVIEW.4 full human Markdown neutralizes provider-authored controls without hiding deterministic review content", () => {
  const markdown = renderHumanReviewMarkdown(model({
    conversation_analysis: hostileConversationAnalysis(),
    review_insights: [hostileConversationInsight()]
  }));

  for (const rawControl of HOSTILE_CONVERSATION_RAW_CONTROLS) {
    assert.equal(hostileConversationControlSurvives(markdown, rawControl), false, `raw provider control survived: ${rawControl}`);
  }
  for (const entity of HOSTILE_CONVERSATION_NEUTRALIZED_ENTITIES) {
    assert.ok(markdown.includes(entity), `neutralized provider text must remain readable: ${entity}`);
  }
  for (const marker of HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS) {
    assert.equal(
      hostileConversationBackslashRun(markdown, marker),
      2,
      `provider trailing backslash must be doubled at ${marker}`
    );
  }
  assert.equal(hostileConversationTitleClosesEmphasis(markdown), true, "renderer-owned title emphasis must close after the neutralized backslash");
  assert.match(markdown, new RegExp(ORDINARY_CONVERSATION_VALUE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(markdown, /&lt;\\!--HOSTILE_SUMMARY--&gt;/);
  assert.match(markdown, /\\\[hostile-title-link\\\]\\\(https&#58;\/\/attacker\.invalid\/title\\\)/);
  assert.match(markdown, /\n## Reading order\n/);
  assert.match(markdown, /\n## Review first\n/);

  const markerReview = model({ conversation_analysis: {
    ...hostileConversationAnalysis(),
    summary: "Provider output included [REDACTED:github_token]."
  } });
  assert.match(renderHumanReviewMarkdown(markerReview), /\[REDACTED:github_token\]/);
});

test("review-surfaces.CONVERSATION_REVIEW.4 missing conversation analysis is an honest not-assessed state, not a clean result", () => {
  const markdown = renderHumanReviewMarkdown(model());
  assert.match(markdown, /\*\*Not assessed\.\*\*/);
  assert.match(markdown, /not evidence that the change is clean/);
});

test("review-surfaces.CONVERSATION_REVIEW.4 legacy human v1 artifacts render without conversation fields", () => {
  const legacy = model();
  delete legacy.conversation_analysis;
  delete legacy.review_insights;

  const markdown = renderHumanReviewMarkdown(legacy);
  const html = renderHumanReviewHtml(legacy);
  const sticky = renderStickySummary(legacy).markdown;

  assert.match(markdown, /\*\*Not assessed\.\*\* No conversation analysis is present/);
  assert.match(html, /Not assessed[^]*No conversation analysis is present/);
  assert.match(html, /No conversation-grounded conclusions are available/);
  assert.doesNotMatch(sticky, /No conversation analysis is present/, "the sticky omits canonical missing-log boilerplate from its primary scan path");
});

test("review-surfaces.CONVERSATION_REVIEW.4 Markdown and HTML share non-analyzed status, summary, and empty-result meaning", () => {
  const cases: Array<{
    analysis: NonNullable<HumanReviewModel["conversation_analysis"]>;
    label: RegExp;
    summary: RegExp;
  }> = [
    {
      analysis: {
        ...notAssessedConversationAnalysis("mock"),
        summary: "The supplied log had no usable reviewer context."
      },
      label: /Not assessed/,
      summary: /The supplied log had no usable reviewer context/
    },
    {
      analysis: {
        ...notAssessedConversationAnalysis("ai-sdk"),
        status: "degraded",
        summary: "The provider timed out before analysis completed.",
        quality_flags: ["conversation_analysis_unavailable"]
      },
      label: /Degraded — incomplete/,
      summary: /The provider timed out before analysis completed/
    }
  ];

  for (const item of cases) {
    const review = model({ conversation_analysis: item.analysis, review_insights: [] });
    const markdown = renderHumanReviewMarkdown(review);
    const html = renderHumanReviewHtml(review);
    assert.match(markdown, item.label);
    assert.match(html, item.label);
    assert.match(markdown, item.summary);
    assert.match(html, item.summary);
    assert.match(markdown, /No conversation-grounded conclusions are available/);
    assert.match(html, /No conversation-grounded conclusions are available/);
  }
});

test("review-surfaces.CONVERSATION_REVIEW.4 stale insights stay hidden unless analysis and reconciliation completed", () => {
  const cases: Array<HumanReviewModel["conversation_analysis"]> = [
    undefined,
    notAssessedConversationAnalysis("mock"),
    {
      ...notAssessedConversationAnalysis("ai-sdk"),
      status: "degraded",
      summary: "Conversation analysis failed before a trustworthy result was available.",
      quality_flags: ["conversation_analysis_unavailable"]
    },
    {
      ...analyzedConversation(),
      quality_flags: ["conversation_review_unavailable"]
    },
    {
      ...analyzedConversation(),
      quality_flags: ["conversation_review_invalid_payload"]
    }
  ];

  for (const analysis of cases) {
    const review = model({
      conversation_analysis: analysis,
      review_insights: [conversationInsight(99)]
    });
    if (analysis === undefined) {
      delete review.conversation_analysis;
    }
    const markdown = renderHumanReviewMarkdown(review);
    const html = renderHumanReviewHtml(review);
    const sticky = renderStickySummary(review).markdown;

    for (const rendered of [markdown, html, sticky]) {
      assert.doesNotMatch(rendered, /Conversation finding 99|Conflicts with intent/);
    }
    assert.match(markdown, /no conversation-grounded conclusion|Diff reconciliation did not complete/i);
    assert.match(html, /no conversation-grounded conclusion|Diff reconciliation did not complete/i);
  }
});

test("review-surfaces.CONVERSATION_REVIEW.4 incomplete reconciliation is visible instead of looking like a clean analysis", () => {
  const review = model({
    conversation_analysis: {
      ...analyzedConversation(),
      quality_flags: [
        "conversation_review_unavailable",
        "conversation_review_diff_truncated",
        "conversation_review_commands_truncated",
        "conversation_review_requirements_truncated",
        "conversation_review_risks_truncated",
        "conversation_review_risk_paths_truncated",
        "conversation_review_coverage_truncated"
      ]
    },
    review_insights: []
  });
  const markdown = renderHumanReviewMarkdown(review);
  const html = renderHumanReviewHtml(review);

  assert.match(markdown, /\*\*Analyzed — partial\.\*\*/);
  assert.match(markdown, /Diff reconciliation did not complete/);
  assert.match(markdown, /bounded subset of changed lines/);
  assert.match(markdown, /Command transcript context was bounded/);
  assert.match(markdown, /Requirement context was bounded/);
  assert.match(markdown, /Deterministic risk context was bounded/);
  assert.match(markdown, /Deterministic risk-path context was bounded/);
  assert.match(markdown, /Coverage-delta context was bounded/);
  assert.doesNotMatch(markdown, /No conversation-grounded insight survived reconciliation/);
  assert.match(html, /Analyzed — partial/);
  assert.match(html, /Diff reconciliation did not complete/);
  assert.match(html, /Command transcript context was bounded/);
  assert.match(html, /Requirement context was bounded/);
  assert.match(html, /Deterministic risk context was bounded/);
  assert.match(html, /Deterministic risk-path context was bounded/);
  assert.match(html, /Coverage-delta context was bounded/);
});

test("review-surfaces.RANKING.4 an aggregate-rollup packet risk renders at file level with a short title, never a borrowed 'precise' anchor", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  packet.risks.items = [
    {
      id: "RISK-001",
      category: "testing",
      severity: "medium",
      summary: "182 requirement(s) have implementation evidence but weak or missing test evidence.",
      // A single-file aggregate (all evidence in one spec file): the fix must still
      // detect it without requiring path diversity.
      evidence: [
        { kind: "file", path: "features/review-surfaces.feature.yaml", confidence: "medium" },
        { kind: "file", path: "features/review-surfaces.feature.yaml", line_start: undefined, confidence: "medium" }
      ],
      suggested_checks: ["Add unit or fixture tests tied to affected requirement groups."]
    }
  ] as unknown as ReviewPacket["risks"]["items"];
  // A diff that DOES contain a changed hunk for the first evidence path: without
  // the fix, queueAnchorForEvidence would borrow that hunk and advertise a
  // "precise diff anchor" with high confidence.
  const diff = parseStructuredDiff(
    [
      "diff --git a/features/review-surfaces.feature.yaml b/features/review-surfaces.feature.yaml",
      "--- a/features/review-surfaces.feature.yaml",
      "+++ b/features/review-surfaces.feature.yaml",
      "@@ -1,2 +1,2 @@",
      "-old comment",
      "+new comment",
      " context"
    ].join("\n") + "\n"
  );
  const built = buildHumanReview({ packet, diff });
  const item = built.review_queue.find((entry) => entry.risk_ids.includes("RISK-001"));
  assert.ok(item, "the aggregate risk must still produce a queue item");
  assert.equal(item.line_start, undefined, "an aggregate rollup must not borrow a line anchor");
  assert.equal(item.hunk_header, undefined, "an aggregate rollup must not borrow a hunk header");
  assert.equal(item.confidence, "medium", "a file-level aggregate is medium confidence, not high");
  assert.equal(item.title, "Weak test evidence across requirements", "the heading is a short fixed label, not a truncated count sentence");
});

test("review-surfaces.HUMAN_REVIEW.24 the summary leads with blockers and queue items, not a verdict restatement or provenance preamble", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  const diff = parseStructuredDiff(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d"
    ].join("\n") + "\n"
  );
  const built = buildHumanReview({ packet, diff });
  assert.match(built.summary, /^\d+ blocker\(s\) and \d+ review queue item\(s\) across /);
  assert.match(built.summary, /2 changed file\(s\)/);
  assert.doesNotMatch(built.summary, /Verdict is/);
  assert.doesNotMatch(built.summary, /Human review surface generated from local evidence/);
});

test("review-surfaces.HUMAN_TRUST.6 the verdict surfaces the top in-diff risk co-equally with a soft missing-evidence reason", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  // An earlier LOW-severity risk precedes the medium one: the cited evidence must
  // name the medium risk that fired hasRiskAtLeast, not the first (low) candidate.
  packet.risks.items = [
    {
      id: "RISK-LOW",
      category: "release",
      severity: "low",
      summary: "A low unrelated risk.",
      evidence: [{ kind: "file", path: "docs/unrelated.md", confidence: "low" }],
      suggested_checks: ["Skim it."]
    },
    {
      id: "RISK-MED",
      category: "testing",
      severity: "medium",
      summary: "A medium in-diff risk.",
      evidence: [{ kind: "file", path: "schemas/human_review.schema.json", confidence: "high" }],
      suggested_checks: ["Version the contract."]
    }
  ] as unknown as ReviewPacket["risks"]["items"];
  packet.risks.missing_manual_checks = [
    {
      id: "MANUAL-001",
      acai_id: "review-surfaces.REVIEWER_VALUE.4",
      summary: "Missing manual review check for review-surfaces.REVIEWER_VALUE.4.",
      manual_check: "Inspect the reviewer decision surface before trusting coverage."
    }
  ] as unknown as ReviewPacket["risks"]["missing_manual_checks"];
  const diff = parseStructuredDiff(
    [
      "diff --git a/schemas/human_review.schema.json b/schemas/human_review.schema.json",
      "--- a/schemas/human_review.schema.json",
      "+++ b/schemas/human_review.schema.json",
      "@@ -1 +1 @@",
      "-{}",
      "+{\"changed\":true}"
    ].join("\n") + "\n"
  );
  const built = buildHumanReview({ packet, diff, prSurface: decisionSurface(["schemas/human_review.schema.json"]) });
  const reasonIds = built.verdict.reasons.map((reason) => reason.id);
  assert.ok(reasonIds.includes("READY-MISSING-EVIDENCE"), "the soft missing-evidence reason is present");
  const riskReason = built.verdict.reasons.find((reason) => reason.id === "READY-RISKS-PRESENT");
  assert.ok(riskReason, "the concrete in-diff risk is also surfaced");
  assert.ok(
    riskReason.evidence.some((ref) => ref.path === "schemas/human_review.schema.json"),
    "the cited evidence names the medium risk that fired, not the earlier low one"
  );
  // The verdict block renders only reason.summary, so the summary itself must name
  // the concrete medium risk (not a generic "reviewable risks remain") — and never
  // the earlier low-severity candidate.
  assert.match(riskReason.summary, /A medium in-diff risk/);
  assert.doesNotMatch(riskReason.summary, /low unrelated risk/);
  assert.equal(built.verdict.decision, "needs_author_clarification", "the decision precedence is unchanged");
});

test("review-surfaces.RANKING.5 the 'Why ranked here' block is suppressed when it is only the default severity echo", () => {
  const withDefault = model({ review_queue: [queueItem({ ranking_reasons: ["ranked by high risk severity with a precise diff anchor"] })] });
  const withSignal = model({ review_queue: [queueItem({ ranking_reasons: ["no changed test covers this file, so it ranks higher among equal-severity items"] })] });
  assert.doesNotMatch(renderHumanReviewMarkdown(withDefault), /Why ranked here/);
  assert.match(renderHumanReviewMarkdown(withSignal), /Why ranked here/);
});

test("review-surfaces.HUMAN_REVIEW.25 a suggested comment whose only evidence echoes its own path renders no Evidence line", () => {
  const echo = model({
    suggested_comments: [
      { id: "SC-001", severity: "blocking", path: "schemas/x.json", body: "Version the contract.", evidence: [{ kind: "file", path: "schemas/x.json", confidence: "high" }], risk_ids: [], requirement_ids: [], confidence: "high", ready_to_post: true }
    ]
  });
  const distinct = model({
    suggested_comments: [
      { id: "SC-002", severity: "blocking", path: "schemas/x.json", body: "Version the contract.", evidence: [{ kind: "file", path: "schemas/x.json", confidence: "high" }, { kind: "file", path: "src/other.ts", confidence: "high" }], risk_ids: [], requirement_ids: [], confidence: "high", ready_to_post: true }
    ]
  });
  assert.doesNotMatch(renderSuggestedCommentsMarkdown(echo), /\nEvidence: /);
  assert.match(renderSuggestedCommentsMarkdown(distinct), /Evidence: /);
});

test("review-surfaces.HUMAN_REVIEW.26 an all-negation non-default route is flagged skippable", () => {
  const step = (rank: number) => ({ id: `S-${rank}`, rank, title: "Nothing detected", priority: "low" as const, action: "No signal.", evidence: [{ kind: "file" as const, path: "review_packet.json", confidence: "low" as const }], queue_item_ids: [], risk_lens_ids: [], question_ids: [], test_plan_ids: [], suggested_comment_ids: [] });
  const withSkippable = model({
    review_routes: [
      { id: "ROUTE-SEC", title: "Security review", persona: "security", is_default: false, is_secondary: false, summary: "Security pass.", steps: [step(1), step(2)] }
    ]
  });
  assert.match(renderReviewRoutesMarkdown(withSkippable), /Skippable: no signal fired/);
});

test("review-surfaces.HUMAN_REVIEW.27 the cockpit answers the three reviewer questions and never renders a bare 'command' evidence anchor", () => {
  const html = renderHumanReviewHtml(model({
    review_queue: [queueItem({ evidence: [{ kind: "command", command: "pnpm run test", confidence: "medium" }], ranking_reasons: ["a real ranking signal"] })]
  }));
  assert.match(html, /Did the agent overreach its instructions\?/);
  assert.match(html, /Did it weaken tests to make them pass\?/);
  assert.match(html, /Did it claim things it didn't do\?/);
  // The three-question block leads the page, before the reading order.
  assert.ok(html.indexOf("Did the agent overreach") < html.indexOf('id="reading-order"'), "the three questions lead the first screen");
  // A command-only evidence anchor shows the command, not the bare kind word.
  assert.match(html, /<code>pnpm run test<\/code>/);
});

test("review-surfaces.READING_ORDER.3 the Tests and Config legs do not repeat their leg header on every line, and the cockpit collapses supporting files", () => {
  const reading_order = {
    legs: [
      {
        title: "Tests",
        read_together: false,
        steps: [
          { path: "tests/a.test.ts", why: "test — read after the 2 changed file(s) it imports", queue_refs: ["REVIEW-001"] },
          { path: "tests/b.test.ts", why: "test — read after the code it covers", queue_refs: [] },
          { path: "tests/c.test.ts", why: "test — read after the code it covers", queue_refs: [] }
        ]
      }
    ]
  };
  const markdown = renderHumanReviewMarkdown(model({ reading_order }));
  assert.doesNotMatch(markdown, /test — read after the code it covers/, "a pure header echo is dropped");
  const html = renderHumanReviewHtml(model({ reading_order }));
  assert.match(html, /supporting file\(s\) in dependency order/, "the cockpit collapses non-lead supporting files behind a details element");
});

test("review-surfaces.HUMAN_TRUST.6 the reviewable_with_attention verdict (no missing evidence) also names and cites the medium+ risk", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  packet.risks.items = [
    { id: "RISK-LOW", category: "release", severity: "low", summary: "A low unrelated risk.", evidence: [{ kind: "file", path: "docs/unrelated.md", confidence: "low" }], suggested_checks: ["Skim it."] },
    { id: "RISK-MED", category: "testing", severity: "medium", summary: "A medium schema-contract risk.", evidence: [{ kind: "file", path: "schemas/x.json", confidence: "high" }], suggested_checks: ["Version it."] }
  ] as unknown as ReviewPacket["risks"]["items"];
  const diff = parseStructuredDiff(
    [
      "diff --git a/schemas/x.json b/schemas/x.json",
      "--- a/schemas/x.json",
      "+++ b/schemas/x.json",
      "@@ -1 +1 @@",
      "-{}",
      "+{\"changed\":true}"
    ].join("\n") + "\n"
  );
  const built = buildHumanReview({ packet, diff });
  assert.equal(built.verdict.decision, "reviewable_with_attention", "no missing evidence + a medium risk => reviewable_with_attention");
  const riskReason = built.verdict.reasons.find((reason) => reason.id === "READY-RISKS-PRESENT");
  assert.ok(riskReason, "the risk reason is present");
  assert.match(riskReason.summary, /A medium schema-contract risk/);
  assert.ok(riskReason.evidence.some((ref) => ref.path === "schemas/x.json"), "cites the medium risk, not the earlier low one");
});

test("review-surfaces.EVIDENCE.8 a feedback-recorded passed command surfaces as a claim even when it is an unrecognized validator", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  packet.risks.test_evidence = [
    {
      id: "TEST-FB-001",
      kind: "claimed",
      summary: "Feedback records a passing validation command: make verify",
      requirement_ids: [],
      evidence: [{ kind: "feedback", path: ".review-surfaces/feedback/manual.yaml", command: "make verify", confidence: "medium" }]
    }
  ] as unknown as ReviewPacket["risks"]["test_evidence"];
  const built = buildHumanReview({ packet });
  assert.ok(
    built.trust_audit.claimed_not_verified.some((claim) => /make verify/.test(claim.claim)),
    "an unrecognized feedback validator must still appear under Claimed but not verified, never vanish"
  );
  assert.ok(
    !built.trust_audit.verified_facts.some((fact) => /make verify/.test(fact.summary)),
    "and it must not appear under Verified facts"
  );
});

test("review-surfaces.HUMAN_REVIEW.24 a review rebuilt from a packet with no diff does not claim 0 changed file(s)", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  const built = buildHumanReview({ packet });
  assert.doesNotMatch(built.summary, /0 changed file\(s\)/);
  assert.doesNotMatch(built.summary, /changed file\(s\)/, "with no diff the summary falls back to the packet-risk denominator");
  assert.match(built.summary, /packet risk\(s\)/);
});

test("review-surfaces.HUMAN_REVIEW.23 a path-only risk lens omits the empty 'Linked risk IDs' line in risk_lenses.md", () => {
  const lensModel = model({
    risk_lens_findings: [
      {
        id: "LENS-001",
        lens: "api_contract",
        severity: "high",
        confidence: "high",
        paths: ["schemas/x.json"],
        risk_ids: [],
        requirement_ids: [],
        summary: "A schema/API contract change fired this lens.",
        reviewer_action: "Version the contract.",
        evidence: [{ kind: "file", path: "schemas/x.json", confidence: "high" }],
        suggested_tests: [],
        suggested_comments: []
      }
    ]
  });
  assert.doesNotMatch(renderRiskLensesMarkdown(lensModel), /Linked risk IDs: none/);
});

test("review-surfaces.TREND.3 a status-change delta renders arrow-only, without a redundant (direction) parenthetical", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  packet.dogfood = {
    milestone: "M6",
    command: "review-surfaces dogfood",
    summary: "dogfood",
    helped_agent: "yes",
    helped_reviewer: "yes",
    previous_packet_path: ".review-surfaces-prev/review_packet.json",
    comparison: {
      status_changes: [
        { acai_id: "review-surfaces.ARCH.6", previous_status: "satisfied", current_status: "partial", direction: "regressed" }
      ],
      new_overreach: [],
      resolved_overreach: [],
      new_risks: [],
      resolved_risks: [],
      count_deltas: {
        satisfied: { before: 1, after: 0, delta: -1 },
        partial: { before: 0, after: 1, delta: 1 },
        missing: { before: 0, after: 0, delta: 0 },
        unknown: { before: 0, after: 0, delta: 0 },
        invalid_evidence: { before: 0, after: 0, delta: 0 }
      }
    },
    findings: [],
    remediation_tasks: [],
    deferrals: []
  } as unknown as ReviewPacket["dogfood"];
  const built = buildHumanReview({ packet });
  const regressed = built.since_last_review.regressed.find((item) => item.acai_id === "review-surfaces.ARCH.6");
  assert.ok(regressed, "the regressed status change is present");
  assert.equal(regressed.summary, "review-surfaces.ARCH.6: satisfied -> partial.");
  assert.doesNotMatch(regressed.summary, /\(regressed\)/);
});

test("review-surfaces.TREND.4 a homogeneous regressed bucket collapses to a count and sample, not a wall of ids", () => {
  const regressed = Array.from({ length: 12 }, (_, index) => ({
    id: `S-${index + 1}`,
    category: "requirement" as const,
    acai_id: `review-surfaces.AREA.${index + 1}`,
    previous_status: "satisfied",
    current_status: "partial",
    direction: "regressed" as const,
    summary: `review-surfaces.AREA.${index + 1}: satisfied -> partial.`,
    evidence: []
  }));
  const { markdown } = renderStickySummary(model({
    since_last_review: { ...model().since_last_review, previous_packet_path: ".review-surfaces-prev/review_packet.json", regressed }
  }));
  assert.match(markdown, /12 requirement\(s\) satisfied -> partial/);
  assert.doesNotMatch(markdown, /\(\+\d+ more\)/);
});

test("review-surfaces.TREND.5 a count-moved aggregate risk renders once as 'still open', not as both resolved and new", () => {
  const { markdown } = renderStickySummary(model({
    since_last_review: {
      ...model().since_last_review,
      previous_packet_path: ".review-surfaces-prev/review_packet.json",
      resolved_risks: [{ id: "R-1", category: "risk", summary: "testing: 139 requirement(s) have implementation evidence but weak or missing test evidence.", evidence: [] }],
      new_risks: [{ id: "N-1", category: "risk", summary: "testing: 182 requirement(s) have implementation evidence but weak or missing test evidence.", evidence: [] }]
    }
  }));
  assert.match(markdown, /Still open \(count changed\)/);
  assert.match(markdown, /139 -> 182 requirement\(s\)/);
});
