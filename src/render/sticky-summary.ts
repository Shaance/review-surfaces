// review-surfaces.PR_SURFACE.2/.4/.5: a compact, deterministic sticky-summary
// renderer for the GitHub PR comment, rendered strictly from the human review
// model (human_review.json) rather than the lower-level PR sidecar.
//
// It is the DETERMINISTIC human-review rollup, not provider-written narrative
// prose, so it is exempt from the PROVIDERS.5 non-mock-narrative posting gate
// (review-surfaces.PR_SURFACE.4) and may be posted under --provider mock. The
// only posting gate it carries is a hard secret-block check: if redaction blocks
// a high-confidence secret, the result is marked blocked and the caller must not
// post it.
import { redactSecrets } from "../privacy/secrets";
import { StructuredDiff } from "../pr/contract";
import { renderHunkExcerpt } from "../human/hunk-excerpt";
import { decisionLabel, formatQueueLocation } from "../human/render";
import type { HumanReviewModel, ReviewQueueItem, SinceLastReview, SinceLastReviewItem } from "../human/contract";
import { STICKY_MARKER } from "./comment";
import { changeMapDetailsBlock } from "./change-map-embed";

const MAX_SUMMARY_CHARS = 600;
const MAX_FIELD_CHARS = 300;
const DEFAULT_TOP_N = 5;
const MAX_SINCE_ITEMS = 5;

export interface StickySummaryOptions {
  // Render-time diff context (from collected diff artifacts, never the model
  // itself) used to inline bounded hunk excerpts. Optional: without it the queue
  // items degrade to their anchor metadata.
  diff?: StructuredDiff;
  // Number of review-queue items to surface; defaults to 5.
  topN?: number;
  // The workflow-artifact name the full .review-surfaces/ packet was uploaded
  // under, so the comment can point a reviewer at it (review-surfaces.PR_SURFACE.3).
  artifactName?: string;
  // The workflow run id that produced this posted sticky. Recorded in the
  // fingerprint so the NEXT run can recover this run's artifact as the comparison
  // baseline — the last sticky the reviewer actually saw (review-surfaces.PR_SURFACE.5).
  runId?: string;
}

export interface StickySummaryResult {
  markdown: string;
  // True when redaction blocked a high-confidence secret anywhere in the
  // rendered body. The caller's postability gate must refuse to post a blocked
  // body (review-surfaces.PR_SURFACE.4).
  blocked: boolean;
}

// Accumulates whether any field-level redaction blocked a secret. Field-level
// redaction replaces the secret before the final whole-body pass runs, so the
// block signal must be captured here or it would be laundered away.
interface RedactionState {
  blocked: boolean;
}

// Stable identity for a queue item across runs: rule/requirement id + file path +
// anchor, never the array position (review-surfaces.PR_SURFACE.5). Used for the
// in-comment fingerprint so a later run can recover prior state when the artifact
// has expired.
export function stickyQueueItemKey(item: ReviewQueueItem): string {
  const rule = item.risk_ids[0] ?? item.requirement_ids[0] ?? "item";
  const anchor = item.hunk_header ?? (item.line_start ? String(item.line_start) : "");
  return `${rule}:${item.path}:${anchor}`;
}

