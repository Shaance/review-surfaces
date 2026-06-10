import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { validateJsonSchema } from "../src/schema/json-schema";
import { ExitCodes } from "../src/core/exit-codes";

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
  assert.match(result.stdout, /Local-first human review decision cockpit/);
  assert.doesNotMatch(result.stdout, /Local-first review packet compiler/);
  assert.match(result.stdout, /run\s+Execute a local command/);
  assert.match(result.stdout, /intent-mismatch\s+Render intent_mismatch\.md from human_review\.json/);
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

// review-surfaces R7 / R6 CLI surfaces (Lane E behavior already landed; these
// additions pin it). (a) validate on an ABSENT packet is a USAGE error (exit 2),
// not a schema-validation failure (exit 3). (b) a present packet whose
// schema_version mismatches the contract prints a regenerate message and returns
// 3. (c) a --verbose run prints debug lines to stderr while a non-verbose run is
// byte-silent on stderr (artifacts unaffected). Assertions are exit-code /
// sentinel based, not exact wording.

test("review-surfaces.CLI validate on a MISSING review_packet.json returns the usage-error exit code", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-validate-missing-"));
  try {
    fs.mkdirSync(path.join(tmp, "schemas"), { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), "schemas", "review_packet.schema.json"),
      path.join(tmp, "schemas", "review_packet.schema.json")
    );
    const run = spawnSync("node", [CLI, "validate"], { cwd: tmp, encoding: "utf8" });
    assert.equal(run.status, ExitCodes.usageError, `an absent packet must be a usage error (2): ${run.stderr}`);
    assert.notEqual(run.status, ExitCodes.schemaValidationFailed, "an absent packet must NOT be reported as a schema-validation failure");
    assert.match(run.stderr, /No review packet JSON found|review-surfaces all/, `expected a usage diagnostic, got:\n${run.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.CLI validate on a wrong schema_version prints a regenerate message and returns the schema-validation exit code", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-validate-badver-"));
  try {
    fs.mkdirSync(path.join(tmp, "schemas"), { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), "schemas", "review_packet.schema.json"),
      path.join(tmp, "schemas", "review_packet.schema.json")
    );
    fs.mkdirSync(path.join(tmp, ".review-surfaces"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".review-surfaces", "review_packet.json"),
      JSON.stringify({ schema_version: "review-surfaces.packet.vX" })
    );
    const run = spawnSync("node", [CLI, "validate"], { cwd: tmp, encoding: "utf8" });
    assert.equal(run.status, ExitCodes.schemaValidationFailed, `a wrong schema_version must return 3: ${run.stderr}`);
    assert.match(run.stderr, /regenerate/, `expected a regenerate message, got:\n${run.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.CLI validate honors a custom --schema and skips the bundled schema_version pre-check", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-validate-customschema-"));
  try {
    // A packet whose schema_version differs from the bundled contract constant,
    // validated against a CALLER-SUPPLIED schema that accepts it. The bundled
    // schema_version pre-check must NOT pre-reject when --schema is overridden —
    // the supplied schema's own ajv validation is the authority.
    const packetPath = path.join(tmp, "packet.json");
    fs.writeFileSync(packetPath, JSON.stringify({ schema_version: "review-surfaces.packet.vNEXT" }));
    const schemaPath = path.join(tmp, "custom-schema.json");
    fs.writeFileSync(
      schemaPath,
      JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" })
    );
    const run = spawnSync("node", [CLI, "validate", packetPath, "--schema", schemaPath], { cwd: tmp, encoding: "utf8" });
    assert.equal(run.status, ExitCodes.success, `a custom --schema that accepts the packet must validate (0): ${run.stderr}`);
    assert.doesNotMatch(run.stderr, /regenerate/, "the bundled version pre-check must be skipped under --schema");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.CLI --verbose prints debug lines to stderr while a non-verbose run does not", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-verbose-"));
  try {
    fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
    fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });

    const baseArgs = ["all", "--base", "HEAD", "--head", "HEAD", "--provider", "mock", "--out", ".review-surfaces"];

    const plain = spawnSync("node", [CLI, ...baseArgs], { cwd: tmp, encoding: "utf8" });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stderr, "", "a healthy non-verbose run is byte-silent on stderr");

    const verbose = spawnSync("node", [CLI, ...baseArgs, "--verbose"], { cwd: tmp, encoding: "utf8" });
    assert.equal(verbose.status, 0, verbose.stderr);
    assert.match(verbose.stderr, /\[review-surfaces\]/, "verbose prints the debug-prefixed diagnostics to stderr");

    // Artifacts are unaffected by the verbose flag (debug is stderr-only).
    const plainPacket = fs.readFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), "utf8");
    assert.ok(plainPacket.length > 0, "the verbose run still wrote the packet");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// review-surfaces.CLI.8 + review-surfaces.SCHEMA.3: validate --surface covers the
