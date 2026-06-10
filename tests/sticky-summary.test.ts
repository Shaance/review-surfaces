import { test } from "node:test";
import assert from "node:assert/strict";
import { HUMAN_REVIEW_SCHEMA_VERSION } from "../src/human/contract";
import type { HumanReviewModel, SinceLastReview } from "../src/human/contract";
import { renderStickySummary, stickyQueueItemKey } from "../src/render/sticky-summary";
import { parseStructuredDiff } from "../src/collector/diff-hunks";

function emptySince(): SinceLastReview {
  return {
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
  };
}

function model(overrides: Partial<HumanReviewModel> = {}): HumanReviewModel {
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: "pr",
    narrative: { source: "fallback", provider: "mock", validated_at_head: "abc", claims: [] },
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    verdict: { decision: "reviewable_with_attention", confidence: "medium", reasons: [] },
    summary: "Two files changed; one impl file lacks a focused test.",
    review_queue: [
      {
        id: "REVIEW-001",
        rank: 1,
        title: "Untested impl change",
        path: "src/cli/index.ts",
        line_start: 42,
        reviewer_action: "Add a test covering the change.",
        reason: "Implementation file changed with no focused test.",
        evidence: [{ kind: "file", path: "src/cli/index.ts", confidence: "medium" }],
        requirement_ids: ["review-surfaces.PR_SURFACE.2"],
        risk_ids: ["PR-RISK-001"],
        ranking_reasons: ["no changed test or current-head transcript covers this file, so it ranks higher"],
        confidence: "high",
        priority: "high"
      },
      {
        id: "REVIEW-002",
        rank: 2,
        title: "Renderer change",
        path: "src/render/sticky-summary.ts",
        reviewer_action: "Re-render and confirm output is byte-stable.",
        reason: "A changed file affects the review comment surface.",
        evidence: [{ kind: "file", path: "src/render/sticky-summary.ts", confidence: "medium" }],
        requirement_ids: ["review-surfaces.PR_SURFACE.2"],
        risk_ids: ["PR-RISK-002"],
        ranking_reasons: [],
        confidence: "high",
        priority: "medium"
      }
    ],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      verified_facts: [{ id: "T-1", summary: "Tests pass at head.", evidence: [] }],
      claimed_not_verified: [{ id: "T-2", claim: "Coverage is adequate.", status: "unverified", missing_evidence: "no coverage report", evidence: [] }],
      missing_evidence: [{ id: "T-3", summary: "No test for the renderer.", evidence: [] }],
      invalid_evidence: [],
      confidence_summary: "Medium confidence."
    },
    risk_lens_findings: [],
    intent_mismatch: { expected_by_spec: [], observed_in_diff: [], possible_mismatches: [], possible_overreach: [], missing_intent: [] },
    review_routes: [],
    since_last_review: emptySince(),
    coverage_evidence: { status: "no_report", files: [] },
    review_plan: { enabled: false, read: [], skim: [], defer: [] },
    evidence_cards: [],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      pr_surface_path: ".review-surfaces/pr_review_surface.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "deadbeef"
    },
    ...overrides
  };
}

