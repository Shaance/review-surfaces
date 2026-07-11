import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { renderComment, type DiagramEmbed } from "../src/render/comment";
import type { ReviewPacket } from "../src/render/packet";
import { readQueueIds, renderRunSummaryFromPacketFile } from "../src/render/summary-json";
import { minimalReviewPacket } from "./helpers/review-packet";
import { isLocalRuntimeArtifactPath } from "./helpers/cli-repo";

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
        && !isLocalRuntimeArtifactPath(relative)
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

test("comment rejects an unknown review surface mode instead of silently using repo", () => {
  const tmp = setupFixture("review-surfaces-scope-typo-");
  try {
    const result = runComment(tmp, ["--mode", "rp"]);
    assert.notEqual(result.status, 0, "a typo'd mode must be a usage error");
    assert.match(result.stderr, /Unknown review surface mode: rp/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("comment rejects conflicting --mode and --review-scope values", () => {
  const tmp = setupFixture("review-surfaces-scope-conflict-");
  try {
    const result = runComment(tmp, ["--mode", "pr", "--review-scope", "repo"]);
    assert.notEqual(result.status, 0, "conflicting surface selectors must be a usage error");
    assert.match(result.stderr, /Conflicting review surface mode flags/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("comment --review-scope pr --format sarif is a usage error (PR surface has no SARIF projection)", () => {
  const tmp = setupFixture("review-surfaces-pr-sarif-");
  try {
    const result = runComment(tmp, ["--review-scope", "pr", "--format", "sarif"]);
    assert.notEqual(result.status, 0, "sarif must not silently emit a whole-repo log in pr scope");
    assert.match(result.stderr, /sarif is not supported with --review-scope pr/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

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
    assert.match(result.stdout, /Full local packet: `review_packet\.md`/);

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

// review-surfaces.COLD_START.8: the published comment's "Full local packet"
// pointer is the SIBLING file name (location-independent) — the comment lives
// next to the packet artifacts it points at, so the pointer is always
// `review_packet.md` / `review_packet.json` regardless of --out / output_dir.
test("review-surfaces.PROVIDERS.1 comment pointer is the sibling file name for any output_dir", () => {
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

    // The pointer is the bare sibling file name, even with a custom output_dir...
    assert.match(
      github.stdout,
      /Full local packet: `review_packet\.md`/,
      "the markdown pointer must be the sibling file name"
    );
    assert.match(
      github.stdout,
      /machine-readable: `review_packet\.json`/,
      "the json pointer must be the sibling file name"
    );
    // ...with no directory prefix (neither the custom dir nor .review-surfaces).
    assert.doesNotMatch(
      github.stdout,
      new RegExp(`${CUSTOM_OUTPUT_DIR}/review_packet`),
      "the comment must not embed the custom output_dir in the pointer"
    );
    assert.doesNotMatch(
      github.stdout,
      /\.review-surfaces\/review_packet/,
      "the comment must not point reviewers at a .review-surfaces-prefixed packet"
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

test("review-surfaces.PROVIDERS.1 comment embeds rendered Mermaid architecture diagrams", () => {
  const tmp = setupFixture("review-surfaces-comment-diagrams-");
  try {
    runAll(tmp);
    const result = runComment(tmp);
    assert.equal(result.status, 0, result.stderr);
    // The valid diagrams the pipeline wrote to diagrams/*.mmd are embedded as
    // <details>-wrapped ```mermaid blocks GitHub renders inline on the PR.
    assert.match(result.stdout, /### Architecture diagrams/);
    assert.match(result.stdout, /<details><summary>Pipeline<\/summary>/);
    assert.match(result.stdout, /```mermaid/);
    assert.match(result.stdout, /flowchart (LR|TB)/);
    // The bodies were actually read from disk (not just referenced by path).
    assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "diagrams", "pipeline.mmd")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.1 comment embeds valid diagrams, omits over-budget ones, and stays optional", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  const diagrams: DiagramEmbed[] = [
    { title: "Pipeline", body: "flowchart LR\n  A-->B" },
    // Over MAX_DIAGRAM_CHARS (4000): must be OMITTED whole, never truncated.
    { title: "Huge", body: `flowchart TB\n${"  X-->Y\n".repeat(2000)}` }
  ];
  const md = renderComment(packet, undefined, diagrams);
  assert.match(md, /### Architecture diagrams/);
  assert.match(md, /<details><summary>Pipeline<\/summary>/);
  assert.match(md, /```mermaid\nflowchart LR\n {2}A-->B\n```/);
  assert.doesNotMatch(md, /summary>Huge/, "an over-budget diagram must be omitted, not truncated");
  assert.match(md, /1 more diagram\(s\) omitted/);

  // Backward compatible: with no diagrams the section is absent entirely.
  assert.doesNotMatch(renderComment(packet, undefined, []), /### Architecture diagrams/);
  assert.doesNotMatch(renderComment(packet), /### Architecture diagrams/);

  // Deterministic: same inputs -> byte-identical comment.
  assert.equal(renderComment(packet, undefined, diagrams), md);
});

test("review-surfaces.PROVIDERS.1 comment diagram embedding is injection-safe (fence + HTML title)", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  const md = renderComment(packet, undefined, [
    { title: "Pipeline", body: "flowchart LR\n  A-->B" },
    // A body that tries to CLOSE the mermaid fence and inject markdown -> omitted whole.
    { title: "Escape", body: "flowchart LR\n  A-->B\n```\n<script>alert(1)</script>" },
    // A title containing HTML -> must be escaped in <summary>, never injected.
    { title: "Evil</summary><img src=x onerror=alert(1)>", body: "flowchart TB\n  X-->Y" }
  ]);
  // The valid diagrams are embedded; the fence-breaking body is omitted so its
  // injected markup never reaches the rendered comment.
  assert.match(md, /```mermaid\nflowchart LR\n {2}A-->B\n```/);
  assert.doesNotMatch(md, /<script>/, "a fence-breaking body must be omitted, not embedded");
  // The HTML title is escaped, not emitted as live markup.
  assert.doesNotMatch(md, /<img /, "an HTML title must be escaped, not injected into <summary>");
  assert.match(md, /&lt;img /);
  // Mermaid arrows in the body are NOT html-escaped (escaping would break rendering).
  assert.match(md, /A-->B/);
  assert.doesNotMatch(md, /A--&gt;B/);
});

test("review-surfaces.PR_SURFACE.2 comment --format sticky renders the deterministic sticky from human_review.json", () => {
  const cwd = setupFixture("rs-sticky-");
  runAll(cwd);
  const result = runComment(cwd, ["--format", "sticky", "--artifact-name", "review-surfaces-pr-7"]);
  assert.equal(result.status, 0);
  // Marker first so the workflow upsert finds the sticky; deterministic sections.
  assert.equal(result.stdout.split("\n")[0], "<!-- review-surfaces:sticky -->");
  assert.match(result.stdout, /## review-surfaces/);
  assert.match(result.stdout, /### Review first/);
  assert.match(result.stdout, /### Trust/);
  assert.match(result.stdout, /download the \*\*review-surfaces-pr-7\*\* workflow artifact/);
  // The sticky was written to comment.md (what the action posts).
  assert.equal(
    fs.readFileSync(path.join(cwd, ".review-surfaces", "comment.md"), "utf8").split("\n")[0],
    "<!-- review-surfaces:sticky -->"
  );
});

test("review-surfaces.PR_SURFACE.2 unknown --format is rejected with guidance listing sticky", () => {
  const cwd = setupFixture("rs-sticky-bad-");
  runAll(cwd);
  const result = runComment(cwd, ["--format", "nope"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown --format.*sticky/);
});

// review-surfaces.QUALITY_GATE.3: `all --json` prints the SAME structured run
// summary to stdout, while the DEFAULT `all` output stays byte-stable (no JSON
// line) so a CI step can opt into one structured line without changing the prose.
test("review-surfaces.QUALITY_GATE.3 all --json prints the structured summary; default all output is unchanged", () => {
  const cwd = setupFixture("rs-all-json-");
  try {
    const baseArgs = ["all", "--base", "HEAD", "--head", "HEAD", "--spec", "features/review-surfaces.feature.yaml", "--provider", "mock", "--out", ".review-surfaces"];

    // Default run: no JSON object anywhere in stdout.
    const plain = spawnSync("node", [CLI, ...baseArgs], { cwd, encoding: "utf8" });
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(
      !/"schema":\s*"review-surfaces\.run-summary\.v1"/.test(plain.stdout),
      "default `all` must NOT print the run-summary JSON line"
    );

    // --json run: the structured object is present and parseable on stdout.
    const withJson = spawnSync("node", [CLI, ...baseArgs, "--json"], { cwd, encoding: "utf8" });
    assert.equal(withJson.status, 0, withJson.stderr);
    // review-surfaces.QUALITY_GATE.3 (Codex finding 5): the summary is emitted as a
    // SINGLE compact line amid the prose, so a CI step can grep one parseable line.
    // Find the exact line that is the run-summary object (not first-`{`-to-last-`}`,
    // which would span prose if any other braces appeared).
    const summaryLine = withJson.stdout.split("\n").find((line) => line.includes('"review-surfaces.run-summary.v1"'));
    assert.ok(summaryLine, "all --json must print the run-summary as one line");
    const summary = JSON.parse(summaryLine!);
    assert.equal(summary.schema, "review-surfaces.run-summary.v1");
    assert.equal(typeof summary.gate_code, "number");
    assert.equal(typeof summary.requirement_counts.missing, "number");

    // The --json projection equals the QUALITY_GATE.2 comment --format json bytes
    // (same packet -> same projection), proving they share one projection.
    const commentJson = runComment(cwd, ["--format", "json"]);
    assert.equal(commentJson.status, 0, commentJson.stderr);
    assert.equal(
      JSON.stringify(JSON.parse(commentJson.stdout)),
      JSON.stringify(summary),
      "all --json and comment --format json must project the same summary"
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.2: `comment --format json` reads the local packet
// and emits a compact, byte-stable run-summary object (gate code, per-status
// requirement counts, risk-severity histogram, top-N queue/risk ids) for CI
// consumers, recomputing nothing — and the SAME packet yields the SAME bytes.
test("review-surfaces.QUALITY_GATE.2 comment --format json emits a deterministic, byte-stable run summary", () => {
  const cwd = setupFixture("rs-json-summary-");
  try {
    runAll(cwd);
    const first = runComment(cwd, ["--format", "json"]);
    assert.equal(first.status, 0, first.stderr);

    const summary = JSON.parse(first.stdout);
    // Schema + the documented shape.
    assert.equal(summary.schema, "review-surfaces.run-summary.v1");
    assert.equal(typeof summary.gate_code, "number");
    // review-surfaces.QUALITY_GATE.2 (Codex finding 7): EVERY contract requirement
    // status is present with its CANONICAL name — no bucket dropped or renamed.
    // "unknown" must be present and "invalid_evidence" must keep its canonical name
    // (not the old "invalid").
    for (const key of ["satisfied", "partial", "missing", "unknown", "overreach", "invalid_evidence"]) {
      assert.equal(typeof summary.requirement_counts[key], "number", `requirement_counts.${key} must be a number`);
    }
    assert.equal(
      summary.requirement_counts.invalid,
      undefined,
      "requirement_counts must use the canonical 'invalid_evidence', not the renamed 'invalid'"
    );
    assert.deepEqual(
      Object.keys(summary.requirement_counts).sort(),
      ["invalid_evidence", "missing", "overreach", "partial", "satisfied", "unknown"],
      "requirement_counts must carry EXACTLY the six contract statuses (canonical names)"
    );
    // Histogram carries every severity bucket (fixed key set).
    for (const severity of ["critical", "high", "medium", "low", "unknown"]) {
      assert.equal(typeof summary.risk_severity_histogram[severity], "number", `histogram.${severity} must be a number`);
    }
    assert.ok(Array.isArray(summary.top_queue_ids), "top_queue_ids must be an array");

    // Byte-determinism: a second render of the SAME packet is byte-identical.
    const second = runComment(cwd, ["--format", "json"]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout, "same packet must render byte-identical JSON");
    // Trailing newline, POSIX-friendly (mirrors the SARIF renderer).
    assert.ok(first.stdout.endsWith("}\n"), "JSON must end with a single trailing newline");
    // review-surfaces.QUALITY_GATE.3 (Codex finding 5): the summary is emitted as a
    // SINGLE compact JSON line (no internal newlines) so a CI step parses one line.
    assert.equal(
      first.stdout.trimEnd().split("\n").length,
      1,
      "the run summary must be a single compact JSON line (no pretty-printed multi-line output)"
    );
    assert.ok(!/\n\s/.test(first.stdout.trimEnd()), "the JSON line must not contain indentation/newlines");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.2 (Codex finding 5): top_queue_ids is the ACTUAL
// ranked review queue (sibling human_review.json review_queue ids), not an empty
// list that silently falls back to risk ids. A normal `all` run writes the queue,
// so the projection must surface those ranked ids.
test("review-surfaces.QUALITY_GATE.2 top_queue_ids comes from the ranked review queue, not the risk ids", () => {
  const cwd = setupFixture("rs-queue-ids-");
  try {
    // Codex finding 2: the queue is trusted only when the packet's head_sha is a
    // REAL resolved commit sha (a sentinel "unknown" can never key freshness). A
    // committed fixture resolves HEAD to a real sha, so the packet head_sha and the
    // queue's generated_from.head_sha agree on a stable identity and the queue is
    // (correctly) used — the realistic in-repo scenario this test asserts.
    execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd, stdio: "ignore" });
    runAll(cwd);
    const queueModel = JSON.parse(fs.readFileSync(path.join(cwd, ".review-surfaces", "human_review.json"), "utf8"));
    const queueIds = (queueModel.review_queue as Array<{ id: string }>).map((item) => item.id);
    assert.ok(queueIds.length > 0, "fixture run must produce a non-empty ranked queue");
    assert.match(
      String(queueModel.generated_from?.head_sha ?? ""),
      /^[0-9a-f]+$/i,
      "the committed fixture must resolve HEAD to a real hex sha so the queue can be trusted"
    );

    const summary = JSON.parse(runComment(cwd, ["--format", "json"]).stdout);
    assert.deepEqual(
      summary.top_queue_ids,
      queueIds.slice(0, 10),
      "top_queue_ids must mirror the ranked review_queue ids (top-10), in order"
    );

    // And it must NOT be the risk-id fallback: the deterministic risk ids differ
    // from the queue ids, so the projection is genuinely reading the queue.
    const packet = JSON.parse(fs.readFileSync(path.join(cwd, ".review-surfaces", "review_packet.json"), "utf8"));
    const riskIds = (packet.risks?.items ?? []).map((item: { id: string }) => item.id);
    assert.notDeepEqual(summary.top_queue_ids, riskIds.slice(0, 10), "queue ids must differ from the risk-id fallback for this fixture");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.2 (Codex finding 1): the projected gate_code must
// honor quality_gate.max_missing / allow_missing, not gate at a hardcoded
// maxMissing 0 with no allowlist. A repo that tolerates N missing requirements
// must NOT see a spurious failing gate in `comment --format json`.
test("review-surfaces.QUALITY_GATE.2 comment --format json honors quality_gate.max_missing/allow_missing in gate_code", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rs-json-gate-config-"));
  try {
    fs.mkdirSync(path.join(cwd, "features"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "features", "example.feature.yaml"),
      `feature:\n  name: example\ncomponents:\n  ZZZ:\n    requirements:\n      1: This requirement has no implementation or tests anywhere.\n`
    );
    fs.writeFileSync(path.join(cwd, "README.md"), "# example\n");
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd, stdio: "ignore" });

    const all = (extra: string[] = []) =>
      execFileSync("node", [CLI, "all", "--base", "HEAD", "--head", "HEAD", "--spec", "features/example.feature.yaml", "--provider", "mock", "--out", ".review-surfaces", ...extra], { cwd, stdio: "ignore" });
    const gateCode = () => JSON.parse(runComment(cwd, ["--format", "json"]).stdout).gate_code;

    // max_missing 0 (default): the lone missing requirement trips the quality gate (10).
    fs.writeFileSync(path.join(cwd, "review-surfaces.config.yaml"), "quality_gate:\n  max_missing: 0\n");
    all();
    const strictSummary = JSON.parse(runComment(cwd, ["--format", "json"]).stdout);
    assert.equal(strictSummary.requirement_counts.missing, 1, "fixture must produce exactly one missing requirement");
    assert.equal(gateCode(), 10, "at max_missing 0 the missing requirement must trip gate_code 10");

    // Raise the tolerance: the SAME missing requirement is now within budget, so
    // the projected gate_code must be 0 — proving the projection reads the config.
    fs.writeFileSync(path.join(cwd, "review-surfaces.config.yaml"), "quality_gate:\n  max_missing: 5\n");
    assert.equal(gateCode(), 0, "quality_gate.max_missing must suppress the gate in the projected gate_code");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.3 (Codex finding 3): the `all --cache` HIT (the
// fastest reuse path) must still emit the --json run summary, not silently accept
// --json and print nothing.
test("review-surfaces.QUALITY_GATE.3 all --cache --json prints the run summary on the cache-hit fast path", () => {
  const cwd = setupFixture("rs-cache-json-");
  try {
    const baseArgs = ["all", "--cache", "--base", "HEAD", "--head", "HEAD", "--spec", "features/review-surfaces.feature.yaml", "--provider", "mock", "--now", "2026-01-01T00:00:00Z", "--out", ".review-surfaces"];

    // Prime the cache.
    const first = spawnSync("node", [CLI, ...baseArgs], { cwd, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);

    // Second run is a cache hit AND requests --json: the structured summary must
    // appear, exactly like the non-cache path.
    const hit = spawnSync("node", [CLI, ...baseArgs, "--json"], { cwd, encoding: "utf8" });
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout + hit.stderr, /inputs unchanged/, "second run must be a cache hit");
    const summaryLine = hit.stdout.split("\n").find((line) => line.includes('"review-surfaces.run-summary.v1"'));
    assert.ok(summaryLine, "all --cache --json must print the run-summary as one line on the cache hit");
    const summary = JSON.parse(summaryLine!);
    assert.equal(summary.schema, "review-surfaces.run-summary.v1");

    // The cache-hit summary equals comment --format json for the same artifacts.
    const commentJson = runComment(cwd, ["--format", "json"]);
    assert.equal(commentJson.status, 0, commentJson.stderr);
    assert.equal(
      JSON.stringify(JSON.parse(commentJson.stdout)),
      JSON.stringify(summary),
      "cache-hit --json and comment --format json must project the same summary"
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.2 (Codex finding 2): runCommentJson reads
// --max-missing via gateOptionsFor, so the comment command's CLI.9 allow-list must
// ACCEPT --max-missing — not reject it as an unknown flag. And the flag must move
// the projected gate_code, proving the renderer genuinely honors it.
test("review-surfaces.QUALITY_GATE.2 comment --format json accepts --max-missing and honors it in gate_code", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rs-comment-max-missing-"));
  try {
    fs.mkdirSync(path.join(cwd, "features"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "features", "example.feature.yaml"),
      `feature:\n  name: example\ncomponents:\n  ZZZ:\n    requirements:\n      1: This requirement has no implementation or tests anywhere.\n`
    );
    fs.writeFileSync(path.join(cwd, "README.md"), "# example\n");
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd, stdio: "ignore" });
    execFileSync("node", [CLI, "all", "--base", "HEAD", "--head", "HEAD", "--spec", "features/example.feature.yaml", "--provider", "mock", "--out", ".review-surfaces"], { cwd, stdio: "ignore" });

    // Without the flag (config default max_missing 0): the lone missing requirement trips gate 10.
    const baseline = runComment(cwd, ["--format", "json"]);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).gate_code, 10, "default max_missing 0 must trip gate_code 10");

    // `comment --format json --max-missing 5` must be ACCEPTED (not an Unknown flag
    // usage error) AND raise the tolerance so the same miss no longer trips the gate.
    const tolerant = runComment(cwd, ["--format", "json", "--max-missing", "5"]);
    assert.equal(tolerant.status, 0, `--max-missing must be accepted on comment, got: ${tolerant.stderr}`);
    assert.doesNotMatch(tolerant.stderr, /Unknown flag/, "--max-missing must not be rejected as an unknown flag");
    assert.equal(JSON.parse(tolerant.stdout).gate_code, 0, "--max-missing must suppress the gate in the projected gate_code");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.2 (Codex finding 4): a STALE human_review.json
// (from an older run over a DIFFERENT head_sha) must NOT supply the ranked queue
// for the current packet. The projection compares the packet manifest head_sha
// against the queue file's generated_from.head_sha and falls back to the
// deterministic risk ids on a mismatch.
test("review-surfaces.QUALITY_GATE.2 comment --format json ignores a stale human_review.json (head_sha mismatch) and falls back to risk ids", () => {
  const cwd = setupFixture("rs-stale-queue-");
  try {
    runAll(cwd);
    const humanReviewPath = path.join(cwd, ".review-surfaces", "human_review.json");
    const queueModel = JSON.parse(fs.readFileSync(humanReviewPath, "utf8"));
    // Rewrite the sibling queue as if it were generated from a DIFFERENT head — its
    // queue ids stay, but its generated_from.head_sha no longer matches the packet.
    queueModel.generated_from = { ...(queueModel.generated_from ?? {}), head_sha: "stale-deadbeef-sha" };
    fs.writeFileSync(humanReviewPath, JSON.stringify(queueModel));

    const summary = JSON.parse(runComment(cwd, ["--format", "json"]).stdout);
    const packet = JSON.parse(fs.readFileSync(path.join(cwd, ".review-surfaces", "review_packet.json"), "utf8"));
    const riskIds = (packet.risks?.items ?? []).map((item: { id: string }) => item.id).slice(0, 10);
    // Stale queue ignored -> deterministic risk ids drive top_queue_ids.
    assert.deepEqual(summary.top_queue_ids, riskIds, "a stale human_review.json must be ignored; top_queue_ids must fall back to the risk ids");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.2 (Codex finding 8): a human_review.json that
// parses to a SCALAR (e.g. `null`) — not an object — must NEVER throw on property
// access; the renderer falls back to the deterministic risk ids and exits 0.
test("review-surfaces.QUALITY_GATE.2 comment --format json never throws on a scalar human_review.json; falls back to risk ids", () => {
  const cwd = setupFixture("rs-scalar-queue-");
  try {
    runAll(cwd);
    const humanReviewPath = path.join(cwd, ".review-surfaces", "human_review.json");
    // A scalar JSON value where an object is expected.
    fs.writeFileSync(humanReviewPath, "null\n");

    const result = runComment(cwd, ["--format", "json"]);
    assert.equal(result.status, 0, `a scalar human_review.json must not crash the renderer, got: ${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    const packet = JSON.parse(fs.readFileSync(path.join(cwd, ".review-surfaces", "review_packet.json"), "utf8"));
    const riskIds = (packet.risks?.items ?? []).map((item: { id: string }) => item.id).slice(0, 10);
    assert.deepEqual(summary.top_queue_ids, riskIds, "a scalar human_review.json must fall back to the risk ids");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.2 (Codex finding 2): the "unknown" head_sha
// sentinel (no git repo / unresolved HEAD) is NEVER a valid freshness key. Outside
// a git repo BOTH the packet AND a stale human_review.json carry head_sha
// "unknown", so a naive string match would trust the STALE queue. readQueueIds must
// reject a sentinel expectedHeadSha and return [] so the caller falls back to risk
// ids — even though the queue file's generated_from.head_sha equals the sentinel.
test("review-surfaces.QUALITY_GATE.2 readQueueIds rejects the 'unknown' head_sha sentinel even when the queue's key matches it", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-sentinel-queue-"));
  try {
    const outDir = path.join(tmp, ".review-surfaces");
    fs.mkdirSync(outDir, { recursive: true });
    // A queue file whose generated_from.head_sha is the SAME "unknown" sentinel.
    fs.writeFileSync(
      path.join(outDir, "human_review.json"),
      JSON.stringify({
        generated_from: { head_sha: "unknown" },
        review_queue: [{ id: "STALE-1" }, { id: "STALE-2" }]
      })
    );

    // A REAL sha still binds normally (control): a matching real sha trusts the queue.
    const real = readQueueIds(tmp, ".review-surfaces", "unknown");
    assert.deepEqual(real, [], "a sentinel 'unknown' head_sha must never trust the queue, even when the queue's key is also 'unknown'");

    // Control: with a real hex sha that matches AND a repo-mode queue, it IS trusted.
    fs.writeFileSync(
      path.join(outDir, "human_review.json"),
      JSON.stringify({
        mode: "repo",
        generated_from: { head_sha: "deadbeef" },
        review_queue: [{ id: "Q-1" }]
      })
    );
    assert.deepEqual(
      readQueueIds(tmp, ".review-surfaces", "deadbeef"),
      ["Q-1"],
      "a REAL hex head_sha that matches the queue's generated_from.head_sha (repo mode) is trusted"
    );
    // Other non-hex sentinels ("HEAD", empty) are rejected too.
    assert.deepEqual(readQueueIds(tmp, ".review-surfaces", "HEAD"), [], "the 'HEAD' sentinel is not a real sha");
    assert.deepEqual(readQueueIds(tmp, ".review-surfaces", ""), [], "an empty head_sha is not a real sha");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.2 (Codex finding 2), end-to-end: a packet whose
// manifest head_sha is the "unknown" sentinel must NOT inherit a stale, string-
// matching queue. renderRunSummaryFromPacketFile reads the packet head_sha
// verbatim, so the sentinel reaches the guard and the projection falls back to the
// deterministic risk ids instead of the stale queue's ids.
test("review-surfaces.QUALITY_GATE.2 renderRunSummaryFromPacketFile with a sentinel head_sha falls back to risk ids over a string-matching stale queue", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-sentinel-e2e-"));
  try {
    const outDir = path.join(tmp, ".review-surfaces");
    fs.mkdirSync(outDir, { recursive: true });
    const packet = minimalReviewPacket() as unknown as ReviewPacket;
    packet.manifest.head_sha = "unknown"; // the not-resolved sentinel
    packet.risks.items = [
      { id: "RISK-DET-1", category: "correctness", severity: "high", summary: "deterministic", evidence: [] }
    ] as unknown as ReviewPacket["risks"]["items"];
    fs.writeFileSync(path.join(outDir, "review_packet.json"), JSON.stringify(packet));
    // A stale queue whose generated_from.head_sha ALSO equals the "unknown" sentinel.
    fs.writeFileSync(
      path.join(outDir, "human_review.json"),
      JSON.stringify({
        generated_from: { head_sha: "unknown" },
        review_queue: [{ id: "STALE-Q-1" }]
      })
    );

    const rendered = renderRunSummaryFromPacketFile(tmp, ".review-surfaces");
    assert.ok(rendered, "the packet exists, so a summary must render");
    assert.deepEqual(
      rendered!.summary.top_queue_ids,
      ["RISK-DET-1"],
      "a sentinel head_sha must fall back to the deterministic risk ids, never the stale string-matching queue"
    );
    assert.ok(!rendered!.summary.top_queue_ids.includes("STALE-Q-1"), "the stale queue id must not leak in");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.2 / ACTION_IO (Codex finding 3): the JSON run
// summary is a WHOLE-REPO packet projection and never reads the PR sidecar
// (pr_review_surface.json). Combining --format json with --review-scope pr would
// silently emit repo-wide counts/queue ids under a PR flag, so it must FAIL FAST
// (mirroring the --format sarif fail-fast), not produce a silently-wrong summary.
test("review-surfaces.ACTION_IO comment --review-scope pr --format json is a usage error (JSON summary is repo-scope only)", () => {
  const tmp = setupFixture("rs-pr-json-reject-");
  try {
    const result = runComment(tmp, ["--review-scope", "pr", "--format", "json"]);
    assert.notEqual(result.status, 0, "json must not silently emit a whole-repo summary in pr scope");
    assert.match(result.stderr, /json is not supported with --review-scope pr/);
    // The same rejection applies via the --mode pr alias for review scope.
    const aliased = runComment(tmp, ["--mode", "pr", "--format", "json"]);
    assert.notEqual(aliased.status, 0, "the --mode pr alias must reject --format json too");
    assert.match(aliased.stderr, /json is not supported with --review-scope pr/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.2 (Codex round-4 finding 1): the REPO-scope JSON
// summary must NOT borrow a PR-scoped queue. When the sibling human_review.json
// was produced by `all --review-scope pr`, its mode is "pr" and its review_queue
// is built from the PR sidecar — a PR-scoped queue, not the whole-repo one this
// summary describes. readQueueIds must trust the queue ONLY when its mode is
// "repo"; a "pr" (or absent) mode falls back to the deterministic risk ids.
test("review-surfaces.QUALITY_GATE.2 readQueueIds ignores a PR-mode human_review.json queue (falls back to risk ids)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-pr-mode-queue-"));
  try {
    const outDir = path.join(tmp, ".review-surfaces");
    fs.mkdirSync(outDir, { recursive: true });

    // A PR-mode queue whose head_sha MATCHES (so only the mode gate can reject it):
    // its ids are PR-scoped and must NOT drive the repo summary.
    fs.writeFileSync(
      path.join(outDir, "human_review.json"),
      JSON.stringify({
        mode: "pr",
        generated_from: { head_sha: "deadbeef" },
        review_queue: [{ id: "PR-SCOPED-1" }, { id: "PR-SCOPED-2" }]
      })
    );
    assert.deepEqual(
      readQueueIds(tmp, ".review-surfaces", "deadbeef"),
      [],
      "a PR-mode queue must be ignored even when its head_sha matches; the caller falls back to risk ids"
    );

    // The SAME queue in repo mode (head_sha still matching) IS trusted — proving
    // the mode is the only thing that changed the decision.
    fs.writeFileSync(
      path.join(outDir, "human_review.json"),
      JSON.stringify({
        mode: "repo",
        generated_from: { head_sha: "deadbeef" },
        review_queue: [{ id: "REPO-SCOPED-1" }, { id: "REPO-SCOPED-2" }]
      })
    );
    assert.deepEqual(
      readQueueIds(tmp, ".review-surfaces", "deadbeef"),
      ["REPO-SCOPED-1", "REPO-SCOPED-2"],
      "a repo-mode queue with a matching head_sha is trusted"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY_GATE.2 (Codex round-4 finding 2), end-to-end: a packet
// produced by `all --provider ai-sdk` over a remote_provider_blocked diff records
// the persisted manifest.gate_remote_blocked: true. `comment --format json` is a
// RENDERER with no live collection/provider, yet it must reproduce the SAME
// privacy gate code (5) the strict gate exited — from the packet ALONE — instead
// of a spurious 0 from a hardcoded mock context. The run is fully offline: the
// ai-sdk enrichment skips (no key), but the collection still flags the block.
test("review-surfaces.QUALITY_GATE.2 comment --format json reproduces the privacy block (5) from an ai-sdk packet over a blocked diff", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rs-json-privacy-block-"));
  try {
    fs.mkdirSync(path.join(cwd, "features"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "features", "example.feature.yaml"),
      `feature:\n  name: example\ncomponents:\n  ZZZ:\n    requirements:\n      1: A requirement.\n`
    );
    fs.writeFileSync(path.join(cwd, "README.md"), "# example\n");
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd, stdio: "ignore" });
    // A high-severity blocked secret (an AWS access key id) STAGED in the working
    // tree (added, uncommitted). A literal `--head HEAD` review folds the staged
    // diff (`git diff --cached`) into the reviewed diff, so the secret's added
    // line is scanned, the redacted diff is flagged remote_provider_blocked, and
    // an ai-sdk run (remote-capable) privacy-blocks (gate code 5).
    fs.writeFileSync(path.join(cwd, "deploy.txt"), "aws_key=AKIAIOSFODNN7EXAMPLE\n");
    execFileSync("git", ["add", "deploy.txt"], { cwd, stdio: "ignore" });

    // Run `all --provider ai-sdk` fully offline (no API key): enrichment skips, but
    // the collection flags the block and the manifest records gate_remote_blocked.
    execFileSync(
      "node",
      [CLI, "all", "--base", "HEAD", "--head", "HEAD", "--spec", "features/example.feature.yaml", "--provider", "ai-sdk", "--out", ".review-surfaces"],
      { cwd, stdio: "ignore", env: { ...process.env, ANTHROPIC_API_KEY: "", GOOGLE_GENERATIVE_AI_API_KEY: "", OPENAI_API_KEY: "" } }
    );

    // The packet persisted the EXACT provider-adjusted privacy condition.
    const packet = JSON.parse(fs.readFileSync(path.join(cwd, ".review-surfaces", "review_packet.json"), "utf8"));
    assert.equal(
      packet.manifest.gate_remote_blocked,
      true,
      "an ai-sdk run over a remote_provider_blocked diff must persist manifest.gate_remote_blocked: true"
    );

    // The renderer reproduces privacy code 5 from the packet alone.
    const json = runComment(cwd, ["--format", "json"]);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(
      JSON.parse(json.stdout).gate_code,
      5,
      "comment --format json must reproduce the privacy gate code (5) from the persisted packet field, not a spurious 0"
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
