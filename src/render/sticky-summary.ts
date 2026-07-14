// review-surfaces.PR_SURFACE.2/.4/.5: a compact, deterministic sticky-summary
// renderer for the GitHub PR comment, rendered strictly from the human review
// model (human_review.json) rather than the lower-level PR sidecar.
//
// It is the DETERMINISTIC human-review rollup, not provider-written narrative
// prose, so it remains postable without an LLM (review-surfaces.PR_SURFACE.4).
// The only posting gate it carries is a hard secret-block check: if redaction blocks
// a high-confidence secret, the result is marked blocked and the caller must not
// post it.
import crypto from "node:crypto";
import { inspectAndRedactSecrets } from "../privacy/secrets";
import { compareStrings } from "../core/compare";
import { decisionLabel } from "../human/review-presentation";
import { requiredAuthorAction } from "../human/primary-surface-policy";
import {
  decisionIntentSourceLabel,
  decisionProjectionHeading,
  EMPTY_DECISION_FINDINGS_TEXT,
  incompleteReviewScopeText
} from "../human/decision-projection-presentation";
import type { HumanReviewModel, ReviewQueueItem, SinceLastReview, SinceLastReviewItem } from "../human/contract";
import { STICKY_MARKER } from "./sticky-marker";
import { escapeMarkdownLiteral, markdownInlineCode, markdownLinkDestination } from "./markdown-literal";

const MAX_FIELD_CHARS = 300;
const MAX_SINCE_ITEMS = 5;
// GitHub rejects issue comments above 65,536 bytes. Stay below that physical
// boundary and adapt the detail per decision to the actual rendered size.
const MAX_GITHUB_COMMENT_BYTES = 60_000;

export interface StickySummaryOptions {
  // The workflow-artifact name the full .review-surfaces/ packet was uploaded
  // under, so the comment can point a reviewer at it (review-surfaces.PR_SURFACE.3).
  artifactName?: string;
  // The workflow run id that produced this posted sticky. Recorded in the
  // fingerprint so the NEXT run can recover this run's artifact as the comparison
  // baseline — the last sticky the reviewer actually saw (review-surfaces.PR_SURFACE.5).
  runId?: string;
  // Direct link to the workflow run that owns artifactName. When present, the
  // reviewer can reach the artifact without hunting through the Actions tab.
  artifactUrl?: string;
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
  cache: Map<string, { text: string; blocked: boolean }>;
}

interface StickyDraft {
  markdown: string;
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
  const cache = new Map<string, { text: string; blocked: boolean }>();
  const decisionDelta = approvalChangingSinceLastReview(model);
  const full = buildStickySummary(model, options, "full", cache, decisionDelta);
  if (full) {
    return finalizeStickyDraft(full);
  }
  const compact = buildStickySummary(model, options, "compact", cache, decisionDelta);
  if (compact) {
    return finalizeStickyDraft(compact);
  }
  const overflow = buildOverflowStickySummary(model, options, cache);
  if (Buffer.byteLength(overflow.markdown, "utf8") <= MAX_GITHUB_COMMENT_BYTES) {
    return finalizeStickyDraft(overflow);
  }
  return buildEmergencyStickySummary(model, options.runId);
}

function finalizeStickyDraft(draft: StickyDraft): StickySummaryResult {
  const redaction = inspectAndRedactSecrets(draft.markdown);
  return { markdown: redaction.text, blocked: draft.blocked || redaction.blocked };
}

function buildEmergencyStickySummary(model: HumanReviewModel, runId: string | undefined): StickySummaryResult {
  const body = `${STICKY_MARKER}\n## review-surfaces\n\n**${decisionLabel(model.verdict.decision)}.**\n\nThe approval brief exceeds GitHub's physical comment limit. Review the workflow artifact before merge.\n\n${renderFingerprint(model, runId)}\n`;
  const redaction = inspectAndRedactSecrets(body);
  return { markdown: redaction.text, blocked: redaction.blocked };
}

