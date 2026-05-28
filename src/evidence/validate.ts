import fs from "node:fs";
import path from "node:path";
import { EvidenceRef, missingEvidence } from "./evidence";
import type { RequirementResult } from "../evaluation/evaluate";

export interface EvidenceValidationContext {
  cwd: string;
  knownAcids?: Set<string>;
  knownPaths?: Set<string>;
  knownCommands?: Set<string>;
}

const PATH_BACKED_KINDS = new Set(["file", "diff", "test", "doc", "spec", "conversation", "feedback", "agent_instruction"]);
const ACID_PATTERN = /^[a-z0-9_-]+\.[A-Z0-9_]+\.[0-9]+(-[0-9]+)?$/;

export function validateEvidenceRef(ref: EvidenceRef, context: EvidenceValidationContext): EvidenceRef {
  const invalidReasons: string[] = [];

  if (ref.path) {
    const normalizedPath = normalizeEvidencePath(ref.path);
    if (!normalizedPath || normalizedPath.startsWith("../") || path.isAbsolute(ref.path)) {
      invalidReasons.push("path must be repository-relative");
    } else if (PATH_BACKED_KINDS.has(ref.kind)) {
      const absolutePath = path.resolve(context.cwd, normalizedPath);
      const pathKnown = context.knownPaths?.has(normalizedPath) ?? false;
      const exists = fs.existsSync(absolutePath);
      if (!exists && !pathKnown) {
        invalidReasons.push("path does not exist in the repository or collected change set");
      }
      if ((ref.line_start !== undefined || ref.line_end !== undefined) && exists) {
        const lineCount = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/).length;
        if (!validLineRange(ref.line_start, ref.line_end, lineCount)) {
          invalidReasons.push("line range is outside the referenced file");
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

function normalizeEvidencePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
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
