import { isRecord, numericField } from "../core/guards";
import { EvidenceRef, isLlmProposed, llmProposedEvidence } from "../evidence/evidence";
import { markHypothesis, redactHypothesisText } from "../evidence/hypothesis";
import { EvidenceValidationContext, normalizeEvidencePath, validateEvidenceRef } from "../evidence/validate";
import type { ReviewAreaMatcher } from "../review-areas/areas";
import type { RequirementResult, RequirementStatus } from "./evaluate";
import { groupFromAcid } from "./evidence-rules";

// Applies schema-bound LLM candidate evidence to evaluation results. This module
// intentionally has no provider or RisksModel dependency: the LLM layer supplies
// parsed candidate entries, and callers append the returned review-focus delta to
// whatever risk model is current after verification.

export interface CandidateEvidenceOutput {
  candidate_evidence?: unknown;
  rationale?: unknown;
  what_would_confirm?: unknown;
}

export interface CandidateEvidenceApplication {
  review_focus: string[];
}

export interface CandidateEvidenceEntry {
  result: RequirementResult;
  data: CandidateEvidenceOutput;
}

export interface CandidateEvidenceApplyOptions {
  evidenceContext: EvidenceValidationContext;
  candidatePaths: string[];
  matcher: ReviewAreaMatcher;
  // Existing deterministic review-focus entries count against the global cap, but
  // this module only owns the LLM-produced delta it returns.
  initialReviewFocusCount?: number;
}

const MAX_CANDIDATE_EVIDENCE_PER_REQUIREMENT = 4;
const MAX_GLOBAL_REVIEW_FOCUS = 14;
const MAX_GLOBAL_LLM_EVIDENCE = 40;

const ENRICHABLE_STATUSES = new Set<RequirementStatus>(["partial", "missing", "unknown"]);
const UPGRADEABLE_FROM = new Set<RequirementStatus>(["missing"]);

