import { CollectionResult } from "../collector/collect";
import { commandLooksLikeTestCommand } from "../commands/classify";
import { ConversationEvent } from "../conversation/events";
import { isRecord, uniqueTruthy } from "../core/guards";
import { EvidenceRef, llmProposedEvidence } from "../evidence/evidence";
import { EvidenceValidationContext, validateEvidenceRef } from "../evidence/validate";
import {
  appendCandidateReviewFocus,
  applyCandidateEvidenceEntries,
  rankEnrichableRequirements
} from "../evaluation/candidate-evidence";
import type {
  CandidateEvidenceApplication,
  CandidateEvidenceEntry,
  CandidateEvidenceOutput
} from "../evaluation/candidate-evidence";
import { EvaluationModel, RequirementResult } from "../evaluation/evaluate";
import { markHypothesis, redactHypothesisText } from "../evidence/hypothesis";
import { ClaimedIntentCandidate, IntentModel } from "../intent/intent";
import { MethodologyModel, WorkflowFinding } from "../methodology/methodology";
import { RisksModel } from "../risks/risks";
import { buildReviewAreas, createReviewAreaMatcher, ReviewArea } from "../review-areas/areas";
import { PacketSeverity, PacketWorkflowSignalKind } from "../schema/review-packet-contract";
import { auditCacheDir, auditCacheKey, loadCachedAudit, storeCachedAudit } from "./audit-cache";
import { effectiveModelId, GenerateStructuredOptions, ReasoningProvider } from "./provider";

/**
 * Phase 3-2: schema-bound, evidence-gated LLM reasoning stages.
 *
 * THE INVARIANT (enforced here, proven in tests):
 * - The LLM never sets a requirement status by itself. Deterministic evidence
 *   validation gates everything.
 * - LLM-proposed evidence must pass the SAME validateEvidenceRef used by the
 *   deterministic layer (path exists / line range valid / repo-relative / known
 *   ACID). Invalid refs are dropped or surfaced as invalid_evidence and can
 *   NEVER upgrade a status.
 * - A requirement reaches "satisfied" ONLY via exact deterministic evidence. The
 *   LLM can at most move missing -> partial by proposing VALID candidate
 *   evidence, always labeled an LLM hypothesis with confidence <= medium.
 * - With the mock provider (returns not-ok), every stage is a NO-OP and the
 *   deterministic packet is byte-stable.
 */

export interface ReasoningInputs {
  collection: CollectionResult;
  intent: IntentModel;
  evaluation: EvaluationModel;
  methodology: MethodologyModel;
  risks: RisksModel;
}

export interface ReasoningOptions {
  redactSecrets?: boolean;
  remotePrivacyBlocked?: boolean;
  // FINDING C: the SAME config-derived review areas evaluateIntent uses (config
  // mode when the repo declares `areas:`). The candidate-evidence stage maps a
  // cited path to a requirement's group via the requirement_proof matcher; without
  // these it rebuilt FALLBACK cluster areas (CLUSTER:SRC/CLI) and a valid in-pool
  // citation like src/cli/index.ts for a *.CLI.* requirement was attached only as
  // a hypothesis (status stayed missing, tripping --strict) despite the config
  // area mapping. Absent => fall back to repo-index cluster areas (unchanged).
  reviewAreas?: ReviewArea[];
  // The requested "<provider>:<model>" string, folded into the methodology-audit
  // cache key so a model change busts the cache (issue #95). Absent => default model.
  model?: string;
}

interface EvaluationReasoningRunOptions {
  appendReviewFocus?: boolean;
  initialReviewFocusCount?: number;
}

const MAX_PROPOSED_REQUIREMENTS = 5;
// review-surfaces.METHODOLOGY.7 (D3): the bounded event budget the methodology
// leaf may send. Phase 2 uses a simple head-cap by raw_index so the FIRST
// shippable increment is truncation-honest; Phase 5a replaces it with
// salience-ordered chunking + map-reduce (the conversation_truncated flag stays).
const MAX_EVENTS_PER_AUDIT_BATCH = 80;
// review-surfaces.METHODOLOGY.7 (D3): the methodology audit summarizes at most
// this many salience-ranked chunks (one bounded generateStructured call each), so
// the number of LLM calls is bounded; beyond MAX_EVENTS_PER_AUDIT_BATCH ×
// MAX_AUDIT_BATCHES events the audit is truncation-honest (conversation_truncated).
const MAX_AUDIT_BATCHES = 3;
const AUDIT_EVENT_BUDGET = MAX_EVENTS_PER_AUDIT_BATCH * MAX_AUDIT_BATCHES;
// Stage A #1: batch the evaluation candidate-evidence call instead of issuing
// one generateStructured call per weak requirement. We still bound the per-call
// payload: very large repos are split into a few bounded batches rather than one
// unbounded prompt.
const MAX_REQUIREMENTS_PER_EVAL_BATCH = 25;

/**
 * Run all reasoning stages in place against the supplied packet models. The
 * provider is consulted with bounded prompts + JSON schemas; a non-ok result is
 * treated as a skip so the deterministic packet is preserved unchanged.
 *
 * This is the monolithic `all` entry point. The composable per-stage runners
 * below (runIntentReasoning / runEvaluationReasoning / runNarrativeReasoning)
 * split this exact sequence by the artifact each stage's side effects land in,
 * so a composed run reproduces the same enrichment as `all` (compose==monolith).
 */
export async function runReasoningStages(
  provider: ReasoningProvider,
  inputs: ReasoningInputs,
  options: ReasoningOptions = {}
): Promise<void> {
  // Mock (and any provider that opts out of reasoning) is a guaranteed no-op:
  // skip every stage so the offline pipeline stays byte-stable.
  if (provider.name === "mock") {
    return;
  }

  const evidenceContext = buildEvidenceContext(inputs);
  const generateOptions = toGenerateOptions(options);

  await runIntentSynthesis(provider, inputs, evidenceContext, generateOptions);
  const candidateApplication = await runEvaluationCandidateEvidence(
    provider,
    inputs,
    evidenceContext,
    generateOptions,
    resolveReviewAreas(inputs, options),
    inputs.risks.review_focus.length
  );
  appendCandidateReviewFocus(inputs.risks.review_focus, candidateApplication.review_focus);
  await runNarrativeStage(provider, inputs, generateOptions);
  await runMethodologyAuditStage(provider, inputs, evidenceContext, generateOptions, options.model);
}

// FINDING C: resolve the review areas the candidate-evidence group mapping must
// use. Prefer the config-derived areas the caller threads through (the SAME ones
// evaluateIntent used, so a config-area-mapped path is recognized as a
// deterministic tie); fall back to repo-index cluster areas when none are
// supplied so non-configured repos behave exactly as before.
function resolveReviewAreas(inputs: ReasoningInputs, options: ReasoningOptions): ReviewArea[] {
  if (options.reviewAreas && options.reviewAreas.length > 0) {
    return options.reviewAreas;
  }
  return buildReviewAreas({ repoIndex: inputs.collection.repoIndex }).areas;
}

function toGenerateOptions(options: ReasoningOptions): GenerateStructuredOptions {
  return {
    redactSecrets: options.redactSecrets,
    remotePrivacyBlocked: options.remotePrivacyBlocked
  };
}

// ---------------------------------------------------------------------------
// Composable per-stage reasoning runners.
//
// Each runner reproduces EXACTLY the side effects the corresponding stage has
// inside runReasoningStages, so a composed subcommand can capture the same
// enrichment as `all` for the single artifact it owns. The mock short-circuit
// is preserved per runner so the deterministic offline path stays byte-stable.
//
// Side-effect map (which model each stage mutates):
//   intent synthesis      -> inputs.intent            (intent.yaml)
//   candidate evidence    -> inputs.evaluation.results (evaluation.yaml)
//                            inputs.risks.review_focus  (risks.yaml)
//   narrative             -> inputs.methodology         (methodology.yaml)
//                            inputs.risks.items          (risks.yaml)
//
// Because candidate evidence and narrative both touch risks, the risks
// subcommand runs BOTH against freshly computed deterministic models so the
// persisted risks.yaml matches `all`. Each runner mutates only the models it is
// meant to own at the call site; callers discard the cross-cutting models they
// do not persist.
// ---------------------------------------------------------------------------

/** Stage 1: intent synthesis. Mutates inputs.intent in place. */
export async function runIntentReasoning(
  provider: ReasoningProvider,
  inputs: ReasoningInputs,
  options: ReasoningOptions = {}
): Promise<void> {
  if (provider.name === "mock") {
    return;
  }
  await runIntentSynthesis(provider, inputs, buildEvidenceContext(inputs), toGenerateOptions(options));
}

/**
 * Stage 2: evaluation candidate evidence. Mutates inputs.evaluation.results and
 * inputs.risks.review_focus in place, and returns the appended review-focus
 * delta for callers that derive risks after verification.
 */
