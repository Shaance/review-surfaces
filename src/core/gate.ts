import type { CollectionResult } from "../collector/collect";
import type { EvaluationModel, RequirementResult } from "../evaluation/evaluate";
import { isHypothesisOnly } from "../evidence/evidence";
import { providerMakesRemoteCall } from "../llm/provider";
import type { ProviderName } from "../llm/provider";
import type { RiskItem } from "../risks/risks";
import { ExitCodes } from "./exit-codes";

// review-surfaces.QUALITY_GATE.1: the deterministic severity ladder the
// --fail-on risk gate compares against. Higher index == more severe, so a
// threshold trips on every risk item at or above its rank. "unknown" sits at the
// BOTTOM so it never trips a high/medium/low threshold; a `--fail-on unknown`
// (the floor) trips on any deterministic risk.
const FAIL_ON_SEVERITY_RANK: Record<RiskItem["severity"], number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export type FailOnSeverity = RiskItem["severity"];

export interface GateOptions {
  // Maximum number of "missing" requirement results tolerated before the
  // quality gate trips. Defaults to 0 (any missing requirement fails).
  maxMissing: number;
  // Acai IDs (or requirement IDs) explicitly allowed to be missing — a planned
  // backlog that has not been implemented yet. Allowlisted misses are excluded
  // from the gate count, so an UNRELATED requirement regressing to missing still
  // trips the gate even when the total miss count is unchanged.
  allowMissing?: string[];
  // review-surfaces.QUALITY_GATE.1: an optional risk-severity threshold. When set,
  // the quality gate also trips when any NON-HYPOTHESIS risk item is at or above
  // this severity (LLM-only hypotheses are excluded — they are never proof). Unset
  // means the legacy behavior (the gate ignores packet.risks).
  failOnSeverity?: FailOnSeverity;
}

export interface GateDecision {
  code: number;
  reason: string;
}

// Pure, unit-testable quality/privacy/evidence gate. Returns the FIRST
// applicable exit code in priority order:
//   privacyBlocked (5) -> evidenceValidationFailed (4) -> qualityGateFailed (10)
// and ExitCodes.success (0) when nothing trips. This function never reads the
// filesystem or process state, so it is identical inside `all` and in tests.
//
// Callers decide whether to ACT on the code: without --strict the pipeline
// keeps its default "fail gently" behavior (warn, exit 0); with --strict the
// returned code becomes the process exit code.
export function gateDecision(
  evaluation: EvaluationModel,
  collection: CollectionResult,
  provider: ProviderName,
  options: GateOptions,
  // review-surfaces.QUALITY_GATE.1: the deterministic risk items the --fail-on
  // threshold inspects. Optional so a stage with no risks model (e.g. `evaluate`)
  // still gates on missing/evidence/privacy exactly as before.
  risks?: RiskItem[]
): GateDecision {
  // 5: a provider that makes a REMOTE call was requested but privacy blocked
  // remote enrichment. Only ai-sdk leaves the machine; mock and agent-file are
  // OFFLINE (agent-file only reads a local --agent-input file), so a
  // remote_provider_blocked diff must NOT privacy-block them — it would
  // wrongly short-circuit the evidence/quality gates for a local-only run.
  if (providerMakesRemoteCall(provider) && collection.privacy.remote_provider_blocked) {
    return {
      code: ExitCodes.privacyBlocked,
      reason: `Privacy block: provider "${provider}" requires remote enrichment, but the redacted diff is flagged remote_provider_blocked.`
    };
  }

  // 4: any result OR overreach finding failed deterministic evidence validation.
  const invalidEvidenceCount = [...evaluation.results, ...evaluation.overreach].filter(
    (result) => result.status === "invalid_evidence"
  ).length;
  if (invalidEvidenceCount > 0) {
    return {
      code: ExitCodes.evidenceValidationFailed,
      reason: `Evidence validation failed: ${invalidEvidenceCount} requirement result(s) have status "invalid_evidence".`
    };
  }

  // 10: more "missing" requirement results than the configured tolerance,
  // excluding the explicitly allowlisted planned backlog.
  const missingCount = countMissing(evaluation.results, options.allowMissing);
  if (missingCount > options.maxMissing) {
    return {
      code: ExitCodes.qualityGateFailed,
      reason: `Quality gate failed: ${missingCount} missing requirement(s) exceed the allowed maximum of ${options.maxMissing}.`
    };
  }

  // 10 (risk-severity gate): review-surfaces.QUALITY_GATE.1. When a --fail-on
  // threshold is set, count DETERMINISTIC risk items at or above it. LLM-only
  // hypotheses are excluded (isHypothesisOnly) so an unverified hypothesis can
  // never trip the gate. Composes with --strict exactly like the missing gate.
  if (options.failOnSeverity !== undefined) {
    const threshold = FAIL_ON_SEVERITY_RANK[options.failOnSeverity];
    const tripping = (risks ?? []).filter(
      (item) => !isHypothesisOnly(item.evidence) && FAIL_ON_SEVERITY_RANK[item.severity] >= threshold
    );
    if (tripping.length > 0) {
      return {
        code: ExitCodes.qualityGateFailed,
        reason: `Quality gate failed: ${tripping.length} deterministic risk item(s) at or above severity "${options.failOnSeverity}" (--fail-on).`
      };
    }
  }

  return { code: ExitCodes.success, reason: "All gates passed." };
}

// Convenience wrapper returning only the numeric exit code.
export function gateExitCode(
  evaluation: EvaluationModel,
  collection: CollectionResult,
  provider: ProviderName,
  options: GateOptions,
  risks?: RiskItem[]
): number {
  return gateDecision(evaluation, collection, provider, options, risks).code;
}

function countMissing(results: RequirementResult[], allowMissing?: string[]): number {
  // Drop blank allowlist entries so a stray empty YAML item cannot match a
  // result that simply has no acai_id and silently exclude it from the gate.
  const allowed = new Set((allowMissing ?? []).filter((id) => id.length > 0));
  return results.filter(
    (result) =>
      result.status === "missing" &&
      !(result.acai_id !== undefined && allowed.has(result.acai_id)) &&
      !allowed.has(result.requirement_id)
  ).length;
}
