import fs from "node:fs";
import path from "node:path";
import { fileExists } from "../core/files";
import { isRecord } from "../core/guards";
import { parseYaml } from "../core/simple-yaml";
import { EvidenceRef, SourceRef } from "../evidence/evidence";
import { EvaluationModel, RequirementResult } from "../evaluation/evaluate";
import { DogfoodModel } from "../dogfood/dogfood";
import { CountDelta, PacketComparison } from "../dogfood/compare";
import { IntentModel, IntentRequirement } from "../intent/intent";
import { MethodologyModel } from "../methodology/methodology";
import { RiskItem, RisksModel } from "../risks/risks";
import {
  PACKET_COMPARISON_DIRECTIONS,
  PACKET_CONFIDENCE_LEVELS,
  PACKET_DOGFOOD_CATEGORIES,
  PACKET_DOGFOOD_SEVERITIES,
  PACKET_EVIDENCE_KINDS,
  PACKET_HELPFULNESS_VALUES,
  PACKET_PARTIAL_REASONS,
  PACKET_REMEDIATION_TYPES,
  PACKET_REQUIREMENT_STATUSES,
  PACKET_RISK_CATEGORIES,
  PACKET_RISK_DETECTABILITY,
  PACKET_RISK_LIKELIHOODS,
  PACKET_RISK_SEVERITIES,
  PACKET_SOURCE_KINDS,
  PACKET_TEST_EVIDENCE_KINDS,
  PACKET_VALIDATION_STATUSES
} from "../schema/review-packet-contract";

/**
 * Phase 4a artifact loaders.
 *
 * Each loader parses a prior-stage YAML artifact written under --out by an
 * earlier subcommand invocation back into its in-memory model, applying light
 * normalization (coerce enums/numbers, default missing arrays) so a model
 * reconstructed from disk matches what the stage builder would have produced.
 *
 * Loaders return null when the artifact is absent or unparseable so the caller
 * can fall back to recomputing the stage. Reusing a successfully-loaded artifact
 * is what lets a subagent run `intent` and later `evaluate`, with evaluate
 * reading the prior intent.yaml instead of recomputing it.
 */

export function loadIntent(outputDir: string): IntentModel | null {
  const parsed = readArtifact(outputDir, "intent.yaml");
  if (!isRecord(parsed)) {
    return null;
  }
  return {
    summary: asString(parsed.summary),
    // review-surfaces.COLD_START.4: round-trip; a legacy artifact without the
    // field infers its mode from the requirement count it actually carries, so
    // a reused spec-less intent.yaml cannot flip back to Acai mode.
    spec_mode: parsed.spec_mode === "none" || (parsed.spec_mode === undefined && asArray(parsed.requirements).length === 0) ? "none" : "acai",
    requirements: asArray(parsed.requirements).map(normalizeRequirement),
    constraints: asStringArray(parsed.constraints),
    non_goals: asStringArray(parsed.non_goals),
    assumptions: asStringArray(parsed.assumptions),
    open_questions: asStringArray(parsed.open_questions),
    sources: asArray(parsed.sources).map(normalizeSourceRef),
    // review-surfaces.INTENT.7: provider candidates must round-trip through the
    // artifact loader, or a reused intent.yaml would silently drop them.
    ...(Array.isArray(parsed.claimed_candidates) && parsed.claimed_candidates.length > 0
      ? {
          claimed_candidates: asArray(parsed.claimed_candidates)
            .filter(isRecord)
            .map((candidate) => ({
              id: asString(candidate.id),
              statement: asString(candidate.statement),
              anchors: asStringArray(candidate.anchors),
              confidence: candidate.confidence === "medium" ? ("medium" as const) : ("low" as const),
              trust: "claimed" as const
            }))
        }
      : {})
  };
}

export function loadEvaluation(outputDir: string): EvaluationModel | null {
  const parsed = readArtifact(outputDir, "evaluation.yaml");
  if (!isRecord(parsed)) {
    return null;
  }
  return {
    summary: asString(parsed.summary),
    results: asArray(parsed.results).map(normalizeRequirementResult),
    overreach: asArray(parsed.overreach).map(normalizeRequirementResult),
    acai_coverage: asStringRecord(parsed.acai_coverage)
  };
}