export async function runEvaluationReasoning(
  provider: ReasoningProvider,
  inputs: ReasoningInputs,
  options: ReasoningOptions = {},
  runOptions: EvaluationReasoningRunOptions = {}
): Promise<CandidateEvidenceApplication> {
  if (provider.name === "mock") {
    return { review_focus: [] };
  }
  const application = await runEvaluationCandidateEvidence(
    provider,
    inputs,
    buildEvidenceContext(inputs),
    toGenerateOptions(options),
    resolveReviewAreas(inputs, options),
    runOptions.initialReviewFocusCount ?? inputs.risks.review_focus.length
  );
  if (runOptions.appendReviewFocus !== false) {
    appendCandidateReviewFocus(inputs.risks.review_focus, application.review_focus);
  }
  return application;
}

/**
 * Stage 3: methodology + risk narrative. Mutates inputs.methodology and
 * inputs.risks.items in place.
 */
export async function runNarrativeReasoning(
  provider: ReasoningProvider,
  inputs: ReasoningInputs,
  options: ReasoningOptions = {}
): Promise<void> {
  if (provider.name === "mock") {
    return;
  }
  await runNarrativeStage(provider, inputs, toGenerateOptions(options));
}

// review-surfaces.METHODOLOGY.7: the composable per-stage runner for the
// methodology leaf, used by runReasoningWithVerification (composed paths). Mock is
// a guaranteed no-op so the degraded keyword fallback + flag survive byte-stable.
export async function runMethodologyReasoning(
  provider: ReasoningProvider,
  inputs: ReasoningInputs,
  options: ReasoningOptions = {}
): Promise<void> {
  if (provider.name === "mock") {
    return;
  }
  await runMethodologyAuditStage(provider, inputs, buildEvidenceContext(inputs), toGenerateOptions(options), options.model);
}

// ---------------------------------------------------------------------------
// Shared evidence validation context
// ---------------------------------------------------------------------------

function buildEvidenceContext(inputs: ReasoningInputs): EvidenceValidationContext {
  const knownPaths = new Set<string>([
    ...inputs.collection.repositoryFiles,
    ...inputs.collection.changedFiles.map((file) => file.path),
    ...inputs.collection.tests.map((test) => test.path),
    ...inputs.collection.docs.map((doc) => doc.path)
  ]);
  const knownAcids = new Set<string>(
    inputs.intent.requirements.map((requirement) => requirement.acai_id).filter(Boolean) as string[]
  );
  // review-surfaces.METHODOLOGY.7 (D5): the event-id allowlist a conversation-kind
  // anchor validates against is CONVERSATION events ONLY — a command-transcript or
  // feedback id must not stamp a `kind:"conversation"` ref valid (those ids belong
  // to their own evidence kinds). A leaf finding citing an unknown event_id demotes
  // (Codex P2).
  const knownEventIds = new Set<string>((inputs.collection.conversationEvents ?? []).map((event) => event.id));
  return {
    cwd: inputs.collection.cwd,
    knownPaths,
    knownAcids,
    knownEventIds,
    pathExistsCache: new Map(),
    lineCountCache: new Map()
  };
}

// ---------------------------------------------------------------------------
// Stage 1: intent synthesis
// ---------------------------------------------------------------------------

const INTENT_SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    non_goals: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
    // review-surfaces.INTENT.6: candidates are {statement, anchors, confidence};
    // anchors are tokens on the narrative allowlist (spec/doc paths, ACIDs).
    candidate_requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          statement: { type: "string" },
          anchors: { type: "array", items: { type: "string" } },
          confidence: { enum: ["medium", "low"] }
        },
        required: ["statement", "anchors"]
      }
    }
  }
} as const;

interface IntentSynthesisOutput {
  summary?: unknown;
  non_goals?: unknown;
  assumptions?: unknown;
  open_questions?: unknown;
  candidate_requirements?: unknown;
}

async function runIntentSynthesis(
  provider: ReasoningProvider,
  inputs: ReasoningInputs,
  evidenceContext: EvidenceValidationContext,
  generateOptions: GenerateStructuredOptions
): Promise<void> {
  const sparse = isSparseSpec(inputs.intent);
  const prompt = intentPrompt(inputs, sparse);
  const result = await provider.generateStructured("intent-synthesis", prompt, INTENT_SYNTHESIS_SCHEMA, generateOptions);
  if (!result.ok || !isRecord(result.data)) {
    return; // no-op: deterministic intent preserved
  }

  const data = result.data as IntentSynthesisOutput;
  const intent = inputs.intent;

  // Authoritative Acai requirements are untouched; only enrich the free-text
  // narrative arrays, each marked as an LLM hypothesis.
  const proposedAssumptions = asStringArray(data.assumptions).map(markHypothesis);
  const proposedNonGoals = asStringArray(data.non_goals).map(markHypothesis);
  const proposedQuestions = asStringArray(data.open_questions).map(markHypothesis);

  intent.assumptions = uniqueTruthy([...intent.assumptions, ...proposedAssumptions]).slice(0, 16);
  intent.non_goals = uniqueTruthy([...intent.non_goals, ...proposedNonGoals]).slice(0, 12);
  intent.open_questions = uniqueTruthy([...intent.open_questions, ...proposedQuestions]).slice(0, 12);

  if (typeof data.summary === "string" && data.summary.trim() !== "") {
    intent.summary = `${intent.summary} ${markHypothesis(data.summary.trim())}`;
  }

  // review-surfaces.INTENT.6/.7: provider candidates land in a SEPARATE
  // claimed-candidates section — never in intent.requirements, so the evaluator
  // (one coverage result per requirement) can never score them and the verdict
  // stays provider-untouchable. A candidate with an invalid anchor is demoted to
  // an open question naming the bad token — never dropped silently.
  applyCandidateRequirements(data.candidate_requirements, intent, evidenceContext);
}

function applyCandidateRequirements(
  raw: unknown,
  intent: IntentModel,
  evidenceContext: EvidenceValidationContext
): void {
  if (!Array.isArray(raw)) {
    return;
  }
  const knownAcids = new Set(
    intent.requirements.map((requirement) => requirement.acai_id).filter((id): id is string => Boolean(id))
  );
  const claimed: ClaimedIntentCandidate[] = intent.claimed_candidates ? [...intent.claimed_candidates] : [];
  const demoted: string[] = [];
  for (const entry of raw.slice(0, MAX_PROPOSED_REQUIREMENTS)) {
    if (!isRecord(entry)) {
      continue;
    }
    const statement = typeof entry.statement === "string" ? redactHypothesisText(entry.statement).trim() : "";
    const anchors = asStringArray(entry.anchors).map((token) => redactHypothesisText(token).trim()).filter(Boolean);
    if (statement === "" || anchors.length === 0) {
      continue;
    }
    // Anchor validation against the deterministic allowlist: an ACID must exist
    // in the indexed spec; a path token must validate as real spec/doc/file
    // evidence. ANY invalid anchor demotes the whole candidate.
    const invalid = anchors.filter((token) => {
      if (knownAcids.has(token)) {
        return false;
      }
      const validated = validateEvidenceRef(
        llmProposedEvidence("file", { path: token, note: "Anchor cited for proposed requirement.", confidence: "low" }),
        evidenceContext
      );
      return validated.validation_status !== "valid";
    });
    if (invalid.length > 0) {
      demoted.push(
        `Provider-proposed requirement could not be verified (invalid anchor(s): ${invalid.join(", ")}): ${statement}`
      );
      continue;
    }
    claimed.push({
      id: `CAND-${String(claimed.length + 1).padStart(3, "0")}`,
      statement,
      anchors,
      confidence: entry.confidence === "medium" ? "medium" : "low",
      trust: "claimed"
    });
  }
  if (claimed.length > 0) {
    intent.claimed_candidates = claimed;
  }
  if (demoted.length > 0) {
    intent.open_questions = uniqueTruthy([...intent.open_questions, ...demoted.map(markHypothesis)]).slice(0, 16);
  }
}

function isSparseSpec(intent: IntentModel): boolean {
  const authoritative = intent.requirements.filter((requirement) => !requirement.llm_derived && requirement.acai_id);
  return authoritative.length === 0;
}

function intentPrompt(inputs: ReasoningInputs, sparse: boolean): string {
  const changedFiles = inputs.collection.changedFiles
    .slice(0, 30)
    .map((file) => `${file.status} ${file.path}`)
    .join("\n");
  const candidateClause = sparse
    ? "The authoritative spec is sparse/absent. You MAY propose up to 5 candidate_requirements, each as {statement, anchors, confidence} where every anchor is a real repository-relative spec/doc path or an ACID that exists in the spec. Do not invent anchors."
    : "The authoritative spec already has requirements. Propose candidate_requirements ONLY for intent you can anchor to real spec/doc paths or existing ACIDs; otherwise leave the array empty.";
  return `Return compact JSON only matching the provided schema. Every assumption/non_goal/open_question MUST cite real repository context, and every candidate_requirement anchor MUST be a real repository-relative spec/doc path or an ACID that exists in the spec. Do not invent file paths, line numbers, ACIDs, or tests.

${candidateClause}

Deterministic intent summary:
${inputs.intent.summary}

Changed files:
${changedFiles || "(none)"}
`;
}

// ---------------------------------------------------------------------------
// Stage 2: evaluation candidate-evidence
// ---------------------------------------------------------------------------

