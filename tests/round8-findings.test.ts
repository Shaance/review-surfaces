import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ingestTestOutputs } from "../src/tests-evidence/junit";
import { analyzeRisks } from "../src/risks/risks";
import { enrichPacket } from "../src/llm/provider";
import { CollectionResult } from "../src/collector/collect";
import { EvaluationModel } from "../src/evaluation/evaluate";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");
const SOURCE_SCHEMA = path.join(process.cwd(), "schemas", "review_packet.schema.json");

function initGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd, stdio: "ignore" });
}

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args, "--out", ".review-surfaces"], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readJson(cwd: string, file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(cwd, ".review-surfaces", file), "utf8"));
}

function readArtifact(cwd: string, file: string): string {
  return fs.readFileSync(path.join(cwd, ".review-surfaces", file), "utf8");
}

// ---------------------------------------------------------------------------
// FINDING A: init in CREATE mode must VALIDATE an existing AGENTS.md (like every
// other scaffold target and like bootstrap's validate-only branch), reporting
// "invalid" for an empty file, while still NEVER overwriting it.
// ---------------------------------------------------------------------------

test("FINDING A: init in a repo with an EMPTY AGENTS.md reports it invalid and does NOT overwrite it", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-r8-findingA-"));
  try {
    spawnSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    // Pre-create an EMPTY (whitespace-only) AGENTS.md. init must never clobber it,
    // but must still validate it and report it invalid.
    const agentsPath = path.join(repo, "AGENTS.md");
    fs.writeFileSync(agentsPath, "   \n\n");

    const run = spawnSync("node", [CLI, "init"], { cwd: repo, encoding: "utf8" });
    assert.equal(run.status, 0, `init itself still exits 0: ${run.stderr}`);
    // The per-target report must mark AGENTS.md invalid (not a bare "exists").
    assert.match(run.stdout, /invalid\s+AGENTS\.md/, `AGENTS.md must be reported invalid:\n${run.stdout}`);

    // No-clobber: the empty file is left byte-identical (init never wrote over it).
    assert.equal(fs.readFileSync(agentsPath, "utf8"), "   \n\n", "init must NOT overwrite the existing AGENTS.md");

    // And bootstrap --strict trips on the same invalid AGENTS.md.
    const strict = spawnSync("node", [CLI, "bootstrap", "--strict"], { cwd: repo, encoding: "utf8" });
    assert.equal(strict.status, 10, `an empty AGENTS.md must trip the strict gate: ${strict.stdout}\n${strict.stderr}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("FINDING A: init in a repo with a NON-empty AGENTS.md reports it exists and does NOT overwrite it", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-r8-findingA-ok-"));
  try {
    spawnSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const agentsPath = path.join(repo, "AGENTS.md");
    const original = "# my own AGENTS.md\n\ncontributor workflow\n";
    fs.writeFileSync(agentsPath, original);

    const run = spawnSync("node", [CLI, "init"], { cwd: repo, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /exists\s+AGENTS\.md/, `a valid existing AGENTS.md must report exists:\n${run.stdout}`);
    assert.equal(fs.readFileSync(agentsPath, "utf8"), original, "init must never clobber an existing AGENTS.md");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING B + FINDING C: per-artifact provenance. A stage (collect/intent) that
// rewrites manifest.json to the current signature while leaving older
// evaluation.yaml/risks.yaml/review_packet.json in place must NOT let a later
// `all --cache` (B) or `packet` (C) reuse those stale artifacts.
// ---------------------------------------------------------------------------

function setupSignatureRepo(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  ALPHA:
    requirements:
      1: The first behavior.
`
  );
  fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
  fs.mkdirSync(path.join(tmp, "schemas"), { recursive: true });
  fs.copyFileSync(SOURCE_SCHEMA, path.join(tmp, "schemas", "review_packet.schema.json"));
  initGitRepo(tmp);
  return tmp;
}

function writeTwoRequirementSpec(tmp: string): void {
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  ALPHA:
    requirements:
      1: The first behavior.
  BETA:
    requirements:
      1: The second, newly-added behavior.
`
  );
}

const STALE_MARKER = "STALE-TAINT-MARKER-DO-NOT-REUSE";

function taintEvaluationSummary(tmp: string): void {
  const evalPath = path.join(tmp, ".review-surfaces", "evaluation.yaml");
  const original = fs.readFileSync(evalPath, "utf8");
  const tainted = original.replace(/^summary:.*$/m, `summary: ${STALE_MARKER}`);
  assert.notEqual(tainted, original, "precondition: evaluation.yaml has a summary line to taint");
  fs.writeFileSync(evalPath, tainted);
}

const BASE_ARGS = ["--base", "HEAD", "--head", "HEAD", "--spec", "features/example.feature.yaml", "--provider", "mock"];

test("FINDING B: all --cache after an intervening collect rewrote the manifest (changed inputs) REGENERATES instead of reusing the stale packet", () => {
  const tmp = setupSignatureRepo("review-surfaces-r8-findingB-");
  try {
    // Stage 1: a full `all` writes review_packet.json and stamps its producing
    // signature into manifest.artifact_signatures.
    assert.equal(runCli(tmp, ["all", ...BASE_ARGS]).status, 0);
    const packet1 = readJson(tmp, "review_packet.json") as {
      evaluation: { results: Array<{ acai_id?: string }> };
    };
    const acids1 = new Set(packet1.evaluation.results.map((result) => result.acai_id));
    assert.ok(acids1.has("example.ALPHA.1"), "first packet covers ALPHA.1");
    assert.ok(!acids1.has("example.BETA.1"), "BETA.1 not present yet");

    // Taint the on-disk packet so a STALE reuse would be detectable as the old bytes.
    // (We assert via the recomputed coverage below, which is the robust signal.)

    // CHANGE THE INPUTS, then run `collect` so manifest.json is rewritten to the NEW
    // signature while review_packet.json is left STALE (this is exactly the B bug
    // surface: shared-manifest-signature freshness would now match).
    writeTwoRequirementSpec(tmp);
    assert.equal(runCli(tmp, ["collect", ...BASE_ARGS]).status, 0);

    const sigAfterCollect = (readJson(tmp, "manifest.json").signature as string) ?? "";
    const artifactSignatures = (readJson(tmp, "manifest.json").artifact_signatures ?? {}) as Record<string, string>;
    assert.notEqual(
      artifactSignatures["review_packet.json"],
      sigAfterCollect,
      "after collect, review_packet.json's PRODUCING signature must NOT equal the new manifest signature (it is stale)"
    );

    // Stage 3: `all --cache`. The top-level manifest signature now matches the
    // current inputs, but review_packet.json's PRODUCING signature does not -> this
    // must be a cache MISS and regenerate against the two-requirement spec.
    const r3 = runCli(tmp, ["all", ...BASE_ARGS, "--cache"]);
    assert.equal(r3.status, 0, r3.stderr);
    assert.doesNotMatch(r3.stdout, /reusing existing packet/, "FINDING B: a stale packet must NOT be reused as a cache hit");

    const packet3 = readJson(tmp, "review_packet.json") as {
      evaluation: { results: Array<{ acai_id?: string }> };
    };
    const acids3 = new Set(packet3.evaluation.results.map((result) => result.acai_id));
    assert.ok(
      acids3.has("example.BETA.1"),
      "FINDING B: the regenerated packet MUST cover the newly-added BETA.1 (proving the stale packet was not reused)"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING B: all --cache with UNCHANGED inputs still reuses the packet (clean hit preserved)", () => {
  const tmp = setupSignatureRepo("review-surfaces-r8-findingB-hit-");
  try {
    assert.equal(runCli(tmp, ["all", ...BASE_ARGS]).status, 0);
    // Second run, identical inputs: review_packet.json's producing signature equals
    // the current signature, so --cache must HIT and reuse.
    const r2 = runCli(tmp, ["all", ...BASE_ARGS, "--cache"]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /reusing existing packet/, "a clean unchanged-input --cache run must still hit");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING C: packet after an intervening collect with CHANGED inputs recomputes coverage/risks instead of loading stale evaluation.yaml", () => {
  const tmp = setupSignatureRepo("review-surfaces-r8-findingC-");
  try {
    // Stage 1: evaluate writes (and stamps) evaluation.yaml under the FIRST inputs.
    assert.equal(runCli(tmp, ["evaluate", ...BASE_ARGS]).status, 0);
    const eval1 = readArtifact(tmp, "evaluation.yaml");
    assert.match(eval1, /ALPHA\.1/, "first evaluation covers ALPHA.1");
    taintEvaluationSummary(tmp);

    // CHANGE INPUTS, then run `collect` so manifest.json is rewritten to the NEW
    // signature while evaluation.yaml is left STALE (its producing signature still
    // points at the old run). A shared-manifest-signature check would now match.
    writeTwoRequirementSpec(tmp);
    assert.equal(runCli(tmp, ["collect", ...BASE_ARGS]).status, 0);

    // Stage 3: packet reuses the SAME --out. evaluation.yaml is stale; FINDING C
    // must recompute coverage from the current spec.
    const r3 = runCli(tmp, ["packet", ...BASE_ARGS]);
    assert.equal(r3.status, 0, r3.stderr);
    const packet = readJson(tmp, "review_packet.json") as {
      evaluation: { summary: string; results: Array<{ acai_id?: string }> };
    };
    assert.doesNotMatch(
      packet.evaluation.summary,
      new RegExp(STALE_MARKER),
      "FINDING C: the stale (tainted) evaluation.yaml must NOT be loaded after an intervening collect changed the inputs"
    );
    const acids = new Set(packet.evaluation.results.map((result) => result.acai_id));
    assert.ok(acids.has("example.BETA.1"), "FINDING C: recomputed coverage MUST include the newly-added BETA.1");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING C: same-run/same-signature reuse still LOADS the prior evaluation.yaml (compose == monolith preserved)", () => {
  const tmp = setupSignatureRepo("review-surfaces-r8-findingC-compose-");
  try {
    // evaluate then packet, UNCHANGED inputs (no intervening collect with new inputs).
    assert.equal(runCli(tmp, ["evaluate", ...BASE_ARGS]).status, 0);
    taintEvaluationSummary(tmp);

    const r2 = runCli(tmp, ["packet", ...BASE_ARGS]);
    assert.equal(r2.status, 0, r2.stderr);
    const packet = readJson(tmp, "review_packet.json") as {
      evaluation: { summary: string; results: Array<{ acai_id?: string }> };
    };
    assert.match(
      packet.evaluation.summary,
      new RegExp(STALE_MARKER),
      "packet must COMPOSE (load) the prior evaluation.yaml when its producing signature matches the current run"
    );
    assert.ok(
      packet.evaluation.results.some((result) => result.acai_id === "example.ALPHA.1"),
      "the composed packet covers ALPHA.1"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING D: the 40-entry parsed-test evidence cap must never HIDE a failing
// test. A failing case that sorts ALPHABETICALLY LAST must still appear.
// ---------------------------------------------------------------------------

function junitWithLateFailure(): string {
  // 45 cases (> the 40 cap). The ONLY failing case sorts alphabetically LAST so the
  // old slice(0, 40) of the alphabetically-sorted list would drop it entirely.
  const passing: string[] = [];
  for (let i = 0; i < 44; i += 1) {
    const name = `aaa_passing_${String(i).padStart(3, "0")}`;
    passing.push(`    <testcase classname="suite" name="${name}" />`);
  }
  // "zzz_..." sorts last among the 45 cases.
  const failing = `    <testcase classname="suite" name="zzz_failing_case">
      <failure message="boom">stack trace</failure>
    </testcase>`;
  return `<?xml version="1.0"?>
<testsuite name="suite" tests="45" failures="1">
${passing.join("\n")}
${failing}
</testsuite>
`;
}

test("FINDING D: a JUnit report with >40 cases where the only failing case sorts alphabetically LAST still appears in risks.test_evidence", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-r8-findingD-"));
  try {
    const junitPath = path.join(tmp, "junit.xml");
    fs.writeFileSync(junitPath, junitWithLateFailure());
    const testResults = ingestTestOutputs(process.cwd(), [junitPath]);
    assert.ok(testResults.cases.length === 45, `precondition: 45 parsed cases, got ${testResults.cases.length}`);

    const collection = {
      changedFiles: [],
      feedback: [],
      commandTranscripts: [],
      commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
      testResults
    } as unknown as CollectionResult;
    const evaluation: EvaluationModel = { summary: "no results", results: [], overreach: [], acai_coverage: {} };

    const risks = analyzeRisks(collection, evaluation, []);

    // The cap keeps at most 40 parsed entries, but the failing case must be among them.
    const parsed = risks.test_evidence.filter((entry) => entry.id.startsWith("TEST-RESULT-"));
    assert.ok(parsed.length <= 40, `the cap still bounds parsed evidence to 40, got ${parsed.length}`);
    const failing = parsed.find((entry) => entry.summary.includes("zzz_failing_case"));
    assert.ok(
      failing,
      "FINDING D: the alphabetically-last FAILING case must NOT be hidden by the 40-entry cap"
    );
    assert.equal(failing?.kind, "missing", "a failing parsed case is recorded as missing evidence");
    // Failures must lead the parsed list so they are never the first to be dropped.
    assert.equal(parsed[0].summary.includes("zzz_failing_case"), true, "failed cases are ordered before passed ones under the cap");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING E: a malformed agent-file array (non-string entries) must not crash
// mergeEnrichment; bad entries are dropped before redaction.
// ---------------------------------------------------------------------------

function enrichTarget(): any {
  return {
    intent: { summary: "intent", assumptions: [] },
    evaluation: { summary: "eval" },
    methodology: { summary: "method", decisions: [] },
    risks: { summary: "risks", review_focus: [], items: [] }
  };
}

test("FINDING E: an agent-file with review_focus: [123] / risk_summaries: [123] does NOT crash and the bad entries are dropped", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-r8-findingE-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "agent.json"),
      JSON.stringify({
        review_focus: [123, "Check the evaluator", true],
        assumptions: [{ nested: "object" }, "valid assumption"],
        methodology_decisions: [42, "valid decision"],
        risk_summaries: [123, "A real hypothesis", null]
      })
    );
    const target = enrichTarget();
    const result = await enrichPacket(target, {
      cwd: tmp,
      outputDir: path.join(tmp, ".review-surfaces"),
      provider: "agent-file",
      agentInput: "agent.json"
    });

    assert.equal(result.status, "applied", "enrichment must not crash on a malformed array");
    // Non-string entries are dropped; only the valid strings survive.
    assert.deepEqual(target.risks.review_focus, ["Check the evaluator"]);
    assert.deepEqual(target.intent.assumptions, ["valid assumption"]);
    assert.deepEqual(target.methodology.decisions, ["valid decision"]);
    // Exactly one AI-RISK item from the single valid risk_summary string.
    assert.equal(target.risks.items.length, 1, "only the valid risk_summary string becomes an AI-RISK item");
    assert.match(target.risks.items[0].summary, /A real hypothesis/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING E: an agent-file whose array values are ENTIRELY non-string drops them all without crashing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-r8-findingE-all-bad-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "agent.json"),
      JSON.stringify({ review_focus: [1, 2, 3], risk_summaries: [{ a: 1 }, false] })
    );
    const target = enrichTarget();
    const result = await enrichPacket(target, {
      cwd: tmp,
      outputDir: path.join(tmp, ".review-surfaces"),
      provider: "agent-file",
      agentInput: "agent.json"
    });
    assert.equal(result.status, "applied");
    assert.deepEqual(target.risks.review_focus, []);
    assert.equal(target.risks.items.length, 0, "no AI-RISK items from an all-non-string risk_summaries");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
