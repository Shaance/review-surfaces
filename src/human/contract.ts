import type { EvidenceRef } from "../evidence/evidence";
import type { PacketConfidence, PacketSeverity } from "../schema/review-packet-contract";

export const HUMAN_REVIEW_SCHEMA_VERSION = "review-surfaces.human_review.v1" as const;

export const HUMAN_REVIEW_DECISIONS = [
  "probably_safe",
  "reviewable_with_attention",
  "needs_author_clarification",
  "block_before_merge",
  "no_signal"
] as const;
export type HumanReviewDecision = (typeof HUMAN_REVIEW_DECISIONS)[number];

export const HUMAN_REVIEW_PRIORITIES = ["blocker", "high", "medium", "low"] as const;
export type HumanReviewPriority = (typeof HUMAN_REVIEW_PRIORITIES)[number];

export const REVIEWER_QUESTION_SEVERITIES = ["blocking", "clarifying", "optional"] as const;
export type ReviewerQuestionSeverity = (typeof REVIEWER_QUESTION_SEVERITIES)[number];

export const SUGGESTED_COMMENT_SEVERITIES = ["blocking", "clarifying", "non_blocking"] as const;
export type SuggestedCommentSeverity = (typeof SUGGESTED_COMMENT_SEVERITIES)[number];

export const FEEDBACK_POLICY_EFFECT_KINDS = ["false_positive", "false_negative", "team_policy", "reviewer_preference"] as const;
export type FeedbackPolicyEffectKind = (typeof FEEDBACK_POLICY_EFFECT_KINDS)[number];

export interface HumanReviewVerdictReason {
  id: string;
  severity: PacketSeverity;
  summary: string;
  evidence: EvidenceRef[];
  required_action?: string;
}

export interface HumanReviewVerdict {
  decision: HumanReviewDecision;
  confidence: PacketConfidence;
  reasons: HumanReviewVerdictReason[];
}

export interface ReviewQueueItem {
  id: string;
  rank: number;
  title: string;
  path: string;
  old_path?: string;
  hunk_header?: string;
  line_start?: number;
  line_end?: number;
  reviewer_action: string;
  reason: string;
  evidence: EvidenceRef[];
  requirement_ids: string[];
  risk_ids: string[];
  confidence: PacketConfidence;
  priority: HumanReviewPriority;
  estimated_review_effort?: "quick" | "moderate" | "deep";
}

export interface ReviewBlocker {
  id: string;
  severity: PacketSeverity;
  summary: string;
  evidence: EvidenceRef[];
  required_action: string;
}

export interface ReviewerQuestion {
  id: string;
  severity: ReviewerQuestionSeverity;
  question: string;
  reason: string;
  evidence: EvidenceRef[];
  maps_to_risks: string[];
  maps_to_requirements: string[];
}

export interface SuggestedReviewComment {
  id: string;
  severity: SuggestedCommentSeverity;
  path?: string;
  line_start?: number;
  line_end?: number;
  body: string;
  evidence: EvidenceRef[];
  risk_ids: string[];
  requirement_ids: string[];
  confidence: PacketConfidence;
  ready_to_post: boolean;
}

export interface TrustFact {
  id: string;
  summary: string;
  evidence: EvidenceRef[];
}

export interface TrustClaim {
  id: string;
  claim: string;
  status: "unverified";
  missing_evidence: string;
  evidence: EvidenceRef[];
}

export interface MissingEvidenceSummary {
  id: string;
  summary: string;
  evidence: EvidenceRef[];
}

export interface InvalidEvidenceSummary {
  id: string;
  summary: string;
  evidence: EvidenceRef[];
}

export interface TrustAudit {
  verified_facts: TrustFact[];
  claimed_not_verified: TrustClaim[];
  missing_evidence: MissingEvidenceSummary[];
  invalid_evidence: InvalidEvidenceSummary[];
  confidence_summary: string;
}

export interface TestPlanItem {
  id: string;
  kind: "automatic" | "manual";
  priority: "required" | "recommended" | "optional";
  suggested_file?: string;
  scenario: string;
  expected_result: string;
  command?: string;
  maps_to_requirements: string[];
  maps_to_risks: string[];
  evidence_gap: string;
}

export interface SkimSafeItem {
  path: string;
  reason: string;
  caveat?: string;
  evidence: EvidenceRef[];
  confidence: PacketConfidence;
}

export interface FeedbackPolicyEffect {
  id: string;
  kind: FeedbackPolicyEffectKind;
  summary: string;
  action: string;
  evidence: EvidenceRef[];
  paths: string[];
  risk_ids: string[];
  confidence: PacketConfidence;
}

export interface HumanReviewModel {
  schema_version: typeof HUMAN_REVIEW_SCHEMA_VERSION;
  mode: "pr" | "repo";
  verdict: HumanReviewVerdict;
  summary: string;
  review_queue: ReviewQueueItem[];
  blockers: ReviewBlocker[];
  questions: ReviewerQuestion[];
  suggested_comments: SuggestedReviewComment[];
  trust_audit: TrustAudit;
  test_plan: TestPlanItem[];
  skim_safe: SkimSafeItem[];
  feedback_effects: FeedbackPolicyEffect[];
  generated_from: {
    packet_path: string;
    pr_surface_path?: string;
    base_ref: string;
    head_ref: string;
    head_sha: string;
  };
}
