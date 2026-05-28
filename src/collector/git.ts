import path from "node:path";
import { execFileSync } from "node:child_process";
import { isRegularFile } from "../core/files";

export interface GitInfo {
  repo: string;
  base_ref: string;
  head_ref: string;
  base_sha?: string;
  head_sha: string;
}

export interface ChangedFile {
  path: string;
  status: string;
  source: "diff" | "working_tree";
}

export function collectGitInfo(cwd: string, baseRef: string, headRef: string): GitInfo {
  return {
    repo: remoteRepoName(cwd),
    base_ref: baseRef,
    head_ref: headRef,
    base_sha: revParse(cwd, baseRef),
    head_sha: revParse(cwd, headRef) ?? revParse(cwd, "HEAD") ?? "unknown"
  };
}

export function collectChangedFiles(cwd: string, baseRef: string, headRef: string): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  const diffOutput = git(cwd, ["diff", "--name-status", `${baseRef}...${headRef}`]) ?? git(cwd, ["diff", "--name-status"]);
  if (diffOutput) {
    for (const line of diffOutput.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const [status, filePath] = line.split(/\s+/, 2);
      if (filePath) {
        byPath.set(filePath, { path: filePath, status, source: "diff" });
      }
    }
  }

  const statusOutput = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (statusOutput) {
    for (const line of statusOutput.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const status = line.slice(0, 2).trim() || "modified";
      const filePath = line.slice(3).trim();
      if (filePath && !filePath.endsWith("/") && !byPath.has(filePath) && filePath !== ".DS_Store" && isRegularFile(path.resolve(cwd, filePath))) {
        byPath.set(filePath, { path: filePath, status, source: "working_tree" });
      }
    }
  }

  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function collectDiff(cwd: string, baseRef: string, headRef: string): string {
  const parts = [
    git(cwd, ["diff", `${baseRef}...${headRef}`]),
    git(cwd, ["diff", "--cached"]),
    git(cwd, ["diff"])
  ].filter((part): part is string => Boolean(part));
  return parts.join("\n");
}

export function collectCommits(cwd: string, baseRef: string, headRef: string): Array<Record<string, string>> {
  const output = git(cwd, ["log", "--format=%H%x09%s", `${baseRef}...${headRef}`]);
  if (!output) {
    return [];
  }
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject = ""] = line.split("\t");
      return { sha, subject };
    });
}

function remoteRepoName(cwd: string): string {
  const remoteUrl = git(cwd, ["remote", "get-url", "origin"]);
  if (!remoteUrl) {
    return "unknown";
  }
  const trimmed = remoteUrl.trim();
  const httpsMatch = trimmed.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return httpsMatch ? httpsMatch[1] : trimmed;
}

function revParse(cwd: string, ref: string): string | undefined {
  return git(cwd, ["rev-parse", "--verify", ref])?.trim();
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
  } catch {
    return undefined;
  }
}