// Stage A #1: the BATCHED candidate-evidence shape. One call returns a
// `requirements` array; each entry keys its candidate_evidence by the
// requirement it addresses (acai_id and/or requirement_id). The deterministic
// processing applied to each entry is IDENTICAL to the prior per-requirement
// path: pool membership, validateEvidenceRef, the per-requirement cap, attach as
// llm_proposed, missing->partial only. Only the call shape/count changed.
const CANDIDATE_EVIDENCE_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["file", "test"] },
    path: { type: "string" },
    line_start: { type: "integer", minimum: 1 },
    line_end: { type: "integer", minimum: 1 },
    test_name: { type: "string" },
    note: { type: "string" }
  },
  required: ["kind", "path"]
} as const;

const CANDIDATE_EVIDENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          // The model echoes back which requirement each batch entry addresses.
          // We match on acai_id first, then requirement_id; an entry that maps to
          // no enrichable requirement in this batch is ignored.
          acai_id: { type: "string" },
          requirement_id: { type: "string" },
          candidate_evidence: {
            type: "array",
            items: CANDIDATE_EVIDENCE_ITEM_SCHEMA
          },
          rationale: { type: "string" },
          what_would_confirm: { type: "string" }
        }
      }
    }
  }
} as const;

interface BatchedCandidateEvidenceOutput {
  requirements?: unknown;
}

interface BatchedCandidateEntry extends CandidateEvidenceOutput {
  acai_id?: unknown;
  requirement_id?: unknown;
}

async function runEvaluationCandidateEvidence(
  provider: ReasoningProvider,
  inputs: ReasoningInputs,
  evidenceContext: EvidenceValidationContext,
  generateOptions: GenerateStructuredOptions,
  // FINDING C/D (soundness): the review areas used to decide whether a cited path
  // is DETERMINISTICALLY TIED to a requirement's group (mirrors the verification
  // loop's strict group mapping). These are the SAME areas evaluateIntent uses --
  // config-derived when the repo declares `areas:`, repo-index clusters otherwise
  // (resolveReviewAreas) -- so a config-area-mapped citation (e.g. src/cli/* for a
  // *.CLI.* requirement) is recognized as a tie rather than a fallback cluster
  // group. Pool membership is necessary but NOT sufficient to upgrade missing ->
  // partial; an unrelated pooled path attaches as a hypothesis but does not change
  // status (FINDING D round-4 soundness, preserved unchanged).
  areas: ReviewArea[],
  initialReviewFocusCount: number
): Promise<CandidateEvidenceApplication> {
  const candidatePaths = candidatePathPool(inputs.collection);
  const matcher = createReviewAreaMatcher(areas);

  // Stage A #3: rank ALL enrichable requirements weakest-first so that, under
  // the global cap, the requirements with the least deterministic evidence win
  // the limited LLM hypothesis budget. Anything beyond the cap simply receives
  // no hypotheses (still deterministic).
  const enrichable = rankEnrichableRequirements(inputs.evaluation.results);
  if (enrichable.length === 0) {
    return { review_focus: [] };
  }

  // Stage A #1: BATCH the call. Send the ranked, enrichable requirements (with
  // the shared candidate-path pool) in a small number of bounded batches and ask
  // the model for candidate_evidence keyed by acai_id/requirement_id, instead of
  // one call per requirement.
  const byRequirementId = new Map<string, BatchedCandidateEntry>();
  const byAcaiId = new Map<string, BatchedCandidateEntry>();
  for (const batch of chunk(enrichable, MAX_REQUIREMENTS_PER_EVAL_BATCH)) {
    const prompt = batchedCandidateEvidencePrompt(batch, inputs.intent, inputs.collection, candidatePaths);
    const stageResult = await provider.generateStructured(
      "evaluation-candidate-evidence",
      prompt,
      CANDIDATE_EVIDENCE_SCHEMA,
      generateOptions
    );
    if (!stageResult.ok || !isRecord(stageResult.data)) {
      continue; // no-op for this batch
    }
    indexBatchedResponse(stageResult.data as BatchedCandidateEvidenceOutput, byRequirementId, byAcaiId);
  }

  if (byRequirementId.size === 0 && byAcaiId.size === 0) {
    return { review_focus: [] }; // no usable batched output
  }

  const entries: CandidateEvidenceEntry[] = [];
  for (const result of enrichable) {
    const entry = lookupBatchedEntry(result, byRequirementId, byAcaiId);
    if (!entry) {
      continue; // the batch returned nothing for this requirement
    }
    entries.push({ result, data: entry });
  }
  return applyCandidateEvidenceEntries(entries, {
    evidenceContext,
    candidatePaths,
    matcher,
    initialReviewFocusCount
  });
}

/** Split an array into bounded chunks (Stage A #1 batch sizing). */
function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Index a batched candidate-evidence response by requirement_id and acai_id so
 * each enrichable requirement can be matched back to its entry. Later entries do
 * not overwrite an earlier one for the same key (first-write-wins keeps the
 * model from re-claiming a requirement across batches).
 */
function indexBatchedResponse(
  data: BatchedCandidateEvidenceOutput,
  byRequirementId: Map<string, BatchedCandidateEntry>,
  byAcaiId: Map<string, BatchedCandidateEntry>
): void {
  const rawRequirements = Array.isArray(data.requirements) ? data.requirements : [];
  for (const raw of rawRequirements) {
    if (!isRecord(raw)) {
      continue;
    }
    const entry = raw as BatchedCandidateEntry;
    const requirementId = typeof entry.requirement_id === "string" ? entry.requirement_id : undefined;
    const acaiId = typeof entry.acai_id === "string" ? entry.acai_id : undefined;
    if (requirementId && !byRequirementId.has(requirementId)) {
      byRequirementId.set(requirementId, entry);
    }
    if (acaiId && !byAcaiId.has(acaiId)) {
      byAcaiId.set(acaiId, entry);
    }
  }
}

/** Match a requirement result to its batched entry: acai_id first, then id. */
function lookupBatchedEntry(
  result: RequirementResult,
  byRequirementId: Map<string, BatchedCandidateEntry>,
  byAcaiId: Map<string, BatchedCandidateEntry>
): BatchedCandidateEntry | undefined {
  if (result.acai_id) {
    const byAcid = byAcaiId.get(result.acai_id);
    if (byAcid) {
      return byAcid;
    }
  }
  return byRequirementId.get(result.requirement_id);
}

function candidatePathPool(collection: CollectionResult): string[] {
  return uniqueTruthy([
    ...collection.changedFiles.map((file) => file.path),
    ...collection.tests.map((test) => test.path)
  ]).slice(0, 40);
}

function batchedCandidateEvidencePrompt(
  batch: RequirementResult[],
  intent: IntentModel,
  collection: CollectionResult,
  candidatePaths: string[]
): string {
  const requirementById = new Map(intent.requirements.map((req) => [req.id, req]));
  const requirementsBlock = batch
    .map((result) => {
      const requirement = requirementById.get(result.requirement_id);
      const text = requirement?.requirement ?? result.summary;
      // Each line echoes the keys the model must use to address the requirement
      // (acai_id when present, requirement_id otherwise) plus its current status.
      return `- requirement_id=${result.requirement_id}${result.acai_id ? ` acai_id=${result.acai_id}` : ""} status=${result.status}: ${text}`;
    })
    .join("\n");
  return `Return compact JSON only matching the provided schema. You are given MANY weak requirements at once. For each requirement you can support, add one entry to the "requirements" array, echoing its acai_id and/or requirement_id so it can be matched back. Propose candidate_evidence ONLY from the shared candidate paths below; never invent paths, line numbers, or tests. Mark everything as a hypothesis; deterministic validation decides whether it counts. Leave out any requirement you cannot support.

Requirements (each addressed by acai_id and/or requirement_id):
${requirementsBlock || "(none)"}

Changed files:
${collection.changedFiles.slice(0, 20).map((file) => file.path).join("\n") || "(none)"}

Shared candidate paths you may cite (same pool for every requirement):
${candidatePaths.join("\n") || "(none)"}
`;
}

// ---------------------------------------------------------------------------
// Stage 3: methodology + risk narrative
// ---------------------------------------------------------------------------

const NARRATIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    considered: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    risk_narratives: { type: "array", items: { type: "string" } }
  }
} as const;

interface NarrativeOutput {
  considered?: unknown;
  decisions?: unknown;
  risk_narratives?: unknown;
}

