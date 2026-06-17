import { test } from "node:test";
import assert from "node:assert/strict";
import { HUMAN_REVIEW_SCHEMA_VERSION } from "../src/human/contract";
import type { HumanReviewModel } from "../src/human/contract";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { parseStructuredDiff } from "../src/collector/diff-hunks";

function model(over: Partial<HumanReviewModel> = {}): HumanReviewModel {
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: "pr",
    spec_mode: "acai",
    narrative: {
      source: "fallback",
      provider: "mock",
      validated_at_head: "abc",
      claims: [
        { id: "C1", text: "Changes the renderer.", trust: "verified", anchors: [], invalid_anchors: [] },
        { id: "C2", text: "Improves performance.", trust: "claimed", anchors: [], invalid_anchors: ["bogus"] }
      ]
    },
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    change_graph: { nodes: [], halo_nodes: [], edges: [], clusters: [], overview: { groups: [], halo_count: 0, edges: [] } },
    reading_order: { legs: [] },
    verdict: { decision: "reviewable_with_attention", confidence: "medium", reasons: [] },
    summary: "One renderer file changed.",
    review_queue: [
      {
        id: "REVIEW-001",
        rank: 1,
        title: "Renderer change",
        path: "src/render.ts",
        line_start: 4,
        reviewer_action: "Inspect the change.",
        reason: "Render output changed.",
        ranking_reasons: ["no changed test or current-head transcript covers this file, so it ranks higher among equal-severity items"],
        evidence: [],
        requirement_ids: [],
        risk_ids: ["PR-RISK-001"],
        confidence: "high",
        priority: "high"
      }
    ],
    blockers: [],
    questions: [{ id: "Q1", severity: "clarifying", question: "Is the output change intended?", reason: "r", evidence: [], maps_to_risks: [], maps_to_requirements: [] }],
    suggested_comments: [],
    trust_audit: { verified_facts: [], claimed_not_verified: [], missing_evidence: [], invalid_evidence: [], confidence_summary: "Medium confidence." },
    risk_lens_findings: [
      { id: "LENS-001", lens: "reviewer_ux", severity: "medium", summary: "s", reviewer_action: "a", evidence: [], suggested_tests: [], suggested_comments: [], risk_ids: ["PR-RISK-001"], requirement_ids: [], paths: ["src/render.ts"], confidence: "medium" }
    ],
    methodology_audit: { degraded: false, considered: [], research: [], workflow_findings: [] },
    intent_mismatch: { expected_by_spec: [], observed_in_diff: [], possible_mismatches: [], possible_overreach: [], missing_intent: [] },
    review_routes: [],
    since_last_review: {
      improved: [], regressed: [], new_risks: [], resolved_risks: [], new_overreach: [], resolved_overreach: [], still_open: [],
      count_deltas: { satisfied: { before: 0, after: 0, delta: 0 }, partial: { before: 0, after: 0, delta: 0 }, missing: { before: 0, after: 0, delta: 0 }, unknown: { before: 0, after: 0, delta: 0 }, invalid_evidence: { before: 0, after: 0, delta: 0 } }
    },
    coverage_evidence: { status: "no_report", files: [] },
    review_plan: { enabled: true, budget_minutes: 15, read: [{ queue_item_id: "REVIEW-001", path: "src/render.ts", estimated_minutes: 3 }], skim: [], defer: [] },
    evidence_cards: [
      { id: "CARD-001", title: "Untested change", status: "missing_evidence", summary: "No focused test.", direct_evidence: [], missing_evidence: [], invalid_evidence: [], why_it_matters: "w", reviewer_action: "act", source_ids: [], risk_ids: ["PR-RISK-001"], requirement_ids: [], confidence: "medium", priority: "high" }
    ],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: { packet_path: ".review-surfaces/review_packet.json", base_ref: "origin/main", head_ref: "HEAD", head_sha: "deadbeef", uncommitted_files: 0 },
    ...over
  };
}

test("review-surfaces.RENDER.9 the HTML cockpit is one self-contained offline file rendered from the model", () => {
  const html = renderHumanReviewHtml(model());
  // Self-contained: no external scripts, stylesheets, or CDN references.
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|https?:\/\/cdn|@import/);
  assert.match(html, /<style>/);
  assert.match(html, /<script>/);
  // Strictly model-sourced sections: verdict, narrative trust marks, queue spine
  // with the ranking reason, plan, coverage honest-negative, cards, trust.
  assert.match(html, /Reviewable with attention/);
  assert.match(html, /✓ Changes the renderer\./);
  assert.match(html, /~ Improves performance\./);
  assert.match(html, /Why ranked here: no changed test/);
  assert.match(html, /Budget: 15 minute\(s\)/);
  assert.match(html, /No coverage evidence: no coverage report was provided/);
  assert.match(html, /Untested change/);
  // Queue links to its evidence card; the plan links back to the queue item.
  assert.match(html, /href="#card-CARD-001"/);
  assert.match(html, /href="#queue-REVIEW-001"/);
});

test("review-surfaces.RENDER.10 every interpolation is escaped and redaction re-runs on render", () => {
  const hostile = model({
    summary: `<script>alert(1)</script> & "quotes" with token ghp_${"a".repeat(36)}`
  });
  const html = renderHumanReviewHtml(hostile);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // Redaction ran before escaping: the raw token never appears.
  assert.doesNotMatch(html, /ghp_a{36}/);
  assert.match(html, /\[REDACTED:github_token\]/);
});

test("review-surfaces.RENDER.10 output is byte-deterministic with no timestamps; checkboxes persist per head sha", () => {
  const m = model();
  const a = renderHumanReviewHtml(m);
  const b = renderHumanReviewHtml(m);
  assert.equal(a, b);
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.match(a, /review-surfaces:checked:.*deadbeef/);
  assert.match(a, /localStorage/);
});

test("review-surfaces.RENDER.10 collapsible hunk excerpts render escaped from the same diff context as the markdown sibling", () => {
  const diff = parseStructuredDiff(
    [
      "diff --git a/src/render.ts b/src/render.ts",
      "--- a/src/render.ts",
      "+++ b/src/render.ts",
      "@@ -3,1 +3,2 @@",
      " context",
      '+const evil = "<img onerror=x>";'
    ].join("\n")
  );
  const html = renderHumanReviewHtml(model(), { diff });
  assert.match(html, /<details><summary>diff excerpt<\/summary><pre>/);
  // Hostile diff content is escaped, never live markup.
  assert.doesNotMatch(html, /<img onerror/);
  assert.match(html, /&lt;img onerror=x&gt;/);
});

test("review-surfaces.RENDER.10 lens filters render from the model's lens findings", () => {
  const html = renderHumanReviewHtml(model());
  assert.match(html, /data-lens-filter="reviewer_ux"/);
  assert.match(html, /data-lenses="reviewer_ux"/);
});
