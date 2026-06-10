import test from "node:test";
import assert from "node:assert/strict";
import type { HumanReviewModel, ReviewQueueItem } from "../src/human/contract";
import { runWalkthrough, buildFeedbackRecord, buildCommentDrafts, parseReviewChoice, WalkthroughIO } from "../src/review/walkthrough";

// ---------------------------------------------------------------------------
// review-surfaces.REVIEW_LOOP.1-4 — interactive review walkthrough (pure logic).
// ---------------------------------------------------------------------------

function queueItem(over: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    id: "Q1",
    rank: 0,
    title: "Security lens: changed env handling",
    path: "src/server.ts",
    line_start: 12,
    line_end: 14,
    reviewer_action: "Confirm the variable is not shell-interpolated.",
    reason: "Environment variable flows into a shell invocation.",
    evidence: [{ kind: "file" as const, path: "src/server.ts", line_start: 12, confidence: "medium" as const }],
    requirement_ids: ["review-surfaces.PRIVACY.2"],
    risk_ids: ["PR-RISK-1"],
    confidence: "medium",
    priority: "high",
    ...over
  };
}

function modelWithQueue(items: ReviewQueueItem[]): HumanReviewModel {
  return { review_queue: items, suggested_comments: [] } as unknown as HumanReviewModel;
}

function fakeIO(interactive: boolean, answers: string[]): { io: WalkthroughIO; output: string[] } {
  const output: string[] = [];
  let index = 0;
  return {
    output,
    io: {
      interactive,
      write: (text) => output.push(text),
      prompt: async () => (index < answers.length ? answers[index++] : undefined)
    }
  };
}

const OPTIONS = { author: "tester", createdAt: "2026-01-01T00:00:00.000Z", headSha: "abc123", packetPath: ".review-surfaces/review_packet.json" };

// REVIEW_LOOP.1: the walkthrough steps through each ranked item, showing its
// title, location, reason, action, and evidence.
test("review-surfaces.REVIEW_LOOP.1 steps through the ranked queue showing reason and evidence", async () => {
  const items = [queueItem({ id: "Q1", reason: "First reason." }), queueItem({ id: "Q2", path: "src/other.ts", reason: "Second reason." })];
  const { io, output } = fakeIO(true, ["s", "s"]); // skip both
  await runWalkthrough(modelWithQueue(items), undefined, io, OPTIONS);
  const text = output.join("\n");
  assert.match(text, /1\/2/);
  assert.match(text, /2\/2/);
  assert.match(text, /First reason\./);
  assert.match(text, /Second reason\./);
  assert.match(text, /Location: src\/server\.ts:12-14/);
  assert.match(text, /Evidence: src\/server\.ts:12/);
});

// REVIEW_LOOP.2 (capture half): accept/flag/false-positive decisions are recorded
// and mapped to a feedback record. (The downgrade-on-rerun half is covered by an
// integration test in human-review.test.ts.)
test("review-surfaces.REVIEW_LOOP.2 captures accept/flag/false-positive into a feedback record", async () => {
  const items = [
    queueItem({ id: "Q1", path: "src/keep.ts" }),
    queueItem({ id: "Q2", path: "src/noisy.ts" }),
    queueItem({ id: "Q3", path: "src/problem.ts", reason: "Missing null check." })
  ];
  const { io } = fakeIO(true, ["a", "p", "f"]); // accept, false-positive, flag
  const result = await runWalkthrough(modelWithQueue(items), undefined, io, OPTIONS);

  assert.equal(result.decisions.length, 3);
  const feedback = result.feedback!;
  assert.ok(feedback, "a feedback record is produced");
  assert.deepEqual((feedback.false_positives as Array<{ path_pattern: string }>).map((fp) => fp.path_pattern), ["src/noisy.ts"]);
  assert.deepEqual((feedback.findings as Array<{ affected_section: string }>).map((f) => f.affected_section), ["src/problem.ts"]);
  assert.match((feedback.validation as { passed: string[] }).passed[0], /Reviewer accepted/);
  // Never silently delete evidence: a false positive is a downgrade policy, not a removal.
  assert.equal((feedback.false_positives as Array<{ action: string }>)[0].action, "downgrade_to_low");
});

