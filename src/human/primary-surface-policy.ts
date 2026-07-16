import type { HumanReviewModel } from "./contract";

// This only bounds previews inside the supporting artifact. The GitHub reviewer
// brief renders every admitted approval decision and never uses this limit.
export const SUPPORTING_PREVIEW_LIMIT = 3;

export function partitionSupportingPreview<T>(items: readonly T[]): { preview: T[]; remaining: T[] } {
  return {
    preview: items.slice(0, SUPPORTING_PREVIEW_LIMIT),
    remaining: items.slice(SUPPORTING_PREVIEW_LIMIT)
  };
}

/** Concrete author work that makes a clarification verdict actionable. */
export function requiredAuthorAction(model: HumanReviewModel): string | undefined {
  if (model.verdict.decision !== "needs_author_clarification") return undefined;
  return model.verdict.reasons.find((reason) => reason.required_action)?.required_action;
}
