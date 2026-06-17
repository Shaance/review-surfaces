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
  // The pre-rename path for an `R*` (rename) status — the destination is `path`.
  // Lets a consumer tell that a public surface LEFT its old location (e.g. a schema
  // renamed to a non-schema path), which the new path alone cannot show. Absent for
  // non-rename changes. (#103)
  old_path?: string;
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

// COLD_START.6: the deterministic default-base chain. origin/HEAD (the remote
// default branch) wins when it exists; the rest cover main/master conventions
// with remote-tracking refs preferred over local branches.
export const BASE_AUTO_CHAIN = ["origin/HEAD", "origin/main", "origin/master", "main", "master"] as const;

export interface BaseResolution {
  ref: string;
  sha: string;
  source: "explicit" | "auto";
}

export type BaseResolutionResult =
  | { ok: true; base: BaseResolution }
  | { ok: false; message: string };

// COLD_START.6: resolve the review base BEFORE any collection or artifact
// write. An explicit base that does not resolve — and an exhausted auto chain —
// are hard errors for the caller to raise (closes quick-wins evidence item 1:
// the silent working-tree fallback reviewed the wrong range on master-default
// repos and CI shallow clones). Callers keep the R6 graceful degradation for
// not-a-repo / unborn-HEAD states by not calling this when HEAD is unresolvable.
export function resolveBaseRef(cwd: string, explicitBase: string | undefined, headRef = "HEAD"): BaseResolutionResult {
  if (explicitBase !== undefined) {
    const sha = resolveGitRefSha(cwd, explicitBase);
    if (sha === undefined) {
      return {
        ok: false,
        message:
          `base ref "${explicitBase}" does not resolve. If this is a shallow clone, fetch the base first ` +
          `(GitHub Actions: actions/checkout with fetch-depth: 0; locally: git fetch --unshallow origin). ` +
          `Otherwise pass --base <ref> naming an existing ref.`
      };
    }
    return { ok: true, base: { ref: explicitBase, sha, source: "explicit" } };
  }
  // COLD_START.6 (PR #79 rounds 4-5, P1s): two failure shapes pull in opposite
  // directions. A LIMITED fetch (single-branch clone, actions/checkout's
  // single-ref fetch) can leave origin/HEAD pointing at the checked-out
  // feature branch itself — there, prefer the first candidate whose commit
  // DIFFERS from the head, or an empty review hides a real diff. A FULL
  // wildcard fetch is the opposite: origin/HEAD is trustworthy and a stale
  // leftover master ref must NOT outrank an up-to-date default branch just
  // because it differs — there, chain order wins even when the candidate
  // equals the head (a clean default-branch checkout is honestly empty). The
  // remote's fetch refspec tells the shapes apart; either way a base that
  // lands on the head commit triggers the CLI's base-equals-head note.
  const headSha = resolveGitRefSha(cwd, headRef) ?? resolveGitRefSha(cwd, "HEAD");
  const resolvedCandidates: BaseResolution[] = [];
  for (const candidate of BASE_AUTO_CHAIN) {
    const sha = resolveGitRefSha(cwd, candidate);
    if (sha === undefined) {
      continue;
    }
    // Record origin/HEAD as the branch it points at (e.g. origin/master): the
    // symref name is opaque in rendered headers and manifests.
    const ref = candidate === "origin/HEAD" ? git(cwd, ["rev-parse", "--abbrev-ref", candidate]) ?? candidate : candidate;
    resolvedCandidates.push({ ref, sha, source: "auto" });
  }
  const preferred = hasLimitedOriginFetch(cwd)
    ? resolvedCandidates.find((candidate) => candidate.sha !== headSha) ?? resolvedCandidates[0]
    : resolvedCandidates[0];
  if (preferred) {
    return { ok: true, base: preferred };
  }
  return {
    ok: false,
    message:
      `no default base ref resolves (tried ${BASE_AUTO_CHAIN.join(", ")}). ` +
      `Pass --base <ref> naming the ref to review against (for example the branch you merge into).`
  };
}

// COLD_START.6: true when an origin remote exists but its fetch refspec does
// NOT cover all branches (single-branch clones, actions/checkout's single-ref
// fetch). In that shape origin/HEAD is not a trustworthy default-branch
// signal. A repo with no origin remote is NOT limited — its local candidates
// follow plain chain order.
function hasLimitedOriginFetch(cwd: string): boolean {
  const refspecs = git(cwd, ["config", "--get-all", "remote.origin.fetch"]);
  if (refspecs === undefined || refspecs === "") {
    return false;
  }
  return !refspecs.split("\n").some((refspec) => refspec.trim().endsWith(":refs/remotes/origin/*"));
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

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

// COLD_START.7: working-tree/untracked files belong in the review only when
// the requested head IS the checked-out state — the literal "HEAD"/"@", or the
// name of the branch currently checked out ("--head main" while on main is a
// current-state review per the requirement text). A raw sha, a tag, a
// different branch, or any ref on a detached checkout is pinned — even one
// equal to the current commit, which is exactly the shape that silently
// absorbed working-tree files in the 104-vs-99 incident (evidence item 2).
export function isCurrentStateHeadRequest(cwd: string, headRef: string): boolean {
  if (headRef === "HEAD" || headRef === "@") {
    return true;
  }
  const currentBranch = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!currentBranch) {
    return false;
  }
  return headRef === currentBranch || headRef === `refs/heads/${currentBranch}` || headRef === `heads/${currentBranch}`;
}

