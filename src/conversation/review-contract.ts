import type { EvidenceRef } from "../evidence/evidence";
import type { PacketSeverity } from "../schema/review-packet-contract";
import type { ConversationAnalysis } from "./analysis";

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
  priority: PacketSeverity;
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
