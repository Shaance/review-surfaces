import { CollectionResult } from "../collector/collect";
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
import { GenerateStructuredOptions, ReasoningProvider } from "./provider";

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
  await runMethodologyAuditStage(provider, inputs, evidenceContext, generateOptions);
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
  await runMethodologyAuditStage(provider, inputs, buildEvidenceContext(inputs), toGenerateOptions(options));
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
  // review-surfaces.METHODOLOGY.7 (D5): the event-id allowlist the methodology
  // leaf's anchors validate against — conversation events + command transcripts +
  // feedback findings. A leaf finding citing an unknown event_id demotes.
  const knownEventIds = new Set<string>([
    ...(inputs.collection.conversationEvents ?? []).map((event) => event.id),
    ...(inputs.collection.commandTranscripts ?? []).map((transcript) => transcript.id),
    ...inputs.collection.feedback.flatMap((file) => file.findings.map((finding) => finding.id))
  ]);
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
  generateOptions: GenerateStructuredOptions
): Promise<void> {
  const events = inputs.collection.conversationEvents ?? [];
  if (events.length === 0) {
    // No conversation stream: nothing to audit. The deterministic builder's
    // methodology_analysis_degraded flag (when a log WAS present) stays as-is.
    return;
  }
  const methodology = inputs.methodology;

  // Bounded event budget (truncation-honest). A simple head-cap by raw_index in
  // Phase 2; Phase 5a replaces it with salience ordering + map-reduce.
  const ordered = [...events].sort((left, right) => left.raw_index - right.raw_index);
  const bounded = ordered.slice(0, MAX_EVENTS_PER_AUDIT_BATCH);
  if (ordered.length > MAX_EVENTS_PER_AUDIT_BATCH) {
    methodology.quality_flags = uniqueTruthy([...methodology.quality_flags, "conversation_truncated"]);
    methodology.skipped_checks = uniqueTruthy([
      ...methodology.skipped_checks,
      `Methodology audit was partial: only the first ${MAX_EVENTS_PER_AUDIT_BATCH} of ${ordered.length} conversation events were analyzed.`
    ]);
  }

  const result = await provider.generateStructured(
    "methodology-audit",
    methodologyAuditPrompt(bounded, inputs),
    METHODOLOGY_AUDIT_SCHEMA,
    generateOptions
  );
  if (!result.ok || !isRecord(result.data)) {
    return; // SKIP: degraded keyword fallback + flag preserved
  }
  const data = result.data as MethodologyAuditOutput;

  // Audit path anchors must be CHANGED-file paths (the prompt + feature text say
  // so), not any repo file — so a model citing an existing-but-unchanged file is
  // not stamped valid (Codex P2).
  const changedFiles = new Set(inputs.collection.changedFiles.map((file) => file.path));

  // Item 4a/4b: considered alternatives + research/context, surfaced as labeled
  // hypotheses — but ONLY when their anchors validate (event id / changed path),
  // so a provider's hallucinated research/alternative is not presented as a
  // conversation-derived fact (Codex P2), matching workflow_findings' discipline.
  methodology.considered = uniqueTruthy([
    ...methodology.considered,
    ...groundedAnchoredTexts(data.considered, evidenceContext, changedFiles).map(markHypothesis)
  ]).slice(0, 16);
  methodology.research = uniqueTruthy([
    ...methodology.research,
    ...groundedAnchoredTexts(data.research, evidenceContext, changedFiles).map(markHypothesis)
  ]).slice(0, 16);

  // Item 4c: unchallenged assumptions + skipped steps + workflow soundness +
  // the LLM cross-reference signals -> validated, advisory workflow_findings.
  const findings: WorkflowFinding[] = [];
  let seq = methodology.workflow_findings.length;
  const addFinding = (signalKind: PacketWorkflowSignalKind, item: unknown, severity: PacketSeverity): void => {
    const text = isRecord(item) ? item.text : item;
    findings.push(buildWorkflowFinding((seq += 1), signalKind, text, severity, isRecord(item) ? item.anchors : undefined, evidenceContext, changedFiles));
  };

  for (const item of asArray(data.unchallenged).slice(0, MAX_PROPOSED_REQUIREMENTS)) {
    addFinding("unchallenged_assumption", item, "low");
  }
  const assessment = isRecord(data.workflow_assessment) ? data.workflow_assessment : undefined;
  if (assessment) {
    for (const item of asArray(assessment.skipped_steps).slice(0, MAX_PROPOSED_REQUIREMENTS)) {
      addFinding("skipped_step", item, "medium");
    }
    const soundness = assessment.soundness;
    if (soundness === "questionable" || soundness === "unsound") {
      const summaryText = typeof assessment.summary === "string" ? assessment.summary : `Workflow soundness assessed as ${soundness}.`;
      findings.push(
        buildWorkflowFinding((seq += 1), "workflow_soundness", summaryText, soundness === "unsound" ? "high" : "medium", undefined, evidenceContext, changedFiles)
      );
    }
  }
  for (const flag of asArray(data.cross_ref_flags).slice(0, MAX_PROPOSED_REQUIREMENTS)) {
    if (!isRecord(flag) || typeof flag.signal !== "string" || !CROSS_REF_SIGNALS.has(flag.signal)) {
      continue;
    }
    findings.push(buildWorkflowFinding((seq += 1), flag.signal as PacketWorkflowSignalKind, flag.text, "medium", flag.anchors, evidenceContext, changedFiles));
  }
  methodology.workflow_findings = [...methodology.workflow_findings, ...findings].slice(0, 50);

  // The deep audit RAN: clear the "not run" flag so the cockpit/packet show the
  // real audit instead of the fallback marker.
  methodology.quality_flags = methodology.quality_flags.filter((flag) => flag !== "methodology_analysis_degraded");
}

