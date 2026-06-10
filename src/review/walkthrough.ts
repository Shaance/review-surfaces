// review-surfaces.REVIEW_LOOP.1-4: an interactive review walkthrough that steps
// through the ranked review queue, captures reviewer decisions into a local
// feedback file (so later runs downgrade/promote matching findings), captures
// comment drafts into the suggested-comments artifact, and degrades gracefully in
// non-interactive (non-TTY / piped) environments.
//
// The pure logic lives here (decision -> feedback record, decision -> comment
// draft, item rendering, the prompt loop over an injected IO) so it is unit- and
// e2e-testable; the CLI handler wires a readline-backed IO and the file writes.

import { stripUndefined } from "../core/guards";
import { EvidenceRef } from "../evidence/evidence";
import { HumanReviewModel, ReviewQueueItem, SuggestedReviewComment } from "../human/contract";
import { renderHunkExcerpt } from "../human/hunk-excerpt";
import { formatQueueLocation } from "../human/render";
import { StructuredDiff } from "../pr/contract";

// The actionable decisions a reviewer can record for a queue item. `skip` and
// `quit` control the loop and record nothing.
export type ReviewChoice = "accept" | "flag" | "false_positive" | "needs_comment" | "skip" | "quit";
export type RecordedChoice = Exclude<ReviewChoice, "skip" | "quit">;

// Injected terminal I/O so the loop is testable with a scripted fake. `prompt`
// resolves to the trimmed answer, or undefined at end-of-input (treated as quit).
export interface WalkthroughIO {
  readonly interactive: boolean;
  write(text: string): void;
  prompt(question: string): Promise<string | undefined>;
}

export interface WalkthroughOptions {
  author: string;
  createdAt?: string;
  headSha?: string;
  packetPath?: string;
}

export interface ReviewDecision {
  item: ReviewQueueItem;
  choice: RecordedChoice;
  commentBody?: string;
  commentReady?: boolean;
}

export interface WalkthroughResult {
  decisions: ReviewDecision[];
  // The YAML-source feedback record to write, or undefined when no decision
  // produced persistable feedback (e.g. only skips, or a non-interactive run).
  feedback?: Record<string, unknown>;
  // Comment drafts to merge into the human review's suggested comments.
  commentDrafts: SuggestedReviewComment[];
}

const CHOICE_BY_KEY: Record<string, ReviewChoice> = {
  a: "accept", accept: "accept",
  f: "flag", flag: "flag",
  p: "false_positive", false_positive: "false_positive", "false-positive": "false_positive",
  c: "needs_comment", comment: "needs_comment", "needs-comment": "needs_comment",
  s: "skip", skip: "skip", "": "skip",
  q: "quit", quit: "quit"
};

const PROMPT = "Decision [a]ccept / [f]lag / [p] false-positive / [c]omment / [s]kip / [q]uit: ";
const MAX_EVIDENCE_SHOWN = 6;

export function parseReviewChoice(input: string): ReviewChoice | undefined {
  return CHOICE_BY_KEY[input.trim().toLowerCase()];
}

