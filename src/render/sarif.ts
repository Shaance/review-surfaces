import fs from "node:fs";
import path from "node:path";
import { fileExists } from "../core/files";
import { redactSecrets } from "../privacy/secrets";
import { isHypothesisOnly } from "../evidence/evidence";
import type { EvidenceRef } from "../evidence/evidence";
import type { RequirementResult } from "../evaluation/evaluate";
import type { RiskItem } from "../risks/risks";
import { resolvePacketPath } from "./artifact-path";
import type { ReviewPacket } from "./packet";

// ---------------------------------------------------------------------------
// Phase 6b: SARIF 2.1.0 exporter (PROVIDERS.2; M6).
//
// Like the Phase 6a comment renderer, this is a RENDERER, not a pipeline stage.
// It READS the local review_packet.json artifact and emits a SARIF 2.1.0 log.
// Hard M6 constraints honored here:
//   - It never recomputes the pipeline (no intent/evaluate/risks logic runs).
//   - It never redefines the core artifact contract; it only consumes the
//     already-written ReviewPacket shape.
//   - The path requires no network/hosted access; it just reads/writes files.
//
// Output is byte-deterministic: same packet in -> same SARIF out. Results and
// the derived rules[] are emitted in a fixed, stable order. Secrets are redacted
// in every free-text message, mirroring the comment renderer.
// ---------------------------------------------------------------------------

export const SARIF_VERSION = "2.1.0";
export const SARIF_SCHEMA_URI =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";
export const SARIF_TOOL_NAME = "review-surfaces";
export const SARIF_INFORMATION_URI = "https://github.com/Shaance/review-surfaces";

export type SarifLevel = "error" | "warning" | "note" | "none";

export interface SarifRegion {
  startLine: number;
  endLine?: number;
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: SarifRegion;
  };
}

export interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations?: SarifLocation[];
}

export interface SarifReportingDescriptor {
  id: string;
  name: string;
}

export interface SarifLog {
  $schema: string;
  version: typeof SARIF_VERSION;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        rules: SarifReportingDescriptor[];
      };
    };
    results: SarifResult[];
  }>;
}

export interface RenderedSarif {
  sarif: SarifLog;
  json: string;
  packetPath: string;
}

const DEFAULT_RISK_RULE_ID = "unknown";

/**
 * Map a RiskItem severity to a SARIF result level. critical/high are surfaced as
 * errors a reviewer should not ignore; medium is a warning; low/unknown are
 * informational notes.
 */
export function levelForSeverity(severity: RiskItem["severity"]): SarifLevel {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
    case "unknown":
    default:
      return "note";
  }
}

/**
 * Load the local review_packet.json and render a SARIF 2.1.0 log. Returns null
 * when the packet is absent so the caller can emit a clean usage error
 * suggesting `review-surfaces all` WITHOUT recomputing anything here.
 */
export function renderSarifFromPacketFile(cwd: string, outDir?: string): RenderedSarif | null {
  const packetPath = resolvePacketPath(cwd, outDir);
  if (!fileExists(packetPath)) {
    return null;
  }
  const packet = JSON.parse(fs.readFileSync(packetPath, "utf8")) as ReviewPacket;
  const sarif = renderSarif(packet);
  return {
    sarif,
    // Trailing newline keeps the file POSIX-friendly and byte-stable across runs.
    json: `${JSON.stringify(sarif, null, 2)}\n`,
    packetPath
  };
}

/**
 * Render a SARIF 2.1.0 log from an in-memory packet. Pure: no IO, no clock,
 * deterministic given the packet. rules[] is derived from exactly the ruleIds
 * the results use, and both arrays are emitted in a stable order.
 */
export function renderSarif(packet: ReviewPacket): SarifLog {
  const results = [...riskResults(packet), ...requirementResults(packet), ...hypothesisResults(packet)];
  const rules = rulesFromResults(results);
  return {
    $schema: SARIF_SCHEMA_URI,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: SARIF_TOOL_NAME,
            informationUri: SARIF_INFORMATION_URI,
            rules
          }
        },
        results
      }
    ]
  };
}

