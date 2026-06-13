import fs from "node:fs";
import path from "node:path";
import { fileExists } from "../core/files";
import { isRecord } from "../core/guards";
import { isHypothesisOnly } from "../evidence/evidence";
import { gateDecision, type GateOptions } from "../core/gate";
import { countRequirementStatuses } from "../evaluation/status";
import { PACKET_REQUIREMENT_STATUSES, PACKET_SEVERITIES } from "../schema/review-packet-contract";
import type { PacketRequirementStatus, PacketSeverity } from "../schema/review-packet-contract";
import type { CollectionResult } from "../collector/collect";
import type { ProviderName } from "../llm/provider";
import { resolvePacketPath } from "./comment";
import type { ReviewPacket } from "./packet";

// ---------------------------------------------------------------------------
// review-surfaces.QUALITY_GATE.2/.3: a deterministic, machine-readable run
// summary projection. Like the SARIF renderer (src/render/sarif.ts) this is a
// RENDERER, not a pipeline stage: it READS the local review_packet.json (and the
// sibling human_review.json for the ranked queue) and recomputes NOTHING about
// the pipeline. The only derived value is the gate code, computed via the SAME
// gateDecision the CLI uses, over the SAME GateOptions the CLI computes for this
// repo (max_missing/allow_missing/fail_on) AND the SAME gate context (collection
// + provider) the command applied — so gate_code matches the run's REAL gate
// outcome, including a privacy block (exit 5) on a remote-provider run over a
// remote_provider_blocked diff. A renderer-only call with no context gates as a
// local mock run (privacy can never trip an already-produced LOCAL packet).
//
// Output is byte-stable: same packet + same queue -> identical JSON bytes out, on
// a SINGLE compact line so a CI step can parse one line. Object keys are emitted
// in a fixed insertion order and the histogram/queue arrays are derived in stable
// order, so a CI consumer can diff two runs byte-for-byte.
// ---------------------------------------------------------------------------

const TOP_QUEUE_LIMIT = 10;

export interface RunSummaryProjection {
  schema: "review-surfaces.run-summary.v1";
  gate_code: number;
  // review-surfaces.QUALITY_GATE.2: EVERY requirement status from the contract
  // (PACKET_REQUIREMENT_STATUSES), with its canonical name — no bucket dropped or
  // renamed, so a CI consumer sees satisfied/partial/missing/unknown/overreach/
  // invalid_evidence in full.
  requirement_counts: Record<PacketRequirementStatus, number>;
  risk_severity_histogram: Record<PacketSeverity, number>;
  top_queue_ids: string[];
}

export interface RenderedRunSummary {
  summary: RunSummaryProjection;
  json: string;
  packetPath: string;
}

// review-surfaces.QUALITY_GATE.1: the REAL gate context the command applied. When
// supplied (the gating commands — all/packet/comment --format json), the
// projection gates over the SAME collection + provider the command did, so a
// privacy-blocked remote run reports the SAME gate_code (5) the strict gate
// exited. Absent (legacy/renderer-only), the projection gates as a local mock run
// — a non-remote-blocked collection + the mock provider, which can never trip
// privacy on an already-produced LOCAL packet.
export interface GateContext {
  collection: CollectionResult;
  provider: ProviderName;
}

