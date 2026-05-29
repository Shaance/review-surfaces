import { CollectionResult } from "../collector/collect";
import { EvidenceRef, isLlmProposed, llmProposedEvidence } from "../evidence/evidence";
import { EvidenceValidationContext, validateEvidenceRef } from "../evidence/validate";
import { EvaluationModel, RequirementResult, RequirementStatus } from "../evaluation/evaluate";
import { IntentModel, IntentRequirement } from "../intent/intent";
import { MethodologyModel } from "../methodology/methodology";
import { redactSecrets } from "../privacy/secrets";
import { RisksModel } from "../risks/risks";
import { buildReviewAreas, ReviewArea, strictGroupsForReviewPath } from "../review-areas/areas";
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
}

const MAX_PROPOSED_REQUIREMENTS = 5;
const MAX_CANDIDATE_EVIDENCE_PER_REQUIREMENT = 4;
const MAX_GLOBAL_REVIEW_FOCUS = 14;

// Stage A #1: batch the evaluation candidate-evidence call instead of issuing
// one generateStructured call per weak requirement. We still bound the per-call
// payload: very large repos are split into a few bounded batches rather than one
// unbounded prompt.
const MAX_REQUIREMENTS_PER_EVAL_BATCH = 25;

// Stage A #3: a GLOBAL cap on how many LLM-proposed candidate-evidence refs can
// be attached across ALL requirements in a single run. The per-requirement cap
// (MAX_CANDIDATE_EVIDENCE_PER_REQUIREMENT) still applies; this is an additional
// run-wide bound so a large weak repo cannot accrue hundreds of hypotheses. When
// the budget is exhausted, the remaining (lower-priority) requirements simply
// receive no LLM hypotheses and stay exactly as the deterministic layer left
// them.
const MAX_GLOBAL_LLM_EVIDENCE = 40;

// Statuses whose evidence we let the LLM enrich. "satisfied" and
// "invalid_evidence" are never touched.
const ENRICHABLE_STATUSES = new Set<RequirementStatus>(["partial", "missing", "unknown"]);

// LLM-proposed candidate evidence may only ever push a requirement to "partial",
// and only from "missing". Everything else is left exactly as the deterministic
// layer computed it.
const UPGRADEABLE_FROM = new Set<RequirementStatus>(["missing"]);

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
  await runEvaluationCandidateEvidence(provider, inputs, evidenceContext, generateOptions);
  await runNarrativeStage(provider, inputs, generateOptions);
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
 * inputs.risks.review_focus in place.
 */
export async function runEvaluationReasoning(
  provider: ReasoningProvider,
  inputs: ReasoningInputs,
  options: ReasoningOptions = {}
): Promise<void> {
  if (provider.name === "mock") {
    return;
  }
  await runEvaluationCandidateEvidence(provider, inputs, buildEvidenceContext(inputs), toGenerateOptions(options));
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
    candidate_requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          requirement: { type: "string" },
          title: { type: "string" },
          source_ref: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string" },
              path: { type: "string" },
              line_start: { type: "integer", minimum: 1 },
              line_end: { type: "integer", minimum: 1 },
              note: { type: "string" }
            }
          }
        },
        required: ["requirement", "source_ref"]
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

  intent.assumptions = unique([...intent.assumptions, ...proposedAssumptions]).slice(0, 16);
  intent.non_goals = unique([...intent.non_goals, ...proposedNonGoals]).slice(0, 12);
  intent.open_questions = unique([...intent.open_questions, ...proposedQuestions]).slice(0, 12);

  if (typeof data.summary === "string" && data.summary.trim() !== "") {
    intent.summary = `${intent.summary} ${markHypothesis(data.summary.trim())}`;
  }

  // Candidate requirements ONLY when the authoritative spec is sparse/absent
  // (e.g. foreign repos). Each must cite a source ref that validates; drop
  // those that do not. Proposed requirements never carry an acai_id and never
  // reach confidence "high".
  if (sparse) {
    const proposed = buildCandidateRequirements(data.candidate_requirements, intent, evidenceContext);
    if (proposed.length > 0) {
      intent.requirements = [...intent.requirements, ...proposed];
    }
  }
}

function isSparseSpec(intent: IntentModel): boolean {
  const authoritative = intent.requirements.filter((requirement) => !requirement.llm_derived && requirement.acai_id);
  return authoritative.length === 0;
}

