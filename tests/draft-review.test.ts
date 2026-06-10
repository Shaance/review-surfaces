import test from "node:test";
import assert from "node:assert/strict";
import type { HumanReviewModel, SuggestedReviewComment } from "../src/human/contract";
import { buildDraftReview } from "../src/render/draft-review";

// ---------------------------------------------------------------------------
// review-surfaces.PROVIDERS.7 — export suggested comments as a GitHub PENDING
// (draft) review for the human to edit and submit; never auto-submit.
// ---------------------------------------------------------------------------

function comment(over: Partial<SuggestedReviewComment>): SuggestedReviewComment {
  return {
    id: "SC-1",
    severity: "clarifying",
    body: "Consider a test here.",
    evidence: [],
    risk_ids: [],
    requirement_ids: [],
    confidence: "medium",
    ready_to_post: true,
    ...over
  };
}

function model(comments: SuggestedReviewComment[]): HumanReviewModel {
  return {
    verdict: { decision: "needs_author_clarification" },
    summary: "2 review-first item(s).",
    suggested_comments: comments
  } as unknown as HumanReviewModel;
}

test("review-surfaces.PROVIDERS.7 exports a PENDING review payload that never auto-submits", () => {
  const draft = buildDraftReview(model([comment({ path: "src/a.ts", line_start: 10 })]));
  // The load-bearing safety property: no `event` field => GitHub creates the
  // review PENDING (a draft), so it is never auto-submitted.
  assert.equal("event" in draft.payload, false, "the payload must omit `event` so the review stays pending");
  assert.equal(draft.payload.comments.length, 1);
});

test("review-surfaces.PROVIDERS.7 hunk-anchors single- and multi-line comments to the new side", () => {
  const draft = buildDraftReview(model([
    comment({ id: "SC-1", path: "src/a.ts", line_start: 10 }),
    comment({ id: "SC-2", path: "src/b.ts", line_start: 4, line_end: 8 })
  ]));
  const single = draft.payload.comments.find((c) => c.path === "src/a.ts")!;
  assert.equal(single.line, 10);
  assert.equal(single.side, "RIGHT");
  assert.equal(single.start_line, undefined, "a single-line comment has no start_line");

  const multi = draft.payload.comments.find((c) => c.path === "src/b.ts")!;
  assert.equal(multi.start_line, 4);
  assert.equal(multi.line, 8);
  assert.equal(multi.start_side, "RIGHT");
});

test("review-surfaces.PROVIDERS.7 folds un-anchored comments into the review body, not dropped", () => {
  const draft = buildDraftReview(model([
    comment({ id: "SC-1", body: "General architectural note." }), // no path
    comment({ id: "SC-2", path: "src/a.ts", line_start: 3 })
  ]));
  assert.equal(draft.payload.comments.length, 1, "only the anchored comment is inline");
  assert.equal(draft.unanchored, 1);
  assert.match(draft.payload.body, /General architectural note\./, "the un-anchored comment is preserved in the body");
});

test("review-surfaces.PROVIDERS.7 marks not-ready comments as drafts to confirm", () => {
  const draft = buildDraftReview(model([
    comment({ id: "SC-1", path: "src/a.ts", line_start: 1, ready_to_post: false, body: "Needs a test." }),
    comment({ id: "SC-2", path: "src/b.ts", line_start: 2, ready_to_post: true, body: "Looks risky." })
  ]));
  const notReady = draft.payload.comments.find((c) => c.path === "src/a.ts")!;
  const ready = draft.payload.comments.find((c) => c.path === "src/b.ts")!;
  assert.match(notReady.body, /^Draft \(confirm before submitting\): Needs a test\./);
  assert.equal(ready.body, "Looks risky.", "a ready comment is unprefixed");
});

test("review-surfaces.PROVIDERS.7 produces a stable payload for an empty comment set", () => {
  const draft = buildDraftReview(model([]));
  assert.deepEqual(draft.payload.comments, []);
  assert.equal(draft.unanchored, 0);
  assert.match(draft.payload.body, /never auto-submit|nothing is auto-submitted/i);
});
