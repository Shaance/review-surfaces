import crypto from "node:crypto";
import { SPEC_NONE_NOTE } from "../evaluation/status";
import { CommandRule, commandLooksLikeLocalValidationCommand } from "../commands/classify";
import { compareStrings } from "../core/compare";
import { globToRegExp } from "../core/glob";
import { stripUndefined, uniqueTruthy } from "../core/guards";
import { formatHunkHeader, hunkOverlapsRange } from "../collector/diff-hunks";
import { buildFallbackNarrative } from "./narrative";
import { ApiSurfaceChange, emptySemanticChangeFacts, formatEnumChanges, formatTypeChanges, SchemaContractChange, SemanticChangeFacts, TestWeakeningSignal } from "../risks/semantic-diff";
import type { SwiftDeclarationChange } from "../risks/swift-semantic-diff";
import { emptyRankingEvidence, RankingEvidence } from "../risks/ranking-evidence";
import { buildReviewPlan } from "./budget";
import { buildChangeGraphSections, ChangedFileFacts, ChangedImportEdge } from "./change-graph";
import { ArchDriftFact, ArchDriftResult } from "../risks/arch-drift";
import { DependencyFact, dependencyFactSeverityRank } from "../risks/dependency-facts";
import { ConfigFact } from "../risks/config-facts";
import { expiredPolicySuppressions, matchPolicySeverityOverride, matchPolicySuppression, ReviewPolicy } from "../feedback/policy";
import type { CoverageEvidence } from "./contract";
import { comparisonRiskKey } from "../dogfood/compare";
import { EvidenceRef, feedbackEvidence, fileEvidence, missingEvidence } from "../evidence/evidence";
import { normalizeEvidencePath } from "../evidence/validate";
import { ACID_PATTERN } from "../evaluation/evidence-rules";
import type { FeedbackFile } from "../feedback/feedback";
import { PrRiskCandidate, PrReviewSurfaceModel, StructuredDiff, StructuredDiffFile, StructuredDiffHunk } from "../pr/contract";
import { PR_RISK_RULE_METADATA } from "../pr/risk-metadata";
import { ReviewPacket } from "../render/packet";
import { isAppleGeneratedPath, isAppleNonReviewArtifactPath } from "../collector/source-kind";
import { looksLikeRecordedCiSecretBoundaryManualCheck } from "../risks/manual-checks";
import { RisksModel } from "../risks/risks";
import { classifyRole, isTestPath } from "../scope/pr-scope";
import type { PacketConfidence, PacketSeverity } from "../schema/review-packet-contract";
import {
  DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
  HUMAN_REVIEW_SCHEMA_VERSION,
  REVIEW_ROUTE_PERSONAS,
  ChangeNarrative,
  EvidenceCard,
  FeedbackPolicyEffect,
  HumanReviewBuildConfig,
  HumanReviewDecision,
  HumanReviewModel,
  HumanReviewPriority,
  HumanReviewVerdict,
  HumanReviewVerdictReason,
  IntentMismatch,
  IntentMismatchItem,
  InvalidEvidenceSummary,
  MethodologyAudit,
  MethodologyAuditFlag,
  MissingEvidenceSummary,
  ReviewBlocker,
  DependencyChain,
  EvalScoreboardSummary,
  ReviewQueueItem,
  RoundsLedgerEntry,
  ReviewRoute,
  ReviewRoutePersona,
  ReviewRouteStep,
  ReviewerQuestion,
  RiskLens,
  RiskLensFinding,
  RISK_LENSES,
  RISK_LENS_METADATA,
  SinceLastReview,
  SinceLastReviewItem,
  SuggestedReviewComment,
  TestPlanItem,
  TrustAudit,
  TrustFact
} from "./contract";

export interface BuildHumanReviewInput {
  packet: ReviewPacket;
  prSurface?: PrReviewSurfaceModel;
  diff?: StructuredDiff;
  feedback?: FeedbackFile[];
  config?: HumanReviewBuildConfig;
  packetPath?: string;
  prSurfacePath?: string;
  // review-surfaces.NARRATIVE.1-4: an already-anchor-validated change narrative
  // built through the provider boundary. Stored read-only; it NEVER influences
  // the verdict, blockers, or coverage. Absent -> no narrative section.
  narrative?: ChangeNarrative;
  // review-surfaces.SEMANTIC_DIFF.1-4: deterministic semantic facts computed in
  // the pipeline (it needs git access to base file content). Absent -> empty.
  semanticFacts?: SemanticChangeFacts;
  // review-surfaces.RANKING.1: per-changed-impl-path evidence (which changed test
  // imports which changed impl) computed in the pipeline (needs head file
  // contents). Absent -> no test-change ranking modifier.
  rankingEvidence?: RankingEvidence;
  // review-surfaces.COVERAGE.3/.4: per-changed-file coverage computed from an
  // ingested lcov report in the pipeline. Absent -> status "no_report" (the
  // honest negative; never a penalty).
  coverageEvidence?: CoverageEvidence;
  // review-surfaces.DEP_FACTS.1/.2: deterministic dependency/lockfile facts
  // computed in the pipeline. Absent -> empty (no supply-chain signal).
  dependencyFacts?: DependencyFact[];
  // review-surfaces.CONFIG_FACTS.1-3: deterministic env/CI/Dockerfile/SQL facts
  // computed in the pipeline. Absent -> empty.
  configFacts?: ConfigFact[];
  // review-surfaces.COLLECTOR.9: validated wrapper command rules, so the trust
  // audit recognizes a configured wrapper as local validation the SAME way the
  // risks model did when it created the claimed TEST-CMD row. Absent -> [].
  commandRules?: CommandRule[];
  // review-surfaces.POLICY.1/.2: the committed team policy (validated by the
  // loader) and the deterministic run clock for suppression expiry.
  policy?: ReviewPolicy;
  policyNowIso?: string;
  // review-surfaces.CHANGE_MAP.1: importer->imported edges among changed files,
  // computed in the pipeline from buildImportGraph() over head content (it needs
  // file access). Absent -> a map with no edges (nodes still render).
  changedImportEdges?: ChangedImportEdge[];
  // review-surfaces.COLD_START.2: implementation roots detected from the target
  // repo's signals; feeds the change-map clusters and the tour categorization.
  implementationRoots?: readonly string[];
  // review-surfaces.ARCH_DRIFT.1-3: module-boundary drift facts + file-level
  // edge deltas computed in the pipeline (base/head file access). Absent ->
  // no drift signal and all change_graph edges stay kind "existing".
  archDrift?: ArchDriftResult;
  // review-surfaces.TREND.1: the prior rounds ledger recovered from the
  // previous packet's human_review.json (either transport: CI artifact or the
  // local prior-packet directory). Absent -> this run starts the ledger.
  previousRounds?: RoundsLedgerEntry[];
  // review-surfaces.EVAL_HARNESS.6: the eval scoreboard summary read from the
  // output directory's eval_scoreboard.json (absent when no scoreboard exists).
  evalScoreboard?: EvalScoreboardSummary;
}

interface BuildReviewRoutesInput {
  input: BuildHumanReviewInput;
  verdict: HumanReviewVerdict;
  reviewQueue: HumanReviewModel["review_queue"];
  blockers: ReviewBlocker[];
  questions: ReviewerQuestion[];
  suggestedComments: SuggestedReviewComment[];
  trustAudit: TrustAudit;
  riskLensFindings: RiskLensFinding[];
  intentMismatch: IntentMismatch;
  sinceLastReview: SinceLastReview;
  testPlan: TestPlanItem[];
}

interface BuildEvidenceCardsInput {
  blockers: ReviewBlocker[];
  trustAudit: TrustAudit;
  riskLensFindings: RiskLensFinding[];
  testPlan: TestPlanItem[];
  coverage?: CoverageEvidence;
}

interface QueueDraft {
  title: string;
  path: string;
  old_path?: string;
  hunk_header?: string;
  line_start?: number;
  line_end?: number;
  anchor_side?: "old" | "new";
  reviewer_action: string;
  reason: string;
  evidence: EvidenceRef[];
  requirement_ids: string[];
  risk_ids: string[];
  confidence: PacketConfidence;
  priority: HumanReviewPriority;
  estimated_review_effort: "quick" | "moderate" | "deep";
  score: number;
  sortKey: string;
  // review-surfaces.RANKING.1/.3: evidence ordering tier — a SECONDARY sort key so
  // evidence breaks ties and demotes well-evidenced items WITHOUT changing the
  // primary score (the semantic-risk class stays the primary key and evidence can
  // never lift an item across a class). -1 promotes (ranks earlier among equal
  // scores), +1 demotes, 0 is neutral.
  evidenceTier?: number;
  // review-surfaces.RANKING.2: the "why ranked here" lines for this draft.
  ranking_reasons?: string[];
  // review-surfaces.HUMAN_REVIEW.28: a cold-start baseline item (no risk fired). Its
  // ranking reason must be the deterministic signal, not a "ranked by risk severity"
  // line that reads as a risk assessment.
  baseline?: string;
}

type TestPlanDraft = Omit<TestPlanItem, "id">;
type TestPlanDraftCore =
  Omit<TestPlanDraft, "maps_to_requirements" | "maps_to_risks" | "evidence_gap"> &
  Partial<Pick<TestPlanDraft, "maps_to_requirements" | "maps_to_risks" | "evidence_gap">>;
type RequirementGap = ReviewPacket["evaluation"]["results"][number];
type MissingAutomaticTestGap = NonNullable<RisksModel["missing_automatic_tests"]>[number];
type MissingManualCheckGap = NonNullable<RisksModel["missing_manual_checks"]>[number];
type PrChangedFile = PrReviewSurfaceModel["scope"]["changed_files"][number];
type IntentObservedFile = Pick<PrChangedFile, "path" | "old_path" | "status" | "areas" | "role" | "added_lines" | "deleted_lines">;
type TrustFactDraft = Omit<TrustFact, "id">;
type InvalidEvidenceDraft = Omit<InvalidEvidenceSummary, "id">;
type SuggestedCommentDraft = Omit<SuggestedReviewComment, "id">;
interface SuggestedCommentCandidate {
  draft: SuggestedCommentDraft;
  risk?: PrRiskCandidate;
  sourceRank: number;
  sortKey: string;
}
interface TestPlanCandidate {
  draft: TestPlanDraft;
  risk?: PrRiskCandidate;
  lens?: RiskLensFinding;
  sourceRank: number;
  sortKey: string;
}
type EvidenceCardDraft = Omit<EvidenceCard, "id">;
type ReviewRouteStepDraft = Omit<ReviewRouteStep, "id" | "rank">;
type FeedbackPolicyEffectDraft = Omit<FeedbackPolicyEffect, "id">;
type IntentMismatchDraft = Omit<IntentMismatchItem, "id">;
interface IntentMismatchFocus {
  exactRequirementKeys: Set<string>;
  scopedRequirementKeys: Set<string>;
  changedPaths: Set<string>;
}
interface ReviewRouteDefinition {
  id: string;
  title: string;
  is_default: boolean;
  is_secondary: boolean;
  summary: string;
  steps: (ctx: BuildReviewRoutesInput) => ReviewRouteStepDraft[];
}
interface RiskLensAccumulator {
  lens: RiskLens;
  severity: PacketSeverity;
  evidence: EvidenceRef[];
  evidence_keys: Set<string>;
  risk_ids: string[];
  risk_id_set: Set<string>;
  requirement_ids: string[];
  requirement_id_set: Set<string>;
  paths: string[];
  path_set: Set<string>;
  confidence: PacketConfidence;
  has_invalid_evidence: boolean;
}
interface ManualCheckRecord {
  text: string;
  evidence: EvidenceRef[];
}

const MAX_QUEUE = 20;
const MAX_BLOCKERS = 8;
const MAX_QUESTIONS = 10;
// Hard ceiling above the config default (10): one draft per PR-risk rule must
// stay representable as rules grow (11 rules since secret_in_diff).
const MAX_COMMENTS = 12;
const MAX_TEST_PLAN = 12;
const MAX_TRUST_ITEMS = 10;
const MAX_EVIDENCE_CARDS = 10;
const MAX_RISK_LENS_FINDINGS = 12;
const MAX_RISK_LENS_PATHS = 12;
const MAX_INTENT_MISMATCH_ITEMS = 8;
const MAX_FOCUSED_REQUIREMENT_TESTS = 6;
const MAX_CHANGED_FILE_QUEUE = 8;
const MAX_FEEDBACK_EFFECTS = 12;
const MAX_MISSING_TEAM_POLICY_QUESTION_EFFECTS = 3;
const INTENT_MISMATCH_QUESTION_REASON = "The intent-mismatch surface found changed behavior or missing evidence that does not cleanly map to stated intent.";
// A corroborated (advisory===false) D6 workflow finding: a deterministic check backs
// it, so its question must survive the global cap even when appended after the
// blocker/risk/gap questions (Codex P2, #109).
const CORROBORATED_WORKFLOW_QUESTION_REASON = "The methodology audit's deterministic cross-reference check corroborated this; resolve it before approval.";
const FEEDBACK_ACTION_DOWNGRADE_TO_LOW = "downgrade_to_low";
const FEEDBACK_ACTION_RETAIN_LOW_PRIORITY = "retain_low_priority";
const FEEDBACK_ACTION_PRIORITIZE_REVIEW_FOCUS = "prioritize_review_focus";
const RECORD_MANUAL_CHECK_PREFIX = "Record manual check:";
const MANUAL_CHECK_RECORDED_PREFIX = "Manual check recorded:";
const MANUAL_CHECK_TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "can",
  "check",
  "confirm",
  "from",
  "in",
  "is",
  "manual",
  "record",
  "recorded",
  "required",
  "that",
  "the",
  "to"
]);
const PR_RISK_RULE_LENSES: Record<PrRiskCandidate["rule"], RiskLens[]> = {
  coverage_regression: ["test_evidence"],
  untested_changed_impl: ["test_evidence"],
  unmapped_change: [],
  privacy_sensitive_change: ["security_privacy"],
  secret_in_diff: ["security_privacy"],
  comment_surface_change: ["reviewer_ux"],
  ci_secret_boundary_change: ["security_privacy"],
  schema_contract_change: ["api_contract"],
  deleted_or_renamed_surface: ["reviewer_ux"],
  failed_or_skipped_test: ["test_evidence"],
  large_diff: []
};
const REVIEW_ROUTE_DEFINITIONS: Record<ReviewRoutePersona, ReviewRouteDefinition> = {
  human_reviewer: {
    id: "ROUTE-HUMAN",
    title: "Human reviewer route",
    is_default: true,
    is_secondary: false,
    summary: "Default path through the verdict, review queue, blockers, questions, trust audit, and test plan.",
    steps: humanReviewerRouteSteps
  },
  maintainer: {
    id: "ROUTE-MAINTAINER",
    title: "Maintainer route",
    is_default: false,
    is_secondary: false,
    summary: "Focuses on merge readiness, public contracts, required tests, and blocking comments.",
    steps: maintainerRouteSteps
  },
  security: {
    id: "ROUTE-SECURITY",
    title: "Security route",
    is_default: false,
    is_secondary: false,
    summary: "Focuses on security/privacy lenses, CI secret-boundary checks, provider/redaction changes, and manual-check evidence.",
    steps: securityRouteSteps
  },
  product: {
    id: "ROUTE-PRODUCT",
    title: "Product route",
    is_default: false,
    is_secondary: false,
    summary: "Focuses on intent fit, reviewer-facing output, reviewer UX risks, and suggested comments.",
    steps: productRouteSteps
  },
  agent_continuation: {
    id: "ROUTE-AGENT",
    title: "Agent-continuation route",
    is_default: false,
    is_secondary: true,
    summary: "Secondary path for implementation agents to continue from open risks, missing tests, and deferrals.",
    steps: agentContinuationRouteSteps
  }
};
export function buildHumanReview(input: BuildHumanReviewInput): HumanReviewModel {
  const config = humanReviewBuildConfig(input);
  // review-surfaces.COLD_START.4: the spec mode is MODEL state read from the
  // packet intent (a legacy packet without the field reads as "acai").
  const specMode: "acai" | "none" = isSpeclessIntent(input.packet.intent) ? "none" : "acai";
  // review-surfaces.SEMANTIC_DIFF.1-4: concrete change facts feed the queue and
  // suggested comments with field-level / signature-level / test-weakening
  // language instead of generic path-touch phrasing.
  const semanticFacts = input.semanticFacts ?? emptySemanticChangeFacts();
  const feedbackEffects = buildFeedbackPolicyEffects(input, config);
  // review-surfaces.POLICY.2: an expired suppression is never silently dropped —
  // it surfaces as its own team-policy finding so the file stays maintained.
  for (const [index, suppression] of expiredPolicySuppressions(input.policy, input.policyNowIso ?? "").entries()) {
    feedbackEffects.push({
      id: `POLICY-EXPIRED-${String(index + 1).padStart(3, "0")}`,
      kind: "team_policy",
      summary: `Policy suppression for rule \`${suppression.rule}\` on \`${suppression.path_glob}\` expired ${suppression.expires}.`,
      action: "Renew the suppression with a new expiry and reason, or remove it from review-surfaces.policy.yaml.",
      evidence: [fileEvidence("review-surfaces.policy.yaml", `Expired suppression: ${suppression.reason}`)],
      paths: [],
      risk_ids: [],
      confidence: "high"
    });
  }
  const riskLensFindings = buildRiskLensFindings(input, config, semanticFacts);
  const blockers = buildBlockers(input, feedbackEffects);
  const reviewQueue = buildReviewQueue(input, feedbackEffects, config, semanticFacts);
  const intentMismatch = buildIntentMismatch(input, specMode);
  const questions = buildQuestions(input, blockers, feedbackEffects, riskLensFindings, intentMismatch, config);
  const suggestedComments = buildSuggestedComments(input, blockers, riskLensFindings, config, semanticFacts);
  const trustAudit = buildTrustAudit(input);
  const sinceLastReview = buildSinceLastReview(input);
  const coverageEvidence: CoverageEvidence = input.coverageEvidence ?? { status: "no_report", files: [] };
  // review-surfaces.BUDGET.1/.2: a pure post-ranking annotation; off by default.
  const reviewPlan = buildReviewPlan(reviewQueue, input.diff, config.review_budget_minutes ?? undefined);
  const testPlan = buildTestPlan(input, feedbackEffects, riskLensFindings);
  const verdict = buildVerdict(input, blockers, trustAudit);
  const evidenceCards = buildEvidenceCards({
    blockers,
    trustAudit,
    riskLensFindings,
    testPlan,
    coverage: coverageEvidence
  });
  const skimSafe = buildSkimSafe(input, feedbackEffects);
  // review-surfaces.CHANGE_MAP.1 + READING_ORDER.1: one shared computation so
  // the map's left-to-right flow and the tour's numbering can never disagree.
  const changeGraphSections = buildChangeGraphSections({
    files: changedFileFactsForGraph(input),
    edges: input.changedImportEdges ?? [],
    usedBy: semanticFacts.api_changes
      .filter((change) => change.used_by && change.used_by.top.length > 0)
      .map((change) => ({ path: change.path, top: (change.used_by as { top: string[] }).top })),
    lensFindings: riskLensFindings,
    reviewQueue,
    implementationRoots: input.implementationRoots,
    // review-surfaces.ARCH_DRIFT.2: drift edge deltas set kind new/removed so
    // both map renderers pick the drift up with zero extra work.
    driftEdges: input.archDrift?.file_edges
  });
  const generatedFrom = buildGeneratedFrom(input);
  // review-surfaces.TREND.1: append THIS run's row to the carried-forward ledger.
  const rounds = buildRoundsLedger(input, verdict, generatedFrom.head_sha);
  // review-surfaces.DEP_FACTS.4 / RENDER.13: attributed dependency chains.
  const dependencyChains = buildDependencyChains(input.dependencyFacts ?? []);
  // review-surfaces.NARRATIVE.5: a provider-built narrative is passed in when
  // available; otherwise always render the deterministic fallback so the section
  // never fails and standalone/cache rebuilds still carry a narrative.
  const narrative = input.narrative ?? buildFallbackNarrative({
    packet: input.packet,
    prSurface: input.prSurface,
    diff: input.diff,
    headSha: generatedFrom.head_sha,
    maxClaims: config.narrative_max_claims
  });
  const reviewRoutes = buildReviewRoutes({
    input,
    verdict,
    reviewQueue,
    blockers,
    questions,
    suggestedComments,
    trustAudit,
    riskLensFindings,
    intentMismatch,
    sinceLastReview,
    testPlan
  });

  return stripUndefined({
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: input.prSurface ? "pr" : "repo",
    spec_mode: specMode,
    verdict,
    summary: summarizeHumanReview(input, reviewQueue.length, blockers.length),
    // review-surfaces.NARRATIVE.4: the narrative is stored read-only AFTER the
    // verdict/blockers/coverage are computed, so it can never influence them.
    narrative,
    semantic_facts: semanticFacts,
    review_queue: reviewQueue,
    blockers,
    questions,
    suggested_comments: suggestedComments,
    trust_audit: trustAudit,
    risk_lens_findings: riskLensFindings,
    methodology_audit: buildMethodologyAudit(input),
    intent_mismatch: intentMismatch,
    review_routes: reviewRoutes,
    since_last_review: sinceLastReview,
    coverage_evidence: coverageEvidence,
    review_plan: reviewPlan,
    change_graph: changeGraphSections.change_graph,
    reading_order: changeGraphSections.reading_order,
    rounds,
    ...(dependencyChains.length > 0 ? { dependency_chains: dependencyChains } : {}),
    ...(input.evalScoreboard ? { eval_scoreboard: input.evalScoreboard } : {}),
    evidence_cards: evidenceCards,
    test_plan: testPlan,
    skim_safe: skimSafe,
    feedback_effects: feedbackEffects,
    generated_from: generatedFrom
  });
}

// review-surfaces.DEP_FACTS.4 / RENDER.13: group attributed transitive facts
// by the direct dependency that pulled them; install-script flags ride along.
// Unattributed facts stay OUT of the chains (flat fallback handles them).
function buildDependencyChains(facts: DependencyFact[]): DependencyChain[] {
  const withScripts = new Set(facts.filter((fact) => fact.kind === "install_scripts").map((fact) => `${fact.source_path}:${fact.package}`));
  const chains = new Map<string, DependencyChain>();
  for (const fact of facts) {
    if (fact.kind !== "transitive_added" || !fact.via) {
      continue;
    }
    const key = `${fact.source_path}:${fact.via}`;
    const chain = chains.get(key) ?? { via: fact.via, source_path: fact.source_path, transitives: [] };
    chain.transitives.push({ package: fact.package, install_scripts: withScripts.has(`${fact.source_path}:${fact.package}`) });
    chains.set(key, chain);
  }
  return [...chains.values()]
    .map((chain) => ({ ...chain, transitives: [...chain.transitives].sort((a, b) => compareStrings(a.package, b.package)) }))
    .sort((a, b) => compareStrings(a.source_path, b.source_path) || compareStrings(a.via, b.via));
}

// review-surfaces.TREND.1: one row per run — round number continues the prior
// ledger; counts come from the EXISTING compare output (stable finding keys,
// never array positions). A missing prior packet/ledger is the first-review
// case: a one-row ledger, never an error.
function buildRoundsLedger(input: BuildHumanReviewInput, verdict: HumanReviewVerdict, headSha: string): RoundsLedgerEntry[] {
  const prior = input.previousRounds ?? [];
  const comparison = (input.packet.dogfood as { comparison?: { new_risks?: unknown[]; resolved_risks?: unknown[]; status_changes?: Array<{ direction?: string }> } } | undefined)?.comparison;
  const entry: RoundsLedgerEntry = {
    round: (prior[prior.length - 1]?.round ?? 0) + 1,
    head_sha: headSha,
    new_count: comparison?.new_risks?.length ?? 0,
    resolved_count: comparison?.resolved_risks?.length ?? 0,
    regressed_count: (comparison?.status_changes ?? []).filter((change) => change.direction === "regressed").length,
    verdict: verdict.decision
  };
  return [...prior, entry];
}

// review-surfaces.ARCH_DRIFT.2: drift facts rank as concrete queue items via
// the risk register plumbing — cycle creation outranks a plain new edge.
function archDriftQueueDrafts(facts: ArchDriftFact[], diffIndex: DiffIndex | undefined): QueueDraft[] {
  const ordered = [...facts].sort(
    (a, b) =>
      (a.kind === "import_cycle_created" ? 0 : 1) - (b.kind === "import_cycle_created" ? 0 : 1) ||
      compareStrings(a.from_module, b.from_module) ||
      compareStrings(a.to_module, b.to_module)
  );
  return ordered.slice(0, 6).map((fact, index) =>
    semanticDraft(diffIndex, {
      title: archDriftTitle(fact.kind),
      path: fact.files[0] ?? fact.from_module,
      reason: `${fact.detail}.`,
      reviewer_action: "Confirm the module-boundary import change is an intentional architecture decision, not an agent shortcut across layers.",
      priority: fact.kind === "import_cycle_created" ? "high" : "medium",
      score: (fact.kind === "import_cycle_created" ? 200 : 160) - index,
      sortKey: `arch_drift:${fact.kind}:${fact.from_module}:${fact.to_module}`
    })
  );
}

function archDriftTitle(kind: ArchDriftFact["kind"]): string {
  switch (kind) {
    case "module_edge_added":
      return "New module dependency edge";
    case "module_edge_removed":
      return "Removed module dependency edge";
    case "import_cycle_created":
      return "Import cycle created";
  }
}

// review-surfaces.CHANGE_MAP.1: per-changed-file churn/status facts for the
// graph. PR-scope runs carry pre-computed added/deleted line counts; repo-scope
// runs derive churn from the structured diff's hunk lines. Both deterministic.
function changedFileFactsForGraph(input: BuildHumanReviewInput): ChangedFileFacts[] {
  const fromDiff = new Map<string, { added: number; removed: number; status: string; old_path?: string }>();
  for (const file of input.diff?.files ?? []) {
    let added = 0;
    let removed = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") added += 1;
        else if (line.kind === "delete") removed += 1;
      }
    }
    fromDiff.set(file.path, { added, removed, status: file.status, ...(file.old_path ? { old_path: file.old_path } : {}) });
  }
  const scoped = input.prSurface?.scope.changed_files ?? [];
  if (scoped.length > 0) {
    return scoped.map((file) => ({
      path: file.path,
      ...(file.old_path ? { old_path: file.old_path } : {}),
      status: file.status,
      added: file.added_lines ?? fromDiff.get(file.path)?.added ?? 0,
      removed: file.deleted_lines ?? fromDiff.get(file.path)?.removed ?? 0
    }));
  }
  return [...fromDiff.entries()].map(([filePath, facts]) => ({
    path: filePath,
    ...(facts.old_path ? { old_path: facts.old_path } : {}),
    status: facts.status,
    added: facts.added,
    removed: facts.removed
  }));
}

function humanReviewBuildConfig(input: BuildHumanReviewInput): HumanReviewBuildConfig {
  return {
    ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
    ...input.config,
    risk_lenses: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG.risk_lenses,
      ...input.config?.risk_lenses
    }
  };
}

export function humanReviewConfigSignature(
  config?: HumanReviewBuildConfig,
  commandRules?: readonly CommandRule[]
): string {
  const resolved = {
    ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
    ...config,
    risk_lenses: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG.risk_lenses,
      ...config?.risk_lenses
    }
  };
  const fingerprint = {
    // review-surfaces.COLLECTOR.9: command_rules change the rendered trust audit
    // (which wrapper claims surface), so a config-only change to them must bust the
    // cache / trigger a standalone rebuild rather than reuse a stale human_review.json.
    command_rules: (commandRules ?? []).map((rule) => ({
      id: rule.id,
      match: rule.match,
      command: rule.command,
      classification: rule.classification
    })),
    max_questions: resolved.max_questions,
    max_review_first: resolved.max_review_first,
    max_suggested_comments: resolved.max_suggested_comments,
    // narrative_max_claims changes the rendered model, so a config-only change
    // to it must bust the cache / trigger a standalone rebuild.
    narrative_max_claims: resolved.narrative_max_claims,
    // review-surfaces.BUDGET.1: a budget change (config or --budget) changes the
    // rendered review_plan, so it must regenerate rather than serve stale cache.
    review_budget_minutes: resolved.review_budget_minutes,
    // review-surfaces.POLICY.2: a committed-policy change busts the cache.
    policy_signature: resolved.policy_signature ?? "",
    required_manual_checks: resolved.required_manual_checks.map((check) => ({
      id: check.id,
      path_patterns: check.path_patterns,
      prompt: check.prompt
    })),
    risk_lenses: RISK_LENSES.map((lens) => [lens, resolved.risk_lenses[lens]])
  };
  return crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
}

function buildGeneratedFrom(input: BuildHumanReviewInput): HumanReviewModel["generated_from"] {
  const manifest = input.packet.manifest as { base_ref?: unknown; base_sha?: unknown; head_ref?: unknown; head_sha?: unknown; uncommitted_files?: unknown };
  const prScope = input.prSurface?.scope;
  const baseSha = prScope?.base_sha ?? stringOr(manifest.base_sha, "");
  return {
    // COLD_START.8: sibling file names, never cwd-relative paths (see the CLI
    // call site) — the defaults match for inputs that predate the field.
    packet_path: input.packetPath ?? "review_packet.json",
    pr_surface_path: input.prSurface ? input.prSurfacePath ?? "pr_review_surface.json" : undefined,
    base_ref: prScope?.base_ref ?? stringOr(manifest.base_ref, "origin/main"),
    ...(baseSha ? { base_sha: baseSha } : {}),
    head_ref: prScope?.head_ref ?? stringOr(manifest.head_ref, "HEAD"),
    head_sha: prScope?.head_sha ?? stringOr(manifest.head_sha, "unknown"),
    // COLD_START.7: working-tree files absorbed into this review (0 on clean or
    // pinned-head runs); every human surface announces a nonzero count.
    uncommitted_files: typeof manifest.uncommitted_files === "number" ? manifest.uncommitted_files : 0,
    human_review_config_signature: humanReviewConfigSignature(input.config, input.commandRules)
  };
}

function buildReviewRoutes(ctx: BuildReviewRoutesInput): ReviewRoute[] {
  return REVIEW_ROUTE_PERSONAS.map((persona) => {
    const definition = REVIEW_ROUTE_DEFINITIONS[persona];
    return reviewRoute(persona, definition, definition.steps(ctx));
  });
}

function reviewRoute(
  persona: ReviewRoutePersona,
  definition: ReviewRouteDefinition,
  drafts: ReviewRouteStepDraft[]
): ReviewRoute {
  return {
    id: definition.id,
    persona,
    title: definition.title,
    summary: definition.summary,
    is_default: definition.is_default,
    is_secondary: definition.is_secondary,
    steps: drafts.map((draft, index) => ({
      id: `${definition.id}-STEP-${String(index + 1).padStart(3, "0")}`,
      rank: index + 1,
      ...draft
    }))
  };
}