export function loadMethodology(outputDir: string): MethodologyModel | null {
  const parsed = readArtifact(outputDir, "methodology.yaml");
  if (!isRecord(parsed)) {
    return null;
  }
  return {
    summary: asString(parsed.summary),
    missing_logs: parsed.missing_logs === true,
    considered: asStringArray(parsed.considered),
    research: asStringArray(parsed.research),
    decisions: asStringArray(parsed.decisions),
    unchallenged_assumptions: asStringArray(parsed.unchallenged_assumptions),
    skipped_checks: asStringArray(parsed.skipped_checks),
    claims_without_evidence: asStringArray(parsed.claims_without_evidence),
    verified_claims: asStringArray(parsed.verified_claims),
    quality_flags: asStringArray(parsed.quality_flags),
    evidence: asArray(parsed.evidence).map(normalizeEvidenceRef)
  };
}

export function loadRisks(outputDir: string): RisksModel | null {
  const parsed = readArtifact(outputDir, "risks.yaml");
  if (!isRecord(parsed)) {
    return null;
  }
  const testGaps = asArray(parsed.test_gaps).map(normalizeTestGap);
  return {
    summary: asString(parsed.summary),
    items: asArray(parsed.items).map(normalizeRiskItem),
    test_evidence: asArray(parsed.test_evidence).map(normalizeTestEvidence),
    test_gaps: testGaps,
    missing_automatic_tests:
      parsed.missing_automatic_tests === undefined
        ? missingAutomaticTestsFromGaps(testGaps)
        : asArray(parsed.missing_automatic_tests).map(normalizeMissingAutomaticTest),
    missing_manual_checks:
      parsed.missing_manual_checks === undefined
        ? missingManualChecksFromGaps(testGaps)
        : asArray(parsed.missing_manual_checks).map(normalizeMissingManualCheck),
    review_focus: asStringArray(parsed.review_focus)
  };
}

