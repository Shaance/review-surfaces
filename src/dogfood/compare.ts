import fs from "node:fs";
import path from "node:path";
import { fileExists } from "../core/files";
import { isRecord } from "../core/guards";
import { EvaluationModel, RequirementResult } from "../evaluation/evaluate";
import { RisksModel } from "../risks/risks";
import { countRequirementStatuses, RequirementStatusCount } from "../evaluation/status";
import { compareStrings } from "../core/compare";
import type { PacketComparisonDirection } from "../schema/review-packet-contract";

// ---------------------------------------------------------------------------
// Phase 5b: previous-packet comparison (CLI.6; TRD 10.9 & 15.4).
//
// Computes a fully DETERMINISTIC diff between a previously-written
// review_packet.json and the current packet's evaluation/risks. No timestamps,
// no environment, no ordering surprises: every list is sorted by a stable key
// so the same pair of packets always yields byte-identical output.
// ---------------------------------------------------------------------------

// Status ordering used to classify a requirement-status transition as
// improved / regressed / unchanged. "overreach" is handled separately (it is
// not a coverage status) and is treated as its own bucket so a status that
// flips into or out of overreach is reported as a change without forcing a
// nonsensical numeric direction.
//
// invalid_evidence ranks BELOW missing/unknown: it means a claim is actively
// untrustworthy (it trips the evidence gate), which is strictly worse than a
// merely-absent claim. So a move INTO invalid_evidence (e.g. missing ->
// invalid_evidence) is a regression, and a move OUT of it is an improvement.
const STATUS_ORDER: Record<string, number> = {
  invalid_evidence: 0,
  missing: 1,
  unknown: 2,
  partial: 3,
  satisfied: 4
};

export type ComparisonDirection = PacketComparisonDirection;

export interface StatusChange {
  acai_id: string;
  previous_status: string;
  current_status: string;
  direction: ComparisonDirection;
}

export interface CountDeltas {
  satisfied: CountDelta;
  partial: CountDelta;
  missing: CountDelta;
  unknown: CountDelta;
  invalid_evidence: CountDelta;
}

export interface CountDelta {
  before: number;
  after: number;
  delta: number;
}

export interface PacketComparison {
  status_changes: StatusChange[];
  new_overreach: string[];
  resolved_overreach: string[];
  new_risks: string[];
  resolved_risks: string[];
  count_deltas: CountDeltas;
}

// Minimal shape of a loaded previous review_packet.json. Only the slices the
// comparison consumes are typed; everything else is ignored so a packet written
// by an older tool version still loads.
export interface PreviousPacket {
  evaluation: EvaluationModel;
  risks: Pick<RisksModel, "items">;
}

export interface CurrentPacketModels {
  evaluation: EvaluationModel;
  risks: Pick<RisksModel, "items">;
}

/**
 * Resolve a --previous-packet value to a concrete review_packet.json path.
 * A directory resolves to <dir>/review_packet.json; a file path is used as-is.
 */
export function resolvePreviousPacketPath(cwd: string, value: string): string {
  const resolved = path.resolve(cwd, value);
  if (resolved.endsWith(".json")) {
    return resolved;
  }
  return path.join(resolved, "review_packet.json");
}

/**
 * Load a previous packet for comparison. Returns null (NOT throwing) when the
 * file is absent or unreadable so an absent/unreadable --previous-packet is a
 * clean no-op and never fatal.
 */
export function loadPreviousPacket(packetPath: string): PreviousPacket | null {
  if (!fileExists(packetPath)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(packetPath, "utf8"));
  } catch {
    return null;
  }
  // A top-level non-object (primitive) OR a JSON array must be treated the same
  // as malformed JSON: a clean no-op returning null. An array satisfies
  // `typeof === "object"` and is non-null, so without the Array.isArray guard
  // it would slip past, get coerced to an empty previous packet, and fabricate
  // a misleading "everything improved" comparison against a phantom baseline.
  if (!isRecord(parsed)) {
    return null;
  }
  const record = parsed;
  // A valid JSON OBJECT that is NOT a review packet (e.g. package.json or
  // manifest.json) must be the SAME clean no-op as the array/primitive cases.
  // Without this guard its absent evaluation/risks fields normalize to an empty
  // baseline, and the comparison falsely reports every current requirement as an
  // improvement-from-missing and every current risk as new — against a phantom
  // baseline. Require it to actually look like a review packet first.
  if (!isReviewPacketShape(record)) {
    return null;
  }
  const evaluation = normalizeEvaluation(record.evaluation);
  const risks = normalizeRisks(record.risks);
  return { evaluation, risks };
}

