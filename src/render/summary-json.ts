import fs from "node:fs";
import path from "node:path";
import { fileExists } from "../core/files";
import { isHypothesisOnly } from "../evidence/evidence";
import { gateDecision, type GateOptions } from "../core/gate";
import { countRequirementStatuses } from "../evaluation/status";
import { PACKET_SEVERITIES } from "../schema/review-packet-contract";
import type { PacketSeverity } from "../schema/review-packet-contract";
import type { CollectionResult } from "../collector/collect";
import { resolvePacketPath } from "./comment";
import type { ReviewPacket } from "./packet";

// ---------------------------------------------------------------------------
// review-surfaces.QUALITY_GATE.2/.3: a deterministic, machine-readable run
// summary projection. Like the SARIF renderer (src/render/sarif.ts) this is a
// RENDERER, not a pipeline stage: it READS the local review_packet.json (and the
// sibling human_review.json for the ranked queue) and recomputes NOTHING about
// the pipeline. The only derived value is the gate code, computed via the SAME
// gateDecision the CLI uses, over the SAME GateOptions the CLI computes for this
// repo (max_missing/allow_missing/fail_on) — so gate_code matches what the real
// gate would return. (No privacy/provider context is persisted in the packet, so
// the projection gates as a local mock run — privacy can never trip here, the
// packet was already produced locally.)
//
// Output is byte-stable: same packet + same queue -> identical JSON bytes out.
// Object keys are emitted in a fixed insertion order and the histogram/queue
// arrays are derived in stable order, so a CI consumer can diff two runs
// byte-for-byte.
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
 *
 * `gateOptions` are the SAME options the CLI threads into the real gate
 * (max_missing/allow_missing from config or --max-missing, plus the --fail-on /
 * quality_gate.fail_on severity threshold) so gate_code matches the run's gate
 * for this repo — defaulting to a maxMissing of 0 with no tolerances only when a
 * caller has none (the legacy missing/evidence-only gate).
 *
 * `queueIds` are the ranked human-review queue ids (sibling human_review.json),
 * read by the caller. When non-empty they drive top_queue_ids; otherwise the
 * deterministic risk ids are used as a packet-only fallback.
 */
export function projectRunSummary(
  packet: ReviewPacket,
  gateOptions: GateOptions = { maxMissing: 0 },
  queueIds: string[] = []
): RunSummaryProjection {
  const results = packet.evaluation?.results ?? [];
  const counts = countRequirementStatuses(results);
  const overreach = packet.evaluation?.overreach?.length ?? 0;
  const riskItems = packet.risks?.items ?? [];

  // gate_code mirrors the CLI's deterministic decision over the SAME inputs AND
  // the SAME GateOptions (max_missing/allow_missing/fail_on), so a repo that
  // tolerates N missing requirements or allowlists a planned backlog reports the
  // gate code its real run would, not a spurious failure at maxMissing 0.
  const decision = gateDecision(packet.evaluation, rendererCollection(), "mock", gateOptions, riskItems);

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
    // Top-N queue item ids: prefer the ranked human-review queue when present,
    // else the deterministic risk ids. Both are taken in their existing stable
    // (ranked) order.
    top_queue_ids: topQueueIds(packet, queueIds)
  };
}

function topQueueIds(packet: ReviewPacket, queueIds: string[]): string[] {
  if (queueIds.length > 0) {
    return queueIds.slice(0, TOP_QUEUE_LIMIT);
  }
  return (packet.risks?.items ?? []).map((item) => item.id).slice(0, TOP_QUEUE_LIMIT);
}

/**
 * Read the ranked review-queue ids from the sibling human_review.json under the
 * SAME directory the packet lives in (located exactly like resolvePacketPath
 * locates the packet). The queue is already rank-ordered, so the ids are taken
 * in their on-disk order. Absent/unreadable/malformed/queue-less -> [] so the
 * caller falls back to the deterministic risk ids — a renderer-only read that
 * recomputes nothing.
 */
export function readQueueIds(cwd: string, outDir?: string): string[] {
  const packetPath = resolvePacketPath(cwd, outDir);
  const humanReviewPath = path.join(path.dirname(packetPath), "human_review.json");
  if (!fileExists(humanReviewPath)) {
    return [];
  }
  let model: unknown;
  try {
    model = JSON.parse(fs.readFileSync(humanReviewPath, "utf8"));
  } catch {
    return [];
  }
  const queue = (model as { review_queue?: unknown }).review_queue;
  if (!Array.isArray(queue)) {
    return [];
  }
  return queue
    .map((item) => (item as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Serialize a projection to byte-stable JSON (compact-ish, 2-space, trailing
 * newline) — the same convention as the SARIF renderer.
 */
export function serializeRunSummary(summary: RunSummaryProjection): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

/**
 * Load the local review_packet.json (and the sibling human_review.json queue) and
 * render the run summary. Returns null when the packet is absent so the caller can
 * emit a clean usage error (mirroring renderSarifFromPacketFile) instead of
 * recomputing anything here.
 */
export function renderRunSummaryFromPacketFile(
  cwd: string,
  outDir?: string,
  gateOptions: GateOptions = { maxMissing: 0 }
): RenderedRunSummary | null {
  const packetPath = resolvePacketPath(cwd, outDir);
  if (!fileExists(packetPath)) {
    return null;
  }
  const packet = JSON.parse(fs.readFileSync(packetPath, "utf8")) as ReviewPacket;
  const summary = projectRunSummary(packet, gateOptions, readQueueIds(cwd, outDir));
  return { summary, json: serializeRunSummary(summary), packetPath };
}
