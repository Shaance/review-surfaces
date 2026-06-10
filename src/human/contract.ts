import type { EvidenceRef } from "../evidence/evidence";
import type { ProviderName } from "../llm/provider";
import type { PacketConfidence, PacketSeverity } from "../schema/review-packet-contract";

export const HUMAN_REVIEW_SCHEMA_VERSION = "review-surfaces.human_review.v1" as const;

// review-surfaces.NARRATIVE.1-5: a bounded, plain-language change narrative that
// opens the human surface. Every claim carries a deterministically-validated
// trust state — `verified` when all of its anchors are on the deterministic
// allowlist, `claimed` when an anchor is missing/invalid (DEMOTED and visibly
// marked, never dropped or rendered as fact). It is prose over deterministic
// facts and never alters the merge-readiness verdict.
export const NARRATIVE_CLAIM_TRUST = ["verified", "claimed"] as const;
export type NarrativeClaimTrust = (typeof NARRATIVE_CLAIM_TRUST)[number];

export interface NarrativeClaim {
  id: string;
  text: string;
  trust: NarrativeClaimTrust;
  /** Anchors that were validated against the deterministic allowlist. */
  anchors: EvidenceRef[];
  /** Off-allowlist anchor tokens the claim cited, surfaced rather than hidden. */
  invalid_anchors: string[];
}

export interface ChangeNarrative {
  /** Whether the claims came from the provider or the deterministic fallback. */
  source: "provider" | "fallback";
  provider: ProviderName;
  /** The head SHA the anchor validation ran against. */
  validated_at_head: string;
  claims: NarrativeClaim[];
}

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

export const RISK_LENSES = [
  "api_contract",
  "security_privacy",
  "llm_trust_boundary",
  "test_evidence",
  "reviewer_ux",
  "cache_provenance",
  "custom"
] as const;
export type RiskLens = (typeof RISK_LENSES)[number];

export const REVIEW_ROUTE_PERSONAS = [
  "human_reviewer",
  "maintainer",
  "security",
  "product",
  "agent_continuation"
] as const;
export type ReviewRoutePersona = (typeof REVIEW_ROUTE_PERSONAS)[number];

export const EVIDENCE_CARD_STATUSES = [
  "verified",
  "unchecked",
  "missing_evidence",
  "invalid_evidence",
  "mixed",
  "unknown"
] as const;
export type EvidenceCardStatus = (typeof EVIDENCE_CARD_STATUSES)[number];

export interface HumanReviewBuildConfig {
  max_review_first: number;
  max_suggested_comments: number;
  max_questions: number;
  risk_lenses: Record<RiskLens, boolean>;
  required_manual_checks: HumanReviewRequiredManualCheckConfig[];
  // review-surfaces.NARRATIVE: bounded count of rendered narrative claims
  // (YAML: human_review.narrative.max_claims).
  narrative_max_claims: number;
}

export interface HumanReviewRequiredManualCheckConfig {
  id: string;
  path_patterns: string[];
  prompt: string;
}

export const DEFAULT_HUMAN_REVIEW_BUILD_CONFIG: HumanReviewBuildConfig = {
  max_review_first: 20,
  max_suggested_comments: 10,
  max_questions: 10,
  risk_lenses: {
    api_contract: true,
    security_privacy: true,
    llm_trust_boundary: true,
    test_evidence: true,
    reviewer_ux: true,
    cache_provenance: true,
    custom: true
  },
  required_manual_checks: [],
  narrative_max_claims: 8
};

export interface RiskLensMetadata {
  label: string;
  rank: number;
}

export const RISK_LENS_METADATA: Record<RiskLens, RiskLensMetadata> = {
  security_privacy: {
    label: "Security / privacy lens",
    rank: 0
  },
  llm_trust_boundary: {
    label: "LLM trust-boundary lens",
    rank: 1
  },
  api_contract: {
    label: "API / schema contract lens",
    rank: 2
  },
  test_evidence: {
    label: "Test evidence lens",
    rank: 3
  },
  reviewer_ux: {
    label: "Reviewer UX lens",
    rank: 4
  },
  cache_provenance: {
    label: "Cache / provenance lens",
    rank: 5
  },
  custom: {
    label: "Custom lens",
    rank: 6
  }
};

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
  // Which diff side the anchor path matched (old for a deletion / rename source,
  // new otherwise). Lets the inline excerpt renderer disambiguate a path shared
  // by a new file and a rename source.
  anchor_side?: "old" | "new";
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

