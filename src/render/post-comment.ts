import { spawnSync } from "node:child_process";
import { STICKY_MARKER } from "./sticky-marker";
import type { PrChangeContext } from "../contracts/pr-review";
import { normalizePrChangeContext, samePrChangeContext } from "../pipeline/pr-surface";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; encoding: "utf8" }
) => CommandResult;

const runCommand: CommandRunner = (command, args, options) =>
  spawnSync(command, args, options) as CommandResult;

// ---------------------------------------------------------------------------
// Phase 6a: OPTIONAL best-effort sticky-comment upsert via the `gh` CLI.
//
// This path is ONLY taken when the user passes --post. It is never required:
// without --post the comment command just emits the local artifact. It must
// never run in tests, which never pass --post.
//
// The default offline path (no --post) does NOT touch the network or `gh`. This
// module isolates every process spawn so the renderer stays pure/deterministic.
// Every failure is best-effort: we report and move on rather than throwing, so a
// missing `gh`, no PR context, or an API hiccup never breaks the artifact emit.
// ---------------------------------------------------------------------------

export interface PostResult {
  attempted: boolean;
  posted: boolean;
  reason: string;
}

function ghAvailable(run: CommandRunner): boolean {
  const result = run("gh", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

interface PrContext {
  number: string;
  // owner/repo "nameWithOwner" needed to address the REST comments endpoint.
  nameWithOwner: string;
}

function configuredPrContext(): PrContext | null {
  const number = process.env.GH_PR_NUMBER?.trim() ?? "";
  const nameWithOwner = process.env.GH_REPO?.trim() ?? "";
  if (!/^\d+$/u.test(number) || !/^[^/\s]+\/[^/\s]+$/u.test(nameWithOwner)) return null;
  return { number, nameWithOwner };
}

// Detect a PR context without mutating anything: `gh pr view` against the
// current branch succeeds only when a PR is associated with it. We also pull
// the repo's nameWithOwner so we can PATCH a specific comment by id below.
function detectPrContext(cwd: string, run: CommandRunner): PrContext | null {
  const configured = configuredPrContext();
  if (configured) return configured;
  const result = run(
    "gh",
    ["pr", "view", "--json", "number,headRepository,headRepositoryOwner", "--jq", ".number"],
    { cwd, encoding: "utf8" }
  );
  if (result.status !== 0) {
    return null;
  }
  const number = result.stdout.trim();
  if (number === "") {
    return null;
  }
  // Resolve owner/repo separately so a fork/base mismatch does not produce a
  // malformed endpoint. `gh repo view` reports the repo the PR targets.
  const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    cwd,
    encoding: "utf8"
  });
  if (repo.status !== 0) {
    return null;
  }
  const nameWithOwner = repo.stdout.trim();
  if (nameWithOwner === "") {
    return null;
  }
  return { number, nameWithOwner };
}

// Find the existing sticky comment's NUMERIC REST id (by the marker) so we can
// update THAT specific comment by id rather than blindly editing "the last
// comment by the current user" (which can clobber an unrelated newer comment).
// Only a successful, parseable list may prove that no sticky exists. Lookup
// failures are distinct so a transient API/auth error can never create a
// duplicate comment.
type StickyLookup =
  | { status: "found"; comment: OwnedStickyComment }
  | { status: "none" }
  | { status: "error"; reason: string };

export interface OwnedStickyComment {
  id: string;
  body: string;
}

function findStickyComment(cwd: string, ctx: PrContext, run: CommandRunner): StickyLookup {
  const owner = authenticatedLogin(cwd, run);
  if (!owner) {
    return { status: "error", reason: "Could not identify the posting account" };
  }
  const ownerLiteral = JSON.stringify(owner);
  const markerLiteral = JSON.stringify(`${STICKY_MARKER}\n`);
  // Pagination applies jq once per page. Return only the final matching id from
  // each page so neither gh nor Node materializes the complete comment history.
  const jq = `[.[] | select(.user.login == ${ownerLiteral}) | select(.body | startswith(${markerLiteral})) | .id] | last // empty`;
  const result = run(
    "gh",
    [
      "api",
      "--paginate",
      `repos/${ctx.nameWithOwner}/issues/${ctx.number}/comments`,
      "--jq",
      jq
    ],
    { cwd, encoding: "utf8" }
  );
  if (result.status !== 0) {
    return { status: "error", reason: "Could not list existing PR comments" };
  }
  const matchingIds = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (matchingIds.some((id) => !/^\d+$/u.test(id))) {
    return { status: "error", reason: "Existing PR comments returned an invalid id" };
  }
  const id = matchingIds.at(-1);
  if (!id) return { status: "none" };

  const detail = run(
    "gh",
    ["api", `repos/${ctx.nameWithOwner}/issues/comments/${id}`, "--jq", "{id,body,user:{login:.user.login}}"],
    { cwd, encoding: "utf8" }
  );
  if (detail.status !== 0) {
    return { status: "error", reason: "Could not read the existing sticky comment" };
  }
  try {
    const comment = ownedStickyComment(JSON.parse(detail.stdout) as unknown, owner);
    return comment
      ? { status: "found", comment }
      : { status: "error", reason: "Existing sticky comment changed during lookup" };
  } catch {
    return { status: "error", reason: "Existing PR comments returned invalid JSON" };
  }
}

