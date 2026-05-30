import { spawnSync } from "node:child_process";
import { STICKY_MARKER } from "./comment";

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

function ghAvailable(): boolean {
  const result = spawnSync("gh", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

interface PrContext {
  number: string;
  // owner/repo "nameWithOwner" needed to address the REST comments endpoint.
  nameWithOwner: string;
}

// Detect a PR context without mutating anything: `gh pr view` against the
// current branch succeeds only when a PR is associated with it. We also pull
// the repo's nameWithOwner so we can PATCH a specific comment by id below.
function detectPrContext(cwd: string): PrContext | null {
  const result = spawnSync(
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
  const repo = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
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
// Returns the last matching comment's id, or null when none exists.
function findStickyCommentId(cwd: string, ctx: PrContext): string | null {
  const result = spawnSync(
    "gh",
    [
      "api",
      "--paginate",
      `repos/${ctx.nameWithOwner}/issues/${ctx.number}/comments`,
      "--jq",
      `[.[] | select(.body | contains("${STICKY_MARKER}")) | .id] | last // ""`
    ],
    { cwd, encoding: "utf8" }
  );
  if (result.status !== 0) {
    return null;
  }
  const trimmed = result.stdout.trim();
  return trimmed === "" ? null : trimmed;
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
export function postStickyComment(cwd: string, body: string): PostResult {
  if (!ghAvailable()) {
    return { attempted: true, posted: false, reason: "gh CLI not available; emitted local artifact only." };
  }
  const ctx = detectPrContext(cwd);
  if (!ctx) {
    return { attempted: true, posted: false, reason: "No PR context detected for this branch; emitted local artifact only." };
  }

  const existingId = findStickyCommentId(cwd, ctx);
  const result = existingId
    ? spawnSync(
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
    : spawnSync("gh", ["pr", "comment", ctx.number, "--body", body], { cwd, encoding: "utf8" });
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