export interface RiskLensFinding {
  id: string;
  lens: RiskLens;
  severity: PacketSeverity;
  summary: string;
  reviewer_action: string;
  evidence: EvidenceRef[];
  suggested_tests: TestPlanItem[];
  suggested_comments: SuggestedReviewComment[];
  risk_ids: string[];
  requirement_ids: string[];
  paths: string[];
  confidence: PacketConfidence;
}

export interface IntentMismatchItem {
  id: string;
  summary: string;
  evidence: EvidenceRef[];
  requirement_ids: string[];
  paths: string[];
  confidence: PacketConfidence;
  severity?: PacketSeverity;
}

export interface IntentMismatch {
  expected_by_spec: IntentMismatchItem[];
  observed_in_diff: IntentMismatchItem[];
  possible_mismatches: IntentMismatchItem[];
  possible_overreach: IntentMismatchItem[];
  missing_intent: IntentMismatchItem[];
}

export interface ReviewRouteStep {
  id: string;
  rank: number;
  title: string;
  action: string;
  evidence: EvidenceRef[];
  priority: HumanReviewPriority;
  artifact?: string;
  queue_item_ids: string[];
  risk_lens_ids: string[];
  question_ids: string[];
  test_plan_ids: string[];
  suggested_comment_ids: string[];
}

export interface ReviewRoute {
  id: string;
  persona: ReviewRoutePersona;
  title: string;
  summary: string;
  is_default: boolean;
  is_secondary: boolean;
  steps: ReviewRouteStep[];
}

export type SinceLastReviewCategory = "requirement" | "risk" | "overreach" | "summary";

export interface SinceLastReviewItem {
  id: string;
  category: SinceLastReviewCategory;
  summary: string;
  evidence: EvidenceRef[];
  acai_id?: string;
  previous_status?: string;
  current_status?: string;
  direction?: "improved" | "regressed" | "unchanged";
  path?: string;
  severity?: PacketSeverity;
}

export interface SinceLastReviewCountDelta {
  before: number;
  after: number;
  delta: number;
}

export interface SinceLastReview {
  previous_packet_path?: string;
  unavailable_reason?: string;
  improved: SinceLastReviewItem[];
  regressed: SinceLastReviewItem[];
  new_risks: SinceLastReviewItem[];
  resolved_risks: SinceLastReviewItem[];
  new_overreach: SinceLastReviewItem[];
  resolved_overreach: SinceLastReviewItem[];
  still_open: SinceLastReviewItem[];
  count_deltas: {
    satisfied: SinceLastReviewCountDelta;
    partial: SinceLastReviewCountDelta;
    missing: SinceLastReviewCountDelta;
    unknown: SinceLastReviewCountDelta;
    invalid_evidence: SinceLastReviewCountDelta;
  };
}

export interface EvidenceCard {
  id: string;
  title: string;
  status: EvidenceCardStatus;
  summary: string;
  direct_evidence: EvidenceRef[];
  missing_evidence: EvidenceRef[];
  invalid_evidence: EvidenceRef[];
  why_it_matters: string;
  reviewer_action: string;
  source_ids: string[];
  risk_ids: string[];
  requirement_ids: string[];
  confidence: PacketConfidence;
  priority: HumanReviewPriority;
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
  // review-surfaces.NARRATIVE.1: optional grounded narrative that opens the
  // surface. Optional-but-strict: absent on pre-narrative artifacts, but when
  // present every claim is anchor-validated and trust-marked.
  narrative?: ChangeNarrative;
  review_queue: ReviewQueueItem[];
  blockers: ReviewBlocker[];
  questions: ReviewerQuestion[];
  suggested_comments: SuggestedReviewComment[];
  trust_audit: TrustAudit;
  risk_lens_findings: RiskLensFinding[];
  intent_mismatch: IntentMismatch;
  review_routes: ReviewRoute[];
  since_last_review: SinceLastReview;
  evidence_cards: EvidenceCard[];
  test_plan: TestPlanItem[];
  skim_safe: SkimSafeItem[];
  feedback_effects: FeedbackPolicyEffect[];
  generated_from: {
    packet_path: string;
    pr_surface_path?: string;
    base_ref: string;
    base_sha?: string;
    head_ref: string;
    head_sha: string;
    human_review_config_signature?: string;
  };
}
