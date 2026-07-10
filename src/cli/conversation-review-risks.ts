import type { ConversationReviewRiskModel } from "../contracts/conversation-review";
import { isHypothesisOnly } from "../evidence/evidence";
import type { RisksModel } from "../risks/risks";

/**
 * Adapt whole-repo packet risks at the orchestration boundary. AI-authored
 * hypotheses stay quarantined: they cannot corroborate another AI conclusion.
 */
export function conversationReviewRisksFromPacket(
  risks: RisksModel
): ConversationReviewRiskModel {
  return {
    candidates: risks.items
      .filter((risk) => !isHypothesisOnly(risk.evidence))
      .map((risk) => ({
        id: risk.id,
        rule: `packet:${risk.category}`,
        severity: risk.severity,
        summary: risk.summary,
        evidence: risk.evidence ?? []
      }))
  };
}