function buildEvidenceCards(ctx: BuildEvidenceCardsInput): EvidenceCard[] {
  const cards: Array<{ draft: EvidenceCardDraft; score: number; sortKey: string }> = [];

  // review-surfaces.COVERAGE.3: per-changed-file coverage cards. Uncovered and
  // partial changed lines are the strongest deterministic "tests pass is weak
  // evidence" signal; fully covered files need no card. A stale report is not
  // trusted (COVERAGE.2), and no report emits no card (COVERAGE.4).
  if (ctx.coverage?.status === "report" && ctx.coverage.postdates_head !== false) {
    // review-surfaces.COVERAGE.3: PER-HUNK cards — name the exact hunk whose
    // changed lines no test executes, not merely the file.
    const hunkCards = ctx.coverage.files
      .flatMap((file) => file.hunks.filter((hunk) => hunk.classification !== "covered").map((hunk) => ({ file, hunk })))
      // Uncovered is the stronger signal: select it ahead of partial BEFORE the
      // cap so a large diff cannot silently drop a fully uncovered hunk.
      .sort((a, b) =>
        (a.hunk.classification === "uncovered" ? 0 : 1) - (b.hunk.classification === "uncovered" ? 0 : 1) ||
        (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0) ||
        (a.hunk.hunk_header < b.hunk.hunk_header ? -1 : 1)
      )
      .slice(0, 4);
    for (const { file, hunk } of hunkCards) {
      const summary = `${hunk.covered_lines} of ${hunk.changed_lines} changed line(s) in \`${file.path}\` ${hunk.hunk_header} are executed by tests.`;
      cards.push({
        score: 60 + (hunk.classification === "uncovered" ? 20 : 0),
        sortKey: `coverage:${file.path}:${hunk.hunk_header}`,
        draft: evidenceCardDraft({
          title: hunk.classification === "uncovered" ? "Changed lines uncovered" : "Changed lines partially covered",
          summary,
          evidence: [{ kind: "file", path: file.path, confidence: "high" }],
          why_it_matters: "Passing tests are weak evidence for changed lines that no test executes.",
          reviewer_action: "Inspect the uncovered changed lines or add a test that executes them.",
          source_ids: [`coverage:${file.path}:${hunk.hunk_header}`],
          risk_ids: [],
          requirement_ids: [],
          priority: hunk.classification === "uncovered" ? "high" : "medium",
          confidence: "high"
        })
      });
    }
  }

  for (const blocker of ctx.blockers.slice(0, 6)) {
    const blockerEvidence = evidenceForBlockerCard(blocker);
    cards.push({
      score: 100 + severityWeight(blocker.severity),
      sortKey: blocker.id,
      draft: evidenceCardDraft({
        title: titleFromSummary(blocker.summary),
        summary: blocker.summary,
        evidence: blockerEvidence,
        why_it_matters: "This item is a deterministic merge-readiness blocker and should be resolved before approval.",
        reviewer_action: blocker.required_action,
        source_ids: [blocker.id],
        risk_ids: riskIdsFromBlocker(blocker),
        requirement_ids: requirementIds(blockerEvidence),
        priority: priorityForSeverity(blocker.severity),
        confidence: blockerEvidence.some(isMissingEvidenceCardRef) ? "medium" : "high"
      })
    });
  }

  for (const finding of ctx.riskLensFindings.slice(0, 6)) {
    cards.push({
      score: 70 + severityWeight(finding.severity) - riskLensRank(finding.lens),
      sortKey: finding.id,
      draft: evidenceCardDraft({
        title: RISK_LENS_METADATA[finding.lens].label,
        summary: finding.summary,
        evidence: finding.evidence,
        why_it_matters: evidenceCardWhyItMattersForLens(finding.lens),
        reviewer_action: finding.reviewer_action,
        source_ids: [finding.id, ...finding.risk_ids],
        risk_ids: finding.risk_ids,
        requirement_ids: finding.requirement_ids,
        priority: priorityForSeverity(finding.severity),
        confidence: finding.confidence
      })
    });
  }

  for (const item of ctx.trustAudit.invalid_evidence.slice(0, 4)) {
    cards.push({
      score: 95,
      sortKey: item.id,
      draft: evidenceCardDraft({
        title: item.summary,
        summary: item.summary,
        evidence: item.evidence,
        why_it_matters: "Invalid evidence can make reviewer-facing claims look better supported than they are.",
        reviewer_action: "Replace the invalid evidence with a valid source or keep the claim marked as unverified.",
        source_ids: [item.id],
        risk_ids: [],
        requirement_ids: requirementIds(item.evidence),
        priority: "high",
        confidence: "low"
      })
    });
  }

  for (const item of ctx.trustAudit.missing_evidence.slice(0, 4)) {
    cards.push({
      score: 80,
      sortKey: item.id,
      draft: evidenceCardDraft({
        title: item.summary,
        summary: item.summary,
        evidence: item.evidence,
        why_it_matters: "Missing evidence keeps the reviewer from verifying a claim, check, or readiness condition.",
        reviewer_action: "Ask the author to provide the missing evidence or record an explicit deferral.",
        source_ids: [item.id],
        risk_ids: [],
        requirement_ids: requirementIds(item.evidence),
        priority: "medium",
        confidence: "medium"
      })
    });
  }

  for (const item of ctx.testPlan.filter((plan) => plan.priority === "required").slice(0, 4)) {
    const evidence = [testPlanEvidence(item)];
    cards.push({
      score: 60,
      sortKey: item.id,
      draft: evidenceCardDraft({
        title: titleFromSummary(item.scenario),
        summary: item.evidence_gap,
        evidence,
        why_it_matters: "A required test-plan item records the evidence needed to unblock review confidence.",
        reviewer_action: item.kind === "manual" ? item.scenario : `Run or add the suggested check: ${item.scenario}`,
        source_ids: [item.id],
        risk_ids: item.maps_to_risks,
        requirement_ids: item.maps_to_requirements,
        priority: item.priority === "required" ? "high" : "medium",
        confidence: "medium"
      })
    });
  }

  for (const fact of ctx.trustAudit.verified_facts.slice(0, 2)) {
    cards.push({
      score: 20,
      sortKey: fact.id,
      draft: evidenceCardDraft({
        title: titleFromSummary(fact.summary),
        summary: fact.summary,
        evidence: fact.evidence,
        why_it_matters: "This is a verified fact the reviewer can use as supporting context while reviewing the change.",
        reviewer_action: "Use this as supporting evidence; inspect only if it conflicts with higher-priority findings.",
        source_ids: [fact.id],
        risk_ids: [],
        requirement_ids: requirementIds(fact.evidence),
        priority: "low",
        confidence: "high"
      })
    });
  }

  if (cards.length === 0) {
    cards.push({
      score: 0,
      sortKey: "CARD-NO-SIGNAL",
      draft: evidenceCardDraft({
        title: "No evidence cards generated",
        summary: "The human review model did not contain enough blocker, trust, risk-lens, or test-plan evidence to build focused cards.",
        evidence: [missingEvidence("No focused evidence-card signal was available.")],
        why_it_matters: "Sparse evidence should lower reviewer confidence rather than create a false approval signal.",
        reviewer_action: "Generate the review with PR scope, command transcripts, and parsed artifacts when available.",
        source_ids: ["READY-NO-SIGNAL"],
        risk_ids: [],
        requirement_ids: [],
        priority: "low",
        confidence: "unknown"
      })
    });
  }

  return dedupeEvidenceCardDrafts(cards)
    .sort((left, right) => right.score - left.score || compareStrings(left.sortKey, right.sortKey))
    .slice(0, MAX_EVIDENCE_CARDS)
    .map(({ draft }, index) => ({
      id: `CARD-${String(index + 1).padStart(3, "0")}`,
      ...draft
    }));
}

function evidenceForBlockerCard(blocker: ReviewBlocker): EvidenceRef[] {
  if (/manual check/i.test(blocker.required_action) && !blocker.evidence.some(isMissingEvidenceCardRef)) {
    return [...blocker.evidence, missingEvidence(`Missing manual-check evidence: ${blocker.required_action}`)];
  }
  return blocker.evidence;
}

function evidenceCardDraft(input: {
  title: string;
  summary: string;
  evidence: EvidenceRef[];
  why_it_matters: string;
  reviewer_action: string;
  source_ids: string[];
  risk_ids: string[];
  requirement_ids: string[];
  confidence: PacketConfidence;
  priority: HumanReviewPriority;
}): EvidenceCardDraft {
  const split = splitEvidenceCardRefs(evidenceOrMissing(input.evidence, input.summary));
  return {
    title: input.title,
    status: evidenceCardStatus(split),
    summary: input.summary,
    direct_evidence: split.direct,
    missing_evidence: split.missing,
    invalid_evidence: split.invalid,
    why_it_matters: input.why_it_matters,
    reviewer_action: input.reviewer_action,
    source_ids: compactStrings(input.source_ids),
    risk_ids: compactStrings(input.risk_ids),
    requirement_ids: compactStrings(input.requirement_ids),
    confidence: input.confidence,
    priority: input.priority
  };
}

// review-surfaces.COLD_START.4/.5: single source of truth for "is this a
// spec-less run". intent is a typed IntentModel with a non-optional spec_mode, so
// no defensive cast is needed.
function isSpeclessIntent(intent: ReviewPacket["intent"]): boolean {
  return intent.spec_mode === "none";
}

function splitEvidenceCardRefs(evidence: EvidenceRef[]): { direct: EvidenceRef[]; missing: EvidenceRef[]; invalid: EvidenceRef[] } {
  const direct: EvidenceRef[] = [];
  const missing: EvidenceRef[] = [];
  const invalid: EvidenceRef[] = [];
  // Single ordered partition: each ref lands in exactly one bucket (or is dropped
  // when it matches none), in input order — equivalent to the prior three filter
  // passes but without the repeated negated predicates.
  for (const ref of dedupeEvidenceRefs(evidence)) {
    if (isInvalidTrustEvidence(ref)) {
      invalid.push(ref);
    } else if (isMissingEvidenceCardRef(ref)) {
      missing.push(ref);
    } else if (isVerifiedTrustEvidence(ref)) {
      direct.push(ref);
    }
  }
  return { direct, missing, invalid };
}

function isMissingEvidenceCardRef(ref: EvidenceRef): boolean {
  return ref.kind === "unknown" || ref.validation_status === "unknown";
}

function evidenceCardStatus(split: { direct: EvidenceRef[]; missing: EvidenceRef[]; invalid: EvidenceRef[] }): EvidenceCard["status"] {
  const hasInvalid = split.invalid.length > 0;
  const hasMissing = split.missing.length > 0;
  const hasDirect = split.direct.length > 0;
  // More than one non-empty bucket is "mixed"; otherwise the single populated
  // bucket decides (direct splits into verified vs unchecked); none is "unknown".
  if ([hasInvalid, hasMissing, hasDirect].filter(Boolean).length > 1) {
    return "mixed";
  }
  if (hasInvalid) {
    return "invalid_evidence";
  }
  if (hasMissing) {
    return "missing_evidence";
  }
  if (hasDirect) {
    return split.direct.every(isVerifiedEvidenceCardRef) ? "verified" : "unchecked";
  }
  return "unknown";
}

function isVerifiedEvidenceCardRef(ref: EvidenceRef): boolean {
  return ref.validation_status === "valid" || ref.verified === true;
}

function evidenceCardWhyItMattersForLens(lens: RiskLens): string {
  switch (lens) {
    case "security_privacy":
      return "Security and privacy changes can expose secrets or sensitive material if trusted boundaries are wrong.";
    case "llm_trust_boundary":
      return "LLM trust-boundary changes decide whether generated prose can surface unsupported claims to reviewers.";
    case "api_contract":
      return "Contract changes can break persisted artifacts, CLI users, or downstream integrations.";
    case "test_evidence":
      return "Test-evidence changes affect whether the reviewer can trust validation and coverage claims.";
    case "reviewer_ux":
      return "Reviewer-facing output changes affect whether humans see blockers, evidence, and next actions clearly.";
    case "supply_chain":
      return "New or changed dependencies alter what third-party code runs at install or build time — exactly where supply-chain overreach hides.";
    case "architecture":
      return "A new dependency edge between modules that never depended on each other changes the system's shape — layering violations look locally reasonable in every single hunk.";
    case "cache_provenance":
      return "Cache and provenance changes affect whether generated artifacts remain reproducible and fresh.";
    case "custom":
      return "Custom risk-lens findings reflect local team policy or repository-specific review focus.";
  }
}

function dedupeEvidenceCardDrafts(
  cards: Array<{ draft: EvidenceCardDraft; score: number; sortKey: string }>
): Array<{ draft: EvidenceCardDraft; score: number; sortKey: string }> {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = `${card.draft.title}|${card.draft.source_ids.join(",")}|${card.draft.summary}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function humanReviewerRouteSteps(ctx: BuildReviewRoutesInput): ReviewRouteStepDraft[] {
  return [
    routeStep(ctx, {
      title: "Merge readiness verdict",
      action: `Start with the ${ctx.verdict.decision} verdict and resolve blocker-level reasons before detailed diff review.`,
      priority: ctx.verdict.decision === "block_before_merge" ? "blocker" : "high",
      artifact: "human_review.md",
      evidence: ctx.verdict.reasons.flatMap((reason) => reason.evidence)
    }),
    routeStep(ctx, {
      title: "Top review queue",
      action: "Inspect the top-ranked path-backed review queue items before skimming lower-risk files.",
      priority: highestQueuePriority(ctx.reviewQueue),
      artifact: "review_queue.md",
      queue_item_ids: ctx.reviewQueue.slice(0, 5).map((item) => item.id),
      evidence: ctx.reviewQueue.slice(0, 5).flatMap((item) => item.evidence)
    }),
    routeStep(ctx, {
      title: "Blockers and author questions",
      action: "Turn deterministic blockers and blocking/clarifying questions into review comments or author follow-up.",
      priority: ctx.blockers.length > 0 ? "blocker" : "high",
      artifact: "human_review.md",
      question_ids: ctx.questions.slice(0, 5).map((question) => question.id),
      evidence: [...ctx.blockers.flatMap((blocker) => blocker.evidence), ...ctx.questions.slice(0, 5).flatMap((question) => question.evidence)]
    }),
    routeStep(ctx, {
      title: "Trust audit and test plan",
      action: "Check missing/invalid evidence and run or request the required test-plan items before approval.",
      priority: ctx.testPlan.some((item) => item.priority === "required") ? "high" : "medium",
      artifact: "trust_audit.md",
      test_plan_ids: ctx.testPlan.slice(0, 5).map((item) => item.id),
      evidence: [...ctx.trustAudit.missing_evidence.flatMap((item) => item.evidence), ...ctx.testPlan.slice(0, 5).flatMap(testPlanEvidence)]
    })
  ];
}

function maintainerRouteSteps(ctx: BuildReviewRoutesInput): ReviewRouteStepDraft[] {
  const contractLenses = ctx.riskLensFindings.filter((finding) => finding.lens === "api_contract" || finding.paths.some(isMaintainerContractPath));
  const blockingComments = ctx.suggestedComments.filter((comment) => comment.severity === "blocking");
  return [
    routeStep(ctx, {
      title: "Merge readiness verdict",
      action: "Confirm the verdict, confidence, and required actions line up with repository merge policy.",
      priority: ctx.verdict.decision === "block_before_merge" ? "blocker" : "high",
      artifact: "human_review.md",
      evidence: ctx.verdict.reasons.flatMap((reason) => reason.evidence)
    }),
    routeStep(ctx, {
      title: "Schema, CLI, and artifact contracts",
      action: "Review schema, CLI, config, feature-ledger, and persisted artifact contract changes for compatibility or versioning.",
      priority: contractLenses.some((finding) => isElevatedSeverity(finding.severity)) ? "blocker" : "high",
      artifact: "risk_lenses.md",
      risk_lens_ids: contractLenses.map((finding) => finding.id),
      evidence: contractLenses.flatMap((finding) => finding.evidence)
    }),
    routeStep(ctx, {
      title: "Required tests and manual checks",
      action: "Verify required test-plan items exist for changed contracts and required manual checks are recorded.",
      priority: ctx.testPlan.some((item) => item.priority === "required") ? "high" : "medium",
      artifact: "test_plan.md",
      test_plan_ids: ctx.testPlan.filter((item) => item.priority === "required").slice(0, 6).map((item) => item.id),
      evidence: ctx.testPlan.filter((item) => item.priority === "required").slice(0, 6).flatMap(testPlanEvidence)
    }),
    routeStep(ctx, {
      title: "Blocking suggested comments",
      action: "Use blocking comment drafts only when their cited evidence still applies to the current head.",
      priority: blockingComments.length > 0 ? "high" : "medium",
      artifact: "suggested_comments.md",
      suggested_comment_ids: blockingComments.slice(0, 5).map((comment) => comment.id),
      evidence: blockingComments.slice(0, 5).flatMap((comment) => comment.evidence)
    })
  ];
}

function securityRouteSteps(ctx: BuildReviewRoutesInput): ReviewRouteStepDraft[] {
  const securityLenses = ctx.riskLensFindings.filter((finding) => finding.lens === "security_privacy" || finding.lens === "llm_trust_boundary");
  const securityQueue = ctx.reviewQueue.filter((item) => routeText(item.title, item.reason, item.reviewer_action, item.path).match(/\b(secret|security|privacy|provider|redact|llm|prompt|anchor|workflow|ci)\b/i));
  const manualChecks = ctx.testPlan.filter((item) => item.kind === "manual" || routeText(item.scenario, item.evidence_gap).match(/\b(secret|security|privacy|manual|provider|redact|ci)\b/i));
  const privacyAuditGaps = [...ctx.trustAudit.missing_evidence, ...ctx.trustAudit.invalid_evidence]
    .filter((item) => routeText(item.summary).match(/\b(secret|security|privacy|provider|redact|llm|ci)\b/i));
  return [
    routeStep(ctx, {
      title: "Security and LLM trust-boundary lenses",
      action: securityLenses.length > 0
        ? "Review security/privacy and LLM trust-boundary lens findings before lower-risk implementation changes."
        : "No security/privacy or LLM trust-boundary lens fired; skim unless the changed files manually imply that boundary.",
      priority: securityLenses.length === 0 ? "low" : securityLenses.some((finding) => isElevatedSeverity(finding.severity)) ? "blocker" : "high",
      artifact: "risk_lenses.md",
      risk_lens_ids: securityLenses.map((finding) => finding.id),
      evidence: securityLenses.flatMap((finding) => finding.evidence)
    }),
    routeStep(ctx, {
      title: "CI, provider, and redaction paths",
      action: securityQueue.length > 0
        ? "Inspect workflow, provider, prompt, anchor-validation, and redaction changes that can affect trust boundaries."
        : "No CI, provider, prompt, anchor-validation, or redaction queue item was detected for this review.",
      priority: highestQueuePriority(securityQueue),
      artifact: "review_queue.md",
      queue_item_ids: securityQueue.slice(0, 6).map((item) => item.id),
      evidence: securityQueue.slice(0, 6).flatMap((item) => item.evidence)
    }),
    routeStep(ctx, {
      title: "Manual security checks",
      action: manualChecks.length > 0
        ? "Confirm required manual security/privacy checks are recorded against the current head, not as future intent."
        : "No manual security/privacy check was generated for this review.",
      priority: manualChecks.length === 0 ? "low" : manualChecks.some((item) => item.priority === "required") ? "blocker" : "high",
      artifact: "test_plan.md",
      test_plan_ids: manualChecks.slice(0, 6).map((item) => item.id),
      evidence: manualChecks.slice(0, 6).flatMap(testPlanEvidence)
    }),
    routeStep(ctx, {
      title: "Privacy and trust audit gaps",
      action: privacyAuditGaps.length > 0
        ? "Treat missing privacy, secret-boundary, provider, or LLM evidence as clarification work before approval."
        : "No privacy, secret-boundary, provider, or LLM trust-audit gap was detected for this review.",
      priority: privacyAuditGaps.length > 0 ? "high" : "low",
      artifact: "trust_audit.md",
      evidence: privacyAuditGaps.flatMap((item) => item.evidence)
    })
  ];
}

function productRouteSteps(ctx: BuildReviewRoutesInput): ReviewRouteStepDraft[] {
  const uxLenses = ctx.riskLensFindings.filter((finding) => finding.lens === "reviewer_ux");
  const routeQuestions = ctx.questions.filter((question) => routeText(question.question, question.reason).match(/\b(intent|reviewer|human|surface|comment|markdown|output|ux|baseline)\b/i));
  const intentItems = [
    ...ctx.intentMismatch.possible_mismatches,
    ...ctx.intentMismatch.possible_overreach,
    ...ctx.intentMismatch.missing_intent
  ];
  return [
    routeStep(ctx, {
      title: "Intent and reviewer workflow fit",
      action: intentItems.length > 0
        ? "Start with the intent-mismatch surface and resolve possible mismatch, overreach, or missing-intent items before relying on lower-risk UX review."
        : "Check whether the changed surface still gives reviewers the fastest safe path through the PR.",
      priority: intentItems.some((item) => isElevatedSeverity(item.severity)) || routeQuestions.some((question) => question.severity === "blocking") ? "high" : "medium",
      artifact: "intent_mismatch.md",
      question_ids: routeQuestions.slice(0, 5).map((question) => question.id),
      evidence: [...intentItems.slice(0, 5).flatMap((item) => item.evidence), ...routeQuestions.slice(0, 5).flatMap((question) => question.evidence)]
    }),
    routeStep(ctx, {
      title: "Reviewer UX lens",
      action: "Review renderer, Markdown, comment, queue, and diagram changes for human readability and bounded output.",
      priority: uxLenses.some((finding) => isElevatedSeverity(finding.severity)) ? "high" : "medium",
      artifact: "risk_lenses.md",
      risk_lens_ids: uxLenses.map((finding) => finding.id),
      evidence: uxLenses.flatMap((finding) => finding.evidence)
    }),
    routeStep(ctx, {
      title: "Human review output",
      action: "Read the generated human review summary and standalone artifacts before relying on lower-level packet details.",
      priority: "medium",
      artifact: "human_review.md",
      evidence: routeEvidence(ctx.input, "Human review route points reviewers at generated human_review.md and standalone human artifacts.")
    }),
    routeStep(ctx, {
      title: "Suggested comments",
      action: "Use suggested comments as evidence-backed drafts, and keep non-blocking drafts separate from merge blockers.",
      priority: ctx.suggestedComments.some((comment) => comment.severity === "blocking") ? "high" : "medium",
      artifact: "suggested_comments.md",
      suggested_comment_ids: ctx.suggestedComments.slice(0, 6).map((comment) => comment.id),
      evidence: ctx.suggestedComments.slice(0, 6).flatMap((comment) => comment.evidence)
    })
  ];
}

function agentContinuationRouteSteps(ctx: BuildReviewRoutesInput): ReviewRouteStepDraft[] {
  const openRiskEvidence = [...ctx.blockers.flatMap((blocker) => blocker.evidence), ...ctx.riskLensFindings.flatMap((finding) => finding.evidence)];
  return [
    routeStep(ctx, {
      title: "Open risks and blockers",
      action: "Start continuation work from deterministic blockers, high-risk lenses, and still-open risk evidence.",
      priority: ctx.blockers.length > 0 ? "blocker" : "high",
      artifact: "human_review.md",
      risk_lens_ids: ctx.riskLensFindings.slice(0, 6).map((finding) => finding.id),
      evidence: openRiskEvidence
    }),
    routeStep(ctx, {
      title: "Missing tests and manual checks",
      action: "Implement or record the required test-plan items before changing reviewer-facing summaries.",
      priority: ctx.testPlan.some((item) => item.priority === "required") ? "high" : "medium",
      artifact: "test_plan.md",
      test_plan_ids: ctx.testPlan.slice(0, 8).map((item) => item.id),
      evidence: ctx.testPlan.slice(0, 8).flatMap(testPlanEvidence)
    }),
    routeStep(ctx, {
      title: "Since-last-review open items",
      action: "Prioritize regressed, new, and still-open items before adding unrelated features.",
      priority: ctx.sinceLastReview.regressed.length > 0 || ctx.sinceLastReview.new_risks.length > 0 ? "high" : "medium",
      artifact: "since_last_review.md",
      evidence: [
        ...ctx.sinceLastReview.regressed,
        ...ctx.sinceLastReview.new_risks,
        ...ctx.sinceLastReview.still_open
      ].flatMap((item) => item.evidence)
    }),
    routeStep(ctx, {
      title: "Agent handoff and deferrals",
      action: "Use the generated agent handoff for next tasks and deferrals, but keep it secondary to the human route.",
      priority: "low",
      artifact: "agent_handoff.md",
      evidence: routeEvidence(ctx.input, "Agent-continuation route points at agent_handoff.md as the secondary continuation surface.")
    })
  ];
}

function routeStep(
  ctx: BuildReviewRoutesInput,
  draft: Omit<ReviewRouteStepDraft, "evidence" | "queue_item_ids" | "risk_lens_ids" | "question_ids" | "test_plan_ids" | "suggested_comment_ids"> &
    Partial<Pick<ReviewRouteStepDraft, "evidence" | "queue_item_ids" | "risk_lens_ids" | "question_ids" | "test_plan_ids" | "suggested_comment_ids">>
): ReviewRouteStepDraft {
  return {
    ...draft,
    evidence: routeStepEvidence(ctx.input, draft.title, draft.evidence ?? []),
    queue_item_ids: draft.queue_item_ids ?? [],
    risk_lens_ids: draft.risk_lens_ids ?? [],
    question_ids: draft.question_ids ?? [],
    test_plan_ids: draft.test_plan_ids ?? [],
    suggested_comment_ids: draft.suggested_comment_ids ?? []
  };
}

function routeStepEvidence(input: BuildHumanReviewInput, title: string, evidence: EvidenceRef[]): EvidenceRef[] {
  const refs = evidence.length ? evidence : routeEvidence(input, `Review route step "${title}" is derived from the generated human review model.`);
  return dedupeEvidenceRefs(refs).slice(0, 8);
}

function routeEvidence(input: BuildHumanReviewInput, note: string): EvidenceRef[] {
  return [fileEvidence(input.packetPath ?? ".review-surfaces/review_packet.json", note, "medium")];
}

function dedupeEvidenceRefs(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((ref) => {
    const key = evidenceRefDedupeKey(ref);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function testPlanEvidence(item: TestPlanItem): EvidenceRef {
  return missingEvidence(item.evidence_gap);
}

function highestQueuePriority(items: ReviewQueueItem[]): HumanReviewPriority {
  if (items.some((item) => item.priority === "blocker")) {
    return "blocker";
  }
  if (items.some((item) => item.priority === "high")) {
    return "high";
  }
  if (items.some((item) => item.priority === "medium")) {
    return "medium";
  }
  return "low";
}

function isMaintainerContractPath(filePath: string): boolean {
  return /^schemas\//.test(filePath) ||
    /^src\/cli\//.test(filePath) ||
    /^features\//.test(filePath) ||
    /(?:^|\/)contract\.ts$/.test(filePath) ||
    /schema/i.test(filePath);
}

function routeText(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => typeof value === "string").join(" ");
}

function buildIntentMismatch(input: BuildHumanReviewInput, specMode: "acai" | "none"): IntentMismatch {
  const focus = buildIntentMismatchFocus(input);
  // review-surfaces.COLD_START.5: a spec-less repo gets NO spec-shaped
  // mismatch/overreach/missing-intent items — only the observed diff facts and
  // the one-line honest note. Provider-claimed candidates still render: they are
  // explicitly marked unconfirmed and exist precisely for sparse-intent repos.
  if (specMode === "none") {
    return {
      spec_note: SPEC_NONE_NOTE,
      expected_by_spec: [],
      observed_in_diff: cappedIntentMismatchItems("INTENT-OBSERVED", observedDiffDrafts(input)),
      possible_mismatches: [],
      possible_overreach: [],
      missing_intent: [],
      claimed_candidates: cappedIntentMismatchItems("INTENT-CLAIMED", claimedCandidateDrafts(input))
    };
  }
  return {
    expected_by_spec: cappedIntentMismatchItems("INTENT-EXPECTED", expectedIntentDrafts(input, focus)),
    observed_in_diff: cappedIntentMismatchItems("INTENT-OBSERVED", observedDiffDrafts(input)),
    possible_mismatches: cappedIntentMismatchItems("INTENT-MISMATCH", possibleMismatchDrafts(input, focus)),
    possible_overreach: cappedIntentMismatchItems("INTENT-OVERREACH", possibleOverreachDrafts(input, focus)),
    missing_intent: cappedIntentMismatchItems("INTENT-MISSING", missingIntentDrafts(input)),
    // review-surfaces.INTENT.7: provider-claimed candidates render distinctly;
    // they widen what the human is asked to confirm and never touch coverage.
    claimed_candidates: cappedIntentMismatchItems("INTENT-CLAIMED", claimedCandidateDrafts(input))
  };
}

function claimedCandidateDrafts(input: BuildHumanReviewInput): IntentMismatchDraft[] {
  const candidates = (input.packet.intent as { claimed_candidates?: Array<{ statement?: unknown; anchors?: unknown; confidence?: unknown }> }).claimed_candidates;
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates
    .filter((candidate) => typeof candidate.statement === "string")
    .slice(0, 6)
    .map((candidate) => {
      const anchors = Array.isArray(candidate.anchors) ? candidate.anchors.filter((a): a is string => typeof a === "string") : [];
      const acidAnchors = anchors.filter((anchor) => /^[A-Za-z][\w-]*\.[A-Za-z][\w-]*\.\d+$/.test(anchor));
      const pathAnchors = anchors.filter((anchor) => !acidAnchors.includes(anchor));
      return {
        summary: `Provider-claimed intent (confirm, do not trust): ${candidate.statement as string}`,
        evidence: [
          ...pathAnchors.map((anchor) => fileEvidence(anchor, "Validated candidate anchor.")),
          ...acidAnchors.map((anchor) => ({ kind: "spec" as const, acai_id: anchor, note: "Validated candidate ACID anchor.", confidence: "low" as const }))
        ],
        requirement_ids: acidAnchors,
        paths: pathAnchors,
        confidence: "low" as const
      };
    });
}

function expectedIntentDrafts(input: BuildHumanReviewInput, focus: IntentMismatchFocus): IntentMismatchDraft[] {
  const exact = input.packet.intent.requirements.filter((requirement) => intentRequirementKeys(requirement).some((key) => focus.exactRequirementKeys.has(key)));
  const scoped = input.packet.intent.requirements.filter((requirement) =>
    intentRequirementKeys(requirement).some((key) => focus.scopedRequirementKeys.has(key)) &&
    !intentRequirementKeys(requirement).some((key) => focus.exactRequirementKeys.has(key))
  );
  const requirements = exact.length > 0 ? exact : scoped.length > 0 ? scoped : input.packet.intent.requirements;
  return requirements
    .slice(0, MAX_INTENT_MISMATCH_ITEMS)
    .map((requirement) => ({
      summary: `${requirement.acai_id ?? requirement.id}: ${requirement.requirement}`,
      evidence: evidenceOrMissing(
        requirement.source_refs.flatMap((ref) => ref.evidence ?? []),
        `${requirement.acai_id ?? requirement.id} was expected by packet intent.`
      ),
      requirement_ids: compactStrings([requirement.acai_id, requirement.id]),
      paths: compactStrings(requirement.source_refs.map((ref) => ref.ref)),
      confidence: requirement.confidence
    }));
}

function observedDiffDrafts(input: BuildHumanReviewInput): IntentMismatchDraft[] {
  const acidKeysByPath = diffAcidKeysByPath(input.diff);
  return intentObservedFiles(input)
    .slice()
    .sort((left, right) => compareStrings(left.path, right.path))
    .slice(0, MAX_INTENT_MISMATCH_ITEMS)
    .map((file) => {
      const areas = changedFileAreas(file);
      const exactRequirements = sortedDiffAcidKeysForFile(acidKeysByPath, file);
      const sourceSpec = isSourceSpecFile(file.path);
      const requirements = exactRequirements.length > 0
        ? exactRequirements
        : sourceSpec
          ? []
          : input.prSurface ? affectedRequirementIdsForFile(input.prSurface, file) : [];
      const mappingText = exactRequirements.length > 0
        ? ` references exact requirement(s) ${exactRequirements.join(", ")}`
        : sourceSpec
          ? " changes source-of-truth spec intent; inspect expected-by-spec items for exact requirement impact"
        : areas.length
          ? ` maps to area(s) ${areas.join(", ")}`
          : " has no mapped review area";
      return {
        summary: `Changed ${file.role} file \`${file.path}\`${mappingText}.`,
        evidence: [fileEvidence(file.path, "Changed file observed in PR scope.", "high")],
        requirement_ids: requirements,
        paths: compactStrings([file.path, file.old_path]),
        confidence: requirements.length > 0 || (!sourceSpec && areas.length > 0) ? "high" : "medium"
      };
    });
}

function possibleMismatchDrafts(input: BuildHumanReviewInput, focus: IntentMismatchFocus): IntentMismatchDraft[] {
  const candidates = input.packet.evaluation.results
    .filter((result) => result.status === "missing" || result.status === "partial" || result.status === "unknown" || result.status === "invalid_evidence")
    .sort((left, right) => mismatchStatusRank(left.status) - mismatchStatusRank(right.status) || compareStrings(requirementComparisonKey(left), requirementComparisonKey(right)));
  const focusedResults = candidates.filter((result) =>
    intentMismatchResultIsStrictlyInFocus(result, focus) ||
    requirementResultKeys(result).some((key) => focus.scopedRequirementKeys.has(key))
  ).sort((left, right) => compareFocusedMismatch(left, right, focus));
  const results = focusedResults.length > 0
    ? focusedResults
    : input.prSurface
      ? []
      : candidates;

  return results.slice(0, MAX_INTENT_MISMATCH_ITEMS).map((result) => {
    const evidence = requirementGapEvidence(result);
    return {
      summary: `${intentMismatchStatusLabel(result.status)} for ${requirementComparisonKey(result)}: ${result.summary}`,
      evidence,
      requirement_ids: compactStrings([result.acai_id, result.requirement_id]),
      paths: evidencePaths(evidence),
      confidence: result.confidence,
      severity: mismatchSeverity(result.status)
    };
  });
}

function possibleOverreachDrafts(input: BuildHumanReviewInput, focus: IntentMismatchFocus): IntentMismatchDraft[] {
  const packetOverreachResults = (input.packet.evaluation.overreach ?? [])
    .filter((result) =>
      input.prSurface === undefined ||
      intentMismatchResultIsStrictlyInFocus(result, focus) ||
      requirementResultKeys(result).some((key) => focus.scopedRequirementKeys.has(key))
    );
  const packetOverreach = packetOverreachResults.map((result) => {
    const evidence = requirementGapEvidence(result);
    return {
      summary: `Possible overreach for ${requirementComparisonKey(result)}: ${result.summary}`,
      evidence,
      requirement_ids: compactStrings([result.acai_id, result.requirement_id]),
      paths: evidencePaths(evidence),
      confidence: result.confidence,
      severity: "medium" as const
    };
  });

  const prOverreach = (input.prSurface?.scope.out_of_scope_changed_files ?? [])
    .filter((file) => file.reason === "unmapped")
    .map((file) => ({
      summary: `Out-of-scope changed file \`${file.path}\` is not mapped to stated intent.`,
      evidence: [fileEvidence(file.path, "PR scope classified this changed file as unmapped.", "high")],
      requirement_ids: [],
      paths: [file.path],
      confidence: "high" as const,
      severity: "medium" as const
    }));

  return [...packetOverreach, ...prOverreach];
}