export function ownedStickyComment(payload: unknown, owner: string): OwnedStickyComment | null {
  const pages = Array.isArray(payload) ? payload : [payload];
  const comments = pages.flatMap((page) => Array.isArray(page) ? page : [page]);
  for (const candidate of comments.reverse()) {
    if (!candidate || typeof candidate !== "object") continue;
    const comment = candidate as { id?: unknown; body?: unknown; user?: { login?: unknown } };
    if (comment.user?.login !== owner) continue;
    if (typeof comment.body !== "string" || !comment.body.startsWith(`${STICKY_MARKER}\n`)) continue;
    const id = String(comment.id ?? "");
    if (/^\d+$/u.test(id)) return { id, body: comment.body };
  }
  return null;
}

export function ownedStickyCommentId(payload: unknown, owner: string): string | null {
  return ownedStickyComment(payload, owner)?.id ?? null;
}

export interface StickyFingerprint {
  headSha: string;
  runId?: string;
}

export function parseStickyFingerprint(body: string): StickyFingerprint | undefined {
  const lastLine = body.split(/\r?\n/u).filter((line) => line.trim()).at(-1);
  const match = lastLine?.match(
    /^<!-- review-surfaces:fingerprint head=([0-9a-f]{7,64})(?: run=([0-9]+))? queue=[0-9a-f]+ -->$/u
  );
  if (!match) return undefined;
  return {
    headSha: match[1],
    ...(match[2] ? { runId: match[2] } : {})
  };
}

function authenticatedLogin(cwd: string, run: CommandRunner): string | null {
  const result = run("gh", ["api", "user", "--jq", ".login"], { cwd, encoding: "utf8" });
  const login = result.status === 0 ? result.stdout.trim() : "";
  if (login && login.length <= 100) return login;

  // `github.token` is the github-actions GitHub App installation token, so
  // GET /user legitimately fails even though comment permissions work. Only
  // use the documented Actions identity inside an actual Actions process; a
  // local/PAT lookup failure remains an error to avoid duplicate stickies.
  return process.env.GITHUB_ACTIONS === "true" ? "github-actions[bot]" : null;
}

interface RemotePrState {
  headSha: string;
  title: string;
  body: string;
}

function remotePrState(cwd: string, ctx: PrContext, run: CommandRunner): RemotePrState | null {
  const result = run(
    "gh",
    ["api", `repos/${ctx.nameWithOwner}/pulls/${ctx.number}`],
    { cwd, encoding: "utf8" }
  );
  if (result.status !== 0) return null;
  try {
    const payload = JSON.parse(result.stdout) as {
      head?: { sha?: unknown };
      title?: unknown;
      body?: unknown;
    };
    if (typeof payload.head?.sha !== "string" || typeof payload.title !== "string") return null;
    return {
      headSha: payload.head.sha,
      title: payload.title,
      body: typeof payload.body === "string" ? payload.body : ""
    };
  } catch {
    return null;
  }
}

export interface PostFreshness {
  headSha?: string;
  changeContext?: PrChangeContext;
}

export interface RemoveResult {
  attempted: boolean;
  removed: boolean;
  reason: string;
}

export type ReadStickyResult =
  | { status: "found"; comment: OwnedStickyComment; fingerprint?: StickyFingerprint }
  | { status: "none"; reason: string }
  | { status: "error"; reason: string };

type StickyTargetResolution =
  | { ok: true; ctx: PrContext; lookup: StickyLookup }
  | { ok: false; reason: string };

