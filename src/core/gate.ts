import { CollectionResult } from "../collector/collect";
import { EvaluationModel, RequirementResult } from "../evaluation/evaluate";
import { ProviderName, providerMakesRemoteCall } from "../llm/provider";
import { ExitCodes } from "./exit-codes";

export interface GateOptions {
  // Maximum number of "missing" requirement results tolerated before the
  // quality gate trips. Defaults to 0 (any missing requirement fails).
  maxMissing: number;
  // Acai IDs (or requirement IDs) explicitly allowed to be missing — a planned
  // backlog that has not been implemented yet. Allowlisted misses are excluded
  // from the gate count, so an UNRELATED requirement regressing to missing still
  // trips the gate even when the total miss count is unchanged.
  allowMissing?: string[];
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
  options: GateOptions
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

  return { code: ExitCodes.success, reason: "All gates passed." };
}

// Convenience wrapper returning only the numeric exit code.
export function gateExitCode(
  evaluation: EvaluationModel,
  collection: CollectionResult,
  provider: ProviderName,
  options: GateOptions
): number {
  return gateDecision(evaluation, collection, provider, options).code;
}

function countMissing(results: RequirementResult[], allowMissing?: string[]): number {
  const allowed = new Set(allowMissing ?? []);
  return results.filter(
    (result) =>
      result.status === "missing" &&
      !allowed.has(result.acai_id ?? "") &&
      !allowed.has(result.requirement_id)
  ).length;
}
