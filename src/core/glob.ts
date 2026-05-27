import fs from "node:fs";
import path from "node:path";
import { relativePath, toPosixPath } from "./files";

const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".pnpm-store"]);

export async function expandPatterns(cwd: string, patterns: string[]): Promise<string[]> {
  const files = await walkFiles(cwd);
  const regexes = patterns.map(globToRegExp);
  return files.filter((filePath) => regexes.some((regex) => regex.test(filePath))).sort();
}

export async function walkFiles(cwd: string): Promise<string[]> {
  const result: string[] = [];

  async function visit(dirPath: string): Promise<void> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store") {
        continue;
      }
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) {
          await visit(absolutePath);
        }
      } else if (entry.isFile()) {
        result.push(relativePath(cwd, absolutePath));
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