function buildCandidateRequirements(
  raw: unknown,
  intent: IntentModel,
  evidenceContext: EvidenceValidationContext
): IntentRequirement[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: IntentRequirement[] = [];
  let counter = intent.requirements.length;
  for (const entry of raw) {
    if (result.length >= MAX_PROPOSED_REQUIREMENTS || !isRecord(entry)) {
      continue;
    }
    // Redact agent/LLM-controlled free text before it can reach intent fields.
    const requirementText = typeof entry.requirement === "string" ? redact(entry.requirement).trim() : "";
    if (requirementText === "") {
      continue;
    }
    const sourceRefRaw = isRecord(entry.source_ref) ? entry.source_ref : undefined;
    if (!sourceRefRaw || typeof sourceRefRaw.path !== "string") {
      continue; // every proposed item MUST cite a source ref
    }
    const candidateEvidence = llmProposedEvidence("file", {
      path: sourceRefRaw.path,
      line_start: numericField(sourceRefRaw.line_start),
      line_end: numericField(sourceRefRaw.line_end),
      note: typeof sourceRefRaw.note === "string" ? redact(sourceRefRaw.note) : "Source cited for proposed requirement.",
      confidence: "low"
    });
    const validated = validateEvidenceRef(candidateEvidence, evidenceContext);
    if (validated.validation_status !== "valid") {
      continue; // drop proposed requirements whose source ref does not validate
    }
    counter += 1;
    result.push({
      id: `REQ-LLM-${String(counter).padStart(3, "0")}`,
      acai_id: undefined, // NEVER fabricate an acai_id
      title: typeof entry.title === "string" ? redact(entry.title) : "LLM-proposed requirement",
      requirement: requirementText,
      source_refs: [
        {
          kind: "file",
          ref: sourceRefRaw.path,
          title: "LLM-proposed source",
          evidence: [validated]
        }
      ],
      constraints: [],
      assumptions: [],
      open_questions: ["LLM-proposed requirement; confirm scope against authoritative intent before relying on it."],
      confidence: "low", // never "high"
      llm_derived: true
    });
  }
  return result;
}