// REVIEW_LOOP.3: a needs-comment decision becomes a suggested-comment draft,
// marked draft or ready per the reviewer's in-session answer.
test("review-surfaces.REVIEW_LOOP.3 captures comment drafts marked draft or ready", async () => {
  const items = [queueItem({ id: "Q1", path: "src/api.ts" }), queueItem({ id: "Q2", path: "src/db.ts" })];
  // First item: comment, body, ready=yes. Second item: comment, body, ready=no(default).
  const { io } = fakeIO(true, ["c", "Add a regression test here.", "y", "c", "Consider a migration.", ""]);
  const result = await runWalkthrough(modelWithQueue(items), undefined, io, OPTIONS);

  assert.equal(result.commentDrafts.length, 2);
  const ready = result.commentDrafts[0];
  assert.equal(ready.body, "Add a regression test here.");
  assert.equal(ready.ready_to_post, true);
  assert.equal(ready.path, "src/api.ts");
  const draft = result.commentDrafts[1];
  assert.equal(draft.body, "Consider a migration.");
  assert.equal(draft.ready_to_post, false);
});

// REVIEW_LOOP.4: a non-interactive environment prints the next queue item and
// returns cleanly with no decisions, no feedback, and no hang.
test("review-surfaces.REVIEW_LOOP.4 degrades gracefully in a non-interactive environment", async () => {
  const items = [queueItem({ reason: "Top-ranked reason." })];
  const { io, output } = fakeIO(false, []);
  const result = await runWalkthrough(modelWithQueue(items), undefined, io, OPTIONS);

  assert.equal(result.decisions.length, 0);
  assert.equal(result.feedback, undefined);
  assert.equal(result.commentDrafts.length, 0);
  assert.match(output.join("\n"), /Non-interactive/);
  assert.match(output.join("\n"), /Top-ranked reason\./);
});

// An empty queue is handled in both modes.
test("review-surfaces.REVIEW_LOOP.1 handles an empty review queue", async () => {
  const { io: interactiveIO, output: a } = fakeIO(true, []);
  const r1 = await runWalkthrough(modelWithQueue([]), undefined, interactiveIO, OPTIONS);
  assert.equal(r1.decisions.length, 0);
  assert.match(a.join("\n"), /empty/);

  const { io: pipedIO, output: b } = fakeIO(false, []);
  await runWalkthrough(modelWithQueue([]), undefined, pipedIO, OPTIONS);
  assert.match(b.join("\n"), /empty/);
});

// Quitting mid-walkthrough records only the decisions made so far.
test("review-surfaces.REVIEW_LOOP.1 quitting early keeps prior decisions", async () => {
  const items = [queueItem({ id: "Q1", path: "src/a.ts" }), queueItem({ id: "Q2", path: "src/b.ts" })];
  const { io } = fakeIO(true, ["p", "q"]); // false-positive first, then quit
  const result = await runWalkthrough(modelWithQueue(items), undefined, io, OPTIONS);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].item.path, "src/a.ts");
});

// Choice parsing accepts both shorthand keys and full words.
test("review-surfaces.REVIEW_LOOP.1 parses decision keys and words", () => {
  assert.equal(parseReviewChoice("p"), "false_positive");
  assert.equal(parseReviewChoice("false-positive"), "false_positive");
  assert.equal(parseReviewChoice("A"), "accept");
  assert.equal(parseReviewChoice(""), "skip");
  assert.equal(parseReviewChoice("zzz"), undefined);
});

// The builders return nothing actionable when there is nothing to persist.
test("review-surfaces.REVIEW_LOOP.2 produces no feedback record for skip-only sessions", () => {
  assert.equal(buildFeedbackRecord([], OPTIONS), undefined);
  assert.equal(buildCommentDrafts([], OPTIONS).length, 0);
});
