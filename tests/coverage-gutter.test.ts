import test from "node:test";
import assert from "node:assert/strict";
import { intersectCoverageWithDiff, MAX_UNCOVERED_LINES_PER_HUNK } from "../src/tests-evidence/lcov";
import { coverageSummaryLine, formatUncoveredRanges } from "../src/human/coverage-gutter";
import { renderHumanReviewMarkdown } from "../src/human/render";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { HumanReviewModel, HUMAN_REVIEW_SCHEMA_VERSION } from "../src/human/contract";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 0000000..1111111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,6 @@
 context line
-removed line
+added line 11
+added line 12
+added line 13
 trailing context
`;

function modelWithCoverage(): HumanReviewModel {
  const diff = parseStructuredDiff(DIFF);
  const files = intersectCoverageWithDiff(diff, {
    files: { "src/a.ts": { instrumented: [11, 12, 13], covered: [11] } }
  });
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: "repo",
    verdict: { decision: "reviewable_with_attention", confidence: "medium", reasons: [] },
    summary: "Coverage gutter fixture.",
    narrative: { source: "fallback", provider: "mock", validated_at_head: "abc", claims: [] },
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    review_queue: [
      {
        id: "Q-1",
        rank: 1,
        title: "fixture",
        path: "src/a.ts",
        hunk_header: files[0]?.hunks[0]?.hunk_header,
        reviewer_action: "review",
        reason: "fixture",
        ranking_reasons: ["fixture"],
        evidence: [],
        requirement_ids: [],
        risk_ids: [],
        confidence: "medium",
        priority: "medium"
      }
    ],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: { confidence_summary: "", verified_facts: [], claimed_not_verified: [], missing_evidence: [], invalid_evidence: [] },
    risk_lens_findings: [],
    intent_mismatch: { expected_by_spec: [], observed_in_diff: [], possible_mismatches: [], possible_overreach: [], missing_intent: [], claimed_candidates: [] },
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
    coverage_evidence: { status: "report", source_path: "coverage/lcov.info", postdates_head: true, files },
    review_plan: { enabled: false, read: [], skim: [], defer: [] },
    change_graph: { nodes: [], halo_nodes: [], edges: [], clusters: [] },
    reading_order: { legs: [] },
    evidence_cards: [],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: { packet_path: "review_packet.json", base_ref: "origin/main", head_ref: "HEAD", head_sha: "abc" }
  };
}

test("review-surfaces.COVERAGE.5 per-hunk coverage exposes sorted uncovered_lines, capped with an explicit truncated flag", () => {
  const diff = parseStructuredDiff(DIFF);
  const files = intersectCoverageWithDiff(diff, {
    files: { "src/a.ts": { instrumented: [11, 12, 13], covered: [11] } }
  });
  assert.equal(files.length, 1);
  const hunk = files[0].hunks[0];
  assert.deepEqual(hunk.uncovered_lines, [12, 13]);
  assert.equal(hunk.uncovered_truncated, undefined);
  assert.equal(hunk.classification, "partial");

  // Pathological hunk: the list caps with an explicit truncated flag.
  const bigLines = Array.from({ length: 80 }, (_, index) => `+line ${index}`).join("\n");
  const bigDiff = parseStructuredDiff(`diff --git a/src/big.ts b/src/big.ts
index 0000000..1111111 100644
--- a/src/big.ts
+++ b/src/big.ts
@@ -0,0 +1,80 @@
${bigLines}
`);
  const instrumented = Array.from({ length: 80 }, (_, index) => index + 1);
  const big = intersectCoverageWithDiff(bigDiff, { files: { "src/big.ts": { instrumented, covered: [] } } });
  const bigHunk = big[0].hunks[0];
  assert.equal(bigHunk.uncovered_lines.length, MAX_UNCOVERED_LINES_PER_HUNK);
  assert.equal(bigHunk.uncovered_truncated, true);
  // Sorted ascending.
  assert.deepEqual(bigHunk.uncovered_lines.slice(0, 3), [1, 2, 3]);
});

test("review-surfaces.COVERAGE.6 the cockpit gutters excerpt lines (deleted lines never), and markdown renders one summary line with uncovered ranges", () => {
  const fixture = modelWithCoverage();
  const diff = parseStructuredDiff(DIFF);
  const html = renderHumanReviewHtml(fixture, { diff });
  // Uncovered added lines get the red glyph; covered line the green one.
  assert.match(html, /✖ \+added line 12/);
  assert.match(html, /title="L12 uncovered"/);
  // Deleted lines never get a coverage gutter (no glyph/tint markers).
  assert.doesNotMatch(html, /[✖✓·] -removed line/);
  // Glyph paired with tint — color never alone.
  assert.match(html, /background:#fde2e2/);
  // Markdown: one summary line under the excerpt with the uncovered ranges.
  const markdown = renderHumanReviewMarkdown(fixture, { diff });
  assert.match(markdown, /Coverage: 2 of 3 changed line\(s\) uncovered: L12–L13/);
  // Honest negatives carry over: no report renders as no-evidence, never red.
  const noReport = { ...fixture, coverage_evidence: { status: "no_report" as const, files: [] } };
  const noReportHtml = renderHumanReviewHtml(noReport, { diff });
  assert.match(noReportHtml, /No coverage evidence: no coverage report was provided/);
  assert.doesNotMatch(noReportHtml, /✖ \+added line/);
  // A stale report renders its staleness note and never gutters.
  const stale = { ...fixture, coverage_evidence: { ...fixture.coverage_evidence, postdates_head: false } };
  const staleHtml = renderHumanReviewHtml(stale, { diff });
  assert.match(staleHtml, /predates the reviewed code/);
  assert.doesNotMatch(staleHtml, /✖ \+added line/);
});

test("review-surfaces.COVERAGE.6 uncovered range formatting is compact and truncation is explicit", () => {
  assert.equal(formatUncoveredRanges([12, 13, 14, 20]), "L12–L14, L20");
  assert.equal(formatUncoveredRanges([5]), "L5");
  assert.match(
    coverageSummaryLine({
      hunk_header: "@@ -1,1 +1,2 @@",
      changed_lines: 60,
      covered_lines: 5,
      classification: "partial",
      uncovered_lines: [1, 2, 3],
      uncovered_truncated: true
    }),
    /list truncated/
  );
  assert.match(
    coverageSummaryLine({ hunk_header: "@@ -1,1 +1,2 @@", changed_lines: 3, covered_lines: 3, classification: "covered", uncovered_lines: [] }),
    /all 3 instrumented changed line\(s\) executed/
  );
});
