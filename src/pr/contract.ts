import { EvidenceRef } from "../evidence/evidence";
import { ProviderName } from "../llm/provider";
import { PacketRequirementStatus, PacketRiskCategory, PacketSeverity } from "../schema/review-packet-contract";

// ---------------------------------------------------------------------------
// PR review surface contract (review-surfaces.pr_surface.v1).
//
// A SEPARATE, diff-scoped model that lives alongside (not inside) the whole-repo
// evaluation/risks/architecture sections. The PR sticky comment renders from
// THIS model in `--review-scope pr` mode; the legacy whole-repo comment renders
// from the full packet in `--review-scope repo` mode. Deterministic facts (scope,
// coverage delta, risk candidates, change diagram) are byte-stable; the LLM only
// authors the `narrative` from those facts and may cite only the allowlists.
// ---------------------------------------------------------------------------

export const PR_SURFACE_SCHEMA_VERSION = "review-surfaces.pr_surface.v1" as const;

export const REVIEW_SCOPES = ["pr", "repo"] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

export const PR_SURFACE_STATUSES = ["ready", "blocked"] as const;
export type PrSurfaceStatus = (typeof PR_SURFACE_STATUSES)[number];

export const PR_SURFACE_BLOCKED_REASONS = [
  "llm_unavailable",
  "privacy_block",
  "baseline_unavailable",
  "no_diff",
  "invalid_llm_output"
] as const;
export type PrSurfaceBlockedReason = (typeof PR_SURFACE_BLOCKED_REASONS)[number];

// --- Structured diff -------------------------------------------------------

export type DiffLineKind = "add" | "delete" | "context";

export interface StructuredDiffLine {
  kind: DiffLineKind;
  text: string;
  old_line?: number;
  new_line?: number;
}

export interface StructuredDiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: StructuredDiffLine[];
}

export interface StructuredDiffFile {
  path: string;
  old_path?: string;
  status: string;
  hunks: StructuredDiffHunk[];
}

export interface StructuredDiff {
  files: StructuredDiffFile[];
}

// --- Scope -----------------------------------------------------------------

export const CHANGED_FILE_ROLES = [
  "implementation",
  "test",
  "spec",
  "doc",
  "config",
  "ci",
  "generated",
  "unknown"
] as const;
export type ChangedFileRole = (typeof CHANGED_FILE_ROLES)[number];

export interface ScopedChangedFile {
  path: string;
  old_path?: string;
  status: string;
  areas: string[];
  role: ChangedFileRole;
  added_lines?: number;
  deleted_lines?: number;
}

// Ordered by confidence (high deterministic first). `llm_candidate_mapping_validated`
// is low-confidence: it only surfaces in a clearly-labeled "possible related" appendix.
export const PR_SCOPE_RULES = [
  "exact_acid_in_diff",
  "spec_block_changed",
  "changed_test_exact_acid",
  "changed_path_requirement_group",
  "changed_test_group",
  "llm_candidate_mapping_validated"
] as const;
export type PrScopeRule = (typeof PR_SCOPE_RULES)[number];

export type PrScopeConfidence = "high" | "medium" | "low";

export interface PrScopeReason {
  rule: PrScopeRule;
  confidence: PrScopeConfidence;
  path?: string;
  line_start?: number;
  line_end?: number;
  note?: string;
}

export interface PrAffectedArea {
  group_key: string;
  area_ids: string[];
  name: string;
  changed_files: string[];
}

export interface PrAffectedRequirement {
  requirement_id: string;
  acai_id?: string;
  title?: string;
  group_key?: string;
  reasons: PrScopeReason[];
}

export interface PrOutOfScopeChangedFile {
  path: string;
  status: string;
  reason: "unmapped" | "ignored" | "generated";
}

export interface PrScopeModel {
  base_ref: string;
  head_ref: string;
  base_sha?: string;
  head_sha: string;
  diff_source: "range" | "working_tree_fallback";
  changed_files: ScopedChangedFile[];
  affected_areas: PrAffectedArea[];
  affected_requirements: PrAffectedRequirement[];
  out_of_scope_changed_files: PrOutOfScopeChangedFile[];
}

// --- Coverage delta --------------------------------------------------------

export type ScopedStatus = PacketRequirementStatus | "absent";

export const PR_COVERAGE_DELTAS = [
  "new_requirement",
  "removed_requirement",
  "improved",
  "regressed",
  "unchanged",
  "newly_in_scope"
] as const;
export type PrCoverageDelta = (typeof PR_COVERAGE_DELTAS)[number];

export interface PrRequirementCoverageDelta {
  requirement_id: string;
  acai_id?: string;
  title?: string;
  base_status: ScopedStatus;
  head_status: ScopedStatus;
  delta: PrCoverageDelta;
  reasons: string[];
  head_evidence: EvidenceRef[];
  missing_evidence: EvidenceRef[];
}

export interface PrScopedCoverageModel {
  base_available: boolean;
  summary: string;
  in_scope_count: number;
  deltas: PrRequirementCoverageDelta[];
  counts: {
    improved: number;
    regressed: number;
    unchanged: number;
    new_requirement: number;
    removed_requirement: number;
    newly_in_scope: number;
  };
}

// --- PR risks --------------------------------------------------------------

export const PR_RISK_RULES = [
  "coverage_regression",
  "untested_changed_impl",
  "unmapped_change",
  "privacy_sensitive_change",
  "comment_surface_change",
  "ci_secret_boundary_change",
  "schema_contract_change",
  "deleted_or_renamed_surface",
  "failed_or_skipped_test",
  "large_diff"
] as const;
export type PrRiskRule = (typeof PR_RISK_RULES)[number];

export interface PrRiskCandidate {
  id: string; // PR-RISK-001
  rule: PrRiskRule;
  category: PacketRiskCategory;
  severity: PacketSeverity;
  summary: string;
  evidence: EvidenceRef[];
  suggested_checks: string[];
}

export interface PrRiskModel {
  summary: string;
  candidates: PrRiskCandidate[];
}

// --- PR change diagram -----------------------------------------------------

export interface PrChangeDiagramModel {
  path: string; // diagrams/pr-change-impact.mmd
  status: "valid" | "invalid";
  body: string;
  warnings: string[];
}

// --- LLM narrative ---------------------------------------------------------

export interface AnchoredNarrativeItem {
  text: string;
  paths?: string[];
  requirement_ids?: string[];
  risk_ids?: string[];
}

export interface AnchoredRiskNarrative {
  risk_id: string;
  text: string;
  suggested_checks?: string[];
}

export interface PrNarrativeModel {
  summary: string;
  what_changed: AnchoredNarrativeItem[];
  why_it_matters: AnchoredNarrativeItem[];
  review_first: AnchoredNarrativeItem[];
  risk_narratives: AnchoredRiskNarrative[];
  diagram_caption?: string;
}

export interface PrNarrativeLlmMeta {
  required: true;
  provider: ProviderName;
  model?: string;
  status: "applied" | "blocked" | "failed";
  prompt_hash?: string;
  output_hash?: string;
  validation_errors?: string[];
}

// --- Top-level PR review surface -------------------------------------------

export interface PrReviewSurfaceModel {
  schema_version: typeof PR_SURFACE_SCHEMA_VERSION;
  mode: "pr";
  status: PrSurfaceStatus;
  blocked_reason?: PrSurfaceBlockedReason;
  scope: PrScopeModel;
  coverage: PrScopedCoverageModel;
  risks: PrRiskModel;
  diagram?: PrChangeDiagramModel;
  narrative?: PrNarrativeModel;
  llm: PrNarrativeLlmMeta;
}