function resolveStickyTarget(
  cwd: string,
  freshness: PostFreshness,
  run: CommandRunner
): StickyTargetResolution {
  if (!ghAvailable(run)) {
    return { ok: false, reason: "gh CLI not available; emitted local artifact only." };
  }
  const ctx = detectPrContext(cwd, run);
  if (!ctx) {
    return { ok: false, reason: "No PR context detected for this branch; emitted local artifact only." };
  }
  if (freshness.headSha || freshness.changeContext?.source === "github") {
    const remote = remotePrState(cwd, ctx, run);
    if (!remote) {
      return { ok: false, reason: "Could not verify the current PR; skipped the stale-sticky operation." };
    }
    if (freshness.headSha && remote.headSha !== freshness.headSha) {
      return {
        ok: false,
        reason: `PR head changed from ${freshness.headSha} to ${remote.headSha}; skipped the stale-sticky operation.`
      };
    }
    if (freshness.changeContext?.source === "github") {
      const currentContext = normalizePrChangeContext({
        title: remote.title,
        ...(remote.body ? { description: remote.body } : {}),
        source: "github",
        redaction_blocked: false
      });
      if (!samePrChangeContext(currentContext, freshness.changeContext)) {
        return {
          ok: false,
          reason: "PR title or description changed after generation; skipped the stale-sticky operation."
        };
      }
    }
  }
  const lookup = findStickyComment(cwd, ctx, run);
  if (lookup.status === "error") {
    return { ok: false, reason: `${lookup.reason}; skipped the operation to avoid targeting the wrong comment.` };
  }
  return { ok: true, ctx, lookup };
}

export function readOwnedStickyComment(
  cwd: string,
  freshness: PostFreshness = {},
  run: CommandRunner = runCommand
): ReadStickyResult {
  const target = resolveStickyTarget(cwd, freshness, run);
  if (!target.ok) return { status: "error", reason: target.reason };
  if (target.lookup.status === "none") {
    return { status: "none", reason: "No existing review-surfaces sticky was found." };
  }
  if (target.lookup.status === "error") return { status: "error", reason: target.lookup.reason };
  const fingerprint = parseStickyFingerprint(target.lookup.comment.body);
  return {
    status: "found",
    comment: target.lookup.comment,
    ...(fingerprint ? { fingerprint } : {})
  };
}

/**
 * Best-effort upsert of the sticky comment. ONLY call this when --post is set.
 * Returns a structured result; it never throws. When `gh` is missing or no PR
 * context is detectable, it reports that and posts nothing.
 *
 * When a prior sticky comment exists we PATCH that EXACT comment by its REST id
 * (`repos/{owner}/{repo}/issues/comments/{id}`) so we never overwrite an
 * unrelated newer bot comment or leave a stale sticky behind. When none exists
 * we create a fresh comment.
 */
export function postStickyComment(
  cwd: string,
  body: string,
  freshness: PostFreshness = {},
  run: CommandRunner = runCommand
): PostResult {
  const target = resolveStickyTarget(cwd, freshness, run);
  if (!target.ok) {
    return {
      attempted: true,
      posted: false,
      reason: target.reason
    };
  }
  const { ctx, lookup } = target;
  const existingId = lookup.status === "found" ? lookup.comment.id : undefined;
  const result = existingId
    ? run(
        "gh",
        [
          "api",
          "--method",
          "PATCH",
          `repos/${ctx.nameWithOwner}/issues/comments/${existingId}`,
          "-f",
          `body=${body}`
        ],
        { cwd, encoding: "utf8" }
      )
    : run("gh", ["pr", "comment", ctx.number, "--body", body], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    return {
      attempted: true,
      posted: false,
      reason: `${existingId ? "gh api PATCH comment" : "gh pr comment"} failed: ${(result.stderr || "unknown error").trim()}`
    };
  }
  return {
    attempted: true,
    posted: true,
    reason: existingId
      ? `Updated sticky comment #${existingId} on PR #${ctx.number}.`
      : `Posted sticky comment on PR #${ctx.number}.`
  };
}

/** Remove the exact owned sticky when a current PR has no reviewable diff. */
export function removeStickyComment(
  cwd: string,
  freshness: PostFreshness = {},
  run: CommandRunner = runCommand
): RemoveResult {
  const target = resolveStickyTarget(cwd, freshness, run);
  if (!target.ok) {
    return { attempted: true, removed: false, reason: target.reason };
  }
  if (target.lookup.status === "none") {
    return { attempted: true, removed: false, reason: "No existing review-surfaces sticky needed removal." };
  }
  if (target.lookup.status === "error") {
    return { attempted: true, removed: false, reason: target.lookup.reason };
  }
  const result = run(
    "gh",
    ["api", "--method", "DELETE", `repos/${target.ctx.nameWithOwner}/issues/comments/${target.lookup.comment.id}`],
    { cwd, encoding: "utf8" }
  );
  return result.status === 0
    ? { attempted: true, removed: true, reason: `Removed stale sticky comment #${target.lookup.comment.id}.` }
    : { attempted: true, removed: false, reason: `Could not remove stale sticky comment #${target.lookup.comment.id}; left it unchanged.` };
}
