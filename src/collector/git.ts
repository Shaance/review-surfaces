import path from "node:path";
import { execFileSync } from "node:child_process";
import { isRegularFile } from "../core/files";
import { compareStrings } from "../core/compare";

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

// R6: whether the changed-file set / diff was derived from the requested
// base...head range or fell back to a bare working-tree diff (e.g. the base ref
// did not resolve). Surfaced to the CLI for stderr diagnostics; never persisted.
export type DiffSource = "range" | "working_tree_fallback";

export interface ChangedFilesResult {
  files: ChangedFile[];
  diffSource: DiffSource;
  diagnostics: string[];
}

export interface DiffResult {
  text: string;
  diffSource: DiffSource;
  diagnostics: string[];
}

export function collectGitInfo(cwd: string, baseRef: string, headRef: string): GitInfo {
  return {
    repo: remoteRepoName(cwd),
    base_ref: baseRef,
    head_ref: headRef,
    base_sha: resolveGitRefSha(cwd, baseRef),
    head_sha: resolveGitRefSha(cwd, headRef) ?? resolveGitRefSha(cwd, "HEAD") ?? "unknown"
  };
}

// R6: diagnostics for the GitInfo resolution step. Separated from collectGitInfo
// so its GitInfo return (embedded in the byte-stable manifest) is unchanged.
// Warns when the directory is not a git repo and when the base ref does not
// resolve to a sha.
export function gitInfoDiagnostics(cwd: string, baseRef: string): string[] {
  const diagnostics: string[] = [];
  if (!isGitRepo(cwd)) {
    diagnostics.push(`not a git repository at ${cwd}; review range and diff are empty`);
    return diagnostics;
  }
  if (resolveGitRefSha(cwd, baseRef) === undefined) {
    diagnostics.push(`base ref "${baseRef}" did not resolve; comparing against the working tree instead`);
  }
  return diagnostics;
}

function isGitRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

export function collectChangedFiles(cwd: string, baseRef: string, headRef: string): ChangedFilesResult {
  const diagnostics: string[] = [];
  const byPath = new Map<string, ChangedFile>();
  // Behavior-preserving: the original used `range ?? bare`, which only fell
  // through on undefined (a git error), NOT on an empty-but-successful range
  // diff ("" is not nullish). We replicate that: fall back to the bare
  // working-tree diff only when the range command errors.
  const rangeOutput = git(cwd, ["diff", "--name-status", "-z", `${baseRef}...${headRef}`]);
  let diffSource: DiffSource = "range";
  let diffOutput = rangeOutput;
  if (rangeOutput === undefined) {
    diffSource = "working_tree_fallback";
    diffOutput = git(cwd, ["diff", "--name-status", "-z"]);
    diagnostics.push(`could not diff ${baseRef}...${headRef}; fell back to working-tree changes`);
  }
  if (diffOutput) {
    for (const changedFile of parseDiffNameStatusOutput(diffOutput)) {
      byPath.set(changedFile.path, changedFile);
    }
  }

  const statusOutput = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (statusOutput) {
    for (const { status, filePath } of parsePorcelainStatusOutput(statusOutput)) {
      if (!filePath || filePath.endsWith("/") || filePath === ".DS_Store") {
        continue;
      }
      const existing = byPath.get(filePath);
      if (existing) {
        const mergedStatus = shouldPreserveRangeStatus(existing.status, status) ? existing.status : status;
        byPath.set(filePath, { ...existing, status: mergedStatus, source: "working_tree" });
        continue;
      }
      if (status.includes("D") || isRegularFile(path.resolve(cwd, filePath))) {
        byPath.set(filePath, { path: filePath, status, source: "working_tree" });
      }
    }
  }

  const files = [...byPath.values()].sort((left, right) => compareStrings(left.path, right.path));
  return { files, diffSource, diagnostics };
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

function shouldPreserveRangeStatus(rangeStatus: string, workingTreeStatus = ""): boolean {
  return isRenameOrCopyStatus(rangeStatus)
    || rangeStatus.startsWith("D")
    || (rangeStatus.startsWith("A") && !workingTreeStatus.includes("D"));
}

function splitNullOutput(output: string): string[] {
  return output.split("\0").filter((field) => field !== "");
}

export function collectDiff(cwd: string, baseRef: string, headRef: string): DiffResult {
  const diagnostics: string[] = [];
  const rangeDiff = git(cwd, ["diff", `${baseRef}...${headRef}`]);
  let diffSource: DiffSource = "range";
  if (rangeDiff === undefined) {
    diffSource = "working_tree_fallback";
    diagnostics.push(`could not produce a ${baseRef}...${headRef} diff; using working-tree diff only`);
  }
  // text is computed identically to before (same parts, same Boolean filter,
  // same join) so .review-surfaces/inputs/diff.patch bytes are unchanged.
  const parts = [
    rangeDiff,
    git(cwd, ["diff", "--cached"]),
    git(cwd, ["diff"])
  ].filter((part): part is string => Boolean(part));
  return { text: parts.join("\n"), diffSource, diagnostics };
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

export function resolveGitRefSha(cwd: string, ref: string): string | undefined {
  return git(cwd, ["rev-parse", "--verify", ref])?.trim();
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
  } catch {
    return undefined;
  }
}
