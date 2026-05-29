import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { validateJsonSchema } from "../src/schema/json-schema";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");
const PACKET_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schemas", "review_packet.schema.json"), "utf8")
);

function setupComposeFixture(prefix: string): string {
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

function runStage(cwd: string, command: string, extra: string[] = []): void {
  execFileSync(
    "node",
    [
      CLI,
      command,
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

// Run a stage against the offline agent-file provider so the reasoning stages
// (intent synthesis, candidate evidence, narrative) actually contribute. No
// network: bounded hypotheses come from a local --agent-input file.
function runAgentStage(cwd: string, command: string): void {
  execFileSync(
    "node",
    [
      CLI,
      command,
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--spec",
      "features/review-surfaces.feature.yaml",
      "--provider",
      "agent-file",
      "--agent-input",
      "agent-input.json",
      "--out",
      ".review-surfaces"
    ],
    { cwd, stdio: "ignore" }
  );
}

// The `commands` provenance records the literal subcommand that produced an
// artifact (e.g. "review-surfaces all ..." vs "review-surfaces risks ...").
// That invocation-identity difference is inherent to composition (like
// created_at / repo paths) and is normalized away when asserting compose==monolith.
function stripCommandProvenance(yaml: string): string {
  return yaml.replace(
    /review-surfaces (all|collect|intent|evaluate|methodology|risks|diagrams|packet)\b/g,
    "review-surfaces CMD"
  );
}

const AGENT_INPUT_FIXTURE = JSON.stringify(
  {
    summary: "Synthesized intent hypothesis.",
    assumptions: ["An assumption hypothesis."],
    non_goals: ["A non-goal hypothesis."],
    open_questions: ["An open question hypothesis."],
    considered: ["Considered an alternative approach."],
    decisions: ["Chose the deterministic-first path."],
    risk_narratives: ["A possible concurrency risk.", "A possible data-loss risk."]
  },
  null,
  2
);

test("review-surfaces.CLI.4a intent subcommand writes intent.yaml only, not a full packet", () => {
  const tmp = setupComposeFixture("review-surfaces-compose-intent-");
  try {
    runStage(tmp, "intent");
    assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "intent.yaml")), "intent.yaml should exist");
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "review_packet.json")),
      false,
      "intent must not write review_packet.json"
    );
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "evaluation.yaml")),
      false,
      "intent must not write evaluation.yaml"
    );
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "risks.yaml")),
      false,
      "intent must not write risks.yaml"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.CLI.4a collect+intent+evaluate composes to match a single all run", () => {
  const composeDir = setupComposeFixture("review-surfaces-compose-eval-");
  const allDir = setupComposeFixture("review-surfaces-compose-all-");
  try {
    // Separate invocations: evaluate reads the intent.yaml that intent wrote.
    runStage(composeDir, "collect");
    runStage(composeDir, "intent");
    runStage(composeDir, "evaluate");

    runStage(allDir, "all");

    const composeEval = fs.readFileSync(path.join(composeDir, ".review-surfaces", "evaluation.yaml"), "utf8");
    const allEval = fs.readFileSync(path.join(allDir, ".review-surfaces", "evaluation.yaml"), "utf8");
    assert.equal(composeEval, allEval, "composed evaluation.yaml should equal the monolith all run");

    const composeIntent = fs.readFileSync(path.join(composeDir, ".review-surfaces", "intent.yaml"), "utf8");
    const allIntent = fs.readFileSync(path.join(allDir, ".review-surfaces", "intent.yaml"), "utf8");
    assert.equal(composeIntent, allIntent, "composed intent.yaml should equal the monolith all run");

    // Composing intent+evaluate must not have produced the full packet.
    assert.equal(
      fs.existsSync(path.join(composeDir, ".review-surfaces", "review_packet.json")),
      false,
      "intent+evaluate composition must not write review_packet.json"
    );
  } finally {
    fs.rmSync(composeDir, { recursive: true, force: true });
    fs.rmSync(allDir, { recursive: true, force: true });
  }
});

