import { CollectionResult } from "../collector/collect";
import { isRecord, numericField, uniqueTruthy } from "../core/guards";
import { llmProposedEvidence } from "../evidence/evidence";
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
import { ClaimedIntentCandidate, IntentModel, IntentRequirement } from "../intent/intent";
import { MethodologyModel } from "../methodology/methodology";
import { RisksModel } from "../risks/risks";
import { buildReviewAreas, createReviewAreaMatcher, ReviewArea } from "../review-areas/areas";
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
  return {
    cwd: inputs.collection.cwd,
    knownPaths,
    knownAcids,
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
// Helpers
// ---------------------------------------------------------------------------

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}
