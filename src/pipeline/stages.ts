import { CollectionResult } from "../collector/collect";
import { ReviewSurfacesConfig } from "../config/config";
import { ArchitectureModel, buildArchitecture, buildArchitectureModel } from "../diagrams/diagrams";
import { EvaluationModel, evaluateIntent, verifyRequirementsWithTests } from "../evaluation/evaluate";
import { buildIntent, IntentModel } from "../intent/intent";
import { EnrichmentResult, ProviderName, enrichPacket, providerFor } from "../llm/provider";
import { ReasoningOptions, runEvaluationReasoning, runIntentReasoning, runNarrativeReasoning } from "../llm/reasoning";
import { buildMethodology, MethodologyModel } from "../methodology/methodology";
import { buildReviewAreas, ReviewArea } from "../review-areas/areas";
import { analyzeRisks, buildRiskReviewFocus, RisksModel } from "../risks/risks";
import { createReviewPacket, ReviewPacket } from "../render/packet";
import { DogfoodModel } from "../dogfood/dogfood";
import { createPipelineArtifactStoreForCollection, PipelineArtifactStore } from "./artifact-store";

export interface PipelineStageContext {
  cwd: string;
  commandName: string;
  commandArgs: string[];
  collection: CollectionResult;
  artifacts: PipelineArtifactStore;
  config: ReviewSurfacesConfig;
  commands: string[];
  provider: ProviderName;
  requestedModel?: string;
  areasOption: { areas?: ReviewArea[] };
  agentInput?: string;
  conversationPath?: string;
}

export interface BuildPipelineStageContextOptions {
  cwd: string;
  commandName: string;
  commandArgs: string[];
  collection: CollectionResult;
  config: ReviewSurfacesConfig;
  provider: ProviderName;
  requestedModel?: string;
  agentInput?: string;
  conversationPath?: string;
}

export function buildPipelineStageContext(options: BuildPipelineStageContextOptions): PipelineStageContext {
  const reviewAreas = buildReviewAreas({ config: options.config, repoIndex: options.collection.repoIndex });
  const areasOption = reviewAreas.mode === "config" ? { areas: reviewAreas.areas } : {};
  return {
    cwd: options.cwd,
    commandName: options.commandName,
    commandArgs: options.commandArgs,
    collection: options.collection,
    artifacts: createPipelineArtifactStoreForCollection(options.collection),
    config: options.config,
    commands: [`review-surfaces ${options.commandName} ${options.commandArgs.join(" ")}`.trim()],
    provider: options.provider,
    requestedModel: options.requestedModel,
    areasOption,
    agentInput: options.agentInput,
    conversationPath: options.conversationPath
  };
}

export function reasoningProviderFor(context: PipelineStageContext) {
  return providerFor(context.provider, {
    model: context.requestedModel,
    cwd: context.cwd,
    remotePrivacyBlocked: context.collection.privacy.remote_provider_blocked,
    agentInput: context.agentInput
  });
}

export function reasoningOptionsFor(context: PipelineStageContext): ReasoningOptions {
  return {
    redactSecrets: context.config.privacy.redact_secrets,
    remotePrivacyBlocked: context.collection.privacy.remote_provider_blocked,
    // FINDING C: thread the SAME config-derived review areas evaluateIntent uses
    // (config mode only) so the composed candidate-evidence stage maps cited paths
    // by config area, matching `all`. Undefined in fallback mode preserves the
    // prior repo-index-cluster behavior.
    reviewAreas: context.areasOption.areas
  };
}

export function enrichPacketForContext(context: PipelineStageContext, packet: ReviewPacket): Promise<EnrichmentResult> {
  return enrichPacket(packet, {
    cwd: context.cwd,
    provider: context.provider,
    model: context.requestedModel,
    agentInput: context.agentInput,
    outputDir: context.collection.outputDir,
    redactSecrets: context.config.privacy.redact_secrets,
    remotePrivacyBlocked: context.collection.privacy.remote_provider_blocked
  });
}

// The single "enrichment has not run yet" literal, previously duplicated at 5
// createReviewPacket call sites (runAll + the 4 per-stage commands). Centralizing
// it guarantees a standalone stage can never construct a divergent preEnrichment
// shape than `all`.
export function notRequestedEnrichment(provider: ProviderName, model?: string): EnrichmentResult {
  return { provider, model, status: "not_requested", summary: "Enrichment has not run yet." };
}

export interface AssembledPacket {
  packet: ReviewPacket;
  enrichment: EnrichmentResult;
}

