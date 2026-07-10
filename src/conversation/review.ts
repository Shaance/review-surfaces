import { uniqueTruthy } from "../core/guards";
import { analyzeConversation, type ConversationAnalysis } from "./analysis";
import { CONVERSATION_REVIEW_INSIGHT_SCHEMA } from "./review-candidate-contract";
import {
  type ConversationReviewResult
} from "./review-contract";
import {
  buildConversationReviewDiffContext,
  buildConversationReviewEvidenceContext,
  buildConversationReviewPrompt,
  conversationReviewContextQualityFlags,
  type BuildConversationReviewInput
} from "./review-evidence-context";
import {
  isStrictConversationReviewInsightEnvelope,
  rankDedupeAndCapConversationReviewInsights,
  validateConversationReviewCandidates
} from "./review-candidate-reconciliation";

export {
  MAX_VISIBLE_CONVERSATION_INSIGHTS,
  REVIEWER_INSIGHT_CATEGORIES,
  REVIEWER_INSIGHT_EVIDENCE_STATES
} from "./review-contract";
export type {
  ConversationReviewResult,
  ReviewerInsight,
  ReviewerInsightCategory,
  ReviewerInsightEvidenceState
} from "./review-contract";
export type { BuildConversationReviewInput } from "./review-evidence-context";

/**
 * Two-pass conversation review: first reconstruct what the conversation meant,
 * then reconcile that model against diff-scoped, deterministic facts. The
 * result is read-only reviewer guidance and cannot alter verdicts or blockers.
 */
export async function buildConversationReview(
  input: BuildConversationReviewInput
): Promise<ConversationReviewResult> {
  const analysis = await analyzeConversation({
    provider: input.provider,
    providerName: input.providerName,
    events: input.events,
    redactSecrets: input.redactSecrets,
    remotePrivacyBlocked: input.remotePrivacyBlocked
  });

  if (analysis.status !== "analyzed") {
    return { analysis, insights: [] };
  }
  if (!input.diff || input.diff.files.length === 0) {
    return {
      analysis: withQualityFlag(analysis, "conversation_review_no_diff"),
      insights: []
    };
  }

  const diffContext = buildConversationReviewDiffContext(input.diff);
  const promptEvidence = buildConversationReviewEvidenceContext(input, analysis, diffContext);
  const result = await input.provider.generateStructured(
    "conversation_review_insights",
    buildConversationReviewPrompt(input, analysis, promptEvidence),
    CONVERSATION_REVIEW_INSIGHT_SCHEMA,
    {
      redactSecrets: input.redactSecrets ?? true,
      remotePrivacyBlocked: input.remotePrivacyBlocked === true || promptEvidence.blocked
    }
  );

  if (!result.ok) {
    return {
      analysis: withQualityFlags(analysis, [
        "conversation_review_unavailable",
        ...conversationReviewContextQualityFlags(promptEvidence)
      ]),
      insights: []
    };
  }
  if (!isStrictConversationReviewInsightEnvelope(result.data)) {
    return {
      analysis: withQualityFlags(analysis, [
        "conversation_review_invalid_payload",
        ...conversationReviewContextQualityFlags(promptEvidence)
      ]),
      insights: []
    };
  }

  const validated = validateConversationReviewCandidates(
    result.data.insights,
    promptEvidence,
    analysis,
    input.headSha
  );
  const insights = rankDedupeAndCapConversationReviewInsights(validated.insights);
  const suppliedCandidateCount = result.data.insights.length;
  return {
    analysis: withQualityFlags(analysis, [
      ...conversationReviewContextQualityFlags(promptEvidence),
      ...(validated.rejectedCitations > 0 ? ["conversation_review_citations_rejected"] : []),
      ...(validated.invalidCandidates > 0 ? ["conversation_review_candidates_rejected"] : []),
      ...(suppliedCandidateCount > 0 && validated.invalidCandidates === suppliedCandidateCount
        ? ["conversation_review_invalid_payload"]
        : []),
      ...(validated.outputRedacted
        ? ["conversation_review_output_redacted"]
        : [])
    ]),
    insights
  };
}

function withQualityFlag(analysis: ConversationAnalysis, flag: string): ConversationAnalysis {
  return withQualityFlags(analysis, [flag]);
}

function withQualityFlags(analysis: ConversationAnalysis, flags: string[]): ConversationAnalysis {
  return {
    ...analysis,
    quality_flags: uniqueTruthy([...analysis.quality_flags, ...flags])
  };
}
