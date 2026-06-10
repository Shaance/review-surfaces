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

function model(comments: SuggestedReviewComment[], headSha?: string): HumanReviewModel {
  return {
    verdict: { decision: "needs_author_clarification" },
    summary: "2 review-first item(s).",
    generated_from: headSha ? { head_sha: headSha } : {},
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

test("review-surfaces.PROVIDERS.7 anchors old-side comments to LEFT (deletions), new-side to RIGHT", () => {
  const draft = buildDraftReview(model([
    comment({ id: "SC-1", path: "src/a.ts", line_start: 10, side: "old" }),
    comment({ id: "SC-2", path: "src/b.ts", line_start: 4, line_end: 8, side: "old" }),
    comment({ id: "SC-3", path: "src/c.ts", line_start: 2, side: "new" }),
    comment({ id: "SC-4", path: "src/d.ts", line_start: 5 }) // no side => new/RIGHT
  ]));
  const byPath = (p: string) => draft.payload.comments.find((c) => c.path === p)!;
  assert.equal(byPath("src/a.ts").side, "LEFT", "a deleted-line comment is LEFT");
  assert.equal(byPath("src/b.ts").side, "LEFT");
  assert.equal(byPath("src/b.ts").start_side, "LEFT", "multi-line keeps the side on start_side");
  assert.equal(byPath("src/c.ts").side, "RIGHT");
  assert.equal(byPath("src/d.ts").side, "RIGHT", "an omitted side defaults to RIGHT");
});

test("review-surfaces.PROVIDERS.7 pins the draft review to the reviewed head sha", () => {
  const pinned = buildDraftReview(model([comment({ path: "src/a.ts", line_start: 1 })], "abc123def456"));
  assert.equal(pinned.payload.commit_id, "abc123def456", "commit_id pins to the reviewed head");
  // ...still no event — pinning does not make it auto-submit.
  assert.equal("event" in pinned.payload, false);

  const unpinned = buildDraftReview(model([comment({ path: "src/a.ts", line_start: 1 })]));
  assert.equal("commit_id" in unpinned.payload, false, "commit_id is omitted when no head sha is known");
});

test("review-surfaces.PROVIDERS.7 produces a stable payload for an empty comment set", () => {
  const draft = buildDraftReview(model([]));
  assert.deepEqual(draft.payload.comments, []);
  assert.equal(draft.unanchored, 0);
  assert.match(draft.payload.body, /never auto-submit|nothing is auto-submitted/i);
});
