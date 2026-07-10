import { compareStrings } from "../core/compare";
import {
  MAX_VISIBLE_CONVERSATION_INSIGHTS,
  type ReviewerInsight,
  type ReviewerInsightEvidenceState
} from "../contracts/conversation-review";
import { reviewSeverityRank } from "../contracts/review";
import type { GroundedConversationReviewInsight } from "./review-candidate-grounding";

export function rankDedupeAndCapConversationReviewInsights(
  values: GroundedConversationReviewInsight[]
): ReviewerInsight[] {
  const sorted = [...values].sort((left, right) =>
    evidenceStateRank(left.evidence_state) - evidenceStateRank(right.evidence_state) ||
    reviewSeverityRank(left.priority) - reviewSeverityRank(right.priority) ||
    compareStrings(left.title, right.title)
  );
  const kept: GroundedConversationReviewInsight[] = [];
  for (const candidate of sorted) {
    if (kept.some((existing) => sameRootCause(existing, candidate))) {
      continue;
    }
    kept.push(candidate);
    if (kept.length >= MAX_VISIBLE_CONVERSATION_INSIGHTS) {
      break;
    }
  }
  return kept.map(({ rootCauseKey: _rootCauseKey, ...insight }, index) => ({
    ...insight,
    id: `CONV-INSIGHT-${String(index + 1).padStart(3, "0")}`
  }));
}

function sameRootCause(
  left: GroundedConversationReviewInsight,
  right: GroundedConversationReviewInsight
): boolean {
  if (left.rootCauseKey && left.rootCauseKey === right.rootCauseKey) {
    return true;
  }
  if (left.category !== right.category) {
    return false;
  }
  const leftPaths = new Set(left.paths);
  const overlap = right.paths.filter((path) => leftPaths.has(path)).length;
  return overlap > 0 && overlap >= Math.ceil(Math.min(left.paths.length, right.paths.length) / 2);
}

function evidenceStateRank(value: ReviewerInsightEvidenceState): number {
  return { contradicted: 0, unverified: 1, supported: 2 }[value];
}
