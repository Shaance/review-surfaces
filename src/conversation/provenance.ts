import path from "node:path";

export interface ConversationProvenanceContext {
  cwd: string;
  changedFiles: string[];
  headSha?: string;
  rangeCommitShas?: string[];
}

export interface ConversationProvenance {
  mutatedPaths: string[];
  readPaths: string[];
  mentionedPaths: string[];
  observedCommitShas: string[];
  firstTimestamp?: string;
  lastTimestamp?: string;
  lastMutationTimestamp?: string;
  auditOnly: boolean;
}

export interface MutableConversationProvenance {
  mutatedPaths: Set<string>;
  readPaths: Set<string>;
  mentionedPaths: Set<string>;
  observedCommitShas: Set<string>;
  firstTimestamp?: string;
  lastTimestamp?: string;
  lastMutationTimestamp?: string;
  sawReadTool: boolean;
  sawReviewCommand: boolean;
}

interface ExactPathMatcher {
  file: string;
  relative: RegExp;
  absolute: RegExp;
}

const exactPathMatcherCache = new WeakMap<ConversationProvenanceContext, ExactPathMatcher[]>();

export function emptyConversationProvenance(): MutableConversationProvenance {
  return {
    mutatedPaths: new Set(),
    readPaths: new Set(),
    mentionedPaths: new Set(),
    observedCommitShas: new Set(),
    sawReadTool: false,
    sawReviewCommand: false
  };
}

export function finishConversationProvenance(value: MutableConversationProvenance): ConversationProvenance {
  const sort = (items: Set<string>): string[] => [...items].sort();
  return {
    mutatedPaths: sort(value.mutatedPaths),
    readPaths: sort(value.readPaths),
    mentionedPaths: sort(value.mentionedPaths),
    observedCommitShas: sort(value.observedCommitShas),
    ...(value.firstTimestamp ? { firstTimestamp: value.firstTimestamp } : {}),
    ...(value.lastTimestamp ? { lastTimestamp: value.lastTimestamp } : {}),
    ...(value.lastMutationTimestamp ? { lastMutationTimestamp: value.lastMutationTimestamp } : {}),
    auditOnly: value.mutatedPaths.size === 0 && (value.sawReadTool || value.sawReviewCommand)
  };
}

export function recordTimestamp(value: MutableConversationProvenance, timestamp: unknown): void {
  if (typeof timestamp !== "string" || timestamp === "") return;
  if (value.firstTimestamp === undefined || timestamp < value.firstTimestamp) value.firstTimestamp = timestamp;
  if (value.lastTimestamp === undefined || timestamp > value.lastTimestamp) value.lastTimestamp = timestamp;
}

export function recordMutationTimestamp(value: MutableConversationProvenance, timestamp: unknown): void {
  recordTimestamp(value, timestamp);
  if (typeof timestamp === "string" && (value.lastMutationTimestamp === undefined || timestamp > value.lastMutationTimestamp)) {
    value.lastMutationTimestamp = timestamp;
  }
}

export function reviewedPath(value: unknown, context: ConversationProvenanceContext): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim().replace(/^['"]|['"]$/g, "");
  if (raw === "") return undefined;
  const normalized = raw.replace(/\\/g, "/");
  const absoluteCwd = path.resolve(context.cwd).replace(/\\/g, "/").replace(/\/$/, "");
  const repoRelative = normalized.startsWith(`${absoluteCwd}/`)
    ? normalized.slice(absoluteCwd.length + 1)
    : normalized.replace(/^\.\//, "");
  return context.changedFiles.find((file) => file === repoRelative);
}

export function exactMentionedPaths(text: unknown, context: ConversationProvenanceContext): string[] {
  if (typeof text !== "string" || text === "") return [];
  const normalized = text.replace(/\\/g, "/");
  const matches: string[] = [];
  for (const matcher of exactPathMatchers(context)) {
    if (matcher.relative.test(normalized) || matcher.absolute.test(normalized)) {
      matches.push(matcher.file);
    }
  }
  return matches;
}

function exactTokenPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s\\"'({[=:])${escaped}(?=$|[\\s\\"')}\\],:;!?])`, "m");
}

function exactPathMatchers(context: ConversationProvenanceContext): ExactPathMatcher[] {
  const cached = exactPathMatcherCache.get(context);
  if (cached) return cached;
  const matchers = context.changedFiles.filter(Boolean).map((file) => ({
    file,
    relative: exactTokenPattern(file),
    absolute: exactTokenPattern(path.resolve(context.cwd, file).replace(/\\/g, "/"))
  }));
  exactPathMatcherCache.set(context, matchers);
  return matchers;
}

export function patchMutationPaths(text: unknown, context: ConversationProvenanceContext): string[] {
  if (typeof text !== "string") return [];
  const paths: string[] = [];
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm)) {
    const reviewed = reviewedPath(match[1], context);
    if (reviewed) paths.push(reviewed);
  }
  return [...new Set(paths)].sort();
}

export function structuredText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(structuredText).filter(Boolean).join("\n");
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(structuredText).filter(Boolean).join("\n");
  }
  return "";
}

export function recordCommitReferences(
  value: MutableConversationProvenance,
  text: unknown,
  context: ConversationProvenanceContext
): void {
  if (typeof text !== "string") return;
  for (const sha of [context.headSha, ...(context.rangeCommitShas ?? [])]) {
    if (!sha || sha === "unknown") continue;
    const short = sha.slice(0, 7);
    if (hasShaToken(text, sha) || (short.length === 7 && hasShaToken(text, short))) value.observedCommitShas.add(sha);
  }
}

function hasShaToken(text: string, sha: string): boolean {
  const escaped = sha.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^0-9a-f])${escaped}(?=$|[^0-9a-f])`, "i").test(text);
}

export function looksLikeMutationTool(name: string): boolean {
  return /(?:^|__|\.)?(?:apply_patch|edit|write|multiedit|notebookedit)$/i.test(name);
}

export function looksLikeReadTool(name: string): boolean {
  return /(?:read|view|open|search|find|grep|glob|rg|git_diff|git_show)/i.test(name);
}

export function looksLikeReviewCommand(value: unknown): boolean {
  return typeof value === "string" && /(?:@codex\s+review|\bcodex\s+review\b|\bgh\s+pr\s+(?:view|diff|checks)|\bgit\s+(?:diff|show)\b)/i.test(value);
}
