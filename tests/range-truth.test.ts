import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { CLI, runCli } from "./helpers/cli-repo";
import { collectDiff, collectHeadCommits, MAX_UNTRACKED_REVIEW_BYTES } from "../src/collector/git";
import type { HumanReviewModel } from "../src/human/contract";
import { renderStickySummary } from "../src/render/sticky-summary";

// Release quick-wins uplift Phase 1 (QUICK_WINS_UPLIFT_GOAL.md): range truth.
// COLD_START.6 — base auto-resolution with a hard error replacing the silent
// working-tree fallback; COLD_START.7 — working-tree files merge only into a
// literal-HEAD review, announced when they do; COLD_START.8 — artifacts are
// portable for any --out location. Every test traces to the 2026-06-12
// quick-wins evidence-log items 1-3.

const FROZEN_NOW = "2026-06-12T00:00:00Z";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8"
  }).trim();
}

function commitFile(cwd: string, name: string, content: string, message: string): string {
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

// runCli (helpers) always appends --out .review-surfaces; this raw variant is
// for COLD_START.8's out-of-repo --out cases.
function runCliRaw(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeRepo(branch: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-range-truth-"));
  git(tmp, ["init", "-b", branch]);
  return tmp;
}

function readManifest(cwd: string, outDir = ".review-surfaces"): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(cwd, outDir, "manifest.json"), "utf8")) as Record<string, unknown>;
}