function buildOverflowStickySummary(
  model: HumanReviewModel,
  options: StickySummaryOptions,
  cache: RedactionState["cache"]
): StickyDraft {
  const state: RedactionState = {
    blocked: model.decision_projection.active_intent.redaction_blocked,
    cache
  };
  const count = model.decision_projection.findings.length;
  const artifact = options.artifactName
    ? options.artifactUrl
      ? `[**${prose(options.artifactName, state)}**](${linkDestination(options.artifactUrl, state)})`
      : `**${prose(options.artifactName, state)}**`
    : "the full review artifact";
  const body = `${[
    STICKY_MARKER,
    "## review-surfaces",
    "",
    `**${decisionLabel(model.verdict.decision)}.**`,
    "",
    "### Approval brief exceeds GitHub's physical comment limit",
    "",
    `${count} independent approval decisions were preserved in ${artifact}, but the actionable one-line-per-decision brief exceeds GitHub's comment size limit.`,
    "",
    "**Author action:** Split the change into reviewable approval units, or review and record each decision from the full artifact before merge.",
    "",
    renderFingerprint(model, options.runId)
  ].join("\n")}\n`;
  return { markdown: body, blocked: state.blocked };
}

function buildStickySummary(
  model: HumanReviewModel,
  options: StickySummaryOptions,
  detail: "full" | "compact",
  cache: RedactionState["cache"],
  decisionDelta: ReturnType<typeof approvalChangingSinceLastReview>
): StickyDraft | undefined {
  const state: RedactionState = {
    blocked: model.decision_projection.active_intent.redaction_blocked,
    cache
  };

  const verdict = `**${decisionLabel(model.verdict.decision)}.**`;

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
  const authorAction = requiredAuthorAction(model);
  if (authorAction) {
    sections.push("", `**Author action:** ${prose(authorAction, state, MAX_FIELD_CHARS)}`);
  }
  const scopeWarning = incompleteReviewScopeText(model.generated_from.omitted_untracked_files ?? 0);
  if (scopeWarning) {
    sections.push("", `**${scopeWarning}**`);
  }

  const trailingSections: string[] = [];
  if (decisionDelta) {
    trailingSections.push(renderSinceSection(decisionDelta.since, state, decisionDelta.verdictTransition));
  }

  if (options.artifactName) {
    const artifactName = prose(options.artifactName, state);
    const artifactPointer = options.artifactUrl
      ? `[**${artifactName}**](${linkDestination(options.artifactUrl, state)})`
      : `**${artifactName}**`;
    trailingSections.push(
      `📦 Full \`.review-surfaces/\` packet: open the ${artifactPointer} workflow artifact.`
    );
  }

  // review-surfaces.PR_SURFACE.5: an in-comment fingerprint (head sha, the run id
  // that produced this posted sticky, and stable finding keys) lets the next run
  // recover THIS run's artifact as the baseline reviewers last saw.
  trailingSections.push(renderFingerprint(model, options.runId));

  const decisionPrefix = renderDecisionProjectionPrefix(model, state, detail);
  const prefix = `${sections.join("\n")}\n\n${decisionPrefix}`;
  const suffix = `${trailingSections.map((section) => `\n\n${section}`).join("")}\n`;
  const fixedBytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
  if (fixedBytes > MAX_GITHUB_COMMENT_BYTES) return undefined;
  const findings = renderDecisionFindingsWithinBudget(
    model,
    state,
    detail,
    MAX_GITHUB_COMMENT_BYTES - fixedBytes
  );
  if (findings === undefined) return undefined;
  return { markdown: `${prefix}${findings}${suffix}`, blocked: state.blocked };
}

function renderDecisionProjectionPrefix(
  model: HumanReviewModel,
  state: RedactionState,
  detail: "full" | "compact"
): string {
  const projection = model.decision_projection;
  const source = decisionIntentSourceLabel(projection.active_intent.source);
  const decisionHeading = `### ${decisionProjectionHeading(projection.findings.length)}`;
  const purposeLimit = detail === "full" ? 2000 : 700;
  return `### Change purpose\n\n${prose(projection.active_intent.summary, state, purposeLimit)}\n\n_${source}._\n\n${decisionHeading}\n\n`;
}

