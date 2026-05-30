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
  const diffOutput = git(cwd, ["diff", "--name-status", "-z", `${baseRef}...${headRef}`]) ?? git(cwd, ["diff", "--name-status", "-z"]);
  if (diffOutput) {
    for (const changedFile of parseDiffNameStatusOutput(diffOutput)) {
      byPath.set(changedFile.path, changedFile);
    }
  }

  const statusOutput = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (statusOutput) {
    for (const { status, filePath } of parsePorcelainStatusOutput(statusOutput)) {
      if (filePath && !filePath.endsWith("/") && !byPath.has(filePath) && filePath !== ".DS_Store" && isRegularFile(path.resolve(cwd, filePath))) {
        byPath.set(filePath, { path: filePath, status, source: "working_tree" });
      }
    }
  }

  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function parseDiffNameStatusOutput(output: string): ChangedFile[] {
  const fields = splitNullOutput(output);
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (!status) {
      continue;
    }
    if (isRenameOrCopyStatus(status)) {
      index += 2;
      const filePath = fields[index];
      if (filePath) {
        files.push({ path: filePath, status, source: "diff" });
      }
      continue;
    }
    const filePath = fields[index + 1];
    index += 1;
    if (filePath) {
      files.push({ path: filePath, status, source: "diff" });
    }
  }
  return files;
}

function parsePorcelainStatusOutput(output: string): Array<{ status: string; filePath: string }> {
  const records = splitNullOutput(output);
  const files: Array<{ status: string; filePath: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2).trim() || "modified";
    const filePath = record.slice(3);
    if (filePath) {
      files.push({ status, filePath });
    }
    if (isRenameOrCopyStatus(status)) {
      index += 1;
    }
  }
  return files;
}

function isRenameOrCopyStatus(status: string): boolean {
  return /[RC]/.test(status);
}

function splitNullOutput(output: string): string[] {
  return output.split("\0").filter((field) => field !== "");
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
