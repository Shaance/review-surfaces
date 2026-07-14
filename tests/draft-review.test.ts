import test from "node:test";
import assert from "node:assert/strict";
import type { DecisionProjection, HumanReviewModel, SuggestedReviewComment } from "../src/human/contract";
import { buildDraftReview } from "../src/render/draft-review";
import { parseStructuredDiff } from "../src/collector/diff-hunks";

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

function decisionProjection(over: Partial<DecisionProjection> = {}): DecisionProjection {
  return {
    active_intent: {
      summary: "Preserve retry behavior while simplifying the request path.",
      source: "pull_request",
      redaction_blocked: false,
      requirement_ids: [],
      event_ids: []
    },
    findings: [
      {
        id: "DECISION-001",
        root_cause: "retry-contract",
        title: "Retry behavior changes for callers",
        path: "src/retry.ts",
        priority: "high",
        reason: "The new request path changes when retries stop.",
        reviewer_action: "Confirm callers still receive the documented retry behavior.",
        evidence: [{ kind: "file", path: "src/retry.ts", line_start: 12, confidence: "high" }],
        requirement_ids: [],
        risk_ids: []
      },
      {
        id: "DECISION-002",
        root_cause: "fallback-contract",
        title: "Fallback errors have a new shape",
        priority: "medium",
        reason: "The fallback now returns structured error details.",
        reviewer_action: "Confirm the new error shape is acceptable to downstream consumers.",
        evidence: [{ kind: "file", path: "src/fallback.ts", confidence: "medium" }],
        requirement_ids: [],
        risk_ids: []
      }
    ],
    ...over
  };
}

