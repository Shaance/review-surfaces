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
  renderReviewRoutesMarkdown
} from "../src/human/render";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { renderStickySummary } from "../src/render/sticky-summary";

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
      acai_id: "review-surfaces.CLI.1",
      summary: "Missing manual review check for review-surfaces.CLI.1.",
      manual_check: "Inspect the CLI before trusting coverage."
    }
  ] as unknown as ReviewPacket["risks"]["missing_manual_checks"];
  const built = buildHumanReview({ packet });
  const reasonIds = built.verdict.reasons.map((reason) => reason.id);
  assert.ok(reasonIds.includes("READY-MISSING-EVIDENCE"), "the soft missing-evidence reason is present");
  const riskReason = built.verdict.reasons.find((reason) => reason.id === "READY-RISKS-PRESENT");
  assert.ok(riskReason, "the concrete in-diff risk is also surfaced");
  assert.ok(
    riskReason.evidence.some((ref) => ref.path === "schemas/human_review.schema.json"),
    "the cited evidence names the medium risk that fired, not the earlier low one"
  );
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
