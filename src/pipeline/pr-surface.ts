import fs from "node:fs";
import path from "node:path";
import { CollectionResult } from "../collector/collect";
import { buildNotAssessedConversationAnalysis } from "../contracts/conversation-review";
import { parseStructuredDiff } from "../collector/diff-hunks";
import { EvaluationModel } from "../evaluation/evaluate";
import { buildPrScopedCoverage } from "../evaluation/scoped-coverage";
import { IntentModel } from "../intent/intent";
import { ProviderName, ReasoningProvider } from "../llm/provider";
import { buildPrNarrative } from "../llm/pr-narrative";
import { buildPrChangeDiagram } from "../diagrams/pr-change-diagram";
import { buildPrRiskCandidates } from "../risks/pr-risks";
import { buildConversationReview } from "../conversation/review";
import { createReviewAreaMatcher, ReviewArea } from "../review-areas/areas";
import { buildPrScope, isExecutableTestPath } from "../scope/pr-scope";
import { PrReviewSurfaceModel, PR_SURFACE_SCHEMA_VERSION, PrSurfaceBlockedReason, StructuredDiff } from "../pr/contract";

// ---------------------------------------------------------------------------
// PR review surface assembly. Runs the deterministic diff-scoped facts
// (scope -> coverage delta -> risks -> change diagram), then the required LLM
// narrative and advisory conversation review, and packages them into a
// PrReviewSurfaceModel. PR mode REQUIRES the narrative:
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

  const diagram = buildPrChangeDiagram({ scope, risks });

  // No changed files -> nothing to review. Block (don't post an empty surface),
  // skip the LLM call entirely.
  if (scope.changed_files.length === 0) {
    const conversationAnalysis = buildNotAssessedConversationAnalysis(input.providerName, "no_diff");
    return {
      schema_version: PR_SURFACE_SCHEMA_VERSION,
      mode: "pr",
      spec_mode: input.intent.spec_mode,
      status: "blocked",
      blocked_reason: "no_diff",
      scope,
      coverage,
      risks,
      conversation_analysis: {
        ...conversationAnalysis,
        quality_flags: [
          ...(input.collection.conversationEvents?.length ? [] : conversationAnalysis.quality_flags),
          "conversation_review_no_diff"
        ]
      },
      review_insights: [],
      diagram,
      llm: { required: true, provider: input.providerName, model: input.model, status: "blocked", validation_errors: ["no_diff"] }
    };
  }

  // Preserve the existing postability-critical narrative call ahead of optional
  // conversation enrichment so a long transcript cannot consume the provider
  // budget and cause an otherwise-ready PR surface to fail afterwards.
  const narrativeResult = await buildPrNarrative({
    specMode: input.intent.spec_mode,
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

  const conversationReview = await buildConversationReview({
    provider: input.provider,
    providerName: input.providerName,
    events: input.collection.conversationEvents,
    diff,
    scope,
    coverage,
    risks,
    commandTranscripts: input.collection.commandTranscripts,
    commandRules: input.collection.commandRules,
    headSha: scope.head_sha,
    redactSecrets: input.redactSecrets,
    remotePrivacyBlocked: input.collection.privacy.remote_provider_blocked
  });

  const blockedReason: PrSurfaceBlockedReason | undefined = narrativeResult.narrative ? undefined : narrativeResult.blocked_reason ?? "llm_unavailable";

  return {
    schema_version: PR_SURFACE_SCHEMA_VERSION,
    mode: "pr",
    spec_mode: input.intent.spec_mode,
    status: narrativeResult.narrative ? "ready" : "blocked",
    blocked_reason: blockedReason,
    scope,
    coverage,
    risks,
    conversation_analysis: conversationReview.analysis,
    review_insights: conversationReview.insights,
    diagram,
    narrative: narrativeResult.narrative,
    llm: narrativeResult.meta
  };
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
  if (isExecutableTestPath(filePath)) {
    return true;
  }
  return /(^|\/)(tests?|__tests__|spec)\//i.test(filePath) && REPOSITORY_TEST_CODE_EXT.test(filePath) && !/\.d\.ts$/i.test(filePath);
}
