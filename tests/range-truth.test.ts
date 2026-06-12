import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { CLI, runCli } from "./helpers/cli-repo";

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

function changedFilePaths(cwd: string, outDir = ".review-surfaces"): string[] {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(cwd, outDir, "inputs", "changed_files.json"), "utf8")
  ) as { files: Array<{ path: string }> };
  return parsed.files.map((file) => file.path);
}

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

    const md = fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.md"), "utf8");
    assert.match(md, /includes 2 uncommitted file\(s\) \(working tree\)/, "human_review.md must carry the line");
    const html = fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.html"), "utf8");
    assert.match(html, /includes 2 uncommitted file\(s\) \(working tree\)/, "the cockpit must carry the line");

    const sticky = runCli(tmp, ["comment", "--format", "sticky"]);
    assert.equal(sticky.status, 0, sticky.stderr);
    const comment = fs.readFileSync(path.join(tmp, ".review-surfaces", "comment.md"), "utf8");
    assert.match(comment, /includes 2 uncommitted file\(s\) \(working tree\)/, "the sticky must carry the line");
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
    // a new artifact writer that is not excluded turns it red.
    const second = runCliRaw(tmp, args);
    assert.equal(second.status, 0, second.stderr);
    const secondManifest = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8")) as Record<string, unknown>;
    assert.equal(
      secondManifest.uncommitted_files,
      0,
      "the second run must not count the first run's artifacts as uncommitted files"
    );
    const changed = JSON.parse(fs.readFileSync(path.join(tmp, "inputs", "changed_files.json"), "utf8")) as {
      files: Array<{ path: string }>;
    };
    assert.deepEqual(
      changed.files.map((file) => file.path),
      ["feature.txt"],
      "the second run's changed set must still be exactly the range diff"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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
