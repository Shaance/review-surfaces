import { SPEC_NONE_NOTE } from "../evaluation/status";
import { redactSecrets } from "../privacy/secrets";
import { changeMapMermaidEmbed, dependencyTreeEmbed, mermaidDetailsBlock } from "./change-map-embed";
import { firstTourLegSnippet } from "./tour-snippet";
import type {
  HumanReviewModel,
  ReviewBlocker,
  ReviewerQuestion,
  ReviewQueueItem,
  SuggestedReviewComment
} from "../human/contract";
import {
  AnchoredNarrativeItem,
  PrChangeDiagramModel,
  PrRequirementCoverageDelta,
  PrReviewSurfaceModel
} from "../pr/contract";

// ---------------------------------------------------------------------------
// PR-mode sticky comment renderer. Renders the diff-scoped PrReviewSurfaceModel:
// LLM what-changed / why / review-first (anchored to changed files + ids),
// affected coverage DELTA (only the requirements the PR touches), deterministic
// PR risks, and a change-impact Mermaid diagram. A BLOCKED surface renders a
// short explanation and NEVER falls back to the whole-repo comment.
// ---------------------------------------------------------------------------

export const PR_STICKY_MARKER = "<!-- review-surfaces:sticky -->";

const MAX_LINE_CHARS = 300;
const MAX_COMMENT_CHARS = 60000;
const MAX_DELTAS = 12;
const MAX_RISKS = 8;
const MAX_WHAT_CHANGED = 3;
const MAX_WHY_IT_MATTERS = 3;
const MAX_REVIEW_FIRST = 5;
const MAX_HUMAN_BLOCKERS = 4;
const MAX_HUMAN_QUESTIONS = 4;
const MAX_HUMAN_COMMENTS = 3;

function redact(value: string): string {
  return redactSecrets(value).text;
}

function field(value: string): string {
  const oneLine = redact(value).replace(/\s+/g, " ").trim();
  return oneLine.length <= MAX_LINE_CHARS ? oneLine : `${oneLine.slice(0, MAX_LINE_CHARS - 1)}…`;
}

// Anchor tags appended to a narrative line so a reviewer can jump to the cited
// files/requirements/risks. All anchors are deterministic allowlist values.
function anchors(item: AnchoredNarrativeItem): string {
  const parts = [...(item.paths ?? []), ...(item.requirement_ids ?? []), ...(item.risk_ids ?? [])];
  return parts.length > 0 ? ` (${parts.map((part) => `\`${field(part)}\``).join(", ")})` : "";
}

function bullets(items: AnchoredNarrativeItem[], emptyText: string): string {
  if (items.length === 0) {
    return `- ${emptyText}`;
  }
  return items.map((item) => `- ${field(item.text)}${anchors(item)}`).join("\n");
}

function coverageLines(deltas: PrRequirementCoverageDelta[], baseAvailable: boolean): string[] {
  const lines: string[] = [];
  for (const delta of deltas.slice(0, MAX_DELTAS)) {
    const id = delta.acai_id ?? delta.requirement_id;
    const change = baseAvailable ? `${delta.base_status} -> ${delta.head_status} (${delta.delta})` : `${delta.head_status}`;
    lines.push(`${id}: ${field(change)}`);
  }
  if (deltas.length > MAX_DELTAS) {
    lines.push(`... ${deltas.length - MAX_DELTAS} more affected requirement(s)`);
  }
  return lines;
}


const DEFAULT_SURFACE_PATH = ".review-surfaces/pr_review_surface.json";
const DEFAULT_HUMAN_REVIEW_PATH = ".review-surfaces/human_review.md";
const DEFAULT_HUMAN_REVIEW_JSON_PATH = ".review-surfaces/human_review.json";

export interface RenderPrCommentOptions {
  // Relative path to the pr_review_surface.json the comment was rendered from, so
  // the "Full PR surface" pointer matches the actual --out / config output_dir
  // instead of hardcoding .review-surfaces.
  surfacePath?: string;
}

export interface RenderHumanPrCommentOptions extends RenderPrCommentOptions {
  humanReviewPath?: string;
  humanReviewJsonPath?: string;
}

function clampTotal(markdown: string, surfacePath: string): string {
  if (markdown.length <= MAX_COMMENT_CHARS) {
    return markdown;
  }
  const trailer = `\n\n... truncated; see \`${surfacePath}\` for the full surface.\n`;
  return `${markdown.slice(0, MAX_COMMENT_CHARS - trailer.length)}${trailer}`;
}