function missingIntentDrafts(input: BuildHumanReviewInput): IntentMismatchDraft[] {
  const changedFiles = intentObservedFiles(input);
  const outOfScopePaths = new Set(
    (input.prSurface?.scope.out_of_scope_changed_files ?? [])
      .filter((file) => file.reason === "unmapped")
      .map((file) => normalizeEvidencePath(file.path))
  );
  const ignoredOrGeneratedPaths = new Set(
    (input.prSurface?.scope.out_of_scope_changed_files ?? [])
      .filter((file) => file.reason === "generated" || file.reason === "ignored")
      .map((file) => normalizeEvidencePath(file.path))
  );
  const drafts: IntentMismatchDraft[] = [];
  for (const file of changedFiles) {
    if (ignoredOrGeneratedPaths.has(normalizeEvidencePath(file.path))) {
      continue;
    }
    if (file.role === "generated") {
      continue;
    }
    const requirementIds = input.prSurface ? affectedRequirementIdsForFile(input.prSurface, file) : [];
    if (!outOfScopePaths.has(normalizeEvidencePath(file.path)) && changedFileAreas(file).length > 0 && requirementIds.length > 0) {
      continue;
    }
    drafts.push({
      summary: `No explicit requirement mapping was found for changed file \`${file.path}\`.`,
      evidence: [fileEvidence(file.path, "Changed file has missing or ambiguous intent mapping.", "medium")],
      requirement_ids: requirementIds,
      paths: compactStrings([file.path, file.old_path]),
      confidence: "medium" as const,
      severity: "medium" as const
    });
    if (drafts.length >= MAX_INTENT_MISMATCH_ITEMS) {
      break;
    }
  }

  if (input.packet.intent.requirements.length === 0) {
    drafts.push({
      summary: "No local intent requirements were available to compare against the diff.",
      evidence: [missingEvidence("Packet intent contains no requirements.")],
      requirement_ids: [],
      paths: [],
      confidence: "unknown",
      severity: "high"
    });
  }

  return drafts;
}

function cappedIntentMismatchItems(prefix: string, drafts: IntentMismatchDraft[]): IntentMismatchItem[] {
  const seen = new Set<string>();
  return drafts
    .filter((draft) => {
      const key = `${draft.summary}|${draft.paths.join(",")}|${draft.requirement_ids.join(",")}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, MAX_INTENT_MISMATCH_ITEMS)
    .map((draft, index) =>
      stripUndefined({
        id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
        summary: draft.summary,
        evidence: evidenceOrMissing(draft.evidence, draft.summary),
        requirement_ids: draft.requirement_ids,
        paths: draft.paths,
        confidence: draft.confidence,
        severity: draft.severity
      })
    );
}

function buildIntentMismatchFocus(input: BuildHumanReviewInput): IntentMismatchFocus {
  const exactRequirementKeys = diffAcidKeys(input.diff);
  const changedPaths = input.prSurface ? prChangedFilePaths(input.prSurface) : diffChangedFilePaths(input.diff);
  const scopedRequirementKeys = new Set<string>([...exactRequirementKeys]);
  for (const requirement of input.prSurface?.scope.affected_requirements ?? []) {
    if (affectedRequirementReasons(requirement).some((reason) => reason.path && changedPaths.has(normalizeEvidencePath(reason.path)))) {
      for (const key of compactStrings([requirement.acai_id, requirement.requirement_id])) {
        scopedRequirementKeys.add(key);
      }
    }
  }
  for (const delta of input.prSurface?.coverage.deltas ?? []) {
    const evidence = [...(delta.head_evidence ?? []), ...(delta.missing_evidence ?? [])];
    if (evidence.some((ref) => ref.kind !== "spec" && ref.path && changedPaths.has(normalizeEvidencePath(ref.path)))) {
      for (const key of compactStrings([delta.acai_id, delta.requirement_id])) {
        scopedRequirementKeys.add(key);
      }
    }
  }
  return { exactRequirementKeys, scopedRequirementKeys, changedPaths };
}

function intentObservedFiles(input: BuildHumanReviewInput): IntentObservedFile[] {
  if (input.prSurface) {
    return input.prSurface.scope.changed_files;
  }
  return (input.diff?.files ?? []).map((file) => {
    const counts = diffChangedLineCounts(file);
    return {
      path: file.path,
      old_path: file.old_path,
      status: file.status,
      areas: [],
      role: classifyRole(file.path, []),
      added_lines: counts.added,
      deleted_lines: counts.deleted
    };
  });
}

function diffChangedFilePaths(diff: StructuredDiff | undefined): Set<string> {
  const paths = new Set<string>();
  for (const file of diff?.files ?? []) {
    for (const filePath of compactStrings([file.path, file.old_path])) {
      paths.add(normalizeEvidencePath(filePath));
    }
  }
  return paths;
}

function diffChangedLineCounts(file: StructuredDiffFile): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        added += 1;
      } else if (line.kind === "delete") {
        deleted += 1;
      }
    }
  }
  return { added, deleted };
}

function diffAcidKeys(diff: StructuredDiff | undefined): Set<string> {
  const keys = new Set<string>();
  for (const file of diff?.files ?? []) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (!isChangedDiffLine(line.kind)) {
          continue;
        }
        for (const key of changedLineAcidKeys(line.text)) {
          keys.add(key);
        }
      }
    }
  }
  return keys;
}

function diffAcidKeysByPath(diff: StructuredDiff | undefined): Map<string, Set<string>> {
  const keysByPath = new Map<string, Set<string>>();
  for (const file of diff?.files ?? []) {
    const keys = new Set<string>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (!isChangedDiffLine(line.kind)) {
          continue;
        }
        for (const key of changedLineAcidKeys(line.text)) {
          keys.add(key);
        }
      }
    }
    if (keys.size === 0) {
      continue;
    }
    for (const filePath of compactStrings([file.path, file.old_path])) {
      keysByPath.set(normalizeEvidencePath(filePath), keys);
    }
  }
  return keysByPath;
}

function sortedDiffAcidKeysForFile(
  keysByPath: Map<string, Set<string>>,
  file: Pick<PrChangedFile, "path" | "old_path">
): string[] {
  const keys = new Set<string>();
  for (const filePath of compactStrings([file.path, file.old_path])) {
    for (const key of keysByPath.get(normalizeEvidencePath(filePath)) ?? []) {
      keys.add(key);
    }
  }
  return [...keys].sort(compareStrings);
}

function changedLineAcidKeys(text: string): string[] {
  return [...text.matchAll(ACID_PATTERN)]
    .filter((match) => isWholeAcidToken(text, match.index ?? 0, match[0]))
    .map((match) => match[0]);
}

function isChangedDiffLine(kind: StructuredDiff["files"][number]["hunks"][number]["lines"][number]["kind"]): boolean {
  return kind === "add" || kind === "delete";
}

function isSourceSpecFile(filePath: string): boolean {
  return /^features\//.test(normalizeEvidencePath(filePath));
}

function isAcidPrefixChar(ch: string): boolean {
  return ch !== "" && /[A-Za-z0-9_.-]/.test(ch);
}

function isAcidSuffixContinuation(text: string, index: number): boolean {
  const ch = index < text.length ? text[index] : "";
  if (ch === "") {
    return false;
  }
  if (/[A-Za-z0-9_-]/.test(ch)) {
    return true;
  }
  if (ch === ".") {
    const next = index + 1 < text.length ? text[index + 1] : "";
    return /[A-Za-z0-9_-]/.test(next);
  }
  return false;
}

function isWholeAcidToken(text: string, index: number, acid: string): boolean {
  const before = index > 0 ? text[index - 1] : "";
  return !isAcidPrefixChar(before) && !isAcidSuffixContinuation(text, index + acid.length);
}

function intentMismatchResultIsStrictlyInFocus(result: RequirementGap, focus: IntentMismatchFocus): boolean {
  return (
    requirementResultKeys(result).some((key) => focus.exactRequirementKeys.has(key)) ||
    [...(result.evidence ?? []), ...(result.missing_evidence ?? [])].some((ref) => ref.kind !== "spec" && ref.path && focus.changedPaths.has(normalizeEvidencePath(ref.path)))
  );
}

function compareFocusedMismatch(left: RequirementGap, right: RequirementGap, focus: IntentMismatchFocus): number {
  return (
    blockingMismatchRank(left.status) - blockingMismatchRank(right.status) ||
    intentMismatchFocusRank(left, focus) - intentMismatchFocusRank(right, focus) ||
    mismatchStatusRank(left.status) - mismatchStatusRank(right.status) ||
    compareStrings(requirementComparisonKey(left), requirementComparisonKey(right))
  );
}

function blockingMismatchRank(status: RequirementGap["status"]): number {
  return status === "invalid_evidence" || status === "missing" ? 0 : 1;
}

function intentMismatchFocusRank(result: RequirementGap, focus: IntentMismatchFocus): number {
  const keys = requirementResultKeys(result);
  if (keys.some((key) => focus.exactRequirementKeys.has(key))) {
    return 0;
  }
  if ([...(result.evidence ?? []), ...(result.missing_evidence ?? [])].some((ref) => ref.kind !== "spec" && ref.path && focus.changedPaths.has(normalizeEvidencePath(ref.path)))) {
    return 1;
  }
  if (keys.some((key) => focus.scopedRequirementKeys.has(key))) {
    return 2;
  }
  return 3;
}

function intentRequirementKeys(requirement: ReviewPacket["intent"]["requirements"][number]): string[] {
  return compactStrings([requirement.acai_id, requirement.id]);
}

function requirementResultKeys(result: RequirementGap): string[] {
  return compactStrings([result.acai_id, result.requirement_id]);
}

function intentMismatchStatusLabel(status: RequirementGap["status"]): string {
  switch (status) {
    case "missing":
      return "Missing implementation evidence";
    case "partial":
      return "Partial implementation evidence";
    case "unknown":
      return "Ambiguous intent evidence";
    case "invalid_evidence":
      return "Invalid evidence";
    default:
      return "Possible mismatch";
  }
}

function mismatchStatusRank(status: RequirementGap["status"]): number {
  switch (status) {
    case "invalid_evidence":
      return 0;
    case "missing":
      return 1;
    case "unknown":
      return 2;
    case "partial":
      return 3;
    default:
      return 4;
  }
}

function mismatchSeverity(status: RequirementGap["status"]): PacketSeverity {
  switch (status) {
    case "invalid_evidence":
    case "missing":
      return "high";
    case "unknown":
    case "partial":
      return "medium";
    default:
      return "unknown";
  }
}

function buildSinceLastReview(input: BuildHumanReviewInput): SinceLastReview {
  const previousPacketPath = input.packet.dogfood?.previous_packet_path;
  const comparison = input.packet.dogfood?.comparison;
  const empty = emptySinceLastReview(previousPacketPath);
  if (!previousPacketPath) {
    return {
      ...empty,
      unavailable_reason: "No previous packet was supplied; pass --previous-packet to compare review rounds."
    };
  }
  if (!comparison) {
    return {
      ...empty,
      unavailable_reason: `Previous packet ${previousPacketPath} was absent or unreadable; no comparison computed.`
    };
  }

  // review-surfaces.COLD_START.5: a spec-less comparison keeps the risk deltas
  // (diff-derived value) but drops the requirement- and overreach-shaped slices
  // a prior Acai-era packet may carry.
  const specless = isSpeclessIntent(input.packet.intent);
  const statusChanges = specless ? [] : comparison.status_changes ?? [];
  const improved = statusChanges
    .filter((change) => change.direction === "improved")
    .map((change, index) => statusChangeItem(input, "SLR-IMPROVED", index, change));
  const regressed = statusChanges
    .filter((change) => change.direction === "regressed")
    .map((change, index) => statusChangeItem(input, "SLR-REGRESSED", index, change));
  const currentRisksByKey = new Map(input.packet.risks.items.map((risk) => [comparisonRiskKey(risk), risk]));

  return {
    previous_packet_path: previousPacketPath,
    improved,
    regressed,
    new_risks: riskComparisonItems(input, "SLR-NEW-RISK", comparison.new_risks ?? [], "New risk since last review", currentRisksByKey),
    resolved_risks: riskComparisonItems(input, "SLR-RESOLVED-RISK", comparison.resolved_risks ?? [], "Resolved risk since last review"),
    new_overreach: specless ? [] : overreachComparisonItems(input, "SLR-NEW-OVERREACH", comparison.new_overreach ?? [], "New overreach since last review"),
    resolved_overreach: specless ? [] : overreachComparisonItems(input, "SLR-RESOLVED-OVERREACH", comparison.resolved_overreach ?? [], "Resolved overreach since last review"),
    still_open: stillOpenSinceLastReviewItems(input, comparison, specless),
    count_deltas: specless ? emptyCountDeltas() : comparison.count_deltas ?? emptyCountDeltas()
  };
}

function emptySinceLastReview(previousPacketPath?: string): SinceLastReview {
  return {
    previous_packet_path: previousPacketPath,
    improved: [],
    regressed: [],
    new_risks: [],
    resolved_risks: [],
    new_overreach: [],
    resolved_overreach: [],
    still_open: [],
    count_deltas: emptyCountDeltas()
  };
}

function emptyCountDeltas(): SinceLastReview["count_deltas"] {
  return {
    satisfied: { before: 0, after: 0, delta: 0 },
    partial: { before: 0, after: 0, delta: 0 },
    missing: { before: 0, after: 0, delta: 0 },
    unknown: { before: 0, after: 0, delta: 0 },
    invalid_evidence: { before: 0, after: 0, delta: 0 }
  };
}

function statusChangeItem(
  input: BuildHumanReviewInput,
  prefix: string,
  index: number,
  change: { acai_id: string; previous_status: string; current_status: string; direction: "improved" | "regressed" | "unchanged" }
): SinceLastReviewItem {
  return {
    id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
    category: "requirement",
    acai_id: change.acai_id,
    previous_status: change.previous_status,
    current_status: change.current_status,
    direction: change.direction,
    // review-surfaces.TREND.3: the bucket emoji + arrow already encode direction;
    // the trailing "(improved/regressed)" parenthetical is a third copy. `direction`
    // stays a structured field for machine consumers.
    summary: `${change.acai_id}: ${change.previous_status} -> ${change.current_status}.`,
    evidence: [comparisonEvidence(input, `Previous-packet comparison reported ${change.direction} status movement for ${change.acai_id}.`, change.acai_id)]
  };
}

function riskComparisonItems(
  input: BuildHumanReviewInput,
  prefix: string,
  riskKeys: string[],
  label: string,
  currentRisksByKey?: Map<string, ReviewPacket["risks"]["items"][number]>
): SinceLastReviewItem[] {
  return riskKeys.map((key, index) => {
    const currentRisk = currentRisksByKey?.get(key);
    return {
      id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
      category: "risk",
      severity: currentRisk?.severity ?? "unknown",
      // review-surfaces.TREND.3: the section header ("Resolved risks" / "New
      // risks") already names the direction; drop the per-bullet "<label>:"
      // echo. The label is preserved in the evidence prose below.
      summary: `${trimSentenceEnd(key)}.`,
      evidence: [comparisonEvidence(input, `${label} from previous-packet comparison: ${key}.`)]
    };
  });
}

function overreachComparisonItems(input: BuildHumanReviewInput, prefix: string, paths: string[], label: string): SinceLastReviewItem[] {
  return paths.map((filePath, index) => ({
    id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
    category: "overreach",
    path: filePath,
    // review-surfaces.TREND.3: the section header already names the direction.
    summary: `${filePath}.`,
    evidence: [comparisonEvidence(input, `${label} from previous-packet comparison for ${filePath}.`)]
  }));
}

function stillOpenSinceLastReviewItems(
  input: BuildHumanReviewInput,
  comparison: NonNullable<ReviewPacket["dogfood"]>["comparison"],
  specless = false
): SinceLastReviewItem[] {
  if (!comparison) {
    return [];
  }
  const changedRequirementKeys = new Set((comparison.status_changes ?? []).map((change) => change.acai_id));
  const newRiskKeys = new Set(comparison.new_risks ?? []);
  const newOverreachPaths = new Set(comparison.new_overreach ?? []);
  const currentOverreachPaths = new Set(
    (input.packet.evaluation.overreach ?? []).flatMap((result) => (result.evidence ?? []).map((ref) => ref.path).filter((filePath): filePath is string => Boolean(filePath)))
  );

  const persistentRequirements = input.packet.evaluation.results
    .filter((result) => result.status !== "satisfied")
    .filter((result) => !changedRequirementKeys.has(requirementComparisonKey(result)))
    .map((result) => ({
      category: "requirement" as const,
      acai_id: requirementComparisonKey(result),
      current_status: result.status,
      summary: `${requirementComparisonKey(result)} remains ${result.status}.`,
      evidence: [comparisonEvidence(input, `Current packet still reports ${requirementComparisonKey(result)} as ${result.status}.`, requirementComparisonKey(result))]
    }));

  const persistentRisks = input.packet.risks.items
    .filter((risk) => !newRiskKeys.has(comparisonRiskKey(risk)))
    .map((risk) => ({
      category: "risk" as const,
      severity: risk.severity,
      summary: `Risk still open: ${comparisonRiskKey(risk)}.`,
      evidence: [comparisonEvidence(input, `Current packet still reports risk ${comparisonRiskKey(risk)}.`)]
    }));

  const persistentOverreach = [...currentOverreachPaths]
    .filter((filePath) => !newOverreachPaths.has(filePath))
    .map((filePath) => ({
      category: "overreach" as const,
      path: filePath,
      summary: `Overreach still open: ${filePath}.`,
      evidence: [comparisonEvidence(input, `Current packet still reports overreach for ${filePath}.`)]
    }));

  // review-surfaces.COLD_START.5: spec-less still-open items keep only the
  // risk slice — requirement and overreach persistence is spec-shaped.
  const stillOpen = specless ? persistentRisks : [...persistentRequirements, ...persistentRisks, ...persistentOverreach];
  return stillOpen
    .sort((left, right) => compareStrings(`${left.category}:${left.summary}`, `${right.category}:${right.summary}`))
    .slice(0, 12)
    .map((item, index) => ({ id: `SLR-STILL-OPEN-${String(index + 1).padStart(3, "0")}`, ...item }));
}

function comparisonEvidence(input: BuildHumanReviewInput, note: string, acaiId?: string): EvidenceRef {
  return {
    kind: "file",
    path: input.packetPath ?? ".review-surfaces/review_packet.json",
    acai_id: acaiId,
    note,
    confidence: "high",
    validation_status: "valid"
  };
}

function requirementComparisonKey(result: { acai_id?: string; requirement_id?: string }): string {
  return result.acai_id || result.requirement_id || "unmapped";
}

function trimSentenceEnd(value: string): string {
  return value.replace(/[.!?]+$/u, "");
}

function buildVerdict(input: BuildHumanReviewInput, blockers: ReviewBlocker[], trustAudit: TrustAudit): HumanReviewVerdict {
  const reasons: HumanReviewVerdictReason[] = [];
  let decision: HumanReviewDecision = "no_signal";

  for (const blocker of blockers) {
    reasons.push({
      id: blocker.id,
      severity: blocker.severity,
      summary: blocker.summary,
      evidence: blocker.evidence,
      required_action: blocker.required_action
    });
  }

  if (blockers.length > 0) {
    decision = "block_before_merge";
  } else if (input.prSurface?.status === "blocked") {
    decision = input.prSurface.blocked_reason === "no_diff" ? "no_signal" : "needs_author_clarification";
    reasons.push({
      id: "READY-PR-SURFACE-BLOCKED",
      severity: input.prSurface.blocked_reason === "no_diff" ? "low" : "medium",
      summary: `PR review surface is blocked (${input.prSurface.blocked_reason ?? "unknown"}).`,
      evidence: [missingEvidence("PR surface narrative is unavailable; deterministic scope is still available.")],
      required_action: "Regenerate the PR surface with the required provider or review deterministic facts locally."
    });
  } else if (trustAudit.missing_evidence.length > 0 || trustAudit.claimed_not_verified.length > 0) {
    decision = "needs_author_clarification";
    reasons.push({
      id: "READY-MISSING-EVIDENCE",
      severity: "medium",
      summary: "Required review evidence is missing or claimed without proof.",
      evidence: trustAudit.missing_evidence[0]?.evidence ?? [missingEvidence("Missing evidence lowers readiness confidence.")],
      required_action: "Record validation evidence or answer the generated reviewer questions."
    });
    // review-surfaces.HUMAN_TRUST.6: a soft, off-diff "missing manual check" must
    // not be the SOLE headline reason while in-diff high-severity lenses (a
    // schema/API-contract break, a weakened test) sit unmentioned in the verdict
    // block. Surface the top such risk co-equally so the headline names the
    // concrete in-diff risk too — without changing the decision precedence.
    if (hasRiskAtLeast(input, "medium")) {
      reasons.push({
        id: "READY-RISKS-PRESENT",
        severity: "medium",
        summary: reviewableRiskReasonSummary(input, "medium"),
        evidence: firstRiskEvidenceAtLeast(input, "medium"),
        required_action: "Review the ranked queue before approving."
      });
    }
  } else if (hasRiskAtLeast(input, "medium")) {
    decision = "reviewable_with_attention";
    // review-surfaces.HUMAN_TRUST.6: name the concrete medium+ risk and cite the
    // risk that crossed the threshold here too, not just in the missing-evidence
    // branch — otherwise a low-then-medium risk surface still gets a generic reason.
    reasons.push({
      id: "READY-RISKS-PRESENT",
      severity: "medium",
      summary: reviewableRiskReasonSummary(input, "medium"),
      evidence: firstRiskEvidenceAtLeast(input, "medium"),
      required_action: "Review the ranked queue before approving."
    });
  } else if (hasPositiveValidationEvidence(input.packet.risks)) {
    decision = "probably_safe";
    reasons.push({
      id: "READY-POSITIVE-EVIDENCE",
      severity: "low",
      summary: "No high-risk blockers were detected and validation evidence is present.",
      evidence: positiveValidationEvidence(input.packet.risks).slice(0, 3)
    });
  }

  if (reasons.length === 0) {
    reasons.push({
      id: "READY-NO-SIGNAL",
      severity: "unknown",
      summary: "Not enough review signal was available to make a readiness claim.",
      evidence: [missingEvidence("No PR surface, risk evidence, or validation evidence was available.")],
      required_action: "Generate a packet with diff and validation evidence."
    });
  }

  return {
    decision,
    confidence: confidenceForDecision(decision, blockers, trustAudit),
    reasons: reasons.slice(0, MAX_BLOCKERS)
  };
}

function buildBlockers(input: BuildHumanReviewInput, feedbackEffects: FeedbackPolicyEffect[]): ReviewBlocker[] {
  const blockers: ReviewBlocker[] = [];
  const prSurface = input.prSurface;

  if (prSurface?.blocked_reason === "privacy_block") {
    blockers.push({
      id: "BLOCK-PRIVACY-001",
      severity: "high",
      summary: "A privacy or secret guard blocked the PR review surface.",
      evidence: [missingEvidence("Remote provider call was blocked by privacy checks.")],
      required_action: "Inspect redaction/secret findings and rerun only after sensitive material is removed or excluded."
    });
  }

  const failedTestEvidence = failedValidationEvidence(input);
  if (failedTestEvidence.length > 0) {
    blockers.push({
      id: "BLOCK-TESTS-001",
      severity: "high",
      summary: "Validation evidence records failing tests.",
      evidence: failedTestEvidence.flatMap((item) => item.evidence ?? [missingEvidence(item.summary)]).slice(0, 6),
      required_action: "Fix or explicitly defer the failing validation before merge."
    });
  }

  for (const risk of allCriticalRisks(input).slice(0, 3)) {
    blockers.push({
      id: `BLOCK-${risk.id}`,
      severity: "critical",
      summary: risk.summary,
      evidence: risk.evidence.length ? risk.evidence : [missingEvidence("Critical risk has no path-bearing evidence.")],
      required_action: risk.suggested_checks[0] ?? "Resolve or explicitly defer the critical risk."
    });
  }

  const secretBoundary = prSurface?.risks.candidates.find((risk) => risk.rule === "ci_secret_boundary_change");
  if (secretBoundary && !hasRecordedCiSecretBoundaryManualCheck(input)) {
    blockers.push({
      id: "BLOCK-CI-SECRET-001",
      severity: "high",
      summary: "CI / secret-boundary files changed without recorded manual check evidence.",
      evidence: evidenceOrMissing(secretBoundary.evidence, "CI / secret-boundary risk needs file evidence."),
      required_action: "Record a manual check confirming PR-controlled code cannot access secrets."
    });
  }

  for (const effect of feedbackEffects.filter(isMissingTeamPolicyEffect).slice(0, 4)) {
    blockers.push({
      id: `BLOCK-${stableFeedbackEffectId(effect.id)}`,
      severity: "high",
      summary: effect.summary,
      evidence: feedbackEffectEvidence(effect),
      required_action: effect.action
    });
  }

  return dedupeById(blockers).slice(0, MAX_BLOCKERS);
}

function buildReviewQueue(
  input: BuildHumanReviewInput,
  feedbackEffects: FeedbackPolicyEffect[],
  config: HumanReviewBuildConfig,
  semanticFacts: SemanticChangeFacts
): HumanReviewModel["review_queue"] {
  const drafts: QueueDraft[] = [];
  const prChangedPaths = input.prSurface ? prChangedFilePaths(input.prSurface) : undefined;
  const diffIndex = buildDiffIndex(input.diff);
  let prRiskQueueItemCount = 0;

  // review-surfaces.SEMANTIC_DIFF.4: concrete change facts rank near the top with
  // field/signature/test-weakening language, not generic path-touch phrasing.
  drafts.push(...semanticQueueDrafts(semanticFacts, diffIndex));
  drafts.push(...dependencyQueueDrafts(input.dependencyFacts ?? [], diffIndex));
  // review-surfaces.ARCH_DRIFT.2: drift facts route into the risk register.
  drafts.push(...archDriftQueueDrafts(input.archDrift?.facts ?? [], diffIndex));
  drafts.push(...configFactQueueDrafts(input.configFacts ?? [], diffIndex));

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    const first = firstPathEvidence(risk.evidence);
    if (!first) {
      continue;
    }
    const aggregate = !normalizedEvidenceRange(first) && evidenceSpansMultiplePaths(risk.evidence);
    const anchor = queueAnchorForEvidence(first, diffIndex, aggregate);
    const feedbackDowngrade = feedbackFalsePositiveEffectForRisk(risk, feedbackEffects, first.path);
    // review-surfaces.POLICY.2: committed policy outranks local feedback. A
    // current (non-expired) suppression matching the STABLE key (rule + path
    // glob) demotes the item — downgrade + annotate, never delete.
    const policySuppression = matchPolicySuppression(input.policy, risk.rule, first.path ?? "", input.policyNowIso ?? "");
    const policyOverride = matchPolicySeverityOverride(input.policy, risk.rule, first.path ?? "");
    const suppressedByPolicy = policySuppression && !policySuppression.expired ? policySuppression.suppression : undefined;
    prRiskQueueItemCount += 1;
    drafts.push({
      title: titleForPrRisk(risk),
      path: anchor.path,
      old_path: anchor.old_path,
      hunk_header: anchor.hunk_header,
      line_start: anchor.line_start,
      line_end: anchor.line_end,
      anchor_side: anchor.side,
      reviewer_action: risk.suggested_checks[0] ?? "Inspect the cited changed file before approving.",
      reason: suppressedByPolicy
        ? `${rankReasonForPrRisk(risk)} Suppressed by policy: ${suppressedByPolicy.reason} (expires ${suppressedByPolicy.expires}); the evidence-backed item is retained.`
        : feedbackDowngrade
          ? `${rankReasonForPrRisk(risk)} Feedback memory downgraded this review priority but retained the evidence-backed item.`
          : rankReasonForPrRisk(risk),
      evidence: feedbackDowngrade
        ? [...evidenceOrMissing(risk.evidence, risk.summary), ...feedbackDowngrade.evidence]
        : evidenceOrMissing(risk.evidence, risk.summary),
      requirement_ids: requirementIds(risk.evidence),
      risk_ids: [risk.id],
      confidence: anchor.line_start || anchor.hunk_header ? "high" : "medium",
      priority: suppressedByPolicy ? "low" : policyOverride ? policyOverride.priority : feedbackDowngrade ? "low" : priorityForSeverity(risk.severity),
      estimated_review_effort: effortForSeverity(risk.severity),
      // A policy severity override re-ranks consistently with the displayed
      // priority (not just the label), so an upgraded item survives the queue cap.
      score:
        (policyOverride ? scorePrRiskWithPriority(risk, anchor, policyOverride.priority) : scorePrRisk(risk, anchor)) +
        (suppressedByPolicy || feedbackDowngrade ? -60 : 0),
      sortKey: `${risk.id}:${first.path}`
    });
  }

  drafts.push(...feedbackReviewQueueDrafts(feedbackEffects, diffIndex));

  // The prSurface changed-file fallback is ITSELF a floor (already capped to the floor
  // budget). Count what it adds so the baseline augmentation below does not pile onto a
  // fallback-only queue and bust that budget (Codex #117 round-2).
  let fallbackDraftCount = 0;
  if (input.prSurface && prRiskQueueItemCount === 0) {
    const beforeFallback = drafts.length;
    drafts.push(...changedFileQueueDrafts(input.prSurface, diffIndex));
    fallbackDraftCount = drafts.length - beforeFallback;
  }

  for (const risk of input.packet.risks.items) {
    const first = prChangedPaths
      ? firstPathEvidenceInScope(risk.evidence ?? [], prChangedPaths)
      : firstPathEvidence(risk.evidence ?? []);
    if (!first) {
      continue;
    }
    // review-surfaces.RANKING.4: every packet risk (from analyzeRisks) is an
    // aggregate statistic over requirement results — none is a concrete single-file
    // fact — so any one without a real line anchor must render at file level. A
    // path-diversity test would miss an aggregate whose evidence (or capped sample)
    // all points at one file (e.g. several requirements in one spec file).
    const aggregate = !normalizedEvidenceRange(first);
    const anchor = queueAnchorForEvidence(first, diffIndex, aggregate);
    drafts.push({
      title: aggregate ? aggregateRiskTitle(risk) : titleFromSummary(risk.summary),
      path: anchor.path,
      old_path: anchor.old_path,
      hunk_header: anchor.hunk_header,
      line_start: anchor.line_start,
      line_end: anchor.line_end,
      anchor_side: anchor.side,
      reviewer_action: risk.suggested_checks?.[0] ?? "Inspect the cited packet risk evidence.",
      // review-surfaces.HUMAN_REVIEW.21: lead with the underlying reason (the
      // risk summary), not "ranked from whole-packet <severity> <category> risk
      // <id>". The risk id stays in risk_ids / trailing queue metadata.
      reason: reviewerReasonFromSummary(risk.summary, `Changed file in a ${risk.category} risk area; inspect it before approving.`),
      evidence: evidenceOrMissing(risk.evidence ?? [], risk.summary),
      requirement_ids: requirementIds(risk.evidence ?? []),
      risk_ids: [risk.id],
      confidence: anchor.line_start || anchor.hunk_header ? "high" : "medium",
      priority: priorityForSeverity(risk.severity),
      estimated_review_effort: effortForSeverity(risk.severity),
      score: severityWeight(risk.severity) + 10 + (anchor.line_start ? 5 : 0) + (anchor.hunk_header ? 5 : 0),
      sortKey: `${risk.id}:${first.path}`
    });
  }

  // Cold-start review-focus floor (review-surfaces.HUMAN_REVIEW.28): rank the changed
  // files by DETERMINISTIC signals (churn, exported surface, an impl file with no
  // connected changed test, sensitive error/async/auth/persistence paths) and surface
  // the files most worth reading, WITHOUT fabricating any risk or blocker.
  const baselineDrafts = baselineReviewFocusDrafts(input, diffIndex, semanticFacts);
  // The queue is "fallback-only" when its sole content is the prSurface changed-file
  // fallback (no real detector finding) — that fallback already IS the floor, so it neither
  // needs nor should receive baseline augmentation on top of its budget (Codex #117 r2).
  const realDetectorDraftCount = drafts.length - fallbackDraftCount;
  if (drafts.length === 0) {
    // Empty queue (spec-less / nothing structural fired): the floor IS the queue, capped to
    // the floor's own budget.
    drafts.push(...baselineDrafts.slice(0, MAX_CHANGED_FILE_QUEUE));
  } else if (realDetectorDraftCount > 0) {
    // Non-empty but possibly THIN: a lone dependency/config detector finding (e.g. a
    // package.json version bump) can be the only queue item while the diff's substantive
    // SOURCE goes unranked and hidden. Augment with review-focus items for IMPLEMENTATION
    // files no existing draft already covers — by path OR rename old_path — so the source a
    // reviewer should read is never buried under a dependency/config finding. Only impl
    // source is added (low-noise), and only within the queue's remaining HEADROOM so
    // augmentation never evicts the detector item that motivated it (Codex #117).
    const coveredPaths = new Set<string>();
    for (const draft of drafts) {
      if (draft.path) {
        coveredPaths.add(draft.path);
      }
      if (draft.old_path) {
        coveredPaths.add(draft.old_path);
      }
    }
    const headroom = Math.max(0, Math.min(MAX_QUEUE, config.max_review_first) - drafts.length);
    const augment = baselineDrafts
      .filter((draft) => {
        const path = draft.path;
        if (!path || coveredPaths.has(path)) {
          return false;
        }
        if (draft.old_path && coveredPaths.has(draft.old_path)) {
          return false;
        }
        return baselineFileRole(path) === "impl";
      })
      .slice(0, Math.min(headroom, MAX_CHANGED_FILE_QUEUE))
      .map((draft) => ({
        ...draft,
        // A detector DID produce a finding for this diff — just not for this file — so the
        // augmented item must not claim "no detector produced a ranked finding" (Codex #117).
        reason: draft.reason.replace(
          "No risk rule produced a ranked finding here, but this is among the changed files most worth reading:",
          "Another finding was queued for this diff, and this changed source is also worth reading:"
        ),
        baseline: draft.baseline?.replace(
          "ranked by deterministic change signals (no detector produced a ranked finding):",
          "ranked by deterministic change signals (surfaced alongside a detector finding):"
        )
      }));
    drafts.push(...augment);
  }

  // review-surfaces.RANKING.1/.3: annotate each draft with its evidence tier and
  // "why ranked here" lines, then sort. Evidence is the SECONDARY key — it breaks
  // ties and demotes well-evidenced items within a score band — so the primary
  // score (semantic-risk class) always wins and evidence never hides or reclasses
  // an item.
  applyRankingEvidence(drafts, input, input.rankingEvidence ?? emptyRankingEvidence());

  drafts.sort(
    (left, right) =>
      right.score - left.score ||
      (left.evidenceTier ?? 0) - (right.evidenceTier ?? 0) ||
      compareStrings(left.sortKey, right.sortKey)
  );
  return drafts.slice(0, Math.min(MAX_QUEUE, config.max_review_first)).map((draft, index) =>
    stripUndefined({
      id: `REVIEW-${String(index + 1).padStart(3, "0")}`,
      rank: index + 1,
      title: draft.title,
      path: draft.path,
      old_path: draft.old_path,
      hunk_header: draft.hunk_header,
      line_start: draft.line_start,
      line_end: draft.line_end,
      anchor_side: draft.anchor_side,
      reviewer_action: draft.reviewer_action,
      reason: draft.reason,
      ranking_reasons: draft.ranking_reasons ?? [defaultRankReason(draft)],
      evidence: draft.evidence,
      requirement_ids: draft.requirement_ids,
      risk_ids: draft.risk_ids,
      confidence: draft.confidence,
      priority: draft.priority,
      estimated_review_effort: draft.estimated_review_effort
    })
  );
}

// review-surfaces.RANKING.1/.2/.3: assign each queue item an evidence ordering
// tier (a SECONDARY sort key — see buildReviewQueue) and a plain-language "why
// ranked here" line. A changed impl with a focused test changed alongside it (or
// validated in its review area) is demoted within its band; one flagged untested
// is promoted. Evidence never changes the primary score, so it cannot reorder an
// item across a risk class.
function applyRankingEvidence(drafts: QueueDraft[], input: BuildHumanReviewInput, evidence: RankingEvidence): void {
  const changedTestsByImpl = evidence.changed_tests_by_impl;
  const untestedImplPaths = untestedChangedImplPaths(input.prSurface);
  const changedImplPaths = changedImplPathSet(input.prSurface);
  // review-surfaces.COVERAGE.3: a current (non-stale) report feeds the score;
  // a stale report is recorded but never trusted (COVERAGE.2), and no report
  // means no coverage signal at all (COVERAGE.4 — absence is never a penalty).
  const coverage = input.coverageEvidence;
  const coverageByPath = new Map(
    coverage?.status === "report" && coverage.postdates_head !== false
      ? coverage.files.map((file) => [file.path, file] as const)
      : []
  );
  for (const draft of drafts) {
    const reasons: string[] = [];
    const tests = changedTestsByImpl[draft.path];
    if (tests && tests.length > 0) {
      draft.evidenceTier = 1;
      // review-surfaces.RANKING.2: cap the inline co-changed test list (it can run
      // to ~10 backtick paths) to a readable sample + "(+N more)", mirroring the
      // blast-radius "(top: ...)" idiom. The full set stays in the JSON model.
      const shownTests = tests.slice(0, 3).map((t) => `\`${t}\``).join(", ");
      const moreTests = tests.length > 3 ? ` (+${tests.length - 3} more)` : "";
      reasons.push(`a focused test changed alongside this file (${shownTests}${moreTests}), so it ranks lower among equal-severity items`);
    } else if (untestedImplPaths.has(draft.path)) {
      draft.evidenceTier = -1;
      reasons.push("no changed test or current-head transcript covers this file, so it ranks higher among equal-severity items");
    } else if (changedImplPaths.has(draft.path)) {
      // Not flagged untested: a changed test in its review area OR a current-head
      // passing transcript cleared it (the two validation paths the PR risk rule
      // treats equally) — so name both, not transcript alone.
      draft.evidenceTier = 1;
      reasons.push("a changed test or current-head transcript covers this file's review area, so it ranks lower among equal-severity items");
    }
    const fileCoverage = coverageByPath.get(draft.path);
    if (fileCoverage) {
      if (fileCoverage.classification === "uncovered") {
        draft.evidenceTier = Math.min(draft.evidenceTier ?? 0, -1);
        reasons.push(`none of its ${fileCoverage.changed_lines} changed line(s) are executed by any test, so it ranks higher among equal-severity items`);
      } else if (fileCoverage.classification === "covered") {
        draft.evidenceTier = Math.max(draft.evidenceTier ?? 0, 1);
        reasons.push(`all ${fileCoverage.changed_lines} changed line(s) are executed by tests, so it ranks lower among equal-severity items`);
      } else {
        // Partial coverage: uncovered changed lines remain — neutralize any
        // demotion from co-changed tests rather than leaving it purely prose.
        draft.evidenceTier = Math.min(draft.evidenceTier ?? 0, 0);
        reasons.push(`${fileCoverage.covered_lines} of ${fileCoverage.changed_lines} changed line(s) are executed by tests`);
      }
    }
    if (reasons.length === 0) {
      // A cold-start baseline item has no risk class, so it must not render "ranked by
      // <priority> risk severity" — use its deterministic signal instead (Codex #112).
      reasons.push(draft.baseline ?? defaultRankReason(draft));
    }
    draft.ranking_reasons = reasons;
  }
}