async function runNarrativeStage(
  provider: ReasoningProvider,
  inputs: ReasoningInputs,
  generateOptions: GenerateStructuredOptions
): Promise<void> {
  const prompt = narrativePrompt(inputs);
  const result = await provider.generateStructured("methodology-risk-narrative", prompt, NARRATIVE_SCHEMA, generateOptions);
  if (!result.ok || !isRecord(result.data)) {
    return; // no-op
  }
  const data = result.data as NarrativeOutput;
  const methodology = inputs.methodology;

  const consideredAdditions = asStringArray(data.considered).map(markHypothesis);
  const decisionsAdditions = asStringArray(data.decisions).map(markHypothesis);
  methodology.considered = uniqueTruthy([...methodology.considered, ...consideredAdditions]).slice(0, 16);
  methodology.decisions = uniqueTruthy([...methodology.decisions, ...decisionsAdditions]).slice(0, 16);

  // Risk narratives are appended as labeled hypotheses (confidence unknown/low),
  // never overriding deterministic risk findings.
  const narratives = asStringArray(data.risk_narratives).slice(0, 3);
  const existing = inputs.risks.items;
  const appended = narratives.map((summary, index) => ({
    id: `LLM-RISK-${String(index + 1).padStart(3, "0")}`,
    category: "unknown" as const,
    severity: "unknown" as const,
    likelihood: "unknown" as const,
    detectability: "unknown" as const,
    summary: markHypothesis(summary),
    impact: "Hypothesis only; not proof of behavior.",
    evidence: [
      // Key order mirrors the canonical EvidenceRef field order used by the
      // load layer (render/load.ts normalizeEvidenceRef): kind, ..., note,
      // confidence, validation_status, llm_proposed. Keeping this order means a
      // directly-written risks.yaml (`all`, composed `risks`) is byte-identical
      // to one round-tripped through the loader (composed `packet`), so
      // compose==monolith holds for risks.yaml.
      {
        kind: "unknown" as const,
        note: "LLM-proposed: risk narrative, not deterministic evidence.",
        confidence: "low" as const,
        validation_status: "unknown" as const,
        llm_proposed: true
      }
    ],
    suggested_checks: ["Validate this hypothesis against deterministic evidence before acting."],
    manual_review: true
  }));
  inputs.risks.items = [...existing, ...appended];
}

function narrativePrompt(inputs: ReasoningInputs): string {
  return `Return compact JSON only matching the provided schema. Provide considered options, decisions, and risk_narratives as hypotheses only. Do not invent file paths, tests, commands, or ACIDs, and do not claim any requirement status.

Evaluation summary: ${inputs.evaluation.summary}
Risk summary: ${inputs.risks.summary}
Methodology summary: ${inputs.methodology.summary}
`;
}

// ---------------------------------------------------------------------------
// Stage 4: methodology audit leaf (item 4) — reads the redacted conversation
// stream (incl. tool calls) and judges the workflow. LLM-primary when a provider
// is configured; with mock/offline this stage never runs and the deterministic
// keyword fallback + methodology_analysis_degraded flag survive (D1/D2).
// ---------------------------------------------------------------------------

const ANCHORED_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    anchors: {
      type: "object",
      additionalProperties: false,
      properties: {
        event_ids: { type: "array", items: { type: "string" } },
        paths: { type: "array", items: { type: "string" } }
      }
    }
  },
  required: ["text"]
} as const;

const METHODOLOGY_AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    considered: { type: "array", items: ANCHORED_ITEM_SCHEMA },
    research: { type: "array", items: ANCHORED_ITEM_SCHEMA },
    unchallenged: { type: "array", items: ANCHORED_ITEM_SCHEMA },
    workflow_assessment: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        soundness: { enum: ["sound", "questionable", "unsound"] },
        anchors: ANCHORED_ITEM_SCHEMA.properties.anchors,
        skipped_steps: { type: "array", items: ANCHORED_ITEM_SCHEMA }
      }
    },
    cross_ref_flags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          signal: { enum: ["risky_no_security", "impl_no_test", "api_no_compat", "deps_no_rationale"] },
          text: { type: "string" },
          anchors: ANCHORED_ITEM_SCHEMA.properties.anchors
        },
        required: ["signal", "text"]
      }
    }
  }
} as const;

interface MethodologyAuditOutput {
  considered?: unknown;
  research?: unknown;
  unchallenged?: unknown;
  workflow_assessment?: unknown;
  cross_ref_flags?: unknown;
}

const CROSS_REF_SIGNALS = new Set<string>(["risky_no_security", "impl_no_test", "api_no_compat", "deps_no_rationale"]);

async function runMethodologyAuditStage(
  provider: ReasoningProvider,
  inputs: ReasoningInputs,
  evidenceContext: EvidenceValidationContext,
  generateOptions: GenerateStructuredOptions,
  model?: string
): Promise<void> {
  const events = inputs.collection.conversationEvents ?? [];
  if (events.length === 0) {
    // No conversation stream: nothing to audit. The deterministic builder's
    // methodology_analysis_degraded flag (when a log WAS present) stays as-is.
    return;
  }
  const methodology = inputs.methodology;

  // review-surfaces.METHODOLOGY.7 (D3): salience-ordered map-reduce. Rank events
  // by salience (user instructions, decisions, tool calls/results, validation
  // turns, and turns touching changed files over chit-chat), keep a bounded budget
  // across at most MAX_AUDIT_BATCHES chunks, summarize each chunk, then merge the
  // per-chunk audits with a DETERMINISTIC order. Replaces the Phase-2 head-cap; the
  // conversation_truncated flag stays.
  const changedFiles = new Set(inputs.collection.changedFiles.map((file) => file.path));
  const { selected, truncated } = selectSalientEvents(events, changedFiles, AUDIT_EVENT_BUDGET);
  const batches = chunk(selected, MAX_EVENTS_PER_AUDIT_BATCH);

  // issue #95 (Phase 5a follow-up): a content-hash cache for the EXPENSIVE remote
  // `ai-sdk` leaf only. mock never reaches this stage; agent-file output depends on
  // a local file, not the prompt, so it is not cached. A privacy-blocked run must
  // NOT read a previously-cached remote response (the provider would now contribute
  // nothing), so the block is a hard cache skip too (Codex P2). The key folds in the
  // resolved model AND the redaction mode — a `--no-redact-secrets` run sends a
  // different effective prompt, so it must not share an entry with a redacted run.
  const cacheable = provider.name === "ai-sdk" && generateOptions.remotePrivacyBlocked !== true;
  const cacheDir = auditCacheDir(inputs.collection.outputDir);
  const modelId = effectiveModelId(model);
  const redactMode = generateOptions.redactSecrets === false ? "noredact" : "redact";

  const multiBatch = batches.length > 1 || truncated;
  const auditOutputs: MethodologyAuditOutput[] = [];
  const batchIdSets: Set<string>[] = [];
  let emptyChunks = 0;
  for (const batch of batches) {
    const prompt = methodologyAuditPrompt(batch, inputs, multiBatch);
    const cacheKey = cacheable ? auditCacheKey(["ai-sdk", modelId, redactMode, prompt]) : undefined;
    let result = cacheKey ? loadCachedAudit(cacheDir, cacheKey) : undefined;
    const fromCache = result !== undefined;
    if (!result) {
      result = await provider.generateStructured("methodology-audit", prompt, METHODOLOGY_AUDIT_SCHEMA, generateOptions);
    }
    if (result.ok && isRecord(result.data)) {
      const data = result.data as MethodologyAuditOutput;
      // Cache a FRESHLY-FETCHED response only when it carries recognizable audit
      // content: a non-ok call (privacy block / missing key / failure) and a
      // schema-valid-but-empty `{}` are NOT cached, so a transient empty response
      // can't leave the audit permanently degraded — a rerun recovers (Codex P2).
      if (cacheKey && !fromCache && hasAuditContent(data)) {
        storeCachedAudit(cacheDir, cacheKey, data);
      }
      auditOutputs.push(data);
      batchIdSets.push(new Set(batch.map((event) => event.id)));
      if (!hasAuditContent(data)) {
        emptyChunks += 1;
      }
    }
  }
  if (auditOutputs.length === 0) {
    return; // SKIP: every batch returned non-ok; degraded fallback + flag preserved, NO truncation flag
  }
  const someBatchFailed = auditOutputs.length < batches.length;

  const eventRawIndex = new Map(selected.map((event) => [event.id, event.raw_index]));

  // The audit RAN: flag a partial audit using the ACTUAL number of analyzed events
  // (the sum of successful batch sizes) so a run that is BOTH over budget AND has a
  // failed batch does not overstate coverage (Codex P2).
  const analyzedEventCount = batchIdSets.reduce((sum, set) => sum + set.size, 0);
  if (analyzedEventCount < events.length) {
    methodology.quality_flags = uniqueTruthy([...methodology.quality_flags, "conversation_truncated"]);
    methodology.skipped_checks = uniqueTruthy([
      ...methodology.skipped_checks,
      `Methodology audit was partial: ${analyzedEventCount} of ${events.length} conversation events were analyzed (salience-ranked${someBatchFailed ? "; a provider batch did not respond" : ""}).`
    ]);
  }
  // Be transparent when a chunk was analyzed but returned no recognizable audit
  // content, so a long transcript is not presented as fully audited on the back of
  // one empty chunk (Codex P2).
  if (emptyChunks > 0) {
    methodology.skipped_checks = uniqueTruthy([
      ...methodology.skipped_checks,
      `Methodology audit: ${emptyChunks} of ${auditOutputs.length} analyzed chunk(s) returned no recognizable audit content.`
    ]);
  }

  // Deterministic cross-chunk reconciliation: a test/validation that ran somewhere
  // in the SELECTED events AFTER the change is EDITED means a chunk-local
  // "implementation changed, no test" flag is likely a partial-view artifact (the
  // test lived in another chunk), so the merged finding is contextualized rather
  // than presented as fact. A test BEFORE the edit (a baseline run, one before the
  // user request, or one after only a mention/read of the file) cannot cover the
  // new change. Ordering is tracked PER changed file: a test that ran after editing
  // `a.ts` must NOT reconcile a no-test finding for `b.ts` that was edited later
  // (Codex P2). When NO selected event EDITS the changed file the order is UNKNOWN,
  // so we do NOT reconcile rather than risk presenting a real gap as an artifact.
  const editIndexByFile = changedFileEditIndexByFile(selected, changedFiles);
  const globalEditIndex = editIndexByFile.size > 0 ? Math.max(...editIndexByFile.values()) : undefined;
  const maxTestIndex = selected.reduce(
    (max, event) => (isTestExecutionEvent(event) && event.raw_index > max ? event.raw_index : max),
    -1
  );
  const reconcilesFinding = (candidate: FindingCandidate): boolean =>
    findingHasPostChangeTest(candidate, changedFiles, editIndexByFile, globalEditIndex, maxTestIndex);

  // Per-CHUNK processing then merge: validate each chunk's items against the events
  // THAT CHUNK actually saw, so a finding can never validate against an event id
  // from a different chunk and an invalid token is still NAMED, not silently
  // dropped (Codex P2). Candidates are then merged deterministically.
  const consideredCandidates: AnchoredCandidate[] = [];
  const researchCandidates: AnchoredCandidate[] = [];
  const findingCandidates: FindingCandidate[] = [];
  let anySoundnessVerdict = false;

  auditOutputs.forEach((data, batchIndex) => {
    const batchContext: EvidenceValidationContext = { ...evidenceContext, knownEventIds: batchIdSets[batchIndex] };
    collectAnchoredCandidates(data.considered, batchContext, changedFiles, eventRawIndex, consideredCandidates);
    collectAnchoredCandidates(data.research, batchContext, changedFiles, eventRawIndex, researchCandidates);

    for (const item of asArray(data.unchallenged).slice(0, MAX_PROPOSED_REQUIREMENTS)) {
      findingCandidates.push(buildFindingCandidate("unchallenged_assumption", item, "low", batchContext, changedFiles, eventRawIndex));
    }
    const assessment = isRecord(data.workflow_assessment) ? data.workflow_assessment : undefined;
    if (assessment) {
      if (typeof assessment.soundness === "string") {
        anySoundnessVerdict = true;
      }
      for (const item of asArray(assessment.skipped_steps).slice(0, MAX_PROPOSED_REQUIREMENTS)) {
        findingCandidates.push(buildFindingCandidate("skipped_step", item, "medium", batchContext, changedFiles, eventRawIndex));
      }
      if (assessment.soundness === "questionable" || assessment.soundness === "unsound") {
        const summaryText =
          typeof assessment.summary === "string" && assessment.summary.trim() !== ""
            ? assessment.summary
            : `Workflow soundness assessed as ${assessment.soundness}.`;
        const soundnessItem = { text: summaryText, anchors: assessment.anchors ?? firstAnchors(assessment.skipped_steps) };
        findingCandidates.push(
          buildFindingCandidate("workflow_soundness", soundnessItem, assessment.soundness === "unsound" ? "high" : "medium", batchContext, changedFiles, eventRawIndex)
        );
      }
    }
    for (const flag of asArray(data.cross_ref_flags).slice(0, MAX_PROPOSED_REQUIREMENTS)) {
      if (!isRecord(flag) || typeof flag.signal !== "string" || !CROSS_REF_SIGNALS.has(flag.signal)) {
        continue;
      }
      findingCandidates.push(buildFindingCandidate(flag.signal as PacketWorkflowSignalKind, flag, "medium", batchContext, changedFiles, eventRawIndex));
    }
  });

  // Item 4a/4b: merge grounded considered/research candidates (ungrounded ones were
  // already dropped per chunk), dedup by text, sort by first-cited event, cap.
  const consideredAdds = mergeCandidateTexts(consideredCandidates).map(markHypothesis);
  const researchAdds = mergeCandidateTexts(researchCandidates).map(markHypothesis);
  methodology.considered = uniqueTruthy([...methodology.considered, ...consideredAdds]).slice(0, 16);
  methodology.research = uniqueTruthy([...methodology.research, ...researchAdds]).slice(0, 16);

  // Item 4c: merge finding candidates — dedup by (signal_kind + core text)
  // PREFERRING the grounded then higher-severity copy (so a chunk that validated an
  // anchor wins over one that did not), sort, cap, assign ids.
  const findings = mergeFindingCandidates(findingCandidates, methodology.workflow_findings.length, reconcilesFinding);
  methodology.workflow_findings = [...methodology.workflow_findings, ...findings].slice(0, 50);

  // Clear the "deep audit not run" marker ONLY when the provider produced
  // recognizable audit content — an `ok` but empty/irrelevant payload must NOT
  // present the keyword fallback as a real audit; a valid workflow_assessment (even
  // soundness:"sound" with no concerns) DOES count (Codex P2).
  const producedContent = consideredAdds.length > 0 || researchAdds.length > 0 || findings.length > 0 || anySoundnessVerdict;
  if (producedContent) {
    methodology.quality_flags = methodology.quality_flags.filter((flag) => flag !== "methodology_analysis_degraded");
  }
}