// THE single reasoning/enrichment path shared by every per-stage command: build
// the not_requested preEnrichment -> createReviewPacket -> enrichPacketForContext,
// in ONE place, so a standalone stage can NEVER diverge from `all`. The caller
// supplies the already-built models (intent/evaluation/methodology/risks/
// architecture) and optional dogfood, and then writes ONLY its own artifact(s)
// from the returned packet+enrichment. Under mock enrichPacket is a no-op
// (not_requested), so this is byte-stable.
export async function assembleEnrichedPacket(
  context: PipelineStageContext,
  models: {
    intent: IntentModel;
    evaluation: EvaluationModel;
    methodology: MethodologyModel;
    risks: RisksModel;
    architecture: ArchitectureModel;
    dogfood?: DogfoodModel;
  }
): Promise<AssembledPacket> {
  const packet = createReviewPacket({
    collection: context.collection,
    intent: models.intent,
    evaluation: models.evaluation,
    methodology: models.methodology,
    risks: models.risks,
    architecture: models.architecture,
    dogfood: models.dogfood,
    enrichment: notRequestedEnrichment(context.provider, context.requestedModel),
    commands: context.commands
  });
  const enrichment = await enrichPacketForContext(context, packet);
  return { packet, enrichment };
}

function logComputed(label: string): void {
  console.log(`Computed missing ${label} dependency.`);
}

// Compute intent + run the resolved reasoning intent stage in place. Used by the
// intent subcommand and as the ELSE-COMPUTE for downstream stages. Only stage 1
// (intent synthesis) touches intent, so we run exactly that slice; placeholders
// for the cross-cutting models are never consulted, and mock is a no-op.
export async function computeEnrichedIntent(context: PipelineStageContext): Promise<IntentModel> {
  const intent = await buildIntent(context.cwd, context.collection);
  await runIntentReasoning(
    reasoningProviderFor(context),
    {
      collection: context.collection,
      intent,
      evaluation: emptyEvaluation(),
      methodology: emptyMethodology(),
      risks: emptyRisks()
    },
    reasoningOptionsFor(context)
  );
  return intent;
}

export async function loadOrComputeIntent(context: PipelineStageContext, label = "intent"): Promise<IntentModel> {
  // FINDING E: only compose a prior intent.yaml when it was produced from the same
  // inputs; otherwise recompute so a reused --out never reuses a stale artifact.
  const loaded = context.artifacts.loadCurrentIntent();
  if (loaded) {
    return loaded;
  }
  logComputed(label);
  return computeEnrichedIntent(context);
}

// FINDING C: the load-or-compute fallback for a MISSING evaluation.yaml (used by
// the composable diagrams/handoff stages). It must produce the SAME evaluation
// the `evaluate`/`all` path produces -- i.e. with the candidate-evidence
// reasoning stage AND the partial -> satisfied verification loop applied -- so a
// standalone diagrams/handoff run builds from POST-promotion statuses rather than
// pre-promotion ones. The intent passed in is already intent-reasoned (its
// caller runs computeEnrichedIntent), so only the evaluation-owned reasoning +
// verification are slotted here. Under mock / without --test-output both are
// no-ops, so the byte-stable offline path is preserved.
export async function computeEvaluation(context: PipelineStageContext, intent: IntentModel): Promise<EvaluationModel> {
  const evaluation = await evaluateIntent(context.cwd, context.collection, intent, context.areasOption);
  // Stage 2 (candidate evidence) attaches LLM-pinpointed test refs the verification
  // loop may rely on, and may upgrade missing -> partial. Its risks.review_focus
  // side effect lands on a throwaway here (diagrams/handoff do not own risks.yaml).
  await runEvaluationReasoning(
    reasoningProviderFor(context),
    {
      collection: context.collection,
      intent,
      evaluation,
      methodology: emptyMethodology(),
      risks: emptyRisks()
    },
    reasoningOptionsFor(context)
  );
  // VERIFICATION LOOP (#2): apply the partial -> satisfied promotion, matching
  // `evaluate`/`all`. No-op without --test-output.
  verifyRequirementsWithTests(context.collection, intent, evaluation, context.areasOption);
  return evaluation;
}

export async function loadOrComputeEvaluation(
  context: PipelineStageContext,
  intentForCompute: () => Promise<IntentModel>
): Promise<EvaluationModel> {
  // FINDING E: only compose a prior evaluation.yaml when its producing signature
  // matches; a stale coverage artifact must be recomputed, not reused.
  const loaded = context.artifacts.loadCurrentEvaluation();
  if (loaded) {
    return loaded;
  }
  logComputed("evaluation");
  return computeEvaluation(context, await intentForCompute());
}

