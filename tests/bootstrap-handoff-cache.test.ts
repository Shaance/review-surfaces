import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createReviewPacket, PacketInputs } from "../src/render/packet";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");
const FROZEN = "2026-01-02T03:04:05.000Z";

// ---------------------------------------------------------------------------
// FINDING A: the agent handoff used to hardcode artifact_paths under
// `.review-surfaces/`. For runs that use --out (or a config output_dir) other
// than .review-surfaces the artifacts are written elsewhere, so the handoff
// pointed reviewers at non-existent paths. The packet/comment paths already
// honor the effective output dir; the handoff must too. The default
// `.review-surfaces` output must stay unchanged.
// ---------------------------------------------------------------------------

function handoffInputs(cwd: string, outputDir: string): PacketInputs {
  return {
    collection: {
      cwd,
      outputDir,
      manifest: { milestone: "M6" },
      changedFiles: []
    },
    intent: {
      summary: "round6 fixture",
      requirements: [],
      constraints: [],
      non_goals: [],
      assumptions: [],
      open_questions: [],
      sources: []
    },
    evaluation: {
      summary: "round6 fixture",
      results: [],
      overreach: [],
      acai_coverage: {}
    },
    architecture: {
      summary: "round6 fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "round6 fixture",
      missing_logs: false,
      considered: [],
      research: [],
      decisions: [],
      unchallenged_assumptions: [],
      skipped_checks: [],
      claims_without_evidence: [],
      verified_claims: [],
      quality_flags: [],
      evidence: []
    },
    risks: {
      summary: "round6 fixture",
      items: [],
      test_gaps: [],
      review_focus: [],
      test_evidence: []
    },
    dogfood: {
      milestone: "M6",
      summary: "round6 dogfood fixture",
      findings: []
    },
    enrichment: {
      provider: "mock",
      status: "skipped"
    },
    commands: []
  } as unknown as PacketInputs;
}

test("FINDING A: a custom output_dir is reflected in the handoff artifact paths", () => {
  const cwd = "/repo/example";
  const packet = createReviewPacket(handoffInputs(cwd, path.join(cwd, "build", "review")));
  const paths = packet.agent_handoff?.artifact_paths ?? [];

  // Every artifact path must reference the EFFECTIVE (custom) output dir, not the
  // hardcoded .review-surfaces.
  assert.ok(paths.length > 0, "handoff must list artifact paths");
  assert.ok(
    paths.every((entry) => entry.startsWith("build/review/")),
    `artifact_paths must reference the custom output dir: ${JSON.stringify(paths)}`
  );
  assert.ok(paths.includes("build/review/review_packet.md"));
  assert.ok(paths.includes("build/review/review_packet.json"));
  assert.ok(paths.includes("build/review/dogfood.yaml"));
  // No leftover hardcoded .review-surfaces path.
  assert.ok(
    !paths.some((entry) => entry.startsWith(".review-surfaces/")),
    `no artifact path should still point at .review-surfaces: ${JSON.stringify(paths)}`
  );
});

test("FINDING A: the default .review-surfaces output dir is unchanged in the handoff", () => {
  const cwd = "/repo/example";
  const packet = createReviewPacket(handoffInputs(cwd, path.join(cwd, ".review-surfaces")));
  const paths = packet.agent_handoff?.artifact_paths ?? [];

  assert.deepEqual(paths, [
    ".review-surfaces/review_packet.md",
    ".review-surfaces/review_packet.json",
    ".review-surfaces/intent.yaml",
    ".review-surfaces/evaluation.yaml",
    ".review-surfaces/architecture.md",
    ".review-surfaces/risks.yaml",
    ".review-surfaces/methodology.yaml",
    ".review-surfaces/dogfood.yaml"
  ]);
});

// ---------------------------------------------------------------------------
// FINDING B: bootstrap --strict (validate-only) must validate EVERY discovered
// feature spec, not just the first sorted match. A later malformed spec would
// otherwise let bootstrap --strict exit 0 even though the next collect/all run
// fails indexing the whole set.
// ---------------------------------------------------------------------------

function makeRepo(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  spawnSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "fixture@example.com"], { cwd: tmp, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Fixture"], { cwd: tmp, stdio: "ignore" });
  return tmp;
}