function intentPrompt(inputs: ReasoningInputs, sparse: boolean): string {
  const changedFiles = inputs.collection.changedFiles
    .slice(0, 30)
    .map((file) => `${file.status} ${file.path}`)
    .join("\n");
  const candidateClause = sparse
    ? "The authoritative spec is sparse/absent. You MAY propose up to 5 candidate_requirements, each citing a source_ref with a real repository-relative path. Do not invent ACIDs."
    : "The authoritative spec already has requirements. Do NOT propose candidate_requirements; leave that array empty.";
  return `Return compact JSON only matching the provided schema. Every assumption/non_goal/open_question and any candidate_requirement source_ref MUST cite a real repository file. Do not invent file paths, line numbers, ACIDs, or tests.

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

interface CandidateEvidenceOutput {
  candidate_evidence?: unknown;
  rationale?: unknown;
  what_would_confirm?: unknown;
}

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
  generateOptions: GenerateStructuredOptions
): Promise<void> {
  const candidatePaths = candidatePathPool(inputs.collection);
  // FINDING D (soundness): the review areas used to decide whether a cited path
  // is DETERMINISTICALLY TIED to a requirement's group (mirrors the verification
  // loop's strict group mapping). Pool membership is necessary but NOT sufficient
  // to upgrade missing -> partial; an unrelated pooled path attaches as a
  // hypothesis but does not change status.
  const areas = buildReviewAreas({ repoIndex: inputs.collection.repoIndex }).areas;
  // Collapse the GLOBAL review_focus surface by rationale TEXT (not by
  // requirement id). One LLM hypothesis cited across many requirements becomes a
  // single coherent "N requirements share this LLM hypothesis" line instead of
  // verbose noise repeated verbatim across the most prominent review surface.
  const focusAccumulator = createReviewFocusAccumulator();

  // Stage A #3: rank ALL enrichable requirements weakest-first so that, under
  // the global cap, the requirements with the least deterministic evidence win
  // the limited LLM hypothesis budget. Anything beyond the cap simply receives
  // no hypotheses (still deterministic).
  const enrichable = rankEnrichableRequirements(inputs.evaluation.results);
  if (enrichable.length === 0) {
    return;
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
    return; // no usable batched output
  }

  // Stage A #3: a single run-wide budget shared across requirements. We apply in
  // ranked (weakest-first) order, so when the budget runs out the strongest
  // requirements are the ones left without hypotheses.
  const budget: GlobalEvidenceBudget = { remaining: MAX_GLOBAL_LLM_EVIDENCE };
  for (const result of enrichable) {
    if (budget.remaining <= 0) {
      break; // global cap reached; remaining requirements get no LLM hypotheses
    }
    const entry = lookupBatchedEntry(result, byRequirementId, byAcaiId);
    if (!entry) {
      continue; // the batch returned nothing for this requirement
    }
    applyCandidateEvidence(result, entry, evidenceContext, inputs.risks, candidatePaths, focusAccumulator, budget, areas);
  }
}

/**
 * Stage A #3 ranking: order enrichable requirements weakest-evidence-first so the
 * global cap is spent on the requirements that need help most. Priority:
 * missing > unknown > partial-with-no-test-evidence > other partial. Ties keep
 * the deterministic evaluation order (stable sort).
 */
function rankEnrichableRequirements(results: RequirementResult[]): RequirementResult[] {
  return results
    .filter((result) => ENRICHABLE_STATUSES.has(result.status))
    .map((result, index) => ({ result, index, rank: enrichmentRank(result) }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((entry) => entry.result);
}

function enrichmentRank(result: RequirementResult): number {
  if (result.status === "missing") {
    return 0;
  }
  if (result.status === "unknown") {
    return 1;
  }
  // status === "partial": prefer partial requirements that have NO test evidence
  // yet (weaker) over partial requirements that already cite a test.
  return hasTestEvidence(result) ? 3 : 2;
}

function hasTestEvidence(result: RequirementResult): boolean {
  return result.evidence.some((ref) => ref.kind === "test" && !isLlmProposed(ref));
}

interface GlobalEvidenceBudget {
  remaining: number;
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

function applyCandidateEvidence(
  result: RequirementResult,
  data: CandidateEvidenceOutput,
  evidenceContext: EvidenceValidationContext,
  risks: RisksModel,
  candidatePaths: string[],
  focusAccumulator: ReviewFocusAccumulator,
  budget: GlobalEvidenceBudget,
  areas: ReviewArea[]
): void {
  const rawCandidates = Array.isArray(data.candidate_evidence) ? data.candidate_evidence : [];
  const candidatePathSet = new Set(candidatePaths);
  const validEvidence: EvidenceRef[] = [];
  const invalidEvidence: EvidenceRef[] = [];

  for (const entry of rawCandidates.slice(0, MAX_CANDIDATE_EVIDENCE_PER_REQUIREMENT)) {
    if (!isRecord(entry) || typeof entry.path !== "string") {
      continue;
    }
    const kind = entry.kind === "test" ? "test" : "file";
    const candidate = llmProposedEvidence(kind, {
      path: entry.path,
      line_start: numericField(entry.line_start),
      line_end: numericField(entry.line_end),
      test_name: typeof entry.test_name === "string" ? redact(entry.test_name) : undefined,
      // Redact agent/LLM-controlled free text before it reaches the evidence note.
      note: typeof entry.note === "string" ? redact(entry.note) : "Candidate evidence for this requirement.",
      confidence: kind === "test" ? "medium" : "low"
    });
    // Gate on the candidate pool BEFORE deterministic validation. The pool is the
    // changed files + tests actually offered for this requirement; a real repo
    // file that is NOT in the pool (e.g. an unrelated source file the model
    // cited) must never attach as proof or drive a missing -> partial upgrade.
    // Path-existence alone is insufficient: it would let any real file inflate
    // arbitrary unrelated requirements. Refs outside the pool are surfaced as
    // invalid so a reviewer can see the rejected hypothesis.
    if (!candidatePathSet.has(normalizeCandidatePath(entry.path))) {
      invalidEvidence.push({
        ...candidate,
        validation_status: "invalid",
        note: appendOutOfPoolNote(candidate.note)
      });
      continue;
    }
    // Validate EVERY candidate ref via the same deterministic validator the
    // evaluation layer uses. Invalid refs can NEVER upgrade status.
    const validated = validateEvidenceRef(candidate, evidenceContext);
    if (validated.validation_status === "valid") {
      validEvidence.push(validated);
    } else {
      invalidEvidence.push(validated);
    }
  }

  // Surface invalid candidate refs as invalid_evidence on the requirement so a
  // reviewer can see the rejected hypothesis; never let them upgrade status.
  if (invalidEvidence.length > 0) {
    result.missing_evidence = [...result.missing_evidence, ...invalidEvidence];
  }

  if (validEvidence.length === 0) {
    enrichReviewFocus(result, data, risks, false, focusAccumulator);
    return;
  }

  // Attach valid, clearly-marked hypotheses. De-duplicate against existing refs
  // AND respect the run-wide global cap (Stage A #3): never attach more
  // llm_proposed evidence than the remaining global budget, and decrement the
  // budget for each ref actually attached. Duplicates do not consume budget.
  const existingKeys = new Set(result.evidence.map(evidenceKey));
  const attached: EvidenceRef[] = [];
  for (const ref of validEvidence) {
    if (budget.remaining <= 0) {
      break; // global cap reached mid-requirement; stop attaching hypotheses
    }
    const key = evidenceKey(ref);
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      result.evidence.push(ref);
      attached.push(ref);
      budget.remaining -= 1;
    }
  }

  // FINDING D (soundness + --strict): missing -> partial may fire ONLY when at
  // least one ATTACHED valid ref is DETERMINISTICALLY TIED to THIS requirement
  // (mirrors the verification-loop per-requirement mapping rule). Pool membership
  // + path-existence alone is NOT enough: an agent/LLM could otherwise cite any
  // unrelated changed/test file, drop the missing count, and help --strict skip
  // the quality gate (which counts missing). A pooled-but-unrelated ref still
  // attaches as a low-confidence llm_proposed hypothesis (above), but the status
  // stays missing so the gate is never bypassed by an unrelated citation.
  const tiedEvidence = attached.filter((ref) => isDeterministicallyTied(result, ref, areas));
  const upgraded = maybeUpgradeToPartial(result, tiedEvidence);
  enrichReviewFocus(result, data, risks, upgraded, focusAccumulator);
}

// Whether an LLM-proposed (but VALID, in-pool) candidate ref is deterministically
// tied to THIS requirement, using the SAME mapping rules the verification loop
// trusts for promotion:
//   (a) EXACT-ACID: the ref's path or test_name references the requirement's
//       exact ACID (e.g. contains "review-surfaces.EVAL.1"). OR
//   (b) GROUP/TEST MAPPING: the ref's path maps to the requirement's group under
//       the STRICT review-area mapping (true directory prefixes + whole-token
//       test keywords, never a stray substring).
// A ref that satisfies neither is a pooled-but-unrelated hypothesis: it attaches
// but does NOT move the status.
function isDeterministicallyTied(result: RequirementResult, ref: EvidenceRef, areas: ReviewArea[]): boolean {
  if (result.acai_id && refReferencesAcid(ref, result.acai_id)) {
    return true;
  }
  const group = groupFromAcid(result.acai_id);
  if (!group || typeof ref.path !== "string") {
    return false;
  }
  return strictGroupsForReviewPath(ref.path, areas).includes(group);
}

function refReferencesAcid(ref: EvidenceRef, acaiId: string): boolean {
  const haystack = [ref.path, ref.test_name, ref.note].filter((part): part is string => typeof part === "string");
  return haystack.some((part) => part.includes(acaiId));
}

function groupFromAcid(acaiId: string | undefined): string | undefined {
  return acaiId?.split(".")[1];
}

function maybeUpgradeToPartial(result: RequirementResult, validEvidence: EvidenceRef[]): boolean {
  if (!UPGRADEABLE_FROM.has(result.status)) {
    return false;
  }
  if (validEvidence.length === 0) {
    return false;
  }
  result.status = "partial";
  result.confidence = "low";
  result.summary =
    "Status raised to partial by an LLM-proposed candidate evidence hypothesis; deterministic proof is still required.";
  return true;
}

function enrichReviewFocus(
  result: RequirementResult,
  data: CandidateEvidenceOutput,
  risks: RisksModel,
  upgraded: boolean,
  focusAccumulator: ReviewFocusAccumulator
): void {
  const rationale = typeof data.rationale === "string" ? data.rationale.trim() : "";
  const whatWouldConfirm = typeof data.what_would_confirm === "string" ? data.what_would_confirm.trim() : "";
  const fragments: string[] = [];
  if (rationale !== "") {
    fragments.push(`rationale: ${rationale}`);
  }
  if (whatWouldConfirm !== "") {
    fragments.push(`what would confirm: ${whatWouldConfirm}`);
  }
  if (fragments.length === 0) {
    return;
  }
  // Per-requirement review_focus keeps the full hypothesis text: it is scoped to
  // one requirement, so it is context, not noise.
  const focusNote = markHypothesis(fragments.join("; "));
  result.review_focus = `${result.review_focus} ${focusNote}`.trim();

  // The GLOBAL "where do I look first" surface de-duplicates by rationale TEXT.
  // The same hypothesis cited across many requirements collapses into a single
  // line listing the affected requirements, rather than one verbatim entry per
  // requirement id.
  recordGlobalReviewFocus(focusAccumulator, risks, {
    label: result.acai_id ?? result.requirement_id,
    upgraded,
    text: fragments.join("; ")
  });
}

// ---------------------------------------------------------------------------
// Global review_focus accumulator: collapse by rationale TEXT, not requirement.
// ---------------------------------------------------------------------------

interface ReviewFocusEntry {
  index: number; // position of this entry's line in risks.review_focus
  labels: string[]; // requirement labels sharing this rationale (deduped, ordered)
  anyUpgraded: boolean;
}

interface ReviewFocusAccumulator {
  byText: Map<string, ReviewFocusEntry>;
}

function createReviewFocusAccumulator(): ReviewFocusAccumulator {
  return { byText: new Map() };
}

function recordGlobalReviewFocus(
  accumulator: ReviewFocusAccumulator,
  risks: RisksModel,
  note: { label: string; upgraded: boolean; text: string }
): void {
  const existing = accumulator.byText.get(note.text);
  if (existing) {
    // Same hypothesis text already surfaced: fold this requirement into the
    // shared line instead of appending a near-identical duplicate.
    if (!existing.labels.includes(note.label)) {
      existing.labels.push(note.label);
    }
    existing.anyUpgraded = existing.anyUpgraded || note.upgraded;
    risks.review_focus[existing.index] = renderGlobalReviewFocusLine(existing, note.text);
    return;
  }

  // First time we see this hypothesis text. Respect the global cap; once we hit
  // it, drop further distinct hypotheses rather than unbounded growth.
  if (risks.review_focus.length >= MAX_GLOBAL_REVIEW_FOCUS) {
    return;
  }
  const entry: ReviewFocusEntry = {
    index: risks.review_focus.length,
    labels: [note.label],
    anyUpgraded: note.upgraded
  };
  accumulator.byText.set(note.text, entry);
  risks.review_focus.push(renderGlobalReviewFocusLine(entry, note.text));
}

function renderGlobalReviewFocusLine(entry: ReviewFocusEntry, text: string): string {
  const upgradeTag = entry.anyUpgraded ? " (raised to partial)" : "";
  if (entry.labels.length === 1) {
    return markHypothesis(`${entry.labels[0]}${upgradeTag}: ${text}`);
  }
  // Collapse repeated identical rationales into one shared line.
  const shown = entry.labels.slice(0, 6);
  const more = entry.labels.length - shown.length;
  const labelList = more > 0 ? `${shown.join(", ")}, +${more} more` : shown.join(", ");
  return markHypothesis(
    `${entry.labels.length} requirements share this hypothesis (${labelList})${upgradeTag}: ${text}`
  );
}

function candidatePathPool(collection: CollectionResult): string[] {
  return unique([
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
  methodology.considered = unique([...methodology.considered, ...consideredAdditions]).slice(0, 16);
  methodology.decisions = unique([...methodology.decisions, ...decisionsAdditions]).slice(0, 16);

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

const HYPOTHESIS_PREFIX = "LLM-proposed:";

// Agent-file/LLM-returned strings reach the packet through the reasoning stages,
// NOT only through provider.ts mergeEnrichment. A local --agent-input file (or a
// remote model echo) can carry a token/API key, so EVERY such string must pass
// through redactSecrets before it is written into intent/methodology/risk fields.
// This mirrors the redaction boundary in provider.ts and keeps raw secrets out of
// review_packet.json / the YAML artifacts. markHypothesis is the single funnel
// every narrative/hypothesis string flows through, so redaction lives here.
function redact(value: string): string {
  return redactSecrets(value).text;
}

function markHypothesis(value: string): string {
  const trimmed = redact(value).trim();
  if (trimmed === "") {
    return trimmed;
  }
  return trimmed.startsWith(HYPOTHESIS_PREFIX) ? trimmed : `${HYPOTHESIS_PREFIX} ${trimmed}`;
}

function evidenceKey(ref: EvidenceRef): string {
  return `${ref.kind}:${ref.path ?? ""}:${ref.line_start ?? ""}:${ref.line_end ?? ""}:${ref.acai_id ?? ""}:${isLlmProposed(ref) ? "llm" : "det"}`;
}

function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Normalize a cited path the same way the evidence validator does (strip
// backslashes + leading "./") so candidate-pool membership is robust to the
// model citing "./src/x.ts" vs "src/x.ts".
function normalizeCandidatePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function appendOutOfPoolNote(note: string | undefined): string {
  const suffix = "Invalid evidence: path is not in the candidate pool (changed files + tests) offered for this requirement.";
  return note ? `${note} ${suffix}` : suffix;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