// human and PR sidecars, and the strict human schema rejects stale partial
// artifacts instead of degrading quietly.
test("review-surfaces.CLI.8 validate --surface covers packet, human, and all surfaces", () => {
  const tmp = setupComposeFixture("review-surfaces-validate-surface-");
  try {
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });
    runStage(tmp, "all");

    const out = ".review-surfaces";
    const human = (args: string[]) => spawnSync("node", [CLI, ...args, "--out", out], { cwd: tmp, encoding: "utf8" });

    assert.equal(human(["validate", "--surface", "packet"]).status, ExitCodes.success);
    assert.equal(human(["validate", "--surface", "human"]).status, ExitCodes.success);
    // PR sidecar is absent in repo mode: explicit --surface pr is a usage error,
    // but --surface all skips the absent sidecar and still passes.
    assert.equal(human(["validate", "--surface", "pr"]).status, ExitCodes.usageError);
    assert.equal(human(["validate", "--surface", "all"]).status, ExitCodes.success);
    // An unknown surface is a usage error.
    assert.equal(human(["validate", "--surface", "bogus"]).status, ExitCodes.usageError);

    // review-surfaces.CLI.8: `--surface all` with the packet JSON as a positional
    // resolves the human/PR sidecars from the packet's directory rather than
    // re-validating review_packet.json against the sidecar schemas.
    const jsonPositional = human(["validate", path.join(out, "review_packet.json"), "--surface", "all"]);
    assert.equal(jsonPositional.status, ExitCodes.success, jsonPositional.stderr);

    // review-surfaces.CLI.8: validate defaults honor --out, so a custom-output run
    // validates the artifacts it actually wrote (not the default .review-surfaces).
    runStage(tmp, "all", ["--out", "tmp-review"]);
    const custom = (args: string[]) => spawnSync("node", [CLI, ...args, "--out", "tmp-review"], { cwd: tmp, encoding: "utf8" });
    assert.equal(custom(["validate", "--surface", "human"]).status, ExitCodes.success, "validate --surface human must honor --out");
    assert.equal(custom(["validate", "--surface", "all"]).status, ExitCodes.success, "validate --surface all must honor --out");

    // review-surfaces.SCHEMA.3: a stale partial human_review.json (missing a now
    // required field) fails validation rather than degrading quietly.
    const humanPath = path.join(tmp, out, "human_review.json");
    const model = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    delete model.review_routes;
    fs.writeFileSync(humanPath, JSON.stringify(model, null, 2));
    const stale = human(["validate", "--surface", "human"]);
    assert.equal(stale.status, ExitCodes.schemaValidationFailed, stale.stderr);
    assert.match(stale.stderr, /review_routes/);
    // --surface all also surfaces the human failure.
    assert.equal(human(["validate", "--surface", "all"]).status, ExitCodes.schemaValidationFailed);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// review-surfaces.SCHEMA.3 (unit): the human schema requires every field the
// current HumanReviewModel emits, so each is independently load-bearing.
test("review-surfaces.SCHEMA.3 human schema requires all current model fields", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));
  for (const field of [
    "risk_lens_findings",
    "intent_mismatch",
    "review_routes",
    "since_last_review",
    "evidence_cards",
    "feedback_effects"
  ]) {
    assert.ok(schema.required.includes(field), `human schema must require ${field}`);
  }
});