interface AnchoredCandidate {
  text: string;
  sortIndex: number;
}

interface FindingCandidate {
  signalKind: PacketWorkflowSignalKind;
  coreText: string;
  severity: PacketSeverity;
  severityRank: number;
  evidence: EvidenceRef[];
  invalidTokens: string[];
  grounded: boolean;
  sortIndex: number;
  dedupKey: string;
}

const SEVERITY_RANK: Record<string, number> = { unknown: 0, low: 1, medium: 2, high: 3, critical: 4 };

// Collect the grounded (validated-anchor) considered/research items for ONE chunk.
// Ungrounded items are dropped so a hallucinated alternative/research is not
// surfaced as a conversation-derived fact.
function collectAnchoredCandidates(
  value: unknown,
  context: EvidenceValidationContext,
  changedFiles: Set<string>,
  eventRawIndex: Map<string, number>,
  out: AnchoredCandidate[]
): void {
  for (const item of asArray(value).slice(0, MAX_PROPOSED_REQUIREMENTS)) {
    const text = redactHypothesisText(isRecord(item) ? (typeof item.text === "string" ? item.text : "") : typeof item === "string" ? item : "").trim();
    if (text === "") {
      continue;
    }
    const anchors = isRecord(item) ? item.anchors : undefined;
    const { evidence } = resolveAuditAnchors(anchors, context, changedFiles);
    if (evidence.length > 0) {
      out.push({ text, sortIndex: firstCitedRawIndex(anchors, eventRawIndex) });
    }
  }
}

// Build one finding candidate from a leaf item, validating its anchors against the
// chunk's context. Invalid anchors are recorded (named, not dropped) so the merged
// finding can demote-and-name them.
function buildFindingCandidate(
  signalKind: PacketWorkflowSignalKind,
  item: unknown,
  severity: PacketSeverity,
  context: EvidenceValidationContext,
  changedFiles: Set<string>,
  eventRawIndex: Map<string, number>
): FindingCandidate {
  const rawText = isRecord(item) ? item.text : item;
  const anchors = isRecord(item) ? item.anchors : undefined;
  const { evidence, invalidTokens } = resolveAuditAnchors(anchors, context, changedFiles);
  const coreText = redactHypothesisText(typeof rawText === "string" ? rawText : "").trim() || "(no description provided)";
  return {
    signalKind,
    coreText,
    severity,
    severityRank: SEVERITY_RANK[severity] ?? 0,
    evidence,
    invalidTokens,
    grounded: evidence.length > 0,
    sortIndex: firstCitedRawIndex(anchors, eventRawIndex),
    // workflow_assessment is the ONE overall soundness verdict for the run, so all
    // chunks' soundness candidates dedup to a single finding and the merge keeps the
    // WORST verdict (higher severity wins) instead of rendering conflicting overall
    // assessments per chunk. Other signals still dedup by signal + text (Codex P2).
    dedupKey: signalKind === "workflow_soundness" ? signalKind : `${signalKind}::${coreText.toLowerCase()}`
  };
}

function mergeCandidateTexts(candidates: AnchoredCandidate[]): string[] {
  const byText = new Map<string, AnchoredCandidate>();
  for (const candidate of candidates) {
    const key = candidate.text.toLowerCase();
    const existing = byText.get(key);
    if (!existing || candidate.sortIndex < existing.sortIndex) {
      byText.set(key, candidate);
    }
  }
  return [...byText.values()]
    .sort((left, right) => left.sortIndex - right.sortIndex || compareText(left.text.toLowerCase(), right.text.toLowerCase()))
    .slice(0, MAX_PROPOSED_REQUIREMENTS)
    .map((candidate) => candidate.text);
}

