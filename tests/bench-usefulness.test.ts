import test from "node:test";
import assert from "node:assert/strict";
import { scoreReviewerUsefulness } from "../src/bench/usefulness";

test("review-surfaces.REVIEWER_VALUE.10 scores curated precision, density, duplication, comments, and reviewer value", () => {
  const score = scoreReviewerUsefulness(
    {
      review_queue: [
        { path: "src/action.ts", title: "Concrete defect" },
        { path: "src/internal.ts", title: "Exported API surface change" }
      ],
      suggested_comments: [
        { path: "src/action.ts", title: "Concrete defect" },
        { path: "src/internal.ts", title: "Exported API surface change" }
      ],
      decision_projection: { findings: [{ root_cause: "root:a" }, { root_cause: "root:a" }] }
    },
    [
      "# Human Review",
      "## Verdict",
      "## Review first",
      "1. concrete",
      "   - Action: inspect it",
      "## Reading order"
    ].join("\n"),
    {
      findings: [
        { path: "src/action.ts", actionable: true },
        { path: "src/internal.ts", title: "Exported API surface change", actionable: false }
      ],
      comments: [
        { path: "src/action.ts", actionable: true },
        { path: "src/internal.ts", actionable: false }
      ],
      max_first_action_line: 4,
      max_primary_surface_lines: 5,
      max_duplicate_root_causes: 0,
      reviewer_value_rating: 2,
      minimum_reviewer_value_rating: 4
    }
  );
  assert.equal(score.finding_precision, 0.5);
  assert.equal(score.comment_precision, 0.5);
  assert.equal(score.first_action_line, 5);
  assert.equal(score.primary_surface_lines, 6);
  assert.equal(score.duplicate_root_causes, 1);
  assert.equal(score.failures.length, 6);
});

test("review-surfaces.REVIEWER_VALUE.10 clean usefulness judgments produce no gate failures", () => {
  const score = scoreReviewerUsefulness(
    {
      review_queue: [{ path: "src/action.ts", title: "Concrete defect" }],
      suggested_comments: [{ path: "src/action.ts", title: "Concrete defect" }],
      decision_projection: { findings: [{ root_cause: "root:a" }] }
    },
    "# Human Review\n## Review first\n- Action: inspect it\n## Reading order\n",
    {
      findings: [{ path: "src/action.ts", actionable: true }],
      comments: [{ path: "src/action.ts", actionable: true }],
      max_first_action_line: 5,
      max_primary_surface_lines: 6,
      reviewer_value_rating: 5,
      minimum_reviewer_value_rating: 4
    }
  );
  assert.deepEqual(score.failures, []);
  assert.equal(score.finding_precision, 1);
  assert.equal(score.comment_precision, 1);
});

test("review-surfaces.REVIEWER_VALUE.10 counts decision findings as first actions", () => {
  const score = scoreReviewerUsefulness(
    {},
    [
      "# Human Review",
      "## Decision findings",
      "1. Contract break",
      "   - Action: preserve the public contract",
      "## Review first",
      "No additional actions.",
      "## Reading order"
    ].join("\n"),
    { max_first_action_line: 4 }
  );
  assert.equal(score.first_action_line, 4);
  assert.deepEqual(score.failures, []);
});

test("review-surfaces.REVIEWER_VALUE.10 fails when a curated actionable item disappears", () => {
  const score = scoreReviewerUsefulness(
    { review_queue: [], suggested_comments: [] },
    "# Human Review\n## Review first\nNo actions.\n## Reading order\n",
    {
      findings: [{ path: "src/action.ts", actionable: true }],
      comments: [{ path: "src/action.ts", body_contains: "Fix this", actionable: true }]
    }
  );
  assert.equal(score.missing_actionable_findings, 1);
  assert.equal(score.missing_postable_comments, 1);
  assert.equal(score.failures.length, 2);
});

test("review-surfaces.REVIEWER_VALUE.10 rejects reviewer ratings outside the 1–5 scale", () => {
  const score = scoreReviewerUsefulness({}, "", { reviewer_value_rating: 10 });
  assert.equal(score.reviewer_value_rating, null);
  assert.match(score.failures[0], /outside the 1–5 range/);
});