export function collectChangedFiles(
  cwd: string,
  baseRef: string,
  headRef: string,
  includeWorkingTree: boolean = isCurrentStateHeadRequest(cwd, headRef),
  // COLD_START.7: pure working-tree entries matching this predicate (the
  // tool's own artifact locations) are not reviewed changes. Range entries are
  // never filtered — a committed change to a tracked artifact stays reviewable.
  isExcludedWorkingTreePath?: (filePath: string) => boolean
): ChangedFilesResult {
  const diagnostics: string[] = [];
  const byPath = new Map<string, ChangedFile>();
  // Behavior-preserving: the original used `range ?? bare`, which only fell
  // through on undefined (a git error), NOT on an empty-but-successful range
  // diff ("" is not nullish). We replicate that: fall back to the bare
  // working-tree diff only when the range command errors — and only for a
  // literal-HEAD review, where working-tree content is in scope at all.
  const rangeOutput = git(cwd, ["diff", "--name-status", "-z", `${baseRef}...${headRef}`]);
  let diffSource: DiffSource = "range";
  let diffOutput = rangeOutput;
  if (rangeOutput === undefined) {
    diagnostics.push(`could not diff ${baseRef}...${headRef}${includeWorkingTree ? "; fell back to working-tree changes" : ""}`);
    if (includeWorkingTree) {
      diffSource = "working_tree_fallback";
      diffOutput = git(cwd, ["diff", "--name-status", "-z"]);
    }
  }
  if (diffOutput) {
    for (const changedFile of parseDiffNameStatusOutput(diffOutput)) {
      byPath.set(changedFile.path, changedFile);
    }
  }

  const statusOutput = includeWorkingTree ? git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) : undefined;
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
      if (isExcludedWorkingTreePath?.(filePath)) {
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
      const oldPath = fields[index + 1];
      index += 2;
      const filePath = fields[index];
      if (filePath) {
        files.push({ path: filePath, status, source: "diff", ...(oldPath ? { old_path: oldPath } : {}) });
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

export function collectDiff(
  cwd: string,
  baseRef: string,
  headRef: string,
  includeWorkingTree: boolean = isCurrentStateHeadRequest(cwd, headRef)
): DiffResult {
  const diagnostics: string[] = [];
  const rangeDiff = git(cwd, ["diff", `${baseRef}...${headRef}`]);
  let diffSource: DiffSource = "range";
  if (rangeDiff === undefined) {
    diffSource = includeWorkingTree ? "working_tree_fallback" : "range";
    diagnostics.push(`could not produce a ${baseRef}...${headRef} diff${includeWorkingTree ? "; using working-tree diff only" : ""}`);
  }
  // COLD_START.7: the staged/working-tree parts join the diff text only for a
  // literal-HEAD review; a pinned head gets the pure range diff. For the
  // literal-HEAD case, text is computed identically to before (same parts, same
  // Boolean filter, same join) so inputs/diff.patch bytes are unchanged.
  const parts = [
    rangeDiff,
    ...(includeWorkingTree ? [git(cwd, ["diff", "--cached"]), git(cwd, ["diff"])] : [])
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
      // Split on the FIRST tab only: the `%x09` separator is a single tab, but a
      // commit subject may itself contain a tab, so a naive `split("\t")[1]`
      // would truncate the subject at its first embedded tab.
      const tab = line.indexOf("\t");
      const sha = tab === -1 ? line : line.slice(0, tab);
      const subject = tab === -1 ? "" : line.slice(tab + 1);
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

// The OLD side of a `base...head` (three-dot) range diff is the merge-base of the
// two refs, not the base branch tip. Semantic schema/API diffs must compare
// against this same merge-base so they describe exactly the reviewed change set
// (and not unrelated commits the base branch gained after the fork point).
// Returns undefined when either ref is missing or there is no common ancestor.
export function resolveMergeBaseSha(cwd: string, baseRef: string, headRef: string): string | undefined {
  return git(cwd, ["merge-base", baseRef, headRef])?.trim();
}

// Read a file's content at a git ref (the OLD version of a changed file), for
// semantic diffs that compare base vs head. Returns undefined when the ref/path
// does not resolve (e.g. an added file has no base version), never throwing.
export function readFileAtRef(cwd: string, ref: string, filePath: string): string | undefined {
  return git(cwd, ["show", `${ref}:${filePath}`]);
}

// COLD_START.7: byte-exact blob read at a ref, for hashing pinned-head content.
// Bypasses git() deliberately — its utf8 decode + trimEnd would corrupt binary
// blobs and strip meaningful trailing newlines from the hash input.
export function readFileBytesAtRef(cwd: string, ref: string, filePath: string): Buffer | undefined {
  try {
    return execFileSync("git", ["show", `${ref}:${filePath}`], { cwd, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

// Committer time of a ref as ISO-8601, for coverage-report staleness checks
// (a report older than the head commit cannot describe the reviewed code).
export function commitTimeAtRef(cwd: string, ref: string): string | undefined {
  return git(cwd, ["show", "-s", "--format=%cI", ref]);
}

// True only when ref:path is a BLOB (a file). `git show ref:dir` succeeds with a
// tree listing, so a show-based existence check would treat directories as files.
export function blobExistsAtRef(cwd: string, ref: string, filePath: string): boolean {
  // `-t` (not `-e` with a ^{blob} suffix — that suffix is parsed as part of
  // the PATH and always fails) so a directory at the path reports its real
  // type "tree" and is rejected: blob-only existence.
  return git(cwd, ["cat-file", "-t", `${ref}:${filePath}`]) === "blob";
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
  } catch {
    return undefined;
  }
}
