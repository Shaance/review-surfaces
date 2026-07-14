import type { HumanReviewModel, ReviewQueueItem } from "./contract";

// Format-neutral reviewer presentation shared by Markdown, HTML, the GitHub
// sticky, and the interactive walkthrough. Keeping these primitives out of the
// large Markdown renderer prevents a primary surface from depending on an
// unrelated supporting-artifact implementation.
export function decisionLabel(decision: HumanReviewModel["verdict"]["decision"]): string {
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

export function formatQueueLocation(item: ReviewQueueItem): string {
  return item.line_start
    ? `${item.path}:${item.line_start}${item.line_end && item.line_end !== item.line_start ? `-${item.line_end}` : ""}`
    : item.path;
}

export function rankingReasonsAreDefaultOnly(item: ReviewQueueItem): boolean {
  const reasons = item.ranking_reasons ?? [];
  if (reasons.length === 0) return true;
  if (reasons.length > 1) return false;
  return /^ranked by \w+ risk severity (with a precise diff anchor|at file level)$/.test(reasons[0]);
}

// Render-only shortening of a reading-order `why` that merely restates its leg
// header. Unknown prose is preserved verbatim rather than guessed at.
export function collapseReadingOrderWhy(why: string): string {
  if (why === "test — read after the code it covers" || why === "config or docs — read last") {
    return "";
  }
  return why.startsWith("test — ") ? why.slice("test — ".length) : why;
}