// Build one advisory (llm_proposed) workflow finding from a leaf item. Every
// cited anchor is validated; an invalid anchor is surfaced in the summary and
// the finding is demoted (never silently dropped), exactly like the intent
// candidate path. A finding with no valid anchor still appears, marked advisory
// with an llm_proposed unknown ref so it can never count as proof.
function buildWorkflowFinding(
  seq: number,
  signalKind: PacketWorkflowSignalKind,
  text: unknown,
  severity: PacketSeverity,
  anchors: unknown,
  context: EvidenceValidationContext,
  changedFiles: Set<string>
): WorkflowFinding {
  const { evidence, invalidTokens } = resolveAuditAnchors(anchors, context, changedFiles);
  const baseText = redactHypothesisText(typeof text === "string" ? text : "").trim() || "(no description provided)";
  const summary = invalidTokens.length > 0 ? `${baseText} (unverified anchor(s): ${invalidTokens.join(", ")})` : baseText;
  return {
    id: `WF-${String(seq).padStart(3, "0")}`,
    signal_kind: signalKind,
    summary: markHypothesis(summary),
    severity,
    advisory: true,
    evidence:
      evidence.length > 0
        ? evidence
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

// Extract the redacted text of each anchored item (string or { text }), keeping
// ONLY items whose anchors validate (a known event id or changed-file path), so
// a hallucinated alternative/research item is not surfaced as a fact.
function groundedAnchoredTexts(value: unknown, context: EvidenceValidationContext, changedFiles: Set<string>): string[] {
  const texts: string[] = [];
  for (const item of asArray(value).slice(0, MAX_PROPOSED_REQUIREMENTS)) {
    const text = redactHypothesisText(isRecord(item) ? (typeof item.text === "string" ? item.text : "") : typeof item === "string" ? item : "").trim();
    if (text === "") {
      continue;
    }
    const { evidence } = resolveAuditAnchors(isRecord(item) ? item.anchors : undefined, context, changedFiles);
    if (evidence.length > 0) {
      texts.push(text);
    }
  }
  return texts;
}

function methodologyAuditPrompt(events: ConversationEvent[], inputs: ReasoningInputs): string {
  const eventLines = events
    .map((event) => {
      const head = `[${event.id}] ${event.actor}/${event.kind}`;
      const tool = event.tool ? ` tool=${event.tool}` : "";
      const file = event.file ? ` file=${event.file}` : "";
      return `${head}${tool}${file}: ${truncateForPrompt(event.summary, 240)}`;
    })
    .join("\n");
  const changedFiles = inputs.collection.changedFiles.slice(0, 30).map((file) => file.path).join("\n") || "(none)";
  return `Return compact JSON only matching the provided schema. You are auditing a coding agent's RAW conversation (messages + tool calls) that produced the diff below. Judge the methodology, citing only event ids and changed-file paths that appear here.

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
