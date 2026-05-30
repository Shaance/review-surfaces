import path from "node:path";
import { fileExists, readText, toPosixPath } from "../core/files";
import { globToRegExp } from "../core/glob";

export const DEFAULT_PRIVACY_IGNORE_PATTERNS = [
  ".env",
  ".env.*",
  "!.env.example",
  "**/.dev.vars",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  ".claude/",
  ".review-surfaces/feedback/raw/**",
  ".review-surfaces/inputs/conversation.raw.*"
];

export interface PrivacyIgnoreRules {
  ignoreFile: string;
  patterns: string[];
  isIgnored(filePath: string): boolean;
}

interface IgnoreRule {
  pattern: string;
  negate: boolean;
  directoryOnly: boolean;
  hasSlash: boolean;
  regex: RegExp;
}

export async function loadPrivacyIgnore(cwd: string, ignoreFile: string): Promise<PrivacyIgnoreRules> {
  const ignorePath = path.resolve(cwd, ignoreFile);
  const filePatterns = fileExists(ignorePath) ? parseIgnoreFile(await readText(ignorePath)) : [];
  const patterns = unique([...DEFAULT_PRIVACY_IGNORE_PATTERNS, ...filePatterns]);
  const rules = patterns.map(compileRule);

  return {
    ignoreFile,
    patterns,
    isIgnored(filePath: string): boolean {
      const normalized = normalizeRelativePath(filePath);
      let ignored = false;
      for (const rule of rules) {
        if (matchesRule(rule, normalized)) {
          ignored = !rule.negate;
        }
      }
      return ignored;
    }
  };
}

export function parseIgnoreFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function compileRule(rawPattern: string): IgnoreRule {
  const negate = rawPattern.startsWith("!");
  let pattern = negate ? rawPattern.slice(1) : rawPattern;
  pattern = normalizeRelativePath(pattern);
  const directoryOnly = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/, "");
  const hasSlash = pattern.includes("/");

  return {
    pattern,
    negate,
    directoryOnly,
    hasSlash,
    regex: globToRegExp(pattern)
  };
}

function matchesRule(rule: IgnoreRule, filePath: string): boolean {
  if (!rule.hasSlash) {
    const segments = filePath.split("/");
    if (rule.directoryOnly) {
      return segments.some((segment) => rule.regex.test(segment));
    }
    return rule.regex.test(segments[segments.length - 1] ?? filePath);
  }

  if (rule.regex.test(filePath)) {
    return true;
  }

  if (rule.directoryOnly && !hasGlob(rule.pattern)) {
    return filePath === rule.pattern || filePath.startsWith(`${rule.pattern}/`);
  }

  return false;
}

function hasGlob(pattern: string): boolean {
  return pattern.includes("*");
}

function normalizeRelativePath(filePath: string): string {
  return toPosixPath(filePath).replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