// Cited implementation paths the PR risk pass flagged as untested. This
// deliberately REUSES the deterministic untested_changed_impl rule (no changed
// test in area AND no current-head passing test transcript) rather than
// recomputing the transcript/area validation here — the rule is the single
// source of that signal, and duplicating its logic would be the worse coupling.
function untestedChangedImplPaths(prSurface: PrReviewSurfaceModel | undefined): Set<string> {
  const paths = new Set<string>();
  for (const risk of prSurface?.risks.candidates ?? []) {
    if (risk.rule !== "untested_changed_impl") {
      continue;
    }
    for (const ref of risk.evidence) {
      if (ref.kind === "file" && ref.path) {
        paths.add(ref.path);
      }
    }
  }
  return paths;
}

function changedImplPathSet(prSurface: PrReviewSurfaceModel | undefined): Set<string> {
  const paths = new Set<string>();
  for (const file of prSurface?.scope.changed_files ?? []) {
    if (file.role === "implementation") {
      paths.add(file.path);
    }
  }
  return paths;
}

// A fallback "why ranked here" line for items with no path-evidence signal (the
// item ranks on its deterministic risk class and diff-anchor precision).
function defaultRankReason(draft: QueueDraft): string {
  const anchor = draft.line_start || draft.hunk_header ? "with a precise diff anchor" : "at file level";
  return `ranked by ${draft.priority} risk severity ${anchor}`;
}

// review-surfaces.SEMANTIC_DIFF.1/.2/.3/.4: turn the semantic facts into
// review-queue items with concrete, field/signature/test-weakening language.
// They score high so they rank near the top of the surface.
// review-surfaces.DEP_FACTS.2: dependency facts rank as concrete supply-chain
// queue items naming the package and the change ("adds `leftpad@2` ...").
function dependencyQueueDrafts(facts: DependencyFact[], diffIndex: DiffIndex | undefined): QueueDraft[] {
  // Select by SEVERITY before capping: an alphabetically late install-script
  // fact must not be dropped by six earlier ordinary additions.
  const ordered = [...facts].sort(
    (a, b) => dependencyFactSeverityRank(a.kind) - dependencyFactSeverityRank(b.kind) || (a.package < b.package ? -1 : a.package > b.package ? 1 : 0)
  );
  return ordered.slice(0, 6).map((fact, index) => {
    const rank = dependencyFactSeverityRank(fact.kind);
    return semanticDraft(diffIndex, {
      title: "Dependency change",
      path: fact.source_path,
      reason: `${fact.detail}.`,
      reviewer_action: "Confirm the dependency change is intentional, vetted, and appropriately pinned.",
      priority: rank <= 1 ? "high" : "medium",
      score: (rank === 0 ? 230 : 150) - index,
      sortKey: `dependency:${fact.kind}:${fact.package}`
    });
  });
}

// CI/Docker/SQL kinds where agent overreach is most dangerous rank high.
function isHighSeverityConfigFact(kind: ConfigFact["kind"]): boolean {
  return (
    kind === "ci_permissions_broadened" ||
    kind === "ci_pull_request_target_added" ||
    kind === "docker_curl_pipe_shell" ||
    kind === "sql_destructive_statement"
  );
}

// review-surfaces.CONFIG_FACTS.1-3: config/infra facts rank as concrete queue
// items; the language flags for attention rather than proving semantics.
function configFactQueueDrafts(facts: ConfigFact[], diffIndex: DiffIndex | undefined): QueueDraft[] {
  // High-severity kinds (CI/Docker/SQL) are selected ahead of the cap so earlier
  // low-risk env facts cannot crowd them out.
  const ordered = [...facts].sort(
    (a, b) =>
      (isHighSeverityConfigFact(a.kind) ? 0 : 1) - (isHighSeverityConfigFact(b.kind) ? 0 : 1) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      (a.detail < b.detail ? -1 : 1)
  );
  return ordered.slice(0, 6).map((fact, index) => semanticDraft(diffIndex, {
    title: configFactTitle(fact.kind),
    path: fact.path,
    reason: `${fact.detail}.`,
    reviewer_action: "Inspect the flagged change before approving.",
    priority: isHighSeverityConfigFact(fact.kind) ? "high" : "medium",
    score: 145 - index,
    sortKey: `config:${fact.kind}:${fact.path}:${fact.detail}`
  }));
}

function configFactTitle(kind: ConfigFact["kind"]): string {
  switch (kind) {
    case "env_var_added":
    case "env_var_removed":
    case "env_example_key_change":
      return "Environment variable change";
    case "ci_permissions_broadened":
    case "ci_new_secret_reference":
    case "ci_pull_request_target_added":
    case "ci_unpinned_action":
      return "CI workflow change";
    case "docker_curl_pipe_shell":
    case "docker_base_image_changed":
    case "docker_user_dropped":
      return "Dockerfile change";
    case "sql_destructive_statement":
      return "Destructive migration statement";
  }
}

function semanticQueueDrafts(facts: SemanticChangeFacts, diffIndex: DiffIndex | undefined): QueueDraft[] {
  const drafts: QueueDraft[] = [];
  for (const [index, signal] of facts.test_weakening.entries()) {
    drafts.push(semanticDraft(diffIndex, {
      title: testWeakeningTitle(signal.kind),
      path: signal.path,
      reason: signal.detail,
      reviewer_action: "Confirm the test change does not silently drop or weaken coverage.",
      priority: "high",
      score: 240 - index,
      sortKey: `semantic-test:${signal.kind}:${signal.path}`
    }));
  }
  for (const [index, change] of facts.schema_changes.entries()) {
    const breaking = change.required_added.length > 0 || change.properties_removed.length > 0 || change.type_changes.length > 0;
    drafts.push(semanticDraft(diffIndex, {
      title: "Schema contract change",
      path: change.path,
      reason: schemaChangeReason(change),
      reviewer_action: "Confirm the contract change is versioned or existing artifacts are migrated before merge.",
      priority: breaking ? "high" : "medium",
      score: 200 - index,
      sortKey: `semantic-schema:${change.path}`
    }));
  }
  for (const [index, change] of facts.api_changes.entries()) {
    const breaking = change.exports_removed.length > 0 || change.signatures_changed.length > 0;
    drafts.push(semanticDraft(diffIndex, {
      title: "Exported API surface change",
      path: change.path,
      reason: apiChangeReason(change),
      reviewer_action: "Confirm callers of the changed exports are updated.",
      priority: breaking ? "high" : "medium",
      // review-surfaces.BLAST_RADIUS.2: a removed/changed export with many
      // importers outranks one with none (bounded so blast radius cannot lift
      // an API change above test-weakening signals).
      score: 160 - index + Math.min(change.used_by?.count ?? 0, 20),
      sortKey: `semantic-api:${change.path}`
    }));
  }
  // review-surfaces.SEMANTIC_DIFF.5: Swift declaration changes — concrete
  // language, public/package breaks outrank additive/internal changes.
  for (const [index, change] of facts.swift_declaration_changes.entries()) {
    drafts.push(semanticDraft(diffIndex, {
      title: swiftDeclarationTitle(change),
      path: change.path,
      reason: change.detail,
      reviewer_action:
        change.change === "removed"
          ? "Confirm callers/conformers of the removed Swift declaration are updated or it is intentionally dropped."
          : "Confirm the Swift declaration change is intended and callers/conformers are updated.",
      priority: change.breaking ? "high" : change.change === "added" ? "low" : "medium",
      score: 150 - index + (change.breaking ? 20 : 0),
      sortKey: `semantic-swift:${change.change}:${change.path}:${change.name}`
    }));
  }
  return drafts;
}

function swiftDeclarationTitle(change: SwiftDeclarationChange): string {
  const verb = change.change === "added" ? "added" : change.change === "removed" ? "removed" : "changed";
  return `Swift declaration ${verb}`;
}

function semanticDraft(
  diffIndex: DiffIndex | undefined,
  fields: { title: string; path: string; reason: string; reviewer_action: string; priority: HumanReviewPriority; score: number; sortKey: string }
): QueueDraft {
  const evidence = fileEvidence(fields.path, "Semantic change fact.");
  const anchor = queueAnchorForEvidence(evidence, diffIndex);
  return {
    title: fields.title,
    path: anchor.path,
    old_path: anchor.old_path,
    hunk_header: anchor.hunk_header,
    line_start: anchor.line_start,
    line_end: anchor.line_end,
    anchor_side: anchor.side,
    reviewer_action: fields.reviewer_action,
    reason: fields.reason,
    evidence: [evidence],
    requirement_ids: [],
    risk_ids: [],
    confidence: "high",
    priority: fields.priority,
    estimated_review_effort: "moderate",
    score: fields.score,
    sortKey: fields.sortKey
  };
}

function testWeakeningTitle(kind: TestWeakeningSignal["kind"]): string {
  switch (kind) {
    case "deleted_test_file":
      return "Test weakening: deleted test file";
    case "removed_test_method":
      return "Test weakening: removed test method";
    case "skipped_test":
      return "Test weakening: newly skipped test";
    case "removed_assertion":
      return "Test weakening: removed assertion";
    case "regenerated_snapshot":
      return "Test weakening: regenerated snapshot";
  }
}

function schemaChangeReason(change: SchemaContractChange): string {
  const parts: string[] = [];
  if (change.required_added.length > 0) {
    parts.push(`field(s) ${joinIds(change.required_added)} became required — existing artifacts without them will fail validation`);
  }
  if (change.required_removed.length > 0) {
    parts.push(`field(s) ${joinIds(change.required_removed)} no longer required`);
  }
  if (change.properties_removed.length > 0) {
    parts.push(`propert(ies) ${joinIds(change.properties_removed)} removed`);
  }
  if (change.properties_added.length > 0) {
    parts.push(`propert(ies) ${joinIds(change.properties_added)} added`);
  }
  if (change.type_changes.length > 0) {
    parts.push(`type change(s): ${formatTypeChanges(change.type_changes)}`);
  }
  if (change.enum_changes.length > 0) {
    parts.push(`enum change(s): ${formatEnumChanges(change.enum_changes)}`);
  }
  return `\`${change.path}\` contract changed: ${parts.join("; ")}.`;
}

function apiChangeReason(change: ApiSurfaceChange): string {
  const parts: string[] = [];
  if (change.signatures_changed.length > 0) {
    parts.push(`signature change(s): ${change.signatures_changed.map((s) => `\`${s.name}\``).join(", ")}`);
  }
  if (change.exports_removed.length > 0) {
    parts.push(`removed export(s): ${joinIds(change.exports_removed)}`);
  }
  if (change.exports_added.length > 0) {
    parts.push(`added export(s): ${joinIds(change.exports_added)}`);
  }
  // review-surfaces.BLAST_RADIUS.2: "signature changed" becomes "signature
  // changed and N call sites depend on it".
  const usedBy = change.used_by;
  const blast = usedBy
    ? usedBy.count > 0
      ? usedBy.truncated
        ? ` Used by at least ${usedBy.count} file(s) (top: ${usedBy.top.map((p) => `\`${p}\``).join(", ")}; import graph truncated at the file cap).`
        : ` Used by ${usedBy.count} file(s) (top: ${usedBy.top.map((p) => `\`${p}\``).join(", ")}).`
      : usedBy.truncated
        ? " Import graph truncated at the file cap; importer count unknown."
        : " No in-repo importers reference the changed exports."
    : "";
  return `\`${change.path}\` exported API changed: ${parts.join("; ")}.${blast}`;
}

function joinIds(ids: string[]): string {
  return ids.map((id) => `\`${id}\``).join(", ");
}

function changedFileQueueDrafts(
  prSurface: PrReviewSurfaceModel,
  diffIndex: DiffIndex | undefined
): QueueDraft[] {
  return prSurface.scope.changed_files
    .filter((file) => changedFileQueueWeight(file) > 0)
    .sort((left, right) => changedFileQueueWeight(right) - changedFileQueueWeight(left) || compareStrings(left.path, right.path))
    .slice(0, MAX_CHANGED_FILE_QUEUE)
    .map((file) => {
      const evidence = fileEvidence(file.path, "Changed PR file queued because no deterministic PR risk candidate fired.");
      const anchor = queueAnchorForEvidence(evidence, diffIndex);
      const fileAreas = changedFileAreas(file);
      const areas = fileAreas.length ? fileAreas.join(", ") : "unmapped area";
      return {
        title: titleForChangedFile(file),
        path: anchor.path,
        old_path: anchor.old_path,
        hunk_header: anchor.hunk_header,
        line_start: anchor.line_start,
        line_end: anchor.line_end,
        anchor_side: anchor.side,
        reviewer_action: actionForChangedFile(file),
        // review-surfaces.HUMAN_REVIEW.21: lead with the changed file behavior,
        // not the bookkeeping "no deterministic PR risk candidate fired".
        reason: `Changed ${file.role} file in ${areas}; no risk rule fired, so scan it manually before approving.`,
        evidence: [evidence],
        requirement_ids: affectedRequirementIdsForFile(prSurface, file),
        risk_ids: [],
        confidence: anchor.line_start || anchor.hunk_header ? "high" as const : "medium" as const,
        priority: priorityForChangedFile(file),
        estimated_review_effort: file.role === "test" ? "quick" as const : "moderate" as const,
        score: changedFileQueueWeight(file) + (anchor.line_start ? 8 : 0) + (anchor.hunk_header ? 8 : 0),
        sortKey: `changed:${file.path}`
      };
    });
}

// Change regions that earn higher attention on a cold-start read: error/async handling,
// auth, network requests, persistence, lifecycle (HUMAN_REVIEW.28). The members are
// STEMS, matched as prefixes (`[a-z]*` tail, not a trailing `\b`) so the family forms
// fire too: `auth`->authentication/authorize, `persist`->persistence, `migrat`->
// migration/migrate, `permission`->permissions. A leading `\b` still prevents matching
// mid-identifier (e.g. `coauthor` does not match `auth`) (Codex #112 round-2). The `auth`
// stem uses `auth(?!or(?!iz))` so it fires on authn/authentication AND authoriz(e/ation) but
// NOT on content-authoring words (author/authors/authorId) (Codex #112 round-6).
const BASELINE_SENSITIVE =
  /\b(async|await|abort|signal|retry|catch|throw|reject|error|timeout|auth(?!or(?!iz))|login|logout|session|token|permission|oauth|password|fetch|request|http|url|socket|persist|database|migrat|cache|transaction|lifecycle|useeffect|dispose|cleanup)[a-z]*/i;
// Exported/public surface added or removed in the diff itself (HUMAN_REVIEW.28 round-2):
// in the spec-less cold-start path `semanticFacts.api_changes` is empty, so the only way
// to see a public-surface change is the changed lines. Cross-language: TS/JS `export`/
// CommonJS `module.exports`, Rust `pub`, Java/Kotlin/C#/PHP `public`, Go exported
// `func Name` / receiver method `func (r T) Name` / `type Name`, Python `__all__`. This is
// an advisory boost, not an exhaustive surface parser — rarer public-declaration forms
// (Kotlin top-level `fun`, Scala, Swift `open`) are intentionally NOT chased (Codex #112 r4).
const BASELINE_EXPORT =
  /\bexport\b|\bmodule\.exports\b|\bexports\.|\bpub(\s|\()|\bpublic\s+(class|interface|function|fun|static|final|abstract|async|void|[A-Z])|\bfunc\s+(\([^)]*\)\s*)?[A-Z]|\btype\s+[A-Z]\w*\s+(struct|interface)\b|\b__all__\b/;
// Generated/build output a human does not read line-by-line on a cold start. `classifyRole`
// only flags `dist/` + lockfiles, so the floor would otherwise rank a regenerated client
// under `generated/`/`build/`/`target/` etc. (Codex #112 round-2).
const BASELINE_GENERATED_DIR =
  /(^|\/)(generated|__generated__|\.generated|build|dist|out|target|vendor|node_modules|coverage|\.next|\.nuxt|\.svelte-kit)\//i;
const BASELINE_CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|m)$/i;
// Documentation extensions `classifyRole` does not already flag as `doc` (it keys on `docs/`
// + `.md`). Outside `docs/`, a `README.mdx`/`CHANGELOG.rst` would otherwise fall through to
// `other` and be queued (Codex #112 round-5). The cold-start floor never asks a human to
// "read this changed file" for prose.
// `.txt` is intentionally NOT here: it is too ambiguous (requirements.txt / constraints.txt
// are substantive dependency manifests, not prose), so dropping it would hide a real change
// (Codex #112 round-6). A genuinely prose .txt falls through to "other" and is merely ranked
// low — never wrongly excluded.
const BASELINE_DOC_EXT = /\.(md|mdx|markdown|mkd|rst|adoc|asciidoc|org|textile|rdoc|pod)$/i;
// Files no human reads line-by-line on a cold-start: lockfiles, images/fonts, source maps,
// snapshots, AND archive/executable/compiled binaries (a `.zip`/`.jar`/`.exe` is not a
// review-focus item — Codex #112 round-5). Excluded from the baseline floor (Codex #112).
const BASELINE_NON_REVIEW_EXT =
  /\.(png|jpe?g|gif|svg|ico|webp|bmp|pdf|woff2?|ttf|eot|otf|map|min\.js|min\.css|snap|lock|wasm|node|zip|tar|gz|tgz|bz2|xz|7z|rar|jar|war|ear|exe|dll|so|dylib|bin|class|o|a|lib|obj|pyc|pyo|deb|rpm|dmg|iso|mp4|mov|mp3|wav)$/i;
const BASELINE_LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "cargo.lock",
  "go.sum",
  "poetry.lock",
  "gemfile.lock",
  "composer.lock",
  "pipfile.lock"
]);
function isNonReviewArtifact(filePath: string): boolean {
  const base = (filePath.split("/").pop() ?? filePath).toLowerCase();
  // review-surfaces.COLLECTOR.8: Apple build/cache/user-state output, the SwiftPM
  // Package.resolved lock, and signing material are not cold-start review-focus
  // items — delegated to the shared source-kind module rather than re-listed here.
  return BASELINE_NON_REVIEW_EXT.test(base) || BASELINE_LOCKFILE_NAMES.has(base) || isAppleNonReviewArtifactPath(filePath);
}

// `classifyRole`'s isTestPath only matches `tests/` + `.test.`/`.spec.`; broaden it to
// the cross-language test conventions (`test/`, `spec/`, `__tests__/`, `foo_test.go`,
// `FooTest.java`) so a `test/retry.ts` is not mislabeled implementation (HUMAN_REVIEW.28).
function isBaselineTest(filePath: string): boolean {
  if (isTestPath(filePath)) {
    return true;
  }
  const base = filePath.split("/").pop() ?? filePath;
  return (
    /(^|\/)(tests?|__tests__|spec)\//.test(filePath) ||
    /(^|[._-])(test|spec)[._-]/i.test(base) ||
    /(^|[._-])(test|spec)\.[^.]+$/i.test(base) ||
    /(?:Test|Spec)\.[^.]+$/.test(base)
  );
}

type BaselineRole = "impl" | "test" | "config" | "ci" | "doc" | "generated" | "other";
function baselineFileRole(filePath: string): BaselineRole {
  // Generated/build output first: a path under generated/build/target/vendor is not
  // worth a manual read even if its extension looks like source (Codex #112 round-2).
  // review-surfaces.COLLECTOR.8: Apple .build/DerivedData/SourcePackages/xcuserdata
  // generated output is folded in via the shared source-kind module.
  if (BASELINE_GENERATED_DIR.test(filePath) || isAppleGeneratedPath(filePath)) {
    return "generated";
  }
  const role = classifyRole(filePath, []);
  // A definite doc/ci/generated/config/spec classification WINS over the broad test-name
  // heuristic: `docs/test.md` is a doc and `.github/workflows/test.yml` is CI, not tests,
  // even though their basename looks test-shaped (Codex #112 round-7).
  if (role === "config" || role === "ci" || role === "doc" || role === "generated") {
    return role;
  }
  // A documentation extension `classifyRole` missed (e.g. README.mdx / CHANGELOG.rst outside
  // docs/) is prose, not a review-focus item (Codex #112 round-5) — also before the test-name
  // fallback so `docs/spec.mdx` is a doc, not a test.
  if (BASELINE_DOC_EXT.test(filePath)) {
    return "doc";
  }
  // The broad cross-language test-name fallback runs only AFTER the definite doc/ci/config
  // roles, so it catches `test/retry.ts` / `FooTest.java` without hijacking a doc/CI path.
  if (isBaselineTest(filePath)) {
    return "test";
  }
  if (role === "spec") {
    return "config";
  }
  // `classifyRole` returns "unknown" when no areas are threaded (the spec-less / diff
  // path): decide impl by code extension (a .d.ts declaration is not implementation).
  if (BASELINE_CODE_EXT.test(filePath) && !/\.d\.ts$/i.test(filePath)) {
    return "impl";
  }
  return "other";
}

// Exported for unit coverage of the cold-start impl<->test stem matching (the Swift
// plural-suffix case); internal callers below use it unchanged.
export function baselineStem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const raw = base.replace(/\.[^.]+$/, ""); // strip extension, keep case
  let name = raw.toLowerCase();
  name = name.replace(/[._-](tests?|specs?)$/i, "").replace(/^(tests?|specs?)[._-]/i, "");
  // PascalCase suffix (`FooTest`/`FooSpec`, plus the plural Swift conventions
  // `FooTests`/`FooUITests`/`FooSnapshotTests`) — strip only when the original used
  // the capitalized convention, so lowercase `latest`/`contest` keep their stem. The
  // plural strip lets `GreeterTests.swift` reduce to `greeter` and connect to
  // `Greeter.swift` in cold-start impl<->test matching.
  if (/(?:UI|Snapshot)?(?:Test|Spec)s?$/.test(raw)) {
    name = name.replace(/(?:ui|snapshot)?(?:test|spec)s?$/, "");
  }
  return name;
}

// Cold-start review-focus floor (HUMAN_REVIEW.28): rank the changed files from the
// structured diff ALONE — no prSurface, no detector facts required — by deterministic
// signals so a substantive diff never yields an empty queue. Fabricates no risk or
// blocker; every item says "no risk rule produced a ranked finding, but this is worth
// reading because ..." (accurate even when a pathless risk was skipped — Codex #112 r3).
function baselineReviewFocusDrafts(
  input: BuildHumanReviewInput,
  diffIndex: DiffIndex | undefined,
  semanticFacts: SemanticChangeFacts
): QueueDraft[] {
  const files = input.diff?.files ?? [];
  if (files.length === 0) {
    return [];
  }
  const surfacePaths = new Set<string>([
    ...semanticFacts.api_changes.map((change) => change.path),
    ...semanticFacts.schema_changes.map((change) => change.path)
  ]);
  const changedTestsByImpl = input.rankingEvidence?.changed_tests_by_impl ?? {};
  // Tests the import evidence already attributed to an impl cover THAT impl; their stem must
  // not be reused as a fallback connection for a different same-stem impl (Codex #112 r3).
  // The map is keyed by the narrower `isTestPath`, so a test it never saw (a cross-language
  // `FooTest.java` the broader baseline detector recognizes) is NOT attributed and may still
  // drive the stem fallback — a single evidence entry must not disable the fallback for the
  // whole diff (Codex #112 r4).
  const attributedTestPaths = new Set(Object.values(changedTestsByImpl).flat());
  // The stem fallback uses only changed test files that are (a) NOT deletions — a removed
  // test is the opposite of connected coverage (Codex #112 r4) — and (b) not already
  // attributed to an impl by evidence.
  const changedTestStems = new Set(
    files
      .filter(
        (file) =>
          baselineFileRole(file.path) === "test" &&
          file.status !== "D" &&
          // A non-review artifact under a test dir (tests/foo.snap, tests/foo.png) is not a
          // real test — it must not lend its stem as connected coverage (Codex #112 round-6).
          !isNonReviewArtifact(file.path) &&
          !attributedTestPaths.has(file.path)
      )
      .map((file) => baselineStem(file.path))
  );
  // The stem fallback (used only without `changed_tests_by_impl` evidence) is ambiguous
  // when two changed impl files share a basename — e.g. `src/foo.ts` and `src/legacy/foo.ts`
  // with a single `tests/foo.test.ts`. We cannot tell WHICH impl that test covers, so a stem
  // shared by >1 changed impl is NOT treated as connected for any of them; each keeps its
  // no-connected-test boost (over-surface, never wrongly clear) (Codex #112 round-2).
  const implStemCounts = new Map<string, number>();
  for (const file of files) {
    if (baselineFileRole(file.path) === "impl") {
      const stem = baselineStem(file.path);
      implStemCounts.set(stem, (implStemCounts.get(stem) ?? 0) + 1);
    }
  }

  const ranked = files
    .map((file) => {
      const role = baselineFileRole(file.path);
      // Drop only docs/generated output and non-review artifacts (lockfiles, images,
      // maps, snapshots). A substantive "other" file — a shell script, Dockerfile,
      // Terraform, SQL, proto — is KEPT so a diff that only changes those is not empty
      // (Codex #112).
      if (role === "doc" || role === "generated" || isNonReviewArtifact(file.path)) {
        return undefined;
      }
      let added = 0;
      let removed = 0;
      let changedText = "";
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.kind === "add") {
            added += 1;
            changedText += ` ${line.text}`;
          } else if (line.kind === "delete") {
            removed += 1;
            changedText += ` ${line.text}`; // deleting sensitive logic (a removed catch/retry/token) counts too (Codex #112)
          }
        }
      }
      const churn = added + removed;
      const isImpl = role === "impl";
      // `surfacePaths` (semantic api/schema changes) is empty in the spec-less cold-start
      // path, so also read the public surface from the changed lines themselves (Codex
      // #112 round-2). A `.d.ts` is excluded from the impl role but is PURE public surface,
      // so it is a public-surface candidate too (Codex #112 round-3); a config/SQL "export"
      // word still does not count.
      const isDeclaration = /\.d\.ts$/i.test(file.path);
      const exported = surfacePaths.has(file.path) || ((isImpl || isDeclaration) && BASELINE_EXPORT.test(changedText));
      const stem = baselineStem(file.path);
      const hasConnectedTest =
        (changedTestsByImpl[file.path]?.length ?? 0) > 0 ||
        (isImpl && changedTestStems.has(stem) && (implStemCounts.get(stem) ?? 0) <= 1);
      const sensitive = BASELINE_SENSITIVE.test(file.path) || BASELINE_SENSITIVE.test(changedText);
      let score = Math.min(churn, 200) / 10;
      if (isImpl) score += 8;
      else if (role === "config" || role === "ci") score += 6;
      else if (role === "other") score += 4; // a substantive script/infra/sql file still ranks
      if (exported) score += 12;
      if (isImpl && !hasConnectedTest && churn > 0) score += 14;
      if (sensitive) score += 10;

      const reasons: string[] = [];
      if (exported) reasons.push("changes an exported/public surface");
      if (isImpl && !hasConnectedTest && churn > 0) reasons.push("an implementation change with no connected test change");
      if (sensitive) reasons.push("touches error/async/auth/network/persistence paths");
      if (churn >= 50) reasons.push(`high churn (+${added}/-${removed})`);
      const why = reasons.length > 0 ? reasons.join(", ") : `a ${role} change worth a manual read`;
      return { file, role, churn, score, why };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .sort((left, right) => right.score - left.score || right.churn - left.churn || compareStrings(left.file.path, right.file.path));
  // NOT capped here — the CALLER caps: the empty-queue path takes the top
  // MAX_CHANGED_FILE_QUEUE, while the augment path filters to uncovered impl FIRST and then
  // caps, so an uncovered impl file ranked past the cap is not dropped before filtering
  // (Codex #117).

  return ranked.map((entry) => {
    const evidence = fileEvidence(entry.file.path, "Ranked by deterministic change signals because no detector produced a ranked finding.");
    const anchor = queueAnchorForEvidence(evidence, diffIndex);
    return {
      title: `Review-focus: ${entry.file.path}`,
      path: anchor.path,
      old_path: anchor.old_path,
      hunk_header: anchor.hunk_header,
      line_start: anchor.line_start,
      line_end: anchor.line_end,
      anchor_side: anchor.side,
      reviewer_action: "No defect pattern fired here — read this changed file to confirm the change is intended and skim-safe.",
      reason: `No risk rule produced a ranked finding here, but this is among the changed files most worth reading: ${entry.why}.`,
      baseline: `ranked by deterministic change signals (no detector produced a ranked finding): ${entry.why}`,
      evidence: [evidence],
      requirement_ids: [],
      risk_ids: [],
      confidence: anchor.line_start || anchor.hunk_header ? ("high" as const) : ("medium" as const),
      priority: (entry.role === "impl" && entry.score >= 20 ? "medium" : "low") as HumanReviewPriority,
      estimated_review_effort: entry.role === "test" ? ("quick" as const) : ("moderate" as const),
      score: entry.score + (anchor.line_start ? 4 : 0) + (anchor.hunk_header ? 4 : 0),
      sortKey: `baseline:${entry.file.path}`
    };
  });
}