function renderDecisionFindingsWithinBudget(
  model: HumanReviewModel,
  state: RedactionState,
  detail: "full" | "compact",
  byteBudget: number
): string | undefined {
  const findings = model.decision_projection.findings;
  if (findings.length === 0) {
    const empty = `- ${EMPTY_DECISION_FINDINGS_TEXT}`;
    return Buffer.byteLength(empty, "utf8") <= byteBudget ? empty : undefined;
  }
  const rows: string[] = [];
  let bytes = 0;
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    const location = finding.path ? ` ${inlineCode(finding.path, state)}` : "";
    const separator = index === 0 ? "" : "\n";
    const separatorBytes = Buffer.byteLength(separator, "utf8");
    const rendered = detail === "compact"
      ? `${index + 1}. **${prose(finding.title, state, 160)}**${location} — Review: ${prose(finding.reviewer_action, state, 260)}`
      : renderFullDecisionRowWithinBudget(finding, index, location, state, byteBudget - bytes - separatorBytes);
    if (rendered === undefined) return undefined;
    const chunkBytes = separatorBytes + Buffer.byteLength(rendered, "utf8");
    if (bytes + chunkBytes > byteBudget) return undefined;
    if (separator) rows.push(separator);
    rows.push(rendered);
    bytes += chunkBytes;
  }
  return rows.join("");
}

function renderFullDecisionRowWithinBudget(
  finding: HumanReviewModel["decision_projection"]["findings"][number],
  index: number,
  location: string,
  state: RedactionState,
  byteBudget: number
): string | undefined {
  const reasonText = finding.reason.trim() === finding.title.trim() ? undefined : finding.reason;
  const reason = reasonText ? ` — ${prose(reasonText, state)}` : "";
  const parts = [
    `${index + 1}. **${prose(finding.title, state)}**${location}${reason}\n   - Review: ${prose(finding.reviewer_action, state)}`
  ];
  let bytes = Buffer.byteLength(parts[0], "utf8");
  if (bytes > byteBudget) return undefined;
  const seenEvidence = new Set<string>();
  let evidenceCount = 0;
  for (const ref of finding.evidence) {
    const value = ref.path ? `${ref.path}${ref.line_start ? `:${ref.line_start}` : ""}` : ref.note;
    if (!value || seenEvidence.has(value)) continue;
    seenEvidence.add(value);
    const chunk = `${evidenceCount === 0 ? "\n   - Evidence: " : ", "}${inlineCode(value, state)}`;
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (bytes + chunkBytes > byteBudget) return undefined;
    parts.push(chunk);
    bytes += chunkBytes;
    evidenceCount += 1;
  }
  return parts.join("");
}