export async function computeMethodology(context: PipelineStageContext): Promise<MethodologyModel> {
  return buildMethodology(context.cwd, context.collection, context.conversationPath, context.commands);
}

export async function loadOrComputeMethodology(context: PipelineStageContext): Promise<MethodologyModel> {
  // FINDING E: recompute when the prior methodology.yaml is stale (signature
  // mismatch) instead of composing it.
  const loaded = context.artifacts.loadCurrentMethodology();
  if (loaded) {
    return loaded;
  }
  logComputed("methodology");
  return computeMethodology(context);
}

export function computeRisks(
  context: PipelineStageContext,
  evaluation: EvaluationModel,
  methodology: MethodologyModel
): RisksModel {
  return analyzeRisks(context.collection, evaluation, context.commands, methodology);
}

export async function loadOrComputeRisks(
  context: PipelineStageContext,
  evaluationForCompute: () => Promise<EvaluationModel>,
  methodologyForCompute: () => Promise<MethodologyModel>
): Promise<RisksModel> {
  // FINDING E: recompute when the prior risks.yaml is stale (signature mismatch)
  // instead of composing it.
  const loaded = context.artifacts.loadCurrentRisks();
  if (loaded) {
    return loaded;
  }
  logComputed("risks");
  return computeRisks(context, await evaluationForCompute(), await methodologyForCompute());
}

export async function computeArchitecture(
  context: PipelineStageContext,
  evaluation: EvaluationModel
): Promise<ArchitectureModel> {
  return buildArchitecture(context.collection, evaluation, context.areasOption);
}

// Per-stage isolation: build the architecture MODEL without the diagrams/*.mmd
// disk side effect, for stages that need the model but do NOT own the diagrams
// artifact (the `risks` enrichment-parity packet, the `handoff` packet inputs).
// The model is byte-identical to computeArchitecture's; only the disk write is
// dropped, so a standalone `risks`/`handoff` run no longer leaks diagrams/.
export function computeArchitectureModel(context: PipelineStageContext, evaluation: EvaluationModel): ArchitectureModel {
  return buildArchitectureModel(context.collection, evaluation, context.areasOption);
}

export interface EnrichedModels {
  intent: IntentModel;
  evaluation: EvaluationModel;
  methodology: MethodologyModel;
  risks: RisksModel;
}

// Reproduce the EXACT models the monolith `all` run holds after reasoning, by
// building the same deterministic models in the same order and running the same
// full reasoning sequence. A composed subcommand then persists only its own
// artifact from these, so compose==monolith holds for every artifact even under
// non-mock providers (e.g. offline agent-file). With mock, runReasoningStages is
// a no-op and these collapse to the deterministic models, byte-stable as before.
//
// NOTE: intent/evaluation/methodology/risks are built fresh and deterministically
// here (never loaded from possibly-already-enriched artifacts) so reasoning is
// applied exactly once, matching `all` and staying idempotent across composed
// invocations.
export async function buildEnrichedModels(context: PipelineStageContext): Promise<EnrichedModels> {
  const intent = await buildIntent(context.cwd, context.collection);
  const methodology = await computeMethodology(context);
  // Mirror `all`: run the reasoning sequence with intent synthesis FIRST (FINDING
  // A: any LLM candidate_requirements get an evaluation.results entry) and the
  // partial -> satisfied verification interleaved at the correct point so the
  // risks model composed subcommands persist (packet/risks/methodology) reflects
  // the promotion. No-op without --test-output / under mock, so the byte-stable
  // offline path holds.
  const { evaluation, risks } = await runReasoningWithVerification(reasoningProviderFor(context), reasoningOptionsFor(context), {
    cwd: context.cwd,
    collection: context.collection,
    intent,
    methodology,
    commands: context.commands,
    areasOption: context.areasOption
  });
  return { intent, evaluation, methodology, risks };
}

interface VerificationStageInputs {
  cwd: string;
  collection: CollectionResult;
  intent: IntentModel;
  methodology: MethodologyModel;
  commands: string[];
  areasOption: { areas?: ReviewArea[] };
}

interface ReasonedEvaluation {
  evaluation: EvaluationModel;
  risks: RisksModel;
}