test("review-surfaces.CLI.4a a stage succeeds by computing an absent dependency", () => {
  const tmp = setupComposeFixture("review-surfaces-compose-absent-");
  try {
    // evaluate with NO prior intent.yaml: it must compute intent and still
    // write only its own evaluation.yaml.
    assert.equal(fs.existsSync(path.join(tmp, ".review-surfaces", "intent.yaml")), false);
    runStage(tmp, "evaluate");
    assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "evaluation.yaml")), "evaluation.yaml should exist");
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "intent.yaml")),
      false,
      "evaluate computes intent in-memory but must not write intent.yaml"
    );

    // risks with NO prior evaluation/methodology: computes both, writes only risks.yaml.
    fs.rmSync(path.join(tmp, ".review-surfaces", "evaluation.yaml"), { force: true });
    runStage(tmp, "risks");
    assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "risks.yaml")), "risks.yaml should exist");
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "evaluation.yaml")),
      false,
      "risks computes evaluation in-memory but must not write evaluation.yaml"
    );

    // packet with NO prior artifacts: computes all and writes a valid packet.
    fs.rmSync(path.join(tmp, ".review-surfaces", "risks.yaml"), { force: true });
    runStage(tmp, "packet");
    assert.ok(
      fs.existsSync(path.join(tmp, ".review-surfaces", "review_packet.json")),
      "packet should write review_packet.json"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Regression: under a NON-mock provider (offline agent-file), the reasoning
// stages enrich methodology (considered/decisions) and risks (review_focus +
// narrative items). The composed methodology/risks/packet stages must reproduce
// the SAME enrichment the monolith `all` writes, so compose==monolith holds for
// methodology.yaml and risks.yaml (modulo the command-name provenance string).
test("review-surfaces.CLI.4a composed methodology/risks match `all` under offline agent-file enrichment", () => {
  const composeDir = setupComposeFixture("review-surfaces-agent-compose-");
  const allDir = setupComposeFixture("review-surfaces-agent-all-");
  try {
    fs.writeFileSync(path.join(composeDir, "agent-input.json"), AGENT_INPUT_FIXTURE);
    fs.writeFileSync(path.join(allDir, "agent-input.json"), AGENT_INPUT_FIXTURE);

    runAgentStage(allDir, "all");

    runAgentStage(composeDir, "collect");
    runAgentStage(composeDir, "intent");
    runAgentStage(composeDir, "evaluate");
    runAgentStage(composeDir, "methodology");
    runAgentStage(composeDir, "risks");

    const read = (dir: string, file: string): string =>
      stripCommandProvenance(fs.readFileSync(path.join(dir, ".review-surfaces", file), "utf8"));

    // The monolith `all` run actually enriched methodology + risks (otherwise this
    // test would pass vacuously). Assert the narrative landed on both artifacts.
    const allMethodology = read(allDir, "methodology.yaml");
    const allRisks = read(allDir, "risks.yaml");
    assert.match(allMethodology, /LLM-proposed:/, "monolith methodology must carry narrative enrichment");
    assert.match(allRisks, /LLM-RISK-/, "monolith risks must carry narrative risk items");

    assert.equal(
      read(composeDir, "methodology.yaml"),
      allMethodology,
      "composed methodology.yaml must equal the monolith all run (incl. narrative enrichment)"
    );
    assert.equal(
      read(composeDir, "risks.yaml"),
      allRisks,
      "composed risks.yaml must equal the monolith all run (incl. review_focus + narrative items)"
    );
  } finally {
    fs.rmSync(composeDir, { recursive: true, force: true });
    fs.rmSync(allDir, { recursive: true, force: true });
  }
});

// FINDING B: `evaluate --provider <non-mock>` WITHOUT a pre-existing intent.yaml
// must run the SAME enriched-intent path as `intent` (deterministic synthesis +
// the resolved provider's intent-reasoning stage), not deterministic-only intent.
// In a sparse/foreign repo (no Acai spec) the intent-reasoning stage is the ONLY
// path that adds validated candidate_requirements, so before the fix the evaluate
// fallback wrote an evaluation.yaml MISSING them while `intent` then `evaluate`
// (which evaluates the ENRICHED intent) included them.
function setupSparseRepo(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  // No features/ Acai spec at all -> isSparseSpec true, so candidate_requirements
  // from the agent-file intent-reasoning stage are accepted.
  fs.writeFileSync(path.join(tmp, "src", "worker.ts"), "export const worker = () => 'runs';\n");
  fs.writeFileSync(path.join(tmp, "README.md"), "# sparse\n");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
  // A bounded agent-file hypothesis proposing one candidate requirement that cites
  // a REAL repo file (so evidence validation accepts it).
  fs.writeFileSync(
    path.join(tmp, "agent-input.json"),
    JSON.stringify(
      {
        summary: "Sparse-repo intent hypothesis.",
        candidate_requirements: [
          {
            title: "Worker entrypoint",
            requirement: "The worker entrypoint in src/worker.ts must run.",
            source_ref: { path: "src/worker.ts", note: "worker module" }
          }
        ]
      },
      null,
      2
    )
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });
  return tmp;
}