function mergeFindingCandidates(
  candidates: FindingCandidate[],
  baseCount: number,
  reconciles: (candidate: FindingCandidate) => boolean
): WorkflowFinding[] {
  const byKey = new Map<string, FindingCandidate>();
  for (const candidate of candidates) {
    const existing = byKey.get(candidate.dedupKey);
    // Merge duplicates across chunks: UNION the evidence + invalid tokens (a token
    // valid in any chunk is no longer "unverified"), take the worst severity and
    // earliest event, and stay grounded if either copy was (Codex P2).
    byKey.set(candidate.dedupKey, existing ? mergeFindingCandidate(existing, candidate) : candidate);
  }
  return [...byKey.values()]
    // Sort by severity DESC first so a late high-severity finding (e.g. an unsound
    // verdict) is never capped out by earlier low-severity ones (Codex P2).
    .sort(
      (left, right) =>
        right.severityRank - left.severityRank || left.sortIndex - right.sortIndex || compareText(left.dedupKey, right.dedupKey)
    )
    .slice(0, MAX_PROPOSED_REQUIREMENTS * 4)
    .map((candidate, index) => decorateFindingCandidate(baseCount + index + 1, candidate, reconciles(candidate)));
}

function mergeFindingCandidate(existing: FindingCandidate, incoming: FindingCandidate): FindingCandidate {
  // Pick the worst severity; break an equal-severity tie toward the GROUNDED
  // candidate so a merged verdict (e.g. two same-severity soundness summaries)
  // renders with available validated evidence rather than the first chunk's
  // unanchored one. Otherwise keep the earlier candidate for determinism (Codex P2).
  const worst =
    incoming.severityRank > existing.severityRank ||
    (incoming.severityRank === existing.severityRank && incoming.grounded && !existing.grounded)
      ? incoming
      : existing;
  // Different-text candidates share a dedup key only because workflow_soundness
  // collapses by signal alone (one overall verdict per run). There the WINNING
  // (worst) verdict keeps its OWN evidence so a high-severity verdict is never
  // presented as evidence-bound by borrowing the losing verdict's anchor (Codex P2).
  if (existing.coreText !== incoming.coreText) {
    return worst;
  }
  // True duplicates (same signal + text across chunks): union the evidence and
  // invalid tokens so a token valid in ANY chunk is no longer "unverified".
  const evidence = unionEvidence(existing.evidence, incoming.evidence);
  const valid = new Set<string>();
  for (const ref of evidence) {
    if (typeof ref.event_id === "string") {
      valid.add(ref.event_id);
    }
    if (typeof ref.path === "string") {
      valid.add(ref.path);
    }
  }
  const invalidTokens = [...new Set([...existing.invalidTokens, ...incoming.invalidTokens])].filter((token) => !valid.has(token));
  return {
    ...worst,
    evidence,
    invalidTokens,
    grounded: existing.grounded || incoming.grounded,
    sortIndex: Math.min(existing.sortIndex, incoming.sortIndex)
  };
}

function unionEvidence(left: EvidenceRef[], right: EvidenceRef[]): EvidenceRef[] {
  const byKey = new Map<string, EvidenceRef>();
  for (const ref of [...left, ...right]) {
    const key = `${ref.kind}:${ref.event_id ?? ""}:${ref.path ?? ""}`;
    if (!byKey.has(key)) {
      byKey.set(key, ref);
    }
  }
  return [...byKey.values()];
}

// A finding whose claim is "tests/validation are missing". impl_no_test always
// qualifies; a skipped_step or workflow_soundness verdict qualifies only when its
// text is actually about testing, so a non-test skipped step (e.g. "no design
// review") is NOT spuriously reconciled by an unrelated test run.
const MISSING_VALIDATION_TEXT =
  /\b(?:tests?|testing|coverage|regression|validat(?:e|ed|es|ion|ing)|verif(?:y|ied|ies|ication)|untested|unverified)\b/i;
function assertsMissingValidation(signalKind: PacketWorkflowSignalKind, coreText: string): boolean {
  if (signalKind === "impl_no_test") {
    return true;
  }
  if (signalKind === "skipped_step" || signalKind === "workflow_soundness") {
    return MISSING_VALIDATION_TEXT.test(coreText);
  }
  return false;
}

function decorateFindingCandidate(seq: number, candidate: FindingCandidate, testExecuted: boolean): WorkflowFinding {
  let summary =
    candidate.invalidTokens.length > 0 ? `${candidate.coreText} (unverified anchor(s): ${candidate.invalidTokens.join(", ")})` : candidate.coreText;
  // Cross-chunk reconciliation (Codex P2): a finding that asserts MISSING
  // tests/validation can be a partial-view artifact — one batch never saw the
  // validation that ran in another. When a test actually ran somewhere in the
  // selected events, contextualize the claim (impl_no_test always, and a
  // skipped_step / soundness verdict whose text is about testing) rather than
  // presenting absence as fact. The finding is kept, not dropped (demote-not-drop).
  if (testExecuted && assertsMissingValidation(candidate.signalKind, candidate.coreText)) {
    summary += " (note: a test execution was observed elsewhere in the conversation — confirm it does not already cover this change)";
  }
  return {
    id: `WF-${String(seq).padStart(3, "0")}`,
    signal_kind: candidate.signalKind,
    summary: markHypothesis(summary),
    severity: candidate.severity,
    advisory: true,
    evidence:
      candidate.evidence.length > 0
        ? candidate.evidence
        : [
            {
              kind: "unknown",
              note: "LLM-proposed: methodology audit finding lacks a validated anchor.",
              confidence: "low",
              validation_status: "not_checked",
              llm_proposed: true
            }
          ]
  };
}

// review-surfaces.METHODOLOGY.7 (D3): rank an event's importance for the audit.
// Tool calls/results are the primary evidence (D8); user turns carry instructions;
// decisions, validation turns, and turns touching a changed file matter more than
// chit-chat. Deterministic — no wall-clock, no randomness.
function salienceScore(event: ConversationEvent, changedFiles: Set<string>): number {
  let score = 0;
  if (event.kind === "tool_call" || event.kind === "tool_result") {
    score += 3;
  }
  if (event.kind === "decision") {
    score += 3;
  }
  if (event.actor === "user") {
    score += 2;
  } else if (event.actor === "assistant") {
    score += 1;
  }
  // A changed file may be named in event.file, inside a shell tool_call's command
  // (e.g. `cat src/uploader.ts`), OR in message text — a user instruction like
  // "change src/uploader.ts but keep the API stable" carries the constraints this
  // phase must preserve, so check the summary too (Codex P2).
  if (eventTouchesChangedFile(event, changedFiles)) {
    score += 2;
  }
  // A validation keyword may be in the summary OR the (often generic-summary) shell
  // command, so check both. Keywords are WHOLE-WORD bounded (with explicit
  // inflections) so prose like "building the UI" or "password handling" does not
  // earn a false validation boost that could displace real evidence (Codex P3).
  if (
    /\b(?:tests?|lint(?:ing|ed|er|s)?|typecheck(?:ing|ed|s)?|build(?:s)?|pass(?:es|ed|ing)?|fail(?:s|ed|ing|ure)?|verif(?:y|ied|ies|ication)|validat(?:e|ed|es|ion|ing))\b/i.test(
      `${event.summary} ${event.command ?? ""}`
    )
  ) {
    score += 2;
  }
  return score;
}

// A tool file path may be absolute, `./`-prefixed, or Windows-separated (e.g.
// `src\uploader.ts`, `C:\repo\src\uploader.ts`) while changedFiles is
// slash-separated repo-relative; fold backslashes to `/` then match on the
// normalized path or a path-segment-aligned suffix so a real edit/test touch is
// not missed — but NOT on a bare basename (e.g. a tool inspecting some other
// `config.ts` must not match `src/config.ts`) — Codex P2.
function touchesChangedFile(file: string, changedFiles: Set<string>): boolean {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (changedFiles.has(normalized)) {
    return true;
  }
  // Only an ABSOLUTE event path may suffix-match a repo-relative changed path: a
  // longer REPO-RELATIVE path like `packages/api/src/uploader.ts` is a DIFFERENT
  // file from `src/uploader.ts`, so suffix-matching it would mis-attribute the edit
  // and start the post-change ordering clock on the wrong file (Codex P2).
  const isAbsolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  for (const changed of changedFiles) {
    // absolute event path ends with the FULL repo-relative changed path
    if (isAbsolute && normalized.endsWith(`/${changed}`)) {
      return true;
    }
    // changed path ends with the event subpath, but only when the event path has a
    // directory segment of its own (a bare basename is too loose to trust)
    if (normalized.includes("/") && changed.endsWith(`/${normalized}`)) {
      return true;
    }
  }
  return false;
}

// True when a changed-file path appears as a PATH-BOUNDED token in free text (a
// shell command or message). Fold backslashes so a Windows-separated reference
// still matches. The match must end on a path boundary (not `src/foo.tsx`), and the
// FULL surrounding path token is then validated with the SAME rule as a structured
// path (`touchesChangedFile`): only an exact match, a `./`-prefix, or an ABSOLUTE
// path suffix counts. So `packages/api/src/uploader.ts` is a DIFFERENT file from
// `src/uploader.ts` here too, and a false mention does not feed the salience or
// change-order signals (Codex P2).
function textNamesChangedFile(text: string, changedFiles: Set<string>): boolean {
  const haystack = text.replace(/\\/g, "/");
  for (const changed of changedFiles) {
    if (changed.length === 0) {
      continue;
    }
    let from = 0;
    for (;;) {
      const idx = haystack.indexOf(changed, from);
      if (idx === -1) {
        break;
      }
      const after = haystack[idx + changed.length] ?? "";
      if (!/[A-Za-z0-9._-]/.test(after)) {
        // Walk back to the start of the surrounding path token, then apply the
        // structured-path rule to it (absolute-only suffix; `./` allowed).
        let start = idx;
        while (start > 0 && /[A-Za-z0-9._/-]/.test(haystack[start - 1])) {
          start -= 1;
        }
        if (touchesChangedFile(haystack.slice(start, idx + changed.length), new Set([changed]))) {
          return true;
        }
      }
      from = idx + 1;
    }
  }
  return false;
}

