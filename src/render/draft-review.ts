// review-surfaces.PROVIDERS.7: export the human review's suggested comments as a
// GitHub PENDING (draft) pull-request review for the reviewer to edit and submit.
// A comment is inlined as a review comment only when it carries a path AND a line
// that resolves to the reviewed diff; the deterministic generators emit path-only
// comments, so most fold into the review body (each prefixed with its path) rather
// than being dropped. The payload deliberately OMITS the `event` field, so creating
// it on GitHub yields a PENDING review (a draft the human submits manually) — this
// export never auto-submits a review or comment. Reading is local-only and the
// payload is deterministic (built in the model's comment order, no timestamps).

import type { HumanReviewModel, SuggestedReviewComment } from "../human/contract";
import {
  decisionFindingPresentation,
  decisionIntentSourceLabel,
  decisionProjectionHeading,
  EMPTY_DECISION_FINDINGS_TEXT
} from "../human/decision-projection-presentation";
import type { StructuredDiff } from "../pr/contract";
import { redactSecrets } from "../privacy/secrets";

// review-surfaces.PRIVACY.6: the draft-review export was the ONLY postable
// surface that interpolated suggested-comment bodies and reviewer-brief prose
// with no secret redaction (every other postable surface redacts). Sink for the
// block signal so a high-confidence secret can refuse the write/print (the CLI
// gate that honors `blocked` lives in runCommentDraftReview).
interface DraftRedactionState {
  blocked: boolean;
}

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
  // review-surfaces.PRIVACY.6: true when redaction hit a high-confidence
  // (blocked) secret in any comment body, active purpose, or decision prose, so
  // the caller can refuse to write/print pending_review.json under a
  // strict-postability gate.
  blocked: boolean;
}

// Build the pending-review export. The `diff` (the reviewed base...head patch)
// is the authority for whether a comment is a valid PR-diff anchor and on which
// side: a comment whose line is an added/context line exports RIGHT, a deleted
// line exports LEFT, and a comment whose line is NOT in the diff at all (e.g. a
// repo-scope evidence line, or a stale anchor) is folded into the review body so
// GitHub never rejects (422) the review. When no diff is available the export
// falls back to a best-effort inline using the comment's own `side` hint.
export function buildDraftReview(model: HumanReviewModel, diff?: StructuredDiff): DraftReviewExport {
  const redaction: DraftRedactionState = { blocked: false };
  const comments: DraftReviewComment[] = [];
  const unanchored: string[] = [];
  for (const suggested of model.suggested_comments) {
    const body = commentBody(suggested, redaction);
    const anchored = suggested.path && suggested.line_start !== undefined ? resolveAnchor(suggested, diff) : undefined;
    if (anchored) {
      // PRIVACY.6: scan/redact the path too — a suggested-comment path can carry
      // a token (e.g. a fixture named sk-proj-…ts) and was serialized verbatim
      // into pending_review.json while `blocked` stayed false on a clean body.
      const comment: DraftReviewComment = { path: redact(suggested.path!, redaction), line: anchored.line, side: anchored.side, body };
      if (anchored.start_line !== undefined) {
        comment.start_line = anchored.start_line;
        comment.start_side = anchored.side;
      }
      comments.push(comment);
    } else {
      // PRIVACY.6 + self-describing: a body folded into the review prose loses its
      // inline file context, so prefix the (redacted) path when the suggestion has
      // one — most deterministic comments are path-only and land here.
      unanchored.push(suggested.path ? `- \`${redact(suggested.path, redaction)}\`: ${body}` : `- ${body}`);
    }
  }
  const payload: DraftReviewPayload = { body: reviewBody(model, unanchored, redaction), comments };
  const headSha = model.generated_from?.head_sha;
  // Pin only to a full, resolvable 40-hex SHA. The schema only requires head_sha
  // to be a string, so placeholders ("unknown", "HEAD") or abbreviated values can
  // appear; `commit_id` must be a real commit SHA or GitHub rejects the review (422).
  if (headSha && /^[0-9a-f]{40}$/.test(headSha)) {
    payload.commit_id = headSha;
  }
  return { payload, unanchored: unanchored.length, blocked: redaction.blocked };
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
// The body is redacted (PRIVACY.6) so no secret reaches pending_review.json or
// its stdout copy; a blocked redaction raises the shared block signal.
function commentBody(comment: SuggestedReviewComment, redaction: DraftRedactionState): string {
  const prefix = comment.ready_to_post ? "" : "Draft (confirm before submitting): ";
  return redact(`${prefix}${comment.body}`, redaction);
}

function reviewBody(model: HumanReviewModel, unanchored: string[], redaction: DraftRedactionState): string {
  const projection = model.decision_projection;
  const findings = projection.findings.map(decisionFindingPresentation);
  const lines = [
    "Pending review drafted by review-surfaces from local evidence. Edit and submit it yourself — nothing is auto-submitted.",
    "",
    `Verdict: ${model.verdict.decision}`,
    "",
    "Change purpose:",
    redact(projection.active_intent.summary, redaction),
    `Source: ${decisionIntentSourceLabel(projection.active_intent.source)}.`,
    "",
    `${decisionProjectionHeading(findings.length)}:`
  ];
  if (findings.length === 0) {
    lines.push(`- ${EMPTY_DECISION_FINDINGS_TEXT}`);
  } else {
    findings.forEach((finding, index) => {
      const location = finding.path ? ` — \`${redact(finding.path, redaction)}\`` : "";
      lines.push(
        `${index + 1}. ${redact(finding.title, redaction)}${location}`,
        `   Reason: ${redact(finding.reason ?? finding.title, redaction)}`,
        `   Action: ${redact(finding.reviewerAction, redaction)}`,
        `   Evidence: ${finding.evidence.length > 0
          ? finding.evidence.map((value) => redact(value, redaction)).join(", ")
          : "No evidence anchors recorded."}`
      );
    });
  }
  if (unanchored.length > 0) {
    lines.push("", "General comments (not anchored to a line):", ...unanchored);
  }
  return lines.join("\n");
}

// Redact secrets from a free-text field and OR its block signal into the shared
// state, so a high-confidence secret anywhere in the payload is both substituted
// and flagged.
function redact(value: string, redaction: DraftRedactionState): string {
  const result = redactSecrets(value);
  if (result.blocked) {
    redaction.blocked = true;
  }
  return result.text;
}
