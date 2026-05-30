import { EvidenceRef } from "../evidence/evidence";
import { IntentRequirement } from "../intent/intent";

export const ACID_PATTERN = /[a-z0-9_-]+\.[A-Z0-9_]+\.[0-9]+(?:-[0-9]+)?/g;

export function groupFromAcid(acaiId: string | undefined): string | undefined {
  return acaiId?.split(".")[1];
}

export function isTestOnlyRequirement(requirement: IntentRequirement, group: string | undefined): boolean {
  return group === "QUALITY" && /\btests?\b/i.test(requirement.requirement);
}

export function isImplementationEvidencePath(filePath: string, testPaths: Set<string>): boolean {
  if (testPaths.has(filePath)) {
    return false;
  }
  if (
    filePath.startsWith("docs/") ||
    filePath.startsWith("features/") ||
    filePath.startsWith(".agents/") ||
    filePath.startsWith(".review-surfaces/") ||
    filePath === "AGENTS.md" ||
    filePath === "CLAUDE.md" ||
    filePath.startsWith("README")
  ) {
    return false;
  }
  return true;
}

export function mentionsGroupToken(haystack: string, group: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(group)}([^A-Za-z0-9_]|$)`).test(haystack);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function uniqueEvidence(values: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const result: EvidenceRef[] = [];
  for (const value of values) {
    const key = `${value.kind}:${value.path ?? ""}:${value.acai_id ?? ""}:${value.note ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result.slice(0, 8);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