export function renderStickySummary(model: HumanReviewModel, options: StickySummaryOptions = {}): StickySummaryResult {
  const topN = options.topN && options.topN > 0 ? options.topN : DEFAULT_TOP_N;
  const state: RedactionState = { blocked: false };
  const since = model.since_last_review;
  const hasPriorReview = sinceLastReviewIsAvailable(since);

  const verdict = `**${decisionLabel(model.verdict.decision)}.** ${field(model.summary, state, MAX_SUMMARY_CHARS)}`;
  const queueBlock = renderQueue(model.review_queue.slice(0, topN), options.diff, state);
  const trustBlock = renderTrustCounts(model);

  const sections: string[] = [STICKY_MARKER, "## review-surfaces", "", verdict];

  if (hasPriorReview) {
    // review-surfaces.PR_SURFACE.5: on a re-review, LEAD with the delta and
    // collapse the unchanged full review under a <details> block.
    sections.push("", renderSinceSection(since, state));
    sections.push(
      "",
      "<details>",
      "<summary>Full review (verdict, review queue, trust)</summary>",
      "",
      "### Review first",
      "",
      queueBlock,
      "",
      "### Trust",
      "",
      trustBlock,
      "</details>"
    );
  } else {
    sections.push("", "### Review first", "", queueBlock, "", "### Trust", "", trustBlock);
  }

  // review-surfaces.CHANGE_MAP.3: the change map embeds as a collapsed details
  // block so the sticky stays short; READING_ORDER.2: only the FIRST tour leg.
  const mapBlock = changeMapDetailsBlock(model.change_graph);
  if (mapBlock) {
    sections.push("", mapBlock);
  }
  const firstLeg = renderFirstTourLeg(model, state);
  if (firstLeg) {
    sections.push("", firstLeg);
  }

  if (options.artifactName) {
    sections.push(
      "",
      `📦 Full \`.review-surfaces/\` packet: download the **${field(options.artifactName, state)}** workflow artifact.`
    );
  }

  // review-surfaces.PR_SURFACE.5: an in-comment fingerprint (head sha, the run id
  // that produced this posted sticky, and stable finding keys) lets the next run
  // recover THIS run's artifact as the baseline reviewers last saw.
  sections.push("", renderFingerprint(model, options.runId));

  const body = `${sections.join("\n")}\n`;
  // Final whole-body redaction pass: field-level redaction already ran on prose
  // fields, but this catches anything not field-redacted (e.g. diff excerpts) and
  // contributes to the block gate alongside the field-level signal.
  const redaction = redactSecrets(body);
  return { markdown: redaction.text, blocked: state.blocked || redaction.blocked };
}

// review-surfaces.READING_ORDER.2: the sticky carries ONLY the first leg of the
// guided tour — it must stay short.
function renderFirstTourLeg(model: HumanReviewModel, state: RedactionState): string | undefined {
  const leg = model.reading_order.legs[0];
  if (!leg || leg.steps.length === 0) {
    return undefined;
  }
  // Cap the leg itself too: a broad PR can put dozens of files in one leg, and
  // the sticky must stay short.
  const MAX_STICKY_TOUR_STEPS = 5;
  const shown = leg.steps.slice(0, MAX_STICKY_TOUR_STEPS);
  const steps = shown
    .map((step, index) => `${index + 1}. \`${field(step.path, state)}\` — ${field(step.why, state)}`)
    .join("\n");
  const hiddenSteps = leg.steps.length - shown.length;
  const remainingLegs = model.reading_order.legs.length - 1;
  const pointers: string[] = [];
  if (hiddenSteps > 0) {
    pointers.push(`+ ${hiddenSteps} more step(s) in this leg`);
  }
  if (remainingLegs > 0) {
    pointers.push(`${remainingLegs} more leg(s)`);
  }
  const more = pointers.length > 0 ? `\n\n_${pointers.join("; ")} in the full reading order (human_review.md)._` : "";
  return `### Start reading here (${field(leg.title, state)})\n\n${steps}${more}`;
}

function renderQueue(items: ReviewQueueItem[], diff: StructuredDiff | undefined, state: RedactionState): string {
  if (items.length === 0) {
    return "- No path-backed review queue items.";
  }
  return items
    .map((item) => {
      const excerpt = inlineExcerpt(item, diff, state);
      return `${item.rank}. \`${field(formatQueueLocation(item), state)}\` — ${field(item.reason, state)}
   - Action: ${field(item.reviewer_action, state)}${excerpt ? `\n${excerpt}` : ""}`;
    })
    .join("\n\n");
}