// True when an event references a changed file via its edited path, a shell
// command, or message text (summary). Broad predicate used for the SALIENCE boost
// — a read or a mention of a changed file is worth ranking up (Codex P2).
function eventTouchesChangedFile(event: ConversationEvent, changedFiles: Set<string>): boolean {
  return (
    (event.file !== undefined && touchesChangedFile(event.file, changedFiles)) ||
    (event.command !== undefined && textNamesChangedFile(event.command, changedFiles)) ||
    textNamesChangedFile(event.summary, changedFiles)
  );
}

// Tools that WRITE/EDIT a file (vs. read or inspect it). Matches only unambiguous
// write verbs — `edit` (Cursor, `Edit`, `MultiEdit`, `NotebookEdit`), `write`
// (`Write`, `write_file`), `patch` (`apply_patch`), `replace` (`str_replace`). A
// `Read`/`cat`/`grep`/`NotebookRead` must NOT match, so vague substrings like
// `notebook`/`create`/`update` are intentionally excluded (Codex P2).
const EDIT_TOOL_PATTERN = /(?:edit|write|patch|replace)/i;

// True when a tool_CALL is an EDIT/WRITE invocation (an edit/write tool name). The
// reconciliation ordering anchor must be a real edit signal, not the broad touch
// predicate — a mere mention/read is not an edit, and an untyped tool_result that
// merely carries a file is NOT an edit (Codex P2).
function isEditCall(event: ConversationEvent): boolean {
  return event.kind === "tool_call" && event.tool !== undefined && EDIT_TOOL_PATTERN.test(event.tool);
}

// The paths an apply_patch-style tool edits, taken ONLY from its unambiguous
// CONTROL lines — `*** Update/Add/Delete File: <path>` and a move's
// `*** Move to: <path>` — anchored at the LINE START (`^\*\*\*`, no leading
// whitespace), which a `+`/`-`/` `-prefixed hunk/content line can never be. So a
// path merely MENTIONED in patch body text, or a literal `diff --git` snippet
// inside a docs patch, is NOT treated as an edit target. The whole rest of the line
// is captured, so a path with spaces (`docs/api notes.md`) is not truncated. We do
// NOT parse unified-diff `diff`/`---`/`+++` operands (git's format, not the
// apply_patch tool) — those stay conservatively unrecognized (Codex P2).
function patchHeaderTargets(text: string): string[] {
  const targets: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fileHeader = line.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+?)\s*$/i);
    if (fileHeader) {
      targets.push(fileHeader[1]);
      continue;
    }
    const moveTo = line.match(/^\*\*\*\s+Move\s+to:\s+(.+?)\s*$/i);
    if (moveTo) {
      targets.push(moveTo[1]);
    }
  }
  return targets;
}

// True when an EDIT/WRITE tool call targets `changed`. A STRUCTURED target
// (`event.file`) is authoritative — a `Write docs/notes.md` whose body merely
// mentions `src/x.ts` must NOT count as editing `src/x.ts`. Only patch-style tools
// with no `event.file` fall back to their PATCH HEADERS (never free body text).
function editTargetsChangedFile(event: ConversationEvent, changed: string): boolean {
  if (event.file !== undefined) {
    return touchesChangedFile(event.file, new Set([changed]));
  }
  // A patch header is itself a repo-relative control-line path, so compare it
  // EXACTLY (after normalizing `./`/backslashes) — NOT with the suffix logic, which
  // would treat `api/src/uploader.ts` as the reviewed `packages/api/src/uploader.ts`
  // (Codex P2).
  return patchHeaderTargets(`${event.command ?? ""}\n${event.summary}`)
    .map((target) => target.replace(/\\/g, "/").replace(/^\.\/+/, ""))
    .includes(changed);
}

// The LATEST raw_index at which EACH changed file is actually EDITED. Tracking
// edits PER FILE means a test that ran after editing `a.ts` does not reconcile a
// no-test finding for `b.ts` edited later; tracking the LATEST edit means a test
// that ran between two edits of the SAME file (edit → test → edit) does not count
// as covering the final change (Codex P2).
function changedFileEditIndexByFile(events: ConversationEvent[], changedFiles: Set<string>): Map<string, number> {
  const byFile = new Map<string, number>();
  for (const event of events) {
    if (!isEditCall(event)) {
      continue;
    }
    for (const changed of changedFiles) {
      if (!editTargetsChangedFile(event, changed)) {
        continue;
      }
      const prev = byFile.get(changed);
      if (prev === undefined || event.raw_index > prev) {
        byFile.set(changed, event.raw_index);
      }
    }
  }
  return byFile;
}

// True when a missing-validation finding is contradicted by a test that ran AFTER
// the relevant edit. If the finding anchors a specific changed file, the test must
// post-date THAT file's edit; otherwise (a non-file-specific skipped_step /
// soundness verdict) any test after the earliest edit counts (Codex P2).
function findingHasPostChangeTest(
  candidate: FindingCandidate,
  changedFiles: Set<string>,
  editIndexByFile: Map<string, number>,
  globalEditIndex: number | undefined,
  maxTestIndex: number
): boolean {
  if (maxTestIndex < 0) {
    return false;
  }
  // Normalize a cited path (`./src/b.ts`, backslashes) to its changed-file key
  // before membership — `resolveAuditAnchors` keeps the original token in evidence,
  // so an un-normalized `changedFiles.has` would drop a valid cited file and let a
  // multi-file finding reconcile on a subset (Codex P2).
  const citedChanged = candidate.evidence
    .filter((ref) => ref.kind === "file" && typeof ref.path === "string")
    .map((ref) => (ref.path as string).replace(/\\/g, "/").replace(/^\.\/+/, ""))
    .filter((path) => changedFiles.has(path));
  if (citedChanged.length > 0) {
    // A finding citing changed files reconciles only when EVERY cited changed file
    // has a KNOWN edit AND a test that ran after it. A cited file with no detected
    // edit is treated as unreconciled (its coverage is unknown) rather than dropped
    // from the check, so a test after `a.ts` can't clear an also-cited `b.ts` whose
    // edit was never observed in the selected slice (Codex P2).
    return citedChanged.every((path) => {
      const editIndex = editIndexByFile.get(path);
      return editIndex !== undefined && maxTestIndex > editIndex;
    });
  }
  return globalEditIndex !== undefined && maxTestIndex > globalEditIndex;
}

// True when an audit chunk's output carries recognizable item-4 content.
function hasAuditContent(data: MethodologyAuditOutput): boolean {
  if (
    asArray(data.considered).length > 0 ||
    asArray(data.research).length > 0 ||
    asArray(data.unchallenged).length > 0 ||
    asArray(data.cross_ref_flags).length > 0
  ) {
    return true;
  }
  const assessment = isRecord(data.workflow_assessment) ? data.workflow_assessment : undefined;
  return assessment !== undefined && (typeof assessment.soundness === "string" || asArray(assessment.skipped_steps).length > 0);
}

// A test/validation RUNNER invocation in the SELECTED set — used to reconcile a
// chunk-local impl_no_test claim that another chunk's test run contradicts. It
// must be an executed runner COMMAND, not a mere mention of "test" (e.g. reading
// or grepping a test file does NOT count — Codex P2).
function isTestExecutionEvent(event: ConversationEvent): boolean {
  if (event.kind !== "tool_call" && event.kind !== "tool_result") {
    return false;
  }
  return commandRunsTest(event.command ?? "");
}

// Cross-ecosystem test runners the JS-focused classifier does not model. Includes
// common Python wrappers (`python -m pytest`, `python3 -m unittest`) so a real
// post-change test run is recognized (Codex P3).
const CROSS_ECOSYSTEM_RUNNER =
  /^(?:node\s+--test|python[0-9.]*\s+-m\s+(?:pytest|unittest)|pytest|go\s+test|cargo\s+test|rspec|phpunit|(?:gradle|mvn)\s+test|ctest)\b/i;
const LEADING_ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;

// True when ANY executed segment of a (possibly chained) shell command runs a
// test. Splitting on `&&`/`||`/`|`/`;` and stripping leading `VAR=value`
// assignments lets a test that is not the first command count
// (`pnpm run lint && pnpm run test`, `cd api && pnpm test`) while a mere mention
// (`grep pytest pyproject.toml`, `echo "go test"`) does not, because each segment
// is matched at its executed command position. Reuses the workspace/filter-aware
// package classifier for JS monorepo selectors (`pnpm --filter api test`) and the
// cross-ecosystem regex for the runners it does not model (Codex P2).
function commandRunsTest(command: string): boolean {
  if (command.trim() === "") {
    return false;
  }
  return commandSegments(command).some(
    (segment) => commandLooksLikeTestCommand(segment) || CROSS_ECOSYSTEM_RUNNER.test(segment)
  );
}