// A loaded object IS a review packet ONLY when it has the expected STRUCTURE:
// an evaluation object with a results array AND a risks object with an items
// array. A package.json / manifest.json / arbitrary JSON object lacks both, so
// it is rejected as an unreadable baseline (no-op).
//
// Round 9 (FINDING A): schema_version is NO LONGER a sufficient short-circuit.
// A parseable-but-truncated/corrupt baseline like
// `{ "schema_version": "review-surfaces.packet.v1" }` (no evaluation/risks) used
// to pass on schema_version alone; normalizeEvaluation(undefined) /
// normalizeRisks(undefined) then coerced it into an EMPTY baseline, and the
// dogfood comparison falsely reported every current requirement as
// improved-from-missing and every current risk as new against a phantom
// baseline. The structural fields are now required UNCONDITIONALLY so such a
// file returns null (clean no-op), exactly like the absent/array/non-packet
// cases.
//
// PARITY PRESERVED: the structural check does NOT require schema_version, so a
// genuine handwritten packet that OMITS schema_version but carries a proper
// evaluation.results array and risks.items array is still accepted (round-3
// behavior).
function isReviewPacketShape(record: Record<string, unknown>): boolean {
  const evaluation = record.evaluation;
  const risks = record.risks;
  return (
    isRecord(evaluation) &&
    Array.isArray(evaluation.results) &&
    isRecord(risks) &&
    Array.isArray(risks.items)
  );
}

/**
 * Compute the deterministic comparison between a previous packet and the
 * current packet's models. Pure: no IO, no clock, fully sorted output.
 */
export function comparePackets(previous: PreviousPacket, current: CurrentPacketModels): PacketComparison {
  return {
    status_changes: computeStatusChanges(previous.evaluation, current.evaluation),
    ...computeOverreachChanges(previous.evaluation, current.evaluation),
    ...computeRiskChanges(previous.risks, current.risks),
    count_deltas: computeCountDeltas(previous.evaluation, current.evaluation)
  };
}

function computeStatusChanges(previous: EvaluationModel, current: EvaluationModel): StatusChange[] {
  const previousByKey = statusByRequirementKey(previous.results);
  const currentByKey = statusByRequirementKey(current.results);
  const keys = new Set<string>([...previousByKey.keys(), ...currentByKey.keys()]);

  const changes: StatusChange[] = [];
  for (const key of keys) {
    const previousStatus = previousByKey.get(key) ?? "missing";
    const currentStatus = currentByKey.get(key) ?? "missing";
    if (previousStatus === currentStatus) {
      continue;
    }
    changes.push({
      acai_id: key,
      previous_status: previousStatus,
      current_status: currentStatus,
      direction: directionFor(previousStatus, currentStatus)
    });
  }

  return changes.sort((left, right) => compareStrings(left.acai_id, right.acai_id));
}

// Key a result by its acai_id when present, else by requirement_id, so the same
// requirement matches across packets even when only one identifier is set.
function statusByRequirementKey(results: RequirementResult[]): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const result of results) {
    const key = result.acai_id || result.requirement_id;
    if (!key) {
      continue;
    }
    // First write wins for stable, deterministic output when duplicates exist.
    if (!byKey.has(key)) {
      byKey.set(key, result.status);
    }
  }
  return byKey;
}

function directionFor(previousStatus: string, currentStatus: string): ComparisonDirection {
  const previousRank = STATUS_ORDER[previousStatus];
  const currentRank = STATUS_ORDER[currentStatus];
  // Either side is overreach (or an unrecognized status): not a coverage
  // ranking, so we cannot say improved/regressed. Treat any change to/from
  // overreach as "regressed" when entering overreach and "improved" when
  // leaving it, otherwise "unchanged".
  if (previousRank === undefined || currentRank === undefined) {
    if (currentStatus === "overreach" && previousStatus !== "overreach") {
      return "regressed";
    }
    if (previousStatus === "overreach" && currentStatus !== "overreach") {
      return "improved";
    }
    return "unchanged";
  }
  if (currentRank > previousRank) {
    return "improved";
  }
  if (currentRank < previousRank) {
    return "regressed";
  }
  return "unchanged";
}

function computeOverreachChanges(
  previous: EvaluationModel,
  current: EvaluationModel
): Pick<PacketComparison, "new_overreach" | "resolved_overreach"> {
  const previousPaths = overreachPaths(previous);
  const currentPaths = overreachPaths(current);
  const newOverreach = [...currentPaths].filter((filePath) => !previousPaths.has(filePath)).sort(compareStrings);
  const resolvedOverreach = [...previousPaths].filter((filePath) => !currentPaths.has(filePath)).sort(compareStrings);
  return { new_overreach: newOverreach, resolved_overreach: resolvedOverreach };
}

