import type { EvidenceRef } from "./evidence";
import type { ProviderName } from "./provider";
import type { ReviewSeverity } from "./review";

export const CONVERSATION_ANALYSIS_STATUSES = ["analyzed", "not_assessed", "degraded"] as const;
export type ConversationAnalysisStatus = (typeof CONVERSATION_ANALYSIS_STATUSES)[number];

export const CONVERSATION_ANALYSIS_SECTIONS = [
  "intent",
  "refinements",
  "decisions",
  "constraints",
  "non_goals",
  "rejected_alternatives",
  "claims",
  "validation_claims",
  "known_gaps"
] as const;
export type ConversationAnalysisSection = (typeof CONVERSATION_ANALYSIS_SECTIONS)[number];

/**
 * One interpretation of the conversation, grounded in exact normalized event
 * ids. `event_ids` contains only ids that exist in the prompt event set; an LLM
 * cannot manufacture a conversation citation that survives this boundary.
 */
export interface ConversationAnalysisItem {
  text: string;
  event_ids: string[];
}

export type ConversationAnalysisSections = {
  [Section in ConversationAnalysisSection]: ConversationAnalysisItem[];
};

/** Fresh empty arrays for every persisted conversation-analysis section. */
export function emptyConversationAnalysisSections(): ConversationAnalysisSections {
  const sections = {} as ConversationAnalysisSections;
  for (const section of CONVERSATION_ANALYSIS_SECTIONS) {
    sections[section] = [];
  }
  return sections;
}

export interface ConversationAnalysis {
  status: ConversationAnalysisStatus;
  provider: ProviderName;
  summary: string;
  intent: ConversationAnalysisItem[];
  refinements: ConversationAnalysisItem[];
  decisions: ConversationAnalysisItem[];
  constraints: ConversationAnalysisItem[];
  non_goals: ConversationAnalysisItem[];
  rejected_alternatives: ConversationAnalysisItem[];
  claims: ConversationAnalysisItem[];
  validation_claims: ConversationAnalysisItem[];
  known_gaps: ConversationAnalysisItem[];
  quality_flags: string[];
}

export const REVIEWER_INSIGHT_CATEGORIES = [
  "intent_mismatch",
  "scope_surprise",
  "superseded_decision",
  "validation_gap",
  "test_weakening",
  "unresolved_assumption",
  "intentional_change"
] as const;

export type ReviewerInsightCategory = (typeof REVIEWER_INSIGHT_CATEGORIES)[number];

export const REVIEWER_INSIGHT_EVIDENCE_STATES = [
  "supported",
  "contradicted",
  "unverified"
] as const;

export type ReviewerInsightEvidenceState = (typeof REVIEWER_INSIGHT_EVIDENCE_STATES)[number];

/** Public artifact/rendering cap for conversation-first reviewer insights. */
export const MAX_VISIBLE_CONVERSATION_INSIGHTS = 3;

export interface ReviewerInsight {
  id: string;
  category: ReviewerInsightCategory;
  title: string;
  summary: string;
  why_it_matters: string;
  reviewer_action: string;
  priority: ReviewSeverity;
  evidence_state: ReviewerInsightEvidenceState;
  /** How the evidence state was earned, not merely where the prose came from. */
  basis: "validated_anchors" | "ai_reconciliation";
  conversation_event_ids: string[];
  paths: string[];
  requirement_ids: string[];
  risk_ids: string[];
  command_ids: string[];
  evidence: EvidenceRef[];
}

export interface ConversationReviewResult {
  analysis: ConversationAnalysis;
  insights: ReviewerInsight[];
}

/** Minimal deterministic-risk shape consumed by conversation reconciliation. */
export interface ConversationReviewRiskCandidate {
  id: string;
  rule: string;
  severity: ReviewSeverity;
  summary: string;
  evidence: EvidenceRef[];
}

export interface ConversationReviewRiskModel {
  candidates: ConversationReviewRiskCandidate[];
}

export const NOT_ASSESSED_CONVERSATION_SUMMARIES = {
  missing_log: "No conversation log was supplied; conversation intent was not assessed.",
  missing_review: "No conversation analysis was supplied with this review; conversation intent was not assessed.",
  no_diff: "No changed diff was available; conversation intent was not assessed."
} as const;

export type NotAssessedConversationReason = keyof typeof NOT_ASSESSED_CONVERSATION_SUMMARIES;

/** Build a safe, deterministic fallback from one of the repository-owned reasons. */
export function buildNotAssessedConversationAnalysis(
  provider: ProviderName,
  reason: NotAssessedConversationReason = "missing_log"
): ConversationAnalysis {
  return {
    status: "not_assessed",
    provider,
    summary: NOT_ASSESSED_CONVERSATION_SUMMARIES[reason],
    ...emptyConversationAnalysisSections(),
    quality_flags: ["conversation_log_missing"]
  };
}