// Run the schema-bound reasoning sequence with the VERIFICATION LOOP (#2)
// promotion interleaved so every evaluation-derived surface (risks here, and
// architecture at the call site) sees the POST-promotion evaluation. The full
// reasoning order is preserved exactly as runReasoningStages would run it
// (intent synthesis -> candidate evidence -> narrative); evaluation, verify and
// analyzeRisks are slotted at the deterministically-correct points:
//
//   intent synthesis       (FINDING A: may append LLM candidate_requirements to
//                            intent; runs BEFORE evaluateIntent)
//   -> evaluateIntent      (evaluates the FULL, post-intent-reasoning intent so
//                            EVERY requirement -- including LLM candidate
//                            requirements -- has a matching evaluation.results
//                            entry, preserving the one-result-per-requirement
//                            contract)
//   -> candidate evidence  (attaches LLM-pinpointed test refs to evaluation;
//                            returns risks.review_focus additions)
//   -> verify              (partial -> satisfied using those refs + deterministic
//                            mappings; mutates evaluation in place)
//   -> analyzeRisks        (POST-promotion: a promoted requirement is no longer a
//                            partial test gap nor counted in the weak-test risk)
//   -> narrative           (appends LLM risk items to risks.items)
//
// Intent synthesis MUST run before evaluateIntent (FINDING A): the deterministic
// evaluator only produces a result for an intent requirement that exists when it
// runs, so building evaluation before intent reasoning left any LLM-appended
// candidate_requirements with no evaluation.results entry (and no risks/architecture).
// The candidate-evidence stage returns its risks.review_focus additions as a
// delta. We re-apply that delta to the freshly analyzed (post-promotion) risks so
// risk derivation itself happens once, after verification. Under mock every
// reasoning stage is a no-op, intent is unchanged, the delta is empty, and this
// collapses to evaluate -> verify -> analyzeRisks, keeping the deterministic
// baseline byte-stable. The same helper backs `all` and buildEnrichedModels so
// compose == monolith.
export async function runReasoningWithVerification(
  reasoningProvider: ReturnType<typeof providerFor>,
  // FINDING C: ReasoningOptions carries the config-derived reviewAreas through to
  // the candidate-evidence stage; a narrower local type would silently strip it.
  reasoningOptions: ReasoningOptions,
  inputs: VerificationStageInputs
): Promise<ReasonedEvaluation> {
  const { cwd, collection, intent, methodology, commands, areasOption } = inputs;

  // FINDING A: intent synthesis runs FIRST so any LLM candidate_requirements are
  // present in intent BEFORE the deterministic evaluator runs. Pass a placeholder
  // evaluation/risks: the intent stage only reads/mutates intent.
  await runIntentReasoning(
    reasoningProvider,
    { collection, intent, evaluation: emptyEvaluation(), methodology, risks: emptyRisks() },
    reasoningOptions
  );

  // Evaluate the FULL (post-intent-reasoning) intent so every requirement has a
  // matching evaluation.results entry (the one-result-per-requirement contract).
  const evaluation = await evaluateIntent(cwd, collection, intent, areasOption);

  const reasoningInputs = { collection, intent, evaluation, methodology, risks: emptyRisks() };
  const evalReviewFocusDelta = (
    await runEvaluationReasoning(reasoningProvider, reasoningInputs, reasoningOptions, {
      appendReviewFocus: false,
      initialReviewFocusCount: buildRiskReviewFocus(
        methodology,
        collection.specIndex !== undefined && collection.specIndex.specs.flatMap((spec) => spec.requirements).length === 0
      ).length
    })
  ).review_focus;

  verifyRequirementsWithTests(collection, intent, evaluation, areasOption);

  // Recompute risks against the POST-promotion evaluation, then re-apply the
  // candidate-evidence review_focus delta so that enrichment is not lost.
  const risks = analyzeRisks(collection, evaluation, commands, methodology);
  risks.review_focus.push(...evalReviewFocusDelta);
  reasoningInputs.risks = risks;
  await runNarrativeReasoning(reasoningProvider, reasoningInputs, reasoningOptions);
  return { evaluation, risks };
}

// emptyEvaluation / emptyMethodology / emptyRisks are placeholders for stages
// that only read a subset of the reasoning inputs. Mock is a no-op, so they are
// never consulted in the default offline path.
export function emptyEvaluation(): EvaluationModel {
  return { summary: "", results: [], overreach: [], acai_coverage: {} };
}

export function emptyMethodology(): MethodologyModel {
  return {
    summary: "",
    missing_logs: true,
    considered: [],
    research: [],
    decisions: [],
    unchallenged_assumptions: [],
    skipped_checks: [],
    claims_without_evidence: [],
    verified_claims: [],
    quality_flags: [],
    evidence: []
  };
}

export function emptyRisks(): RisksModel {
  return {
    summary: "",
    items: [],
    test_evidence: [],
    test_gaps: [],
    missing_automatic_tests: [],
    missing_manual_checks: [],
    review_focus: []
  };
}
