import type { DecisionIntentSource, DecisionSupportingDetailCounts } from "./contract";

export const STALE_DECISION_PROJECTION_TEXT = "This pre-M2 artifact has no decision projection; regenerate it before review.";
export const UNAVAILABLE_DECISION_FINDINGS_TEXT = "Decision findings unavailable in this stale artifact.";
export const EMPTY_DECISION_FINDINGS_TEXT = "No approval-changing findings were admitted for this reviewed range.";

export function decisionIntentSourceLabel(source: DecisionIntentSource): string {
  switch (source) {
    case "conversation_advisory": return "advisory conversation interpretation";
    case "affected_requirements": return "affected authoritative requirements";
    case "packet": return "packet intent";
  }
}

export function fullDecisionSupportingText(counts: DecisionSupportingDetailCounts): string {
  return `${counts.projected_queue_items} of ${counts.total_queue_items} queue item(s) contribute to the decision findings; ${counts.supporting_queue_items} remain supporting detail. ${counts.affected_requirement_count} affected and ${counts.supporting_requirement_count} supporting requirement(s).`;
}

export function compactDecisionSupportingText(counts: DecisionSupportingDetailCounts): string {
  return `${counts.supporting_queue_items} queue and ${counts.supporting_requirement_count} requirement item(s) remain supporting detail.`;
}

export function incompleteReviewScopeText(omittedCount: number): string | undefined {
  return omittedCount > 0
    ? `Review scope incomplete: ${omittedCount} untracked file(s) exceeded the collection budget and were omitted.`
    : undefined;
}
