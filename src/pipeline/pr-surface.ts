import fs from "node:fs";
import path from "node:path";
import { CollectionResult } from "../collector/collect";
import { parseStructuredDiff } from "../collector/diff-hunks";
import { EvaluationModel } from "../evaluation/evaluate";
import { buildPrScopedCoverage } from "../evaluation/scoped-coverage";
import { IntentModel } from "../intent/intent";
import { buildPrRiskCandidates } from "../risks/pr-risks";
import { createReviewAreaMatcher, ReviewArea } from "../review-areas/areas";
import { buildPrScope, isTestPath } from "../scope/pr-scope";
import { PrChangeContext, PrReviewSurfaceModel, PR_SURFACE_SCHEMA_VERSION, StructuredDiff } from "../pr/contract";
import { inspectAndRedactSecrets } from "../privacy/secrets";

// ---------------------------------------------------------------------------
// PR review surface assembly. Runs the deterministic diff-scoped facts
// (scope -> coverage delta -> risks) and packages them into a
// PrReviewSurfaceModel. Provider prose is optional enrichment on the human
// artifact; it is deliberately not duplicated in this lower-level sidecar.
// ---------------------------------------------------------------------------

export interface AssemblePrSurfaceInput {
  collection: CollectionResult;
  intent: IntentModel;
  evaluation: EvaluationModel;
  // The base-ref evaluation (from a worktree run); absent -> coverage degrades to
  // current-status. Wired by the CLI/pipeline when a base ref is resolvable.
  baseEvaluation?: EvaluationModel;
  reviewAreas: ReviewArea[];
  diff?: StructuredDiff;
  changeContext?: PrChangeContext;
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
  const changeContext = normalizePrChangeContext(input.changeContext);

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

  const repositoryTestAreas = scope.changed_files.some((file) => file.role === "implementation")
    ? collectRepositoryTestAreas(input)
    : new Set<string>();

  const risks = buildPrRiskCandidates({
    specMode: input.intent.spec_mode,
    scope,
    coverage,
    secretFindings: input.collection.privacy.secret_findings,
    testResults: input.collection.testResults,
    commandTranscripts: input.collection.commandTranscripts,
    commandRules: input.collection.commandRules,
    changedFileSources: Object.fromEntries(input.collection.changedFiles.map((file) => [file.path, file.source])),
    reviewAreas: input.reviewAreas,
    repositoryTestAreas
  });

  // No changed files -> nothing to review. Block (don't post an empty surface),
  // skip the LLM call entirely.
  if (scope.changed_files.length === 0) {
    return {
      schema_version: PR_SURFACE_SCHEMA_VERSION,
      mode: "pr",
      status: "blocked",
      blocked_reason: "no_diff",
      change_context: changeContext,
      scope,
      coverage,
      risks
    };
  }

  // review-surfaces.PROVIDERS.5: deterministic current-head facts are enough to
  // produce a ready PR surface. Optional provider prose is never a readiness or
  // postability prerequisite.
  return {
    schema_version: PR_SURFACE_SCHEMA_VERSION,
    mode: "pr",
    status: "ready",
    change_context: changeContext,
    scope,
    coverage,
    risks
  };
}

export function normalizePrChangeContext(context: PrChangeContext | undefined): PrChangeContext | undefined {
  if (!context) return undefined;
  const titleRedaction = inspectAndRedactSecrets(context.title);
  const descriptionRedaction = inspectAndRedactSecrets(context.description ?? "");
  const title = titleRedaction.text.trim().slice(0, 300);
  if (!title) return undefined;
  const description = descriptionRedaction.text.trim().slice(0, 6000);
  return {
    title,
    ...(description ? { description } : {}),
    source: context.source,
    redaction_blocked: titleRedaction.blocked || descriptionRedaction.blocked
  };
}

export function samePrChangeContext(
  left: PrChangeContext | undefined,
  right: PrChangeContext | undefined
): boolean {
  const normalizedLeft = normalizePrChangeContext(left);
  const normalizedRight = normalizePrChangeContext(right);
  return normalizedLeft?.title === normalizedRight?.title &&
    normalizedLeft?.description === normalizedRight?.description &&
    normalizedLeft?.source === normalizedRight?.source &&
    normalizedLeft?.redaction_blocked === normalizedRight?.redaction_blocked;
}

function collectRepositoryTestAreas(input: AssemblePrSurfaceInput): Set<string> {
  const repositoryTestAreas = new Set<string>();
  const testMatcher = createReviewAreaMatcher(input.reviewAreas);
  const repositoryTestPaths = new Set<string>([
    ...input.collection.tests.map((test) => test.path),
    ...input.collection.repositoryFiles.filter(isRepositoryExecutableTestPath)
  ]);
  for (const testPath of repositoryTestPaths) {
    for (const area of testMatcher.groupsForPath(testPath, { purpose: "review_surface", testPath: true })) {
      repositoryTestAreas.add(area);
    }
  }
  return repositoryTestAreas;
}

const REPOSITORY_TEST_CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|m|sh|bash|zsh)$/i;

function isRepositoryExecutableTestPath(filePath: string): boolean {
  return isTestPath(filePath) && REPOSITORY_TEST_CODE_EXT.test(filePath) && !/\.d\.ts$/i.test(filePath);
}
