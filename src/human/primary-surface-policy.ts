import type { HumanReviewModel, ReviewQueueItem } from "./contract";

export const PRIMARY_SURFACE_LIMIT = 3;

export function partitionPrimary<T>(items: readonly T[]): { primary: T[]; supporting: T[] } {
  return {
    primary: items.slice(0, PRIMARY_SURFACE_LIMIT),
    supporting: items.slice(PRIMARY_SURFACE_LIMIT)
  };
}

/** Queue rows not already represented by the bounded decision projection. */
export function supportingReviewQueue(model: HumanReviewModel): ReviewQueueItem[] {
  const projected = new Set(model.decision_projection?.findings.flatMap((finding) => finding.source_queue_ids) ?? []);
  return model.review_queue.filter((item) => !projected.has(item.id));
}

/** Concrete author work that makes a clarification verdict actionable. */
export function requiredAuthorAction(model: HumanReviewModel): string | undefined {
  if (model.verdict.decision !== "needs_author_clarification") return undefined;
  return model.verdict.reasons.find((reason) => reason.required_action)?.required_action;
}