function buildFeedbackPolicyEffects(input: BuildHumanReviewInput, config: HumanReviewBuildConfig): FeedbackPolicyEffect[] {
  const drafts: FeedbackPolicyEffectDraft[] = [];
  const changedFiles = input.prSurface?.scope.changed_files ?? [];
  let riskRulePaths: Map<string, Set<string>> | undefined;

  for (const policy of config.required_manual_checks) {
    const matchers = policy.path_patterns.map(buildFeedbackPathMatcher);
    const paths = changedFilePathsMatchingAny(changedFiles, matchers);
    if (paths.length === 0) {
      continue;
    }
    const recordedEvidence = recordedManualCheckEvidence(input, policy.prompt);
    const recorded = recordedEvidence.length > 0;
    drafts.push({
      kind: "team_policy",
      summary: recorded
        ? `Configured manual check ${policy.id} matched changed file(s), and matching manual-check evidence is recorded.`
        : `Configured manual check ${policy.id} matched changed file(s), but the required manual check is missing.`,
      action: recorded
        ? `${MANUAL_CHECK_RECORDED_PREFIX} ${policy.prompt}`
        : `${RECORD_MANUAL_CHECK_PREFIX} ${policy.prompt}`,
      evidence: recordedEvidence,
      paths,
      risk_ids: [`config:${policy.id}`],
      confidence: recorded ? "medium" : "high"
    });
  }

  for (const feedbackFile of input.feedback ?? []) {
    for (const policy of feedbackFile.false_positives ?? []) {
      if (!feedbackFalsePositiveHasSelector(policy)) {
        continue;
      }
      if (!feedbackFalsePositiveConditionSupported(policy.condition)) {
        continue;
      }
      const matcher = buildFeedbackPathMatcher(policy.path_pattern);
      for (const risk of input.prSurface?.risks.candidates ?? []) {
        const ruleMatches = policy.rule === undefined || policy.rule === risk.rule;
        if (!ruleMatches) {
          continue;
        }
        const riskHasPathEvidence = risk.evidence.some((ref) => ref.path);
        const paths = risk.evidence
          .filter((ref) => ref.path && matcher.matches(ref.path))
          .map((ref) => normalizeEvidencePath(String(ref.path)));
        const fallbackPaths = policy.path_pattern && !riskHasPathEvidence
          ? changedFilePathsMatchingAny(changedFiles, [matcher])
          : [];
        const matchedPaths = uniqueTruthy([...paths, ...fallbackPaths]);
        if (policy.path_pattern && matchedPaths.length === 0) {
          continue;
        }
        if (!feedbackFalsePositiveConditionSatisfied(policy.condition, matchedPaths)) {
          continue;
        }
        drafts.push({
          kind: "false_positive",
          summary: `Feedback marks ${risk.rule} as noisy${matchedPaths.length ? ` for ${matchedPaths.join(", ")}` : ""}.`,
          action: feedbackFalsePositiveAction(policy.action),
          evidence: [...policy.evidence, ...evidenceOrMissing(risk.evidence, risk.summary)],
          paths: matchedPaths,
          risk_ids: [risk.id],
          confidence: "medium"
        });
      }
    }

    for (const policy of feedbackFile.false_negatives ?? []) {
      const matcher = buildFeedbackPathMatcher(policy.path_pattern);
      const desiredRule = policy.desired_rule;
      const paths = changedFiles
        .flatMap((file) => {
          const matchedPaths = changedFilePathsMatchedByPolicy(file, [matcher]);
          if (matchedPaths.length === 0) {
            return [];
          }
          if (desiredRule) {
            const rulePaths = riskRulePaths ?? buildPrRiskRulePathIndex(input.prSurface);
            riskRulePaths = rulePaths;
            return matchedPaths.filter((filePath) => !prRiskRuleCoversPath(rulePaths, desiredRule, filePath));
          }
          return matchedPaths;
        });
      if (paths.length === 0) {
        continue;
      }
      drafts.push({
        kind: "false_negative",
        summary: `${policy.description}${policy.desired_rule ? ` Desired rule: ${policy.desired_rule}.` : ""}`,
        action: policy.desired_rule ? `Queue reviewer focus for feedback rule ${policy.desired_rule}.` : "Queue reviewer focus from feedback false-negative policy.",
        evidence: policy.evidence,
        paths,
        risk_ids: policy.desired_rule ? [`feedback:${policy.desired_rule}`] : [],
        confidence: "medium"
      });
    }

    for (const policy of feedbackFile.team_policy ?? []) {
      const matcher = buildFeedbackPathMatcher(policy.path_pattern);
      const paths = changedFilePathsMatchingAny(changedFiles, [matcher]);
      if (paths.length === 0 || !policy.required_manual_check) {
        continue;
      }
      const recordedEvidence = recordedManualCheckEvidence(input, policy.required_manual_check);
      const recorded = recordedEvidence.length > 0;
      drafts.push({
        kind: "team_policy",
        summary: recorded
          ? `Team policy ${policy.id} matched changed file(s), and matching manual-check evidence is recorded.`
          : `Team policy ${policy.id} matched changed file(s), but the required manual check is missing.`,
        action: recorded
          ? `${MANUAL_CHECK_RECORDED_PREFIX} ${policy.required_manual_check}`
          : `${RECORD_MANUAL_CHECK_PREFIX} ${policy.required_manual_check}`,
        evidence: recorded ? [...policy.evidence, ...recordedEvidence] : policy.evidence,
        paths,
        risk_ids: [`policy:${policy.id}`],
        confidence: recorded ? "medium" : "high"
      });
    }

    for (const preference of feedbackFile.reviewer_preferences ?? []) {
      const focusPatterns = reviewerPreferencePathPatterns(preference.key, preference.value);
      if (focusPatterns.length === 0) {
        continue;
      }
      const matchers = focusPatterns.map(buildFeedbackPathMatcher);
      const paths = changedFilePathsMatchingAny(changedFiles, matchers);
      if (paths.length === 0) {
        continue;
      }
      drafts.push({
        kind: "reviewer_preference",
        summary: `Reviewer preference ${preference.key} matched changed file(s).`,
        action: FEEDBACK_ACTION_PRIORITIZE_REVIEW_FOCUS,
        evidence: preference.evidence,
        paths,
        risk_ids: [],
        confidence: "medium"
      });
    }
  }

  const deduped = dedupeFeedbackEffects(drafts);
  const requiredMissing = boundedMissingTeamPolicyEffects(deduped.filter(isMissingTeamPolicyEffect));
  const optional = deduped.filter((draft) => !isMissingTeamPolicyEffect(draft));
  const capped = [
    ...requiredMissing,
    ...optional.slice(0, Math.max(0, MAX_FEEDBACK_EFFECTS - requiredMissing.length))
  ];
  return capped.map((draft, index) => ({
    id: `FEEDBACK-${String(index + 1).padStart(3, "0")}`,
    ...draft
  }));
}

function buildRiskLensFindings(input: BuildHumanReviewInput, config: HumanReviewBuildConfig, semanticFacts: SemanticChangeFacts): RiskLensFinding[] {
  const accumulators = new Map<RiskLens, RiskLensAccumulator>();
  const addSignal = (
    lens: RiskLens,
    severity: PacketSeverity,
    evidence: EvidenceRef[],
    riskIds: string[] = [],
    requirementIds: string[] = [],
    paths: string[] = []
  ): void => {
    if (!config.risk_lenses[lens]) {
      return;
    }
    const existing = accumulators.get(lens) ?? {
      lens,
      severity: "unknown" as const,
      evidence: [],
      evidence_keys: new Set<string>(),
      risk_ids: [],
      risk_id_set: new Set<string>(),
      requirement_ids: [],
      requirement_id_set: new Set<string>(),
      paths: [],
      path_set: new Set<string>(),
      confidence: "medium" as const,
      has_invalid_evidence: false
    };
    existing.severity = maxSeverity(existing.severity, severity);
    const hasInvalidEvidence = evidence.some(isInvalidTrustEvidence);
    existing.has_invalid_evidence = existing.has_invalid_evidence || hasInvalidEvidence;
    appendUniqueEvidence(existing, evidence);
    appendUniqueStrings(existing.risk_ids, existing.risk_id_set, riskIds);
    appendUniqueStrings(existing.requirement_ids, existing.requirement_id_set, requirementIds);
    appendUniqueStrings(existing.paths, existing.path_set, paths.map(normalizeEvidencePath), MAX_RISK_LENS_PATHS);
    existing.confidence = existing.has_invalid_evidence ? "low" : riskIds.length > 0 ? "high" : existing.confidence;
    accumulators.set(lens, existing);
  };

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    const paths = evidencePaths(risk.evidence);
    const lenses = PR_RISK_RULE_LENSES[risk.rule];
    for (const lens of lenses.length ? lenses : riskLensesForEvidencePaths(paths)) {
      addSignal(
        lens,
        risk.severity,
        evidenceOrMissing(risk.evidence, risk.summary),
        [risk.id],
        requirementIdsForPrRisk(input, risk),
        paths
      );
    }
  }

  for (const file of input.prSurface?.scope.changed_files ?? []) {
    const lensMatches = riskLensMatchesForChangedFile(file);
    if (lensMatches.length === 0) {
      continue;
    }
    const fileRequirementIds = input.prSurface ? affectedRequirementIdsForFile(input.prSurface, file) : [];
    for (const match of lensMatches) {
      addSignal(
        match.lens,
        defaultSeverityForLensPath(match.lens, match.matched_paths[0] ?? file.path, file.role),
        [fileEvidence(file.path, riskLensChangedFileEvidenceNote(match.lens, file, match.matched_paths))],
        [],
        fileRequirementIds,
        uniqueTruthy([file.path, ...match.matched_paths])
      );
    }
  }

  // review-surfaces.SEMANTIC_DIFF.4: the concrete change facts also flow into the
  // risk lenses, so the api_contract / test_evidence lenses carry field-level and
  // signature-level detail rather than generic path-touch findings. Evidence is
  // anchored to the (allowlisted) changed file path.
  for (const change of semanticFacts.schema_changes) {
    const breaking = change.required_added.length > 0 || change.properties_removed.length > 0 || change.type_changes.length > 0;
    addSignal("api_contract", breaking ? "high" : "medium", [fileEvidence(change.path, schemaChangeReason(change))], [], [], [change.path]);
  }
  for (const change of semanticFacts.api_changes) {
    const breaking = change.exports_removed.length > 0 || change.signatures_changed.length > 0;
    addSignal("api_contract", breaking ? "high" : "medium", [fileEvidence(change.path, apiChangeReason(change))], [], [], [change.path]);
  }
  // review-surfaces.SEMANTIC_DIFF.5: Swift declaration changes feed the api_contract
  // lens. A public/package break is high; an additive or internal change is
  // advisory (medium) until Phase 3 supplies a deterministic used_by relationship.
  for (const change of semanticFacts.swift_declaration_changes) {
    addSignal("api_contract", change.breaking ? "high" : "medium", [fileEvidence(change.path, change.detail)], [], [], [change.path]);
  }
  // review-surfaces.DEP_FACTS.2: dependency facts feed the supply_chain lens.
  for (const fact of input.dependencyFacts ?? []) {
    const rank = dependencyFactSeverityRank(fact.kind);
    addSignal("supply_chain", rank === 0 ? "high" : rank === 1 ? "medium" : "low", [fileEvidence(fact.source_path, fact.detail)], [], [], [fact.source_path]);
  }
  // review-surfaces.CONFIG_FACTS.1-3: config/infra facts feed the security lens.
  for (const fact of input.configFacts ?? []) {
    addSignal("security_privacy", isHighSeverityConfigFact(fact.kind) ? "high" : "medium", [fileEvidence(fact.path, fact.detail)], [], [], [fact.path]);
  }

  // review-surfaces.ARCH_DRIFT.2: drift facts feed the architecture lens.
  for (const fact of input.archDrift?.facts ?? []) {
    addSignal("architecture", fact.kind === "import_cycle_created" ? "high" : "medium", [fileEvidence(fact.files[0] ?? fact.from_module, fact.detail)], [], [], fact.files);
  }

  for (const signal of semanticFacts.test_weakening) {
    const severe = signal.kind === "deleted_test_file" || signal.kind === "removed_test_method" || signal.kind === "removed_assertion";
    addSignal("test_evidence", severe ? "high" : "medium", [fileEvidence(signal.path, signal.detail)], [], [], [signal.path]);
  }

  return [...accumulators.values()]
    .filter((finding) => finding.evidence.length > 0)
    .sort(compareRiskLensAccumulators)
    .slice(0, MAX_RISK_LENS_FINDINGS)
    .map((finding, index) => {
      const id = `LENS-${String(index + 1).padStart(3, "0")}`;
      const base: Omit<RiskLensFinding, "suggested_tests" | "suggested_comments"> = {
        id,
        lens: finding.lens,
        severity: finding.severity,
        summary: riskLensSummary(finding),
        reviewer_action: riskLensReviewerAction(finding, input),
        evidence: finding.evidence.slice(0, 8),
        risk_ids: finding.risk_ids,
        requirement_ids: finding.requirement_ids,
        paths: finding.paths,
        confidence: finding.has_invalid_evidence ? "low" : finding.confidence
      };
      return {
        ...base,
        suggested_tests: buildRiskLensSuggestedTests(input, base),
        suggested_comments: buildRiskLensSuggestedComments(base)
      };
    });
}

function riskLensMatchesForChangedFile(file: PrChangedFile): Array<{ lens: RiskLens; matched_paths: string[] }> {
  const matches = new Map<RiskLens, string[]>();
  const candidatePaths = [file.path, file.old_path]
    .filter((filePath): filePath is string => Boolean(filePath))
    .map(normalizeEvidencePath);
  for (const filePath of uniqueTruthy(candidatePaths)) {
    for (const lens of riskLensesForChangedFilePath(filePath, file.role)) {
      const paths = matches.get(lens) ?? [];
      if (!paths.includes(filePath)) {
        paths.push(filePath);
      }
      matches.set(lens, paths);
    }
  }
  return [...matches.entries()].map(([lens, matched_paths]) => ({ lens, matched_paths }));
}

function riskLensesForChangedFilePath(filePath: string, role: PrChangedFile["role"]): RiskLens[] {
  return compactRiskLenses([
    isApiContractLensPath(filePath, role) ? "api_contract" as const : undefined,
    isSecurityPrivacyLensPath(filePath, role) ? "security_privacy" as const : undefined,
    isLlmTrustBoundaryLensPath(filePath) ? "llm_trust_boundary" as const : undefined,
    isTestEvidenceLensPath(filePath, role) ? "test_evidence" as const : undefined,
    isReviewerUxLensPath(filePath) ? "reviewer_ux" as const : undefined,
    isCacheProvenanceLensPath(filePath) ? "cache_provenance" as const : undefined
  ]);
}

function riskLensChangedFileEvidenceNote(lens: RiskLens, file: PrChangedFile, matchedPaths: string[]): string {
  const renameText = file.old_path ? ` renamed from ${file.old_path}` : "";
  const matchedText = matchedPaths.length > 0 ? ` Matched path(s): ${matchedPaths.join(", ")}.` : "";
  return `${RISK_LENS_METADATA[lens].label} matched changed file ${file.path}${renameText}.${matchedText}`;
}

function riskLensesForEvidencePaths(paths: string[]): RiskLens[] {
  return uniqueTruthy(paths.flatMap((filePath) => riskLensesForPath(filePath)));
}

function riskLensesForPath(filePath: string): RiskLens[] {
  const normalizedPath = normalizeEvidencePath(filePath);
  return compactRiskLenses([
    isApiContractLensPath(normalizedPath, "unknown") ? "api_contract" as const : undefined,
    isSecurityPrivacyLensPath(normalizedPath, "unknown") ? "security_privacy" as const : undefined,
    isLlmTrustBoundaryLensPath(normalizedPath) ? "llm_trust_boundary" as const : undefined,
    isTestEvidenceLensPath(normalizedPath, "unknown") ? "test_evidence" as const : undefined,
    isReviewerUxLensPath(normalizedPath) ? "reviewer_ux" as const : undefined,
    isCacheProvenanceLensPath(normalizedPath) ? "cache_provenance" as const : undefined
  ]);
}

function compactRiskLenses(values: Array<RiskLens | undefined>): RiskLens[] {
  return uniqueTruthy(values).filter((value): value is RiskLens => typeof value === "string");
}

function isApiContractLensPath(filePath: string, role: PrChangedFile["role"]): boolean {
  return (
    role === "spec" ||
    /^src\/cli\//.test(filePath) ||
    isVersionedArtifactContractPath(filePath) ||
    filePath === "review-surfaces.config.yaml" ||
    /^features\/.*\.feature\.yaml$/.test(filePath)
  );
}

function isPersistedSchemaContractPath(filePath: string): boolean {
  return (
    /^schemas\//.test(filePath) ||
    /(?:^|\/)schema(?:s)?\//.test(filePath) ||
    /(?:^|\/)[^/]*schema[^/]*\.json$/.test(filePath)
  );
}

function isVersionedArtifactContractPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    isPersistedSchemaContractPath(filePath) ||
    /(?:^|\/)contract\.ts$/.test(filePath) ||
    lower.includes("review-packet-contract") ||
    lower.includes("render/load")
  );
}

function hasVersionedArtifactContractPath(paths: string[]): boolean {
  return paths.some(isVersionedArtifactContractPath);
}

function isSecurityPrivacyLensPath(filePath: string, role: PrChangedFile["role"]): boolean {
  return (
    role === "ci" ||
    /^\.github\/workflows\//.test(filePath) ||
    /^src\/privacy\//.test(filePath) ||
    /^src\/llm\/provider/.test(filePath) ||
    /\b(secret|token|redact|credential|privacy|provider)\b/i.test(filePath)
  );
}

function isLlmTrustBoundaryLensPath(filePath: string): boolean {
  return (
    /^src\/llm\//.test(filePath) ||
    /\b(prompt|narrative|allowlist|anchor|llm)\b/i.test(filePath)
  );
}

function isTestEvidenceLensPath(filePath: string, role: PrChangedFile["role"]): boolean {
  return (
    role === "test" ||
    /^tests\//.test(filePath) ||
    /\b(test-output|junit|coverage|tests-evidence|command-transcript|transcript)\b/i.test(filePath)
  );
}

function isReviewerUxLensPath(filePath: string): boolean {
  return (
    /^src\/render\//.test(filePath) ||
    /^src\/human\/render\.ts$/.test(filePath) ||
    /\b(comment|markdown|mermaid|diagram|review[-_]queue|human_review)\b/i.test(filePath)
  );
}

function isCacheProvenanceLensPath(filePath: string): boolean {
  return /\b(cache|provenance|artifact-store|previous-packet|input-hash|signature)\b/i.test(filePath);
}

function defaultSeverityForLensPath(lens: RiskLens, filePath: string, role: PrChangedFile["role"]): PacketSeverity {
  if (lens === "security_privacy" && (role === "ci" || /^\.github\/workflows\//.test(filePath))) {
    return "high";
  }
  if (lens === "api_contract" || lens === "llm_trust_boundary") {
    return "medium";
  }
  return "low";
}

function riskLensSummary(finding: RiskLensAccumulator): string {
  const source = finding.risk_ids.length
    ? `${finding.risk_ids.length} deterministic risk(s)`
    : `${finding.paths.length} changed file(s)`;
  const pathText = finding.paths.length ? ` across ${finding.paths.slice(0, 4).join(", ")}` : "";
  return `${RISK_LENS_METADATA[finding.lens].label} fired from ${source}${pathText}.`;
}

function riskLensReviewerAction(
  finding: Pick<RiskLensFinding, "lens" | "risk_ids" | "paths" | "evidence">,
  input: BuildHumanReviewInput
): string {
  switch (finding.lens) {
    case "api_contract":
      return hasVersionedArtifactContractPath(finding.paths)
        ? "Confirm the changed schema or artifact contract is additive or intentionally versioned, and add a compatibility fixture for existing generated artifacts."
        : "Confirm the changed CLI, config, or feature-ledger contract is documented and covered by focused command/config tests.";
    case "security_privacy":
      return hasCiSecretBoundaryLensRisk(finding) && !hasRecordedCiSecretBoundaryManualCheck(input)
        ? "Inspect workflow/provider boundaries and record a manual check proving PR-controlled code cannot access secrets."
        : "Inspect privacy, provider, redaction, token, and workflow boundaries with sensitive-input validation evidence.";
    case "llm_trust_boundary":
      return "Verify LLM prompt/output changes cannot fabricate paths, requirements, risks, statuses, or reviewer-facing anchors.";
    case "test_evidence":
      return "Confirm parsed test output, coverage, command transcripts, and skipped-test handling still produce trustworthy review evidence.";
    case "reviewer_ux":
      return "Render the changed reviewer-facing Markdown or diagram from fixtures and inspect boundedness, evidence links, and blocked-state messaging.";
    case "supply_chain":
      return "Inspect the added or changed dependency: confirm it is intentional, pinned appropriately, and free of unexpected install scripts.";
    case "architecture":
      return "Confirm the new or removed module-boundary import edge is an intentional architecture change, not an agent shortcut across layers.";
    case "cache_provenance":
      return "Verify cache signatures, previous-packet comparison, and artifact provenance cannot reuse stale or mismatched review evidence.";
    case "custom":
      return "Inspect the custom risk lens finding and record the reviewer action taken.";
  }
}

function buildRiskLensSuggestedTests(
  input: BuildHumanReviewInput,
  finding: Omit<RiskLensFinding, "suggested_tests" | "suggested_comments">
): TestPlanItem[] {
  const drafts: TestPlanDraft[] = [];
  const required = isElevatedSeverity(finding.severity) ? "required" as const : "recommended" as const;
  switch (finding.lens) {
    case "api_contract":
      drafts.push(...apiContractTestPlanDrafts(finding));
      break;
    case "security_privacy":
      if (hasCiSecretBoundaryLensRisk(finding) && !hasRecordedCiSecretBoundaryManualCheck(input)) {
        drafts.push({
          kind: "manual",
          priority: "required",
          scenario: "Inspect workflow/provider/comment-posting changes for the CI secret boundary.",
          expected_result: "Reviewer records that PR-controlled code cannot access secrets and secret-bearing steps run only from trusted code.",
          maps_to_requirements: finding.requirement_ids,
          maps_to_risks: finding.risk_ids,
          evidence_gap: "No manual CI secret-boundary check is recorded for this lens finding."
        });
      } else {
        drafts.push({
          kind: "automatic",
          priority: required,
          suggested_file: "tests/privacy.test.ts",
          scenario: "Exercise the changed privacy, provider, redaction, token, or workflow path with sensitive-looking input.",
          expected_result: "No secret or unredacted sensitive value reaches artifacts, logs, comments, or remote-provider prompts.",
          command: "pnpm run test -- tests/privacy.test.ts",
          maps_to_requirements: finding.requirement_ids,
          maps_to_risks: finding.risk_ids,
          evidence_gap: finding.summary
        });
      }
      break;
    case "llm_trust_boundary":
      drafts.push({
        kind: "automatic",
        priority: "required",
        suggested_file: "tests/pr-narrative.test.ts",
        scenario: "Generate LLM narrative candidates with off-allowlist paths, ACIDs, risks, and statuses.",
        expected_result: "Invalid anchors are dropped or marked invalid and never appear as trusted reviewer-facing facts.",
        command: "pnpm run test -- tests/pr-narrative.test.ts",
        maps_to_requirements: finding.requirement_ids,
        maps_to_risks: finding.risk_ids,
        evidence_gap: finding.summary
      });
      break;
    case "test_evidence":
      const testEvidenceFile = suggestedLensTestFile(finding, "tests/tests-evidence.test.ts");
      drafts.push({
        kind: "automatic",
        priority: required,
        suggested_file: testEvidenceFile,
        scenario: "Run or add a fixture proving test output, coverage, skipped tests, or command transcripts are parsed into the expected evidence state.",
        expected_result: "The human review trust audit distinguishes passed, failed, skipped, claimed, and missing validation evidence correctly.",
        command: `pnpm run test -- ${testEvidenceFile}`,
        maps_to_requirements: finding.requirement_ids,
        maps_to_risks: finding.risk_ids,
        evidence_gap: finding.summary
      });
      break;
    case "reviewer_ux":
      const reviewerUxFile = suggestedLensTestFile(finding, "tests/pr-comment.test.ts", isReviewerUxImplementationPath);
      drafts.push({
        kind: "automatic",
        priority: "recommended",
        suggested_file: reviewerUxFile,
        scenario: "Render the changed reviewer-facing surface from a deterministic fixture.",
        expected_result: "The Markdown stays compact, evidence-backed, and clear in blocked and ready states.",
        command: `pnpm run test -- ${reviewerUxFile}`,
        maps_to_requirements: finding.requirement_ids,
        maps_to_risks: finding.risk_ids,
        evidence_gap: finding.summary
      });
      break;
    case "supply_chain":
      drafts.push({
        kind: "manual",
        priority: "required",
        scenario: "Vet the added or changed dependency: confirm it is intentional, appropriately pinned, and free of unexpected install scripts.",
        expected_result: "The dependency change is confirmed intentional and safe, or removed.",
        maps_to_requirements: finding.requirement_ids,
        maps_to_risks: finding.risk_ids,
        evidence_gap: finding.summary
      });
      break;
    case "cache_provenance":
      drafts.push({
        kind: "automatic",
        priority: "recommended",
        suggested_file: "tests/artifact-provenance-input-hardening.test.ts",
        scenario: "Change cache/provenance inputs and verify stale review artifacts are regenerated instead of reused.",
        expected_result: "Cache hits occur only for matching signatures and provenance; mismatched artifacts force regeneration.",
        command: "pnpm run test -- tests/artifact-provenance-input-hardening.test.ts",
        maps_to_requirements: finding.requirement_ids,
        maps_to_risks: finding.risk_ids,
        evidence_gap: finding.summary
      });
      break;
    case "custom":
      break;
  }
  return drafts.map((draft, index) => ({
    id: `${finding.id}-TEST-${String(index + 1).padStart(3, "0")}`,
    ...draft
  }));
}

function buildRiskLensSuggestedComments(
  finding: Omit<RiskLensFinding, "suggested_tests" | "suggested_comments">
): SuggestedReviewComment[] {
  const body = riskLensSuggestedCommentBody(finding);
  if (!body) {
    return [];
  }
  const firstPath = riskLensSuggestedCommentPath(finding);
  return [{
    id: `${finding.id}-SC-001`,
    severity: riskLensSuggestedCommentSeverity(finding),
    path: firstPath,
    body,
    evidence: finding.evidence,
    risk_ids: finding.risk_ids,
    requirement_ids: finding.requirement_ids,
    confidence: finding.confidence,
    ready_to_post: finding.evidence.length > 0 && !finding.evidence.some(isInvalidTrustEvidence)
  }];
}

function riskLensSuggestedCommentBody(finding: Pick<RiskLensFinding, "lens" | "paths" | "reviewer_action">): string | undefined {
  switch (finding.lens) {
    case "api_contract":
      return hasVersionedArtifactContractPath(finding.paths)
        ? "This fires the API/schema contract lens. Can you add a compatibility fixture for an existing generated artifact, or explicitly version this as a breaking change?"
        : "This fires the API/CLI/config contract lens. Can you point to the focused CLI, config, or feature-ledger test covering the changed public behavior?";
    case "security_privacy":
      return "This fires the security/privacy lens. Can you record the manual check or sensitive-input validation proving the changed boundary does not expose secrets or unredacted data?";
    case "llm_trust_boundary":
      return "This fires the LLM trust-boundary lens. Which fixture proves fabricated paths, requirement IDs, risk IDs, or statuses are rejected before rendering?";
    case "test_evidence":
      return "This fires the test evidence lens. Can you point to parsed test output or a command transcript proving the changed evidence path is trustworthy?";
    case "reviewer_ux":
      return "This fires the reviewer UX lens. Please include or inspect a rendered Markdown/diagram fixture so reviewers can verify the output directly.";
    case "supply_chain":
      return "Is this dependency change intentional, and has the package been vetted for install scripts and maintenance?";
    case "architecture":
      return "Is the new module-boundary dependency edge intentional, and should it be documented as an architecture decision?";
    case "cache_provenance":
      return "This fires the cache/provenance lens. Which fixture proves stale or mismatched artifacts cannot be reused for this change?";
    case "custom":
      return undefined;
  }
}

// A risk-lens finding is blocking when its own severity is elevated, when it is
// a versioned-artifact API/schema contract change, or when it crosses the
// LLM trust boundary. Shared by the suggested-comment and reviewer-question
// severity mappers so the blocking band is defined once.
function isBlockingRiskLensFinding(finding: Pick<RiskLensFinding, "lens" | "severity" | "paths">): boolean {
  return (
    isElevatedSeverity(finding.severity) ||
    (finding.lens === "api_contract" && hasVersionedArtifactContractPath(finding.paths)) ||
    finding.lens === "llm_trust_boundary"
  );
}

function riskLensSuggestedCommentSeverity(finding: Pick<RiskLensFinding, "lens" | "severity" | "paths">): SuggestedReviewComment["severity"] {
  if (isBlockingRiskLensFinding(finding)) {
    return "blocking";
  }
  if (finding.lens === "reviewer_ux" || finding.lens === "cache_provenance") {
    return "non_blocking";
  }
  return "clarifying";
}

function suggestedLensTestFile(
  finding: Pick<RiskLensFinding, "paths">,
  fallback: string,
  preferredPath?: (filePath: string) => boolean
): string {
  const orderedPaths = preferredPath
    ? [
        ...finding.paths.filter((filePath) => preferredPath(filePath)),
        ...finding.paths.filter((filePath) => !preferredPath(filePath))
      ]
    : finding.paths;
  for (const filePath of orderedPaths) {
    const suggested = suggestedTestFileForPath(filePath);
    if (suggested) {
      return suggested;
    }
  }
  return fallback;
}

function apiContractTestPlanDrafts(
  finding: Omit<RiskLensFinding, "suggested_tests" | "suggested_comments">
): TestPlanDraft[] {
  const drafts: TestPlanDraft[] = [];
  if (hasVersionedArtifactContractPath(finding.paths)) {
    drafts.push({
      kind: "automatic",
      priority: "required",
      suggested_file: "tests/schema-contract.test.ts",
      scenario: "Load an existing generated artifact fixture and validate it against the changed schema or artifact contract.",
      expected_result: "The old fixture still validates, or the schema/artifact contract version is explicitly bumped for a breaking change.",
      command: "pnpm run test -- tests/schema-contract.test.ts",
      maps_to_requirements: finding.requirement_ids,
      maps_to_risks: finding.risk_ids,
      evidence_gap: finding.summary
    });
  }
  for (const suggestedFile of suggestedApiContractTestFiles(finding.paths)) {
    drafts.push({
      kind: "automatic",
      priority: "recommended",
      suggested_file: suggestedFile,
      scenario: "Run or add a focused fixture covering the changed CLI, config, or feature-ledger contract.",
      expected_result: "The public command/config behavior remains documented, deterministic, and compatible with existing reviewer workflows.",
      command: `pnpm run test -- ${suggestedFile}`,
      maps_to_requirements: finding.requirement_ids,
      maps_to_risks: finding.risk_ids,
      evidence_gap: finding.summary
    });
  }
  return drafts.length ? drafts : [{
    kind: "automatic",
    priority: "recommended",
    suggested_file: "tests/schema-contract.test.ts",
    scenario: "Run or add a focused fixture covering the changed API or artifact contract.",
    expected_result: "The changed contract remains documented, deterministic, and compatible with existing reviewer workflows.",
    command: "pnpm run test -- tests/schema-contract.test.ts",
    maps_to_requirements: finding.requirement_ids,
    maps_to_risks: finding.risk_ids,
    evidence_gap: finding.summary
  }];
}

function suggestedApiContractTestFiles(paths: string[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const filePath of paths) {
    if (isVersionedArtifactContractPath(filePath)) {
      continue;
    }
    const suggested = suggestedApiContractTestFileForPath(filePath);
    if (suggested && !seen.has(suggested)) {
      seen.add(suggested);
      files.push(suggested);
    }
  }
  return files;
}

function suggestedApiContractTestFileForPath(filePath: string): string | undefined {
  if (/^src\/cli\//.test(filePath)) {
    return "tests/cli.test.ts";
  }
  if (filePath === "review-surfaces.config.yaml") {
    return "tests/config.test.ts";
  }
  if (/^features\/.*\.feature\.yaml$/.test(filePath)) {
    return "tests/acai.test.ts";
  }
  return suggestedTestFileForPath(filePath);
}

function riskLensSuggestedCommentPath(finding: Pick<RiskLensFinding, "lens" | "paths">): string | undefined {
  if (finding.lens === "reviewer_ux") {
    return preferredLensPath(finding, isReviewerUxImplementationPath) ?? finding.paths[0];
  }
  return finding.paths[0];
}

function preferredLensPath(
  finding: Pick<RiskLensFinding, "paths">,
  preferredPath: (filePath: string) => boolean
): string | undefined {
  return finding.paths.find((filePath) => preferredPath(filePath));
}

function isReviewerUxImplementationPath(filePath: string): boolean {
  const normalizedPath = normalizeEvidencePath(filePath);
  return /^src\/render\//.test(normalizedPath) || normalizedPath === "src/human/render.ts";
}

function hasCiSecretBoundaryLensRisk(finding: Pick<RiskLensFinding, "risk_ids" | "paths" | "evidence">): boolean {
  return (
    finding.risk_ids.some((id) => /CI-SECRET/i.test(id)) ||
    finding.paths.some((filePath) => /^\.github\/workflows\//.test(normalizeEvidencePath(filePath))) ||
    finding.evidence.some((ref) => /ci secret|secret-boundary|workflow/i.test([ref.note, ref.path].filter(Boolean).join(" ")))
  );
}

function compareRiskLensAccumulators(left: RiskLensAccumulator, right: RiskLensAccumulator): number {
  return (
    severityWeight(right.severity) - severityWeight(left.severity) ||
    riskLensRank(left.lens) - riskLensRank(right.lens) ||
    compareStrings(left.paths.join(","), right.paths.join(","))
  );
}

function riskLensRank(lens: RiskLens): number {
  return RISK_LENS_METADATA[lens].rank;
}

function maxSeverity(left: PacketSeverity, right: PacketSeverity): PacketSeverity {
  return severityWeight(right) > severityWeight(left) ? right : left;
}

function evidencePaths(evidence: EvidenceRef[]): string[] {
  return uniqueTruthy(evidence.filter((ref) => ref.path).map((ref) => normalizeEvidencePath(String(ref.path))));
}

function appendUniqueEvidence(accumulator: RiskLensAccumulator, evidence: EvidenceRef[]): void {
  for (const ref of evidence) {
    const key = evidenceRefDedupeKey(ref);
    if (accumulator.evidence_keys.has(key)) {
      continue;
    }
    accumulator.evidence_keys.add(key);
    accumulator.evidence.push(ref);
  }
}

function appendUniqueStrings(target: string[], seen: Set<string>, values: string[], limit = Number.POSITIVE_INFINITY): void {
  for (const value of values) {
    if (!value || seen.has(value) || target.length >= limit) {
      continue;
    }
    seen.add(value);
    target.push(value);
  }
}

function evidenceRefDedupeKey(ref: EvidenceRef): string {
  return [
    ref.kind,
    ref.path,
    ref.line_start,
    ref.line_end,
    ref.acai_id,
    ref.command,
    ref.test_name,
    ref.note
  ].join("|");
}

function feedbackReviewQueueDrafts(
  feedbackEffects: FeedbackPolicyEffect[],
  diffIndex: DiffIndex | undefined
): QueueDraft[] {
  const drafts: QueueDraft[] = [];
  const effectToDrafts = (effect: FeedbackPolicyEffect, baseScore: number, priority: HumanReviewPriority): QueueDraft[] =>
    effect.paths.map((filePath) => {
      const evidence = fileEvidence(filePath, "Changed file matched reviewer feedback memory.", "medium");
      const anchor = queueAnchorForEvidence(evidence, diffIndex);
      return {
        title: feedbackQueueTitle(effect),
        path: anchor.path,
        old_path: anchor.old_path,
        hunk_header: anchor.hunk_header,
        line_start: anchor.line_start,
        line_end: anchor.line_end,
        anchor_side: anchor.side,
        reviewer_action: effect.action,
        reason: effect.summary,
        evidence: [evidence, ...effect.evidence],
        requirement_ids: requirementIds(effect.evidence),
        risk_ids: effect.risk_ids,
        confidence: anchor.line_start || anchor.hunk_header ? "high" : effect.confidence,
        priority,
        estimated_review_effort: priority === "high" ? "moderate" : "quick",
        score: baseScore + (anchor.line_start ? 8 : 0) + (anchor.hunk_header ? 8 : 0),
        sortKey: `${effect.id}:${filePath}`
      };
    });

  for (const effect of feedbackEffects) {
    if (effect.kind === "false_negative") {
      drafts.push(...effectToDrafts(effect, 70, "high"));
    } else if (isMissingTeamPolicyEffect(effect)) {
      drafts.push(...effectToDrafts(effect, 78, "high"));
    } else if (isReviewerPreferenceFocusEffect(effect)) {
      drafts.push(...effectToDrafts(effect, 55, "medium"));
    }
  }

  return dedupeQueueDrafts(drafts);
}

function feedbackFalsePositiveEffectForRisk(
  risk: PrRiskCandidate,
  feedbackEffects: FeedbackPolicyEffect[],
  anchorPath: string | undefined
): FeedbackPolicyEffect | undefined {
  const riskPaths = uniqueTruthy(
    risk.evidence
      .filter((ref) => ref.path)
      .map((ref) => normalizeEvidencePath(String(ref.path)))
  );
  const normalizedAnchorPath = anchorPath ? normalizeEvidencePath(anchorPath) : undefined;
  return feedbackEffects.find((effect) =>
    effect.kind === "false_positive" &&
    effect.risk_ids.includes(risk.id) &&
    (effect.action === FEEDBACK_ACTION_DOWNGRADE_TO_LOW || effect.action === FEEDBACK_ACTION_RETAIN_LOW_PRIORITY) &&
    feedbackFalsePositiveCoversRiskPaths(effect, riskPaths, normalizedAnchorPath)
  );
}

function feedbackFalsePositiveCoversRiskPaths(
  effect: FeedbackPolicyEffect,
  riskPaths: string[],
  anchorPath: string | undefined
): boolean {
  if (effect.paths.length === 0) {
    return true;
  }
  const effectPaths = new Set(effect.paths.map((filePath) => normalizeEvidencePath(filePath)));
  if (riskPaths.length > 1) {
    return riskPaths.every((filePath) => effectPaths.has(filePath));
  }
  return anchorPath ? effectPaths.has(anchorPath) : false;
}

function feedbackFalsePositiveAction(action: string): string {
  const normalized = action.trim().toLowerCase();
  if (normalized === FEEDBACK_ACTION_DOWNGRADE_TO_LOW) {
    return FEEDBACK_ACTION_DOWNGRADE_TO_LOW;
  }
  if (normalized === "suppress" || normalized === "ignore") {
    return FEEDBACK_ACTION_RETAIN_LOW_PRIORITY;
  }
  return normalized || FEEDBACK_ACTION_DOWNGRADE_TO_LOW;
}

function feedbackFalsePositiveHasSelector(policy: { rule?: string; path_pattern?: string }): boolean {
  return Boolean(policy.rule?.trim() || policy.path_pattern?.trim());
}

function feedbackFalsePositiveConditionSupported(condition: string | undefined): boolean {
  const normalized = condition?.trim().toLowerCase();
  return !normalized || normalized === "lockfile_only";
}

function feedbackFalsePositiveConditionSatisfied(condition: string | undefined, matchedPaths: string[]): boolean {
  const normalized = condition?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized === "lockfile_only") {
    return matchedPaths.length > 0 && matchedPaths.every(isLockfilePath);
  }
  return false;
}

function isLockfilePath(filePath: string): boolean {
  const normalizedPath = normalizeEvidencePath(filePath);
  return /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|Cargo\.lock)$/.test(normalizedPath);
}

