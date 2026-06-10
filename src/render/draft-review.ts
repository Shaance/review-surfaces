// review-surfaces.PROVIDERS.7: export the human review's hunk-anchored suggested
// comments as a GitHub PENDING (draft) pull-request review for the reviewer to
// edit and submit. The payload deliberately OMITS the `event` field, so creating
// it on GitHub yields a PENDING review (a draft the human submits manually) — this
// export never auto-submits a review or comment. Reading is local-only and the
// payload is deterministic (built in the model's comment order, no timestamps).

import { HumanReviewModel, SuggestedReviewComment } from "../human/contract";
import { StructuredDiff } from "../pr/contract";

// A single hunk-anchored comment in the GitHub "Create a review" payload.
export interface DraftReviewComment {
  path: string;
  // The line the comment anchors to; `start_line` is set for a multi-line range.
  // `side` is LEFT for a deleted/rename-source (old-side) line and RIGHT for an
  // added/context (new-side) line — GitHub rejects (422) the wrong side.
  line: number;
  start_line?: number;
  side: "LEFT" | "RIGHT";
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

// The GitHub POST /repos/{owner}/{repo}/pulls/{n}/reviews body. The ABSENCE of an
// `event` field is load-bearing: it makes the created review PENDING, never
// submitted. The type therefore has no `event` member by construction. `commit_id`
// pins the review to the reviewed head so a later push does not re-anchor it.
export interface DraftReviewPayload {
  commit_id?: string;
  body: string;
  comments: DraftReviewComment[];
}

export interface DraftReviewExport {
  payload: DraftReviewPayload;
  // Suggested comments that are not hunk-anchored (no path + line) and so cannot
  // be inline review comments; surfaced in the review body instead of dropped.
  unanchored: number;
}

// Build the pending-review export. The `diff` (the reviewed base...head patch)
// is the authority for whether a comment is a valid PR-diff anchor and on which
// side: a comment whose line is an added/context line exports RIGHT, a deleted
// line exports LEFT, and a comment whose line is NOT in the diff at all (e.g. a
// repo-scope evidence line, or a stale anchor) is folded into the review body so
// GitHub never rejects (422) the review. When no diff is available the export
// falls back to a best-effort inline using the comment's own `side` hint.
export function buildDraftReview(model: HumanReviewModel, diff?: StructuredDiff): DraftReviewExport {
  const comments: DraftReviewComment[] = [];
  const unanchored: string[] = [];
  for (const suggested of model.suggested_comments) {
    const anchored = suggested.path && suggested.line_start !== undefined ? resolveAnchor(suggested, diff) : undefined;
    if (anchored) {
      const comment: DraftReviewComment = { path: suggested.path!, line: anchored.line, side: anchored.side, body: commentBody(suggested) };
      if (anchored.start_line !== undefined) {
        comment.start_line = anchored.start_line;
        comment.start_side = anchored.side;
      }
      comments.push(comment);
    } else {
      unanchored.push(`- ${commentBody(suggested)}`);
    }
  }
  const payload: DraftReviewPayload = { body: reviewBody(model, unanchored), comments };
  const headSha = model.generated_from?.head_sha;
  // Pin only to a full, resolvable 40-hex SHA. The schema only requires head_sha
  // to be a string, so placeholders ("unknown", "HEAD") or abbreviated values can
  // appear; `commit_id` must be a real commit SHA or GitHub rejects the review (422).
  if (headSha && /^[0-9a-f]{40}$/.test(headSha)) {
    payload.commit_id = headSha;
  }
  return { payload, unanchored: unanchored.length };
}

// Resolve a comment's anchor against the diff: returns the GitHub side and line(s)
// when the anchor line is present in the diff, or undefined when it is not (so the
// caller folds it into the body rather than emitting an invalid inline comment).
// With no diff, trusts the comment's `side` hint (best-effort, unvalidated).
function resolveAnchor(comment: SuggestedReviewComment, diff: StructuredDiff | undefined): { side: "LEFT" | "RIGHT"; line: number; start_line?: number } | undefined {
  const lineEnd = comment.line_end ?? comment.line_start!;
  const lineStart = comment.line_start!;
  if (!diff) {
    const side = comment.side === "old" ? "LEFT" : "RIGHT";
    return { side, line: lineEnd, start_line: lineEnd !== lineStart ? lineStart : undefined };
  }
  const newLines = new Set<number>();
  const oldLines = new Set<number>();
  for (const file of diff.files) {
    if (file.path !== comment.path && file.old_path !== comment.path) {
      continue;
    }
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        // A context line exists on BOTH sides, so record it in both — an explicit
        // old-side anchor on unchanged context then still resolves LEFT. A deletion
        // is old-side only; an addition is new-side only.
        if (line.kind !== "add" && line.old_line !== undefined) oldLines.add(line.old_line);
        if (line.kind !== "delete" && line.new_line !== undefined) newLines.add(line.new_line);
      }
    }
  }
  const preferOld = comment.side === "old";
  let side: "LEFT" | "RIGHT" | undefined;
  if (preferOld && oldLines.has(lineEnd)) side = "LEFT";
  else if (!preferOld && newLines.has(lineEnd)) side = "RIGHT";
  else if (newLines.has(lineEnd)) side = "RIGHT";
  else if (oldLines.has(lineEnd)) side = "LEFT";
  if (!side) {
    return undefined;
  }
  const sameSide = side === "RIGHT" ? newLines : oldLines;
  const start_line = lineEnd !== lineStart && sameSide.has(lineStart) ? lineStart : undefined;
  return { side, line: lineEnd, start_line };
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
