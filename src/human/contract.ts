import type { EvidenceRef } from "../evidence/evidence";
import type { ProviderName } from "../llm/provider";
import type { SemanticChangeFacts } from "../risks/semantic-diff";
import type { PacketConfidence, PacketSeverity } from "../schema/review-packet-contract";

export type { SemanticChangeFacts };

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
  "supply_chain",
  "architecture",
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
  // review-surfaces.BUDGET.1: review time budget in whole minutes (YAML:
  // human_review.review_budget, e.g. "15m"/"1h"; --budget overrides). null = off.
  review_budget_minutes: number | null;
  // review-surfaces.POLICY.2: content hash of the committed policy, folded into
  // the config signature so a policy change regenerates cached human artifacts.
  policy_signature?: string;
}

export interface HumanReviewRequiredManualCheckConfig {
  id: string;
  path_patterns: string[];
  prompt: string;
}

export const DEFAULT_HUMAN_REVIEW_BUILD_CONFIG: HumanReviewBuildConfig = {
  review_budget_minutes: null,
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
    supply_chain: true,
    architecture: true,
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
  supply_chain: {
    label: "Supply-chain lens",
    rank: 6
  },
  architecture: {
    label: "Architecture lens",
    rank: 7
  },
  custom: {
    label: "Custom lens",
    rank: 8
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
  // review-surfaces.RANKING.2: one plain-language line per item explaining why it
  // ranked where it did (evidence signals — changed tests, transcripts, coverage).
  // Required and non-empty in the strict schema; items with no evidence signal
  // carry the default severity/anchor reason.
  ranking_reasons: string[];
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
  // Which diff side the line anchors to (old for a deleted/rename-source line, new
  // otherwise). Drives the GitHub review-comment side (LEFT/RIGHT) on export; new
  // when omitted.
  side?: "old" | "new";
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
  // review-surfaces.COLD_START.5: in spec_mode "none" the spec-coupled
  // subsections are empty and this one-line honest note renders instead.
  spec_note?: string;
  expected_by_spec: IntentMismatchItem[];
  observed_in_diff: IntentMismatchItem[];
  possible_mismatches: IntentMismatchItem[];
  possible_overreach: IntentMismatchItem[];
  missing_intent: IntentMismatchItem[];
  // review-surfaces.INTENT.7: provider-proposed claimed candidates, rendered
  // DISTINCTLY (they widen what the human is asked to confirm; they never touch
  // coverage or the verdict). Optional so prior artifacts degrade.
  claimed_candidates?: IntentMismatchItem[];
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

// review-surfaces.COVERAGE.3/.4: per-changed-file coverage evidence computed by
// intersecting an ingested lcov report with the changed lines of each hunk.
// status "no_report" is the honest negative — distinct from "uncovered" — and a
// repository is never penalized for not providing coverage.
export interface CoverageEvidenceHunk {
  hunk_header: string;
  changed_lines: number;
  covered_lines: number;
  classification: "covered" | "uncovered" | "partial";
  // review-surfaces.COVERAGE.5: sorted new-side line numbers that are
  // instrumented but not executed, capped with an explicit truncated flag.
  // OPTIONAL in the schema for v1 artifact compatibility (pre-COVERAGE.5
  // sidecars stay valid; absent reads as "no per-line data", never as covered).
  uncovered_lines?: number[];
  uncovered_truncated?: boolean;
  // Executed counterpart so per-line gutters never guess: a line in neither
  // list is not-instrumented (neutral).
  covered_line_numbers?: number[];
}

export interface CoverageEvidenceFile {
  path: string;
  changed_lines: number;
  covered_lines: number;
  classification: "covered" | "uncovered" | "partial";
  // review-surfaces.COVERAGE.3: the per-hunk breakdown the evidence cards cite.
  hunks: CoverageEvidenceHunk[];
}

export interface CoverageEvidence {
  status: "no_report" | "report";
  source_path?: string;
  // False when the report predates the head commit (stale, not trusted).
  postdates_head?: boolean;
  files: CoverageEvidenceFile[];
}

// review-surfaces.BUDGET.2: the explicit read/skim/defer cut under a time
// budget. enabled=false (the default) renders nothing.
export interface ReviewPlanItem {
  queue_item_id: string;
  path: string;
  estimated_minutes: number;
  reason?: string;
}

export interface ReviewPlan {
  enabled: boolean;
  budget_minutes?: number;
  read: ReviewPlanItem[];
  skim: ReviewPlanItem[];
  defer: ReviewPlanItem[];
}

// review-surfaces.CHANGE_MAP.1: the change-graph model — changed files as
// nodes (churn, dominant lens, status), a dashed halo of top unchanged
// importers from blast-radius facts, import edges among changed files, and
// top-level-directory clusters. Built from buildImportGraph() output restricted
// to changed files; every list sorted so renders are byte-deterministic. The
// edge `kind` slot ships existing-only; ARCH_DRIFT.2 fills new/removed later.
export type ChangeGraphNodeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangeGraphNode {
  path: string;
  // Rename source path, so renderers can match old-side-anchored queue items.
  old_path?: string;
  churn_added: number;
  churn_removed: number;
  status: ChangeGraphNodeStatus;
  cluster: string;
  // Dominant risk lens for the file (highest-ranked lens finding citing it).
  lens?: RiskLens;
}

export interface ChangeGraphHaloNode {
  // Unchanged importer taken from a blast-radius fact's bounded used_by.top
  // list (at most two per high-blast node, alphabetical as the fact stores them).
  path: string;
  // The changed files this importer depends on — the citing facts.
  imports: string[];
}

export type ChangeGraphEdgeKind = "existing" | "new" | "removed";

export interface ChangeGraphEdge {
  // Importer -> imported, per CHANGE_MAP.1. Renderers that want dependencies
  // flowing left-to-right (to agree with the tour) reverse at draw time.
  from: string;
  to: string;
  kind: ChangeGraphEdgeKind;
}

export interface ChangeGraphCluster {
  name: string;
  paths: string[];
}

export interface ChangeGraph {
  nodes: ChangeGraphNode[];
  halo_nodes: ChangeGraphHaloNode[];
  edges: ChangeGraphEdge[];
  // Cluster array order is the render order (first appearance in the tour).
  clusters: ChangeGraphCluster[];
}

// review-surfaces.READING_ORDER.1: the guided diff tour — changed files
// topologically sorted dependencies-first, strongly connected components
// collapsed into one read-together leg (alphabetical inside), each step with a
// derived why line and review-queue cross-links. Never includes unchanged files.
export interface ReadingOrderStep {
  path: string;
  why: string;
  queue_refs: string[];
}

export interface ReadingOrderLeg {
  title: string;
  // True for a collapsed import cycle: the leg's files should be read together.
  read_together: boolean;
  steps: ReadingOrderStep[];
}

export interface ReadingOrder {
  legs: ReadingOrderLeg[];
}

// review-surfaces.TREND.1: one row per review round, carried forward with the
// prior packet (CI artifact or local prior-packet directory — the comparison
// engine is transport-indifferent). Identity stays on stable finding keys via
// the compare output; partial history is NORMAL (artifact expiry), never an
// error. Optional in the schema for pre-TREND v1 artifacts; always emitted.
export interface RoundsLedgerEntry {
  round: number;
  head_sha: string;
  new_count: number;
  resolved_count: number;
  regressed_count: number;
  verdict: HumanReviewDecision;
}

// review-surfaces.DEP_FACTS.4 / RENDER.13: an attributed dependency chain —
// the direct dependency and the new transitives it pulled (install-script
// flags marked). Only built when the lockfile's edges resolved; otherwise the
// flat transitive facts remain the honest output.
export interface DependencyChain {
  via: string;
  source_path: string;
  transitives: Array<{ package: string; install_scripts: boolean }>;
}

// review-surfaces.EVAL_HARNESS.6: the eval scoreboard summary surfaced on the
// cockpit footer (and the generated README block). Optional: absent when no
// eval_scoreboard.json exists in the output directory.
export interface EvalScoreboardSummary {
  top_n: number;
  classes: Array<{ name: string; passed: number; total: number }>;
}

export interface HumanReviewModel {
  schema_version: typeof HUMAN_REVIEW_SCHEMA_VERSION;
  mode: "pr" | "repo";
  // review-surfaces.COLD_START.4: "none" when zero Acai spec requirements were
  // indexed — derived from the packet intent, never from renderer guesswork, so
  // every surface inherits the spec-less suppressions (COLD_START.5).
  spec_mode: "acai" | "none";
  verdict: HumanReviewVerdict;
  summary: string;
  // review-surfaces.NARRATIVE.1: grounded narrative that opens the surface. Always
  // emitted (provider-built or the deterministic fallback) and required by the
  // schema, so a stale artifact lacking it fails validation and is rebuilt rather
  // than rendering an empty section (SCHEMA.3 strictness for new fields).
  narrative: ChangeNarrative;
  // review-surfaces.SEMANTIC_DIFF.1-4: deterministic facts about what the change
  // means (schema contract changes, exported API surface changes, test-weakening
  // signals). Always present (empty when nothing applies).
  semantic_facts: SemanticChangeFacts;
  review_queue: ReviewQueueItem[];
  blockers: ReviewBlocker[];
  questions: ReviewerQuestion[];
  suggested_comments: SuggestedReviewComment[];
  trust_audit: TrustAudit;
  risk_lens_findings: RiskLensFinding[];
  intent_mismatch: IntentMismatch;
  review_routes: ReviewRoute[];
  since_last_review: SinceLastReview;
  coverage_evidence: CoverageEvidence;
  review_plan: ReviewPlan;
  // review-surfaces.CHANGE_MAP.1 / READING_ORDER.1: required (SCHEMA.3
  // strictness) — empty graphs/tours render as empty sections, never absent.
  change_graph: ChangeGraph;
  reading_order: ReadingOrder;
  // review-surfaces.TREND.1: the full rounds ledger (renderers cap the table;
  // the artifact keeps every row). Optional for pre-TREND v1 artifacts.
  rounds?: RoundsLedgerEntry[];
  // review-surfaces.DEP_FACTS.4 / RENDER.13: attributed dependency chains.
  // Optional: present only when lockfile edges resolved and chains exist.
  dependency_chains?: DependencyChain[];
  // review-surfaces.EVAL_HARNESS.6: scoreboard summary for the cockpit footer.
  eval_scoreboard?: EvalScoreboardSummary;
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