/**
 * Render the PR-mode sticky comment from a PrReviewSurfaceModel. Deterministic
 * given the surface. A blocked surface renders an explanation, not the generic
 * whole-repo comment.
 */
export function renderPrComment(surface: PrReviewSurfaceModel, options: RenderPrCommentOptions = {}): string {
  const providerLabel = surface.llm.model ? `${surface.llm.provider}/${surface.llm.model}` : surface.llm.provider;
  const surfacePath = options.surfacePath ?? DEFAULT_SURFACE_PATH;

  if (surface.status === "blocked" || !surface.narrative) {
    const reason = surface.blocked_reason ?? "llm_unavailable";
    const hint =
      reason === "no_diff"
        ? "No changed files in scope for this base/head range."
        : reason === "privacy_block"
          ? "A privacy/secret guard blocked the remote LLM call; the PR narrative was not generated."
          : reason === "baseline_unavailable"
            ? "The base ref could not be evaluated for a coverage delta."
            : reason === "llm_failed"
              ? "The LLM provider was configured but the call failed at runtime (timeout, network, or model error). Re-run; see `validation_errors` in `.review-surfaces/pr_review_surface.json` for the underlying cause."
              : reason === "invalid_llm_output"
                ? "The LLM responded but produced no output that survived evidence-gating (no valid anchored items). Re-run; deterministic scope is below."
                : "The PR review narrative requires an LLM provider. Re-run with `--provider ai-sdk` and a configured key (Google/Gemini by default), or use `--review-scope repo` for the whole-repo report.";
    return clampTotal(
      [
        PR_STICKY_MARKER,
        "## review-surfaces PR review",
        "",
        `**Status:** blocked (\`${reason}\`).`,
        "",
        field(hint),
        "",
        // review-surfaces.COLD_START.5: spec-less surfaces never count requirements.
        surface.spec_mode === "none"
          ? `Deterministic scope: ${surface.scope.changed_files.length} changed file(s), ${surface.risks.candidates.length} PR risk(s). See \`${surfacePath}\`.`
          : `Deterministic scope: ${surface.scope.changed_files.length} changed file(s), ${surface.scope.affected_requirements.length} affected requirement(s), ${surface.risks.candidates.length} PR risk(s). See \`${surfacePath}\`.`,
        ""
      ].join("\n") + "\n",
      surfacePath
    );
  }

  const narrative = surface.narrative;
  const summary = field(narrative.summary);
  // Build the comment as discrete blocks joined by single blank lines. Blank ("")
  // entries are INTENTIONAL Markdown separators and must survive to the join: the
  // mermaid `<details>` block in particular only renders on GitHub when a blank
  // line separates the raw-HTML opener from the ```mermaid fence. (A prior
  // `.filter(line => line !== "")` stripped those, collapsing the diagram.)
  const sections: string[] = [
    PR_STICKY_MARKER,
    "## review-surfaces PR review",
    "",
    `**Status:** PR-scoped review generated with ${field(providerLabel)}.`
  ];
  if (summary) {
    sections.push("", summary);
  }
  sections.push(
    "",
    "### What changed",
    bullets(narrative.what_changed.slice(0, MAX_WHAT_CHANGED), "No change narrative."),
    "",
    "### Why it matters",
    bullets(narrative.why_it_matters.slice(0, MAX_WHY_IT_MATTERS), "No impact narrative."),
    "",
    "### Review first",
    bullets(narrative.review_first.slice(0, MAX_REVIEW_FIRST), "No ordered review plan."),
    "",
    // review-surfaces.COLD_START.5: a spec-less PR comment renders the honest
    // note instead of an empty affected-coverage section.
    ...(surface.spec_mode === "none"
      ? ["### Affected coverage", SPEC_NONE_NOTE]
      : [
          "### Affected coverage",
          surface.coverage.base_available
            ? `${surface.coverage.in_scope_count} in scope — improved ${surface.coverage.counts.improved} | regressed ${surface.coverage.counts.regressed} | unchanged ${surface.coverage.counts.unchanged} | new ${surface.coverage.counts.new_requirement}`
            : `${surface.coverage.in_scope_count} requirement(s) in scope (baseline unavailable; current status only)`,
          bulletsFromLines(coverageLines(surface.coverage.deltas, surface.coverage.base_available), "No affected requirements.")
        ]),
    "",
    "### PR risks",
    renderRisks(surface),
    // review-surfaces.CHANGE_MAP.3: the old requirements-hairball "Change
    // impact" embed retired with the change map; pr-change-impact.mmd remains a
    // standalone agent-facing artifact off the human surfaces.
    "",
    `Full PR surface: \`${surfacePath}\`.`
  );

  return clampTotal(`${sections.join("\n")}\n`, surfacePath);
}