// Render a queue item for the reviewer: rank, priority, title, location, the
// reason and suggested action, evidence anchors, and the inline diff excerpt.
export function formatQueueItemForReview(
  item: ReviewQueueItem,
  diff: StructuredDiff | undefined,
  position: number,
  total: number
): string {
  const lines: string[] = ["", `(${position}/${total}) [${item.priority}] ${item.title}`];
  lines.push(`  Location: ${formatQueueLocation(item)}`);
  lines.push(`  Why: ${item.reason}`);
  lines.push(`  Action: ${item.reviewer_action}`);
  const anchors = item.evidence.map(formatEvidence).filter(Boolean);
  if (anchors.length > 0) {
    const shown = anchors.slice(0, MAX_EVIDENCE_SHOWN);
    const more = anchors.length - shown.length;
    lines.push(`  Evidence: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  const excerpt = renderHunkExcerpt(diff, {
    path: item.path,
    old_path: item.old_path,
    hunk_header: item.hunk_header,
    line_start: item.line_start,
    line_end: item.line_end,
    side: item.anchor_side
  });
  if (excerpt) {
    lines.push(excerpt);
  }
  return lines.join("\n");
}

function formatEvidence(evidence: EvidenceRef): string {
  if (evidence.path) {
    return evidence.line_start ? `${evidence.path}:${evidence.line_start}` : evidence.path;
  }
  return evidence.acai_id ?? evidence.test_name ?? evidence.command ?? evidence.kind;
}

// Step through the ranked queue. In a non-interactive environment, print the next
// item and exit cleanly (REVIEW_LOOP.4) — no hang, no error, no persistence.
export async function runWalkthrough(
  model: HumanReviewModel,
  diff: StructuredDiff | undefined,
  io: WalkthroughIO,
  options: WalkthroughOptions
): Promise<WalkthroughResult> {
  const queue = model.review_queue;
  if (!io.interactive) {
    if (queue.length === 0) {
      io.write("Review queue is empty; nothing to walk through.");
    } else {
      io.write("Non-interactive environment: printing the next review queue item.");
      io.write(formatQueueItemForReview(queue[0], diff, 1, queue.length));
    }
    return { decisions: [], commentDrafts: [] };
  }

  if (queue.length === 0) {
    io.write("Review queue is empty; nothing to walk through.");
    return { decisions: [], commentDrafts: [] };
  }

  io.write(`Review walkthrough — ${queue.length} item(s) in the ranked queue.`);
  const decisions: ReviewDecision[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    io.write(formatQueueItemForReview(item, diff, index + 1, queue.length));
    const answer = await io.prompt(PROMPT);
    const choice = answer === undefined ? "quit" : parseReviewChoice(answer);
    if (choice === undefined) {
      io.write("Unrecognized choice; skipping this item.");
      continue;
    }
    if (choice === "quit") {
      io.write("Ending walkthrough early; recording decisions made so far.");
      break;
    }
    if (choice === "skip") {
      continue;
    }
    const decision: ReviewDecision = { item, choice };
    if (choice === "needs_comment") {
      decision.commentBody = (await io.prompt("  Comment body: "))?.trim() || item.reviewer_action;
      const ready = (await io.prompt("  Ready to post? [y/N]: ")) ?? "";
      decision.commentReady = /^y(es)?$/i.test(ready.trim());
    }
    decisions.push(decision);
  }

  io.write(`Recorded ${decisions.length} decision(s).`);
  return {
    decisions,
    feedback: buildFeedbackRecord(decisions, options),
    commentDrafts: buildCommentDrafts(decisions, options)
  };
}

// REVIEW_LOOP.2: map the session's decisions to a feedback-file YAML source. A
// false-positive becomes a path-scoped downgrade policy (the existing feedback
// machinery downgrades matching findings on the next run while RETAINING the
// evidence — never a silent delete, per HUMAN_REVIEW.10). A flag becomes a
// recorded finding; accepts are recorded as validation passes. Returns undefined
// when no decision produces persistable feedback.
export function buildFeedbackRecord(decisions: ReviewDecision[], options: WalkthroughOptions): Record<string, unknown> | undefined {
  // A path-scoped downgrade policy. `condition` is intentionally omitted: it is a
  // structured matcher token (e.g. "lockfile_only"), not free text — setting it to
  // a note would block the match. The reviewer's rationale lives in validation.notes.
  const falsePositives = decisions
    .filter((decision) => decision.choice === "false_positive")
    .map((decision) => ({
      path_pattern: decision.item.path,
      action: "downgrade_to_low"
    }));
  const findings = decisions
    .filter((decision) => decision.choice === "flag")
    .map((decision, index) => ({
      id: `WT-${String(index + 1).padStart(3, "0")}`,
      category: "review_value",
      severity: severityForPriority(decision.item.priority),
      affected_section: decision.item.path,
      finding: decision.item.reason,
      desired_change: decision.item.reviewer_action
    }));
  const accepted = decisions
    .filter((decision) => decision.choice === "accept")
    .map((decision) => `Reviewer accepted: ${decision.item.title} (${decision.item.path})`);

  if (falsePositives.length === 0 && findings.length === 0 && accepted.length === 0) {
    return undefined;
  }

  return stripUndefined({
    schema_version: "review-surfaces.feedback.v1",
    author: options.author,
    created_at: options.createdAt,
    head_sha: options.headSha,
    packet_path: options.packetPath,
    findings,
    validation: { passed: accepted, failed: [], notes: ["Captured by the interactive review walkthrough."] },
    false_positives: falsePositives
  });
}

// REVIEW_LOOP.3: a needs-comment decision becomes a suggested-comment draft,
// hunk-anchored to the item, marked draft (ready_to_post: false) unless the
// reviewer confirmed it ready in-session.
export function buildCommentDrafts(decisions: ReviewDecision[], options: WalkthroughOptions): SuggestedReviewComment[] {
  return decisions
    .filter((decision) => decision.choice === "needs_comment")
    .map((decision, index) => ({
      id: `SC-WT-${String(index + 1).padStart(3, "0")}`,
      severity: "clarifying" as const,
      path: decision.item.path,
      line_start: decision.item.line_start,
      line_end: decision.item.line_end,
      body: decision.commentBody ?? decision.item.reviewer_action,
      evidence: decision.item.evidence,
      risk_ids: decision.item.risk_ids,
      requirement_ids: decision.item.requirement_ids,
      confidence: "medium" as const,
      ready_to_post: decision.commentReady ?? false
    }));
}

function severityForPriority(priority: ReviewQueueItem["priority"]): string {
  return priority === "blocker" ? "high" : priority;
}