// Overreach is keyed by the changed-file path(s) it covers; collect every file
// path referenced by the overreach results' evidence so a packet whose
// OVERREACH-NNN ids shift still diffs by stable file identity.
function overreachPaths(evaluation: EvaluationModel): Set<string> {
  const paths = new Set<string>();
  for (const result of evaluation.overreach ?? []) {
    for (const ref of result.evidence ?? []) {
      if (ref.path) {
        paths.add(ref.path);
      }
    }
  }
  return paths;
}

function computeRiskChanges(
  previous: Pick<RisksModel, "items">,
  current: Pick<RisksModel, "items">
): Pick<PacketComparison, "new_risks" | "resolved_risks"> {
  const previousRisks = riskKeys(previous.items ?? []);
  const currentRisks = riskKeys(current.items ?? []);
  const newRisks = [...currentRisks].filter((key) => !previousRisks.has(key)).sort(compareStrings);
  const resolvedRisks = [...previousRisks].filter((key) => !currentRisks.has(key)).sort(compareStrings);
  return { new_risks: newRisks, resolved_risks: resolvedRisks };
}

// Risks are keyed by a STABLE property (category + summary), NOT the generated
// RISK-NNN id. Risk ids are assigned by insertion order, so adding an earlier
// risk renumbers every later one; keying on the id would then report an
// unchanged risk (same summary, shifted id) as BOTH resolved AND new. Category
// is included so two distinct risks that happen to share a summary stay
// separable, while a re-numbered risk with the same category+summary matches
// across packets.
function riskKeys(items: Array<{ id?: string; category?: string; summary?: string }>): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    keys.add(comparisonRiskKey(item));
  }
  return keys;
}

export function comparisonRiskKey(item: { category?: string; summary?: string }): string {
  const category = item.category ?? "";
  const summary = item.summary ?? "";
  return `${category}: ${summary}`;
}

function computeCountDeltas(previous: EvaluationModel, current: EvaluationModel): CountDeltas {
  const before = countRequirementStatuses(previous.results);
  const after = countRequirementStatuses(current.results);
  return {
    satisfied: deltaFor(before, after, "satisfied"),
    partial: deltaFor(before, after, "partial"),
    missing: deltaFor(before, after, "missing"),
    unknown: deltaFor(before, after, "unknown"),
    invalid_evidence: deltaFor(before, after, "invalid_evidence")
  };
}

function deltaFor(
  before: RequirementStatusCount,
  after: RequirementStatusCount,
  key: keyof RequirementStatusCount
): CountDelta {
  return { before: before[key], after: after[key], delta: after[key] - before[key] };
}

// ---------------------------------------------------------------------------
// Tolerant normalizers for a previously-written packet on disk.
// ---------------------------------------------------------------------------

function normalizeEvaluation(value: unknown): EvaluationModel {
  const record = isRecord(value) ? value : {};
  return {
    summary: typeof record.summary === "string" ? record.summary : "",
    results: asArray(record.results).map(normalizeResult),
    overreach: asArray(record.overreach).map(normalizeResult),
    acai_coverage: {}
  };
}

function normalizeResult(value: unknown): RequirementResult {
  const record = isRecord(value) ? value : {};
  return {
    requirement_id: typeof record.requirement_id === "string" ? record.requirement_id : "",
    acai_id: typeof record.acai_id === "string" ? record.acai_id : undefined,
    status: (typeof record.status === "string" ? record.status : "unknown") as RequirementResult["status"],
    summary: typeof record.summary === "string" ? record.summary : "",
    evidence: asArray(record.evidence)
      .map((ref) => (isRecord(ref) && typeof ref.path === "string" ? { kind: "file" as const, path: ref.path, confidence: "unknown" as const } : null))
      .filter((ref): ref is { kind: "file"; path: string; confidence: "unknown" } => ref !== null),
    missing_evidence: [],
    review_focus: "",
    confidence: "unknown"
  };
}

function normalizeRisks(value: unknown): Pick<RisksModel, "items"> {
  const record = isRecord(value) ? value : {};
  const items = asArray(record.items)
    .filter(isRecord)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      // Preserve the real category so the stable risk key (category + summary)
      // matches across packets; fall back to "unknown" when absent.
      category: isRiskCategory(item.category) ? item.category : ("unknown" as const),
      severity: "unknown" as const,
      summary: typeof item.summary === "string" ? item.summary : ""
    }));
  return { items };
}

const RISK_CATEGORIES = new Set<string>([
  "correctness",
  "security",
  "privacy",
  "maintainability",
  "architecture",
  "testing",
  "workflow",
  "release",
  "performance",
  "unknown"
]);

function isRiskCategory(value: unknown): value is RisksModel["items"][number]["category"] {
  return typeof value === "string" && RISK_CATEGORIES.has(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
