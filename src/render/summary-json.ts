import fs from "node:fs";
import { fileExists } from "../core/files";
import { isHypothesisOnly } from "../evidence/evidence";
import { gateDecision, type FailOnSeverity } from "../core/gate";
import { countRequirementStatuses } from "../evaluation/status";
import { PACKET_SEVERITIES } from "../schema/review-packet-contract";
import type { PacketSeverity } from "../schema/review-packet-contract";
import type { CollectionResult } from "../collector/collect";
import { resolvePacketPath } from "./comment";
import type { ReviewPacket } from "./packet";

// ---------------------------------------------------------------------------
// review-surfaces.QUALITY_GATE.2/.3: a deterministic, machine-readable run
// summary projection. Like the SARIF renderer (src/render/sarif.ts) this is a
// RENDERER, not a pipeline stage: it READS the local review_packet.json and
// recomputes NOTHING about the pipeline. The only derived value is the gate code,
// computed via the SAME gateDecision the CLI uses (no privacy/provider context is
// persisted in the packet, so the projection gates as a local mock run — privacy
// can never trip here, the packet was already produced locally).
//
// Output is byte-stable: same packet in -> identical JSON bytes out. Object keys
// are emitted in a fixed insertion order and the histogram/queue arrays are
// derived in stable order, so a CI consumer can diff two runs byte-for-byte.
// ---------------------------------------------------------------------------

const TOP_QUEUE_LIMIT = 10;

export interface RunSummaryProjection {
  schema: "review-surfaces.run-summary.v1";
  gate_code: number;
  requirement_counts: {
    satisfied: number;
    partial: number;
    missing: number;
    invalid: number;
    overreach: number;
  };
  risk_severity_histogram: Record<PacketSeverity, number>;
  top_queue_ids: string[];
}

export interface RenderedRunSummary {
  summary: RunSummaryProjection;
  json: string;
  packetPath: string;
}

// gateDecision needs a collection only for the privacy short-circuit, which can
// never apply to an already-produced LOCAL packet. A non-remote-blocked mock
// collection keeps the projection honest (privacy never trips a renderer).
function rendererCollection(): CollectionResult {
  return { privacy: { remote_provider_blocked: false } } as unknown as CollectionResult;
}

/**
 * Pure projection of a ReviewPacket into the machine-readable run summary. No IO.
 * `failOnSeverity` lets the gate code reflect the same --fail-on threshold the
 * CLI applied for this run (omit for the legacy missing/evidence-only gate).
 */
export function projectRunSummary(packet: ReviewPacket, failOnSeverity?: FailOnSeverity): RunSummaryProjection {
  const results = packet.evaluation?.results ?? [];
  const counts = countRequirementStatuses(results);
  const overreach = packet.evaluation?.overreach?.length ?? 0;
  const riskItems = packet.risks?.items ?? [];

  // gate_code mirrors the CLI's deterministic decision over the SAME inputs.
  const decision = gateDecision(
    packet.evaluation,
    rendererCollection(),
    "mock",
    { maxMissing: 0, failOnSeverity },
    riskItems
  );

  // Severity histogram in a FIXED severity order (PACKET_SEVERITIES), counting
  // DETERMINISTIC risk items only — an LLM-hypothesis-only risk is excluded so the
  // machine summary never over-counts unverified material (mirrors SARIF).
  const histogram = Object.fromEntries(PACKET_SEVERITIES.map((severity) => [severity, 0])) as Record<PacketSeverity, number>;
  for (const item of riskItems) {
    if (isHypothesisOnly(item.evidence)) {
      continue;
    }
    if (item.severity in histogram) {
      histogram[item.severity] += 1;
    }
  }

  return {
    schema: "review-surfaces.run-summary.v1",
    gate_code: decision.code,
    requirement_counts: {
      satisfied: counts.satisfied,
      partial: counts.partial,
      missing: counts.missing,
      invalid: counts.invalid_evidence,
      overreach
    },
    risk_severity_histogram: histogram,
    // Top-N queue item ids: prefer the human-review queue when present, else the
    // deterministic risk ids. Both are taken in their existing stable order.
    top_queue_ids: topQueueIds(packet)
  };
}

function topQueueIds(packet: ReviewPacket): string[] {
  const queue = readQueueIds(packet);
  if (queue.length > 0) {
    return queue.slice(0, TOP_QUEUE_LIMIT);
  }
  return (packet.risks?.items ?? []).map((item) => item.id).slice(0, TOP_QUEUE_LIMIT);
}

// The human-review queue is a sidecar (human_review.json), not part of the
// packet, so the byte-stable projection reads the queue ids the packet itself
// carries. The packet has no review_queue, so this returns [] and the risk ids
// are used — a deterministic, packet-only fallback.
function readQueueIds(_packet: ReviewPacket): string[] {
  return [];
}

/**
 * Serialize a projection to byte-stable JSON (compact-ish, 2-space, trailing
 * newline) — the same convention as the SARIF renderer.
 */
export function serializeRunSummary(summary: RunSummaryProjection): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

/**
 * Load the local review_packet.json and render the run summary. Returns null when
 * the packet is absent so the caller can emit a clean usage error (mirroring
 * renderSarifFromPacketFile) instead of recomputing anything here.
 */
export function renderRunSummaryFromPacketFile(
  cwd: string,
  outDir?: string,
  failOnSeverity?: FailOnSeverity
): RenderedRunSummary | null {
  const packetPath = resolvePacketPath(cwd, outDir);
  if (!fileExists(packetPath)) {
    return null;
  }
  const packet = JSON.parse(fs.readFileSync(packetPath, "utf8")) as ReviewPacket;
  const summary = projectRunSummary(packet, failOnSeverity);
  return { summary, json: serializeRunSummary(summary), packetPath };
}
