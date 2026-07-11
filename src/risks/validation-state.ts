import type { EvidenceRef } from "../contracts/evidence";
import type { PacketTestEvidenceKind } from "../schema/review-packet-contract";

export type ValidationRunState = "passed" | "failed" | "skipped" | "unknown";

interface ValidationEvidenceItem {
  kind: PacketTestEvidenceKind;
  summary: string;
  evidence?: EvidenceRef[];
}

/** Classify producer-owned validation evidence without interpreting incidental prose. */
export function classifyValidationRunState(item: ValidationEvidenceItem): ValidationRunState {
  if (item.evidence?.some((ref) => ref.validation_status === "invalid")) return "failed";
  if (item.kind === "direct" || item.kind === "indirect") return "passed";
  if (/^Parsed test skipped:/i.test(item.summary) || /^Validation (?:was )?skipped\b/i.test(item.summary)) return "skipped";
  if (item.kind !== "missing") return "unknown";
  const commandText = [
    item.summary,
    ...(item.evidence ?? []).filter((ref) => ref.kind === "command").flatMap((ref) => [ref.note, ref.command])
  ].join(" ");
  if (/\b(fail(?:ed|ing)?|error)\b/i.test(item.summary)) return "failed";
  if (/\b(?:exit(?:_code)?=|exit\s+)(?:[1-9]\d*)\b/i.test(commandText) || /\bstatus=failed\b/i.test(commandText)) return "failed";
  return "unknown";
}