test("review-surfaces.PR_SURFACE.2 sticky renders verdict, top queue items, trust counts and artifact link from the human model", () => {
  const { markdown, blocked } = renderStickySummary(model(), { artifactName: "review-surfaces-pr-7" });
  assert.equal(blocked, false);
  // Marker is the first line so the workflow upsert can find the sticky.
  assert.equal(markdown.split("\n")[0], "<!-- review-surfaces:sticky -->");
  assert.match(markdown, /## review-surfaces/);
  assert.match(markdown, /\*\*Reviewable with attention\.\*\*/);
  assert.match(markdown, /### Review first/);
  assert.match(markdown, /1\. `src\/cli\/index\.ts:42`/);
  assert.match(markdown, /- Action: Add a test covering the change\./);
  assert.match(markdown, /### Trust/);
  assert.match(markdown, /1 verified, 1 claimed \(unverified\), 1 missing evidence, 0 invalid\./);
  assert.match(markdown, /download the \*\*review-surfaces-pr-7\*\* workflow artifact/);
});

test("review-surfaces.PR_SURFACE.2 sticky bounds the queue to the requested top-N", () => {
  const { markdown } = renderStickySummary(model(), { topN: 1 });
  assert.match(markdown, /1\. `src\/cli\/index\.ts:42`/);
  assert.doesNotMatch(markdown, /2\. `src\/render\/sticky-summary\.ts`/);
});

test("review-surfaces.PR_SURFACE.2 sticky is byte-deterministic for the same model", () => {
  const m = model();
  assert.equal(renderStickySummary(m).markdown, renderStickySummary(m).markdown);
});

test("review-surfaces.PR_SURFACE.4 sticky redacts secrets and blocks posting when a high-confidence secret survives", () => {
  const leak = "ghp_" + "a".repeat(36);
  const { markdown, blocked } = renderStickySummary(model({ summary: `Token committed: ${leak}` }));
  // Redaction ran before the body left the renderer; the raw token never appears.
  assert.doesNotMatch(markdown, /ghp_a{36}/);
  assert.match(markdown, /\[REDACTED:github_token\]/);
  // The block gate trips so the caller refuses to post.
  assert.equal(blocked, true);
});

test("review-surfaces.PR_SURFACE.4 a clean model is not blocked", () => {
  assert.equal(renderStickySummary(model()).blocked, false);
});

test("review-surfaces.PR_SURFACE.5 sticky leads with the since-last-review delta and collapses the rest when a prior packet was compared", () => {
  const since: SinceLastReview = {
    ...emptySince(),
    previous_packet_path: ".rs-prev/review_packet.json",
    resolved_risks: [{ id: "S-1", category: "risk", summary: "Null-deref risk resolved", evidence: [] }],
    regressed: [{ id: "S-2", category: "requirement", summary: "RENDER.3 regressed to partial", evidence: [] }],
    new_risks: [{ id: "S-3", category: "risk", summary: "New supply-chain risk", evidence: [] }]
  };
  const { markdown } = renderStickySummary(model({ since_last_review: since }));
  // The delta section leads (appears before the full review).
  const deltaIdx = markdown.indexOf("### Since your last review");
  const fullIdx = markdown.indexOf("<summary>Full review");
  assert.ok(deltaIdx > -1, "delta section present");
  assert.ok(fullIdx > deltaIdx, "full review collapsed AFTER the delta");
  assert.match(markdown, /✅ Resolved risks: Null-deref risk resolved/);
  assert.match(markdown, /⚠️ Regressed: RENDER\.3 regressed to partial/);
  assert.match(markdown, /🆕 New risks: New supply-chain risk/);
  // The full review is wrapped in a collapsible <details> block.
  assert.match(markdown, /<details>\n<summary>Full review/);
});

test("review-surfaces.PR_SURFACE.5 a first review (no prior packet) shows the queue expanded with no delta section", () => {
  const { markdown } = renderStickySummary(model());
  assert.doesNotMatch(markdown, /### Since your last review/);
  assert.doesNotMatch(markdown, /<summary>Full review/);
  // Queue is expanded, not collapsed.
  assert.match(markdown, /### Review first\n\n1\. `src\/cli\/index\.ts:42`/);
});

test("review-surfaces.PR_SURFACE.5 a recovered prior packet with no changes still leads with the delta (collapsed), not a first review", () => {
  const since: SinceLastReview = { ...emptySince(), previous_packet_path: ".rs-prev/review_packet.json" };
  const { markdown } = renderStickySummary(model({ since_last_review: since }));
  // Re-review mode even with all-empty buckets: lead with the delta, then collapse
  // the unchanged queue under <details> (not expanded as a first review).
  assert.match(markdown, /No requirement or risk changes since the last review/);
  const deltaIdx = markdown.indexOf("### Since your last review");
  const detailsIdx = markdown.indexOf("<summary>Full review");
  const queueIdx = markdown.indexOf("### Review first");
  assert.ok(deltaIdx > -1 && detailsIdx > deltaIdx && queueIdx > detailsIdx, "delta leads; queue collapsed after it");
});

test("review-surfaces.PR_SURFACE.5 the fingerprint records the run id so the next run can recover this run's artifact", () => {
  const { markdown } = renderStickySummary(model(), { runId: "987654" });
  assert.match(markdown, /<!-- review-surfaces:fingerprint head=deadbeef run=987654 keys=/);
  // Omitted when no run id is supplied (local renders).
  assert.doesNotMatch(renderStickySummary(model()).markdown, /run=/);
});

test("review-surfaces.PR_SURFACE.4 a high-confidence secret in a hunk excerpt trips the block gate too", () => {
  const leak = "ghp_" + "b".repeat(36);
  const diff = parseStructuredDiff(
    [
      "diff --git a/src/cli/index.ts b/src/cli/index.ts",
      "--- a/src/cli/index.ts",
      "+++ b/src/cli/index.ts",
      "@@ -41,1 +41,2 @@",
      " context line",
      `+const token = "${leak}";`
    ].join("\n")
  );
  const { markdown, blocked } = renderStickySummary(model(), { diff });
  // The excerpt renders, the token is redacted, AND the block gate trips.
  assert.match(markdown, /```diff/);
  assert.doesNotMatch(markdown, /ghp_b{36}/);
  assert.equal(blocked, true);
});

test("review-surfaces.PR_SURFACE.5 an overreach-only delta still renders its group (not 'no changes')", () => {
  const since: SinceLastReview = {
    ...emptySince(),
    previous_packet_path: ".rs-prev/review_packet.json",
    new_overreach: [{ id: "S-OR", category: "overreach", summary: "src/new.ts changed with no mapped intent", evidence: [] }]
  };
  const { markdown } = renderStickySummary(model({ since_last_review: since }));
  assert.match(markdown, /### Since your last review/);
  assert.match(markdown, /➕ New overreach: src\/new\.ts changed with no mapped intent/);
  assert.doesNotMatch(markdown, /No requirement or risk changes since the last review/);
});

test("review-surfaces.PR_SURFACE.5 the fingerprint sanitizes keys so a path with --> cannot close the HTML comment", () => {
  const m = model();
  m.review_queue[0].path = "src/evil-->inject.ts";
  const { markdown } = renderStickySummary(m);
  const fingerprint = markdown.split("\n").find((line) => line.includes("review-surfaces:fingerprint")) ?? "";
  // The only `-->` left is the comment terminator; the key's `-->` is neutralized.
  assert.equal(fingerprint.match(/-->/g)?.length, 1);
  assert.ok(fingerprint.endsWith("-->"));
  assert.doesNotMatch(fingerprint, /evil-->inject/);
});

test("review-surfaces.PR_SURFACE.5 the in-comment fingerprint pins the head sha and stable finding keys (rule+path+anchor, not array index)", () => {
  const { markdown } = renderStickySummary(model());
  assert.match(markdown, /<!-- review-surfaces:fingerprint head=deadbeef keys=/);
  // Stable key uses rule id + path + anchor.
  assert.equal(stickyQueueItemKey(model().review_queue[0]), "PR-RISK-001:src/cli/index.ts:42");
  assert.match(markdown, /keys=PR-RISK-001:src\/cli\/index\.ts:42,PR-RISK-002:src\/render\/sticky-summary\.ts:/);
});