export function loadDogfood(outputDir: string): DogfoodModel | null {
  const parsed = readArtifact(outputDir, "dogfood.yaml");
  if (!isRecord(parsed)) {
    return null;
  }
  return {
    milestone: asString(parsed.milestone) || "MVP",
    command: optionalString(parsed.command),
    summary: asString(parsed.summary),
    previous_packet_path: optionalString(parsed.previous_packet_path),
    comparison: normalizeComparison(parsed.comparison),
    helped_agent: asEnum(parsed.helped_agent, PACKET_HELPFULNESS_VALUES),
    helped_reviewer: asEnum(parsed.helped_reviewer, PACKET_HELPFULNESS_VALUES),
    findings: asArray(parsed.findings).map(normalizeDogfoodFinding),
    remediation_tasks: asArray(parsed.remediation_tasks).map(normalizeRemediation),
    deferrals: asStringArray(parsed.deferrals)
  };
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeRequirement(value: unknown): IntentRequirement {
  const record = isRecord(value) ? value : {};
  return {
    id: asString(record.id),
    acai_id: optionalString(record.acai_id),
    title: optionalString(record.title),
    requirement: asString(record.requirement),
    source_refs: asArray(record.source_refs).map(normalizeSourceRef),
    constraints: asStringArray(record.constraints),
    assumptions: asStringArray(record.assumptions),
    open_questions: asStringArray(record.open_questions),
    confidence: asEnum(record.confidence, PACKET_CONFIDENCE_LEVELS) ?? "unknown",
    llm_derived: record.llm_derived === true ? true : undefined
  };
}

function normalizeRequirementResult(value: unknown): RequirementResult {
  const record = isRecord(value) ? value : {};
  const status = asEnum(record.status, PACKET_REQUIREMENT_STATUSES) ?? "unknown";
  // partial_reason is only meaningful for partial results; carry it through
  // round-trips so loaded evaluations match a monolithic `all` run.
  const partialReason = status === "partial" ? asEnum(record.partial_reason, PACKET_PARTIAL_REASONS) : undefined;
  return {
    requirement_id: asString(record.requirement_id),
    acai_id: optionalString(record.acai_id),
    status,
    summary: asString(record.summary),
    ...(partialReason ? { partial_reason: partialReason } : {}),
    evidence: asArray(record.evidence).map(normalizeEvidenceRef),
    missing_evidence: asArray(record.missing_evidence).map(normalizeEvidenceRef),
    review_focus: asString(record.review_focus),
    confidence: asEnum(record.confidence, PACKET_CONFIDENCE_LEVELS) ?? "unknown"
  };
}

function normalizeSourceRef(value: unknown): SourceRef {
  const record = isRecord(value) ? value : {};
  return {
    kind: asEnum(record.kind, PACKET_SOURCE_KINDS) ?? "unknown",
    ref: asString(record.ref),
    title: optionalString(record.title),
    evidence: record.evidence === undefined ? undefined : asArray(record.evidence).map(normalizeEvidenceRef)
  };
}

function normalizeEvidenceRef(value: unknown): EvidenceRef {
  const record = isRecord(value) ? value : {};
  const ref: EvidenceRef = {
    kind: asEnum(record.kind, PACKET_EVIDENCE_KINDS) ?? "unknown",
    path: optionalString(record.path),
    line_start: optionalNumber(record.line_start),
    line_end: optionalNumber(record.line_end),
    sha: optionalString(record.sha),
    url: optionalString(record.url),
    acai_id: optionalString(record.acai_id),
    event_id: optionalString(record.event_id),
    test_name: optionalString(record.test_name),
    command: optionalString(record.command),
    excerpt_hash: optionalString(record.excerpt_hash),
    note: optionalString(record.note),
    confidence: asEnum(record.confidence, PACKET_CONFIDENCE_LEVELS) ?? "unknown",
    validation_status: asEnum(record.validation_status, PACKET_VALIDATION_STATUSES),
    llm_proposed: record.llm_proposed === true ? true : undefined,
    verified: record.verified === true ? true : undefined
  };
  return ref;
}

function normalizeRiskItem(value: unknown): RiskItem {
  const record = isRecord(value) ? value : {};
  return {
    id: asString(record.id),
    category: asEnum(record.category, PACKET_RISK_CATEGORIES) ?? "unknown",
    severity: asEnum(record.severity, PACKET_RISK_SEVERITIES) ?? "unknown",
    likelihood: asEnum(record.likelihood, PACKET_RISK_LIKELIHOODS),
    detectability: asEnum(record.detectability, PACKET_RISK_DETECTABILITY),
    summary: asString(record.summary),
    impact: optionalString(record.impact),
    evidence: record.evidence === undefined ? undefined : asArray(record.evidence).map(normalizeEvidenceRef),
    suggested_checks: record.suggested_checks === undefined ? undefined : asStringArray(record.suggested_checks),
    manual_review: record.manual_review === true ? true : record.manual_review === false ? false : undefined
  };
}

function normalizeTestEvidence(value: unknown): RisksModel["test_evidence"][number] {
  const record = isRecord(value) ? value : {};
  return {
    id: asString(record.id),
    kind: asEnum(record.kind, PACKET_TEST_EVIDENCE_KINDS) ?? "unknown",
    summary: asString(record.summary),
    requirement_ids: record.requirement_ids === undefined ? undefined : asStringArray(record.requirement_ids),
    evidence: record.evidence === undefined ? undefined : asArray(record.evidence).map(normalizeEvidenceRef)
  };
}

function normalizeTestGap(value: unknown): RisksModel["test_gaps"][number] {
  const record = isRecord(value) ? value : {};
  return {
    id: asString(record.id),
    requirement_id: optionalString(record.requirement_id),
    acai_id: optionalString(record.acai_id),
    summary: asString(record.summary),
    suggested_test: optionalString(record.suggested_test),
    manual_check: optionalString(record.manual_check),
    evidence: record.evidence === undefined ? undefined : asArray(record.evidence).map(normalizeEvidenceRef)
  };
}

function normalizeMissingAutomaticTest(value: unknown): NonNullable<RisksModel["missing_automatic_tests"]>[number] {
  const record = isRecord(value) ? value : {};
  return {
    id: asString(record.id),
    requirement_id: optionalString(record.requirement_id),
    acai_id: optionalString(record.acai_id),
    summary: asString(record.summary),
    suggested_test: asString(record.suggested_test),
    evidence: record.evidence === undefined ? undefined : asArray(record.evidence).map(normalizeEvidenceRef)
  };
}

function normalizeMissingManualCheck(value: unknown): NonNullable<RisksModel["missing_manual_checks"]>[number] {
  const record = isRecord(value) ? value : {};
  return {
    id: asString(record.id),
    requirement_id: optionalString(record.requirement_id),
    acai_id: optionalString(record.acai_id),
    summary: asString(record.summary),
    manual_check: asString(record.manual_check),
    evidence: record.evidence === undefined ? undefined : asArray(record.evidence).map(normalizeEvidenceRef)
  };
}

function missingAutomaticTestsFromGaps(
  gaps: RisksModel["test_gaps"]
): NonNullable<RisksModel["missing_automatic_tests"]> {
  return gaps
    .filter((gap) => gap.suggested_test)
    .map((gap, index) => ({
      id: `AUTO-${String(index + 1).padStart(3, "0")}`,
      requirement_id: gap.requirement_id,
      acai_id: gap.acai_id,
      summary: `Missing automatic test for ${gap.acai_id ?? gap.requirement_id ?? gap.id}.`,
      suggested_test: gap.suggested_test as string,
      evidence: gap.evidence
    }));
}

function missingManualChecksFromGaps(gaps: RisksModel["test_gaps"]): NonNullable<RisksModel["missing_manual_checks"]> {
  return gaps
    .filter((gap) => gap.manual_check)
    .map((gap, index) => ({
      id: `MANUAL-${String(index + 1).padStart(3, "0")}`,
      requirement_id: gap.requirement_id,
      acai_id: gap.acai_id,
      summary: `Missing manual review check for ${gap.acai_id ?? gap.requirement_id ?? gap.id}.`,
      manual_check: gap.manual_check as string,
      evidence: gap.evidence
    }));
}

function normalizeDogfoodFinding(value: unknown): DogfoodModel["findings"][number] {
  const record = isRecord(value) ? value : {};
  const remediation = isRecord(record.remediation) ? normalizeRemediation(record.remediation) : undefined;
  return {
    id: asString(record.id),
    category: asEnum(record.category, PACKET_DOGFOOD_CATEGORIES) ?? "unknown",
    severity: asEnum(record.severity, PACKET_DOGFOOD_SEVERITIES) ?? "unknown",
    packet_section: optionalString(record.packet_section),
    finding: asString(record.finding),
    impact: optionalString(record.impact),
    evidence: record.evidence === undefined ? undefined : asArray(record.evidence).map(normalizeEvidenceRef),
    remediation
  };
}

function normalizeRemediation(value: unknown): NonNullable<DogfoodModel["remediation_tasks"]>[number] {
  const record = isRecord(value) ? value : {};
  return {
    type: asEnum(record.type, PACKET_REMEDIATION_TYPES) ?? "defer",
    description: asString(record.description),
    acai_id: optionalString(record.acai_id),
    target_milestone: optionalString(record.target_milestone)
  };
}

// Phase 5b: reconstruct the dogfood comparison from dogfood.yaml so the
// `packet` stage that loads a prior dogfood artifact preserves it. Returns
// undefined when no comparison was recorded.
function normalizeComparison(value: unknown): PacketComparison | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    status_changes: asArray(value.status_changes)
      .filter(isRecord)
      .map((change) => ({
        acai_id: asString(change.acai_id),
        previous_status: asString(change.previous_status),
        current_status: asString(change.current_status),
        direction: asEnum(change.direction, PACKET_COMPARISON_DIRECTIONS) ?? "unchanged"
      })),
    new_overreach: asStringArray(value.new_overreach),
    resolved_overreach: asStringArray(value.resolved_overreach),
    new_risks: asStringArray(value.new_risks),
    resolved_risks: asStringArray(value.resolved_risks),
    count_deltas: normalizeCountDeltas(value.count_deltas)
  };
}

function normalizeCountDeltas(value: unknown): PacketComparison["count_deltas"] {
  const record = isRecord(value) ? value : {};
  return {
    satisfied: normalizeCountDelta(record.satisfied),
    partial: normalizeCountDelta(record.partial),
    missing: normalizeCountDelta(record.missing),
    unknown: normalizeCountDelta(record.unknown),
    invalid_evidence: normalizeCountDelta(record.invalid_evidence)
  };
}

function normalizeCountDelta(value: unknown): CountDelta {
  const record = isRecord(value) ? value : {};
  const before = optionalNumber(record.before) ?? 0;
  const after = optionalNumber(record.after) ?? 0;
  return { before, after, delta: optionalNumber(record.delta) ?? after - before };
}

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

function readArtifact(outputDir: string, fileName: string): unknown {
  const artifactPath = path.join(outputDir, fileName);
  if (!fileExists(artifactPath)) {
    return null;
  }
  try {
    return parseYaml(fs.readFileSync(artifactPath, "utf8"));
  } catch {
    return null;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  return asArray(value)
    .filter((item) => typeof item === "string")
    .map((item) => item as string);
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = asString(entry);
  }
  return result;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}
