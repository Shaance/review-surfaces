import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

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
// FINDING A: AGENTS.md is part of the BOOTSTRAP.2/5 + README scaffold. It must be
// REQUIRED for `bootstrap --strict` (missing/invalid -> exit 10), while init must
// still never clobber an existing AGENTS.md.
// ---------------------------------------------------------------------------

// Scaffold every OTHER required target so AGENTS.md is the sole differentiator.
function scaffoldAllExceptAgents(repo: string): void {
  // Run a full init (creates everything including AGENTS.md), then delete AGENTS.md
  // so the only required target missing is AGENTS.md.
  assert.equal(spawnSync("node", [CLI, "init"], { cwd: repo, encoding: "utf8" }).status, 0);
  fs.rmSync(path.join(repo, "AGENTS.md"), { force: true });
}

test("FINDING A: bootstrap --strict in a repo with all scaffold but NO AGENTS.md exits 10", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-findingA-noagents-"));
  try {
    spawnSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    scaffoldAllExceptAgents(repo);
    assert.equal(
      fs.existsSync(path.join(repo, "AGENTS.md")),
      false,
      "precondition: AGENTS.md is the only missing required scaffold target"
    );
    // Every other required target is present...
    assert.ok(fs.existsSync(path.join(repo, "review-surfaces.config.yaml")));
    assert.ok(fs.existsSync(path.join(repo, "schemas", "review_packet.schema.json")));

    const strict = spawnSync("node", [CLI, "bootstrap", "--strict"], { cwd: repo, encoding: "utf8" });
    assert.equal(strict.status, 10, `a missing AGENTS.md must trip the strict quality gate: ${strict.stdout}\n${strict.stderr}`);
    assert.match(strict.stdout + strict.stderr, /quality gate failed/i);
    // The AGENTS.md line is reported as missing.
    assert.match(strict.stdout, /missing\s+AGENTS\.md/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("FINDING A: bootstrap --strict in a repo with a present AGENTS.md (full scaffold) exits 0", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-findingA-withagents-"));
  try {
    spawnSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    // Full init creates AGENTS.md too.
    assert.equal(spawnSync("node", [CLI, "init"], { cwd: repo, encoding: "utf8" }).status, 0);
    assert.ok(fs.existsSync(path.join(repo, "AGENTS.md")), "init created AGENTS.md");

    const strict = spawnSync("node", [CLI, "bootstrap", "--strict"], { cwd: repo, encoding: "utf8" });
    assert.equal(strict.status, 0, `a present AGENTS.md (full scaffold) must pass: ${strict.stderr}`);
    assert.match(strict.stdout, /exists\s+AGENTS\.md/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("FINDING A: an EMPTY AGENTS.md fails bootstrap --strict; init never clobbers a user AGENTS.md", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-findingA-empty-"));
  try {
    spawnSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    assert.equal(spawnSync("node", [CLI, "init"], { cwd: repo, encoding: "utf8" }).status, 0);

    // Replace AGENTS.md with a user-owned EMPTY (whitespace-only) file.
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "   \n");
    const strict = spawnSync("node", [CLI, "bootstrap", "--strict"], { cwd: repo, encoding: "utf8" });
    assert.equal(strict.status, 10, "an empty/invalid AGENTS.md must fail the strict gate");
    assert.match(strict.stdout, /invalid\s+AGENTS\.md/);

    // NO-OVERWRITE preserved: init (even --force) must not clobber the user's file.
    const ownAgents = "# my own AGENTS\nkeep this.\n";
    fs.writeFileSync(path.join(repo, "AGENTS.md"), ownAgents);
    assert.equal(spawnSync("node", [CLI, "init", "--force"], { cwd: repo, encoding: "utf8" }).status, 0);
    assert.equal(
      fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"),
      ownAgents,
      "init --force must never clobber an existing AGENTS.md"
    );
    // ...and a present, valid user AGENTS.md now passes strict.
    assert.equal(spawnSync("node", [CLI, "bootstrap", "--strict"], { cwd: repo, encoding: "utf8" }).status, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING B (dedup): running `risks` then `packet` in the same --out (agent-file)
// must NOT append the same risk_summaries twice. loadRisks() feeds the prior
// AI-RISK items back into the packet; the packet-level enrichPacket must dedupe so
// the risk register is not inflated with duplicate AI-RISK ids/summaries.
// ---------------------------------------------------------------------------

function setupAgentRiskRepo(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "thing.ts"), "export const thing = 1;\n");
  fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
  // schemas/ so packet validation / dedup can read it where needed.
  fs.mkdirSync(path.join(tmp, "schemas"), { recursive: true });
  fs.copyFileSync(SOURCE_SCHEMA, path.join(tmp, "schemas", "review_packet.schema.json"));
  fs.writeFileSync(
    path.join(tmp, "agent-input.json"),
    JSON.stringify({ risk_summaries: ["A possible unhandled error path in src/thing.ts."] }, null, 2)
  );
  initGitRepo(tmp);
  return tmp;
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

test("FINDING B: `risks` then `packet` (same --out, agent-file) yields NO duplicate AI-RISK items", () => {
  const tmp = setupAgentRiskRepo("review-surfaces-findingB-dedup-");
  try {
    const args = ["--base", "HEAD", "--head", "HEAD", "--provider", "agent-file", "--agent-input", "agent-input.json"];

    // Stage 1: risks writes an enriched risks.yaml carrying the AI-RISK item.
    const r1 = runCli(tmp, ["risks", ...args]);
    assert.equal(r1.status, 0, r1.stderr);
    const risksYaml = readArtifact(tmp, "risks.yaml");
    assert.match(risksYaml, /AI-RISK-001/, "the risks stage surfaced the agent risk_summary");

    // Stage 2: packet loads that risks.yaml (re-feeding AI-RISK) AND runs the
    // packet-level enrichPacket again. The dedup must prevent a second copy.
    const r2 = runCli(tmp, ["packet", ...args]);
    assert.equal(r2.status, 0, r2.stderr);

    const packet = readJson(tmp, "review_packet.json") as {
      risks: { items: Array<{ id: string; summary: string }> };
    };
    const aiRisks = packet.risks.items.filter((item) => item.id.startsWith("AI-RISK-"));
    assert.equal(aiRisks.length, 1, `expected exactly one AI-RISK item, got ${JSON.stringify(aiRisks)}`);

    // The summary appears exactly once (no duplicate id/summary inflation).
    const summaries = packet.risks.items.map((item) => item.summary);
    assert.equal(
      summaries.filter((s) => s.includes("A possible unhandled error path in src/thing.ts.")).length,
      1,
      "the agent risk_summary must appear exactly once after risks->packet"
    );

    // And the rendered review_packet.json text does not carry duplicate AI-RISK ids.
    const raw = fs.readFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), "utf8");
    assert.equal(countMatches(raw, /"AI-RISK-001"/g), 1, "AI-RISK-001 must not be duplicated in the packet");
    assert.equal(countMatches(raw, /"AI-RISK-002"/g), 0, "no second AI-RISK item should be created on re-enrichment");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING C: with `areas:` configured, the candidate-evidence stage must use the
// SAME config-derived review areas evaluateIntent uses, so a config-area-mapped
// citation (e.g. src/cli/* for a *.CLI.* requirement) is recognized as a
// deterministic tie and upgrades missing -> partial. An UNRELATED in-pool path
// (not config-group-mapped, no ACID) must STILL stay missing (round-4 Finding D
// soundness, NOT re-loosened).
// ---------------------------------------------------------------------------

const CONFIG_WITH_CLI_AREA = `output_dir: .review-surfaces
specs:
  - features/**/*.feature.yaml
areas:
  - id: SUB-CLI
    name: CLI orchestration
    group_key: CLI
    prefixes:
      - src/cli/
    purpose: Parse commands and wire stages.
    pattern: command dispatcher
    test_keywords:
      - cli
  - id: SUB-DATA
    name: Data layer
    group_key: DATA
    prefixes:
      - src/data/
    purpose: Persist records.
    pattern: repository
    test_keywords:
      - data
`;

// A repo with `areas:` configured. The CLI group (-> src/cli/) has an in-pool
// changed file, so example.CLI.1 is deterministically PARTIAL (config-area mapping
// is a deterministic tie). The DATA group (-> src/data/) has NO changed file, so
// example.DATA.1 stays deterministically MISSING (only its spec source ref) -- the
// genuinely-unsupported requirement used to exercise the EVIDENCE.4 exit-4 path
// without it being a deterministically-backed verdict the agent could corrupt.
function setupConfigAreaRepo(prefix: string, agentInput: Record<string, unknown>): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "cli"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "other"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  CLI:
    requirements:
      1: The CLI dispatcher must parse commands.
  DATA:
    requirements:
      1: The data layer must persist records.
`
  );
  fs.writeFileSync(path.join(tmp, "review-surfaces.config.yaml"), CONFIG_WITH_CLI_AREA);
  fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
  fs.writeFileSync(path.join(tmp, "agent-input.json"), JSON.stringify(agentInput, null, 2));
  initGitRepo(tmp);
  // In-pool working-tree changes AFTER the commit (so --base HEAD --head HEAD sees
  // them as changed): one in the CLI config area, one unrelated.
  fs.writeFileSync(path.join(tmp, "src", "cli", "index.ts"), "export const dispatch = () => 'ok';\n");
  fs.writeFileSync(path.join(tmp, "src", "other", "unrelated.ts"), "export const unrelated = 1;\n");
  return tmp;
}

function packetResults(tmp: string): Array<{ acai_id?: string; status: string; evidence?: Array<{ llm_proposed?: boolean; path?: string }> }> {
  const packet = readJson(tmp, "review_packet.json") as {
    evaluation: { results: Array<{ acai_id?: string; status: string; evidence?: Array<{ llm_proposed?: boolean; path?: string }> }> };
  };
  return packet.evaluation.results;
}

// FINDING C is verified at the unit level in tests/reasoning.test.ts, where the
// candidate-evidence stage can be isolated from the deterministic evaluator (which
// already auto-maps a changed src/cli/ file to the CLI group, so an end-to-end CLI
// repo cannot leave a CLI requirement deterministically "missing" for the LLM tie
// to be the deciding factor). Those tests prove: a config-area-mapped citation
// upgrades missing -> partial (and the SAME citation stays missing under the
// fallback cluster areas, i.e. WITHOUT the threaded config areas), while an
// unrelated path stays missing even with config areas (round-4 D soundness intact).

// ---------------------------------------------------------------------------
// FINDING D (EVIDENCE.4): a genuinely-invalid LLM-proposed ref (in-pool path but
// out-of-range line) on a GENUINELY-UNSUPPORTED requirement (no valid deterministic
// backing -- only its spec source ref) must turn the requirement into
// invalid_evidence so it is surfaced AND the --strict exit-4 evidence gate catches
// it -- even in a run that would otherwise pass the missing/quality gate.
//
// ROUND-5 SOUNDNESS (paired below): the SAME invalid agent ref aimed at a
// deterministically-PARTIAL requirement (real backing evidence) must NOT corrupt
// that sound verdict. So this test targets example.DATA.1 (deterministically
// missing, no mapped changed file) rather than example.CLI.1 (deterministically
// partial via config-area mapping), which would otherwise be wrongly demoted.
// ---------------------------------------------------------------------------

test("FINDING D: an invalid LLM-proposed ref makes an unsupported requirement invalid_evidence and --strict returns exit 4", () => {
  const tmp = setupConfigAreaRepo("review-surfaces-findingD-invalid-", {
    requirements: [
      {
        // example.DATA.1 is deterministically MISSING (no src/data/ change maps to
        // it), so it carries only a valid spec source ref -- no deterministic
        // backing the agent could be corrupting.
        acai_id: "example.DATA.1",
        // In-pool path (src/other/unrelated.ts is a changed file) BUT with a line
        // range far beyond the file's length -> validateEvidenceRef returns invalid
        // ("line range is outside the referenced file"). A genuinely-invalid ref.
        candidate_evidence: [
          { kind: "file", path: "src/other/unrelated.ts", line_start: 9000, line_end: 9001, note: "bad line range" }
        ],
        rationale: "Invalid line range hypothesis."
      }
    ]
  });
  try {
    const run = spawnSync(
      "node",
      [
        CLI,
        "all",
        "--base",
        "HEAD",
        "--head",
        "HEAD",
        "--spec",
        "features/example.feature.yaml",
        "--provider",
        "agent-file",
        "--agent-input",
        "agent-input.json",
        "--out",
        ".review-surfaces",
        "--strict",
        // Tolerate the missing requirement so the ONLY gate that can trip is the
        // exit-4 evidence gate, proving the invalid ref is what surfaces.
        "--max-missing",
        "5"
      ],
      { cwd: tmp, encoding: "utf8" }
    );
    assert.equal(run.status, 4, `an invalid LLM-proposed ref must trip the exit-4 evidence gate: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /Strict gate tripped \(exit 4\)/);

    const data = packetResults(tmp).find((result) => result.acai_id === "example.DATA.1");
    assert.equal(data?.status, "invalid_evidence", "a genuinely-invalid LLM ref on an unsupported requirement must make it invalid_evidence");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ROUND-5 SOUNDNESS (E2E, paired with the test above): the SAME genuinely-invalid
// agent ref aimed at a deterministically-PARTIAL requirement (real config-area
// backing) must NOT demote it to invalid_evidence or trip exit 4. example.CLI.1 is
// deterministically partial (src/cli/index.ts maps to CLI); an invented bad-range
// agent ref must stay surfaced as a rejected hypothesis but leave the sound verdict.
test("ROUND-5 SOUNDNESS: an invalid agent ref does NOT demote a deterministically-partial requirement (no exit 4)", () => {
  const tmp = setupConfigAreaRepo("review-surfaces-round5-partial-soundness-", {
    requirements: [
      {
        acai_id: "example.CLI.1",
        candidate_evidence: [
          { kind: "file", path: "src/cli/index.ts", line_start: 9000, line_end: 9001, note: "bad line range" }
        ],
        rationale: "Invalid line range hypothesis against a backed requirement."
      }
    ]
  });
  try {
    const run = spawnSync(
      "node",
      [
        CLI,
        "all",
        "--base",
        "HEAD",
        "--head",
        "HEAD",
        "--spec",
        "features/example.feature.yaml",
        "--provider",
        "agent-file",
        "--agent-input",
        "agent-input.json",
        "--out",
        ".review-surfaces",
        "--strict",
        "--max-missing",
        "5"
      ],
      { cwd: tmp, encoding: "utf8" }
    );
    assert.equal(run.status, 0, `an invalid agent ref must NOT trip exit 4 on a deterministically-backed verdict: ${run.stdout}\n${run.stderr}`);
    const cli = packetResults(tmp).find((result) => result.acai_id === "example.CLI.1") as
      | { acai_id?: string; status: string; missing_evidence?: Array<{ validation_status?: string }> }
      | undefined;
    assert.equal(cli?.status, "partial", "a deterministically-partial verdict must survive an invalid agent ref");
    assert.ok(
      cli?.missing_evidence?.some((ref) => ref.validation_status === "invalid"),
      "the invalid agent ref is still surfaced as a rejected hypothesis"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING D: a VALID config-mapped hypothesis on the same requirement does NOT trigger invalid_evidence (gate not over-tightened)", () => {
  // Negative control: a valid in-pool, config-mapped citation upgrades to partial
  // and does NOT trip exit 4 (only genuinely-invalid refs do).
  const tmp = setupConfigAreaRepo("review-surfaces-findingD-valid-", {
    requirements: [
      {
        acai_id: "example.CLI.1",
        candidate_evidence: [{ kind: "file", path: "src/cli/index.ts", note: "valid in-range hypothesis" }],
        rationale: "Valid config-area-mapped citation."
      }
    ]
  });
  try {
    const run = spawnSync(
      "node",
      [
        CLI,
        "all",
        "--base",
        "HEAD",
        "--head",
        "HEAD",
        "--spec",
        "features/example.feature.yaml",
        "--provider",
        "agent-file",
        "--agent-input",
        "agent-input.json",
        "--out",
        ".review-surfaces",
        "--strict",
        "--max-missing",
        "5"
      ],
      { cwd: tmp, encoding: "utf8" }
    );
    assert.equal(run.status, 0, `a valid hypothesis must NOT trip the evidence gate: ${run.stderr}`);
    const cli = packetResults(tmp).find((result) => result.acai_id === "example.CLI.1");
    assert.equal(cli?.status, "partial", "a valid config-mapped hypothesis upgrades to partial, not invalid_evidence");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING E: reusing the same --out after the inputs changed (different signature)
// must RECOMPUTE coverage/risks for the packet stage instead of loading the stale
// prior-stage artifacts.
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

// Taint a prior-stage artifact's summary with a recognizable marker so a later
// packet run that LOADS it (compose) carries the marker, while a run that
// RECOMPUTES it (stale) drops the marker. This is the byte-level signal that
// distinguishes compose from recompute regardless of log wording.
const STALE_MARKER = "STALE-TAINT-MARKER-DO-NOT-REUSE";

function taintEvaluationSummary(tmp: string): void {
  const evalPath = path.join(tmp, ".review-surfaces", "evaluation.yaml");
  const original = fs.readFileSync(evalPath, "utf8");
  // Replace the leading `summary:` line with a tainted one (the load layer reads
  // evaluation.summary, which flows into review_packet.json's evaluation.summary).
  const tainted = original.replace(/^summary:.*$/m, `summary: ${STALE_MARKER}`);
  assert.notEqual(tainted, original, "precondition: evaluation.yaml has a summary line to taint");
  fs.writeFileSync(evalPath, tainted);
}

test("FINDING E: packet after the inputs changed (different signature) recomputes coverage/risks instead of loading stale artifacts", () => {
  const tmp = setupSignatureRepo("review-surfaces-findingE-");
  try {
    const baseArgs = ["--base", "HEAD", "--head", "HEAD", "--spec", "features/example.feature.yaml", "--provider", "mock"];

    // Stage 1: evaluate writes evaluation.yaml under the FIRST input set.
    assert.equal(runCli(tmp, ["evaluate", ...baseArgs]).status, 0);
    const sig1 = (readJson(tmp, "manifest.json").signature as string) ?? "";
    assert.ok(sig1.length > 0, "the first run records a signature");
    const eval1 = readArtifact(tmp, "evaluation.yaml");
    assert.match(eval1, /ALPHA\.1/, "the first evaluation covers ALPHA.1");
    assert.doesNotMatch(eval1, /BETA\.1/, "BETA.1 is not present before the spec changed");
    // Taint the prior evaluation so we can prove the stale artifact was NOT reused.
    taintEvaluationSummary(tmp);

    // CHANGE THE INPUTS: add a second requirement to the spec. This changes the
    // collection signature (the spec input hash changes).
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

    // Stage 2: packet reuses the SAME --out. The prior evaluation.yaml is now
    // STALE (it predates the spec change). FINDING E must recompute coverage from
    // the current spec rather than publish the stale evaluation.
    const r2 = runCli(tmp, ["packet", ...baseArgs]);
    assert.equal(r2.status, 0, r2.stderr);

    const sig2 = (readJson(tmp, "manifest.json").signature as string) ?? "";
    assert.notEqual(sig2, sig1, "the spec change is a different signature");

    const packet = readJson(tmp, "review_packet.json") as {
      evaluation: { summary: string; results: Array<{ acai_id?: string }> };
    };
    // The tainted (stale) summary must NOT survive: coverage was recomputed.
    assert.doesNotMatch(
      packet.evaluation.summary,
      new RegExp(STALE_MARKER),
      "the stale (tainted) evaluation.yaml must NOT be loaded after the inputs changed"
    );
    const acids = new Set(packet.evaluation.results.map((result) => result.acai_id));
    assert.ok(acids.has("example.ALPHA.1"), "the recomputed coverage still includes ALPHA.1");
    assert.ok(
      acids.has("example.BETA.1"),
      "the recomputed coverage MUST include the newly-added BETA.1 (proving stale evaluation.yaml was not reused)"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING E: with UNCHANGED inputs, packet still composes the prior evaluation.yaml (signature match)", () => {
  const tmp = setupSignatureRepo("review-surfaces-findingE-compose-");
  try {
    const baseArgs = ["--base", "HEAD", "--head", "HEAD", "--spec", "features/example.feature.yaml", "--provider", "mock"];

    // Stage 1: evaluate writes evaluation.yaml.
    assert.equal(runCli(tmp, ["evaluate", ...baseArgs]).status, 0);
    // Taint it: with UNCHANGED inputs the signature matches, so packet must LOAD
    // (compose) this evaluation.yaml -- the tainted summary must survive.
    taintEvaluationSummary(tmp);

    // Stage 2: packet with UNCHANGED inputs -> the signature matches -> the prior
    // (tainted) evaluation.yaml is loaded (composed), NOT recomputed.
    const r2 = runCli(tmp, ["packet", ...baseArgs]);
    assert.equal(r2.status, 0, r2.stderr);
    const packet = readJson(tmp, "review_packet.json") as {
      evaluation: { summary: string; results: Array<{ acai_id?: string }> };
    };
    assert.match(
      packet.evaluation.summary,
      new RegExp(STALE_MARKER),
      "packet must compose (load) the prior evaluation.yaml when inputs are unchanged"
    );
    assert.ok(
      packet.evaluation.results.some((result) => result.acai_id === "example.ALPHA.1"),
      "the composed packet covers ALPHA.1"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
