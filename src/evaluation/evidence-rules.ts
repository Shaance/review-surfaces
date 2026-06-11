import { EvidenceRef } from "../evidence/evidence";
import { IntentRequirement } from "../intent/intent";

export const ACID_PATTERN = /[a-z0-9_-]+\.[A-Z0-9_]+\.[0-9]+(?:-[0-9]+)?/g;

export function groupFromAcid(acaiId: string | undefined): string | undefined {
  return acaiId?.split(".")[1];
}

export function isTestOnlyRequirement(requirement: IntentRequirement, group: string | undefined): boolean {
  return group === "QUALITY" && /\btests?\b/i.test(requirement.requirement);
}

// Paths classified as non-implementation by default (docs, feature specs, agent
// scaffolding, prior review artifacts). Exported because the foreign-repo bias
// guard test imports them, and because a future config seam can override them
// per repository (a foreign repo may keep source under docs/).
export const DEFAULT_NON_IMPLEMENTATION_PREFIXES = [
  "docs/",
  "features/",
  ".agents/",
  ".review-surfaces/"
] as const;
// review-surfaces.config.yaml carries staged ACIDs in quality_gate.allow_missing;
// treating it as implementation would let allowlisting a requirement count as
// shipping it, hiding "missing" from the strict self-dogfood gate.
export const DEFAULT_NON_IMPLEMENTATION_EXACT = ["AGENTS.md", "CLAUDE.md", "review-surfaces.config.yaml"] as const;
// README* matched by the prefix "README" (no slash) — preserves the existing
// startsWith semantics (README.md, README, README.rst all match).
export const DEFAULT_NON_IMPLEMENTATION_STARTS_WITH = ["README"] as const;

// Path-shaped tokens a requirement sentence can cite as repository-presence
// evidence. Bare well-known filenames (no slash) are listed explicitly so
// presence requirements like DISTRIBUTION.1 are satisfiable by the files
// existing rather than by artificial ACID mentions.
export function pathLikeTokens(text: string): string[] {
  return [
    ...new Set(
      text
        .replace(/`/g, "")
        .match(/(?:[\w.-]+\/)+[\w.-]+|AGENTS\.md|CONTRIBUTING\.md|LICENSE|README(?:\.[\w.-]+)?|package\.json|review-surfaces\.config\.yaml/g) ?? []
    )
  ];
}

// A repository-presence requirement ("the repository must contain X and Y") is
// satisfied only when EVERY cited file exists — any-token satisfaction would
// let a phase land with one of two promised files and silence the gate.
export function allPresenceTokensExist(text: string, files: Set<string>): boolean {
  const tokens = pathLikeTokens(text);
  return tokens.length > 0 && tokens.every((token) => files.has(token));
}

export interface ImplementationPathOptions {
  nonImplementationPrefixes?: readonly string[];
  nonImplementationExact?: readonly string[];
  nonImplementationStartsWith?: readonly string[];
}

export function isImplementationEvidencePath(
  filePath: string,
  testPaths: Set<string>,
  options: ImplementationPathOptions = {}
): boolean {
  if (testPaths.has(filePath)) {
    return false;
  }
  const prefixes = options.nonImplementationPrefixes ?? DEFAULT_NON_IMPLEMENTATION_PREFIXES;
  const exact = options.nonImplementationExact ?? DEFAULT_NON_IMPLEMENTATION_EXACT;
  const startsWith = options.nonImplementationStartsWith ?? DEFAULT_NON_IMPLEMENTATION_STARTS_WITH;
  if (prefixes.some((prefix) => filePath.startsWith(prefix))) {
    return false;
  }
  if (exact.includes(filePath)) {
    return false;
  }
  if (startsWith.some((prefix) => filePath.startsWith(prefix))) {
    return false;
  }
  return true;
}

export function mentionsGroupToken(haystack: string, group: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(group)}([^A-Za-z0-9_]|$)`).test(haystack);
}

// Re-exported so evaluate.ts / verification.ts importers keep `from
// "./evidence-rules"`. The plain (no Boolean filter) flavor lives in core/guards.
export { unique } from "../core/guards";

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