function isMissingTeamPolicyEffect(effect: Pick<FeedbackPolicyEffect, "kind" | "action">): boolean {
  return effect.kind === "team_policy" && effect.action.startsWith(RECORD_MANUAL_CHECK_PREFIX);
}

function isReviewerPreferenceFocusEffect(effect: FeedbackPolicyEffect): boolean {
  return effect.kind === "reviewer_preference" && effect.action === FEEDBACK_ACTION_PRIORITIZE_REVIEW_FOCUS;
}

function manualCheckQuestionText(action: string): string {
  return action.replace(new RegExp(`^${escapeRegExp(RECORD_MANUAL_CHECK_PREFIX)}\\s*`), "");
}

// review-surfaces.HUMAN_REVIEW.23: a reviewer question template appends `?` to
// an embedded summary/action. When that embedded value already ends in ANY
// sentence-ending punctuation (`.`, `?`, or `!`) the template would produce
// doubled terminal punctuation (`.?`, `??`, or `!?`). Strip the ENTIRE trailing
// run of sentence-ending marks — not just one — so a value ending in a
// punctuation run (`?!`, `...`, `!!!`) does not leave a residual mark before the
// appended `?` (e.g. `Really??`, `Waiting..?`). Also trim trailing whitespace
// before AND after the stripped run so the rendered question reads cleanly
// regardless of how the embedded summary was punctuated.
function forQuestionTail(value: string): string {
  return value.replace(/\s+$/, "").replace(/[.?!]+$/, "").replace(/\s+$/, "");
}

function feedbackQueueTitle(effect: FeedbackPolicyEffect): string {
  switch (effect.kind) {
    case "false_negative":
      return "Feedback-requested review focus";
    case "team_policy":
      return "Feedback team policy manual check";
    case "reviewer_preference":
      return "Reviewer-preferred review focus";
    case "false_positive":
      return "Feedback-downgraded risk";
  }
}

function feedbackEffectEvidence(effect: FeedbackPolicyEffect): EvidenceRef[] {
  return [
    ...effect.paths.map((filePath) => fileEvidence(filePath, "Feedback policy matched this changed file.", effect.confidence)),
    ...effect.evidence
  ];
}

function stableFeedbackEffectId(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase();
}

function dedupeFeedbackEffects(drafts: FeedbackPolicyEffectDraft[]): FeedbackPolicyEffectDraft[] {
  const seen = new Set<string>();
  const result: FeedbackPolicyEffectDraft[] = [];
  for (const draft of drafts.sort(compareFeedbackEffectDrafts)) {
    const key = [
      draft.kind,
      draft.action,
      draft.summary,
      draft.paths.join(","),
      draft.risk_ids.join(",")
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(draft);
  }
  return result;
}

function boundedMissingTeamPolicyEffects(drafts: FeedbackPolicyEffectDraft[]): FeedbackPolicyEffectDraft[] {
  if (drafts.length <= MAX_MISSING_TEAM_POLICY_QUESTION_EFFECTS) {
    return drafts;
  }
  const visible = drafts.slice(0, MAX_MISSING_TEAM_POLICY_QUESTION_EFFECTS - 1);
  const overflow = drafts.slice(MAX_MISSING_TEAM_POLICY_QUESTION_EFFECTS - 1);
  return [foldMissingTeamPolicyEffects(overflow), ...visible];
}

function foldMissingTeamPolicyEffects(drafts: FeedbackPolicyEffectDraft[]): FeedbackPolicyEffectDraft {
  const riskIds = uniqueTruthy(drafts.flatMap((draft) => draft.risk_ids)).sort(compareStrings);
  const paths = uniqueTruthy(drafts.flatMap((draft) => draft.paths)).sort(compareStrings);
  const preview = riskIds.slice(0, 4).join(", ");
  const suffix = riskIds.length > 4 ? `, and ${riskIds.length - 4} more` : "";
  const configured = riskIds.every((id) => id.startsWith("config:"));
  const feedbackPolicies = riskIds.every((id) => id.startsWith("policy:"));
  const label = configured
    ? "configured manual check"
    : feedbackPolicies
      ? "feedback policy manual check"
      : "required manual check";
  return {
    kind: "team_policy",
    summary: `${drafts.length} additional ${label}(s) matched changed file(s), but the required manual checks are missing${preview ? `: ${preview}${suffix}.` : "."}`,
    action: `${RECORD_MANUAL_CHECK_PREFIX} ${drafts.length} additional ${label}(s) are missing: ${foldedManualCheckProcedure(drafts)}`,
    evidence: uniqueEvidenceRefs(drafts.flatMap((draft) => draft.evidence)).slice(0, 8),
    paths,
    risk_ids: riskIds,
    confidence: "high"
  };
}

function foldedManualCheckProcedure(drafts: FeedbackPolicyEffectDraft[]): string {
  const items = drafts.map((draft) => ({
    riskId: draft.risk_ids[0] ?? "policy",
    prompt: manualCheckPromptFromAction(draft.action)
  }));
  const visible = items.slice(0, 5).map((item) => {
    return item.prompt ? `${item.riskId}: ${item.prompt}` : item.riskId;
  });
  const suffix = items.length > 5 ? `; and ${items.length - 5} more policy ID(s): ${items.slice(5).map((item) => item.riskId).join(", ")}` : "";
  return `${visible.join("; ")}${suffix}.`;
}

function manualCheckPromptFromAction(action: string): string | undefined {
  if (action.startsWith(RECORD_MANUAL_CHECK_PREFIX)) {
    return action.slice(RECORD_MANUAL_CHECK_PREFIX.length).trim();
  }
  return undefined;
}

function uniqueEvidenceRefs(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const result: EvidenceRef[] = [];
  for (const ref of evidence) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function compareFeedbackEffectDrafts(left: FeedbackPolicyEffectDraft, right: FeedbackPolicyEffectDraft): number {
  return (
    feedbackEffectKindRank(left.kind) - feedbackEffectKindRank(right.kind) ||
    compareStrings(left.action, right.action) ||
    compareStrings(left.summary, right.summary) ||
    compareStrings(left.paths.join(","), right.paths.join(","))
  );
}

function feedbackEffectKindRank(kind: FeedbackPolicyEffect["kind"]): number {
  switch (kind) {
    case "team_policy":
      return 0;
    case "false_negative":
      return 1;
    case "false_positive":
      return 2;
    case "reviewer_preference":
      return 3;
  }
}

function dedupeQueueDrafts(drafts: QueueDraft[]): QueueDraft[] {
  const seen = new Set<string>();
  const result: QueueDraft[] = [];
  for (const draft of drafts) {
    const key = `${draft.path}|${draft.reason}|${draft.reviewer_action}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(draft);
  }
  return result;
}

function buildPrRiskRulePathIndex(prSurface: PrReviewSurfaceModel | undefined): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const risk of prSurface?.risks.candidates ?? []) {
    const paths = risk.evidence
      .filter((ref) => ref.path)
      .map((ref) => normalizeEvidencePath(String(ref.path)));
    if (paths.length === 0) {
      continue;
    }
    const existing = index.get(risk.rule) ?? new Set<string>();
    for (const filePath of paths) {
      existing.add(filePath);
    }
    index.set(risk.rule, existing);
  }
  return index;
}

function prRiskRuleCoversPath(index: Map<string, Set<string>>, rule: string, filePath: string): boolean {
  const normalizedPath = normalizeEvidencePath(filePath);
  return index.get(rule)?.has(normalizedPath) ?? false;
}

function reviewerPreferencePathPatterns(key: string, value: unknown): string[] {
  if (key !== "always_review" && key !== "always_prioritize" && key !== "always_review_surfaces") {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface FeedbackPathMatcher {
  matches(filePath: string | undefined): boolean;
}

function changedFilePathsMatchingAny(changedFiles: PrChangedFile[], matchers: FeedbackPathMatcher[]): string[] {
  return uniqueTruthy(changedFiles.flatMap((file) => changedFileMatchedPaths(file, matchers)));
}

function changedFileMatchedPaths(file: PrChangedFile, matchers: FeedbackPathMatcher[]): string[] {
  const paths = compactStrings([file.path, file.old_path]).map((filePath) => normalizeEvidencePath(filePath));
  return paths.some((filePath) => matchers.some((matcher) => matcher.matches(filePath))) ? uniqueTruthy(paths) : [];
}

function changedFilePathsMatchedByPolicy(file: PrChangedFile, matchers: FeedbackPathMatcher[]): string[] {
  return uniqueTruthy(
    compactStrings([file.path, file.old_path])
      .map((filePath) => normalizeEvidencePath(filePath))
      .filter((filePath) => matchers.some((matcher) => matcher.matches(filePath)))
  );
}

function buildFeedbackPathMatcher(pattern: string | undefined): FeedbackPathMatcher {
  const regex = pattern ? globToRegExp(pattern) : undefined;
  return {
    matches(filePath: string | undefined): boolean {
      if (!filePath) {
        return false;
      }
      if (!regex) {
        return true;
      }
      return regex.test(normalizeEvidencePath(filePath));
    }
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildQuestions(
  input: BuildHumanReviewInput,
  blockers: ReviewBlocker[],
  feedbackEffects: FeedbackPolicyEffect[],
  riskLensFindings: RiskLensFinding[],
  intentMismatch: IntentMismatch,
  config: HumanReviewBuildConfig
): ReviewerQuestion[] {
  const questions: ReviewerQuestion[] = [];
  const focusedGaps = focusedRequirementGaps(input);

  for (const blocker of blockers) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "blocking",
      question: `${blocker.required_action}`,
      reason: blocker.summary,
      evidence: blocker.evidence,
      maps_to_risks: riskIdsFromBlocker(blocker),
      maps_to_requirements: requirementIds(blocker.evidence)
    });
  }

  const schemaRisk = input.prSurface?.risks.candidates.find((risk) => risk.rule === "schema_contract_change");
  if (schemaRisk) {
    questions.push(questionFromPrRisk(questions.length + 1, "blocking", schemaRisk, "Is the schema or persisted artifact contract change additive-only, and where is the compatibility fixture?"));
  }

  if (input.prSurface && !input.prSurface.coverage.base_available) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "clarifying",
      question: "Was the baseline evaluation intentionally unavailable for this run?",
      reason: "Coverage deltas are current-status only when the baseline is unavailable.",
      evidence: [missingEvidence("PR coverage base_available=false.")],
      maps_to_risks: [],
      maps_to_requirements: input.prSurface.coverage.deltas.map((delta) => delta.acai_id ?? delta.requirement_id).slice(0, 8)
    });
  }

  for (const effect of feedbackEffects.filter(isMissingTeamPolicyEffect).slice(0, 3)) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "blocking",
      question: `What current-head evidence records this team-policy manual check: ${forQuestionTail(manualCheckQuestionText(effect.action))}?`,
      reason: effect.summary,
      evidence: feedbackEffectEvidence(effect),
      maps_to_risks: effect.risk_ids,
      maps_to_requirements: requirementIds(effect.evidence)
    });
  }

  for (const effect of feedbackEffects.filter((effect) => effect.kind === "false_negative").slice(0, 3)) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "clarifying",
      question: `Should ${effect.paths.map((filePath) => `\`${filePath}\``).join(", ")} be reviewed under this feedback policy before approval?`,
      reason: effect.summary,
      evidence: feedbackEffectEvidence(effect),
      maps_to_risks: effect.risk_ids,
      maps_to_requirements: requirementIds(effect.evidence)
    });
  }

  for (const finding of riskLensFindings.filter(isPathOnlyRiskLensFinding).slice(0, 3)) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: riskLensQuestionSeverity(finding),
      question: riskLensQuestionText(finding),
      reason: finding.summary,
      evidence: finding.evidence,
      maps_to_risks: finding.risk_ids,
      maps_to_requirements: finding.requirement_ids
    });
  }

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    if (firstPathEvidence(risk.evidence)) {
      continue;
    }
    questions.push(questionFromPrRisk(
      questions.length + 1,
      questionSeverityForRisk(risk.severity),
      risk,
      risk.suggested_checks[0] ?? `How should reviewers account for this pathless PR risk: ${risk.summary}`
    ));
  }

  if (hasNoValidationEvidence(input.packet.risks)) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "clarifying",
      question: "Which validation command or parsed test artifact should reviewers trust for this change?",
      reason: "The packet does not contain direct or indirect validation evidence.",
      evidence: [missingEvidence("No direct or indirect validation evidence found in risks.test_evidence.")],
      maps_to_risks: [],
      maps_to_requirements: []
    });
  }

  for (const gap of focusedGaps.slice(0, 3)) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: gap.status === "missing" || gap.status === "invalid_evidence" ? "blocking" : "clarifying",
      question: `What validation evidence or explicit deferral should close ${gap.acai_id ?? gap.requirement_id}?`,
      reason: gap.summary,
      evidence: requirementGapEvidence(gap),
      maps_to_risks: [],
      maps_to_requirements: compactStrings([gap.acai_id, gap.requirement_id])
    });
  }

  for (const item of intentMismatchQuestionItems(intentMismatch, 3)) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: questionSeverityForRisk(item.severity ?? "unknown"),
      question: `How should reviewers resolve this intent gap: ${forQuestionTail(item.summary)}?`,
      reason: INTENT_MISMATCH_QUESTION_REASON,
      evidence: item.evidence,
      maps_to_risks: [],
      maps_to_requirements: item.requirement_ids
    });
  }

  if (focusedGaps.length === 0) {
    for (const item of missingEvidenceSummaries(input).slice(0, 2)) {
      questions.push({
        id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
        severity: "clarifying",
        question: `What evidence closes this review gap: ${forQuestionTail(item.summary)}?`,
        reason: "The trust audit marks this evidence as missing.",
        evidence: item.evidence,
        maps_to_risks: [],
        maps_to_requirements: requirementIds(item.evidence)
      });
    }
  }

  if (input.prSurface?.status === "blocked" && input.prSurface.blocked_reason !== "no_diff") {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "clarifying",
      question: `Should the PR surface be regenerated so the blocked state (${input.prSurface.blocked_reason ?? "unknown"}) is resolved before review?`,
      reason: "The human artifact can use deterministic facts, but PR narrative evidence is unavailable.",
      evidence: [missingEvidence("PR surface is blocked.")],
      maps_to_risks: [],
      maps_to_requirements: []
    });
  }

  // review-surfaces.METHODOLOGY.7/.8 (D5/D6): surface the methodology audit's item-4
  // findings as reviewer questions — only the ones whose anchor was VALIDATED
  // against a real event id / changed path (so the demoted / unanchored ones never
  // add noise). A finding stays a CLARIFYING/advisory question UNLESS it was PROMOTED
  // (advisory === false) — i.e. an independent deterministic cross-reference check
  // (Phase 3a: a secret finding, a breaking API/schema change, a test-weakening, a
  // moved lockfile) corroborated it — in which case it becomes a BLOCKING question so
  // the promotion bit actually moves reviewer gating (Codex P2). Under the mock
  // default workflow_findings is empty, so this is a no-op on the offline path.
  // Order PROMOTED (non-advisory, corroborated) findings first so the cap never drops
  // a blocking D6 signal in favor of earlier advisory ones (Codex P2). Stable within
  // each group (producer order preserved).
  const orderedWorkflowFindings = (input.packet.methodology.workflow_findings ?? [])
    .filter(workflowFindingHasValidatedAnchor)
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => Number(a.finding.advisory !== false) - Number(b.finding.advisory !== false) || a.index - b.index)
    .map((entry) => entry.finding);
  for (const finding of orderedWorkflowFindings.slice(0, 3)) {
    const corroborated = finding.advisory === false;
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: corroborated ? "blocking" : "clarifying",
      question: corroborated
        ? `A deterministic check corroborated this (${finding.signal_kind.replace(/_/g, " ")}): ${forQuestionTail(finding.summary)}. Confirm it was intended before approval.`
        : `Did the agent's workflow account for this (${finding.signal_kind.replace(/_/g, " ")}): ${forQuestionTail(finding.summary)}?`,
      reason: corroborated
        ? CORROBORATED_WORKFLOW_QUESTION_REASON
        : "The methodology audit of the agent conversation flagged this as advisory; confirm it before approval.",
      evidence: finding.evidence,
      maps_to_risks: [],
      maps_to_requirements: []
    });
  }

  return capQuestionsPreservingIntent(dedupeQuestions(questions), Math.min(MAX_QUESTIONS, config.max_questions));
}

// A methodology workflow finding is worth a reviewer question only when the leaf
// VALIDATED at least one anchor (a known event id or changed path); demoted /
// unanchored findings stay out of the question queue.
function workflowFindingHasValidatedAnchor(finding: { evidence: EvidenceRef[] }): boolean {
  return finding.evidence.some((ref) => ref.validation_status === "valid");
}

// review-surfaces.METHODOLOGY.7/.8 (Phase 4): the agent-workflow audit card for the
// cockpit — considered alternatives (4a), research/context (4b), and the GROUNDED
// item-4 workflow findings (only the validated-anchor ones, so demoted/unanchored
// LLM proposals never add noise — the same signal-to-noise rule the questions use).
// Bounded so the card stays scannable. Empty arrays when the audit produced nothing.
const METHODOLOGY_AUDIT_FLAGS: MethodologyAuditFlag[] = ["methodology_analysis_degraded", "conversation_log_missing", "conversation_truncated"];

// Provider (LLM-proposed) considered/research entries are appended AFTER the keyword
// picks, so a plain head-cap would hide them; surface them FIRST before the cap so
// the grounded 4a/4b audit reaches the cockpit (Codex P2).
function providerFirst(entries: string[]): string[] {
  const provider = entries.filter((entry) => entry.startsWith("LLM-proposed:"));
  const rest = entries.filter((entry) => !entry.startsWith("LLM-proposed:"));
  return [...provider, ...rest].slice(0, 8);
}

function buildMethodologyAudit(input: BuildHumanReviewInput): MethodologyAudit {
  const methodology = input.packet.methodology;
  return {
    quality_flags: (methodology.quality_flags ?? []).filter((flag): flag is MethodologyAuditFlag =>
      (METHODOLOGY_AUDIT_FLAGS as string[]).includes(flag)
    ),
    considered: providerFirst(methodology.considered ?? []),
    research: providerFirst(methodology.research ?? []),
    workflow_findings: (methodology.workflow_findings ?? [])
      .filter(workflowFindingHasValidatedAnchor)
      // Promoted (corroborated, advisory===false) findings first so the cap never
      // drops a blocking D6 signal for earlier advisory ones (Codex P2).
      .map((finding, index) => ({ finding, index }))
      .sort((a, b) => Number(a.finding.advisory !== false) - Number(b.finding.advisory !== false) || a.index - b.index)
      .map((entry) => entry.finding)
      .slice(0, 8)
      .map((finding) => ({
        id: finding.id,
        signal_kind: finding.signal_kind,
        summary: finding.summary,
        severity: finding.severity,
        advisory: finding.advisory,
        evidence: finding.evidence
      }))
  };
}

function capQuestionsPreservingIntent(questions: ReviewerQuestion[], limit: number): ReviewerQuestion[] {
  if (limit <= 0) {
    return [];
  }
  if (questions.length <= limit) {
    return renumberQuestions(questions);
  }

  const selected = questions.slice(0, limit);
  // Questions the head-cap must not silently drop just because they were appended late:
  // the FIRST intent-mismatch question (matching the prior single-preserve behavior),
  // plus EVERY corroborated (blocking) D6 workflow question. Process them HIGHEST
  // severity first so a blocking corroborated question wins a scarce slot over a
  // lower-severity intent question; swap each in over the LAST selected question of
  // equal-or-lower severity that is not itself preserved (Codex P2, #109).
  const firstIntent = questions.find(isIntentMismatchQuestion);
  const preserved = questions.filter((question) => question.reason === CORROBORATED_WORKFLOW_QUESTION_REASON);
  if (firstIntent) {
    preserved.push(firstIntent);
  }
  preserved.sort((a, b) => questionSeverityRank(b.severity) - questionSeverityRank(a.severity));
  for (const priority of preserved) {
    if (selected.includes(priority)) {
      continue;
    }
    const priorityRank = questionSeverityRank(priority.severity);
    // Evict the last selected question of equal-or-lower severity that is either not
    // preserved, or is a STRICTLY lower-severity preserved one — so a blocking
    // corroborated question can take a scarce slot from a clarifying intent question,
    // but two equal-severity preserved questions never thrash (Codex #110).
    const replacementIndex = findLastQuestionIndex(
      selected,
      (question) =>
        questionSeverityRank(question.severity) <= priorityRank &&
        (!preserved.includes(question) || questionSeverityRank(question.severity) < priorityRank)
    );
    if (replacementIndex < 0) {
      continue;
    }
    selected[replacementIndex] = priority;
  }
  return renumberQuestions(dedupeQuestions(selected).slice(0, limit));
}

function isIntentMismatchQuestion(question: ReviewerQuestion): boolean {
  return question.reason === INTENT_MISMATCH_QUESTION_REASON;
}

function findLastQuestionIndex(questions: ReviewerQuestion[], predicate: (question: ReviewerQuestion) => boolean): number {
  for (let index = questions.length - 1; index >= 0; index -= 1) {
    if (predicate(questions[index])) {
      return index;
    }
  }
  return -1;
}

function questionSeverityRank(severity: ReviewerQuestion["severity"]): number {
  switch (severity) {
    case "blocking":
      return 3;
    case "clarifying":
      return 2;
    case "optional":
      return 1;
    default:
      return 0;
  }
}

function renumberQuestions(questions: ReviewerQuestion[]): ReviewerQuestion[] {
  return questions.map((question, index) => ({
    ...question,
    id: `QUESTION-${String(index + 1).padStart(3, "0")}`
  }));
}

function intentMismatchQuestionItems(intentMismatch: IntentMismatch, limit: number): IntentMismatchItem[] {
  const buckets = [
    intentMismatch.missing_intent,
    intentMismatch.possible_overreach,
    intentMismatch.possible_mismatches
  ];
  const selected: IntentMismatchItem[] = [];
  for (const bucket of buckets) {
    if (bucket[0]) {
      selected.push(bucket[0]);
    }
    if (selected.length >= limit) {
      return selected;
    }
  }
  for (const bucket of buckets) {
    for (const item of bucket.slice(1)) {
      selected.push(item);
      if (selected.length >= limit) {
        return selected;
      }
    }
  }
  return selected;
}

function riskLensQuestionSeverity(finding: RiskLensFinding): ReviewerQuestion["severity"] {
  return isBlockingRiskLensFinding(finding) ? "blocking" : "clarifying";
}

function isPathOnlyRiskLensFinding(finding: RiskLensFinding): boolean {
  return finding.risk_ids.length === 0;
}

function riskLensQuestionText(finding: RiskLensFinding): string {
  switch (finding.lens) {
    case "api_contract":
      return hasVersionedArtifactContractPath(finding.paths)
        ? "What compatibility fixture, schema versioning decision, or downstream contract check covers this API/schema contract change?"
        : "Which focused CLI, config, or feature-ledger test covers this public contract change?";
    case "security_privacy":
      return "What current-head evidence proves the changed security/privacy boundary does not expose secrets or unredacted sensitive data?";
    case "llm_trust_boundary":
      return "Which fixture proves fabricated LLM paths, requirements, risks, statuses, or anchors are rejected before rendering?";
    case "test_evidence":
      return "Which parsed test output, coverage fixture, or command transcript proves this evidence path remains trustworthy?";
    case "reviewer_ux":
      return "Where is the rendered Markdown or diagram fixture reviewers should inspect for this UI/comment surface change?";
    case "cache_provenance":
      return "Which cache/provenance fixture proves stale or mismatched review artifacts cannot be reused?";
    case "supply_chain":
      return "Is this dependency change intentional, and has the package been vetted for install scripts, pinning, and maintenance?";
    case "architecture":
      return "Is the new module-boundary dependency edge intentional, and should it be documented as an architecture decision?";
    case "custom":
      return "What reviewer action should close this custom risk lens finding?";
  }
}