function bootstrapStrict(repo: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, "bootstrap", "--strict"], { cwd: repo, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// A valid Acai feature spec under features/. The numeric suffix orders the
// glob result, so `<repo>.feature.yaml` precedes/follows the second spec
// deterministically.
const VALID_SPEC = `feature:
  name: first
components:
  CORE:
    requirements:
      1: The first observable behavior.
`;

test("FINDING B: bootstrap --strict with a malformed SECOND feature spec exits 10", () => {
  const repo = makeRepo("review-surfaces-findingB-second-malformed-");
  try {
    // Full scaffold so every OTHER required target is present and valid; the
    // generated <repo>.feature.yaml is a valid first spec.
    assert.equal(spawnSync("node", [CLI, "init"], { cwd: repo, encoding: "utf8" }).status, 0);
    // The init-generated spec sorts AFTER "aaa..." and BEFORE "zzz...". Add a
    // valid spec that sorts FIRST and a malformed spec that sorts LAST so the
    // FIRST sorted match is valid and only a LATER spec is malformed.
    fs.writeFileSync(path.join(repo, "features", "aaa.feature.yaml"), VALID_SPEC);
    fs.writeFileSync(
      path.join(repo, "features", "zzz.feature.yaml"),
      "feature:\n  name: broken\n  : this : is : not : valid : yaml :\n    - [unterminated\n"
    );

    const strict = bootstrapStrict(repo);
    assert.equal(
      strict.status,
      10,
      `a malformed later feature spec must trip bootstrap --strict: ${strict.stdout}\n${strict.stderr}`
    );
    assert.match(strict.stdout + strict.stderr, /quality gate failed/i);
    // The malformed spec is the one reported invalid, not the valid first match.
    assert.match(strict.stdout, /invalid\s+features\/zzz\.feature\.yaml/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("FINDING B: bootstrap --strict with two VALID feature specs still reports found and exits 0", () => {
  const repo = makeRepo("review-surfaces-findingB-all-valid-");
  try {
    assert.equal(spawnSync("node", [CLI, "init"], { cwd: repo, encoding: "utf8" }).status, 0);
    fs.writeFileSync(path.join(repo, "features", "aaa.feature.yaml"), VALID_SPEC);

    const strict = bootstrapStrict(repo);
    assert.equal(strict.status, 0, `all-valid specs must pass bootstrap --strict: ${strict.stdout}\n${strict.stderr}`);
    // "found N" with N counting every discovered spec.
    assert.match(strict.stdout, /found\s+/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING C: on a --cache signature hit WITHOUT --strict, runAll used to return
// success BEFORE calling applyGate, so a cached packet with a gate-tripping
// condition skipped the fail-gently gate WARNING that a normal run prints. A
// cache hit must match a normal run: without --strict it prints the warning and
// returns success; with --strict it returns the gate exit code.
// ---------------------------------------------------------------------------

// A repo whose single requirement has no satisfying code/test, so the quality
// gate finds a "missing" requirement and trips under --strict.
function setupGateTrippingRepo(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  SRC:
    requirements:
      1: An unimplemented requirement with no matching code or test.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "module.ts"), "export const unrelated = 'nothing';\n");
  fs.writeFileSync(path.join(tmp, "README.md"), "# example\n");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"],
    { cwd: tmp, stdio: "ignore" }
  );
  return tmp;
}

function runAll(cwd: string, extra: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "node",
    [CLI, "all", "--provider", "mock", "--base", "HEAD", "--head", "HEAD", "--spec", "features/example.feature.yaml", ...extra],
    { cwd, encoding: "utf8" }
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("FINDING C: a --cache hit over a gate-tripping evaluation prints the warning (no --strict) and returns success", () => {
  const tmp = setupGateTrippingRepo("review-surfaces-findingC-warn-");
  try {
    // Prime the cache (no --strict): fails gently with a Gate warning, exit 0.
    const prime = runAll(tmp, ["--now", FROZEN, "--cache"]);
    assert.equal(prime.status, 0, prime.stderr);
    assert.match(prime.stderr, /Gate warning \(would exit \d+ under --strict\)/, "prime must warn under the fail-gently gate");

    // Second run with unchanged inputs: a cache HIT must STILL print the gate
    // warning (matching a normal run) and return success.
    const hit = runAll(tmp, ["--now", FROZEN, "--cache"]);
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /inputs unchanged \(signature match\)/, "the second run must be a cache hit");
    assert.match(
      hit.stderr,
      /Gate warning \(would exit \d+ under --strict\)/,
      "a no-strict cache hit must still print the fail-gently gate warning"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING C: a --cache --strict hit over a gate-tripping evaluation returns the gate exit code", () => {
  const tmp = setupGateTrippingRepo("review-surfaces-findingC-strict-");
  try {
    const prime = runAll(tmp, ["--now", FROZEN, "--cache", "--strict"]);
    assert.equal(prime.status, 10, "prime must trip the strict gate");

    const hit = runAll(tmp, ["--now", FROZEN, "--cache", "--strict"]);
    assert.match(hit.stdout, /inputs unchanged \(signature match\)/, "the second strict run must be a cache hit");
    assert.equal(hit.status, 10, "a strict cache hit must still return the gate exit code");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
