import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");

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
// FINDING A: in a sparse/foreign repo, the agent-file intent-reasoning stage may
// append LLM candidate_requirements. Because intent synthesis now runs BEFORE
// evaluateIntent, EVERY intent requirement -- including the LLM candidate -- must
// have a matching evaluation.results entry (the one-result-per-requirement
// contract) in both `all` and `packet`.
// ---------------------------------------------------------------------------

function setupSparseRepoWithCandidate(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  // No features/ Acai spec -> isSparseSpec true, so the agent-file candidate
  // requirement is accepted.
  fs.writeFileSync(path.join(tmp, "src", "worker.ts"), "export const worker = () => 'runs';\n");
  fs.writeFileSync(path.join(tmp, "README.md"), "# sparse\n");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
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
  initGitRepo(tmp);
  return tmp;
}

function assertEveryRequirementHasResult(packet: Record<string, unknown>): void {
  const intent = packet.intent as { requirements: Array<{ id: string }> };
  const evaluation = packet.evaluation as { results: Array<{ requirement_id: string }> };
  const resultIds = new Set(evaluation.results.map((result) => result.requirement_id));
  for (const requirement of intent.requirements) {
    assert.ok(
      resultIds.has(requirement.id),
      `intent requirement ${requirement.id} must have a matching evaluation.results entry`
    );
  }
  // And the LLM candidate requirement is actually present (otherwise the test is vacuous).
  assert.ok(
    intent.requirements.some((requirement) => requirement.id.startsWith("REQ-LLM-")),
    "the LLM candidate requirement must be present so the contract is meaningfully exercised"
  );
}

