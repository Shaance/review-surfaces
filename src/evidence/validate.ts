import fs from "node:fs";
import path from "node:path";
import { EvidenceRef, missingEvidence } from "./evidence";
import type { RequirementResult } from "../evaluation/evaluate";

export interface EvidenceValidationContext {
  cwd: string;
  knownAcids?: Set<string>;
  knownPaths?: Set<string>;
  knownCommands?: Set<string>;
  // review-surfaces.METHODOLOGY.7 (D5): the deterministic event-id allowlist —
  // conversation event ids + command transcript ids + feedback finding ids. A
  // cited event_id must be a member, exactly like knownAcids gates acai_id.
  knownEventIds?: Set<string>;
  pathExistsCache?: Map<string, boolean>;
  lineCountCache?: Map<string, number>;
}

const PATH_BACKED_KINDS = new Set(["file", "diff", "test", "doc", "spec", "conversation", "feedback", "agent_instruction"]);
const ACID_PATTERN = /^[a-z0-9_-]+\.[A-Z0-9_]+\.[0-9]+(-[0-9]+)?$/;

export function validateEvidenceRef(ref: EvidenceRef, context: EvidenceValidationContext): EvidenceRef {
  const invalidReasons: string[] = [];

  if (ref.path) {
    const normalizedPath = normalizeEvidencePath(ref.path);
    const resolvedPath = path.resolve(context.cwd, normalizedPath);
    if (!isSafeRepositoryPath(ref.path, normalizedPath, resolvedPath, context.cwd)) {
      invalidReasons.push("path must be repository-relative");
    } else if (PATH_BACKED_KINDS.has(ref.kind)) {
      const pathKnown = context.knownPaths?.has(normalizedPath) ?? false;
      const hasLineRange = ref.line_start !== undefined || ref.line_end !== undefined;
      const exists = pathKnown && !hasLineRange ? true : pathExists(resolvedPath, context);
      if (!exists && !pathKnown) {
        invalidReasons.push("path does not exist in the repository or collected change set");
      }
      if (hasLineRange) {
        if (!exists) {
          invalidReasons.push("line range cannot be checked because the referenced file does not exist");
        } else {
          const lineCount = fileLineCount(resolvedPath, context);
          if (!validLineRange(ref.line_start, ref.line_end, lineCount)) {
            invalidReasons.push("line range is outside the referenced file");
          }
        }
      }
    }
  }

  if (ref.acai_id) {
    if (!ACID_PATTERN.test(ref.acai_id)) {
      invalidReasons.push("ACID format is invalid");
    } else if (context.knownAcids && !context.knownAcids.has(ref.acai_id)) {
      invalidReasons.push("ACID is not present in the collected intent");
    }
  }

  if (ref.command && context.knownCommands && !context.knownCommands.has(ref.command)) {
    invalidReasons.push("command was not recorded in this run");
  }

  // review-surfaces.METHODOLOGY.7 (D5): an event_id must be a real collected
  // event (conversation/command/feedback), paralleling the knownAcids check.
  // Without this, a hallucinated event_id was stamped valid (it was wholly
  // unvalidated before this uplift).
  if (ref.event_id && context.knownEventIds && !context.knownEventIds.has(ref.event_id)) {
    invalidReasons.push("event_id is not present in the collected conversation/command/feedback events");
  }

  // review-surfaces.METHODOLOGY.7: a conversation-kind ref must bind to a real
  // event id — path membership ALONE must not validate it. Require an event_id
  // (and, when the allowlist is supplied, that it is known). Closes the
  // path-fall-through where a conversation ref with a valid-looking repo path but
  // no/unknown event_id was stamped valid.
  if (ref.kind === "conversation" && !ref.event_id) {
    invalidReasons.push("conversation evidence must cite an event_id (path membership alone is insufficient)");
  }

  if (ref.url) {
    try {
      new URL(ref.url);
    } catch {
      invalidReasons.push("URL is invalid");
    }
  }

  if (invalidReasons.length > 0) {
    return {
      ...ref,
      validation_status: "invalid",
      note: appendValidationNote(ref.note, invalidReasons)
    };
  }

  if (ref.kind === "unknown" && !ref.path && !ref.acai_id && !ref.command && !ref.url) {
    return { ...ref, validation_status: ref.validation_status ?? "unknown" };
  }

  return { ...ref, validation_status: "valid" };
}

export function validateRequirementResultEvidence(
  result: RequirementResult,
  context: EvidenceValidationContext
): RequirementResult {
  const evidence = result.evidence.map((ref) => validateEvidenceRef(ref, context));
  const missing_evidence = result.missing_evidence.map((ref) => validateEvidenceRef(ref, context));
  const invalidEvidence = [...evidence, ...missing_evidence].filter((ref) => ref.validation_status === "invalid");

  if (invalidEvidence.length === 0) {
    return { ...result, evidence, missing_evidence };
  }

  return {
    ...result,
    status: "invalid_evidence",
    // The result is no longer partial, so drop any partial sub-reason rather
    // than leaving a stale field that contradicts the new status.
    partial_reason: undefined,
    summary: "One or more evidence references failed deterministic validation.",
    evidence,
    missing_evidence: [
      ...missing_evidence,
      missingEvidence("Fix or remove invalid evidence references before using this requirement result as proof.")
    ],
    review_focus: "Inspect invalid evidence references before judging requirement coverage.",
    confidence: "high"
  };
}

export function normalizeEvidencePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function isSafeRepositoryPath(originalPath: string, normalizedPath: string, resolvedPath: string, cwd: string): boolean {
  if (!normalizedPath || path.isAbsolute(originalPath) || normalizedPath.split("/").includes("..")) {
    return false;
  }
  const root = path.resolve(cwd);
  return resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`);
}

function pathExists(filePath: string, context: EvidenceValidationContext): boolean {
  const cache = context.pathExistsCache ?? new Map<string, boolean>();
  context.pathExistsCache = cache;
  const cached = cache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  const exists = fs.existsSync(filePath);
  cache.set(filePath, exists);
  return exists;
}

function fileLineCount(filePath: string, context: EvidenceValidationContext): number {
  const cache = context.lineCountCache ?? new Map<string, number>();
  context.lineCountCache = cache;
  const cached = cache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
  cache.set(filePath, lines.length);
  return lines.length;
}

function validLineRange(lineStart: number | undefined, lineEnd: number | undefined, lineCount: number): boolean {
  if (lineStart === undefined && lineEnd === undefined) {
    return true;
  }
  const start = lineStart ?? lineEnd;
  const end = lineEnd ?? lineStart;
  return start !== undefined && end !== undefined && start >= 1 && end >= start && end <= lineCount;
}

function appendValidationNote(note: string | undefined, reasons: string[]): string {
  const suffix = `Invalid evidence: ${reasons.join("; ")}.`;
  return note ? `${note} ${suffix}` : suffix;
}
