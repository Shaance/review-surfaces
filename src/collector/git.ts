import path from "node:path";
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
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

export interface WorkingTreeSnapshot {
  status: string | undefined;
  paths: string[];
  untracked: { paths: string[]; omitted: number; omitted_entries: string[] };
}

export const MAX_UNTRACKED_REVIEW_FILES = 200;
export const MAX_UNTRACKED_REVIEW_BYTES = 10 * 1024 * 1024;
// Node's execFileSync default is only 1 MiB. A normal cross-cutting PR can
// exceed that, at which point the old helper returned undefined and the
// collector quietly reviewed only working-tree changes. Keep a bounded
// physical budget, but make it large enough for real review inputs; callers
// with resolved refs fail closed if git still cannot produce the range.
export const MAX_GIT_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

export function collectWorkingTreeSnapshot(
  cwd: string,
  isExcludedWorkingTreePath?: (filePath: string) => boolean
): WorkingTreeSnapshot {
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths = status
    ? parsePorcelainStatusOutput(status).map((entry) => entry.filePath).filter(Boolean).sort(compareStrings)
    : [];
  return { status, paths, untracked: selectUntrackedFiles(cwd, status, isExcludedWorkingTreePath) };
}

export function hasReviewableWorkingTreeChanges(
  snapshot: WorkingTreeSnapshot,
  isExcluded: (filePath: string) => boolean
): boolean {
  if (!snapshot.status) return false;
  return parsePorcelainStatusOutput(snapshot.status).some(({ filePath, oldPath }) =>
    [filePath, oldPath]
      .filter((candidate): candidate is string => Boolean(candidate) && !candidate!.endsWith("/") && candidate !== ".DS_Store")
      .some((candidate) => !isExcluded(candidate))
  );
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
  isExcludedWorkingTreePath?: (filePath: string) => boolean,
  workingTreeSnapshot?: WorkingTreeSnapshot
): ChangedFilesResult {
  const diagnostics: string[] = [];
  const byPath = new Map<string, ChangedFile>();
  // Behavior-preserving: the original used `range ?? bare`, which only fell
  // through on undefined (a git error), NOT on an empty-but-successful range
  // diff ("" is not nullish). We replicate that: fall back to the bare
  // working-tree diff only when the range command errors — and only for a
  // literal-HEAD review, where working-tree content is in scope at all.
  const rangeOutput = gitRange(cwd, baseRef, headRef, ["diff", "--name-status", "-z"]);
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

  const snapshot = includeWorkingTree
    ? workingTreeSnapshot ?? collectWorkingTreeSnapshot(cwd, isExcludedWorkingTreePath)
    : undefined;
  const statusOutput = snapshot?.status;
  const untrackedSelection = snapshot?.untracked ?? { paths: [], omitted: 0, omitted_entries: [] };
  const selectedUntracked = new Set(untrackedSelection.paths);
  if (untrackedSelection.omitted > 0) {
    diagnostics.push(
      `omitted ${untrackedSelection.omitted} untracked file(s) beyond the ${MAX_UNTRACKED_REVIEW_FILES}-file / ${MAX_UNTRACKED_REVIEW_BYTES}-byte review budget`
    );
  }
  if (statusOutput) {
    for (const { status, filePath, oldPath } of parsePorcelainStatusOutput(statusOutput)) {
      if (!filePath || filePath.endsWith("/") || filePath === ".DS_Store") {
        continue;
      }
      if (status === "??" && !selectedUntracked.has(filePath)) {
        continue;
      }
      const existing = byPath.get(filePath);
      if (existing) {
        const mergedStatus = shouldPreserveRangeStatus(existing.status, status) ? existing.status : status;
        byPath.set(filePath, { ...existing, status: mergedStatus, source: "working_tree", ...(oldPath ? { old_path: oldPath } : {}) });
        continue;
      }
      if (isExcludedWorkingTreePath?.(filePath)) {
        continue;
      }
      if (status.includes("D") || isRegularFile(path.resolve(cwd, filePath))) {
        byPath.set(filePath, { path: filePath, status, source: "working_tree", ...(oldPath ? { old_path: oldPath } : {}) });
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
        // old_path ONLY for a RENAME (the source is gone). A COPY (C*) leaves the
        // source in place, so recording its source as old_path would misreport the
        // copy as a modification of the source (Codex P2).
        files.push({ path: filePath, status, source: "diff", ...(status.startsWith("R") && oldPath ? { old_path: oldPath } : {}) });
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

function parsePorcelainStatusOutput(output: string): Array<{ status: string; filePath: string; oldPath?: string }> {
  const records = splitNullOutput(output);
  const files: Array<{ status: string; filePath: string; oldPath?: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2).trim() || "modified";
    const filePath = record.slice(3);
    // Porcelain v1 `-z` emits a rename/copy as the destination record followed by
    // the SOURCE path in the next field. Capture it (renames only, like the range
    // parser) so a staged/dirty rename also carries its old path (Codex P2).
    let oldPath: string | undefined;
    if (isRenameOrCopyStatus(status)) {
      oldPath = records[index + 1];
      index += 1;
    }
    if (filePath) {
      files.push({ status, filePath, ...(status.startsWith("R") && oldPath ? { oldPath } : {}) });
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
  includeWorkingTree: boolean = isCurrentStateHeadRequest(cwd, headRef),
  isExcludedWorkingTreePath?: (filePath: string) => boolean,
  workingTreeSnapshot?: WorkingTreeSnapshot
): DiffResult {
  const diagnostics: string[] = [];
  const rangeDiff = gitRange(cwd, baseRef, headRef, ["diff"]);
  let diffSource: DiffSource = "range";
  if (rangeDiff === undefined) {
    diffSource = includeWorkingTree ? "working_tree_fallback" : "range";
    diagnostics.push(`could not produce a ${baseRef}...${headRef} diff${includeWorkingTree ? "; using working-tree diff only" : ""}`);
  }
  // COLD_START.7: the staged/working-tree parts join the diff text only for a
  // literal-HEAD review; a pinned head gets the pure range diff. For the
  // literal-HEAD case, text is computed identically to before (same parts, same
  // Boolean filter, same join) so inputs/diff.patch bytes are unchanged.
  const untrackedSelection = includeWorkingTree
    ? (workingTreeSnapshot ?? collectWorkingTreeSnapshot(cwd, isExcludedWorkingTreePath)).untracked
    : { paths: [], omitted: 0, omitted_entries: [] };
  if (untrackedSelection.omitted > 0 && workingTreeSnapshot === undefined) {
    diagnostics.push(
      `omitted ${untrackedSelection.omitted} untracked file(s) beyond the ${MAX_UNTRACKED_REVIEW_FILES}-file / ${MAX_UNTRACKED_REVIEW_BYTES}-byte review budget`
    );
  }
  const untrackedDiffs = untrackedSelection.paths.map((filePath) => gitUntrackedDiff(cwd, filePath));
  const parts = [
    rangeDiff,
    ...(includeWorkingTree ? [git(cwd, ["diff", "--cached"]), git(cwd, ["diff"]), ...untrackedDiffs] : [])
  ].filter((part): part is string => Boolean(part));
  return { text: parts.join("\n"), diffSource, diagnostics };
}

function selectUntrackedFiles(
  cwd: string,
  status: string | undefined,
  isExcluded?: (filePath: string) => boolean
): { paths: string[]; omitted: number; omitted_entries: string[] } {
  if (!status) return { paths: [], omitted: 0, omitted_entries: [] };
  const candidates = parsePorcelainStatusOutput(status)
    .filter((entry) => entry.status === "??" && !isExcluded?.(entry.filePath))
    .map((entry) => entry.filePath)
    .sort(compareStrings);
  const paths: string[] = [];
  let bytes = 0;
  const omittedEntries: string[] = [];
  for (const filePath of candidates) {
    try {
      const stat = fs.statSync(path.resolve(cwd, filePath));
      if (!stat.isFile()) continue;
      if (paths.length >= MAX_UNTRACKED_REVIEW_FILES || bytes + stat.size > MAX_UNTRACKED_REVIEW_BYTES) {
        omittedEntries.push(`${filePath}:${stat.size}`);
        continue;
      }
      paths.push(filePath);
      bytes += stat.size;
    } catch {
      continue;
    }
  }
  return { paths, omitted: omittedEntries.length, omitted_entries: omittedEntries };
}

// `git diff --no-index` exits 1 when it successfully found a difference, so it
// cannot use the ordinary git() helper (which treats every nonzero status as a
// failure). Its output is the same parseable unified patch shape as tracked
// changes, including a binary marker instead of reading binary bytes as text.
function gitUntrackedDiff(cwd: string, filePath: string): string {
  const result = spawnSync(
    "git",
    ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", filePath],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 20 * 1024 * 1024 }
  );
  if ((result.status !== 0 && result.status !== 1) || typeof result.stdout !== "string") {
    throw new Error(`could not generate a review patch for untracked file ${filePath}`);
  }
  return result.stdout.trimEnd();
}

export function collectCommits(cwd: string, baseRef: string, headRef: string): Array<Record<string, string>> {
  const output = git(cwd, ["log", "--format=%H%x09%s", `${baseRef}...${headRef}`]);
  return parseCommitLog(output);
}

// Producer corroboration must only use commits reachable from the reviewed head
// and absent from the base. A symmetric range also contains base-only commits
// after the target branch falls behind, which cannot have produced the review diff.
export function collectHeadCommits(cwd: string, baseRef: string, headRef: string): Array<Record<string, string>> {
  const output = git(cwd, ["log", "--format=%H%x09%s", `${baseRef}..${headRef}`]);
  return parseCommitLog(output);
}

function parseCommitLog(output: string | undefined): Array<Record<string, string>> {
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

export function isGitAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
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
    return execFileSync("git", ["show", `${ref}:${filePath}`], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: MAX_GIT_COMMAND_OUTPUT_BYTES
    });
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
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: MAX_GIT_COMMAND_OUTPUT_BYTES
    }).trimEnd();
  } catch {
    return undefined;
  }
}

function gitRange(cwd: string, baseRef: string, headRef: string, args: string[]): string | undefined {
  const output = git(cwd, [...args, `${baseRef}...${headRef}`]);
  if (output === undefined && resolveGitRefSha(cwd, baseRef) !== undefined && resolveGitRefSha(cwd, headRef) !== undefined) {
    throw new Error(
      `git could not produce the requested ${baseRef}...${headRef} range; refusing to review a smaller fallback`
    );
  }
  return output;
}