/**
 * Render the PR sticky comment from the human-review cockpit contract. This is
 * still PR-mode output: the lower-level pr_review_surface.json remains the fact
 * and postability gate, while the comment body uses the human decision model
 * when that JSON is available and current.
 */
export interface RenderedHumanPrComment {
  markdown: string;
  // True when redaction blocked a high-confidence secret in the embedded map
  // or tour snippet. The posting gate must refuse to post a blocked body —
  // the body itself only carries the redacted placeholder, so this flag is the
  // only surviving signal (same contract as renderStickySummary).
  blocked: boolean;
}

export function renderHumanPrComment(model: HumanReviewModel, options: RenderHumanPrCommentOptions = {}): RenderedHumanPrComment {
  const humanReviewPath = options.humanReviewPath ?? DEFAULT_HUMAN_REVIEW_PATH;
  const humanReviewJsonPath = options.humanReviewJsonPath ?? DEFAULT_HUMAN_REVIEW_JSON_PATH;
  const surfacePath = options.surfacePath ?? DEFAULT_SURFACE_PATH;
  // review-surfaces.CHANGE_MAP.3 + READING_ORDER.2: the PR-mode sticky carries
  // the collapsed map AND the first tour leg, like the Action sticky.
  const mapEmbed = changeMapMermaidEmbed(model.change_graph);
  const depTree = dependencyTreeEmbed(model.dependency_chains);
  const tourLeg = firstTourLegSnippet(model);
  const sections: string[] = [
    PR_STICKY_MARKER,
    "## review-surfaces PR review",
    "",
    `**Verdict:** ${decisionLabel(model.verdict.decision)}.`,
    "",
    field(model.summary),
    "",
    "### Review first",
    renderHumanReviewFirst(model.review_queue.slice(0, MAX_REVIEW_FIRST)),
    "",
    "### Blockers",
    renderHumanBlockers(model.blockers.slice(0, MAX_HUMAN_BLOCKERS)),
    "",
    "### Questions",
    renderHumanQuestions(model.questions.slice(0, MAX_HUMAN_QUESTIONS)),
    "",
    "### Suggested comments",
    renderHumanSuggestedComments(model.suggested_comments),
    "",
    // The blank line before the details block is required for GitHub to render
    // the inner mermaid.
    ...(mapEmbed.body ? [mermaidDetailsBlock("Change map", mapEmbed.body), ""] : []),
    ...(depTree.body ? [mermaidDetailsBlock("Dependency chains (supply chain)", depTree.body), ""] : []),
    ...(tourLeg.text ? [tourLeg.text, ""] : []),
    `Full human review: \`${field(humanReviewPath)}\`.`,
    `Human review JSON: \`${field(humanReviewJsonPath)}\`.`,
    `Lower-level PR facts: \`${field(surfacePath)}\`.`
  ];
  return {
    markdown: clampTotal(`${sections.join("\n")}\n`, humanReviewPath),
    blocked: mapEmbed.blocked || depTree.blocked || tourLeg.blocked
  };
}

