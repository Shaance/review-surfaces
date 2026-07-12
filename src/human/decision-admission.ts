import type { EvidenceRef } from "../contracts/evidence";
import type { PrReviewSurfaceModel, PrRiskCandidate, StructuredDiff } from "../contracts/pr-review";
import type { ReviewPacket } from "../render/packet";
import { isExplicitContractSurfacePath, isPersistedSchemaPath } from "../risks/contract-surface";
import { isBreakingApiChange, type ApiSurfaceChange } from "../risks/semantic-diff";
import { classifyValidationRunState, type ValidationRunState } from "../risks/validation-state";
import { affectedRequirementKeysForRange } from "./intent-scope";

export interface DecisionScope {
  mode: "pr" | "repo";
  changed_paths: ReadonlySet<string>;
  affected_requirement_ids: ReadonlySet<string>;
  head_sha: string;
  working_tree_dirty: boolean;
}

export function isDecisionRelevantApiChange(change: ApiSurfaceChange): boolean {
  return isBreakingApiChange(change) && (
    isExplicitContractSurfacePath(change.path) || (change.used_by?.count ?? 0) > 0
  );
}

export function buildDecisionScope(input: {
  packet: ReviewPacket;
  prSurface?: PrReviewSurfaceModel;
  diff?: StructuredDiff;
}): DecisionScope {
  const changedPaths = new Set<string>();
  const scopedFiles = input.prSurface?.scope.changed_files ?? input.diff?.files ?? [];
  for (const file of scopedFiles) {
    changedPaths.add(file.path);
    if (file.old_path) changedPaths.add(file.old_path);
  }
  const affected = new Set<string>();
  for (const requirement of input.prSurface?.scope.affected_requirements ?? []) {
    affected.add(requirement.requirement_id);
    if (requirement.acai_id) affected.add(requirement.acai_id);
  }
  if (!input.prSurface) {
    for (const key of affectedRequirementKeysForRange(input.packet.intent, input.diff)) affected.add(key);
  }
  return {
    mode: input.prSurface ? "pr" : "repo",
    changed_paths: changedPaths,
    affected_requirement_ids: affected,
    head_sha: input.prSurface?.scope.head_sha ?? String(input.packet.manifest.head_sha ?? ""),
    working_tree_dirty: Number(input.packet.manifest.uncommitted_files ?? 0) > 0 ||
      Number(input.packet.manifest.omitted_untracked_files ?? 0) > 0
  };
}

export function isDecisionScopedSignal(
  scope: DecisionScope,
  evidence: readonly EvidenceRef[],
  requirementIds: readonly string[] = []
): boolean {
  if (requirementIds.some((id) => scope.affected_requirement_ids.has(id))) return true;
  return evidence.some((ref) => isDecisionScopedEvidenceRef(scope, ref));
}

export function isDecisionScopedEvidenceRef(scope: DecisionScope, ref: EvidenceRef): boolean {
  if (ref.kind === "command" || ref.kind === "feedback" || (ref.kind === "test" && !ref.path)) {
    return isCurrentValidationEvidence(scope, ref);
  }
  if (ref.acai_id !== undefined && scope.affected_requirement_ids.has(ref.acai_id)) return true;
  return ref.path !== undefined && scope.changed_paths.has(ref.path);
}

export function isCurrentValidationEvidence(scope: DecisionScope, ref: EvidenceRef): boolean {
  const validationKind = ref.kind === "command" || ref.kind === "feedback" || ref.kind === "test";
  return validationKind && !scope.working_tree_dirty && ref.sha === scope.head_sha;
}

export function currentValidationRunState(
  scope: DecisionScope,
  item: { kind: ReviewPacket["risks"]["test_evidence"][number]["kind"]; summary: string; evidence?: EvidenceRef[] }
): { state: ValidationRunState; evidence: EvidenceRef[] } {
  const allEvidence = item.evidence ?? [];
  const evidence = allEvidence.filter((ref) => isCurrentValidationEvidence(scope, ref));
  if (evidence.length === 0) return { state: "unknown", evidence };
  const summary = evidence.length === allEvidence.length ? item.summary : "";
  return { state: classifyValidationRunState({ ...item, summary, evidence }), evidence };
}

export function decisionRootForRisk(rule: PrRiskCandidate["rule"], path?: string): string | undefined {
  const suffix = path ? `:${path}` : "";
  switch (rule) {
    case "schema_contract_change": return path && isExplicitContractSurfacePath(path) ? `persisted_contract${suffix}` : undefined;
    case "deleted_or_renamed_surface": return path && isExplicitContractSurfacePath(path)
      ? `${isPersistedSchemaPath(path) ? "persisted_contract" : "public_contract"}${suffix}`
      : undefined;
    case "failed_or_skipped_test": return "test_integrity";
    case "secret_in_diff":
    case "privacy_sensitive_change":
    case "ci_secret_boundary_change": return `secret_boundary${suffix}`;
    case "coverage_regression":
    case "untested_changed_impl": return `test_coverage${suffix}`;
    case "comment_surface_change": return `review_surface${suffix}`;
    case "large_diff":
    case "unmapped_change": return undefined;
  }
}
