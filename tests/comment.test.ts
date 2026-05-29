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

test("review-surfaces.PROVIDERS.1 comment enforces a real length bound on pathological free-text", () => {
  const tmp = setupFixture("review-surfaces-comment-bound-");
  try {
    runAll(tmp);
    // Inject pathological free-text into the local packet: huge risk and
    // requirement summaries plus an unbounded foreign-repo path. The bound must
    // hold regardless of input length, not by luck of short mock summaries.
    const packetPath = path.join(tmp, ".review-surfaces", "review_packet.json");
    const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
    const big = "X".repeat(200000);
    packet.risks.items.unshift({ id: "RISK-BIG", category: "correctness", severity: "high", summary: big, evidence: [] });
    if (packet.evaluation.results.length > 0) {
      packet.evaluation.results[0].status = "missing";
      packet.evaluation.results[0].summary = big;
    }
    fs.writeFileSync(packetPath, JSON.stringify(packet, null, 2));

    const result = runComment(tmp);
    assert.equal(result.status, 0, result.stderr);

    // Total comment stays well under GitHub's ~65,536-char per-comment limit.
    assert.ok(
      result.stdout.length < 65536,
      `comment must stay under the GitHub per-comment limit, was ${result.stdout.length} chars`
    );
    // No single line carries the unbounded 200k field: per-line truncation holds.
    const longestLine = Math.max(...result.stdout.split("\n").map((line) => line.length));
    assert.ok(longestLine < 1000, `no line should be unbounded, longest was ${longestLine} chars`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.EVIDENCE.6 comment does not intermix LLM hypothesis risks into deterministic Top risks", () => {
  const tmp = setupFixture("review-surfaces-comment-toprisks-");
  try {
    fs.writeFileSync(path.join(tmp, "agent-input.json"), AGENT_INPUT_FIXTURE);
    // Offline agent-file provider appends LLM-RISK-* hypotheses (severity unknown,
    // llm_proposed-only evidence). They must be quarantined under the hypotheses
    // header, mirroring the SARIF renderer, NOT listed under "### Top risks".
    runAll(tmp, ["--provider", "agent-file", "--agent-input", "agent-input.json"]);
    const result = runComment(tmp);
    assert.equal(result.status, 0, result.stderr);

    // Slice out just the deterministic Top risks block.
    const topRisksBlock = result.stdout.slice(
      result.stdout.indexOf("### Top risks"),
      result.stdout.indexOf("### Requirement coverage")
    );
    assert.doesNotMatch(topRisksBlock, /LLM-RISK/, "LLM hypothesis risks must not appear under deterministic Top risks");

    // They MUST still be surfaced under the labeled hypotheses section.
    const hypothesesBlock = result.stdout.slice(
      result.stdout.indexOf("### LLM/agent hypotheses")
    );
    assert.match(hypothesesBlock, /LLM-RISK-001/);
    assert.match(hypothesesBlock, /LLM-RISK-002/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FINDING D: agent-file risk_summaries become AI-RISK-* items in the packet.
// Their evidence ref must be marked llm_proposed so isHypothesisOnly quarantines
// them. Before the fix the missing marker let AI-RISK items render as deterministic
// top risks; they must instead surface only under the hypotheses section.
test("review-surfaces.EVIDENCE.6 comment quarantines agent-file AI-RISK risk_summaries under hypotheses", () => {
  const tmp = setupFixture("review-surfaces-comment-airisk-");
  try {
    fs.writeFileSync(
      path.join(tmp, "agent-input.json"),
      JSON.stringify({ risk_summaries: ["A possible race condition in the worker"] }, null, 2)
    );
    runAll(tmp, ["--provider", "agent-file", "--agent-input", "agent-input.json"]);
    const result = runComment(tmp);
    assert.equal(result.status, 0, result.stderr);

    // The AI-RISK hypothesis must NOT appear under the deterministic Top risks block.
    const topRisksBlock = result.stdout.slice(
      result.stdout.indexOf("### Top risks"),
      result.stdout.indexOf("### Requirement coverage")
    );
    assert.doesNotMatch(topRisksBlock, /AI-RISK/, "AI-RISK hypotheses must not appear under deterministic Top risks");

    // It MUST be surfaced under the labeled hypotheses section.
    const hypothesesBlock = result.stdout.slice(result.stdout.indexOf("### LLM/agent hypotheses"));
    assert.match(hypothesesBlock, /AI-RISK-001/, "the AI-RISK hypothesis must be quarantined into the hypotheses section");
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

// FINDING C: comment WITHOUT --out must resolve the effective output dir from
// config (--out else config.output_dir else .review-surfaces), the SAME
// precedence collectInputs/`all` use. Before the fix comment passed undefined and
// the renderer hardcoded .review-surfaces, so a repo that configured a custom
// output_dir (and where `all` wrote the packet there) got a spurious "no packet"
// usage error. This covers BOTH the github and sarif formats.
const CUSTOM_OUTPUT_DIR = ".review-surfaces-custom";

function runAllNoOut(cwd: string, extra: string[] = []): void {
  execFileSync(
    "node",
    [CLI, "all", "--base", "HEAD", "--head", "HEAD", "--spec", "features/review-surfaces.feature.yaml", "--provider", "mock", ...extra],
    { cwd, stdio: "ignore" }
  );
}

function runCommentNoOut(cwd: string, extra: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, "comment", ...extra], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("review-surfaces.PROVIDERS.1/.2 comment without --out reads the configured output_dir for both github and sarif", () => {
  const tmp = setupFixture("review-surfaces-comment-customdir-");
  try {
    // Point output_dir somewhere OTHER than .review-surfaces and gitignore it so
    // generated artifacts never perturb the diff. setupFixture copies the repo's
    // own config; overwrite it for this fixture.
    fs.writeFileSync(
      path.join(tmp, "review-surfaces.config.yaml"),
      `schema_version: review-surfaces.config.v1\noutput_dir: ${CUSTOM_OUTPUT_DIR}\n`
    );
    fs.appendFileSync(path.join(tmp, ".gitignore"), `\n${CUSTOM_OUTPUT_DIR}/\n`);

    // `all` WITHOUT --out writes the packet under the CONFIGURED dir.
    runAllNoOut(tmp);
    assert.ok(
      fs.existsSync(path.join(tmp, CUSTOM_OUTPUT_DIR, "review_packet.json")),
      "all (no --out) must write the packet under the configured output_dir"
    );
    assert.ok(
      !fs.existsSync(path.join(tmp, ".review-surfaces", "review_packet.json")),
      ".review-surfaces must NOT be used when config sets output_dir"
    );

    // comment --format github WITHOUT --out must find the packet under the configured dir.
    const github = runCommentNoOut(tmp);
    assert.equal(github.status, 0, github.stderr);
    assert.match(github.stdout, /### Requirement coverage/, "comment must render from the configured-dir packet");
    assert.ok(
      fs.existsSync(path.join(tmp, CUSTOM_OUTPUT_DIR, "comment.md")),
      "comment.md must be written under the configured output_dir"
    );

    // comment --format sarif WITHOUT --out must likewise find the packet.
    const sarif = runCommentNoOut(tmp, ["--format", "sarif"]);
    assert.equal(sarif.status, 0, sarif.stderr);
    assert.match(sarif.stdout, /sarif-schema-2\.1\.0\.json/, "sarif must render from the configured-dir packet");
    assert.ok(
      fs.existsSync(path.join(tmp, CUSTOM_OUTPUT_DIR, "review.sarif")),
      "review.sarif must be written under the configured output_dir"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FINDING A (round 3): the published comment's "Full local packet" pointer must
// reference the EFFECTIVE output dir the renderer actually read, not a hardcoded
// .review-surfaces path. In a repo with a custom output_dir the hardcoded link
// would point at a non-existent/stale packet. The pointer (markdown + json) must
// reflect the custom dir and must NOT mention .review-surfaces.
test("review-surfaces.PROVIDERS.1 comment pointer reflects a custom output_dir (not a hardcoded .review-surfaces link)", () => {
  const tmp = setupFixture("review-surfaces-comment-pointer-");
  try {
    fs.writeFileSync(
      path.join(tmp, "review-surfaces.config.yaml"),
      `schema_version: review-surfaces.config.v1\noutput_dir: ${CUSTOM_OUTPUT_DIR}\n`
    );
    fs.appendFileSync(path.join(tmp, ".gitignore"), `\n${CUSTOM_OUTPUT_DIR}/\n`);

    runAllNoOut(tmp);
    const github = runCommentNoOut(tmp);
    assert.equal(github.status, 0, github.stderr);

    // The pointer must name the configured dir's packet artifacts...
    assert.match(
      github.stdout,
      new RegExp(`Full local packet: \`${CUSTOM_OUTPUT_DIR}/review_packet\\.md\``),
      "the markdown pointer must reference the configured output_dir"
    );
    assert.match(
      github.stdout,
      new RegExp(`machine-readable: \`${CUSTOM_OUTPUT_DIR}/review_packet\\.json\``),
      "the json pointer must reference the configured output_dir"
    );
    // ...and must NOT carry the stale hardcoded .review-surfaces link.
    assert.doesNotMatch(
      github.stdout,
      /\.review-surfaces\/review_packet/,
      "the comment must not point reviewers at a non-existent .review-surfaces packet"
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