function buildSuggestedComments(
  input: BuildHumanReviewInput,
  blockers: ReviewBlocker[],
  riskLensFindings: RiskLensFinding[],
  config: HumanReviewBuildConfig,
  semanticFacts: SemanticChangeFacts
): SuggestedReviewComment[] {
  const comments: SuggestedReviewComment[] = [];
  const candidates: SuggestedCommentCandidate[] = [];
  const focusedGaps = focusedRequirementGaps(input);

  // review-surfaces.SEMANTIC_DIFF.1/.4: suggested comments naming the concrete
  // contract change (e.g. the field that became required), ranked first.
  const semanticCandidates = semanticCommentCandidates(semanticFacts);
  candidates.push(...semanticCandidates);
  // review-surfaces.SEMANTIC_DIFF.4: a concrete semantic-fact comment supersedes a
  // generic risk-lens comment of the same severity on the same path — the lens
  // prose ("this fires the API/schema contract lens...") would be a near-duplicate
  // ask a reviewer would post twice on one file.
  const semanticCommentCoverage = new Set(
    semanticCandidates
      .filter((candidate) => candidate.draft.path)
      .map((candidate) => `${candidate.draft.severity}:${candidate.draft.path}`)
  );

  for (const blocker of blockers) {
    const first = firstPathEvidence(blocker.evidence);
    candidates.push({
      sourceRank: 0,
      sortKey: blocker.id,
      draft: stripUndefined({
        severity: "blocking",
        path: first?.path,
        line_start: first?.line_start,
        line_end: first?.line_end,
        body: blocker.required_action,
        evidence: blocker.evidence,
        risk_ids: riskIdsFromBlocker(blocker),
        requirement_ids: requirementIds(blocker.evidence),
        confidence: "high",
        ready_to_post: blocker.evidence.length > 0
      })
    });
  }

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    // A critical risk already escalated to a blocker has a blocker comment above;
    // a second per-rule draft for the same risk would be a duplicate ask.
    if (blockers.some((blocker) => blocker.id === `BLOCK-${risk.id}`)) {
      continue;
    }
    for (const draft of commentDraftsForPrRisk(input, risk)) {
      candidates.push({ risk, draft, sourceRank: 1, sortKey: risk.id });
    }
  }

  for (const finding of riskLensFindings.filter(isPathOnlyRiskLensFinding)) {
    // review-surfaces.SEMANTIC_DIFF.5: only the lenses a semantic-fact comment
    // actually duplicates may be deduped against it — the api/schema-contract lens
    // (schema_changes/api_changes) and the test-evidence lens (test_weakening). A
    // distinct blocking lens on the same path (e.g. the LLM trust-boundary lens on
    // a schema change under src/llm/) is a different concern and must survive.
    const lensDuplicatesSemantic = finding.lens === "api_contract" || finding.lens === "test_evidence";
    for (const comment of finding.suggested_comments) {
      if (lensDuplicatesSemantic && comment.path && semanticCommentCoverage.has(`${comment.severity}:${comment.path}`)) {
        continue;
      }
      candidates.push({ draft: commentDraftWithoutId(comment), sourceRank: 2, sortKey: finding.id });
    }
  }

  if (hasNoValidationEvidence(input.packet.risks)) {
    candidates.push({
      sourceRank: 3,
      sortKey: "missing-validation-evidence",
      draft: {
        severity: "clarifying",
        body: "I do not see direct validation evidence in the packet. Can you record the relevant test/typecheck command transcript or parsed test output?",
        evidence: [missingEvidence("No direct or indirect validation evidence found.")],
        risk_ids: [],
        requirement_ids: [],
        confidence: "medium",
        ready_to_post: true
      }
    });
  }

  const focusedGap = focusedGaps[0];
  if (focusedGap) {
    candidates.push({
      sourceRank: 4,
      sortKey: focusedGap.acai_id ?? focusedGap.requirement_id,
      draft: {
        severity: focusedGap.status === "missing" || focusedGap.status === "invalid_evidence" ? "blocking" : "clarifying",
        body: `Can you point to the validation evidence or explicit deferral for ${focusedGap.acai_id ?? focusedGap.requirement_id}? The human review surface currently marks it as ${focusedGap.status}.`,
        evidence: requirementGapEvidence(focusedGap),
        risk_ids: [],
        requirement_ids: compactStrings([focusedGap.acai_id, focusedGap.requirement_id]),
        confidence: "medium",
        ready_to_post: true
      }
    });
  }

  for (const candidate of candidates.sort(compareSuggestedCommentCandidates)) {
    appendSuggestedComment(comments, candidate.draft);
  }

  return comments.slice(0, Math.min(MAX_COMMENTS, config.max_suggested_comments));
}

// review-surfaces.SEMANTIC_DIFF.1/.3/.4: suggested comments from semantic facts,
// naming the concrete change (a field that became required, a removed assertion,
// a changed export). Ranked above the generic comments.
function semanticCommentCandidates(facts: SemanticChangeFacts): SuggestedCommentCandidate[] {
  const candidates: SuggestedCommentCandidate[] = [];
  const add = (severity: SuggestedReviewComment["severity"], path: string, body: string, sortKey: string): void => {
    candidates.push({
      sourceRank: -1,
      sortKey,
      draft: {
        severity,
        path,
        body,
        evidence: [fileEvidence(path, "Semantic change fact.")],
        risk_ids: [],
        requirement_ids: [],
        confidence: "high",
        ready_to_post: true
      }
    });
  };
  for (const signal of facts.test_weakening) {
    add("blocking", signal.path, `${signal.detail} (${signal.kind.replace(/_/g, " ")})`, `semantic-test:${signal.kind}:${signal.path}`);
  }
  for (const change of facts.schema_changes) {
    add("blocking", change.path, `${schemaChangeReason(change)} Please version the contract or migrate existing artifacts.`, `semantic-schema:${change.path}`);
  }
  for (const change of facts.api_changes) {
    add("clarifying", change.path, `${apiChangeReason(change)}${apiCallerCallToAction(change)}`, `semantic-api:${change.path}`);
  }
  // review-surfaces.SEMANTIC_DIFF.4/.5: a ready-to-post comment for each Swift
  // declaration change, carrying the concrete detail (a breaking public change blocks).
  for (const change of facts.swift_declaration_changes) {
    add(
      change.breaking ? "blocking" : "clarifying",
      change.path,
      `${change.detail} Confirm callers/conformers are updated or the change is intentional.`,
      `semantic-swift:${change.change}:${change.path}:${change.name}`
    );
  }
  return candidates;
}

// review-surfaces.SEMANTIC_DIFF.4: the call-to-action must agree with the blast
// radius apiChangeReason just stated. When no in-repo importer references the
// changed exports, "Please confirm callers are updated." contradicts the prose;
// ask about external/runtime consumers instead.
function apiCallerCallToAction(change: ApiSurfaceChange): string {
  const usedBy = change.used_by;
  if (usedBy && usedBy.count === 0 && !usedBy.truncated) {
    return " Confirm there are no external or runtime consumers (downstream packages, the CLI, persisted callers) before treating this as safe.";
  }
  return " Please confirm callers are updated.";
}

function commentDraftWithoutId(comment: SuggestedReviewComment): SuggestedCommentDraft {
  const { id: _id, ...draft } = comment;
  return draft;
}

function buildTrustAudit(input: BuildHumanReviewInput): TrustAudit {
  const positiveEvidenceFacts = positiveValidationEvidence(input.packet.risks).map((evidence) => ({
    summary: evidence.note ?? evidence.command ?? evidence.test_name ?? "Verified validation evidence is present.",
    evidence: [evidence]
  }));

  const prFacts: TrustFactDraft[] = [];
  if (input.prSurface) {
    // review-surfaces.COLD_START.5: no affected-requirement clause on spec-less PRs.
    const speclessTrust = isSpeclessIntent(input.packet.intent);
    prFacts.push({
      summary: speclessTrust
        ? `PR scope contains ${input.prSurface.scope.changed_files.length} changed file(s) and ${input.prSurface.risks.candidates.length} deterministic PR risk candidate(s).`
        : `PR scope contains ${input.prSurface.scope.changed_files.length} changed file(s), ${input.prSurface.scope.affected_requirements.length} affected requirement(s), and ${input.prSurface.risks.candidates.length} deterministic PR risk candidate(s).`,
      evidence: input.prSurface.scope.changed_files.slice(0, 5).map((file) => fileEvidence(file.path, "Changed file included in PR scope."))
    });

    for (const risk of input.prSurface.risks.candidates) {
      if (prFacts.length >= MAX_TRUST_ITEMS) {
        break;
      }
      const concreteEvidence = risk.evidence.filter(isVerifiedTrustEvidence);
      if (concreteEvidence.length === 0) {
        continue;
      }
      prFacts.push({
        summary: `Deterministic PR risk ${risk.id} (${risk.rule}) fired: ${risk.summary}`,
        evidence: concreteEvidence.slice(0, 3)
      });
    }
  }

  const verified = withTrustFactIds([
    ...prFacts.slice(0, MAX_TRUST_ITEMS),
    ...positiveEvidenceFacts.slice(0, Math.max(0, MAX_TRUST_ITEMS - prFacts.length))
  ]);

  const claimed = [
    ...input.packet.methodology.claims_without_evidence.map((claim, index) => ({
      id: `TRUST-CLAIM-${String(index + 1).padStart(3, "0")}`,
      claim,
      status: "unverified" as const,
      missing_evidence: "No command transcript or parsed test artifact verifies this claim.",
      evidence: input.packet.methodology.evidence.length ? input.packet.methodology.evidence.slice(0, 3) : [missingEvidence("Methodology claim lacks evidence.")]
    })),
    ...input.packet.risks.test_evidence
      .filter((item) => isClaimedValidationEvidence(item, input.commandRules ?? []))
      .map((item, index) => ({
        id: `TRUST-CLAIM-TEST-${String(index + 1).padStart(3, "0")}`,
        claim: item.summary,
        status: "unverified" as const,
        missing_evidence: "The command or test is claimed but not backed by direct parsed output or transcript evidence.",
        evidence: item.evidence ?? [missingEvidence(item.summary)]
      }))
  ].slice(0, MAX_TRUST_ITEMS);

  const missing = missingEvidenceSummaries(input);
  const invalid = invalidEvidenceSummaries(input);

  return {
    verified_facts: verified,
    claimed_not_verified: claimed,
    missing_evidence: missing,
    invalid_evidence: invalid,
    confidence_summary: confidenceSummary(verified.length, claimed.length, missing.length, invalid.length)
  };
}

function isClaimedValidationEvidence(
  item: RisksModel["test_evidence"][number],
  commandRules: readonly CommandRule[] = []
): boolean {
  if (item.kind !== "claimed") {
    return false;
  }
  // review-surfaces.EVIDENCE.8: a feedback-recorded passed command is always a
  // claim that must surface under "Claimed but not verified" — it must never
  // silently vanish from both sections — even when its command is a project-
  // specific validator (e.g. `make verify`) we do not recognize as local validation.
  if ((item.evidence ?? []).some((ref) => ref.kind === "feedback")) {
    return true;
  }
  const commands = (item.evidence ?? [])
    .map((ref) => ref.command)
    .filter((command): command is string => typeof command === "string" && command.length > 0);
  if (commands.length === 0) {
    return true;
  }
  // review-surfaces.COLLECTOR.9: pass the configured wrapper rules so a wrapper the
  // risks model recognized as validation (via a command_rule) does not vanish from
  // "Claimed but not verified" because this re-check was rule-blind.
  return commands.some((command) => commandLooksLikeLocalValidationCommand(command, commandRules));
}

// review-surfaces.HUMAN_REVIEW.21: each focused-requirement test item's "Expected"
// must describe what passing looks like for THIS gap, derived from its
// deterministic partial_reason/status — not restate the project-wide determinism
// invariant identically across every TEST-### item.
function expectedResultForGap(gap: RequirementGap): string {
  switch (gap.partial_reason) {
    case "impl_no_test":
      return "A direct test exercises this requirement's behavior, so a regression would fail a check.";
    case "impl_broad_no_exact_test":
      // Exact TEST evidence already exists; the gap is exact IMPLEMENTATION proof.
      return "The implementation is tied to this requirement by an exact ACID reference in the code, not just broad-area code.";
    case "exact_impl_broad_test":
      return "A focused test pins the exact changed behavior rather than the broad area.";
    case "broad_area_only":
      return "A test ties directly to this requirement instead of only its general area.";
    case "test_no_impl":
      return "The implementation backing this requirement is present and exercised by the test.";
    default:
      return gap.status === "missing" || gap.status === "invalid_evidence"
        ? "Direct implementation and a test prove this requirement's behavior exists."
        : "A focused test gives this requirement direct, evidence-backed coverage.";
  }
}

// review-surfaces.HUMAN_REVIEW.21: a broad-evidence gap's "Evidence gap" is
// matcher-confidence prose with nothing to act on; append the file the test
// should land in so the reviewer has a concrete next step.
function evidenceGapForGap(gap: RequirementGap, suggestedFile: string | undefined): string {
  // impl_broad_no_exact_test means an exact TEST already exists and the gap is
  // exact IMPLEMENTATION proof, so point at the code, not another test file.
  if (gap.partial_reason === "impl_broad_no_exact_test") {
    return `${trimSentenceEnd(gap.summary)} — tie the implementation to this requirement with an exact ACID reference in the code.`;
  }
  // These two genuinely need a requirement-specific test, so name where it lands.
  const needsTest = gap.partial_reason === "broad_area_only" || gap.partial_reason === "exact_impl_broad_test";
  if (needsTest && suggestedFile) {
    return `${trimSentenceEnd(gap.summary)} — add a direct assertion in \`${suggestedFile}\`.`;
  }
  return gap.summary;
}

function buildTestPlan(
  input: BuildHumanReviewInput,
  feedbackEffects: FeedbackPolicyEffect[],
  riskLensFindings: RiskLensFinding[]
): TestPlanItem[] {
  const items: TestPlanItem[] = [];
  const candidates: TestPlanCandidate[] = [];

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    for (const draft of testPlanDraftsForPrRisk(input, risk)) {
      candidates.push({ risk, draft, sourceRank: 0, sortKey: risk.id });
    }
  }

  for (const finding of riskLensFindings.filter(isPathOnlyRiskLensFinding)) {
    for (const testItem of finding.suggested_tests) {
      candidates.push({
        lens: finding,
        draft: testPlanDraftWithoutId(testItem),
        sourceRank: 2,
        sortKey: finding.id
      });
    }
  }

  for (const [index, gap] of focusedRequirementGaps(input).slice(0, MAX_FOCUSED_REQUIREMENT_TESTS).entries()) {
    const requirementId = gap.acai_id ?? gap.requirement_id;
    const suggestedFile = suggestedTestFile(requirementId, gap.summary);
    candidates.push({
      sourceRank: 1,
      sortKey: rankedSortKey(index, requirementId),
      draft: {
        kind: "automatic",
        priority: gap.status === "missing" || gap.status === "invalid_evidence" ? "required" : "recommended",
        suggested_file: suggestedFile,
        scenario: `Add a focused unit or fixture test tied to ${requirementId}.`,
        expected_result: expectedResultForGap(gap),
        command: suggestedFile ? `pnpm run test -- ${suggestedFile}` : "pnpm run test",
        maps_to_requirements: compactStrings([gap.acai_id, gap.requirement_id]),
        maps_to_risks: [],
        evidence_gap: evidenceGapForGap(gap, suggestedFile)
      }
    });
  }

  for (const [index, gap] of [...(input.packet.risks.missing_automatic_tests ?? [])].sort(compareMissingGapPriority).entries()) {
    const suggestedFile = suggestedTestFile(gap.acai_id, gap.suggested_test);
    candidates.push({
      sourceRank: 3,
      sortKey: rankedSortKey(index, gap.acai_id ?? gap.requirement_id ?? gap.id),
      draft: {
        kind: "automatic",
        priority: "recommended",
        suggested_file: suggestedFile,
        scenario: gap.suggested_test,
        expected_result: "The packet records direct or requirement-specific test evidence for the mapped requirement.",
        command: suggestedFile ? `pnpm run test -- ${suggestedFile}` : "pnpm run test",
        maps_to_requirements: compactStrings([gap.acai_id, gap.requirement_id]),
        maps_to_risks: [],
        evidence_gap: gap.summary
      }
    });
  }

  for (const [index, gap] of [...(input.packet.risks.missing_manual_checks ?? [])].sort(compareMissingGapPriority).entries()) {
    candidates.push({
      sourceRank: 4,
      sortKey: rankedSortKey(index, gap.acai_id ?? gap.requirement_id ?? gap.id),
      draft: {
        kind: "manual",
        priority: "recommended",
        scenario: gap.manual_check,
        expected_result: "Reviewer records the files inspected, conclusion, and any follow-up action.",
        maps_to_requirements: compactStrings([gap.acai_id, gap.requirement_id]),
        maps_to_risks: [],
        evidence_gap: gap.summary
      }
    });
  }

  for (const [index, effect] of feedbackEffects.filter(isMissingTeamPolicyEffect).entries()) {
    candidates.push({
      sourceRank: -1,
      sortKey: rankedSortKey(index, effect.id),
      draft: {
        kind: "manual",
        priority: "required",
        scenario: effect.action,
        expected_result: "Reviewer records the files inspected, conclusion, and any follow-up action in local feedback for the current head.",
        maps_to_requirements: requirementIds(effect.evidence),
        maps_to_risks: effect.risk_ids,
        evidence_gap: effect.summary
      }
    });
  }

  for (const candidate of candidates.sort(compareTestPlanCandidates)) {
    appendTestPlanItem(items, candidate.draft);
  }

  return items.slice(0, MAX_TEST_PLAN);
}

function testPlanDraftWithoutId(item: TestPlanItem): TestPlanDraft {
  const { id: _id, ...draft } = item;
  return draft;
}

function testPlanDraftsForPrRisk(input: BuildHumanReviewInput, risk: PrRiskCandidate): TestPlanDraft[] {
  const riskEvidence = evidenceOrMissing(risk.evidence, risk.summary);
  const path = firstPathEvidence(risk.evidence)?.path;
  const suggestedFile = suggestedTestFileForPath(path);
  const mapsToRisks = [risk.id];
  const riskDraft = (draft: TestPlanDraftCore): TestPlanDraft => ({
    ...draft,
    maps_to_requirements: draft.maps_to_requirements ?? requirementIdsForPrRisk(input, risk),
    maps_to_risks: draft.maps_to_risks ?? mapsToRisks,
    evidence_gap: draft.evidence_gap ?? risk.summary
  });

  switch (risk.rule) {
    case "coverage_regression":
      return [riskDraft({
        kind: "automatic",
        priority: "required",
        suggested_file: "tests/scoped-coverage.test.ts",
        scenario: "Add or restore a fixture proving the regressed requirement returns to satisfied or partial-with-evidence coverage.",
        expected_result: "The scoped coverage delta no longer reports a regression for the mapped requirement.",
        command: "pnpm run test -- tests/scoped-coverage.test.ts"
      })];
    case "untested_changed_impl":
      return [riskDraft({
        kind: "automatic",
        priority: "required",
        suggested_file: suggestedFile,
        scenario: `Add or identify a focused test that exercises the changed implementation${path ? ` in ${path}` : ""}.`,
        expected_result: "A direct test or command transcript demonstrates the changed implementation behavior before approval.",
        command: suggestedFile ? `pnpm run test -- ${suggestedFile}` : "pnpm run test"
      })];
    case "unmapped_change":
      // review-surfaces.COLD_START.5: spec-less repos are never asked to map
      // files to requirements — review areas are the only mapping concept.
      return isSpeclessIntent(input.packet.intent)
        ? [riskDraft({
            kind: "manual",
            priority: "recommended",
            scenario: "Inspect the unmapped changed files and decide whether they need review-area mappings.",
            expected_result: "Each unmapped file is either mapped to a review area or explicitly recorded as generated, ignored, or non-product behavior."
          })]
        : [riskDraft({
            kind: "manual",
            priority: "recommended",
            scenario: "Inspect the unmapped changed files and decide whether they need review-area or requirement mappings.",
            expected_result: "Each unmapped file is either mapped to a review area/requirement or explicitly recorded as generated, ignored, or non-product behavior."
          })];
    case "privacy_sensitive_change":
      return [riskDraft({
        kind: "automatic",
        priority: "required",
        suggested_file: suggestedFile ?? "tests/privacy.test.ts",
        scenario: "Exercise the changed privacy, provider, redaction, secret, or token-handling path with sensitive-looking input.",
        expected_result: "No secret or unredacted sensitive value is emitted to artifacts, logs, comments, or remote-provider prompts.",
        command: `pnpm run test -- ${suggestedFile ?? "tests/privacy.test.ts"}`
      })];
    case "secret_in_diff":
      return [riskDraft({
        kind: "manual",
        priority: "required",
        scenario: "Remove the committed secret from the change and rotate the credential.",
        expected_result: "The secret no longer appears in the diff and the credential has been rotated (a committed secret is leaked)."
      })];
    case "comment_surface_change":
      return [riskDraft({
        kind: "automatic",
        priority: "recommended",
        suggested_file: "tests/pr-comment.test.ts",
        scenario: "Render the changed reviewer-facing Markdown surface from a deterministic fixture.",
        expected_result: "The Markdown stays bounded, evidence-backed, and avoids whole-packet fallback in PR mode.",
        command: "pnpm run test -- tests/pr-comment.test.ts"
      })];
    case "ci_secret_boundary_change":
      if (hasRecordedCiSecretBoundaryManualCheck(input)) {
        return [];
      }
      return [riskDraft({
        kind: "manual",
        priority: "required",
        scenario: "Inspect workflow/provider/comment-posting changes for the CI secret boundary.",
        expected_result: "Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets, and secret-bearing steps run only from trusted code.",
        evidence_gap: "No manual CI secret-boundary check is recorded."
      })];
    case "schema_contract_change":
      return [riskDraft({
        kind: "automatic",
        priority: "required",
        suggested_file: "tests/schema-contract.test.ts",
        scenario: "Load a previous valid human or PR review surface fixture and validate it against the current schema.",
        expected_result: "The fixture validates, or the schema version is intentionally bumped for a breaking contract change.",
        command: "pnpm run test -- tests/schema-contract.test.ts"
      })];
    case "deleted_or_renamed_surface":
      return [riskDraft({
        kind: "automatic",
        priority: "recommended",
        suggested_file: suggestedFile,
        scenario: `Run or add a reference/import test for the deleted or renamed surface${path ? ` around ${path}` : ""}.`,
        expected_result: "No stale imports, generated artifact references, or reviewer-facing links point at the removed path.",
        command: suggestedFile ? `pnpm run test -- ${suggestedFile}` : "pnpm run test"
      })];
    case "failed_or_skipped_test":
      return [riskDraft({
        kind: "automatic",
        priority: "required",
        scenario: "Rerun the affected test command after fixing failures and confirming skipped tests are intentional.",
        expected_result: "Parsed test output records zero failures, and any skipped tests are explicitly justified or removed.",
        command: "pnpm run test"
      })];
    case "large_diff":
      return [riskDraft({
        kind: "manual",
        priority: "optional",
        scenario: "Decide whether the large diff should be split or reviewed with extra owner attention.",
        expected_result: "Reviewer records whether the diff size is acceptable for one review and which areas received deeper inspection.",
        evidence_gap: riskEvidence[0]?.note ?? risk.summary
      })];
  }
}

function compareTestPlanCandidates(
  left: TestPlanCandidate,
  right: TestPlanCandidate
): number {
  return (
    testPlanPriorityRank(left.draft.priority) - testPlanPriorityRank(right.draft.priority) ||
    (left.sourceRank - right.sourceRank) ||
    severityWeight(right.risk?.severity ?? right.lens?.severity ?? "unknown") - severityWeight(left.risk?.severity ?? left.lens?.severity ?? "unknown") ||
    ruleWeight(right.risk?.rule) - ruleWeight(left.risk?.rule) ||
    compareStrings(left.sortKey, right.sortKey)
  );
}

function testPlanPriorityRank(priority: TestPlanItem["priority"]): number {
  switch (priority) {
    case "required":
      return 0;
    case "recommended":
      return 1;
    case "optional":
      return 2;
  }
}

function rankedSortKey(index: number, key: string): string {
  return `${String(index).padStart(4, "0")}:${key}`;
}

function requirementIdsForPrRisk(input: BuildHumanReviewInput, risk: PrRiskCandidate): string[] {
  const fromEvidence = requirementIds(risk.evidence);
  if (risk.rule !== "coverage_regression") {
    return fromEvidence;
  }
  const fromDeltas = input.prSurface?.coverage.deltas
    .filter((delta) => delta.delta === "regressed")
    .map((delta) => delta.acai_id ?? delta.requirement_id) ?? [];
  return uniqueTruthy([...fromEvidence, ...fromDeltas]).slice(0, 8);
}

function withTestPlanId(index: number, draft: TestPlanDraft): TestPlanItem {
  return stripUndefined({
    id: `TEST-${String(index).padStart(3, "0")}`,
    ...draft
  });
}

function appendTestPlanItem(items: TestPlanItem[], draft: TestPlanDraft): void {
  if (items.length >= MAX_TEST_PLAN) {
    return;
  }
  const candidate = withTestPlanId(items.length + 1, draft);
  const candidateKey = testPlanDedupeKey(candidate);
  if (items.some((item) => testPlanDedupeKey(item) === candidateKey)) {
    return;
  }
  items.push(candidate);
}

function appendSuggestedComment(items: SuggestedReviewComment[], draft: SuggestedCommentDraft): void {
  if (items.length >= MAX_COMMENTS) {
    return;
  }
  const candidate = withSuggestedCommentId(items.length + 1, draft);
  const candidateKey = suggestedCommentDedupeKey(candidate);
  if (items.some((item) => suggestedCommentDedupeKey(item) === candidateKey)) {
    return;
  }
  items.push(candidate);
}

function withSuggestedCommentId(index: number, draft: SuggestedCommentDraft): SuggestedReviewComment {
  return stripUndefined({
    id: `SC-${String(index).padStart(3, "0")}`,
    ...draft
  });
}

function buildSkimSafe(input: BuildHumanReviewInput, feedbackEffects: FeedbackPolicyEffect[]): HumanReviewModel["skim_safe"] {
  const highRiskPaths = new Set<string>();
  for (const item of [...(input.prSurface?.risks.candidates ?? []), ...input.packet.risks.items]) {
    if (isElevatedSeverity(item.severity)) {
      for (const ref of item.evidence ?? []) {
        if (ref.path) {
          highRiskPaths.add(ref.path);
        }
      }
    }
  }
  const feedbackFocusPaths = new Set(
    feedbackEffects
      .filter((effect) => effect.kind === "false_negative" || effect.kind === "team_policy" || isReviewerPreferenceFocusEffect(effect))
      .flatMap((effect) => effect.paths)
      .map((filePath) => normalizeEvidencePath(filePath))
  );

  return (input.prSurface?.scope.changed_files ?? [])
    .filter((file) => !highRiskPaths.has(file.path))
    .filter((file) => !feedbackFocusPaths.has(normalizeEvidencePath(file.path)))
    .filter((file) => isSkimSafeCandidate(file.path, file.role))
    .slice(0, 8)
    .map((file) => ({
      path: file.path,
      reason: file.role === "generated" ? "Generated artifact with no mapped high-risk finding." : file.role === "doc" ? "Docs-only changed file with no mapped high-risk finding." : "Lockfile or generated dependency metadata with no mapped high-risk finding.",
      caveat: file.role === "doc" ? "Inspect if the doc defines product contracts, policies, or reviewer workflows." : "Inspect if runtime dependency versions or generated artifacts are intentionally part of the change.",
      evidence: [fileEvidence(file.path, "Changed file considered skim-safe by deterministic role/path heuristics.", "low")],
      confidence: "low" as const
    }));
}

function summarizeHumanReview(
  input: BuildHumanReviewInput,
  queueCount: number,
  blockerCount: number
): string {
  // review-surfaces.HUMAN_REVIEW.24: lead with what a reviewer acts on (blockers
  // and queue items), not a restatement of the verdict badge or a "generated from
  // local evidence" preamble the section header already establishes. The
  // denominator is the changed-file count — the scope a reviewer actually feels —
  // never "217 requirement result(s)".
  // review-surfaces.COLD_START.5: a spec-less packet never advertises
  // "0 requirement result(s)" — the spec-coupled counts are simply absent.
  const specless = isSpeclessIntent(input.packet.intent);
  // Only assert a changed-file count when the diff is actually present. A review
  // rebuilt from an existing packet (no inputs/diff.patch) must not claim
  // "0 changed file(s)" — it falls back to the packet-risk denominator instead.
  const changedFilePart = input.diff ? `${input.diff.files.length} changed file(s), ` : "";
  const scope = input.prSurface
    ? specless
      ? `${input.prSurface.scope.changed_files.length} changed file(s), ${input.prSurface.risks.candidates.length} PR risk candidate(s)`
      : `${input.prSurface.scope.changed_files.length} changed file(s), ${input.prSurface.scope.affected_requirements.length} affected requirement(s), ${input.prSurface.risks.candidates.length} PR risk candidate(s)`
    : `${changedFilePart}${input.packet.risks.items.length} packet risk(s)`;
  return `${blockerCount} blocker(s) and ${queueCount} review queue item(s) across ${scope}.`;
}

function missingEvidenceSummaries(input: BuildHumanReviewInput): MissingEvidenceSummary[] {
  const missing: MissingEvidenceSummary[] = [];
  for (const item of input.packet.risks.test_evidence) {
    if (item.kind === "missing" || item.kind === "unknown") {
      missing.push({
        id: `MISSING-${String(missing.length + 1).padStart(3, "0")}`,
        summary: item.summary,
        evidence: item.evidence ?? [missingEvidence(item.summary)]
      });
    }
  }
  if (input.prSurface && !input.prSurface.coverage.base_available) {
    missing.push({
      id: `MISSING-${String(missing.length + 1).padStart(3, "0")}`,
      summary: "Baseline evaluation unavailable; coverage deltas are current-status only.",
      evidence: [missingEvidence("coverage.base_available=false")]
    });
  }
  for (const gap of input.packet.risks.missing_manual_checks ?? []) {
    missing.push({
      id: `MISSING-${String(missing.length + 1).padStart(3, "0")}`,
      summary: gap.summary,
      evidence: gap.evidence ?? [missingEvidence(gap.manual_check)]
    });
  }
  return missing.slice(0, MAX_TRUST_ITEMS);
}

function invalidEvidenceSummaries(input: BuildHumanReviewInput): HumanReviewModel["trust_audit"]["invalid_evidence"] {
  const packetInvalid = input.packet.evaluation.results
    .filter((result) => result.status === "invalid_evidence")
    .map((result) => ({
      summary: `${result.acai_id ?? result.requirement_id}: ${result.summary}`,
      evidence: [...result.evidence, ...result.missing_evidence]
    }));

  const prRiskInvalid: InvalidEvidenceDraft[] = [];
  for (const risk of input.prSurface?.risks.candidates ?? []) {
    const invalidRiskEvidence = risk.evidence.filter(isInvalidTrustEvidence);
    if (invalidRiskEvidence.length === 0) {
      continue;
    }
    prRiskInvalid.push({
      summary: `${risk.id}: PR risk evidence is invalid or not deterministic.`,
      evidence: invalidRiskEvidence
    });
  }

  return withInvalidEvidenceIds([
    ...prRiskInvalid.slice(0, MAX_TRUST_ITEMS),
    ...packetInvalid.slice(0, Math.max(0, MAX_TRUST_ITEMS - prRiskInvalid.length))
  ]);
}

function withTrustFactIds(drafts: TrustFactDraft[]): TrustFact[] {
  return drafts.slice(0, MAX_TRUST_ITEMS).map((draft, index) => ({
    id: `TRUST-VERIFIED-${String(index + 1).padStart(3, "0")}`,
    ...draft
  }));
}

function withInvalidEvidenceIds(drafts: InvalidEvidenceDraft[]): InvalidEvidenceSummary[] {
  return drafts.slice(0, MAX_TRUST_ITEMS).map((draft, index) => ({
    id: `INVALID-${String(index + 1).padStart(3, "0")}`,
    ...draft
  }));
}

function isVerifiedTrustEvidence(ref: EvidenceRef): boolean {
  return ref.kind !== "unknown" && ref.validation_status !== "invalid" && ref.llm_proposed !== true;
}

function isInvalidTrustEvidence(ref: EvidenceRef): boolean {
  return ref.validation_status === "invalid" || ref.llm_proposed === true;
}

function positiveValidationEvidence(risks: RisksModel): EvidenceRef[] {
  return risks.test_evidence
    .filter((item) => item.kind === "direct" || item.kind === "indirect")
    .flatMap((item) => item.evidence ?? [missingEvidence(item.summary)]);
}

function hasPositiveValidationEvidence(risks: RisksModel): boolean {
  return positiveValidationEvidence(risks).length > 0;
}

function hasNoValidationEvidence(risks: RisksModel): boolean {
  return !risks.test_evidence.some((item) => item.kind === "direct" || item.kind === "indirect");
}

function allCriticalRisks(input: BuildHumanReviewInput): Array<{
  id: string;
  summary: string;
  evidence: EvidenceRef[];
  suggested_checks: string[];
}> {
  return [
    ...input.packet.risks.items
      .filter((risk) => risk.severity === "critical")
      .map((risk) => ({ id: risk.id, summary: risk.summary, evidence: risk.evidence ?? [], suggested_checks: risk.suggested_checks ?? [] })),
    ...(input.prSurface?.risks.candidates ?? [])
      .filter((risk) => risk.severity === "critical")
      .map((risk) => ({ id: risk.id, summary: risk.summary, evidence: risk.evidence, suggested_checks: risk.suggested_checks }))
  ];
}

// review-surfaces.HUMAN_TRUST.6: cite the evidence of the first risk AT OR ABOVE
// the threshold that made hasRiskAtLeast fire, so the verdict reason names the
// concrete medium/high in-diff risk rather than an earlier low-severity candidate.
function firstRiskEvidenceAtLeast(input: BuildHumanReviewInput, severity: PacketSeverity): EvidenceRef[] {
  const threshold = severityWeight(severity);
  const prRisk = input.prSurface?.risks.candidates.find((risk) => severityWeight(risk.severity) >= threshold);
  if (prRisk) {
    return evidenceOrMissing(prRisk.evidence, prRisk.summary).slice(0, 3);
  }
  const packetRisk = input.packet.risks.items.find((risk) => severityWeight(risk.severity) >= threshold);
  if (packetRisk) {
    return evidenceOrMissing(packetRisk.evidence ?? [], packetRisk.summary).slice(0, 3);
  }
  return firstRiskEvidence(input);
}

// review-surfaces.HUMAN_TRUST.6: the verdict block renders only reason.summary, so
// the summary itself must name the concrete in-diff risk (a schema/API break, a
// weakened test) rather than a generic "reviewable risks remain".
function firstRiskSummaryAtLeast(input: BuildHumanReviewInput, severity: PacketSeverity): string | undefined {
  const threshold = severityWeight(severity);
  const prRisk = input.prSurface?.risks.candidates.find((risk) => severityWeight(risk.severity) >= threshold);
  if (prRisk) {
    return prRisk.summary;
  }
  return input.packet.risks.items.find((risk) => severityWeight(risk.severity) >= threshold)?.summary;
}

