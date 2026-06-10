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
  // Resolve a queue item's originating PR-risk rule(s), so a false-positive is
  // scoped to that rule rather than downgrading every finding sharing the path.
  // Undefined (e.g. repo scope, no PR risks) falls back to a path-only policy.
  rulesForItem?: (item: ReviewQueueItem) => string[];
}

// The human-review schema caps a suggested-comment body at 2000 chars; truncate a
// longer in-session draft so the regenerated artifact still validates.
const MAX_COMMENT_BODY = 2000;

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
  // The automatic downgrade-on-rerun matches PR-risk candidates by rule/path
  // (buildFeedbackPolicyEffects); in repo scope decisions are still recorded
  // durably to feedback memory, but the rerun downgrade applies to PR-scoped
  // reviews. Be explicit rather than silently not downgrading.
  if (model.mode !== "pr") {
    io.write("Note: decisions are saved to feedback memory. Automatic finding-downgrade on rerun applies to PR-scoped reviews (--review-scope pr); repo-scope decisions are recorded for the audit trail.");
  }
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
      const body = (await io.prompt("  Comment body: "))?.trim() || item.reviewer_action;
      decision.commentBody = body.slice(0, MAX_COMMENT_BODY);
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
  // A downgrade policy scoped, where possible, to the reviewed finding's rule so a
  // file with several risks does not get all of them downgraded. When the item's
  // rule cannot be resolved (repo scope, or several rules on one item) it falls
  // back to a path-only policy. `condition` is intentionally omitted: it is a
  // structured matcher token (e.g. "lockfile_only"), not free text — a note there
  // would block the match. The reviewer's rationale lives in validation.notes.
  const falsePositives = decisions
    .filter((decision) => decision.choice === "false_positive")
    .map((decision) => {
      const rules = options.rulesForItem?.(decision.item) ?? [];
      const rule = rules.length === 1 ? rules[0] : undefined;
      return stripUndefined({ rule, path_pattern: decision.item.path, action: "downgrade_to_low" });
    });
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
  // Acceptances are recorded as NOTES, not validation.passed: a `passed` entry is
  // treated by feedback ingestion as a passing validation command (indirect test
  // evidence), which would wrongly suppress missing-validation questions. An
  // acceptance is a review acknowledgement, not a test that ran.
  const accepted = decisions
    .filter((decision) => decision.choice === "accept")
    .map((decision) => `Reviewer accepted: ${decision.item.title} (${decision.item.path})`);
  // REVIEW_LOOP.2: a needs-comment decision is recorded durably in feedback memory
  // (not only in the regenerable comments artifact), so the reviewer's intent
  // survives a later rebuild even though the draft itself lives in the artifact.
  const commentRequests = decisions
    .filter((decision) => decision.choice === "needs_comment")
    .map((decision) => `Reviewer requested a comment on ${decision.item.path}: ${decision.commentBody ?? decision.item.reviewer_action}`);

  if (falsePositives.length === 0 && findings.length === 0 && accepted.length === 0 && commentRequests.length === 0) {
    return undefined;
  }

  return stripUndefined({
    schema_version: "review-surfaces.feedback.v1",
    author: options.author,
    created_at: options.createdAt,
    head_sha: options.headSha,
    packet_path: options.packetPath,
    findings,
    validation: { passed: [], failed: [], notes: ["Captured by the interactive review walkthrough.", ...accepted, ...commentRequests] },
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
