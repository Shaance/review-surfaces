import { compareStrings } from "../core/compare";
import { EvaluationModel, RequirementResult } from "./evaluate";
import {
  PrCoverageDelta,
  PrRequirementCoverageDelta,
  PrScopeModel,
  PrScopedCoverageModel,
  ScopedStatus
} from "../pr/contract";

// ---------------------------------------------------------------------------
// PR-scoped coverage delta: for ONLY the requirements the diff touches, compare
// head vs base coverage. This replaces the whole-spec "satisfied 7 | partial 74"
// dump in PR mode. The base evaluation (when available) is produced by running
// the pipeline against the base SHA in a temporary worktree at integration time;
// this module is a pure comparison over the two evaluations.
// ---------------------------------------------------------------------------

export interface BuildPrScopedCoverageInput {
  scope: PrScopeModel;
  headEvaluation: EvaluationModel;
  // Absent when the base ref could not be evaluated (shallow clone, missing ref).
  // base_available is then false and deltas are reported as current-status only.
  baseEvaluation?: EvaluationModel;
}

// Rank for "better/worse" comparison. Higher is better coverage.
const STATUS_RANK: Record<ScopedStatus, number> = {
  satisfied: 4,
  partial: 3,
  unknown: 2,
  missing: 1,
  invalid_evidence: 0,
  overreach: 0,
  absent: -1
};

function findResult(evaluation: EvaluationModel, requirementId: string, acaiId?: string): RequirementResult | undefined {
  // Align by ACID first (stable across renames/reorders), then by requirement_id.
  if (acaiId) {
    const byAcai = evaluation.results.find((result) => result.acai_id === acaiId);
    if (byAcai) {
      return byAcai;
    }
  }
  return evaluation.results.find((result) => result.requirement_id === requirementId);
}

function computeDelta(baseAvailable: boolean, base: ScopedStatus, head: ScopedStatus): PrCoverageDelta {
  if (!baseAvailable) {
    // No baseline to diff against: report as in-scope current status. The renderer
    // keys off base_available to phrase this as "current status (no baseline)".
    return "newly_in_scope";
  }
  if (base === "absent" && head !== "absent") {
    return "new_requirement";
  }
  if (base !== "absent" && head === "absent") {
    return "removed_requirement";
  }
  const headRank = STATUS_RANK[head];
  const baseRank = STATUS_RANK[base];
  if (headRank > baseRank) {
    return "improved";
  }
  if (headRank < baseRank) {
    return "regressed";
  }
  return "unchanged";
}

/**
 * Build the PR-scoped coverage delta from the scope's affected requirements and
 * the head (and optional base) evaluations. Pure and deterministic: the delta
 * list follows the scope's already-sorted affected-requirement order.
 */
export function buildPrScopedCoverage(input: BuildPrScopedCoverageInput): PrScopedCoverageModel {
  // A base evaluation that produced ZERO requirement results is not a usable
  // baseline: every in-scope requirement would resolve to "absent" and be
  // mislabeled "new_requirement", falsely implying the whole spec is brand-new in
  // this PR. Such an empty result set is ambiguous (base predates the spec, or the
  // base eval silently degraded), so treat it as no baseline (current-status only).
  const baseAvailable = input.baseEvaluation !== undefined && input.baseEvaluation.results.length > 0;
  const deltas: PrRequirementCoverageDelta[] = [];

  for (const requirement of input.scope.affected_requirements) {
    const headResult = findResult(input.headEvaluation, requirement.requirement_id, requirement.acai_id);
    const baseResult = input.baseEvaluation
      ? findResult(input.baseEvaluation, requirement.requirement_id, requirement.acai_id)
      : undefined;

    const headStatus: ScopedStatus = headResult?.status ?? "absent";
    const baseStatus: ScopedStatus = baseAvailable ? (baseResult?.status ?? "absent") : "absent";
    const delta = computeDelta(baseAvailable, baseStatus, headStatus);

    const reasons: string[] = [];
    if (baseAvailable) {
      reasons.push(`base ${baseStatus} -> head ${headStatus}`);
    } else {
      reasons.push(`current status ${headStatus} (no baseline)`);
    }

    deltas.push({
      requirement_id: requirement.requirement_id,
      acai_id: requirement.acai_id,
      title: requirement.title,
      base_status: baseStatus,
      head_status: headStatus,
      delta,
      reasons,
      head_evidence: headResult?.evidence ?? [],
      missing_evidence: headResult?.missing_evidence ?? []
    });
  }

  // Stable secondary sort by acai_id/requirement_id so the table is byte-stable
  // even if scope ordering ever changes upstream.
  deltas.sort((left, right) =>
    compareStrings(left.acai_id ?? left.requirement_id, right.acai_id ?? right.requirement_id)
  );

  const counts = {
    improved: 0,
    regressed: 0,
    unchanged: 0,
    new_requirement: 0,
    removed_requirement: 0,
    newly_in_scope: 0
  };
  for (const entry of deltas) {
    counts[entry.delta] += 1;
  }

  const summary = baseAvailable
    ? `${deltas.length} requirement(s) in scope: ${counts.improved} improved, ${counts.regressed} regressed, ${counts.unchanged} unchanged, ${counts.new_requirement} new, ${counts.removed_requirement} removed.`
    : `${deltas.length} requirement(s) in scope (baseline unavailable; current status only).`;

  return {
    base_available: baseAvailable,
    summary,
    in_scope_count: deltas.length,
    deltas,
    counts
  };
}