function inlineExcerpt(item: ReviewQueueItem, diff: StructuredDiff | undefined, state: RedactionState): string {
  // review-surfaces.PR_SURFACE.4: thread the block state so a high-confidence
  // secret in an excerpt line also trips the postability gate, not just the
  // field-level prose redaction.
  const excerpt = renderHunkExcerpt(
    diff,
    {
      path: item.path,
      old_path: item.old_path,
      hunk_header: item.hunk_header,
      line_start: item.line_start,
      line_end: item.line_end,
      side: item.anchor_side
    },
    undefined,
    state
  );
  if (!excerpt) {
    return "";
  }
  return excerpt
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}

function renderTrustCounts(model: HumanReviewModel): string {
  const trust = model.trust_audit;
  return `- ${trust.verified_facts.length} verified, ${trust.claimed_not_verified.length} claimed (unverified), ${trust.missing_evidence.length} missing evidence, ${trust.invalid_evidence.length} invalid.`;
}

function renderSinceSection(since: SinceLastReview, state: RedactionState): string {
  const lines = [
    formatSinceGroup("✅ Resolved risks", since.resolved_risks, state),
    formatSinceGroup("⚠️ Regressed", since.regressed, state),
    formatSinceGroup("🆕 New risks", since.new_risks, state),
    formatSinceGroup("📈 Improved", since.improved, state),
    formatSinceGroup("➕ New overreach", since.new_overreach, state),
    formatSinceGroup("✅ Resolved overreach", since.resolved_overreach, state)
  ].filter((line): line is string => line !== undefined);
  return `### Since your last review

${lines.length ? lines.join("\n") : "- No requirement or risk changes since the last review."}

_Compared against the previous review packet._`;
}

function formatSinceGroup(label: string, items: SinceLastReviewItem[], state: RedactionState): string | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const shown = items
    .slice(0, MAX_SINCE_ITEMS)
    .map((item) => field(item.summary, state))
    .join("; ");
  const more = items.length > MAX_SINCE_ITEMS ? ` (+${items.length - MAX_SINCE_ITEMS} more)` : "";
  return `- ${label}: ${shown}${more}`;
}

function renderFingerprint(model: HumanReviewModel, runId: string | undefined): string {
  const keys = model.review_queue.map((item) => stickyQueueItemKey(item)).join(",");
  const runPart = runId ? ` run=${runId}` : "";
  // Strip characters that could close the HTML comment early: a path or hunk
  // anchor containing `-->` would otherwise break out and render the rest as
  // visible Markdown (an injection surface for arbitrary comment text).
  const safe = sanitizeForHtmlComment(`head=${model.generated_from.head_sha}${runPart} keys=${keys}`);
  return `<!-- review-surfaces:fingerprint ${safe} -->`;
}

function sanitizeForHtmlComment(text: string): string {
  return text.replace(/[<>]/g, "").replace(/-{2,}/g, "-");
}

// A compared-in prior packet means re-review mode, even when every delta bucket
// is empty: the reviewer already saw the queue, so the sticky leads with "no
// changes since last review" and collapses the unchanged remainder rather than
// re-expanding the full queue as a first review (review-surfaces.PR_SURFACE.5).
function sinceLastReviewIsAvailable(since: SinceLastReview | undefined): since is SinceLastReview {
  return Boolean(since && !since.unavailable_reason && since.previous_packet_path);
}

// Redact secrets first, then collapse whitespace and truncate — same invariant as
// the human renderer: truncating before redacting would split a multi-line secret
// and leave it unmatched. A blocked secret is recorded on `state` because the
// replacement hides it from the final whole-body pass.
function field(value: string, state: RedactionState, max = MAX_FIELD_CHARS): string {
  const redaction = redactSecrets(value);
  if (redaction.blocked) {
    state.blocked = true;
  }
  const redacted = redaction.text.replace(/\s+/g, " ").trim();
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 3)}...`;
}
