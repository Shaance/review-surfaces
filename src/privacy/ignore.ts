import fs from "node:fs";
import path from "node:path";
import { fileExists, readText, toPosixPath } from "../core/files";
import { globToRegExp } from "../core/glob";
import { unique } from "../core/guards";

export const DEFAULT_PRIVACY_IGNORE_PATTERNS = [
  ".env",
  ".env.*",
  "!.env.example",
  "**/.dev.vars",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  // review-surfaces.PRIVACY.8: Apple signing/provisioning material, per-user Xcode
  // state, and build caches are excluded by default. Reviewable service-plist /
  // entitlement / project TEXT is intentionally NOT excluded here — it stays
  // available to deterministic detectors and is protected by redact-before-persist
  // and block-before-remote instead. The signing-extension and build-cache sets
  // mirror src/collector/source-kind.ts (isAppleSigningArtifactPath /
  // isAppleGeneratedPath) so anything the classifier marks private is also never
  // persisted in changed_files / diff.patch.
  "**/*.mobileprovision",
  "**/*.provisionprofile",
  "**/*.p12",
  "**/*.cer",
  "**/*.certSigningRequest",
  "**/*.keychain",
  "**/*.xcuserstate",
  "**/xcuserdata/**",
  "**/DerivedData/**",
  "**/.build/**",
  "**/SourcePackages/**",
  "**/.swiftpm/**",
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

  // Match the privacy boundary case-INSENSITIVELY: the shared source-kind classifier
  // lowercases basenames before classifying signing/cache artifacts, so a changed
  // `CI.CER` / `Cert.P12` / `foo.CERTSIGNINGREQUEST` must be dropped here too — never
  // persisted to changed_files / diff.patch on a case-sensitive checkout (PRIVACY.8).
  const base = globToRegExp(pattern);
  const regex = base.flags.includes("i") ? base : new RegExp(base.source, `${base.flags}i`);

  return {
    pattern,
    negate,
    directoryOnly,
    hasSlash,
    regex
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

// Synchronous variant for sync build paths (the blast-radius graph): same
// default + file patterns, default ignore-file name.
export function loadPrivacyIgnoreSync(cwd: string, ignoreFile = ".review-surfacesignore"): PrivacyIgnoreRules {
  const ignorePath = path.resolve(cwd, ignoreFile);
  let fileText = "";
  try {
    fileText = fs.readFileSync(ignorePath, "utf8");
  } catch {
    fileText = "";
  }
  const patterns = unique([...DEFAULT_PRIVACY_IGNORE_PATTERNS, ...parseIgnoreFile(fileText)]);
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