test("FINDING A: `all` (agent-file, sparse repo) gives every LLM candidate_requirement a matching evaluation.results entry", () => {
  const tmp = setupSparseRepoWithCandidate("review-surfaces-findingA-all-");
  try {
    const run = runCli(tmp, ["all", "--base", "HEAD", "--head", "HEAD", "--provider", "agent-file", "--agent-input", "agent-input.json"]);
    assert.equal(run.status, 0, run.stderr);
    assertEveryRequirementHasResult(readJson(tmp, "review_packet.json"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING A: `packet` (agent-file, sparse repo) gives every LLM candidate_requirement a matching evaluation.results entry", () => {
  const tmp = setupSparseRepoWithCandidate("review-surfaces-findingA-packet-");
  try {
    // Standalone packet computes all stage deps in-memory (no prior artifacts).
    const run = runCli(tmp, ["packet", "--base", "HEAD", "--head", "HEAD", "--provider", "agent-file", "--agent-input", "agent-input.json"]);
    assert.equal(run.status, 0, run.stderr);
    assertEveryRequirementHasResult(readJson(tmp, "review_packet.json"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING B: the standalone `risks` stage must run the same packet-level
// enrichment `all`/`packet` run, so `risks --provider agent-file` surfaces the
// agent risk_summaries as AI-RISK items (kept hypothesis-quarantined).
// ---------------------------------------------------------------------------

test("FINDING B: `risks --provider agent-file` surfaces agent risk_summaries as AI-RISK items", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-findingB-"));
  try {
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "thing.ts"), "export const thing = 1;\n");
    fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
    fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
    // The agent-file enrichment carries risk_summaries (the packet-level
    // enrichPacket path), which the standalone risks stage previously dropped.
    fs.writeFileSync(
      path.join(tmp, "agent-input.json"),
      JSON.stringify(
        {
          risk_summaries: ["A possible unhandled error path in src/thing.ts."],
          review_focus: ["Look closely at the thing module."]
        },
        null,
        2
      )
    );
    initGitRepo(tmp);

    const run = runCli(tmp, ["risks", "--base", "HEAD", "--head", "HEAD", "--provider", "agent-file", "--agent-input", "agent-input.json"]);
    assert.equal(run.status, 0, run.stderr);

    const risks = readArtifact(tmp, "risks.yaml");
    assert.match(risks, /AI-RISK-001/, "the agent risk_summary must be appended as an AI-RISK item");
    assert.match(risks, /A possible unhandled error path/, "the agent risk_summary text must be surfaced");
    // It stays hypothesis-quarantined: marked llm_proposed and severity unknown.
    assert.match(risks, /AI\/agent hypothesis:/, "the AI-RISK is labeled a hypothesis");
    assert.match(risks, /llm_proposed: true/, "the AI-RISK evidence is marked llm_proposed (quarantined)");
    // The review_focus addition also lands (packet-level enrichment parity).
    assert.match(risks, /Look closely at the thing module\./, "agent review_focus additions are surfaced");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING B (regression): the FINDING B enrichment-parity fix added an
// architecture computation inside the `risks` stage to build the packet passed
// to enrichPacket. buildArchitecture writes diagrams/*.mmd as a disk side effect,
// so a standalone `risks` run started leaking a diagrams/ directory it does NOT
// own -- violating per-stage isolation ("Each subcommand writes ONLY its own
// artifact(s)"). enrichPacket never reads packet.architecture, so the model is
// now built WITHOUT the disk side effect. Re-assert isolation: standalone `risks`
// (and `handoff`, same gratuitous pattern) write ONLY their own artifact(s) plus
// inputs/manifest (+ prompts/ under the enrichment path), and NEVER diagrams/.
// ---------------------------------------------------------------------------

function setupRisksIsolationRepo(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "thing.ts"), "export const thing = 1;\n");
  fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
  fs.writeFileSync(
    path.join(tmp, "agent-input.json"),
    JSON.stringify({ risk_summaries: ["A possible unhandled error path."] }, null, 2)
  );
  initGitRepo(tmp);
  return tmp;
}

function assertNoDiagramsLeak(cwd: string): void {
  assert.equal(
    fs.existsSync(path.join(cwd, ".review-surfaces", "diagrams")),
    false,
    "the stage must NOT leak a diagrams/ directory it does not own"
  );
}

test("FINDING B (regression): standalone `risks --provider mock` writes risks.yaml but NOT diagrams/", () => {
  const tmp = setupRisksIsolationRepo("review-surfaces-findingB-iso-mock-");
  try {
    const run = runCli(tmp, ["risks", "--base", "HEAD", "--head", "HEAD", "--provider", "mock"]);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "risks.yaml")), "risks.yaml must exist");
    assertNoDiagramsLeak(tmp);
    // The risks stage must not write any other stage's owned artifact either.
    for (const leaked of ["evaluation.yaml", "methodology.yaml", "intent.yaml", "architecture.md", "review_packet.json"]) {
      assert.equal(
        fs.existsSync(path.join(tmp, ".review-surfaces", leaked)),
        false,
        `risks must not leak ${leaked}`
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING B (regression): standalone `risks --provider agent-file` surfaces AI-RISK items but does NOT leak diagrams/", () => {
  const tmp = setupRisksIsolationRepo("review-surfaces-findingB-iso-agent-");
  try {
    const run = runCli(tmp, ["risks", "--base", "HEAD", "--head", "HEAD", "--provider", "agent-file", "--agent-input", "agent-input.json"]);
    assert.equal(run.status, 0, run.stderr);
    // FINDING B enrichment parity is still intact: the agent risk_summary lands.
    assert.match(readArtifact(tmp, "risks.yaml"), /AI-RISK-001/, "the FINDING B enrichment must still surface AI-RISK items");
    // ...but the architecture model is now built without the disk side effect.
    assertNoDiagramsLeak(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING B (regression): standalone `handoff` writes agent_handoff.md but NOT diagrams/", () => {
  const tmp = setupRisksIsolationRepo("review-surfaces-findingB-iso-handoff-");
  try {
    const run = runCli(tmp, ["handoff", "--base", "HEAD", "--head", "HEAD", "--provider", "mock", "--dogfood"]);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "agent_handoff.md")), "agent_handoff.md must exist");
    assertNoDiagramsLeak(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING C: the composable diagrams/handoff load-or-compute fallback (when no
// evaluation.yaml exists yet AND --test-output is supplied) must apply the
// verification loop so it builds from POST-promotion statuses, matching `all`.
// ---------------------------------------------------------------------------

// A repo with one EVAL requirement, a genuine (non-test) implementation file,
// and an EXACT-ACID passing JUnit case -> the verification loop promotes the
// requirement partial -> satisfied. Without that promotion in the fallback,
// diagrams/handoff would build from the pre-promotion (partial) status.
function setupVerifiablePromotionRepo(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: Evaluate implementation.
`
  );
  // Genuine non-test implementation in the EVAL area (no exact ACID mention).
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.ts"), "export const evaluate = true;\n");
  // An EXACT-ACID passing test so the verification loop promotes.
  fs.writeFileSync(
    path.join(tmp, "junit.xml"),
    `<?xml version="1.0"?>
<testsuite name="eval">
  <testcase name="example.EVAL.1 evaluator behaves correctly" classname="suite.EVAL" time="0.01"/>
</testsuite>
`
  );
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
  initGitRepo(tmp);
  return tmp;
}

const VERIFY_AREAS_CONFIG = `output_dir: .review-surfaces
specs:
  - features/**/*.feature.yaml
areas:
  - id: SUB-EVAL
    name: Evaluation
    group_key: EVAL
    prefixes:
      - src/evaluation/
    purpose: Evaluate requirements.
    pattern: evaluation
    test_keywords:
      - evaluation
`;

function writeVerifyConfig(cwd: string): void {
  fs.writeFileSync(path.join(cwd, "review-surfaces.config.yaml"), VERIFY_AREAS_CONFIG);
}

test("FINDING C: handoff fallback (no prior evaluation.yaml) reflects the verified partial -> satisfied promotion", () => {
  const tmp = setupVerifiablePromotionRepo("review-surfaces-findingC-handoff-");
  try {
    writeVerifyConfig(tmp);
    // No prior evaluation.yaml: the handoff stage computes evaluation via the
    // fallback. With --test-output the fallback must apply verification.
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "evaluation.yaml")),
      false,
      "precondition: no evaluation.yaml before the handoff run"
    );
    const run = runCli(tmp, [
      "handoff",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--spec",
      "features/example.feature.yaml",
      "--provider",
      "mock",
      "--dogfood",
      "--test-output",
      "junit.xml"
    ]);
    assert.equal(run.status, 0, run.stderr);

    const handoff = readArtifact(tmp, "agent_handoff.md");
    // A satisfied requirement is no longer a missing/partial relevant ACID, and
    // the verified test surfaces as validation evidence (also exercises FINDING F).
    assert.match(handoff, /example\.EVAL\.1 evaluator behaves correctly/, "the verified parsed test is listed as validation evidence");
    // The promotion means the requirement is NOT listed as an open partial gap.
    assert.doesNotMatch(
      handoff,
      /partial coverage for example\.EVAL\.1/,
      "a verified-and-promoted requirement must not be reported as a partial gap"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING C: diagrams fallback (no prior evaluation.yaml) builds architecture from POST-promotion statuses", () => {
  const fallbackDir = setupVerifiablePromotionRepo("review-surfaces-findingC-diag-fallback-");
  const stagedDir = setupVerifiablePromotionRepo("review-surfaces-findingC-diag-staged-");
  try {
    writeVerifyConfig(fallbackDir);
    writeVerifyConfig(stagedDir);

    // Reference path: run `evaluate` first (which applies verification) then
    // `diagrams`, so diagrams reads the POST-promotion evaluation.yaml.
    const args = ["--base", "HEAD", "--head", "HEAD", "--spec", "features/example.feature.yaml", "--provider", "mock", "--test-output", "junit.xml"];
    assert.equal(runCli(stagedDir, ["evaluate", ...args]).status, 0);
    assert.ok(
      fs.existsSync(path.join(stagedDir, ".review-surfaces", "evaluation.yaml")),
      "staged evaluation.yaml exists after the evaluate stage"
    );
    assert.equal(runCli(stagedDir, ["diagrams", ...args]).status, 0);
    const stagedArchitecture = readArtifact(stagedDir, "architecture.md");

    // Fallback path: run `diagrams` standalone with NO prior evaluation.yaml. The
    // fallback must apply verification so the architecture matches the staged run.
    assert.equal(
      fs.existsSync(path.join(fallbackDir, ".review-surfaces", "evaluation.yaml")),
      false,
      "precondition: no evaluation.yaml before the standalone diagrams run"
    );
    assert.equal(runCli(fallbackDir, ["diagrams", ...args]).status, 0);
    const fallbackArchitecture = readArtifact(fallbackDir, "architecture.md");

    assert.equal(
      fallbackArchitecture,
      stagedArchitecture,
      "the diagrams fallback must build the SAME architecture as evaluate-then-diagrams (POST-promotion)"
    );
  } finally {
    fs.rmSync(fallbackDir, { recursive: true, force: true });
    fs.rmSync(stagedDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING E: a --cache signature hit must validate review_packet.json against the
// schema. A truncated/non-packet but parseable JSON with a MATCHING signature
// must trigger regeneration (treated as a cache miss), not reuse.
// ---------------------------------------------------------------------------

test("FINDING E: a corrupt (non-packet) cached review_packet.json with a matching signature triggers regeneration", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-findingE-"));
  try {
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "thing.ts"), "export const thing = 1;\n");
    fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
    fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
    // The CLI resolves schemas relative to cwd; make the review_packet schema
    // available inside the fixture so the cache validity check can run.
    fs.mkdirSync(path.join(tmp, "schemas"), { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), "schemas", "review_packet.schema.json"),
      path.join(tmp, "schemas", "review_packet.schema.json")
    );
    initGitRepo(tmp);

    const baseArgs = ["all", "--base", "HEAD", "--head", "HEAD", "--provider", "mock", "--cache"];

    // First run populates the cache (manifest + valid packet).
    assert.equal(runCli(tmp, baseArgs).status, 0);
    const manifest = readJson(tmp, "manifest.json");
    assert.equal(typeof manifest.signature, "string", "the manifest records a signature");

    // CORRUPT the packet to parseable-but-non-packet JSON while KEEPING the
    // manifest (and thus the signature) intact, so the inputs still match.
    const packetPath = path.join(tmp, ".review-surfaces", "review_packet.json");
    fs.writeFileSync(packetPath, "{}");

    // A second --cache run with unchanged inputs would, with the old parseable-only
    // check, REUSE the corrupt packet. The schema-validity check must instead treat
    // it as a cache miss and regenerate a valid packet.
    const second = runCli(tmp, baseArgs);
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(
      second.stdout + second.stderr,
      /reusing existing packet/,
      "a schema-invalid cached packet must NOT be reused"
    );

    // The regenerated packet is a real, schema-valid review packet again.
    const regenerated = readJson(tmp, "review_packet.json");
    assert.equal(regenerated.schema_version, "review-surfaces.packet.v1", "the packet was regenerated, not left as {}");
    assert.ok(regenerated.intent && regenerated.evaluation, "the regenerated packet has the required sections");

    // Sanity: a clean (uncorrupted) cache hit DOES reuse.
    const third = runCli(tmp, baseArgs);
    assert.match(third.stdout + third.stderr, /reusing existing packet/, "an unchanged valid packet is reused");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING F: a --test-output run (parsed JUnit passes, no command transcript)
// must list parsed-test validation evidence in agent_handoff.md, not claim "none
// recorded".
// ---------------------------------------------------------------------------

test("FINDING F: a --test-output run lists parsed-test validation evidence in the handoff", () => {
  const tmp = setupVerifiablePromotionRepo("review-surfaces-findingF-");
  try {
    writeVerifyConfig(tmp);
    // `all --dogfood` writes agent_handoff.md and runs the verification loop.
    const run = runCli(tmp, [
      "all",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--spec",
      "features/example.feature.yaml",
      "--provider",
      "mock",
      "--dogfood",
      "--test-output",
      "junit.xml"
    ]);
    assert.equal(run.status, 0, run.stderr);

    const packet = readJson(tmp, "review_packet.json") as { agent_handoff?: { validation_evidence?: string[] } };
    const evidence = packet.agent_handoff?.validation_evidence ?? [];
    assert.ok(evidence.length > 0, "the handoff must record parsed-test validation evidence (no command transcript was supplied)");
    assert.ok(
      evidence.some((line) => line.includes("Parsed test passed") || line.includes("example.EVAL.1 evaluator behaves correctly")),
      `validation_evidence must reference the parsed passing test, got ${JSON.stringify(evidence)}`
    );

    // The rendered markdown does NOT claim none were recorded.
    const handoff = readArtifact(tmp, "agent_handoff.md");
    const validationSection = handoff.split("## Validation Evidence")[1]?.split("##")[0] ?? "";
    assert.doesNotMatch(validationSection, /- None recorded\./, "the Validation Evidence section must not be empty");
    assert.match(validationSection, /Parsed test passed|example\.EVAL\.1 evaluator behaves correctly/, "parsed-test validation evidence is rendered");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING D (--strict): an UNRELATED in-pool agent citation must NOT drop a
// requirement out of "missing", so it cannot bypass the --strict quality gate
// (which counts missing requirements). A genuinely-tied citation (exact ACID)
// still upgrades missing -> partial.
// ---------------------------------------------------------------------------

function setupStrictGateRepo(prefix: string, agentInput: Record<string, unknown>): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
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
  fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
  fs.writeFileSync(path.join(tmp, "agent-input.json"), JSON.stringify(agentInput, null, 2));
  initGitRepo(tmp);
  // An UNRELATED file written AFTER the commit so it is a working-tree change (in
  // the candidate pool) under --base HEAD --head HEAD. It does not map to the ZZZ
  // group and does not mention the ACID.
  fs.writeFileSync(path.join(tmp, "src", "unrelated.ts"), "export const unrelated = 1;\n");
  return tmp;
}

test("FINDING D (--strict): an UNRELATED in-pool agent citation keeps the requirement missing and does NOT bypass the strict gate", () => {
  // The agent proposes candidate_evidence citing an unrelated, in-pool changed
  // file for the otherwise-missing ZZZ.1 requirement. Under FINDING D this must
  // NOT upgrade missing -> partial, so the missing count stays 1 and --strict
  // still trips the quality gate (exit 10).
  const tmp = setupStrictGateRepo("review-surfaces-findingD-strict-", {
    // The agent-file provider returns this same parsed object to every reasoning
    // stage. The candidate-evidence stage reads the batched `requirements` shape;
    // here it cites an unrelated, in-pool changed file for the missing ZZZ.1.
    requirements: [
      {
        acai_id: "example.ZZZ.1",
        candidate_evidence: [{ kind: "file", path: "src/unrelated.ts", note: "I think this helps" }],
        rationale: "Speculative association."
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
        "--strict"
      ],
      { cwd: tmp, encoding: "utf8" }
    );
    assert.equal(run.status, 10, `unrelated citation must not bypass the strict gate: ${run.stderr}`);
    assert.match(run.stderr, /Strict gate tripped \(exit 10\)/);

    const packet = readJson(tmp, "review_packet.json") as {
      evaluation: { results: Array<{ acai_id?: string; status: string; evidence?: Array<{ llm_proposed?: boolean; validation_status?: string; path?: string }> }> };
    };
    const zzz = packet.evaluation.results.find((result) => result.acai_id === "example.ZZZ.1");
    assert.equal(zzz?.status, "missing", "an unrelated in-pool citation must NOT upgrade the requirement out of missing");
    // Non-vacuous: the candidate-evidence stage DID run and validated the in-pool
    // ref; it is attached as a hypothesis (just not as a status-changing tie).
    assert.ok(
      (zzz?.evidence ?? []).some((ref) => ref.llm_proposed === true && ref.path === "src/unrelated.ts"),
      "the unrelated in-pool hypothesis is still attached (proving the gate-bypass guard, not a no-op, kept it missing)"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING D (--strict): a DETERMINISTICALLY-TIED agent citation (exact ACID) DOES upgrade missing -> partial (gate not over-tightened)", () => {
  // Positive control: the agent cites the SAME unrelated path but references the
  // requirement's exact ACID in the note. That is a deterministic tie, so the
  // requirement is upgraded missing -> partial (no longer counted as missing).
  const tmp = setupStrictGateRepo("review-surfaces-findingD-tied-", {
    requirements: [
      {
        acai_id: "example.ZZZ.1",
        candidate_evidence: [{ kind: "file", path: "src/unrelated.ts", note: "implements example.ZZZ.1" }],
        rationale: "Tied to the exact requirement."
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
        ".review-surfaces"
      ],
      { cwd: tmp, encoding: "utf8" }
    );
    assert.equal(run.status, 0, run.stderr);

    const packet = readJson(tmp, "review_packet.json") as {
      evaluation: { results: Array<{ acai_id?: string; status: string }> };
    };
    const zzz = packet.evaluation.results.find((result) => result.acai_id === "example.ZZZ.1");
    assert.equal(zzz?.status, "partial", "an exact-ACID-tied citation legitimately upgrades missing -> partial");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