// Each non-hypothesis risk item -> one result. ruleId is the risk category;
// level derives from severity. locations come from any evidence ref carrying a
// file path. Items whose ONLY evidence is LLM-proposed are handled separately by
// hypothesisResults so they can never be emitted at error level.
function riskResults(packet: ReviewPacket): SarifResult[] {
  const results: SarifResult[] = [];
  for (const item of packet.risks?.items ?? []) {
    if (isHypothesisOnly(item.evidence)) {
      continue;
    }
    results.push({
      ruleId: item.category || DEFAULT_RISK_RULE_ID,
      level: levelForSeverity(item.severity),
      message: { text: redact(`${item.id}: ${item.summary}`) },
      ...locationsField(deterministicLocations(item.evidence))
    });
  }
  return results;
}

// Requirement results -> SARIF results. invalid_evidence is an error (a
// requirement claimed evidence that did not validate); missing is a warning (no
// evidence at all). Other statuses (satisfied/partial/unknown/overreach) are not
// emitted: the comment + packet already carry coverage, and SARIF is for
// actionable findings. Overreach is intentionally excluded here because it is
// already represented as a risk item when present.
function requirementResults(packet: ReviewPacket): SarifResult[] {
  const results: SarifResult[] = [];
  for (const result of packet.evaluation?.results ?? []) {
    const mapped = requirementResultFor(result);
    if (mapped) {
      results.push(mapped);
    }
  }
  return results;
}

function requirementResultFor(result: RequirementResult): SarifResult | null {
  const id = result.acai_id ?? result.requirement_id;
  if (result.status === "invalid_evidence") {
    return {
      ruleId: "invalid_evidence",
      level: "error",
      message: { text: redact(`${id}: ${result.summary}`) },
      ...locationsField(deterministicLocations(result.evidence))
    };
  }
  if (result.status === "missing") {
    return {
      ruleId: "missing_requirement",
      level: "warning",
      message: { text: redact(`${id}: ${result.summary}`) },
      // Missing requirements have no proving evidence; surface any
      // missing_evidence path hints when present, else no location.
      ...locationsField(deterministicLocations(result.missing_evidence))
    };
  }
  return null;
}

// LLM/agent-proposed material is surfaced ONLY as level "note" with a message
// that clearly flags it as an unverified hypothesis (review-surfaces.EVIDENCE.6).
// It is NEVER an error or warning regardless of the severity/status it rides on,
// so a hypothesis can never masquerade as deterministic proof in SARIF.
function hypothesisResults(packet: ReviewPacket): SarifResult[] {
  const results: SarifResult[] = [];

  for (const requirement of packet.intent?.requirements ?? []) {
    if (requirement.llm_derived) {
      results.push({
        ruleId: "llm_hypothesis",
        level: "note",
        message: { text: redact(`HYPOTHESIS (NOT proof; verify): requirement ${requirement.id}: ${requirement.requirement}`) }
      });
    }
  }

  for (const item of packet.risks?.items ?? []) {
    if (isHypothesisOnly(item.evidence)) {
      results.push({
        ruleId: "llm_hypothesis",
        level: "note",
        message: { text: redact(`HYPOTHESIS (NOT proof; verify): ${item.id}: ${item.summary}`) },
        ...locationsField(deterministicLocations(item.evidence))
      });
    }
  }

  for (const result of packet.evaluation?.results ?? []) {
    const id = result.acai_id ?? result.requirement_id;
    for (const ref of [...(result.evidence ?? []), ...(result.missing_evidence ?? [])]) {
      if (ref.llm_proposed === true) {
        results.push({
          ruleId: "llm_hypothesis",
          level: "note",
          message: { text: redact(`HYPOTHESIS (NOT proof; verify): ${id}: ${ref.path ?? ref.note ?? ref.kind}`) },
          ...locationsField(deterministicLocations([ref]))
        });
      }
    }
  }

  return results;
}

