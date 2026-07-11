import { ACID_PATTERN } from "../core/acai";
import type { StructuredDiff } from "../contracts/pr-review";

interface IntentLike {
  requirements: Array<{ id: string; acai_id?: string; requirement: string }>;
}

/** One authoritative exact/text mapping from a reviewed range to intent keys. */
export function affectedRequirementKeysForRange(intent: IntentLike, diff: StructuredDiff | undefined): Set<string> {
  const keys = changedAcidKeys(diff);
  const changedText = normalizedChangedText(diff);
  for (const requirement of intent.requirements) {
    const acidMatched = requirement.acai_id !== undefined && keys.has(requirement.acai_id);
    const requirementText = normalizeText(requirement.requirement);
    const textMatched = requirementText.length >= 24 && changedText.includes(requirementText);
    if (!acidMatched && !textMatched) continue;
    keys.add(requirement.id);
    if (requirement.acai_id) keys.add(requirement.acai_id);
  }
  return keys;
}

export function changedLineAcidKeys(text: string): string[] {
  return [...text.matchAll(ACID_PATTERN)]
    .filter((match) => isWholeAcidToken(text, match.index ?? 0, match[0]))
    .map((match) => match[0]);
}

function changedAcidKeys(diff: StructuredDiff | undefined): Set<string> {
  const keys = new Set<string>();
  for (const file of diff?.files ?? []) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "context") continue;
        for (const key of changedLineAcidKeys(line.text)) keys.add(key);
      }
    }
  }
  return keys;
}

function normalizedChangedText(diff: StructuredDiff | undefined): string {
  if (!diff) return "";
  return normalizeText(diff.files.flatMap((file) =>
    file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind !== "context").map((line) => line.text))
  ).join(" "));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, " ").trim();
}

function isWholeAcidToken(text: string, index: number, acid: string): boolean {
  const before = index > 0 ? text[index - 1] : "";
  return !isAcidPrefixChar(before) && !isAcidSuffixContinuation(text, index + acid.length);
}

function isAcidPrefixChar(ch: string): boolean {
  return ch !== "" && /[A-Za-z0-9_.-]/.test(ch);
}

function isAcidSuffixContinuation(text: string, index: number): boolean {
  const ch = index < text.length ? text[index] : "";
  if (ch === "") return false;
  if (/[A-Za-z0-9_-]/.test(ch)) return true;
  if (ch !== ".") return false;
  const next = index + 1 < text.length ? text[index + 1] : "";
  return /[A-Za-z0-9_-]/.test(next);
}