export function rankEnrichableRequirements(results: RequirementResult[]): RequirementResult[] {
  return results
    .filter((result) => ENRICHABLE_STATUSES.has(result.status))
    .map((result, index) => ({ result, index, rank: enrichmentRank(result) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.result);
}

export function applyCandidateEvidenceEntries(
  entries: CandidateEvidenceEntry[],
  options: CandidateEvidenceApplyOptions
): CandidateEvidenceApplication {
  const reviewFocus: string[] = [];
  const focusAccumulator = createReviewFocusAccumulator(options.initialReviewFocusCount ?? 0);
  const budget: GlobalEvidenceBudget = { remaining: MAX_GLOBAL_LLM_EVIDENCE };
  const candidatePathSet = new Set(options.candidatePaths.map(normalizeEvidencePath));

  for (const entry of entries) {
    if (budget.remaining <= 0) {
      break;
    }
    applyCandidateEvidence(
      entry.result,
      entry.data,
      options.evidenceContext,
      candidatePathSet,
      focusAccumulator,
      budget,
      options.matcher,
      reviewFocus
    );
  }

  return { review_focus: reviewFocus };
}

export function appendCandidateReviewFocus(target: string[], delta: string[]): void {
  const remaining = Math.max(0, MAX_GLOBAL_REVIEW_FOCUS - target.length);
  if (remaining > 0) {
    target.push(...delta.slice(0, remaining));
  }
}

function enrichmentRank(result: RequirementResult): number {
  if (result.status === "missing") {
    return 0;
  }
  if (result.status === "unknown") {
    return 1;
  }
  return hasTestEvidence(result) ? 3 : 2;
}

function hasTestEvidence(result: RequirementResult): boolean {
  return result.evidence.some((ref) => ref.kind === "test" && !isLlmProposed(ref));
}

interface GlobalEvidenceBudget {
  remaining: number;
}

function applyCandidateEvidence(
  result: RequirementResult,
  data: CandidateEvidenceOutput,
  evidenceContext: EvidenceValidationContext,
  candidatePathSet: Set<string>,
  focusAccumulator: ReviewFocusAccumulator,
  budget: GlobalEvidenceBudget,
  matcher: ReviewAreaMatcher,
  reviewFocus: string[]
): void {
  const rawCandidates = Array.isArray(data.candidate_evidence) ? data.candidate_evidence : [];
  const validEvidence: EvidenceRef[] = [];
  const outOfPoolEvidence: EvidenceRef[] = [];
  const genuinelyInvalidEvidence: EvidenceRef[] = [];

  for (const entry of rawCandidates.slice(0, MAX_CANDIDATE_EVIDENCE_PER_REQUIREMENT)) {
    if (!isRecord(entry) || typeof entry.path !== "string") {
      continue;
    }
    const kind = entry.kind === "test" ? "test" : "file";
    const candidate = llmProposedEvidence(kind, {
      path: entry.path,
      line_start: numericField(entry.line_start),
      line_end: numericField(entry.line_end),
      test_name: typeof entry.test_name === "string" ? redactHypothesisText(entry.test_name) : undefined,
      note: typeof entry.note === "string" ? redactHypothesisText(entry.note) : "Candidate evidence for this requirement.",
      confidence: kind === "test" ? "medium" : "low"
    });

    if (!candidatePathSet.has(normalizeEvidencePath(entry.path))) {
      outOfPoolEvidence.push({
        ...candidate,
        validation_status: "invalid",
        note: appendOutOfPoolNote(candidate.note)
      });
      continue;
    }

    const validated = validateEvidenceRef(candidate, evidenceContext);
    if (validated.validation_status === "valid") {
      validEvidence.push(validated);
    } else {
      genuinelyInvalidEvidence.push(validated);
    }
  }

  const allInvalid = [...outOfPoolEvidence, ...genuinelyInvalidEvidence];
  if (allInvalid.length > 0) {
    result.missing_evidence = [...result.missing_evidence, ...allInvalid];
  }

  if (genuinelyInvalidEvidence.length > 0 && !hasValidDeterministicEvidence(result)) {
    markInvalidEvidence(result);
  }

  if (validEvidence.length === 0) {
    enrichReviewFocus(result, data, false, focusAccumulator, reviewFocus);
    return;
  }

  const existingKeys = new Set(result.evidence.map(evidenceKey));
  const attached: EvidenceRef[] = [];
  for (const ref of validEvidence) {
    if (budget.remaining <= 0) {
      break;
    }
    const key = evidenceKey(ref);
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      result.evidence.push(ref);
      attached.push(ref);
      budget.remaining -= 1;
    }
  }

  const tiedEvidence = attached.filter((ref) => isDeterministicallyTied(result, ref, matcher));
  const upgraded = maybeUpgradeToPartial(result, tiedEvidence);
  enrichReviewFocus(result, data, upgraded, focusAccumulator, reviewFocus);
}

function isDeterministicallyTied(result: RequirementResult, ref: EvidenceRef, matcher: ReviewAreaMatcher): boolean {
  if (result.acai_id && refReferencesAcid(ref, result.acai_id)) {
    return true;
  }
  const group = groupFromAcid(result.acai_id);
  if (!group || typeof ref.path !== "string") {
    return false;
  }
  return matcher.groupsForPath(ref.path, { purpose: "requirement_proof" }).includes(group);
}

function refReferencesAcid(ref: EvidenceRef, acaiId: string): boolean {
  const haystack = [ref.path, ref.test_name, ref.note].filter((part): part is string => typeof part === "string");
  return haystack.some((part) => part.includes(acaiId));
}

const SOURCE_ONLY_EVIDENCE_KINDS = new Set<EvidenceRef["kind"]>(["spec", "doc"]);

function hasValidDeterministicEvidence(result: RequirementResult): boolean {
  return result.evidence.some(
    (ref) =>
      !isLlmProposed(ref) &&
      ref.validation_status === "valid" &&
      !SOURCE_ONLY_EVIDENCE_KINDS.has(ref.kind)
  );
}

function markInvalidEvidence(result: RequirementResult): void {
  if (result.status === "invalid_evidence") {
    return;
  }
  result.status = "invalid_evidence";
  result.partial_reason = undefined;
  result.summary = "One or more LLM-proposed evidence references failed deterministic validation.";
  result.review_focus = "Inspect invalid evidence references before judging requirement coverage.";
  result.confidence = "high";
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
  upgraded: boolean,
  focusAccumulator: ReviewFocusAccumulator,
  reviewFocus: string[]
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

  const focusNote = markHypothesis(fragments.join("; "));
  result.review_focus = `${result.review_focus} ${focusNote}`.trim();
  recordGlobalReviewFocus(focusAccumulator, reviewFocus, {
    label: result.acai_id ?? result.requirement_id,
    upgraded,
    text: fragments.join("; ")
  });
}

interface ReviewFocusEntry {
  index: number;
  labels: string[];
  anyUpgraded: boolean;
}

interface ReviewFocusAccumulator {
  byText: Map<string, ReviewFocusEntry>;
  initialCount: number;
}

function createReviewFocusAccumulator(initialCount: number): ReviewFocusAccumulator {
  return { byText: new Map(), initialCount };
}

function recordGlobalReviewFocus(
  accumulator: ReviewFocusAccumulator,
  reviewFocus: string[],
  note: { label: string; upgraded: boolean; text: string }
): void {
  const existing = accumulator.byText.get(note.text);
  if (existing) {
    if (!existing.labels.includes(note.label)) {
      existing.labels.push(note.label);
    }
    existing.anyUpgraded = existing.anyUpgraded || note.upgraded;
    reviewFocus[existing.index] = renderGlobalReviewFocusLine(existing, note.text);
    return;
  }

  if (accumulator.initialCount + reviewFocus.length >= MAX_GLOBAL_REVIEW_FOCUS) {
    return;
  }
  const entry: ReviewFocusEntry = {
    index: reviewFocus.length,
    labels: [note.label],
    anyUpgraded: note.upgraded
  };
  accumulator.byText.set(note.text, entry);
  reviewFocus.push(renderGlobalReviewFocusLine(entry, note.text));
}

function renderGlobalReviewFocusLine(entry: ReviewFocusEntry, text: string): string {
  const upgradeTag = entry.anyUpgraded ? " (raised to partial)" : "";
  if (entry.labels.length === 1) {
    return markHypothesis(`${entry.labels[0]}${upgradeTag}: ${text}`);
  }
  const shown = entry.labels.slice(0, 6);
  const more = entry.labels.length - shown.length;
  const labelList = more > 0 ? `${shown.join(", ")}, +${more} more` : shown.join(", ");
  return markHypothesis(`${entry.labels.length} requirements share this hypothesis (${labelList})${upgradeTag}: ${text}`);
}

function evidenceKey(ref: EvidenceRef): string {
  return `${ref.kind}:${ref.path ?? ""}:${ref.line_start ?? ""}:${ref.line_end ?? ""}:${ref.acai_id ?? ""}:${isLlmProposed(ref) ? "llm" : "det"}`;
}

function appendOutOfPoolNote(note: string | undefined): string {
  const suffix = "Invalid evidence: path is not in the candidate pool (changed files + tests) offered for this requirement.";
  return note ? `${note} ${suffix}` : suffix;
}
