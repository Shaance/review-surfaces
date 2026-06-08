import fs from "node:fs";
import path from "node:path";
import { CollectionResult } from "../collector/collect";
import { parseStructuredDiff } from "../collector/diff-hunks";
import { EvaluationModel } from "../evaluation/evaluate";
import { buildPrScopedCoverage } from "../evaluation/scoped-coverage";
import { IntentModel } from "../intent/intent";
import { ProviderName, ReasoningProvider } from "../llm/provider";
import { buildPrNarrative } from "../llm/pr-narrative";
import { buildPrChangeDiagram } from "../diagrams/pr-change-diagram";
import { buildPrRiskCandidates } from "../risks/pr-risks";
import { ReviewArea } from "../review-areas/areas";
import { buildPrScope } from "../scope/pr-scope";
import { PrReviewSurfaceModel, PR_SURFACE_SCHEMA_VERSION, PrSurfaceBlockedReason, StructuredDiff } from "../pr/contract";

// ---------------------------------------------------------------------------
// PR review surface assembly. Runs the deterministic diff-scoped facts
// (scope -> coverage delta -> risks -> change diagram) then the LLM narrative,
// and packages them into a PrReviewSurfaceModel. PR mode REQUIRES the narrative:
// a blocked surface (no narrative) is returned rather than ever falling back to
// the whole-repo comment. The caller (CLI/renderer) decides whether to post.
// ---------------------------------------------------------------------------

export interface AssemblePrSurfaceInput {
  collection: CollectionResult;
  intent: IntentModel;
  evaluation: EvaluationModel;
  // The base-ref evaluation (from a worktree run); absent -> coverage degrades to
  // current-status. Wired by the CLI/pipeline when a base ref is resolvable.
  baseEvaluation?: EvaluationModel;
  reviewAreas: ReviewArea[];
  provider: ReasoningProvider;
  providerName: ProviderName;
  model?: string;
  redactSecrets: boolean;
  diff?: StructuredDiff;
}

function readDiffText(collection: CollectionResult): string {
  const diffPath = path.join(collection.outputDir, "inputs", "diff.patch");
  try {
    return fs.readFileSync(diffPath, "utf8");
  } catch {
    return "";
  }
}

export async function assemblePrReviewSurface(input: AssemblePrSurfaceInput): Promise<PrReviewSurfaceModel> {
  const diff: StructuredDiff = input.diff ?? parseStructuredDiff(readDiffText(input.collection));

  const scope = buildPrScope({
    collection: input.collection,
    intent: input.intent,
    reviewAreas: input.reviewAreas,
    diff
  });

  const coverage = buildPrScopedCoverage({
    scope,
    headEvaluation: input.evaluation,
    baseEvaluation: input.baseEvaluation
  });

  const risks = buildPrRiskCandidates({
    scope,
    coverage,
    testResults: input.collection.testResults
  });

  const diagram = buildPrChangeDiagram({ scope, risks });

  // No changed files -> nothing to review. Block (don't post an empty surface),
  // skip the LLM call entirely.
  if (scope.changed_files.length === 0) {
    return {
      schema_version: PR_SURFACE_SCHEMA_VERSION,
      mode: "pr",
      status: "blocked",
      blocked_reason: "no_diff",
      scope,
      coverage,
      risks,
      diagram,
      llm: { required: true, provider: input.providerName, model: input.model, status: "blocked", validation_errors: ["no_diff"] }
    };
  }

  const narrativeResult = await buildPrNarrative({
    provider: input.provider,
    providerName: input.providerName,
    model: input.model,
    repo: input.collection.git.repo,
    scope,
    coverage,
    risks,
    diagram,
    diff,
    redactSecrets: input.redactSecrets,
    remotePrivacyBlocked: input.collection.privacy.remote_provider_blocked
  });

  const blockedReason: PrSurfaceBlockedReason | undefined = narrativeResult.narrative ? undefined : narrativeResult.blocked_reason ?? "llm_unavailable";

  return {
    schema_version: PR_SURFACE_SCHEMA_VERSION,
    mode: "pr",
    status: narrativeResult.narrative ? "ready" : "blocked",
    blocked_reason: blockedReason,
    scope,
    coverage,
    risks,
    diagram,
    narrative: narrativeResult.narrative,
    llm: narrativeResult.meta
  };
}