function runSparseStage(cwd: string, command: string): { status: number | null; stderr: string } {
  const result = spawnSync(
    "node",
    [CLI, command, "--base", "HEAD", "--head", "HEAD", "--provider", "agent-file", "--agent-input", "agent-input.json", "--out", ".review-surfaces"],
    { cwd, encoding: "utf8" }
  );
  return { status: result.status, stderr: result.stderr };
}

test("review-surfaces.CLI.4a evaluate (no prior intent.yaml) runs enriched intent so candidate_requirements match `intent` then `evaluate` in a sparse repo", () => {
  const evalDir = setupSparseRepo("review-surfaces-sparse-eval-");
  const stagedDir = setupSparseRepo("review-surfaces-sparse-staged-");
  try {
    // Reference: `intent` then `evaluate` evaluates the ENRICHED intent (with the
    // candidate requirement), so the candidate flows into evaluation.yaml.
    assert.equal(runSparseStage(stagedDir, "intent").status, 0);
    const stagedEvalRun = runSparseStage(stagedDir, "evaluate");
    assert.equal(stagedEvalRun.status, 0, stagedEvalRun.stderr);
    const stagedEval = fs.readFileSync(path.join(stagedDir, ".review-surfaces", "evaluation.yaml"), "utf8");
    assert.match(
      stagedEval,
      /REQ-LLM-/,
      "intent then evaluate must include the LLM-derived candidate requirement (otherwise this test is vacuous)"
    );

    // `evaluate` standalone with NO prior intent.yaml must reproduce the same
    // candidate requirement: the fix runs the intent-reasoning fallback so the
    // evaluation evaluates the enriched intent, not deterministic-only intent.
    assert.equal(
      fs.existsSync(path.join(evalDir, ".review-surfaces", "intent.yaml")),
      false,
      "precondition: no intent.yaml before the evaluate run"
    );
    const evalRun = runSparseStage(evalDir, "evaluate");
    assert.equal(evalRun.status, 0, evalRun.stderr);
    const standaloneEval = fs.readFileSync(path.join(evalDir, ".review-surfaces", "evaluation.yaml"), "utf8");
    assert.match(
      standaloneEval,
      /REQ-LLM-/,
      "evaluate (no prior intent.yaml) must include the candidate requirement via the enriched-intent fallback"
    );
  } finally {
    fs.rmSync(evalDir, { recursive: true, force: true });
    fs.rmSync(stagedDir, { recursive: true, force: true });
  }
});

// review-surfaces.SCHEMA.3 / CLI.4a: a standalone `packet --dogfood` with NO
// pre-existing dogfood.yaml must BUILD the dogfood + agent_handoff sections, not
// leave them undefined. The packet schema REQUIRES both when run_mode=dogfood,
// so an unbuilt dogfood section would emit an invalid review_packet.json.
test("review-surfaces.SCHEMA.3 packet --dogfood with no prior dogfood.yaml emits a schema-valid packet", () => {
  const tmp = setupComposeFixture("review-surfaces-packet-dogfood-");
  try {
    // No prior dogfood.yaml exists; `packet --dogfood` must build it. (packet
    // also computes any other missing stage deps, so this is fully standalone.)
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "dogfood.yaml")),
      false,
      "precondition: no dogfood.yaml before the packet run"
    );
    runStage(tmp, "packet", ["--dogfood"]);

    const packetPath = path.join(tmp, ".review-surfaces", "review_packet.json");
    const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));

    // run_mode is stamped dogfood; the schema then requires both sections.
    assert.equal(packet.manifest.run_mode, "dogfood");
    assert.ok(packet.dogfood, "packet --dogfood must include the dogfood section");
    assert.ok(packet.agent_handoff, "packet --dogfood must include the agent_handoff section");

    const result = validateJsonSchema(PACKET_SCHEMA, packet);
    assert.equal(result.valid, true, JSON.stringify(result.issues));

    // The handoff surfaces are written alongside the JSON packet.
    assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "dogfood.yaml")), "dogfood.yaml is written");
    assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "agent_handoff.md")), "agent_handoff.md is written");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// review-surfaces.QUALITY.7 / CLI.4: --strict turns a missing requirement into