function reviewableRiskReasonSummary(input: BuildHumanReviewInput, severity: PacketSeverity): string {
  const summary = firstRiskSummaryAtLeast(input, severity);
  return summary ? `Reviewable risk remains: ${trimSentenceEnd(summary)}.` : "Reviewable risks remain and should guide the review path.";
}

function firstRiskEvidence(input: BuildHumanReviewInput): EvidenceRef[] {
  const prRisk = input.prSurface?.risks.candidates[0];
  if (prRisk) {
    return evidenceOrMissing(prRisk.evidence, prRisk.summary).slice(0, 3);
  }
  const packetRisk = input.packet.risks.items[0];
  return packetRisk ? evidenceOrMissing(packetRisk.evidence ?? [], packetRisk.summary).slice(0, 3) : [missingEvidence("Risk evidence unavailable.")];
}

function hasRiskAtLeast(input: BuildHumanReviewInput, severity: PacketSeverity): boolean {
  const threshold = severityWeight(severity);
  return [
    ...input.packet.risks.items.map((risk) => risk.severity),
    ...(input.prSurface?.risks.candidates.map((risk) => risk.severity) ?? [])
  ].some((riskSeverity) => severityWeight(riskSeverity) >= threshold);
}

function confidenceForDecision(
  decision: HumanReviewDecision,
  blockers: ReviewBlocker[],
  trustAudit: TrustAudit
): PacketConfidence {
  if (decision === "no_signal") {
    return "unknown";
  }
  if (trustAudit.invalid_evidence.length > 0) {
    return "low";
  }
  if (blockers.length > 0) {
    return "high";
  }
  if (trustAudit.missing_evidence.length > 0 || trustAudit.claimed_not_verified.length > 0) {
    return "medium";
  }
  return "high";
}

function confidenceSummary(verified: number, claimed: number, missing: number, invalid: number): string {
  if (invalid > 0) {
    return `Low confidence: ${invalid} invalid evidence item(s) require inspection before trusting the surface.`;
  }
  if (missing > 0 || claimed > 0) {
    return `Medium confidence: ${verified} verified fact(s), ${missing} missing evidence item(s), and ${claimed} unverified claim(s).`;
  }
  if (verified > 0) {
    return `High confidence: ${verified} verified fact(s) and no missing or invalid evidence surfaced in the compact audit.`;
  }
  return "Unknown confidence: no verified facts were available in the compact audit.";
}

function isFailedValidationEvidence(item: RisksModel["test_evidence"][number]): boolean {
  if (item.evidence?.some((ref) => ref.validation_status === "invalid")) {
    return true;
  }
  if (item.kind !== "missing") {
    return false;
  }
  if (/\b(fail(?:ed|ing)?|error)\b/i.test(item.summary)) {
    return true;
  }
  const commandText = [
    item.summary,
    ...(item.evidence ?? []).filter((ref) => ref.kind === "command").flatMap((ref) => [ref.note, ref.command])
  ].join(" ");
  return /\b(?:exit(?:_code)?=|exit\s+)(?:[1-9]\d*)\b/i.test(commandText) || /\bstatus=failed\b/i.test(commandText);
}

function failedValidationEvidence(input: BuildHumanReviewInput): RisksModel["test_evidence"] {
  return input.packet.risks.test_evidence.filter(isFailedValidationEvidence);
}

function prRiskMentionsFailedTests(risk: PrRiskCandidate): boolean {
  const evidenceText = risk.evidence
    .flatMap((ref) => compactStrings([ref.note, ref.command, ref.test_name, ref.path, ref.acai_id]))
    .join(" ");
  return /\b(fail(?:ed|ing)?|error)\b/i.test(`${risk.summary} ${evidenceText}`);
}

// Score with the policy-overridden priority's weight in place of the risk's own
// severity weight (POLICY.2: overrides re-rank, not merely re-label).
function scorePrRiskWithPriority(risk: PrRiskCandidate, anchor: QueueAnchor, priority: HumanReviewPriority): number {
  const weightByPriority: Record<HumanReviewPriority, number> = { blocker: 100, high: 75, medium: 40, low: 15 };
  return weightByPriority[priority] + ruleWeight(risk.rule) + (anchor.line_start ? 10 : 0) + (anchor.hunk_header ? 10 : 0);
}

function scorePrRisk(risk: PrRiskCandidate, anchor: QueueAnchor): number {
  return severityWeight(risk.severity) + ruleWeight(risk.rule) + (anchor.line_start ? 10 : 0) + (anchor.hunk_header ? 10 : 0);
}

function severityWeight(severity: PacketSeverity): number {
  switch (severity) {
    case "critical":
      return 100;
    case "high":
      return 75;
    case "medium":
      return 40;
    case "low":
      return 15;
    default:
      return 5;
  }
}

function ruleWeight(rule: PrRiskCandidate["rule"] | undefined): number {
  if (!rule) {
    return 0;
  }
  return PR_RISK_RULE_METADATA[rule].review_queue_weight;
}

function titleForPrRisk(risk: PrRiskCandidate): string {
  return PR_RISK_RULE_METADATA[risk.rule].title;
}

// review-surfaces.HUMAN_REVIEW.21: the queue reason states the underlying reason
// the change matters (the risk's own summary), not self-referential bookkeeping
// ("ranked from deterministic PR risk rule X"). The rule id and severity already
// surface as trailing queue metadata (Risk: `…`, priority), so they are not
// repeated as the sentence subject here.
function rankReasonForPrRisk(risk: PrRiskCandidate): string {
  return reviewerReasonFromSummary(risk.summary, `Changed file flagged by the ${PR_RISK_RULE_METADATA[risk.rule].title.toLowerCase()} risk rule.`);
}

// Normalize a deterministic finding's summary into a reviewer-facing reason.
// Falls back to a concrete default when the summary is empty so the rendered
// "Why this matters" line is never blank.
function reviewerReasonFromSummary(summary: string, fallback: string): string {
  const trimmed = summary.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function titleFromSummary(summary: string): string {
  const first = summary.split(/[.:]/)[0]?.trim();
  if (!first) {
    return "Packet risk";
  }
  return first.length <= 80 ? first : `${first.slice(0, 77)}...`;
}

// review-surfaces.RANKING.4: aggregate-rollup risks carry a count-led summary
// ("143 requirement(s) have implementation evidence but weak or missing test
// evidence.") that titleFromSummary would truncate mid-word into the heading.
// Give them a short, stable heading instead and let the full count live only in
// the "Why this matters" line below it.
function aggregateRiskTitle(risk: ReviewPacket["risks"]["items"][number]): string {
  switch (risk.category) {
    case "testing":
      return "Weak test evidence across requirements";
    case "correctness":
      return "Requirements missing implementation or test evidence";
    case "release":
      return "Requirements left unknown by weak evidence";
    case "workflow":
      return /did not map|requirement group/.test(risk.summary)
        ? "Changed files outside any requirement group"
        : "Validation claims without command-transcript evidence";
    default:
      return titleFromSummary(risk.summary);
  }
}

function titleForChangedFile(file: PrChangedFile): string {
  if (file.role === "doc" && isSourceOfTruthReviewDoc(file.path)) {
    return "Changed source-of-truth document";
  }
  switch (file.role) {
    case "implementation":
      return "Changed implementation file";
    case "test":
      return "Changed test file";
    case "ci":
      return "Changed CI file";
    case "config":
      return "Changed configuration file";
    case "spec":
      return "Changed contract or spec file";
    default:
      return "Changed review file";
  }
}

function actionForChangedFile(file: PrChangedFile): string {
  if (file.role === "doc" && isSourceOfTruthReviewDoc(file.path)) {
    return `Inspect ${file.path} for reviewer workflow, requirement, or product-contract changes.`;
  }
  switch (file.role) {
    case "implementation":
      return `Inspect ${file.path} and confirm the changed behavior is covered by existing or co-changed tests.`;
    case "test":
      return `Inspect ${file.path} to confirm the new or changed test exercises the intended behavior.`;
    case "ci":
      return `Inspect ${file.path} for workflow permissions, checkout boundaries, and reviewer-facing side effects.`;
    case "config":
      return `Inspect ${file.path} for configuration contract or runtime behavior changes.`;
    case "spec":
      return `Inspect ${file.path} for public requirement, schema, or workflow contract changes.`;
    default:
      return `Inspect ${file.path} before approving.`;
  }
}

function changedFileQueueWeight(file: PrChangedFile): number {
  switch (file.role) {
    case "ci":
      return 72;
    case "implementation":
      return 68;
    case "spec":
    case "config":
      return 60;
    case "test":
      return 50;
    case "doc":
      return isSourceOfTruthReviewDoc(file.path) ? 46 : 0;
    default:
      return 0;
  }
}

function isSourceOfTruthReviewDoc(filePath: string): boolean {
  const normalizedPath = normalizeEvidencePath(filePath);
  return (
    /(^|\/)AGENTS\.md$/.test(normalizedPath) ||
    /(^|\/)CLAUDE\.md$/.test(normalizedPath) ||
    normalizedPath === "README.md" ||
    normalizedPath === "CONTRIBUTING.md" ||
    normalizedPath === "docs/review-surfaces-trd.md" ||
    normalizedPath === "docs/dogfooding.md" ||
    /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(normalizedPath)
  );
}

function priorityForChangedFile(file: PrChangedFile): HumanReviewPriority {
  return file.role === "test" ? "low" : "medium";
}

function affectedRequirementIdsForFile(prSurface: PrReviewSurfaceModel, file: Pick<PrChangedFile, "path" | "old_path" | "areas">): string[] {
  const areas = new Set(changedFileAreas(file));
  const paths = new Set(compactStrings([file.path, file.old_path]).map((filePath) => normalizeEvidencePath(filePath)));
  return prSurface.scope.affected_requirements
    .filter((requirement) =>
      (requirement.group_key && areas.has(requirement.group_key)) ||
      affectedRequirementReasons(requirement).some((reason) => reason.path && paths.has(normalizeEvidencePath(reason.path)))
    )
    .map((requirement) => requirement.acai_id ?? requirement.requirement_id)
    .slice(0, 8);
}

function changedFileAreas(file: Pick<PrChangedFile, "areas">): string[] {
  return Array.isArray(file.areas) ? file.areas : [];
}

function affectedRequirementReasons(
  requirement: PrReviewSurfaceModel["scope"]["affected_requirements"][number]
): PrReviewSurfaceModel["scope"]["affected_requirements"][number]["reasons"] {
  return Array.isArray(requirement.reasons) ? requirement.reasons : [];
}

function priorityForSeverity(severity: PacketSeverity): HumanReviewPriority {
  if (severity === "critical") {
    return "blocker";
  }
  if (severity === "high") {
    return "high";
  }
  if (severity === "medium") {
    return "medium";
  }
  return "low";
}

// The "elevated" severity band (critical/high) that drives blocker priority,
// required-vs-recommended tests, blocking question/comment severity, and
// high-risk skim-safe exclusion. Centralized so the band is defined once.
function isElevatedSeverity(severity: PacketSeverity | undefined): boolean {
  return severity === "critical" || severity === "high";
}

function effortForSeverity(severity: PacketSeverity): "quick" | "moderate" | "deep" {
  if (isElevatedSeverity(severity)) {
    return "deep";
  }
  if (severity === "medium") {
    return "moderate";
  }
  return "quick";
}

function questionFromPrRisk(
  index: number,
  severity: ReviewerQuestion["severity"],
  risk: PrRiskCandidate,
  question: string
): ReviewerQuestion {
  return {
    id: `QUESTION-${String(index).padStart(3, "0")}`,
    severity,
    question,
    reason: risk.summary,
    evidence: evidenceOrMissing(risk.evidence, risk.summary),
    maps_to_risks: [risk.id],
    maps_to_requirements: requirementIds(risk.evidence)
  };
}

function commentDraftsForPrRisk(input: BuildHumanReviewInput, risk: PrRiskCandidate): SuggestedCommentDraft[] {
  const path = firstPathEvidence(risk.evidence)?.path;
  switch (risk.rule) {
    case "coverage_regression":
      return [commentDraftFromPrRisk(input, "blocking", risk, "Coverage regressed for this PR. Can you add or point to validation that restores the regressed requirement coverage before approval?")];
    case "untested_changed_impl":
      return [commentDraftFromPrRisk(input, "clarifying", risk, `What test or existing fixture covers the behavior changed in ${path ?? "this implementation file"}?`)];
    case "unmapped_change":
      return [commentDraftFromPrRisk(input, "clarifying", risk, "This change is outside the mapped review areas. Can you confirm whether it is intentional and add a review-area mapping or explicit deferral if needed?")];
    case "privacy_sensitive_change":
      return [commentDraftFromPrRisk(input, "blocking", risk, "This touches privacy, provider, redaction, secret, or token-handling code. Can you add or point to sensitive-input validation before approval?")];
    case "secret_in_diff":
      return [commentDraftFromPrRisk(input, "blocking", risk, `An added line in ${path ?? "this change"} matches a high-confidence secret pattern. Please remove it and rotate the credential — a committed secret must be treated as leaked.`)];
    case "comment_surface_change":
      return [commentDraftFromPrRisk(input, "non_blocking", risk, "Please include or inspect a rendered comment/human surface fixture so reviewers can verify the Markdown output directly.")];
    case "ci_secret_boundary_change":
      // The merge-readiness blocker is the canonical suggested comment for this manual-check gate.
      return [];
    case "schema_contract_change":
      return [commentDraftFromPrRisk(input, "blocking", risk, "This changes a persisted schema or artifact contract. Can you add a compatibility fixture for an existing generated artifact, or explicitly version this as a breaking change?")];
    case "deleted_or_renamed_surface":
      return [commentDraftFromPrRisk(input, "clarifying", risk, "This deletes or renames a generated or reviewer-facing surface. Can you confirm no stale imports, generated references, or reviewer links still point to the old path?")];
    case "failed_or_skipped_test":
      if (failedValidationEvidence(input).length > 0 && prRiskMentionsFailedTests(risk)) {
        return [];
      }
      return [commentDraftFromPrRisk(input, "blocking", risk, "Validation evidence indicates failed or skipped tests. Can you fix the failures or record why the skipped tests are intentional before approval?")];
    case "large_diff":
      return [commentDraftFromPrRisk(input, "non_blocking", risk, "This is a large diff. Consider splitting it or listing the areas that received deeper owner review.")];
  }
}

function commentDraftFromPrRisk(
  input: BuildHumanReviewInput,
  severity: SuggestedReviewComment["severity"],
  risk: PrRiskCandidate,
  body: string
): SuggestedCommentDraft {
  const first = firstPathEvidence(risk.evidence);
  return stripUndefined({
    severity,
    path: first?.path,
    line_start: first?.line_start,
    line_end: first?.line_end,
    body,
    evidence: evidenceOrMissing(risk.evidence, risk.summary),
    risk_ids: [risk.id],
    requirement_ids: requirementIdsForPrRisk(input, risk),
    confidence: "medium" as const,
    ready_to_post: true
  });
}

function compareSuggestedCommentCandidates(
  left: SuggestedCommentCandidate,
  right: SuggestedCommentCandidate
): number {
  return (
    suggestedCommentSeverityRank(left.draft.severity) - suggestedCommentSeverityRank(right.draft.severity) ||
    (left.sourceRank - right.sourceRank) ||
    severityWeight(right.risk?.severity ?? "unknown") - severityWeight(left.risk?.severity ?? "unknown") ||
    ruleWeight(right.risk?.rule) - ruleWeight(left.risk?.rule) ||
    compareStrings(left.sortKey, right.sortKey)
  );
}

function suggestedCommentSeverityRank(severity: SuggestedReviewComment["severity"]): number {
  switch (severity) {
    case "blocking":
      return 0;
    case "clarifying":
      return 1;
    case "non_blocking":
      return 2;
  }
}

function firstPathEvidence(evidence: EvidenceRef[]): EvidenceRef | undefined {
  return evidence.find((ref) => typeof ref.path === "string" && ref.path.length > 0);
}

// review-surfaces.RANKING.4: an aggregate-rollup risk ("143 requirement(s) have
// weak test evidence", "4 changed file(s) did not map") has no single changed
// line to point at — its evidence spans many distinct files. When the chosen
// evidence also carries no line anchor, the queue must render it honestly at
// file level instead of borrowing an unrelated firstChangedHunk and advertising
// it as a "precise diff anchor" with high confidence.
function evidenceSpansMultiplePaths(evidence: EvidenceRef[]): boolean {
  const paths = new Set<string>();
  for (const ref of evidence) {
    if (typeof ref.path === "string" && ref.path.length > 0) {
      paths.add(normalizeEvidencePath(ref.path));
      if (paths.size > 1) {
        return true;
      }
    }
  }
  return false;
}

function firstPathEvidenceInScope(evidence: EvidenceRef[], changedPaths: Set<string>): EvidenceRef | undefined {
  for (const ref of evidence) {
    if (typeof ref.path !== "string") {
      continue;
    }
    const normalizedPath = normalizeEvidencePath(ref.path);
    if (changedPaths.has(normalizedPath)) {
      return normalizedPath === ref.path ? ref : { ...ref, path: normalizedPath };
    }
  }
  return undefined;
}

interface DiffIndex {
  byPath: Map<string, DiffIndexEntry>;
}

interface DiffIndexEntry {
  file: StructuredDiffFile;
  side: "old" | "new";
}

interface QueueAnchor {
  path: string;
  old_path?: string;
  hunk_header?: string;
  line_start?: number;
  line_end?: number;
  // Which diff side the anchor path matched (old for a deletion or a rename
  // source, new otherwise). Disambiguates a path shared by a new file and a
  // rename source when the inline excerpt is rendered.
  side?: "old" | "new";
}

function buildDiffIndex(diff: StructuredDiff | undefined): DiffIndex | undefined {
  if (!diff || diff.files.length === 0) {
    return undefined;
  }
  const byPath = new Map<string, DiffIndexEntry>();
  for (const file of diff.files) {
    byPath.set(normalizeEvidencePath(file.path), { file, side: file.status === "D" ? "old" : "new" });
    if (file.old_path) {
      byPath.set(normalizeEvidencePath(file.old_path), { file, side: "old" });
    }
  }
  return { byPath };
}

// review-surfaces.RANKING.4: `suppressHunkBorrow` is set for aggregate-rollup
// risks whose evidence spans many files. It keeps a genuine evidence line anchor
// (hunkForEvidence) but skips the firstChangedHunk fallback, so the item never
// claims a borrowed, unrelated hunk as its own — it renders at file level
// (confidence medium, "ranked ... at file level") instead.
function queueAnchorForEvidence(evidence: EvidenceRef, diffIndex: DiffIndex | undefined, suppressHunkBorrow = false): QueueAnchor {
  const path = normalizeEvidencePath(String(evidence.path));
  const fallbackRange = normalizedEvidenceRange(evidence);
  const fallback = stripUndefined({
    path,
    line_start: fallbackRange?.line_start,
    line_end: fallbackRange?.line_end
  });
  if (!diffIndex) {
    return fallback;
  }
  const entry = diffIndex.byPath.get(path);
  if (!entry) {
    return fallback;
  }
  const { file: diffFile, side } = entry;
  const anchorPath = anchorPathForSide(diffFile, side);
  const hunk = hunkForEvidence(diffFile, evidence, side) ?? (fallbackRange || suppressHunkBorrow ? undefined : firstChangedHunk(diffFile));
  if (!hunk) {
    return stripUndefined({
      path: anchorPath,
      old_path: oldPathForAnchor(diffFile, anchorPath),
      line_start: fallbackRange?.line_start,
      line_end: fallbackRange?.line_end,
      side
    });
  }
  const changedRange = fallbackRange ?? changedLineRange(hunk, side);
  return stripUndefined({
    path: anchorPath,
    old_path: oldPathForAnchor(diffFile, anchorPath),
    hunk_header: formatHunkHeader(hunk),
    line_start: changedRange?.line_start,
    line_end: changedRange?.line_end,
    side
  });
}

function hunkForEvidence(
  diffFile: StructuredDiffFile,
  evidence: EvidenceRef,
  side: "old" | "new"
): StructuredDiffHunk | undefined {
  if (!evidence.line_start) {
    return undefined;
  }
  const range = normalizedEvidenceRange(evidence);
  if (!range) {
    return undefined;
  }
  return diffFile.hunks.find((hunk) => hunkOverlapsRange(hunk, side, range.line_start, range.line_end));
}

function normalizedEvidenceRange(evidence: EvidenceRef): { line_start: number; line_end: number } | undefined {
  if (!evidence.line_start || evidence.line_start < 1) {
    return undefined;
  }
  const lineEnd = evidence.line_end && evidence.line_end >= evidence.line_start ? evidence.line_end : evidence.line_start;
  return { line_start: evidence.line_start, line_end: lineEnd };
}

function firstChangedHunk(diffFile: StructuredDiffFile): StructuredDiffHunk | undefined {
  return diffFile.hunks.find((hunk) => hunk.lines.some((line) => isChangedDiffLine(line.kind)));
}

function changedLineRange(hunk: StructuredDiffHunk, side: "old" | "new"): { line_start: number; line_end: number } | undefined {
  let lineStart: number | undefined;
  let lineEnd: number | undefined;
  for (const line of hunk.lines) {
    const lineNumber = side === "old" ? line.old_line : line.new_line;
    const wantedKind = side === "old" ? "delete" : "add";
    if (line.kind !== wantedKind || typeof lineNumber !== "number" || lineNumber <= 0) {
      continue;
    }
    lineStart = lineStart === undefined ? lineNumber : Math.min(lineStart, lineNumber);
    lineEnd = lineEnd === undefined ? lineNumber : Math.max(lineEnd, lineNumber);
  }
  if (lineStart === undefined || lineEnd === undefined) {
    return undefined;
  }
  return { line_start: lineStart, line_end: lineEnd };
}

function anchorPathForSide(diffFile: StructuredDiffFile, side: "old" | "new"): string {
  return side === "old" && diffFile.old_path ? diffFile.old_path : diffFile.path;
}

function oldPathForAnchor(diffFile: StructuredDiffFile, anchorPath: string): string | undefined {
  return diffFile.old_path && diffFile.old_path !== anchorPath ? diffFile.old_path : undefined;
}

function prChangedFilePaths(prSurface: PrReviewSurfaceModel): Set<string> {
  return new Set(
    prSurface.scope.changed_files.flatMap((file) =>
      compactStrings([file.path, file.old_path]).map((filePath) => normalizeEvidencePath(filePath))
    )
  );
}

function evidenceOrMissing(evidence: EvidenceRef[], fallback: string): EvidenceRef[] {
  return evidence.length ? evidence : [missingEvidence(fallback)];
}

function requirementIds(evidence: EvidenceRef[]): string[] {
  return compactStrings(evidence.map((ref) => ref.acai_id));
}

function compactStrings(values: Array<string | undefined>): string[] {
  return uniqueTruthy(values).filter((value): value is string => typeof value === "string");
}

function riskIdsFromBlocker(blocker: ReviewBlocker): string[] {
  // BLOCK-<risk id> wraps the originating RISK id; non-risk blockers
  // (BLOCK-TESTS-001, BLOCK-PRIVACY-001, ...) must not yield fake risk ids, so
  // only unwrap remainders that look like a risk id.
  const wrapped = blocker.id.match(/^BLOCK-((?:PR-)?RISK-.+)$/);
  return wrapped ? [wrapped[1]] : [];
}

function questionSeverityForRisk(severity: PacketSeverity): ReviewerQuestion["severity"] {
  return isElevatedSeverity(severity) ? "blocking" : "clarifying";
}

function hasRecordedCiSecretBoundaryManualCheck(input: BuildHumanReviewInput): boolean {
  return recordedManualCheckRecords(input, { includeCommandEvidence: false }).some((record) => looksLikeRecordedCiSecretBoundaryManualCheck(record.text));
}

function recordedManualCheckEvidence(input: BuildHumanReviewInput, requiredManualCheck: string): EvidenceRef[] {
  const requiredTokens = normalizedManualCheckTokens(requiredManualCheck);
  if (requiredTokens.length === 0) {
    return [];
  }
  for (const record of recordedManualCheckRecords(input)) {
    if (!looksLikePositiveManualCheckRecord(record.text)) {
      continue;
    }
    const textTokens = new Set(normalizedManualCheckTokens(record.text));
    if (requiredTokens.every((token) => textTokens.has(token))) {
      return record.evidence;
    }
  }
  return [];
}

function recordedManualCheckRecords(input: BuildHumanReviewInput, options: { includeCommandEvidence?: boolean } = {}): ManualCheckRecord[] {
  const headSha = currentHeadSha(input);
  return [
    ...input.packet.risks.test_evidence
      .filter((item) => item.kind === "direct" || item.kind === "indirect")
      .flatMap((item) => manualCheckEvidenceRecords(item.evidence ?? [], headSha, options)),
    ...(input.feedback ?? [])
      .filter((feedbackFile) => feedbackFileAppliesToHead(feedbackFile, headSha))
      .flatMap((feedbackFile) =>
        (feedbackFile.validation?.notes ?? []).map((note, index) => ({
          text: note,
          evidence: [
            feedbackEvidence(feedbackFile.path, note, {
              eventId: `validation-note:${index + 1}`,
              sha: headSha
            })
          ]
        }))
      )
  ];
}

function feedbackFileAppliesToHead(feedbackFile: FeedbackFile, headSha: string): boolean {
  return headSha !== "unknown" && feedbackFile.head_sha === headSha;
}

function looksLikePositiveManualCheckRecord(value: string): boolean {
  const normalized = value.toLowerCase();
  if (/\b(?:unable|could not|cannot|can't)\s+(?:to\s+)?(?:confirm|verify)\b/.test(normalized)) {
    return false;
  }
  if (/\bnot\s+(?:confirmed|verified|safe|completed|recorded|reviewed|inspected)\b/.test(normalized)) {
    return false;
  }
  if (/\bno\s+(?:manual\s+)?check\s+(?:recorded|completed|reviewed|inspected|verified)\b/.test(normalized)) {
    return false;
  }
  if (/\b(?:failed|unsafe|unverified|unconfirmed|unresolved|pending|planned|planning|todo|missing evidence|no evidence)\b/.test(normalized)) {
    return false;
  }
  if (/\b(?:reviewed|inspected)\s+(?:whether|if|to)\b/.test(normalized)) {
    return false;
  }
  return (
    /\bmanual check\s+(?:recorded|completed|confirmed|verified|passed)\b/.test(normalized) ||
    /\b(?:confirmed|verified)\b.*\b(?:safe|isolated|cannot access|no secrets?|does not leak|protected)\b/.test(normalized) ||
    /\b(?:reviewed|inspected)\b.*\b(?:confirmed|verified|safe|no secrets?|cannot access|does not leak)\b/.test(normalized)
  );
}

function normalizedManualCheckTokens(value: string): string[] {
  return uniqueTruthy(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !MANUAL_CHECK_TOKEN_STOP_WORDS.has(token))
  );
}

function currentHeadSha(input: BuildHumanReviewInput): string {
  const manifest = input.packet.manifest as { head_sha?: unknown };
  return input.prSurface?.scope.head_sha ?? stringOr(manifest.head_sha, "unknown");
}

function manualCheckEvidenceRecords(
  evidence: EvidenceRef[],
  headSha: string,
  options: { includeCommandEvidence?: boolean } = {}
): ManualCheckRecord[] {
  if (headSha === "unknown") {
    return [];
  }
  const feedbackRecords = evidence
    .filter((ref) => ref.kind === "feedback" && ref.validation_status !== "invalid" && ref.sha === headSha)
    .flatMap((ref) =>
      compactStrings([ref.note]).map((text) => ({
        text,
        evidence: [ref]
      }))
    );
  const commandRecords = options.includeCommandEvidence === false ? [] : evidence
    .filter((ref) =>
      ref.kind === "command" &&
      ref.validation_status === "valid" &&
      ref.sha === headSha &&
      commandEvidenceRecordsPassingTranscript(ref)
    )
    .flatMap((ref) =>
      compactStrings([ref.command, ref.note]).map((text) => ({
        text,
        evidence: [ref]
      }))
    );
  return [...feedbackRecords, ...commandRecords];
}

function commandEvidenceRecordsPassingTranscript(ref: EvidenceRef): boolean {
  const note = ref.note?.toLowerCase() ?? "";
  return /\bexit_code=0\b/.test(note) && /\bstatus=passed\b/.test(note);
}

function focusedRequirementGaps(input: BuildHumanReviewInput): RequirementGap[] {
  return input.packet.evaluation.results
    .filter((result) => result.status !== "satisfied")
    .filter((result) => {
      const id = result.acai_id ?? result.requirement_id;
      return id.includes(".HUMAN_REVIEW.") || id.includes(".HUMAN_TRUST.");
    })
    .sort(compareRequirementGapPriority);
}

function compareRequirementGapPriority(left: RequirementGap, right: RequirementGap): number {
  return (
    requirementGapPriority(left) - requirementGapPriority(right) ||
    compareStrings(left.acai_id ?? left.requirement_id, right.acai_id ?? right.requirement_id)
  );
}

function requirementGapPriority(gap: RequirementGap): number {
  const id = gap.acai_id ?? gap.requirement_id;
  if (gap.status === "invalid_evidence") {
    return 0;
  }
  if (gap.status === "missing") {
    return 1;
  }
  if (id.includes(".HUMAN_TRUST.")) {
    return 2;
  }
  return 3;
}

function requirementGapEvidence(gap: RequirementGap): EvidenceRef[] {
  return evidenceOrMissing(
    [...(gap.evidence ?? []), ...(gap.missing_evidence ?? [])],
    `${gap.acai_id ?? gap.requirement_id} needs evidence.`
  );
}

function compareMissingGapPriority(
  left: MissingAutomaticTestGap | MissingManualCheckGap,
  right: MissingAutomaticTestGap | MissingManualCheckGap
): number {
  return (
    missingGapPriority(left) - missingGapPriority(right) ||
    compareStrings(left.acai_id ?? left.requirement_id ?? left.id, right.acai_id ?? right.requirement_id ?? right.id)
  );
}

function missingGapPriority(gap: MissingAutomaticTestGap | MissingManualCheckGap): number {
  const id = gap.acai_id ?? gap.requirement_id ?? "";
  if (id.includes(".HUMAN_TRUST.")) {
    return 0;
  }
  if (id.includes(".HUMAN_REVIEW.")) {
    return 1;
  }
  if (id.includes(".PRIVACY.") || id.includes(".PROVIDERS.") || id.includes(".SCHEMA.")) {
    return 2;
  }
  return 3;
}

function suggestedTestFile(acaiId: string | undefined, suggested: string): string | undefined {
  return suggestedTestFileFromKeywords(`${acaiId ?? ""} ${suggested}`);
}

function suggestedTestFileForPath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const normalizedPath = normalizeEvidencePath(filePath);
  const shared = suggestedTestFileFromKeywords(normalizedPath);
  if (shared) {
    return shared;
  }
  const lower = normalizedPath.toLowerCase();
  if (!lower.startsWith("src/")) {
    return undefined;
  }
  const basename = normalizedPath.split("/").pop()?.replace(/\.[cm]?[tj]sx?$/, "");
  return basename ? `tests/${basename}.test.ts` : undefined;
}

function suggestedTestFileFromKeywords(value: string): string | undefined {
  const lower = value.toLowerCase();
  if (lower.includes("schema")) {
    return "tests/schema-contract.test.ts";
  }
  if (lower.includes("human")) {
    return "tests/human-review.test.ts";
  }
  if (lower.includes("pr-risks")) {
    return "tests/pr-risks.test.ts";
  }
  if (lower.includes("pr-scope")) {
    return "tests/pr-scope.test.ts";
  }
  if (lower.includes("pr-comment")) {
    return "tests/pr-comment.test.ts";
  }
  if (lower.includes("pr-narrative")) {
    return "tests/pr-narrative.test.ts";
  }
  if (lower.includes("render/") || lower.includes("comment")) {
    return "tests/render.test.ts";
  }
  if (lower.includes("privacy") || lower.includes("redact") || lower.includes("secret")) {
    return "tests/privacy.test.ts";
  }
  if (lower.includes("provider")) {
    return "tests/provider.test.ts";
  }
  if (lower.includes("coverage")) {
    return "tests/scoped-coverage.test.ts";
  }
  if (lower.includes("provider")) {
    return "tests/provider.test.ts";
  }
  if (/\bpr\b|pr-surface/.test(lower)) {
    return "tests/pr-surface-e2e.test.ts";
  }
  if (lower.includes("render/") || lower.includes("render") || lower.includes("comment")) {
    return "tests/render.test.ts";
  }
  return undefined;
}

function isSkimSafeCandidate(filePath: string, role: string): boolean {
  if (filePath === "pnpm-lock.yaml") {
    return true;
  }
  if (role === "generated") {
    return true;
  }
  if (role !== "doc") {
    return false;
  }
  if (isSourceOfTruthReviewDoc(filePath)) {
    return false;
  }
  const lower = filePath.toLowerCase();
  return !lower.includes("feature") && !lower.includes("trd") && !lower.includes("proposal") && !lower.includes("agents.md");
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

function dedupeQuestions(items: ReviewerQuestion[]): ReviewerQuestion[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.question;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function suggestedCommentDedupeKey(item: SuggestedReviewComment): string {
  return `${item.severity}:${item.path ?? ""}:${item.body}`;
}

function testPlanDedupeKey(item: TestPlanItem): string {
  return `${item.kind}:${item.suggested_file ?? ""}:${item.scenario}`;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
