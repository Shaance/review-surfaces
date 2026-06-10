// review-surfaces.PROVIDERS.7: export the human review's hunk-anchored suggested
// comments as a GitHub PENDING (draft) pull-request review for the reviewer to
// edit and submit. The payload deliberately OMITS the `event` field, so creating
// it on GitHub yields a PENDING review (a draft the human submits manually) — this
// export never auto-submits a review or comment. Reading is local-only and the
// payload is deterministic (built in the model's comment order, no timestamps).

import { HumanReviewModel, SuggestedReviewComment } from "../human/contract";

// A single hunk-anchored comment in the GitHub "Create a review" payload.
export interface DraftReviewComment {
  path: string;
  // The (new-side) line the comment anchors to; `start_line` is set for a
  // multi-line range. GitHub anchors review comments to the diff's RIGHT side.
  line: number;
  start_line?: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
}

// The GitHub POST /repos/{owner}/{repo}/pulls/{n}/reviews body. The ABSENCE of an
// `event` field is load-bearing: it makes the created review PENDING, never
// submitted. The type therefore has no `event` member by construction.
export interface DraftReviewPayload {
  body: string;
  comments: DraftReviewComment[];
}

export interface DraftReviewExport {
  payload: DraftReviewPayload;
  // Suggested comments that are not hunk-anchored (no path + line) and so cannot
  // be inline review comments; surfaced in the review body instead of dropped.
  unanchored: number;
}

// Build the pending-review export from the human review model.
export function buildDraftReview(model: HumanReviewModel): DraftReviewExport {
  const comments: DraftReviewComment[] = [];
  const unanchored: string[] = [];
  for (const suggested of model.suggested_comments) {
    if (suggested.path && suggested.line_start !== undefined) {
      const comment: DraftReviewComment = {
        path: suggested.path,
        line: suggested.line_end ?? suggested.line_start,
        side: "RIGHT",
        body: commentBody(suggested)
      };
      if (suggested.line_end !== undefined && suggested.line_end !== suggested.line_start) {
        comment.start_line = suggested.line_start;
        comment.start_side = "RIGHT";
      }
      comments.push(comment);
    } else {
      unanchored.push(`- ${commentBody(suggested)}`);
    }
  }
  return { payload: { body: reviewBody(model, unanchored), comments }, unanchored: unanchored.length };
}

// A not-yet-ready draft is prefixed so the reviewer can tell which comments they
// already approved in-session (REVIEW_LOOP.3) from machine suggestions to confirm.
function commentBody(comment: SuggestedReviewComment): string {
  const prefix = comment.ready_to_post ? "" : "Draft (confirm before submitting): ";
  return `${prefix}${comment.body}`;
}

function reviewBody(model: HumanReviewModel, unanchored: string[]): string {
  const lines = [
    "Pending review drafted by review-surfaces from local evidence. Edit and submit it yourself — nothing is auto-submitted.",
    "",
    `Verdict: ${model.verdict.decision}. ${model.summary}`
  ];
  if (unanchored.length > 0) {
    lines.push("", "General comments (not anchored to a line):", ...unanchored);
  }
  return lines.join("\n");
}