// Build SARIF locations from evidence refs that carry a file path. Region
// startLine/endLine are added from line_start/line_end when present (SARIF lines
// are 1-based; we only emit a region when line_start is a positive integer).
// Deduplicated and sorted for byte-stable output.
function deterministicLocations(evidence: EvidenceRef[] | undefined): SarifLocation[] {
  const seen = new Set<string>();
  const locations: SarifLocation[] = [];
  for (const ref of evidence ?? []) {
    if (typeof ref.path !== "string" || ref.path.trim() === "") {
      continue;
    }
    // Code-scanning consumers require every location to resolve INSIDE the
    // analyzed repo. An invalid_evidence result preserves its REJECTED evidence
    // path (validation_status "invalid"), which can be absolute or escape the
    // repo via a `..` segment. Emitting that raw value as artifactLocation.uri
    // points the consumer out-of-repo. Drop the location for any unsafe path (or
    // any ref the validator marked invalid); the result is still reported, but at
    // the run level (no location) via locationsField.
    if (isUnsafeEvidencePath(ref)) {
      continue;
    }
    const region = regionFor(ref);
    const key = `${ref.path}:${region?.startLine ?? ""}:${region?.endLine ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    locations.push({
      physicalLocation: {
        artifactLocation: { uri: ref.path },
        ...(region ? { region } : {})
      }
    });
  }
  return locations.sort((left, right) => {
    const leftUri = left.physicalLocation.artifactLocation.uri;
    const rightUri = right.physicalLocation.artifactLocation.uri;
    if (leftUri !== rightUri) {
      return leftUri < rightUri ? -1 : 1;
    }
    const leftStart = left.physicalLocation.region?.startLine ?? 0;
    const rightStart = right.physicalLocation.region?.startLine ?? 0;
    return leftStart - rightStart;
  });
}

// An evidence ref's path is UNSAFE for a SARIF artifactLocation.uri when it
// cannot be trusted to resolve inside the analyzed repo: an absolute path, a
// path with a `..` segment (escapes the repo), or a ref the deterministic
// validator already rejected (validation_status "invalid"). Such refs are
// dropped from locations so the result is emitted at the run level instead of
// carrying an out-of-repo URI. Path checks cover both POSIX and Windows
// separators so a `..\\` or drive-letter path is caught too.
function isUnsafeEvidencePath(ref: EvidenceRef): boolean {
  if (ref.validation_status === "invalid") {
    return true;
  }
  const value = ref.path ?? "";
  return isAbsolutePath(value) || hasParentSegment(value);
}

function isAbsolutePath(value: string): boolean {
  // POSIX absolute (/foo), Windows drive (C:\ or C:/), or UNC (\\server) paths.
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function hasParentSegment(value: string): boolean {
  return value
    .split(/[\\/]/)
    .some((segment) => segment === "..");
}

function regionFor(ref: EvidenceRef): SarifRegion | undefined {
  if (typeof ref.line_start !== "number" || !Number.isInteger(ref.line_start) || ref.line_start <= 0) {
    return undefined;
  }
  const region: SarifRegion = { startLine: ref.line_start };
  if (typeof ref.line_end === "number" && Number.isInteger(ref.line_end) && ref.line_end >= ref.line_start) {
    region.endLine = ref.line_end;
  }
  return region;
}

function locationsField(locations: SarifLocation[]): { locations?: SarifLocation[] } {
  return locations.length > 0 ? { locations } : {};
}

// rules[] must cover exactly the distinct ruleIds the results use. Sorted for a
// deterministic, byte-stable driver.rules array.
function rulesFromResults(results: SarifResult[]): SarifReportingDescriptor[] {
  const ids = [...new Set(results.map((result) => result.ruleId))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return ids.map((id) => ({ id, name: id }));
}

function redact(value: string): string {
  return redactSecrets(value).text;
}
