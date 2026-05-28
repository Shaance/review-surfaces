import fs from "node:fs";
import path from "node:path";
import { relativePath, toPosixPath } from "./files";

const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".pnpm-store"]);

export interface WalkOptions {
  isIgnored?: (relativePath: string) => boolean;
}

export async function expandPatterns(cwd: string, patterns: string[], options: WalkOptions = {}): Promise<string[]> {
  const files = await walkFiles(cwd, options);
  const regexes = patterns.map(globToRegExp);
  return files.filter((filePath) => regexes.some((regex) => regex.test(filePath))).sort();
}

export async function walkFiles(cwd: string, options: WalkOptions = {}): Promise<string[]> {
  const result: string[] = [];

  async function visit(dirPath: string): Promise<void> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store" || entry.name === ".git") {
        continue;
      }
      const absolutePath = path.join(dirPath, entry.name);
      const relative = relativePath(cwd, absolutePath);
      if (options.isIgnored?.(relative)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) {
          await visit(absolutePath);
        }
      } else if (entry.isFile()) {
        result.push(relative);
      }
    }
  }

  await visit(cwd);
  return result.sort();
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = toPosixPath(pattern);
  let output = "^";
  let i = 0;

  while (i < normalized.length) {
    const char = normalized[i];
    const next = normalized[i + 1];
    const afterNext = normalized[i + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      output += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (char === "*" && next === "*") {
      output += ".*";
      i += 2;
      continue;
    }
    if (char === "*") {
      output += "[^/]*";
      i += 1;
      continue;
    }

    output += escapeRegExp(char);
    i += 1;
  }

  output += "$";
  return new RegExp(output);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