function decisionLabel(decision: HumanReviewModel["verdict"]["decision"]): string {
  switch (decision) {
    case "probably_safe":
      return "Probably safe";
    case "reviewable_with_attention":
      return "Reviewable with attention";
    case "needs_author_clarification":
      return "Needs author clarification";
    case "block_before_merge":
      return "Block before merge";
    case "no_signal":
      return "No signal";
  }
}

function renderHumanReviewFirst(items: ReviewQueueItem[]): string {
  if (items.length === 0) {
    return "- No path-backed review queue items generated.";
  }
  return items.map((item, index) => {
    const ids = [...item.risk_ids, ...item.requirement_ids].slice(0, 4);
    const anchors = ids.length > 0 ? ` Evidence: ${ids.map((id) => `\`${field(id)}\``).join(", ")}.` : "";
    return `${index + 1}. \`${field(formatQueueLocation(item))}\` - ${field(item.title)}. Action: ${field(item.reviewer_action)}${anchors}`;
  }).join("\n");
}

function formatQueueLocation(item: ReviewQueueItem): string {
  if (item.line_start !== undefined && item.line_end !== undefined) {
    return item.line_start === item.line_end ? `${item.path}:${item.line_start}` : `${item.path}:${item.line_start}-${item.line_end}`;
  }
  if (item.line_start !== undefined) {
    return `${item.path}:${item.line_start}`;
  }
  return item.path;
}

function renderHumanBlockers(blockers: ReviewBlocker[]): string {
  if (blockers.length === 0) {
    return "- No merge blockers generated.";
  }
  return blockers.map((blocker) => `- ${field(blocker.id)} [${blocker.severity}]: ${field(blocker.summary)} Required action: ${field(blocker.required_action)}`).join("\n");
}

function renderHumanQuestions(questions: ReviewerQuestion[]): string {
  if (questions.length === 0) {
    return "- No reviewer questions generated.";
  }
  return questions.map((question) => `- ${field(question.question)} (${question.severity})`).join("\n");
}

function renderHumanSuggestedComments(comments: SuggestedReviewComment[]): string {
  const ready = comments.filter((comment) => comment.ready_to_post).slice(0, MAX_HUMAN_COMMENTS);
  if (ready.length === 0) {
    return "- No ready suggested comments generated.";
  }
  return ready.map((comment) => {
    const location = comment.path ? ` \`${field(comment.path)}\`:` : "";
    return `- ${comment.severity}:${location} ${field(comment.body)}`;
  }).join("\n");
}

function bulletsFromLines(lines: string[], emptyText: string): string {
  if (lines.length === 0) {
    return `- ${emptyText}`;
  }
  return lines.map((line) => `- ${line}`).join("\n");
}

function renderRisks(surface: PrReviewSurfaceModel): string {
  const byId = new Map(surface.narrative?.risk_narratives.slice(0, MAX_RISKS).map((narrative) => [narrative.risk_id, narrative]) ?? []);
  const lines: string[] = [];
  for (const candidate of surface.risks.candidates.slice(0, MAX_RISKS)) {
    const narrative = byId.get(candidate.id);
    lines.push(`${candidate.id} [${candidate.severity}]: ${field(narrative?.text ?? candidate.summary)}`);
  }
  if (surface.risks.candidates.length > MAX_RISKS) {
    lines.push(`... ${surface.risks.candidates.length - MAX_RISKS} more in pr_review_surface.json`);
  }
  return bulletsFromLines(lines, "No PR-specific risks detected.");
}
