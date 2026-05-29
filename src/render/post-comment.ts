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

// Detect a PR context without mutating anything: `gh pr view` against the
// current branch succeeds only when a PR is associated with it.
function detectPrNumber(cwd: string): string | null {
  const result = spawnSync("gh", ["pr", "view", "--json", "number", "--jq", ".number"], {
    cwd,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return null;
  }
  const trimmed = result.stdout.trim();
  return trimmed === "" ? null : trimmed;
}

// Find an existing sticky comment id (by the marker) so we can upsert rather
// than spamming a new comment each run.
function findStickyCommentId(cwd: string, prNumber: string): string | null {
  const result = spawnSync(
    "gh",
    [
      "pr",
      "view",
      prNumber,
      "--json",
      "comments",
      "--jq",
      `[.comments[] | select(.body | contains("${STICKY_MARKER}")) | .url] | last // ""`
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
 */
export function postStickyComment(cwd: string, body: string): PostResult {
  if (!ghAvailable()) {
    return { attempted: true, posted: false, reason: "gh CLI not available; emitted local artifact only." };
  }
  const prNumber = detectPrNumber(cwd);
  if (!prNumber) {
    return { attempted: true, posted: false, reason: "No PR context detected for this branch; emitted local artifact only." };
  }

  const existing = findStickyCommentId(cwd, prNumber);
  const args = existing
    ? ["pr", "comment", prNumber, "--edit-last", "--body", body]
    : ["pr", "comment", prNumber, "--body", body];
  const result = spawnSync("gh", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    return {
      attempted: true,
      posted: false,
      reason: `gh pr comment failed: ${(result.stderr || "unknown error").trim()}`
    };
  }
  return {
    attempted: true,
    posted: true,
    reason: existing ? `Updated sticky comment on PR #${prNumber}.` : `Posted sticky comment on PR #${prNumber}.`
  };
}