// Conservatively drop ALL heredoc BODIES (`<<MARKER ... \nMARKER`) before command
// segmentation. A heredoc body is ambiguous — inert input to `cat`/`tee`, stdin to
// a script (`bash run.sh <<EOF`), or executed by a bare interpreter (`bash <<EOF`,
// `cat <<EOF | bash`). Rather than parse the shell precisely (an unbounded
// edge-case surface), the ADVISORY reconciliation note errs toward NOT firing: a
// test command that appears only inside a heredoc body is not counted as an executed
// test run. The body lines are removed so they never segment into commands (Codex P2).
function stripHeredocBodies(command: string): string {
  // Drop the body up to its terminator (CRLF-aware) OR, when the heredoc is
  // TRUNCATED with no terminator (tool bodies are bounded to MAX_TOOL_BODY_LENGTH),
  // up to end-of-command — so a dangling `pnpm test` body line is never segmented
  // into a counted test run (Codex P2).
  return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?(?:\r?\n[ \t]*\2[ \t]*(?=\r?\n|$)|$)/g, "<<$2");
}

function commandSegments(command: string): string[] {
  // Newlines are shell command separators too, so a multi-line tool command
  // (`cd api\npnpm test`) splits into its real commands (Codex P2).
  return stripHeredocBodies(command).split(/&&|\|\||[|;\n\r]/).map((segment) => {
    let seg = segment.trim();
    while (LEADING_ENV_ASSIGNMENT.test(seg)) {
      seg = seg.replace(LEADING_ENV_ASSIGNMENT, "");
    }
    return seg;
  });
}

// Select up to `budget` events by salience (desc), tie-broken by raw_index (asc)
// for stability, returning them in SALIENCE order so the chunker puts the most
// important events in the FIRST batch(es) — if a later batch fails/truncates, the
// high-salience events the map-reduce exists to preserve are the ones that ran
// (Codex P2). Each batch is re-sorted chronologically for the prompt by
// methodologyAuditPrompt. `truncated` is true when events were dropped.
function selectSalientEvents(
  events: ConversationEvent[],
  changedFiles: Set<string>,
  budget: number
): { selected: ConversationEvent[]; truncated: boolean } {
  const ranked = [...events].sort(
    (left, right) => salienceScore(right, changedFiles) - salienceScore(left, changedFiles) || left.raw_index - right.raw_index
  );
  // The WINNERS are the top-`budget` events by salience — selection never includes
  // a non-winner, so pulling a partner can never evict a higher-ranked event (Codex
  // P2). Co-location below only reorders winners; it never forces a low-salience
  // partner into the budget.
  const winners = new Set(ranked.slice(0, budget).map((event) => event.id));
  const byRawIndex = new Map(events.map((event) => [event.raw_index, event]));
  // Emit winners in salience order, but place a winner's COMPLEMENTARY partner
  // (a tool_call's following tool_result, or a tool_result's preceding tool_call)
  // right after it when the partner is ALSO a winner — so a command and its outcome
  // stay adjacent and land in the same 80-event chunk (round-8 #3423068338) without
  // displacing any higher-ranked event (round-10 #3423378795).
  const selected: ConversationEvent[] = [];
  const emitted = new Set<string>();
  for (const event of ranked) {
    if (!winners.has(event.id) || emitted.has(event.id)) {
      continue;
    }
    selected.push(event);
    emitted.add(event.id);
    const partnerKind = event.kind === "tool_call" ? "tool_result" : event.kind === "tool_result" ? "tool_call" : undefined;
    const partnerIndex = event.kind === "tool_call" ? event.raw_index + 1 : event.kind === "tool_result" ? event.raw_index - 1 : undefined;
    if (partnerKind !== undefined && partnerIndex !== undefined) {
      const partner = byRawIndex.get(partnerIndex);
      if (partner && partner.kind === partnerKind && winners.has(partner.id) && !emitted.has(partner.id)) {
        selected.push(partner);
        emitted.add(partner.id);
      }
    }
  }
  return { selected, truncated: events.length > budget };
}

// The raw_index of the first cited event id present in the selection, used as the
// stable merge sort key (Infinity sorts unanchored items last).
function firstCitedRawIndex(anchors: unknown, eventRawIndex: Map<string, number>): number {
  if (!isRecord(anchors)) {
    return Number.MAX_SAFE_INTEGER;
  }
  for (const raw of asStringArray(anchors.event_ids)) {
    const index = eventRawIndex.get(raw.trim());
    if (index !== undefined) {
      return index;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolveAuditAnchors(
  anchors: unknown,
  context: EvidenceValidationContext,
  changedFiles: Set<string>
): { evidence: EvidenceRef[]; invalidTokens: string[] } {
  const evidence: EvidenceRef[] = [];
  const invalidTokens: string[] = [];
  const eventIds = isRecord(anchors) ? asStringArray(anchors.event_ids) : [];
  const paths = isRecord(anchors) ? asStringArray(anchors.paths) : [];
  for (const raw of eventIds) {
    const token = redactHypothesisText(raw).trim();
    if (token === "") {
      continue;
    }
    const ref = validateEvidenceRef(
      {
        kind: "conversation",
        event_id: token,
        note: "LLM-proposed: methodology audit event anchor.",
        confidence: "low",
        validation_status: "not_checked",
        llm_proposed: true
      },
      context
    );
    if (ref.validation_status === "valid") {
      evidence.push(ref);
    } else {
      invalidTokens.push(token);
    }
  }
  for (const raw of paths) {
    const token = redactHypothesisText(raw).trim();
    if (token === "") {
      continue;
    }
    const normalized = token.replace(/^\.\/+/, "");
    const ref = validateEvidenceRef(
      llmProposedEvidence("file", { path: token, note: "Methodology audit changed-file anchor.", confidence: "low" }),
      context
    );
    // A path anchor must be BOTH valid evidence AND a changed file in this diff
    // (the audit only judges the reviewed change).
    if (ref.validation_status === "valid" && changedFiles.has(normalized)) {
      evidence.push(ref);
    } else {
      invalidTokens.push(token);
    }
  }
  return { evidence, invalidTokens };
}

// The anchors of the first item in an anchored array, used so a workflow-soundness
// finding can borrow the skipped-steps' validated anchors when the assessment
// supplies none of its own.
function firstAnchors(value: unknown): unknown {
  const first = asArray(value).find((item) => isRecord(item) && isRecord(item.anchors));
  return isRecord(first) ? first.anchors : undefined;
}

function methodologyAuditPrompt(events: ConversationEvent[], inputs: ReasoningInputs, partial = false): string {
  // The batch is composed in salience order; sort it chronologically here so the
  // model reads a coherent slice (Codex P2).
  const eventLines = [...events]
    .sort((left, right) => left.raw_index - right.raw_index)
    .map((event) => {
      const head = `[${event.id}] ${event.actor}/${event.kind}`;
      const tool = event.tool ? ` tool=${event.tool}` : "";
      const file = event.file ? ` file=${event.file}` : "";
      // Include the (already-redacted) command so a preserved tool_call carries
      // its actual command to the leaf — research/validation can't be judged from
      // a bare summary that omits the args (Codex P2).
      const command = event.command ? ` cmd=${truncateForPrompt(event.command, 200)}` : "";
      return `${head}${tool}${file}${command}: ${truncateForPrompt(event.summary, 240)}`;
    })
    .join("\n");
  const changedFiles = inputs.collection.changedFiles.slice(0, 30).map((file) => file.path).join("\n") || "(none)";
  const slice = partial
    ? " NOTE: these events are a SALIENCE-RANKED SLICE of a longer conversation, not the whole of it — base 'unchallenged'/'skipped'/cross-reference claims only on what is clearly absent from the FULL change, since a step you cannot see here may have happened in an un-shown turn."
    : "";
  return `Return compact JSON only matching the provided schema. You are auditing a coding agent's RAW conversation (messages + tool calls) that produced the diff below. Judge the methodology, citing only event ids and changed-file paths that appear here.${slice}

Answer item 4:
- considered: what alternatives/options were weighed (cite event_ids).
- research: what research/context-gathering happened — ground EACH in the tool_call/tool_result events that did it (cite those event_ids).
- unchallenged: assumptions that were made but NOT challenged (what is MISSING from the conversation), each with the nearest event_id.
- workflow_assessment: an overall soundness verdict (sound|questionable|unsound) and any important steps that were skipped.
- cross_ref_flags: where the diff changed something risky with no matching discussion — risky_no_security (auth/crypto/secrets/input-validation changed, no security discussion), impl_no_test (implementation changed, no test added/run), api_no_compat (exported API / schema / public contract changed, no compatibility discussion), deps_no_rationale (dependency/lockfile/CI/config changed, no rationale).

Do NOT invent event ids or file paths; cite only ones present below. Keep each array to at most 5 items.

Conversation events (id / actor / kind / summary):
${eventLines || "(none)"}

Changed files:
${changedFiles}
`;
}

function truncateForPrompt(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
