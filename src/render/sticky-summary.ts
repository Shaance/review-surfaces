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
import { inspectAndRedactSecrets } from "../privacy/secrets";
import { compareStrings } from "../core/compare";
import { StructuredDiff } from "../pr/contract";
import { renderHunkExcerpt } from "../human/hunk-excerpt";
import {
  decisionLabel,
  formatQueueLocation,
  renderCompactConversationReviewMarkdown
} from "../human/render";
import {
  conversationAnalysisForRender,
  conversationInsightsForRender
} from "../human/conversation-review-presentation";
import type { HumanReviewModel, ReviewQueueItem, SinceLastReview, SinceLastReviewItem } from "../human/contract";
import { STICKY_MARKER } from "./comment";
import { changeMapMermaidEmbed, changeMapTitle, dependencyTreeEmbed, mermaidDetailsBlock } from "./change-map-embed";
import { firstTourLegSnippet } from "./tour-snippet";

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

  const sections: string[] = [
    STICKY_MARKER,
    "## review-surfaces",
    "",
    verdict
  ];

  // COLD_START.7: a literal-HEAD review that absorbed working-tree files says
  // so right under the verdict; clean and pinned-head runs add nothing.
  if (model.generated_from.uncommitted_files > 0) {
    sections.push("", `_includes ${model.generated_from.uncommitted_files} uncommitted file(s) (working tree)_`);
  }

  if (hasPriorReview) {
    // review-surfaces.PR_SURFACE.5: on a re-review, LEAD with the delta and
    // collapse the unchanged full review under a <details> block.
    sections.push("", renderSinceSection(since, state));
  }

  sections.push("", "### Conversation-aware insights", "", renderConversationInsights(model, state));

  if (hasPriorReview) {
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
  // The embed's redaction block signal feeds the postability gate — the final
  // whole-body pass only sees already-redacted text.
  const mapEmbed = changeMapMermaidEmbed(model.change_graph);
  if (mapEmbed.blocked) {
    state.blocked = true;
  }
  if (mapEmbed.body) {
    sections.push("", mermaidDetailsBlock(changeMapTitle(mapEmbed.level), mapEmbed.body));
  }
  // review-surfaces.RENDER.13: attributed dependency chains as a collapsed
  // mermaid tree — only when a chain exists (flat facts stay in the queue).
  const depTree = dependencyTreeEmbed(model.dependency_chains);
  if (depTree.blocked) {
    state.blocked = true;
  }
  if (depTree.body) {
    sections.push("", mermaidDetailsBlock("Dependency chains (supply chain)", depTree.body));
  }
  // review-surfaces.TREND.2: the rounds ledger as a compact table (last ~8
  // rounds; the full ledger lives in the artifact). Partial history renders
  // honestly — "history begins at round N" — never as an error.
  const roundsBlock = renderRoundsTable(model);
  if (roundsBlock) {
    sections.push("", roundsBlock);
  }

  const firstLeg = firstTourLegSnippet(model);
  if (firstLeg.blocked) {
    state.blocked = true;
  }
  if (firstLeg.text) {
    sections.push("", firstLeg.text);
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
  const redaction = inspectAndRedactSecrets(body);
  return { markdown: redaction.text, blocked: state.blocked || redaction.blocked };
}

function renderConversationInsights(model: HumanReviewModel, state: RedactionState): string {
  const analysis = conversationAnalysisForRender(model);
  const insights = conversationInsightsForRender(model);
  return renderCompactConversationReviewMarkdown(analysis, insights, {
    renderField: (value, max) => field(value, state, max)
  });
}

const MAX_ROUNDS_ROWS = 8;

// review-surfaces.TREND.2: rendered only when there is actual history (a
// one-row ledger is the first review — nothing to trend yet).
function renderRoundsTable(model: HumanReviewModel): string | undefined {
  const rounds = model.rounds ?? [];
  if (rounds.length < 2) {
    return undefined;
  }
  const shown = rounds.slice(-MAX_ROUNDS_ROWS);
  const lines = [
    "### Review rounds",
    "",
    ...(rounds[0].round > 1
      ? [`_History begins at round ${rounds[0].round} (earlier rounds expired with their artifacts); full ledger in human_review.json._`, ""]
      : shown[0].round > 1
        ? [`_Showing the last ${shown.length} of ${rounds.length} rounds; full ledger in human_review.json._`, ""]
        : []),
    "| round | head | new | resolved | regressed | verdict |",
    "| --- | --- | --- | --- | --- | --- |",
    ...shown.map(
      (entry) =>
        `| ${entry.round} | \`${entry.head_sha.slice(0, 7)}\` | ${entry.new_count} | ${entry.resolved_count} | ${entry.regressed_count} | ${entry.verdict} |`
    )
  ];
  return lines.join("\n");
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
  // review-surfaces.TREND.5: a single aggregate risk whose only change is its
  // count appears as BOTH resolved (old count) and new (new count) because the
  // count is baked into the comparison identity. Collapse the count-moved pair at
  // render time into one "still open (count N -> M)" note rather than reporting it
  // as both resolved and new.
  const { resolved, news, moved } = dedupeCountMovedRisks(since.resolved_risks, since.new_risks);
  const lines = [
    formatSinceGroup("✅ Resolved risks", resolved, state),
    formatSinceGroup("⚠️ Regressed", since.regressed, state),
    formatSinceGroup("🆕 New risks", news, state),
    moved.length ? `- ↔ Still open (count changed): ${moved.map((note) => field(note, state)).join("; ")}` : undefined,
    formatSinceGroup("📈 Improved", since.improved, state),
    formatSinceGroup("➕ New overreach", since.new_overreach, state),
    formatSinceGroup("✅ Resolved overreach", since.resolved_overreach, state)
  ].filter((line): line is string => line !== undefined);
  return `### Since your last review

${lines.length ? lines.join("\n") : "- No requirement or risk changes since the last review."}

_Compared against the previous review packet._`;
}

const SINCE_COUNT_RE = /\b\d+ (?:requirement\(s\)|changed file\(s\))/;
const SINCE_COLLAPSE_THRESHOLD = 10;

// The count-led aggregate summary with its number removed, so "...139
// requirement(s)..." and "...182 requirement(s)..." normalize to the same stem.
function sinceCountStem(summary: string): string {
  return summary.replace(/\b\d+ (requirement\(s\)|changed file\(s\))/g, "$1");
}

function sinceLeadingCount(summary: string): string | undefined {
  return summary.match(/\b(\d+) (?:requirement\(s\)|changed file\(s\))/)?.[1];
}

// review-surfaces.TREND.5: detect a risk that is "resolved" at its old count and
// "new" at its new count (the same aggregate, count moved) and report it once.
function dedupeCountMovedRisks(
  resolved: SinceLastReviewItem[],
  news: SinceLastReviewItem[]
): { resolved: SinceLastReviewItem[]; news: SinceLastReviewItem[]; moved: string[] } {
  const newByStem = new Map<string, SinceLastReviewItem>();
  for (const item of news) {
    const stem = sinceCountStem(item.summary);
    if (!newByStem.has(stem)) {
      newByStem.set(stem, item);
    }
  }
  const movedStems = new Set<string>();
  const moved: string[] = [];
  const resolvedFiltered: SinceLastReviewItem[] = [];
  for (const item of resolved) {
    const stem = sinceCountStem(item.summary);
    const match = newByStem.get(stem);
    if (match && SINCE_COUNT_RE.test(item.summary) && !movedStems.has(stem)) {
      movedStems.add(stem);
      const oldCount = sinceLeadingCount(item.summary);
      const newCount = sinceLeadingCount(match.summary);
      moved.push(item.summary.replace(/\b\d+ (requirement\(s\)|changed file\(s\))/, `${oldCount} -> ${newCount} $1`));
    } else {
      resolvedFiltered.push(item);
    }
  }
  const newsFiltered = news.filter((item) => !movedStems.has(sinceCountStem(item.summary)));
  return { resolved: resolvedFiltered, news: newsFiltered, moved };
}

function formatSinceGroup(label: string, items: SinceLastReviewItem[], state: RedactionState): string | undefined {
  if (items.length === 0) {
    return undefined;
  }
  return `- ${label}: ${sinceGroupBody(items, state)}`;
}

function sinceGroupBody(items: SinceLastReviewItem[], state: RedactionState): string {
  // review-surfaces.TREND.4: when a bucket is dominated by one homogeneous status
  // transition (the test-evidence flap that regresses dozens of requirements
  // satisfied->partial at once), collapse it to a count + a couple of sample ids
  // so the loudest line is not the lowest-signal one. Single-item / small buckets
  // render verbatim.
  if (items.every((item) => item.previous_status && item.current_status)) {
    const byTransition = new Map<string, SinceLastReviewItem[]>();
    for (const item of items) {
      const key = `${item.previous_status} -> ${item.current_status}`;
      const group = byTransition.get(key);
      if (group) {
        group.push(item);
      } else {
        byTransition.set(key, [item]);
      }
    }
    if ([...byTransition.values()].some((group) => group.length >= SINCE_COLLAPSE_THRESHOLD)) {
      return [...byTransition.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([transition, group]) => {
          const samples = group.slice(0, 2).map((item) => field(item.acai_id ?? item.summary, state)).join(", ");
          return `${group.length} requirement(s) ${transition} (e.g. ${samples})`;
        })
        .join("; ");
    }
  }
  const shown = items
    .slice(0, MAX_SINCE_ITEMS)
    .map((item) => field(item.summary, state))
    .join("; ");
  const more = items.length > MAX_SINCE_ITEMS ? ` (+${items.length - MAX_SINCE_ITEMS} more)` : "";
  return `${shown}${more}`;
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
  const redaction = inspectAndRedactSecrets(value);
  if (redaction.blocked) {
    state.blocked = true;
  }
  const redacted = redaction.text.replace(/\s+/g, " ").trim();
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 3)}...`;
}