// the qualityGateFailed (10) exit code; the identical run without --strict keeps
// the default "fail gently" behavior and exits 0.
function setupMissingRequirementFixture(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-strict-gate-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  ZZZ:
    requirements:
      1: This requirement has no implementation or tests anywhere.
`
  );
  fs.writeFileSync(path.join(tmp, "README.md"), "# example\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"],
    { cwd: tmp, stdio: "ignore" }
  );
  return tmp;
}

function runAllForGate(cwd: string, extra: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(
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
      "mock",
      "--out",
      ".review-surfaces",
      ...extra
    ],
    { cwd, encoding: "utf8" }
  );
  return { status: result.status, stderr: result.stderr };
}

test("review-surfaces.QUALITY.7 --strict run with a missing requirement exits 10", () => {
  const tmp = setupMissingRequirementFixture();
  try {
    const strict = runAllForGate(tmp, ["--strict"]);
    assert.equal(strict.status, 10, strict.stderr);
    assert.match(strict.stderr, /Strict gate tripped \(exit 10\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.QUALITY.7 same run without --strict fails gently and exits 0", () => {
  const tmp = setupMissingRequirementFixture();
  try {
    const lenient = runAllForGate(tmp, []);
    assert.equal(lenient.status, 0, lenient.stderr);
    assert.match(lenient.stderr, /Gate warning \(would exit 10 under --strict\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.QUALITY.7 --strict --max-missing tolerates the missing requirement and exits 0", () => {
  const tmp = setupMissingRequirementFixture();
  try {
    const tolerated = runAllForGate(tmp, ["--strict", "--max-missing", "1"]);
    assert.equal(tolerated.status, 0, tolerated.stderr);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.CLI.1 supports top-level --help output", () => {
  const cli = path.join(process.cwd(), "dist", "src", "cli", "index.js");
  const result = spawnSync("node", [cli, "--help"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /review-surfaces 0\.1\.0/);
  assert.match(result.stdout, /run\s+Execute a local command/);
});

test("review-surfaces.CLI.4 rejects unknown top-level flags", () => {
  const cli = path.join(process.cwd(), "dist", "src", "cli", "index.js");
  const result = spawnSync("node", [cli, "--bogus"], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command: --bogus/);
});

test("review-surfaces.CLI.7 bin run records bootstrap build failures without dist", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-bin-bootstrap-"));
  fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "bin", "review-surfaces.js"), path.join(tmp, "bin", "review-surfaces.js"));
  assert.equal(fs.existsSync(path.join(tmp, "dist", "src", "cli", "index.js")), false);

  const result = spawnSync(
    "node",
    [
      path.join(tmp, "bin", "review-surfaces.js"),
      "run",
      "--id",
      "CMD-BOOTSTRAP-BUILD",
      "--",
      "node",
      "-e",
      "process.stderr.write('bootstrap build failed'); process.exit(7)"
    ],
    { cwd: tmp, encoding: "utf8" }
  );

  assert.equal(result.status, 7);
  assert.match(result.stderr, /bootstrap build failed/);
  assert.match(result.stderr, /Recorded command transcript/);

  const transcriptPath = path.join(tmp, ".review-surfaces", "commands", "CMD-BOOTSTRAP-BUILD.json");
  const transcriptFile = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
  const transcript = transcriptFile.commands[0];
  assert.equal(transcriptFile.schema_version, "review-surfaces.command_transcripts.v1");
  assert.equal(transcript.id, "CMD-BOOTSTRAP-BUILD");
  assert.equal(transcript.status, "failed");
  assert.equal(transcript.exit_code, 7);
  assert.match(transcript.command, /node -e/);
  assert.match(transcript.stderr_excerpt, /bootstrap build failed/);
});