function model(comments: SuggestedReviewComment[], headSha?: string, projection = decisionProjection()): HumanReviewModel {
  return {
    verdict: { decision: "needs_author_clarification" },
    decision_projection: projection,
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

test("review-surfaces.PROVIDERS.7 pins the draft review to a full reviewed head sha only", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567"; // 40 hex
  const pinned = buildDraftReview(model([comment({ path: "src/a.ts", line_start: 1 })], sha));
  assert.equal(pinned.payload.commit_id, sha, "commit_id pins to the reviewed head");
  // ...still no event — pinning does not make it auto-submit.
  assert.equal("event" in pinned.payload, false);

  const unpinned = buildDraftReview(model([comment({ path: "src/a.ts", line_start: 1 })]));
  assert.equal("commit_id" in unpinned.payload, false, "commit_id is omitted when no head sha is known");

  // A non-SHA placeholder (e.g. "HEAD", abbreviated) is NOT pinned — GitHub needs a real SHA.
  const placeholder = buildDraftReview(model([comment({ path: "src/a.ts", line_start: 1 })], "HEAD"));
  assert.equal("commit_id" in placeholder.payload, false, "a non-SHA head is not pinned");
});

// When the reviewed diff is available it is the authority: it sets the side and
// folds comments whose line is not in the diff into the body (so GitHub never 422s).
test("review-surfaces.PROVIDERS.7 resolves side and inline-ability against the diff", () => {
  const diff = parseStructuredDiff([
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,3 @@",
    " context",
    "-old removed line",
    "+new added line",
    " context2",
    ""
  ].join("\n"));
  const draft = buildDraftReview(model([
    comment({ id: "SC-1", path: "src/a.ts", line_start: 11, side: "new" }),   // added line 11 -> RIGHT
    comment({ id: "SC-2", path: "src/a.ts", line_start: 11, side: "old" }),   // deleted line 11 -> LEFT
    comment({ id: "SC-3", path: "src/a.ts", line_start: 999 }),               // not in the diff -> body
    comment({ id: "SC-4", path: "src/other.ts", line_start: 1 })              // file not in the diff -> body
  ]), diff);

  const onA = draft.payload.comments.filter((c) => c.path === "src/a.ts");
  assert.ok(onA.some((c) => c.side === "RIGHT"), "the added line anchors RIGHT");
  assert.ok(onA.some((c) => c.side === "LEFT"), "the deleted line anchors LEFT");
  assert.equal(draft.payload.comments.some((c) => c.line === 999 || c.path === "src/other.ts"), false, "non-diff comments are not inlined");
  assert.equal(draft.unanchored, 2, "the two non-diff comments fold into the body");
});

// An explicit old-side anchor on an UNCHANGED context line (e.g. a rename-source
// reference) must still resolve LEFT — context lines exist on both sides.
test("review-surfaces.PROVIDERS.7 keeps old-side anchors on context lines LEFT", () => {
  const diff = parseStructuredDiff([
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,3 @@",
    " context",          // old_line 10, new_line 10 (unchanged context)
    "-old removed line", // old_line 11
    "+new added line",   // new_line 11
    " context2",
    ""
  ].join("\n"));
  const draft = buildDraftReview(model([comment({ id: "SC-1", path: "src/a.ts", line_start: 10, side: "old" })]), diff);
  assert.equal(draft.payload.comments[0]?.side, "LEFT", "an old-side anchor on a context line stays LEFT");
});

test("review-surfaces.PROVIDERS.7 omits a sentinel `unknown` head sha", () => {
  const draft = buildDraftReview(model([comment({ path: "src/a.ts", line_start: 1 })], "unknown"));
  assert.equal("commit_id" in draft.payload, false, "the sentinel head sha is not pinned");
});

test("review-surfaces.PROVIDERS.7 produces a stable payload for an empty comment set", () => {
  const draft = buildDraftReview(model([]));
  assert.deepEqual(draft.payload.comments, []);
  assert.equal(draft.unanchored, 0);
  assert.match(draft.payload.body, /never auto-submit|nothing is auto-submitted/i);
});

test("review-surfaces.PROVIDERS.7 makes the change purpose and every approval decision actionable", () => {
  const draft = buildDraftReview(model([]));
  assert.match(draft.payload.body, /Verdict: needs_author_clarification/);
  assert.match(draft.payload.body, /Change purpose:\nPreserve retry behavior while simplifying the request path\./);
  assert.match(draft.payload.body, /Source: From the PR title and description\./);
  assert.match(draft.payload.body, /Approval decisions \(2\):/);
  assert.match(draft.payload.body, /1\. Retry behavior changes for callers — `src\/retry\.ts`/);
  assert.match(draft.payload.body, /Reason: The new request path changes when retries stop\./);
  assert.match(draft.payload.body, /Action: Confirm callers still receive the documented retry behavior\./);
  assert.match(draft.payload.body, /Evidence: src\/retry\.ts:12/);
  assert.match(draft.payload.body, /2\. Fallback errors have a new shape/);
  assert.match(draft.payload.body, /Action: Confirm the new error shape is acceptable to downstream consumers\./);
  assert.match(draft.payload.body, /Evidence: src\/fallback\.ts/);
});

// review-surfaces.PRIVACY.6 — the draft-review export was the only postable
// surface with no secret redaction; a secret in a suggested comment body or the
// active purpose/decision prose leaked into pending_review.json (and its stdout copy).
test("review-surfaces.PRIVACY.6 redacts secrets out of the draft-review payload and flags blocked", () => {
  const ghToken = `ghp_${"C".repeat(36)}`;
  // Assemble the fixture at runtime so the committed diff never contains a
  // contiguous credential-shaped value that the product must correctly flag.
  const googleKey = ["AIza", "SyA", "1234567890", "abcdefghijklmnopqrstuv"].join("");
  const decisionToken = `sk-proj-${"d".repeat(24)}`;
  const projection = decisionProjection({
    active_intent: {
      summary: `Audit the request path where key ${googleKey} was committed.`,
      source: "pull_request",
      redaction_blocked: false,
      requirement_ids: [],
      event_ids: []
    },
    findings: [{
      id: "DECISION-SECRET",
      root_cause: "secret-boundary",
      title: "Remove the exposed credential",
      priority: "high",
      reason: `The decision prose contains ${decisionToken}.`,
      reviewer_action: "Confirm the credential is rotated.",
      evidence: [{ kind: "file", path: "src/secrets.ts", confidence: "high" }],
      requirement_ids: [],
      risk_ids: []
    }]
  });
  const m = model(
    [
      comment({ id: "SC-1", path: "src/a.ts", line_start: 3, body: `Token ${ghToken} is hardcoded here.` }),
      comment({ id: "SC-2", body: "General note: SECRET=topsecretvalue9999 leaks in logs." }) // unanchored -> body
    ],
    undefined,
    projection
  );

  const draft = buildDraftReview(m);
  const serialized = JSON.stringify(draft.payload);

  assert.ok(!serialized.includes(ghToken), "the github token must be redacted from the inline comment body");
  assert.ok(!serialized.includes(googleKey), "the google key must be redacted from the active purpose");
  assert.ok(!serialized.includes(decisionToken), "the token must be redacted from the decision reason");
  assert.ok(!serialized.includes("topsecretvalue9999"), "the secret in the un-anchored comment must be redacted from the body");
  assert.match(serialized, /\[REDACTED:github_token\]/, "the inline comment body keeps its redaction marker");
  assert.match(serialized, /\[REDACTED:google_api_key\]/, "the active purpose keeps its redaction marker");
  assert.match(serialized, /\[REDACTED:openai_key\]/, "the decision reason keeps its redaction marker");
  assert.equal(draft.blocked, true, "a high-confidence secret raises the blocked signal for the postability gate");
});

test("review-surfaces.PRIVACY.6 leaves a clean payload unblocked", () => {
  const draft = buildDraftReview(model([comment({ path: "src/a.ts", line_start: 1, body: "Add a test for the new branch." })]));
  assert.equal(draft.blocked, false, "no secret => not blocked, so the payload posts normally");
});

test("review-surfaces.PRIVACY.6 redacts a secret in a suggested-comment path and flags blocked", () => {
  // The inline-comment `path` field was serialized verbatim, so a token in the
  // path (e.g. a fixture named like an OpenAI key) leaked while the body was clean.
  const secretPath = `src/sk-proj-${"a".repeat(24)}.ts`;
  const draft = buildDraftReview(model([comment({ id: "SC-1", path: secretPath, line_start: 1, body: "Clean body." })]));
  const serialized = JSON.stringify(draft.payload);
  assert.ok(!serialized.includes("sk-proj-aaaa"), "the secret in the path must be redacted out of the payload");
  assert.match(serialized, /\[REDACTED:openai_key\]/, "the path keeps its redaction marker");
  assert.equal(draft.blocked, true, "a secret in the path raises the block signal even with a clean body");
});
