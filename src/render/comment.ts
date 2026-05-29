import fs from "node:fs";
import path from "node:path";
import { fileExists } from "../core/files";
import { redactSecrets } from "../privacy/secrets";
import { countRequirementStatuses, formatRequirementStatusSummary } from "../evaluation/status";
import type { ReviewPacket } from "./packet";

// ---------------------------------------------------------------------------
// Phase 6a: GitHub STICKY-COMMENT renderer (PROVIDERS.1; M6).
//
// This is a RENDERER, not a pipeline stage. It READS the local
// review_packet.json artifact and emits a compact GitHub Markdown comment.
// Hard M6 constraints honored here:
//   - It never recomputes the pipeline (no intent/evaluate/risks logic runs).
//   - It never redefines the core artifact contract; it only consumes the
//     already-written ReviewPacket shape.
//   - The default path requires no network/hosted access; it just reads a file.
//
// The first line is an HTML comment carrying review-surfaces:sticky so CI (or a
// later `--post` path) can find-and-upsert a single sticky comment per PR.
// Output is byte-deterministic: same packet in -> same comment out (no clock,
// no environment), and every section is capped so the comment stays well under
// a typical PR comment size.
// ---------------------------------------------------------------------------

export const STICKY_MARKER = "<!-- review-surfaces:sticky -->";

// Per-section caps keep the comment review-sized. These are deliberately small:
// the comment is a pointer to the full local packet, not a replacement for it.
const MAX_REVIEW_FOCUS = 5;
const MAX_RISKS = 5;
const MAX_NON_SATISFIED = 6;
const MAX_HYPOTHESES = 6;

export interface RenderedComment {
  markdown: string;
  packetPath: string;
}

/**
 * Resolve the review_packet.json path under an output directory (default
 * .review-surfaces, honoring --out). A directory resolves to
 * <dir>/review_packet.json; an explicit .json path is used as-is.
 */
export function resolvePacketPath(cwd: string, outDir?: string): string {
  const base = path.resolve(cwd, outDir ?? ".review-surfaces");
  return base.endsWith(".json") ? base : path.join(base, "review_packet.json");
}

/**
 * Load the local review_packet.json and render a compact sticky GitHub comment.
 * Returns null when the packet is absent so the caller can emit a clean usage
 * error suggesting `review-surfaces all` WITHOUT recomputing anything here.
 */
export function renderCommentFromPacketFile(cwd: string, outDir?: string): RenderedComment | null {
  const packetPath = resolvePacketPath(cwd, outDir);
  if (!fileExists(packetPath)) {
    return null;
  }
  const packet = JSON.parse(fs.readFileSync(packetPath, "utf8")) as ReviewPacket;
  return {
    markdown: renderComment(packet),
    packetPath
  };
}

/**
 * Render the compact sticky comment from an in-memory packet. Pure: no IO, no
 * clock, deterministic given the packet. Secrets are redacted in every rendered
 * free-text line, mirroring the packet markdown renderer.
 */
export function renderComment(packet: ReviewPacket): string {
  const counts = countRequirementStatuses(packet.evaluation.results ?? []);
  const overreachCount = packet.evaluation.overreach?.length ?? 0;
  const milestone = readMilestone(packet);

  const sections: string[] = [
    STICKY_MARKER,
    `## review-surfaces${milestone ? ` (${redact(milestone)})` : ""}`,
    `Status: ${formatRequirementStatusSummary(counts, overreachCount)}.`,
    "",
    "### Top review focus",
    renderBullets(reviewFocus(packet, MAX_REVIEW_FOCUS), "No review focus generated."),
    "",
    "### Top risks",
    renderBullets(topRisks(packet, MAX_RISKS), "No risks recorded."),
    "",
    "### Requirement coverage",
    renderBullets(coverageLines(packet, counts, overreachCount), "No requirements indexed."),
    "",
    "### LLM/agent hypotheses (NOT proof; verify against deterministic evidence)",
    renderBullets(hypotheses(packet, MAX_HYPOTHESES), "None proposed."),
    "",
    "Full local packet: `.review-surfaces/review_packet.md` (machine-readable: `.review-surfaces/review_packet.json`)."
  ];

  // Single trailing newline so two renders of the same packet are byte-identical.
  return `${sections.join("\n")}\n`;
}

function readMilestone(packet: ReviewPacket): string | undefined {
  const milestone = packet.dogfood?.milestone ?? packet.manifest?.milestone;
  return typeof milestone === "string" && milestone.trim() !== "" ? milestone : undefined;
}

function reviewFocus(packet: ReviewPacket, limit: number): string[] {
  return (packet.risks?.review_focus ?? []).slice(0, limit).map((item) => redact(item));
}

function topRisks(packet: ReviewPacket, limit: number): string[] {
  return (packet.risks?.items ?? [])
    .slice(0, limit)
    .map((risk) => redact(`${risk.id} [${risk.severity}]: ${risk.summary}`));
}

// Compact coverage: the count summary line plus a few NON-satisfied requirement
// statuses (the ones a reviewer should look at first). Capped and overflow-noted.
function coverageLines(
  packet: ReviewPacket,
  counts: ReturnType<typeof countRequirementStatuses>,
  overreachCount: number
): string[] {
  const lines: string[] = [
    `satisfied ${counts.satisfied} | partial ${counts.partial} | missing ${counts.missing} | unknown ${counts.unknown} | invalid_evidence ${counts.invalid_evidence} | overreach ${overreachCount}`
  ];
  const nonSatisfied = (packet.evaluation.results ?? []).filter((result) => result.status !== "satisfied");
  for (const result of nonSatisfied.slice(0, MAX_NON_SATISFIED)) {
    const id = result.acai_id ?? result.requirement_id;
    lines.push(redact(`${id}: ${result.status} - ${result.summary}`));
  }
  if (nonSatisfied.length > MAX_NON_SATISFIED) {
    lines.push(`... ${nonSatisfied.length - MAX_NON_SATISFIED} more in review_packet.json`);
  }
  return lines;
}

// review-surfaces.EVIDENCE.6: surface LLM/agent-proposed material CLEARLY labeled
// as hypotheses (the section header says so) and never presented as proof.
function hypotheses(packet: ReviewPacket, limit: number): string[] {
  const lines: string[] = [];
  for (const requirement of packet.intent?.requirements ?? []) {
    if (requirement.llm_derived) {
      lines.push(`requirement ${requirement.id}: ${requirement.requirement}`);
    }
  }
  for (const result of packet.evaluation?.results ?? []) {
    for (const ref of [...(result.evidence ?? []), ...(result.missing_evidence ?? [])]) {
      if (ref.llm_proposed === true) {
        lines.push(`${result.acai_id ?? result.requirement_id} [${ref.validation_status ?? "unknown"}]: ${ref.path ?? ref.note ?? ref.kind}`);
      }
    }
  }
  for (const item of packet.risks?.items ?? []) {
    if ((item.evidence ?? []).some((ref) => ref.llm_proposed === true)) {
      lines.push(`${item.id}: ${item.summary}`);
    }
  }
  const visible = lines.slice(0, limit).map((line) => redact(line));
  if (lines.length > limit) {
    visible.push(`... ${lines.length - limit} more in review_packet.json`);
  }
  return visible;
}

function renderBullets(items: string[], emptyText: string): string {
  if (items.length === 0) {
    return `- ${emptyText}`;
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function redact(value: string): string {
  return redactSecrets(value).text;
}
