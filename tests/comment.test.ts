import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");

// Mirror the cli.test.ts fixture harness: copy the repo (minus .git, dist, and
// .review-surfaces) into a temp dir and init a fresh git repo so the pipeline
// can run fully offline against the real feature spec.
function setupFixture(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(process.cwd(), tmp, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(process.cwd(), source);
      return relative !== ".git"
        && !relative.startsWith(`.git${path.sep}`)
        && relative !== ".review-surfaces"
        && !relative.startsWith(`.review-surfaces${path.sep}`)
        && relative !== "dist"
        && !relative.startsWith(`dist${path.sep}`);
    }
  });
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  return tmp;
}

// Generate review_packet.json via the real pipeline (mock provider, fully
// offline). The comment renderer only READS this artifact.
function runAll(cwd: string, extra: string[] = []): void {
  execFileSync(
    "node",
    [
      CLI,
      "all",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--spec",
      "features/review-surfaces.feature.yaml",
      "--provider",
      "mock",
      "--out",
      ".review-surfaces",
      ...extra
    ],
    { cwd, stdio: "ignore" }
  );
}

// Run the comment command capturing stdout/stderr/status. The comment markdown
// is written to stdout; the "Wrote ..." notice goes to stderr.
function runComment(cwd: string, extra: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, "comment", "--out", ".review-surfaces", ...extra], {
    cwd,
    encoding: "utf8"
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const AGENT_INPUT_FIXTURE = JSON.stringify(
  {
    summary: "Synthesized intent hypothesis.",
    assumptions: ["An assumption hypothesis."],
    risk_narratives: ["A possible concurrency risk.", "A possible data-loss risk."]
  },
  null,
  2
);

test("review-surfaces.PROVIDERS.1 comment renders a compact sticky comment with status summary", () => {
  const tmp = setupFixture("review-surfaces-comment-");
  try {
    runAll(tmp);
    const result = runComment(tmp);
    assert.equal(result.status, 0, result.stderr);

    // First line is the sticky marker HTML comment so CI can upsert it.
    assert.equal(result.stdout.split("\n")[0], "<!-- review-surfaces:sticky -->");
    assert.match(result.stdout, /review-surfaces:sticky/);

    // A one-line status summary with the status buckets + overreach count.
    assert.match(result.stdout, /Status: \d+ satisfied, \d+ partial, \d+ missing, \d+ unknown, \d+ invalid evidence, \d+ overreach item\(s\)\./);

    // Compact, capped sections plus a pointer to the full local packet.
    assert.match(result.stdout, /### Top review focus/);
    assert.match(result.stdout, /### Top risks/);
    assert.match(result.stdout, /### Requirement coverage/);
    assert.match(result.stdout, /Full local packet: `\.review-surfaces\/review_packet\.md`/);

    // The artifact is written under --out and equals stdout.
    const commentPath = path.join(tmp, ".review-surfaces", "comment.md");
    assert.ok(fs.existsSync(commentPath), "comment.md should be written under --out");
    assert.equal(fs.readFileSync(commentPath, "utf8"), result.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.1 comment is review-sized (length-bounded)", () => {
  const tmp = setupFixture("review-surfaces-comment-size-");
  try {
    runAll(tmp);
    const result = runComment(tmp);
    assert.equal(result.status, 0, result.stderr);
    // Well under a typical PR comment size (GitHub allows ~65k chars). Caps keep
    // it tiny; assert a generous-but-real upper bound.
    assert.ok(
      result.stdout.length < 8000,
      `rendered comment should be compact, was ${result.stdout.length} chars`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.EVIDENCE.6 comment clearly labels LLM/agent hypotheses as non-proof", () => {
  const tmp = setupFixture("review-surfaces-comment-hyp-");
  try {
    fs.writeFileSync(path.join(tmp, "agent-input.json"), AGENT_INPUT_FIXTURE);
    // Offline agent-file provider contributes bounded hypotheses (no network).
    runAll(tmp, ["--provider", "agent-file", "--agent-input", "agent-input.json"]);
    const result = runComment(tmp);
    assert.equal(result.status, 0, result.stderr);

    // The hypotheses section header must mark them as NOT proof, and must require
    // verification against deterministic evidence.
    assert.match(
      result.stdout,
      /### LLM\/agent hypotheses \(NOT proof; verify against deterministic evidence\)/
    );
    // Hypotheses are never presented as the satisfied/coverage proof.
    assert.doesNotMatch(result.stdout, /hypotheses.*satisfied/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.1 comment render is byte-deterministic across two renders", () => {
  const tmp = setupFixture("review-surfaces-comment-det-");
  try {
    runAll(tmp);
    const first = runComment(tmp);
    const firstArtifact = fs.readFileSync(path.join(tmp, ".review-surfaces", "comment.md"), "utf8");
    const second = runComment(tmp);
    const secondArtifact = fs.readFileSync(path.join(tmp, ".review-surfaces", "comment.md"), "utf8");

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout, "two renders of the same packet must be byte-identical");
    assert.equal(firstArtifact, secondArtifact, "the written artifact must be byte-stable across renders");
    assert.equal(first.stdout, firstArtifact, "stdout and the written artifact must match");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.1 missing packet is a clean usage error pointing at `all`", () => {
  const tmp = setupFixture("review-surfaces-comment-missing-");
  try {
    // No `all` run: review_packet.json is absent. comment must NOT recompute.
    assert.equal(fs.existsSync(path.join(tmp, ".review-surfaces", "review_packet.json")), false);
    const result = runComment(tmp);
    assert.equal(result.status, 2, "absent packet must exit with the usage error code");
    assert.match(result.stderr, /No review packet JSON found/);
    assert.match(result.stderr, /review-surfaces all/);
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "comment.md")),
      false,
      "no comment.md should be written when the packet is absent"
    );
    // It must not have recomputed the pipeline as a side effect.
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "review_packet.json")),
      false,
      "comment must never recompute review_packet.json"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.1 default comment does not invoke --post (no network)", () => {
  const tmp = setupFixture("review-surfaces-comment-nopost-");
  try {
    // Shim a `gh` on PATH that records every invocation. Without --post it must
    // never be called, proving the default offline path takes no network action.
    const binDir = path.join(tmp, "fake-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const ghLog = path.join(tmp, "gh-invocations.log");
    const ghShim = path.join(binDir, "gh");
    fs.writeFileSync(ghShim, `#!/bin/sh\necho "$@" >> "${ghLog}"\nexit 0\n`);
    fs.chmodSync(ghShim, 0o755);

    runAll(tmp);
    const result = spawnSync("node", [CLI, "comment", "--out", ".review-surfaces"], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.existsSync(ghLog),
      false,
      "gh must never be invoked without --post (default path takes no network action)"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