function renderSinceSection(
  since: SinceLastReview,
  state: RedactionState,
  verdictTransition?: string
): string {
  // review-surfaces.TREND.5: a single aggregate risk whose only change is its
  // count appears as BOTH resolved (old count) and new (new count) because the
  // count is baked into the comparison identity. Collapse the count-moved pair at
  // render time into one "still open (count N -> M)" note rather than reporting it
  // as both resolved and new.
  const { resolved, news, moved } = dedupeCountMovedRisks(since.resolved_risks, since.new_risks);
  const lines = [
    verdictTransition ? `- Verdict changed: ${prose(verdictTransition, state)}` : undefined,
    formatSinceGroup("✅ Resolved risks", resolved, state),
    formatSinceGroup("⚠️ Regressed", since.regressed, state),
    formatSinceGroup("🆕 New risks", news, state),
    moved.length ? `- ↔ Still open (count changed): ${moved.map((note) => prose(note, state)).join("; ")}` : undefined,
    formatSinceGroup("📈 Improved", since.improved, state),
    formatSinceGroup("➕ New overreach", since.new_overreach, state),
    formatSinceGroup("✅ Resolved overreach", since.resolved_overreach, state)
  ].filter((line): line is string => line !== undefined);
  return `### Since your last review

${lines.join("\n")}

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
          const samples = group.slice(0, 2).map((item) => prose(item.acai_id ?? item.summary, state)).join(", ");
          return `${group.length} requirement(s) ${transition} (e.g. ${samples})`;
        })
        .join("; ");
    }
  }
  const shown = items
    .slice(0, MAX_SINCE_ITEMS)
    .map((item) => prose(item.summary, state))
    .join("; ");
  const more = items.length > MAX_SINCE_ITEMS ? ` (+${items.length - MAX_SINCE_ITEMS} more)` : "";
  return `${shown}${more}`;
}

function renderFingerprint(model: HumanReviewModel, runId: string | undefined): string {
  const keys = model.review_queue.map((item) => stickyQueueItemKey(item)).join(",");
  const keyHash = crypto.createHash("sha256").update(keys).digest("hex").slice(0, 20);
  const safeHead = sanitizeForHtmlComment(model.generated_from.head_sha).slice(0, 80);
  const safeRun = runId ? sanitizeForHtmlComment(runId).slice(0, 32) : undefined;
  const runPart = safeRun ? ` run=${safeRun}` : "";
  // Strip characters that could close the HTML comment early: a path or hunk
  // anchor containing `-->` would otherwise break out and render the rest as
  // visible Markdown (an injection surface for arbitrary comment text).
  return `<!-- review-surfaces:fingerprint head=${safeHead}${runPart} queue=${keyHash} -->`;
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

function approvalChangingSinceLastReview(model: HumanReviewModel): {
  since: SinceLastReview;
  verdictTransition?: string;
} | undefined {
  const since = model.since_last_review;
  if (!sinceLastReviewIsAvailable(since)) return undefined;
  const findings = model.decision_projection.findings;
  const decisionRefs = new Set(findings.flatMap((finding) => [...finding.risk_ids, ...finding.requirement_ids]));
  const paths = new Set(findings.flatMap((finding) => [
    ...(finding.path ? [finding.path] : []),
    ...finding.evidence.flatMap((ref) => ref.path ? [ref.path] : [])
  ]));
  const relevant = (item: SinceLastReviewItem): boolean =>
    item.decision_refs?.some((ref) => decisionRefs.has(ref)) === true ||
    (item.acai_id !== undefined && decisionRefs.has(item.acai_id)) ||
    (item.path !== undefined && paths.has(item.path)) ||
    item.evidence.some((ref) => ref.path !== undefined && paths.has(ref.path));
  const filtered: SinceLastReview = {
    ...since,
    improved: since.improved.filter(relevant),
    regressed: since.regressed.filter(relevant),
    new_risks: since.new_risks.filter(relevant),
    // A resolved risk cannot appear in the current decision projection. Its
    // exact refs come from the previous review's admitted approval decisions.
    resolved_risks: since.resolved_risks.filter((item) =>
      (item.decision_refs?.length ?? 0) > 0 || relevant(item)
    ),
    // Path-level overreach is supporting inventory, not a decision transition.
    // If overreach matters to approval it already appears as an admitted
    // decision above; repeating file churn here turns the brief into a changelog.
    new_overreach: [],
    resolved_overreach: [],
    still_open: since.still_open.filter(relevant)
  };
  const previousRound = [...model.rounds]
    .reverse()
    .find((entry) => entry.head_sha !== model.generated_from.head_sha);
  const verdictTransition = previousRound && previousRound.verdict !== model.verdict.decision
    ? `${decisionLabel(previousRound.verdict)} → ${decisionLabel(model.verdict.decision)}`
    : undefined;
  const hasRelevantItems = [
    filtered.improved,
    filtered.regressed,
    filtered.new_risks,
    filtered.resolved_risks
  ].some((items) => items.length > 0);
  return hasRelevantItems || verdictTransition ? { since: filtered, verdictTransition } : undefined;
}

// Redact secrets first, then collapse whitespace and truncate — same invariant as
// the human renderer: truncating before redacting would split a multi-line secret
// and leave it unmatched. A blocked secret is recorded on `state` because the
// replacement hides it from the final whole-body pass.
function field(value: string, state: RedactionState, max = MAX_FIELD_CHARS): string {
  let redaction = state.cache.get(value);
  if (!redaction) {
    const inspected = inspectAndRedactSecrets(value);
    redaction = {
      text: inspected.text.replace(/\s+/g, " ").trim(),
      blocked: inspected.blocked
    };
    state.cache.set(value, redaction);
  }
  if (redaction.blocked) {
    state.blocked = true;
  }
  const redacted = redaction.text;
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 3)}...`;
}

// User-authored PR titles/bodies are rendered as literal prose, never as
// Markdown/HTML control syntax. This prevents a title such as `<!--` or `#`
// from hiding or restructuring the approval decisions below it.
function prose(value: string, state: RedactionState, max = MAX_FIELD_CHARS): string {
  return escapeMarkdownLiteral(field(value, state, max));
}

function inlineCode(value: string, state: RedactionState): string {
  return markdownInlineCode(field(value, state));
}

function linkDestination(value: string, state: RedactionState): string {
  return markdownLinkDestination(field(value, state, 2000));
}