function rendererGateContext(): GateContext {
  return {
    collection: { privacy: { remote_provider_blocked: false } } as unknown as CollectionResult,
    provider: "mock"
  };
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
 *
 * `gateContext` is the SAME collection + provider the command's real gate used,
 * so a privacy-blocked remote run reports the SAME gate_code (5) the strict gate
 * exited (review-surfaces.QUALITY_GATE.1). Absent, the projection gates as a
 * local mock run (privacy can never trip an already-produced LOCAL packet).
 */
export function projectRunSummary(
  packet: ReviewPacket,
  gateOptions: GateOptions = { maxMissing: 0 },
  queueIds: string[] = [],
  gateContext: GateContext = rendererGateContext()
): RunSummaryProjection {
  const results = packet.evaluation?.results ?? [];
  const overreachResults = packet.evaluation?.overreach ?? [];
  // Codex finding 4: count each requirement status across BOTH evaluation.results
  // AND evaluation.overreach, exactly as gateDecision does (it counts
  // invalid_evidence over [...results, ...overreach]). An overreach entry whose
  // status is "invalid_evidence" trips the evidence gate (code 4), so it MUST also
  // land in requirement_counts.invalid_evidence — otherwise the JSON counts would
  // disagree with the gate_code. Entries whose status is "overreach" are not in the
  // counted-status set, so they don't double-count; the separate `overreach` bucket
  // below stays the evaluation.overreach total.
  const counts = countRequirementStatuses([...results, ...overreachResults]);
  const overreach = overreachResults.length;
  const riskItems = packet.risks?.items ?? [];

  // gate_code mirrors the CLI's deterministic decision over the SAME inputs AND
  // the SAME GateOptions (max_missing/allow_missing/fail_on) AND the SAME gate
  // context (collection + provider) — so a repo that tolerates N missing
  // requirements reports its real gate code, and a privacy-blocked remote run
  // reports privacy code 5, not a spurious 0 from a mock-context recompute.
  const decision = gateDecision(packet.evaluation, gateContext.collection, gateContext.provider, gateOptions, riskItems);

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
    // review-surfaces.QUALITY_GATE.2: EVERY contract requirement status, with its
    // CANONICAL name (PACKET_REQUIREMENT_STATUSES is the source of truth, in the
    // contract's fixed order), so no bucket is dropped or renamed. overreach is the
    // separately-tracked evaluation.overreach count; every other status comes from
    // countRequirementStatuses.
    requirement_counts: Object.fromEntries(
      PACKET_REQUIREMENT_STATUSES.map((status) => [
        status,
        status === "overreach" ? overreach : counts[status]
      ])
    ) as Record<PacketRequirementStatus, number>,
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
  // Codex finding 5: the no-human_review fallback must list only the DETERMINISTIC
  // risk ids — an LLM-hypothesis-only risk is never proof, so excluding it here
  // matches the gate (which drops hypotheses via isHypothesisOnly) and the
  // risk-severity histogram above. Without this filter the machine fallback queue
  // would surface unverified hypotheses the deterministic queue never would.
  return (packet.risks?.items ?? [])
    .filter((item) => !isHypothesisOnly(item.evidence))
    .map((item) => item.id)
    .slice(0, TOP_QUEUE_LIMIT);
}

// review-surfaces.QUALITY_GATE.2: the key that ties a human_review.json to the
// packet it was generated from — the packet manifest's head_sha, compared against
// the queue file's generated_from.head_sha, so a STALE queue (from an older run
// over a different head) never supplies the ranked ids for THIS packet.
//
// This returns the RAW manifest head_sha string (or undefined when the manifest is
// missing / non-string). Codex finding 2: it is passed VERBATIM to readQueueIds so
// a sentinel value ("unknown") reaches the real-sha guard THERE and is rejected,
// rather than being pre-filtered to undefined (which would skip the freshness
// check and silently trust the queue). readQueueIds — not this reader — owns the
// validity decision, so both call paths share one rule.
function rawPacketHeadSha(packet: ReviewPacket): string | undefined {
  const manifest = packet.manifest;
  if (!isRecord(manifest)) {
    return undefined;
  }
  const headSha = manifest.head_sha;
  return typeof headSha === "string" ? headSha : undefined;
}

// A real commit sha is a non-empty hex string (git short/full SHA-1 or SHA-256).
// The "unknown"/"HEAD" sentinels, an empty string, and any non-hex value are never
// a real sha, so they can never key freshness — outside a git repo BOTH the packet
// AND a stale queue carry "unknown", so two unresolved runs must NOT be treated as
// the same head.
function isRealHeadSha(headSha: string): boolean {
  return /^[0-9a-f]+$/i.test(headSha);
}

/**
 * Read the ranked review-queue ids from the sibling human_review.json under the
 * SAME directory the packet lives in (located exactly like resolvePacketPath
 * locates the packet) — but ONLY when that file corresponds to THIS packet
 * (matching head_sha). The queue is already rank-ordered, so the ids are taken in
 * their on-disk order. Absent/unreadable/malformed/scalar/queue-less/stale -> []
 * so the caller falls back to the deterministic risk ids — a renderer-only read
 * that recomputes nothing and NEVER throws.
 *
 * `expectedHeadSha` is the current packet's manifest head_sha; when supplied it
 * must equal the queue file's generated_from.head_sha or the (stale) queue is
 * ignored.
 *
 * Codex finding 2: a sentinel/non-real head_sha ("unknown", "HEAD", empty, or any
 * non-hex value) is NEVER a valid freshness key — outside a git repo both the
 * packet AND a stale queue carry "unknown", so matching them would pair two
 * unrelated runs. When the supplied key is not a real sha we do NOT trust the
 * queue (return [] so the caller falls back to deterministic risk ids), rather
 * than skipping the check and trusting a possibly-stale queue.
 */
export function readQueueIds(cwd: string, outDir?: string, expectedHeadSha?: string): string[] {
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
  // FINDING 8: a human_review.json that parses to a SCALAR (e.g. `null`) or array
  // must never throw on property access — guard with isRecord before reading.
  if (!isRecord(model)) {
    return [];
  }
  // FINDING 4 + Codex finding 2: only trust a queue that was generated FROM this
  // packet. When the caller supplies a head_sha it must be a REAL sha AND must
  // equal the queue file's generated_from.head_sha; a sentinel key, a missing key,
  // or a mismatch all mean the queue cannot be proven current -> [].
  if (expectedHeadSha !== undefined) {
    if (!isRealHeadSha(expectedHeadSha)) {
      return [];
    }
    const generatedFrom = model.generated_from;
    const queueHeadSha = isRecord(generatedFrom) ? generatedFrom.head_sha : undefined;
    if (typeof queueHeadSha !== "string" || queueHeadSha !== expectedHeadSha) {
      return [];
    }
  }
  const queue = model.review_queue;
  if (!Array.isArray(queue)) {
    return [];
  }
  return queue
    .map((item) => (isRecord(item) ? item.id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Serialize a projection to a SINGLE compact JSON line with a trailing newline
 * (review-surfaces.QUALITY_GATE.3) — JSON.stringify with NO indentation, so a CI
 * step can read and parse exactly one line (whether emitted on its own by
 * `comment --format json` or interleaved amid the human prose of `all --json`).
 * Object keys are emitted in a fixed insertion order, so the line is byte-stable.
 */
export function serializeRunSummary(summary: RunSummaryProjection): string {
  return `${JSON.stringify(summary)}\n`;
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
  gateOptions: GateOptions = { maxMissing: 0 },
  gateContext?: GateContext
): RenderedRunSummary | null {
  const packetPath = resolvePacketPath(cwd, outDir);
  if (!fileExists(packetPath)) {
    return null;
  }
  const packet = JSON.parse(fs.readFileSync(packetPath, "utf8")) as ReviewPacket;
  // FINDING 4 + Codex finding 2: bind the queue read to THIS packet's RAW manifest
  // head_sha so a stale human_review.json from an older run cannot supply the
  // ranked ids — and so a sentinel head_sha ("unknown") reaches readQueueIds' real-
  // sha guard and is rejected (it never silently trusts the queue).
  const queueIds = readQueueIds(cwd, outDir, rawPacketHeadSha(packet));
  const summary = projectRunSummary(packet, gateOptions, queueIds, gateContext);
  return { summary, json: serializeRunSummary(summary), packetPath };
}