// review-surfaces.NARRATIVE.1/.2: in repo scope the human narrative anchors
// against the collected diff, so an agent-file claim citing a real changed file
// is verified while a fabricated path is demoted (not dropped). Guards the
// repo-scope diff wiring (the diff is only parsed eagerly for PR scope).
test("review-surfaces.NARRATIVE.1 human narrative anchors against the repo-scope diff", () => {
  const tmp = setupComposeFixture("review-surfaces-narrative-");
  try {
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });
    fs.appendFileSync(path.join(tmp, "README.md"), "\nnarrative diff marker\n");
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "change"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(
      path.join(tmp, "narr.json"),
      JSON.stringify({
        claims: [
          { text: "Updates the project readme.", paths: ["README.md"] },
          { text: "Edits a file that does not exist.", paths: ["src/nope-fabricated.ts"] }
        ]
      })
    );
    const run = spawnSync(
      "node",
      [CLI, "all", "--base", "HEAD~1", "--head", "HEAD", "--spec", "features/review-surfaces.feature.yaml", "--provider", "agent-file", "--agent-input", "narr.json", "--out", ".review-surfaces"],
      { cwd: tmp, encoding: "utf8" }
    );
    assert.equal(run.status, 0, run.stderr);
    const md = fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.md"), "utf8");
    const section = md.split("## Change narrative")[1].split("## Review first")[0];
    assert.match(section, /✓ Updates the project readme\./, "a claim citing a real changed file is verified");
    assert.match(section, /~ Edits a file that does not exist\./, "a fabricated-path claim is demoted, not dropped");
    assert.match(section, /unverified anchor\(s\): `src\/nope-fabricated\.ts`/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// review-surfaces.NARRATIVE.1: an `all --cache` hit reuses the narrative already
// in human_review.json rather than re-invoking the provider, so a cache hit keeps
// the provider-authored narrative (lossless reuse, no fresh provider call).
test("review-surfaces.NARRATIVE.1 cache hit preserves the provider narrative", () => {
  const tmp = setupComposeFixture("review-surfaces-narrative-cache-");
  try {
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });
    fs.appendFileSync(path.join(tmp, "README.md"), "\nnarrative cache marker\n");
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "change"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "narr.json"), JSON.stringify({ claims: [{ text: "Updates the readme.", paths: ["README.md"] }] }));
    const args = ["all", "--cache", "--base", "HEAD~1", "--head", "HEAD", "--spec", "features/review-surfaces.feature.yaml", "--provider", "agent-file", "--agent-input", "narr.json", "--now", "2026-01-01T00:00:00Z", "--out", ".review-surfaces"];
    const first = spawnSync("node", [CLI, ...args], { cwd: tmp, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const firstModel = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    assert.equal(firstModel.narrative.source, "provider");
    // Second run is a cache hit; the provider narrative must survive (not be
    // overwritten by the deterministic fallback).
    const second = spawnSync("node", [CLI, ...args], { cwd: tmp, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout + second.stderr, /inputs unchanged/, "second run is a cache hit");
    const secondModel = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    assert.equal(secondModel.narrative.source, "provider", "cache hit preserves the provider narrative");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// review-surfaces.REVIEW_LOOP.1-4 — the interactive review walkthrough command.
// ---------------------------------------------------------------------------

function setupReviewFixture(prefix: string): string {
  const tmp = setupComposeFixture(prefix);
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });
  // Generate the full review (human_review.json + a ranked queue) to walk through.
  runStage(tmp, "all", ["--dogfood"]);
  return tmp;
}

test("review-surfaces.REVIEW_LOOP.4 review command degrades gracefully in a non-TTY environment", () => {
  const tmp = setupReviewFixture("rs-review-nontty-");
  try {
    // Piped (non-TTY) stdin, no --interactive: print the next item, exit cleanly.
    const result = spawnSync("node", [CLI, "review", "--out", ".review-surfaces"], { cwd: tmp, input: "", encoding: "utf8" });
    assert.equal(result.status, ExitCodes.success, result.stderr);
    assert.match(result.stdout, /Non-interactive environment/);
    assert.match(result.stdout, /\(1\//, "prints the next ranked queue item");
    // No feedback is written by a non-interactive run.
    const feedbackDir = path.join(tmp, ".review-surfaces", "feedback");
    const walkthroughFiles = fs.existsSync(feedbackDir) ? fs.readdirSync(feedbackDir).filter((name) => name.startsWith("walkthrough-")) : [];
    assert.equal(walkthroughFiles.length, 0, "a non-interactive run writes no feedback");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.REVIEW_LOOP.3 review command captures a comment draft into suggested_comments.md", () => {
  const tmp = setupReviewFixture("rs-review-comment-");
  try {
    // Drive the first item: comment, body, ready=yes. Remaining items end on EOF.
    const result = spawnSync(
      "node",
      [CLI, "review", "--interactive", "--out", ".review-surfaces"],
      { cwd: tmp, input: "c\nNeeds a regression test before merge\ny\n", encoding: "utf8" }
    );
    assert.equal(result.status, ExitCodes.success, result.stderr);
    const suggested = fs.readFileSync(path.join(tmp, ".review-surfaces", "suggested_comments.md"), "utf8");
    assert.match(suggested, /Needs a regression test before merge/, "the captured draft lands in suggested_comments.md");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.REVIEW_LOOP.2 review command persists a false-positive into a local feedback file", () => {
  const tmp = setupReviewFixture("rs-review-feedback-");
  try {
    // Mark the first item a false positive; remaining items end on EOF.
    const result = spawnSync(
      "node",
      [CLI, "review", "--interactive", "--out", ".review-surfaces"],
      { cwd: tmp, input: "p\n", encoding: "utf8" }
    );
    assert.equal(result.status, ExitCodes.success, result.stderr);
    const feedbackDir = path.join(tmp, ".review-surfaces", "feedback");
    const walkthroughFiles = fs.readdirSync(feedbackDir).filter((name) => name.startsWith("walkthrough-"));
    assert.equal(walkthroughFiles.length, 1, "a walkthrough feedback file is written");
    const feedback = fs.readFileSync(path.join(feedbackDir, walkthroughFiles[0]), "utf8");
    // This fixture is repo-scoped, so the false positive is recorded as an audit
    // note rather than a wildcard downgrade policy (scoped policies are PR-scope).
    assert.match(feedback, /Reviewer marked a false positive/);

    // A second session on the same head must not overwrite the first.
    const second = spawnSync("node", [CLI, "review", "--interactive", "--out", ".review-surfaces"], { cwd: tmp, input: "p\n", encoding: "utf8" });
    assert.equal(second.status, ExitCodes.success, second.stderr);
    const afterSecond = fs.readdirSync(feedbackDir).filter((name) => name.startsWith("walkthrough-"));
    assert.equal(afterSecond.length, 2, "a second session writes a distinct feedback file, preserving the first");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.REVIEW_LOOP.2 feedback under a custom (absolute) --out dir is ingested on the next run", () => {
  const tmp = setupComposeFixture("rs-review-customout-");
  try {
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });
    // An ABSOLUTE output dir inside the repo: the collector must relativize it
    // before matching repo-relative file paths (round-3 fix).
    const absOut = path.join(tmp, ".rs-out");
    runStage(tmp, "all", ["--dogfood", "--out", absOut]);
    const feedbackDir = path.join(absOut, "feedback");
    fs.mkdirSync(feedbackDir, { recursive: true });
    fs.writeFileSync(
      path.join(feedbackDir, "walkthrough-x.yaml"),
      "schema_version: review-surfaces.feedback.v1\nauthor: tester\nvalidation:\n  passed: []\n  failed: []\n  notes: [marker-note-xyz]\nfalse_positives: []\n"
    );
    // Re-run; the collector must index feedback from the custom dir, not just .review-surfaces.
    runStage(tmp, "all", ["--dogfood", "--out", absOut]);
    const index = JSON.parse(fs.readFileSync(path.join(absOut, "inputs", "feedback.index.json"), "utf8"));
    const files = (index.feedback ?? index.files ?? []).map((entry: { path?: string } | string) => (typeof entry === "string" ? entry : entry.path ?? ""));
    assert.ok(files.some((file: string) => file.includes(".rs-out/feedback/walkthrough-x.yaml")), "feedback under an absolute --out dir is ingested");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.REVIEW_LOOP.1 review --review-scope pr fails fast without a PR surface", () => {
  const tmp = setupReviewFixture("rs-review-prscope-");
  try {
    // The fixture generated a repo-scope review (no pr_review_surface.json). A
    // PR-scope walkthrough must fail fast rather than silently walking the repo queue.
    const result = spawnSync("node", [CLI, "review", "--review-scope", "pr", "--out", ".review-surfaces"], { cwd: tmp, input: "", encoding: "utf8" });
    assert.equal(result.status, ExitCodes.usageError, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /PR-scope review requires a current pr_review_surface\.json/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.REVIEW_LOOP.2 feedback under a repo-root output dir (--out .) is ingested", () => {
  const tmp = setupComposeFixture("rs-review-rootout-");
  try {
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });
    runStage(tmp, "all", ["--dogfood", "--out", "."]);
    const feedbackDir = path.join(tmp, "feedback");
    fs.mkdirSync(feedbackDir, { recursive: true });
    fs.writeFileSync(
      path.join(feedbackDir, "walkthrough-x.yaml"),
      "schema_version: review-surfaces.feedback.v1\nauthor: tester\nvalidation:\n  passed: []\n  failed: []\n  notes: [root-marker]\nfalse_positives: []\n"
    );
    runStage(tmp, "all", ["--dogfood", "--out", "."]);
    const index = JSON.parse(fs.readFileSync(path.join(tmp, "inputs", "feedback.index.json"), "utf8"));
    const files = (index.feedback ?? index.files ?? []).map((entry: { path?: string } | string) => (typeof entry === "string" ? entry : entry.path ?? ""));
    assert.ok(files.some((file: string) => file.includes("feedback/walkthrough-x.yaml")), "feedback under --out . is ingested");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.7 comment --format review exports a pending (no-event) draft review", () => {
  const tmp = setupReviewFixture("rs-draft-review-");
  try {
    const result = spawnSync("node", [CLI, "comment", "--format", "review", "--out", ".review-surfaces"], { cwd: tmp, encoding: "utf8" });
    assert.equal(result.status, ExitCodes.success, result.stderr);
    const payload = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "pending_review.json"), "utf8"));
    assert.equal("event" in payload, false, "the exported review omits event so it is never auto-submitted");
    assert.ok(Array.isArray(payload.comments), "the payload has a comments array");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.7 comment --format review rejects a stale/invalid human_review.json", () => {
  const tmp = setupReviewFixture("rs-draft-review-stale-");
  try {
    // Corrupt the artifact into a schema-invalid shape.
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify({ not: "a valid human review" }));
    const result = spawnSync("node", [CLI, "comment", "--format", "review", "--out", ".review-surfaces"], { cwd: tmp, encoding: "utf8" });
    assert.equal(result.status, ExitCodes.usageError, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /stale or invalid/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.7 comment --format review --review-scope pr fails fast on a repo-scope artifact", () => {
  const tmp = setupReviewFixture("rs-draft-prscope-");
  try {
    // The fixture generated a repo-scope review (no pr_review_surface.json). A
    // PR-scope draft export must fail fast rather than export repo-scope comments.
    const result = spawnSync("node", [CLI, "comment", "--format", "review", "--review-scope", "pr", "--out", ".review-surfaces"], { cwd: tmp, encoding: "utf8" });
    assert.equal(result.status, ExitCodes.usageError, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /PR-scope draft review requires a current pr_review_surface\.json/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