test("review-surfaces.COLD_START.6 collects committed range diffs larger than Node's implicit 1 MiB buffer", () => {
  const tmp = makeRepo("main");
  try {
    const base = commitFile(tmp, "large.txt", "base\n", "base");
    const largeText = Array.from(
      { length: 20_000 },
      (_, index) => `review-line-${index.toString().padStart(5, "0")}-${"x".repeat(64)}`
    ).join("\n");
    commitFile(tmp, "large.txt", `${largeText}\n`, "large review change");

    const result = collectDiff(tmp, base, "HEAD", false);

    assert.equal(result.diffSource, "range");
    assert.deepEqual(result.diagnostics, []);
    assert.ok(Buffer.byteLength(result.text, "utf8") > 1024 * 1024, "the complete range exceeds the old implicit buffer");
    assert.match(result.text, /review-line-19999-/, "the end of the committed range is retained");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.6 a range command failure with resolved refs fails closed", () => {
  const tmp = makeRepo("main");
  try {
    fs.writeFileSync(path.join(tmp, ".gitattributes"), "*.txt diff=broken\n");
    git(tmp, ["add", ".gitattributes"]);
    const base = commitFile(tmp, "large.txt", "base\n", "base");
    git(tmp, ["config", "diff.broken.textconv", "false"]);
    fs.writeFileSync(path.join(tmp, "large.txt"), "changed\n");
    git(tmp, ["add", "large.txt"]);
    git(tmp, ["commit", "-m", "change with broken diff driver"]);

    assert.throws(
      () => collectDiff(tmp, base, "HEAD", false),
      /refusing to review a smaller fallback/,
      "resolved refs must never degrade to an incomplete working-tree review"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function changedFilePaths(cwd: string, outDir = ".review-surfaces"): string[] {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(cwd, outDir, "inputs", "changed_files.json"), "utf8")
  ) as { files: Array<{ path: string }> };
  return parsed.files.map((file) => file.path);
}

test("review-surfaces.CONVERSATION_REVIEW.7 producer commit evidence excludes base-only commits", () => {
  const tmp = makeRepo("main");
  try {
    commitFile(tmp, "README.md", "# repo\n", "init");
    git(tmp, ["checkout", "-b", "feature"]);
    const featureSha = commitFile(tmp, "feature.txt", "feature\n", "feature work");
    git(tmp, ["checkout", "main"]);
    commitFile(tmp, "base.txt", "base advance\n", "base-only work");

    const commits = collectHeadCommits(tmp, "main", "feature");
    assert.deepEqual(commits.map((commit) => commit.sha), [featureSha]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// COLD_START.6 — base resolution
// ---------------------------------------------------------------------------

test("review-surfaces.COLD_START.6 an explicit --base that does not resolve is a hard error and writes no artifacts", () => {
  const tmp = makeRepo("master");
  try {
    commitFile(tmp, "README.md", "# repo\n", "init");
    const result = runCli(tmp, ["all", "--provider", "mock", "--base", "does-not-exist", "--head", "HEAD"]);
    assert.notEqual(result.status, 0, `a non-resolving explicit base must be a hard error:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /does-not-exist/, `the error must name the unresolved ref:\n${result.stderr}`);
    assert.match(
      result.stderr,
      /fetch-depth|unshallow/,
      `the error must give the shallow-clone fixes:\n${result.stderr}`
    );
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces")),
      false,
      "a hard base-resolution error must write no artifacts"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.6 the default base auto-resolves on a master-default repository and the resolved range is printed and persisted", () => {
  const tmp = makeRepo("master");
  try {
    commitFile(tmp, "README.md", "# repo\n", "init");
    git(tmp, ["checkout", "-b", "feature"]);
    commitFile(tmp, "feature.txt", "feature work\n", "add feature");

    const result = runCli(tmp, ["all", "--provider", "mock"]);
    assert.equal(result.status, 0, `auto-resolution must succeed on a master-default repo:\n${result.stderr}`);
    assert.match(
      result.stdout,
      /Reviewing range: master \([0-9a-f]{7}\) -> HEAD \([0-9a-f]{7}\)/,
      `the resolved range must be printed in the all summary:\n${result.stdout}`
    );

    const manifest = readManifest(tmp);
    assert.equal(manifest.base_ref, "master", "the manifest must persist the resolved base ref");
    assert.match(String(manifest.base_sha), /^[0-9a-f]{40}$/, "the manifest must persist the resolved base sha");
    assert.deepEqual(changedFilePaths(tmp), ["feature.txt"], "the diff must cover exactly the feature-branch change");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.6 the auto chain prefers origin/HEAD and records the dereferenced remote default branch", () => {
  const tmp = makeRepo("trunk");
  try {
    const sha = commitFile(tmp, "README.md", "# repo\n", "init");
    // Simulate a clone's remote-tracking state without a network remote: a
    // remote default branch origin/master pointed at by origin/HEAD.
    git(tmp, ["update-ref", "refs/remotes/origin/master", sha]);
    git(tmp, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"]);
    commitFile(tmp, "later.txt", "later\n", "later work");

    const result = runCli(tmp, ["all", "--provider", "mock"]);
    assert.equal(result.status, 0, `auto-resolution via origin/HEAD must succeed:\n${result.stderr}`);
    const manifest = readManifest(tmp);
    assert.equal(
      manifest.base_ref,
      "origin/master",
      "origin/HEAD must be recorded as the dereferenced remote default branch, not the opaque symref name"
    );
    assert.deepEqual(changedFilePaths(tmp), ["later.txt"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Configure a remote whose fetch refspec covers only one branch — the shape a
// single-branch clone or actions/checkout's single-ref fetch leaves behind.
function configureSingleBranchOrigin(tmp: string, branch: string): void {
  git(tmp, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
  git(tmp, ["config", "remote.origin.fetch", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
}

test("review-surfaces.COLD_START.6 a LIMITED fetch prefers a base that differs from the head (single-branch origin/HEAD shape)", () => {
  const tmp = makeRepo("feature");
  try {
    const older = commitFile(tmp, "README.md", "# repo\n", "init");
    const tip = commitFile(tmp, "feature.txt", "feature work\n", "feature commit");
    // A single-branch checkout's remote state: a narrow fetch refspec, with
    // origin/HEAD pointing at the checked-out feature branch (== head).
    // origin/main exists at the older commit (a CI fetch added it) and must
    // win, despite origin/HEAD being first in the chain.
    configureSingleBranchOrigin(tmp, "feature");
    git(tmp, ["update-ref", "refs/remotes/origin/feature", tip]);
    git(tmp, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature"]);
    git(tmp, ["update-ref", "refs/remotes/origin/main", older]);

    const result = runCli(tmp, ["all", "--provider", "mock"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readManifest(tmp).base_ref, "origin/main", "the differing candidate must be preferred over origin/HEAD");
    assert.deepEqual(changedFilePaths(tmp), ["feature.txt"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.6 a FULL fetch keeps chain order so a stale master ref cannot outrank the default branch", () => {
  const tmp = makeRepo("main");
  try {
    const older = commitFile(tmp, "README.md", "# repo\n", "init");
    const tip = commitFile(tmp, "feature.txt", "more work\n", "tip");
    // A normal clone on the REAL default branch: full wildcard refspec,
    // origin/HEAD -> origin/main == head, plus a stale leftover master ref at
    // an older commit (the branch-rename shape). The stale ref must NOT win
    // just because it differs from the head; the honest result is the empty
    // default-branch review.
    git(tmp, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(tmp, ["update-ref", "refs/remotes/origin/main", tip]);
    git(tmp, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    git(tmp, ["update-ref", "refs/remotes/origin/master", older]);

    const result = runCli(tmp, ["all", "--provider", "mock"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readManifest(tmp).base_ref, "origin/main", "chain order must hold on a full fetch");
    assert.deepEqual(changedFilePaths(tmp), [], "the clean default-branch review is honestly empty");
    assert.match(result.stderr, /same commit as the head/, "the base-equals-head note still fires");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.6 an auto base equal to the head is announced, never a silent empty review", () => {
  const tmp = makeRepo("feature");
  try {
    const tip = commitFile(tmp, "README.md", "# repo\n", "init");
    // The irreducible shape: the ONLY auto candidate is origin/HEAD pointing
    // at the checked-out branch itself (a pure single-branch clone).
    configureSingleBranchOrigin(tmp, "feature");
    git(tmp, ["update-ref", "refs/remotes/origin/feature", tip]);
    git(tmp, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature"]);

    const result = runCli(tmp, ["all", "--provider", "mock"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /auto-resolved base .* same commit as the head/,
      `a base-equals-head auto resolution must be announced on stderr:\n${result.stderr}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.6 an exhausted auto chain is a hard error naming the candidates tried", () => {
  const tmp = makeRepo("trunk");
  try {
    commitFile(tmp, "README.md", "# repo\n", "init");
    const result = runCli(tmp, ["all", "--provider", "mock"]);
    assert.notEqual(result.status, 0, `an exhausted auto chain must be a hard error:\n${result.stdout}`);
    assert.match(
      result.stderr,
      /origin\/HEAD.*origin\/main.*origin\/master.*\bmain\b.*\bmaster\b/s,
      `the error must list the candidates tried:\n${result.stderr}`
    );
    assert.match(result.stderr, /--base/, `the error must suggest passing --base:\n${result.stderr}`);
    assert.equal(fs.existsSync(path.join(tmp, ".review-surfaces")), false, "no artifacts on a hard error");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.6 an explicit --head that does not resolve is a hard error and writes no artifacts", () => {
  const tmp = makeRepo("main");
  try {
    commitFile(tmp, "README.md", "# repo\n", "init");
    const result = runCli(tmp, ["all", "--provider", "mock", "--base", "main", "--head", "no-such-head"]);
    assert.notEqual(result.status, 0, `a non-resolving explicit head must be a hard error:\n${result.stdout}`);
    assert.match(result.stderr, /no-such-head/, `the error must name the unresolved head ref:\n${result.stderr}`);
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces")),
      false,
      "a hard head-resolution error must write no artifacts"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.6 two refs without a common history are a hard error, not an empty review", () => {
  const tmp = makeRepo("main");
  try {
    commitFile(tmp, "README.md", "# repo\n", "init");
    // An orphan branch shares no history with main — the same shape as a
    // shallow fetch holding both tips but not their merge base.
    git(tmp, ["checkout", "--orphan", "island"]);
    commitFile(tmp, "island.txt", "isolated\n", "island commit");

    const result = runCli(tmp, ["all", "--provider", "mock", "--base", "main"]);
    assert.notEqual(result.status, 0, `a missing merge base must be a hard error:\n${result.stdout}`);
    assert.match(result.stderr, /merge base/i, `the error must name the missing merge base:\n${result.stderr}`);
    assert.match(result.stderr, /fetch-depth|unshallow/, `the error must give the shallow-history fixes:\n${result.stderr}`);
    assert.equal(fs.existsSync(path.join(tmp, ".review-surfaces")), false, "no artifacts on a hard error");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// COLD_START.7 — working-tree honesty
// ---------------------------------------------------------------------------

// The diff-derived review surfaces a pinned range produces. The repository
// walk (inputs/repo_index.json, evidence indexes) legitimately sees the
// working tree — it indexes evidence, not the reviewed change set — so the
// byte-identity contract is on the artifacts that describe the RANGE.
const PINNED_RANGE_ARTIFACTS = [
  "inputs/changed_files.json",
  "inputs/diff.patch",
  // review_packet.json embeds the manifest (including the cache signature),
  // which must hash committed blobs — not dirty worktree bytes — for a pinned
  // head (PR #79 round 3).
  "review_packet.json",
  "human_review.md",
  "human_review.html"
];

test("review-surfaces.COLD_START.7 a pinned head excludes working-tree changes (the 104-vs-99 incident shape)", () => {
  const tmp = makeRepo("main");
  try {
    const shaA = commitFile(tmp, "a.txt", "alpha\n", "A");
    const shaB = commitFile(tmp, "b.txt", "beta\n", "B");
    const args = ["all", "--provider", "mock", "--base", shaA, "--head", shaB, "--now", FROZEN_NOW];

    const clean = runCli(tmp, args);
    assert.equal(clean.status, 0, clean.stderr);
    assert.deepEqual(changedFilePaths(tmp), ["b.txt"]);
    const cleanBytes = PINNED_RANGE_ARTIFACTS.map((rel) =>
      fs.readFileSync(path.join(tmp, ".review-surfaces", rel))
    );

    // Dirty the tree exactly like the incident: a tracked-file edit plus an
    // untracked file, while the pinned head IS the checked-out commit.
    fs.writeFileSync(path.join(tmp, "a.txt"), "alpha EDITED\n");
    fs.writeFileSync(path.join(tmp, "c.txt"), "untracked\n");

    const dirty = runCli(tmp, args);
    assert.equal(dirty.status, 0, dirty.stderr);
    assert.deepEqual(
      changedFilePaths(tmp),
      ["b.txt"],
      "a pinned range must not absorb working-tree or untracked files"
    );
    PINNED_RANGE_ARTIFACTS.forEach((rel, index) => {
      const dirtyBytes = fs.readFileSync(path.join(tmp, ".review-surfaces", rel));
      assert.equal(
        dirtyBytes.equals(cleanBytes[index]),
        true,
        `${rel} must be byte-identical between clean-tree and dirty-tree pinned-range runs`
      );
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.7 requesting the checked-out BRANCH by name is a current-state review (working tree included)", () => {
  const tmp = makeRepo("main");
  try {
    const shaA = commitFile(tmp, "a.txt", "alpha\n", "A");
    commitFile(tmp, "b.txt", "beta\n", "B");
    fs.writeFileSync(path.join(tmp, "c.txt"), "untracked\n");

    // --head main while main is checked out resolves to the checked-out HEAD:
    // per COLD_START.7 this is a current-state review, not a pinned one.
    const result = runCli(tmp, ["all", "--provider", "mock", "--base", shaA, "--head", "main", "--now", FROZEN_NOW]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /includes 1 uncommitted file\(s\) \(working tree\)/,
      `a checked-out-branch head must include and announce working-tree files:\n${result.stdout}`
    );
    assert.ok(changedFilePaths(tmp).includes("c.txt"), "the untracked file must be part of the current-state review");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.7 a HEAD review with a dirty tree announces the uncommitted count on every surface", () => {
  const tmp = makeRepo("main");
  try {
    const shaA = commitFile(tmp, "a.txt", "alpha\n", "A");
    commitFile(tmp, "b.txt", "beta\n", "B");
    fs.writeFileSync(path.join(tmp, "a.txt"), "alpha EDITED\n");
    fs.writeFileSync(path.join(tmp, "c.txt"), "untracked\n");

    const result = runCli(tmp, ["all", "--provider", "mock", "--base", shaA, "--now", FROZEN_NOW]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /includes 2 uncommitted file\(s\) \(working tree\)/,
      `the all summary must announce the uncommitted count:\n${result.stdout}`
    );

    const manifest = readManifest(tmp);
    assert.equal(manifest.uncommitted_files, 2, "the manifest must persist the uncommitted count");

    const patch = fs.readFileSync(path.join(tmp, ".review-surfaces", "inputs", "diff.patch"), "utf8");
    assert.match(patch, /diff --git a\/c\.txt b\/c\.txt/, "the structured diff must include untracked files it counts as reviewed");

    const md = fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.md"), "utf8");
    assert.match(md, /includes 2 uncommitted file\(s\) \(working tree\)/, "human_review.md must carry the line");
    // PR #79 round 4: the warning belongs in the HEADER — a reviewer must see
    // it before the verdict, not buried in the evidence pointers.
    assert.ok(
      md.indexOf("includes 2 uncommitted file(s)") < md.indexOf("## Verdict"),
      "the uncommitted line must appear in the header before the verdict"
    );
    assert.match(md, /`c\.txt`/, "the human review must not count an untracked file while omitting it from reviewer scope");
    const html = fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.html"), "utf8");
    assert.match(html, /includes 2 uncommitted file\(s\) \(working tree\)/, "the cockpit must carry the line");

    const sticky = runCli(tmp, ["comment", "--format", "sticky"]);
    assert.equal(sticky.status, 0, sticky.stderr);
    const comment = fs.readFileSync(path.join(tmp, ".review-surfaces", "comment.md"), "utf8");
    assert.match(comment, /includes 2 uncommitted file\(s\) \(working tree\)/, "the sticky must carry the line");

    // The default `github` alias renders the same human brief as `sticky`.
    const defaultComment = runCli(tmp, ["comment"]);
    assert.equal(defaultComment.status, 0, defaultComment.stderr);
    const defaultMarkdown = fs.readFileSync(path.join(tmp, ".review-surfaces", "comment.md"), "utf8");
    assert.equal(defaultMarkdown, comment);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.REVIEWER_VALUE.5 omitted untracked scope survives the full local report workflow", () => {
  const tmp = makeRepo("main");
  try {
    commitFile(tmp, "README.md", "# repo\n", "init");
    fs.writeFileSync(path.join(tmp, "reviewable.ts"), "export const reviewed = true;\n");
    fs.writeFileSync(path.join(tmp, "oversized.bin"), Buffer.alloc(MAX_UNTRACKED_REVIEW_BYTES + 1));
    const result = runCli(tmp, ["all", "--provider", "mock", "--base", "HEAD", "--head", "HEAD"]);
    assert.equal(result.status, 0, result.stderr);

    const manifest = readManifest(tmp);
    const packet = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), "utf8")) as { manifest: Record<string, unknown> };
    const model = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8")) as HumanReviewModel;
    assert.equal(manifest.uncommitted_files, 1);
    assert.equal(manifest.omitted_untracked_files, 1);
    assert.equal(packet.manifest.omitted_untracked_files, 1);
    assert.notEqual(model.verdict.decision, "probably_safe");

    const surfaces = [
      fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.md"), "utf8"),
      fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.html"), "utf8"),
      renderStickySummary(model).markdown,
      renderStickySummary(model).markdown
    ];
    for (const surface of surfaces) {
      assert.match(surface, /Review scope incomplete/);
      assert.match(surface, /1 untracked file\(s\).*omitted/);
      assert.doesNotMatch(surface, /includes 2 uncommitted/);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.7 a clean-tree HEAD review carries no uncommitted line and a zero count", () => {
  const tmp = makeRepo("main");
  try {
    const shaA = commitFile(tmp, "a.txt", "alpha\n", "A");
    commitFile(tmp, "b.txt", "beta\n", "B");
    const result = runCli(tmp, ["all", "--provider", "mock", "--base", shaA, "--now", FROZEN_NOW]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readManifest(tmp).uncommitted_files, 0);
    const md = fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.md"), "utf8");
    assert.doesNotMatch(md, /uncommitted file/, "a clean run must not render an uncommitted line");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.7 a ROOT output dir (--out .) never counts its own artifacts as working-tree changes", () => {
  const tmp = makeRepo("master");
  try {
    commitFile(tmp, "README.md", "# repo\n", "init");
    git(tmp, ["checkout", "-b", "feature"]);
    commitFile(tmp, "feature.txt", "feature work\n", "add feature");
    const args = ["all", "--provider", "mock", "--now", FROZEN_NOW, "--out", "."];

    const first = runCliRaw(tmp, args);
    assert.equal(first.status, 0, first.stderr);
    const firstManifest = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8")) as Record<string, unknown>;
    assert.equal(firstManifest.uncommitted_files, 0);

    // The first run left untracked artifacts at the REPO ROOT (manifest.json,
    // review_packet.*, inputs/, ...). The second literal-HEAD run must not
    // absorb any of them — this test pins the root-artifact exclusion list, so
    // a new artifact writer that is not excluded turns it red. The draft-review
    // renderer's output is simulated too (PR #79 round 3: pending_review.json
    // was missing from the list).
    fs.writeFileSync(path.join(tmp, "pending_review.json"), "{}\n");
    // REAL user files in same-named directories must NOT be treated as
    // artifact churn (PR #79 round 4): only the exact files the tool writes
    // are excluded at the root.
    fs.writeFileSync(path.join(tmp, "inputs", "app-config.yaml"), "real: true\n");
    fs.mkdirSync(path.join(tmp, "commands"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "commands", "README.md"), "real docs\n");
    const second = runCliRaw(tmp, args);
    assert.equal(second.status, 0, second.stderr);
    const secondManifest = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8")) as Record<string, unknown>;
    assert.equal(
      secondManifest.uncommitted_files,
      2,
      "the second run must count the REAL user files and nothing the tool wrote"
    );
    const changed = JSON.parse(fs.readFileSync(path.join(tmp, "inputs", "changed_files.json"), "utf8")) as {
      files: Array<{ path: string }>;
    };
    assert.deepEqual(
      changed.files.map((file) => file.path),
      ["commands/README.md", "feature.txt", "inputs/app-config.yaml"],
      "the second run's changed set must be the range diff plus the real user files only"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.7 committed artifact changes stay reviewable; working-tree artifact churn does not", () => {
  const tmp = makeRepo("master");
  try {
    fs.mkdirSync(path.join(tmp, ".review-surfaces"));
    commitFile(tmp, path.join(".review-surfaces", "agent_handoff.md"), "handoff v1\n", "track handoff");
    git(tmp, ["checkout", "-b", "feature"]);
    commitFile(tmp, path.join(".review-surfaces", "agent_handoff.md"), "handoff v2\n", "update handoff");
    // Plus pure working-tree artifact churn that must NOT be reviewed.
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "manifest.json"), "{}\n");

    const result = runCliRaw(tmp, ["all", "--provider", "mock", "--now", FROZEN_NOW, "--out", "/tmp/rs-tracked-artifact-out"]);
    assert.equal(result.status, 0, result.stderr);
    const changed = JSON.parse(
      fs.readFileSync("/tmp/rs-tracked-artifact-out/inputs/changed_files.json", "utf8")
    ) as { files: Array<{ path: string }> };
    const paths = changed.files.map((file) => file.path);
    assert.ok(
      paths.includes(".review-surfaces/agent_handoff.md"),
      `a COMMITTED change to a tracked artifact must stay reviewable: ${JSON.stringify(paths)}`
    );
    assert.ok(
      !paths.includes(".review-surfaces/manifest.json"),
      `pure working-tree artifact churn must be excluded: ${JSON.stringify(paths)}`
    );
    const diffPatch = fs.readFileSync("/tmp/rs-tracked-artifact-out/inputs/diff.patch", "utf8");
    assert.ok(diffPatch.includes("agent_handoff.md"), "the committed artifact change must appear in diff.patch");
    assert.ok(!diffPatch.includes("manifest.json"), "working-tree artifact churn must not leak into diff.patch");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync("/tmp/rs-tracked-artifact-out", { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// COLD_START.8 — portable artifacts for any --out
// ---------------------------------------------------------------------------

function listFilesRecursive(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((rel) => path.join(dir, rel))
    .filter((candidate) => fs.statSync(candidate).isFile());
}

test("review-surfaces.COLD_START.8 an out-of-repo --out yields artifacts free of parent-directory and absolute paths", () => {
  const repo = makeRepo("main");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-out-"));
  try {
    const shaA = commitFile(repo, "a.txt", "alpha\n", "A");
    commitFile(repo, "b.txt", "beta\n", "B");

    const result = runCliRaw(repo, [
      "all", "--provider", "mock", "--base", shaA, "--now", FROZEN_NOW, "--out", outside
    ]);
    assert.equal(result.status, 0, result.stderr);

    const realRepo = fs.realpathSync(repo);
    const realOutside = fs.realpathSync(outside);
    for (const file of listFilesRecursive(outside)) {
      const content = fs.readFileSync(file, "utf8");
      assert.equal(
        content.includes("../"),
        false,
        `${path.relative(outside, file)} must not contain a parent-directory path chain`
      );
      for (const absolute of [repo, realRepo, outside, realOutside]) {
        assert.equal(
          content.includes(absolute),
          false,
          `${path.relative(outside, file)} must not embed the machine-specific path ${absolute}`
        );
      }
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.8 artifact bytes are identical between an in-repo and an out-of-repo --out", () => {
  const repo = makeRepo("main");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-out-"));
  try {
    const shaA = commitFile(repo, "a.txt", "alpha\n", "A");
    commitFile(repo, "b.txt", "beta\n", "B");
    const baseArgs = ["all", "--provider", "mock", "--base", shaA, "--now", FROZEN_NOW];

    const inRepo = runCliRaw(repo, [...baseArgs, "--out", ".review-surfaces"]);
    assert.equal(inRepo.status, 0, inRepo.stderr);
    const outRepo = runCliRaw(repo, [...baseArgs, "--out", outside]);
    assert.equal(outRepo.status, 0, outRepo.stderr);

    // manifest.json carries per-out-dir provenance (artifact_signatures) and is
    // machine state, not a rendered surface; everything else must match.
    const inRepoOut = path.join(repo, ".review-surfaces");
    const rendered = listFilesRecursive(inRepoOut)
      .map((file) => path.relative(inRepoOut, file))
      .filter((rel) => rel !== "manifest.json");
    assert.ok(rendered.includes("human_review.html"), "sanity: the cockpit must be among the compared artifacts");
    for (const rel of rendered) {
      const inside = fs.readFileSync(path.join(inRepoOut, rel));
      const outsideBytes = fs.readFileSync(path.join(outside, rel));
      assert.equal(
        inside.equals(outsideBytes),
        true,
        `${rel} must be byte-identical regardless of where --out points`
      );
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
