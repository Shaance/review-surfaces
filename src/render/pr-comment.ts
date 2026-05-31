import { redactSecrets } from "../privacy/secrets";
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

function renderDiagram(diagram: PrChangeDiagramModel | undefined): string[] {
  if (!diagram || diagram.status !== "valid") {
    return [];
  }
  const body = redact(diagram.body);
  // Omit (never embed) a body that would close the mermaid fence; keep it inside
  // the code fence (verbatim) so arrows render.
  if (/^\s*```/m.test(body) || body.length > 8000) {
    return [];
  }
  return ["", "### Change impact", "<details><summary>Change impact diagram</summary>", "", "```mermaid", body, "```", "", "</details>"];
}

function clampTotal(markdown: string): string {
  if (markdown.length <= MAX_COMMENT_CHARS) {
    return markdown;
  }
  const trailer = "\n\n... truncated; see `.review-surfaces/pr_review_surface.json` for the full surface.\n";
  return `${markdown.slice(0, MAX_COMMENT_CHARS - trailer.length)}${trailer}`;
}

/**
 * Render the PR-mode sticky comment from a PrReviewSurfaceModel. Deterministic
 * given the surface. A blocked surface renders an explanation, not the generic
 * whole-repo comment.
 */
export function renderPrComment(surface: PrReviewSurfaceModel): string {
  const providerLabel = surface.llm.model ? `${surface.llm.provider}/${surface.llm.model}` : surface.llm.provider;

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
        `Deterministic scope: ${surface.scope.changed_files.length} changed file(s), ${surface.scope.affected_requirements.length} affected requirement(s), ${surface.risks.candidates.length} PR risk(s). See \`.review-surfaces/pr_review_surface.json\`.`,
        ""
      ].join("\n") + "\n"
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
    bullets(narrative.what_changed, "No change narrative."),
    "",
    "### Why it matters",
    bullets(narrative.why_it_matters, "No impact narrative."),
    "",
    "### Review first",
    bullets(narrative.review_first, "No ordered review plan."),
    "",
    "### Affected coverage",
    surface.coverage.base_available
      ? `${surface.coverage.in_scope_count} in scope — improved ${surface.coverage.counts.improved} | regressed ${surface.coverage.counts.regressed} | unchanged ${surface.coverage.counts.unchanged} | new ${surface.coverage.counts.new_requirement}`
      : `${surface.coverage.in_scope_count} requirement(s) in scope (baseline unavailable; current status only)`,
    bulletsFromLines(coverageLines(surface.coverage.deltas, surface.coverage.base_available), "No affected requirements."),
    "",
    "### PR risks",
    renderRisks(surface),
    ...renderDiagram(surface.diagram),
    "",
    "Full PR surface: `.review-surfaces/pr_review_surface.json`."
  );

  return clampTotal(`${sections.join("\n")}\n`);
}

function bulletsFromLines(lines: string[], emptyText: string): string {
  if (lines.length === 0) {
    return `- ${emptyText}`;
  }
  return lines.map((line) => `- ${line}`).join("\n");
}

function renderRisks(surface: PrReviewSurfaceModel): string {
  const byId = new Map(surface.narrative?.risk_narratives.map((narrative) => [narrative.risk_id, narrative]) ?? []);
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
