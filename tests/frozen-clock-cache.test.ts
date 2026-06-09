import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");
const FROZEN = "2026-01-02T03:04:05.000Z";

// A self-contained committed repo so `all --base HEAD --head HEAD` is stable and
// the working tree is clean (no spurious changed files) until a test mutates it.
function setupRepo(prefix: string): string {
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
      1: The source module exports the marker.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "module.ts"), "export const marker = 'example.SRC.1';\n");
  fs.writeFileSync(path.join(tmp, "README.md"), "# example\n");
  // Mirror real usage: generated run artifacts and alt output dirs are gitignored
  // so they never appear as untracked "changed files" and perturb the signature.
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n.review-surfaces-alt/\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"],
    { cwd: tmp, stdio: "ignore" }
  );
  return tmp;
}

function runAll(cwd: string, extra: string[] = []): { status: number | null; stdout: string; stderr: string } {
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
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Same as runAll but with a custom environment, so a test can vary
// REVIEW_SURFACES_AI_MODEL between runs. The `extra` flags come AFTER the
// defaults so a later --provider overrides the default mock.
function runAllWithEnv(
  cwd: string,
  env: NodeJS.ProcessEnv,
  extra: string[] = []
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "node",
    [CLI, "all", "--base", "HEAD", "--head", "HEAD", "--spec", "features/example.feature.yaml", "--provider", "mock", "--out", ".review-surfaces", ...extra],
    { cwd, encoding: "utf8", env }
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function read(cwd: string, file: string): string {
  return fs.readFileSync(path.join(cwd, ".review-surfaces", file), "utf8");
}

function signatureOf(cwd: string): string {
  return JSON.parse(read(cwd, "manifest.json")).signature;
}

// FIX 1: --now freezes the clock so two runs with identical inputs + --now are
// byte-identical across review_packet.json, manifest.json, and evaluation.yaml.
test("review-surfaces frozen clock: same --now yields byte-identical packet/manifest/evaluation", () => {
  const tmp = setupRepo("review-surfaces-frozen-");
  try {
    runAll(tmp, ["--now", FROZEN]);
    const firstPacket = read(tmp, "review_packet.json");
    const firstManifest = read(tmp, "manifest.json");
    const firstEval = read(tmp, "evaluation.yaml");

    // A real wall-clock run between the two frozen runs proves it is --now, not
    // timing, that makes them identical.
    runAll(tmp);
    runAll(tmp, ["--now", FROZEN]);

    assert.equal(read(tmp, "review_packet.json"), firstPacket, "review_packet.json must be byte-identical");
    assert.equal(read(tmp, "manifest.json"), firstManifest, "manifest.json must be byte-identical");
    assert.equal(read(tmp, "evaluation.yaml"), firstEval, "evaluation.yaml must be byte-identical");

    assert.equal(JSON.parse(firstManifest).created_at, FROZEN, "created_at must be the frozen instant");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FIX 1: without --now created_at is real wall-clock time (unchanged default).
test("review-surfaces frozen clock: without --now created_at is a real timestamp", () => {
  const tmp = setupRepo("review-surfaces-realclock-");
  try {
    runAll(tmp);
    const createdAt = JSON.parse(read(tmp, "manifest.json")).created_at;
    assert.notEqual(createdAt, FROZEN);
    assert.ok(!Number.isNaN(Date.parse(createdAt)), "created_at parses as a real timestamp");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FIX 1: an invalid --now is a clean usage error (exit 2), not a crash.
test("review-surfaces frozen clock: invalid --now is a clean usage error", () => {
  const tmp = setupRepo("review-surfaces-badnow-");
  try {
    const result = runAll(tmp, ["--now", "not-a-timestamp"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--now must be a parseable ISO 8601 timestamp/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FIX 2: the signature is stable across identical runs and excludes created_at
// and the --out path.
test("review-surfaces signature: stable across identical runs, independent of --now and --out", () => {
  const tmp = setupRepo("review-surfaces-sig-stable-");
  try {
    runAll(tmp, ["--now", FROZEN]);
    const frozenSig = signatureOf(tmp);

    runAll(tmp);
    const realClockSig = signatureOf(tmp);
    assert.equal(realClockSig, frozenSig, "signature must not depend on created_at / --now");

    // A different --out directory must not change the signature.
    runAll(tmp, ["--out", ".review-surfaces-alt"]);
    const altManifest = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces-alt", "manifest.json"), "utf8"));
    assert.equal(altManifest.signature, frozenSig, "signature must not depend on the --out path");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FIX 2: a content change to a CHANGED file must change the signature (the cache
// key must capture working-tree/source edits, not only spec/doc inputs).
test("review-surfaces signature: changes when a changed file's content changes", () => {
  const tmp = setupRepo("review-surfaces-sig-source-");
  try {
    // Make the source file a working-tree change so it is a "changed file".
    fs.writeFileSync(path.join(tmp, "src", "module.ts"), "export const marker = 'example.SRC.1'; // v1\n");
    runAll(tmp, ["--now", FROZEN]);
    const sigV1 = signatureOf(tmp);

    fs.writeFileSync(path.join(tmp, "src", "module.ts"), "export const marker = 'example.SRC.1'; // v2 edited\n");
    runAll(tmp, ["--now", FROZEN]);
    const sigV2 = signatureOf(tmp);

    assert.notEqual(sigV2, sigV1, "a changed-source edit must produce a different signature");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FIX 2: provider/model swaps and base/head differences are cache-key-relevant.
test("review-surfaces signature: changes with provider/model and with base/head", () => {
  const tmp = setupRepo("review-surfaces-sig-provider-");
  try {
    runAll(tmp, ["--now", FROZEN]);
    const mockSig = signatureOf(tmp);

    runAll(tmp, ["--now", FROZEN, "--provider", "agent-file"]);
    assert.notEqual(signatureOf(tmp), mockSig, "provider swap must change the signature");

    runAll(tmp, ["--now", FROZEN, "--model", "anthropic:claude-3-5-haiku-latest"]);
    assert.notEqual(signatureOf(tmp), mockSig, "model swap must change the signature");

    // Distinct base produces a distinct base_sha (HEAD vs HEAD~ requires a 2nd
    // commit); add one so base/head differ.
    fs.writeFileSync(path.join(tmp, "README.md"), "# example v2\n");
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "second"],
      { cwd: tmp, stdio: "ignore" }
    );
    const result = spawnSync(
      "node",
      [CLI, "all", "--base", "HEAD~1", "--head", "HEAD", "--spec", "features/example.feature.yaml",
        "--provider", "mock", "--out", ".review-surfaces", "--now", FROZEN],
      { cwd: tmp, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(signatureOf(tmp), mockSig, "differing base/head must change the signature");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FINDING B (round 3): under --provider ai-sdk, the EFFECTIVE model can come
// from REVIEW_SURFACES_AI_MODEL (no --model, no config.llm.model). Before the
// fix the signature recorded model=undefined, so a re-run with a DIFFERENT env
// model hit the old cache and reused the prior model's reasoning/enrichment.
// The env model must be folded into the signature so changing it busts the cache.
// (No API key is set, so the ai-sdk run cleanly skips enrichment offline.)
test("review-surfaces signature: REVIEW_SURFACES_AI_MODEL changes the signature under ai-sdk", () => {
  const tmp = setupRepo("review-surfaces-sig-envmodel-");
  try {
    const baseEnv = { ...process.env };
    delete baseEnv.REVIEW_SURFACES_AI_MODEL;

    const first = runAllWithEnv(
      tmp,
      { ...baseEnv, REVIEW_SURFACES_AI_MODEL: "anthropic:claude-3-5-haiku-latest" },
      ["--now", FROZEN, "--provider", "ai-sdk"]
    );
    assert.equal(first.status, 0, first.stderr);
    const sigModelA = signatureOf(tmp);

    // Same inputs, ONLY the env model differs -> a DIFFERENT signature.
    const second = runAllWithEnv(
      tmp,
      { ...baseEnv, REVIEW_SURFACES_AI_MODEL: "openai:gpt-4o-mini" },
      ["--now", FROZEN, "--provider", "ai-sdk"]
    );
    assert.equal(second.status, 0, second.stderr);
    const sigModelB = signatureOf(tmp);

    assert.notEqual(sigModelB, sigModelA, "changing REVIEW_SURFACES_AI_MODEL must change the ai-sdk signature");

    // The signature must be STABLE when the env model is unchanged (rerunning A).
    const again = runAllWithEnv(
      tmp,
      { ...baseEnv, REVIEW_SURFACES_AI_MODEL: "anthropic:claude-3-5-haiku-latest" },
      ["--now", FROZEN, "--provider", "ai-sdk"]
    );
    assert.equal(again.status, 0, again.stderr);
    assert.equal(signatureOf(tmp), sigModelA, "an unchanged env model must keep the signature stable");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FINDING B (round 3): mock must stay deterministic. The mock provider never
// calls a model, so REVIEW_SURFACES_AI_MODEL must NOT perturb the mock signature.
test("review-surfaces signature: REVIEW_SURFACES_AI_MODEL does NOT change the mock signature", () => {
  const tmp = setupRepo("review-surfaces-sig-mockenv-");
  try {
    const baseEnv = { ...process.env };
    delete baseEnv.REVIEW_SURFACES_AI_MODEL;

    const noEnv = runAllWithEnv(tmp, baseEnv, ["--now", FROZEN]);
    assert.equal(noEnv.status, 0, noEnv.stderr);
    const sigNoEnv = signatureOf(tmp);

    const withEnv = runAllWithEnv(
      tmp,
      { ...baseEnv, REVIEW_SURFACES_AI_MODEL: "openai:gpt-4o-mini" },
      ["--now", FROZEN]
    );
    assert.equal(withEnv.status, 0, withEnv.stderr);
    assert.equal(signatureOf(tmp), sigNoEnv, "the env model must not perturb the deterministic mock signature");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FIX 2: --cache skips regeneration on a signature match and regenerates on a
// mismatch. Sentinel: mutate the packet on a hit (it must be left untouched);
// then mutate an input and confirm the next run rewrites the packet.
test("review-surfaces --cache: reuses on signature match, regenerates on mismatch", () => {
  const tmp = setupRepo("review-surfaces-cache-");
  try {
    fs.writeFileSync(path.join(tmp, "src", "module.ts"), "export const marker = 'example.SRC.1'; // baseline\n");
    runAll(tmp, ["--now", FROZEN, "--cache"]);
    const baselinePacket = read(tmp, "review_packet.json");

    // Write a sentinel into the on-disk packet. A cache HIT must NOT overwrite it.
    const sentinel = baselinePacket.replace("\"schema_version\"", "\"_cache_sentinel\": true,\n  \"schema_version\"");
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), sentinel);

    const hit = runAll(tmp, ["--now", FROZEN, "--cache"]);
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /inputs unchanged \(signature match\); reusing existing packet/);
    assert.equal(read(tmp, "review_packet.json"), sentinel, "cache hit must leave the existing packet untouched");

    // Now MUTATE an input. The signature changes -> cache MISS -> regenerate,
    // which must rewrite the packet (sentinel gone, valid schema_version back).
    fs.writeFileSync(path.join(tmp, "src", "module.ts"), "export const marker = 'example.SRC.1'; // changed\n");
    const miss = runAll(tmp, ["--now", FROZEN, "--cache"]);
    assert.equal(miss.status, 0, miss.stderr);
    assert.doesNotMatch(miss.stdout, /inputs unchanged/);
    const regenerated = read(tmp, "review_packet.json");
    assert.doesNotMatch(regenerated, /_cache_sentinel/, "cache miss must regenerate the packet");
    assert.match(regenerated, /review-surfaces\.packet\.v1/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FIX 2: without --cache a run ALWAYS regenerates even when inputs are unchanged
// (current default behavior preserved).
test("review-surfaces without --cache always regenerates", () => {
  const tmp = setupRepo("review-surfaces-nocache-");
  try {
    runAll(tmp, ["--now", FROZEN]);
    const sentinel = read(tmp, "review_packet.json").replace(
      "\"schema_version\"",
      "\"_no_cache_sentinel\": true,\n  \"schema_version\""
    );
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), sentinel);

    const again = runAll(tmp, ["--now", FROZEN]);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /inputs unchanged/);
    assert.doesNotMatch(read(tmp, "review_packet.json"), /_no_cache_sentinel/, "default run must regenerate");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FIX (staleness): --cache must NOT serve a stale packet when a FLAG-supplied
// input file's content changes. These files (conversation, test-output,
// coverage, agent-input, config) shape the packet but are not discovered by the
// repo walk, so before this fix their content was absent from the signature and
// an edit was a stale cache HIT. Each case asserts the second run is a cache
// MISS (regenerated) and the packet bytes change.
function setupCacheHit(cwd: string, flags: string[]): string {
  runAll(cwd, ["--now", FROZEN, "--cache", ...flags]);
  const first = read(cwd, "review_packet.json");
  // Sentinel into the on-disk packet so an unexpected HIT would leave it intact.
  const sentinel = first.replace("\"schema_version\"", "\"_stale_sentinel\": true,\n  \"schema_version\"");
  fs.writeFileSync(path.join(cwd, ".review-surfaces", "review_packet.json"), sentinel);
  return first;
}

function assertCacheMissRegenerated(cwd: string, flags: string[]): void {
  const run = runAll(cwd, ["--now", FROZEN, "--cache", ...flags]);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /inputs unchanged/, "a flag-input content change must be a cache MISS");
  assert.doesNotMatch(read(cwd, "review_packet.json"), /_stale_sentinel/, "cache miss must regenerate the packet");
}

test("review-surfaces --cache: a --conversation content change is a cache miss", () => {
  const tmp = setupRepo("review-surfaces-cache-conv-");
  try {
    fs.writeFileSync(path.join(tmp, "conv.txt"), "research: looked at X\ndecision: chose Y\nconsidered: A vs B\n");
    setupCacheHit(tmp, ["--conversation", "conv.txt"]);
    fs.writeFileSync(path.join(tmp, "conv.txt"), "hi\n");
    assertCacheMissRegenerated(tmp, ["--conversation", "conv.txt"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces --cache: a --test-output content change (green->red) is a cache miss", () => {
  const tmp = setupRepo("review-surfaces-cache-junit-");
  try {
    fs.mkdirSync(path.join(tmp, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "reports", "j.xml"),
      `<testsuites><testsuite name="s" tests="1" failures="0"><testcase name="t1" classname="s"/></testsuite></testsuites>\n`
    );
    setupCacheHit(tmp, ["--test-output", "reports/j.xml"]);
    fs.writeFileSync(
      path.join(tmp, "reports", "j.xml"),
      `<testsuites><testsuite name="s" tests="2" failures="1"><testcase name="t1" classname="s"/><testcase name="t2" classname="s"><failure>boom</failure></testcase></testsuite></testsuites>\n`
    );
    assertCacheMissRegenerated(tmp, ["--test-output", "reports/j.xml"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces --cache: a --coverage content change is a cache miss", () => {
  const tmp = setupRepo("review-surfaces-cache-cov-");
  try {
    fs.mkdirSync(path.join(tmp, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "reports", "j.xml"),
      `<testsuites><testsuite name="s" tests="1" failures="0"><testcase name="t1" classname="s"/></testsuite></testsuites>\n`
    );
    fs.writeFileSync(
      path.join(tmp, "coverage.json"),
      `{"total":{"lines":{"pct":90},"statements":{"pct":90},"functions":{"pct":90},"branches":{"pct":90}}}\n`
    );
    setupCacheHit(tmp, ["--test-output", "reports/j.xml", "--coverage", "coverage.json"]);
    fs.writeFileSync(
      path.join(tmp, "coverage.json"),
      `{"total":{"lines":{"pct":12},"statements":{"pct":12},"functions":{"pct":12},"branches":{"pct":12}}}\n`
    );
    assertCacheMissRegenerated(tmp, ["--test-output", "reports/j.xml", "--coverage", "coverage.json"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces --cache: an --agent-input content change is a cache miss (agent-file provider)", () => {
  const tmp = setupRepo("review-surfaces-cache-agent-");
  try {
    fs.writeFileSync(path.join(tmp, "agent.json"), `{"hypotheses":[{"id":"H1","statement":"first"}]}\n`);
    // agent-file provider, so override the default --provider mock from runAll.
    runAll(tmp, ["--now", FROZEN, "--cache", "--provider", "agent-file", "--agent-input", "agent.json"]);
    const first = read(tmp, "review_packet.json");
    const sentinel = first.replace("\"schema_version\"", "\"_stale_sentinel\": true,\n  \"schema_version\"");
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), sentinel);

    fs.writeFileSync(
      path.join(tmp, "agent.json"),
      `{"hypotheses":[{"id":"H2","statement":"second"},{"id":"H3","statement":"third"}]}\n`
    );
    const run = runAll(tmp, ["--now", FROZEN, "--cache", "--provider", "agent-file", "--agent-input", "agent.json"]);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /inputs unchanged/, "an agent-input change must be a cache MISS");
    assert.doesNotMatch(read(tmp, "review_packet.json"), /_stale_sentinel/, "cache miss must regenerate the packet");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces --cache: a --config content change is a cache miss", () => {
  const tmp = setupRepo("review-surfaces-cache-config-");
  try {
    // A gitignored config pointed at via --config (clean, not a changed file).
    fs.appendFileSync(path.join(tmp, ".gitignore"), "myconfig.yaml\n");
    fs.writeFileSync(
      path.join(tmp, "myconfig.yaml"),
      "schema_version: review-surfaces.config.v1\nquality_gate:\n  max_missing: 0\n"
    );
    runAll(tmp, ["--now", FROZEN, "--cache", "--config", "myconfig.yaml"]);
    const sigBefore = signatureOf(tmp);

    fs.writeFileSync(
      path.join(tmp, "myconfig.yaml"),
      "schema_version: review-surfaces.config.v1\nquality_gate:\n  max_missing: 5\n"
    );
    const run = runAll(tmp, ["--now", FROZEN, "--cache", "--config", "myconfig.yaml"]);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /inputs unchanged/, "a config content change must be a cache MISS");
    assert.notEqual(signatureOf(tmp), sigBefore, "config content must be folded into the signature");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FINDING E: with --cache, changing --previous-packet (its path OR its contents)
// must change the signature. Before the fix it was absent from the fingerprint,
// so a dogfood --cache run could restore an old review_packet.json whose
// dogfood.comparison / agent_handoff.changes_since_last_packet was computed
// against a stale baseline. The previous packet is hashed (path + content) like
// --agent-input and --test-output.
function writePreviousPacket(cwd: string, dir: string, evalSummary: string): void {
  fs.mkdirSync(path.join(cwd, dir), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, dir, "review_packet.json"),
    `{"schema_version":"review-surfaces.packet.v1","evaluation":{"summary":"${evalSummary}","results":[]},"risks":{"summary":"r","items":[]}}\n`
  );
}

test("review-surfaces --cache: a --previous-packet content change is a cache miss (dogfood comparison staleness)", () => {
  const tmp = setupRepo("review-surfaces-cache-prevpacket-content-");
  try {
    writePreviousPacket(tmp, "prev", "baseline-summary");
    runAll(tmp, ["--now", FROZEN, "--cache", "--dogfood", "--previous-packet", "prev"]);
    const sigBefore = signatureOf(tmp);

    // Edit the baseline packet's bytes (the comparison would change). Same path.
    writePreviousPacket(tmp, "prev", "edited-different-summary");
    const run = runAll(tmp, ["--now", FROZEN, "--cache", "--dogfood", "--previous-packet", "prev"]);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /inputs unchanged/, "a previous-packet content change must be a cache MISS");
    assert.notEqual(signatureOf(tmp), sigBefore, "previous-packet content must be folded into the signature");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces --cache: a --previous-packet PATH change is a cache miss", () => {
  const tmp = setupRepo("review-surfaces-cache-prevpacket-path-");
  try {
    writePreviousPacket(tmp, "prev1", "summary-one");
    writePreviousPacket(tmp, "prev2", "summary-two-different");
    runAll(tmp, ["--now", FROZEN, "--cache", "--dogfood", "--previous-packet", "prev1"]);
    const sigPrev1 = signatureOf(tmp);

    // Point at a DIFFERENT baseline packet. The signature must change so the cache
    // does not reuse the comparison computed against the first baseline.
    runAll(tmp, ["--now", FROZEN, "--cache", "--dogfood", "--previous-packet", "prev2"]);
    assert.notEqual(signatureOf(tmp), sigPrev1, "changing which baseline --previous-packet points at must change the signature");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FINDING F: a dogfood --cache packet and a local --cache packet must NOT share a
// signature. run_mode (and milestone) are part of the fingerprint so a prior
// local-mode cached packet can never be restored for a dogfood run (which would
// yield a packet missing the schema-required dogfood + agent_handoff sections).
test("review-surfaces --cache: a dogfood run never matches a non-dogfood cached signature", () => {
  const tmp = setupRepo("review-surfaces-cache-runmode-");
  try {
    // Local run primes the cache and stamps run_mode local.
    runAll(tmp, ["--now", FROZEN, "--cache"]);
    const localSig = signatureOf(tmp);
    const localManifest = JSON.parse(read(tmp, "manifest.json"));
    assert.equal(localManifest.run_mode, "local", "the first run is local mode");

    // A dogfood run with otherwise-identical inputs must compute a DIFFERENT
    // signature (so it never reuses the local-mode packet).
    const dogfood = runAll(tmp, ["--now", FROZEN, "--cache", "--dogfood"]);
    assert.equal(dogfood.status, 0, dogfood.stderr);
    assert.doesNotMatch(dogfood.stdout, /inputs unchanged/, "a dogfood run must NOT hit a local-mode cached signature");
    const dogfoodSig = signatureOf(tmp);
    assert.notEqual(dogfoodSig, localSig, "dogfood and local runs must not share a signature");

    // And the regenerated dogfood packet carries the schema-required sections that
    // a restored local-mode packet would have been missing.
    const dogfoodManifest = JSON.parse(read(tmp, "manifest.json"));
    assert.equal(dogfoodManifest.run_mode, "dogfood", "the dogfood run stamps run_mode dogfood");
    const packet = JSON.parse(read(tmp, "review_packet.json"));
    assert.ok(packet.dogfood, "the dogfood packet has the required dogfood section");
    assert.ok(packet.agent_handoff, "the dogfood packet has the required agent_handoff section");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// A repo whose single requirement has no satisfying code/test, so the quality
// gate finds a "missing" requirement and trips (exit 10) under --strict.
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

// FIX (gate bypass): on a --cache HIT under --strict, if the cached output dir
// is incomplete (evaluation.yaml missing/unreadable) the gate must STILL run.
// Before the fix loadEvaluation returned null and the run short-circuited to
// exit 0, silently turning --strict into a no-op. Now it regenerates and gates.
test("review-surfaces --cache --strict: missing evaluation.yaml on a hit regenerates and gates (not exit 0)", () => {
  const tmp = setupGateTrippingRepo("review-surfaces-cache-strict-");
  try {
    // Prime the cache; the gate trips on the prime (exit 10) but writes artifacts.
    const prime = runAll(tmp, ["--now", FROZEN, "--cache", "--strict"]);
    assert.equal(prime.status, 10, "prime must trip the strict gate (1 missing requirement)");

    // Remove the sidecar evaluation.yaml; manifest.json + a valid packet remain,
    // so the signature still matches => without the fix this is a HIT-skip-gate.
    fs.rmSync(path.join(tmp, ".review-surfaces", "evaluation.yaml"));

    const run = runAll(tmp, ["--now", FROZEN, "--cache", "--strict"]);
    assert.equal(run.status, 10, "missing evaluation.yaml on a strict cache hit must regenerate and still gate (exit 10)");
    assert.match(run.stderr, /regenerating to apply the --strict gate|Strict gate tripped/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// A clean --cache --strict HIT (evaluation.yaml present) still reuses the packet
// untouched AND applies the gate from the loaded evaluation (no regeneration).
test("review-surfaces --cache --strict: a clean hit reuses the packet and still applies the gate", () => {
  const tmp = setupGateTrippingRepo("review-surfaces-cache-strict-clean-");
  try {
    const prime = runAll(tmp, ["--now", FROZEN, "--cache", "--strict"]);
    assert.equal(prime.status, 10);

    const sentinel = read(tmp, "review_packet.json").replace(
      "\"schema_version\"",
      "\"_clean_hit_sentinel\": true,\n  \"schema_version\""
    );
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), sentinel);

    const run = runAll(tmp, ["--now", FROZEN, "--cache", "--strict"]);
    assert.equal(run.status, 10, "clean strict hit must still apply the gate from the loaded evaluation");
    assert.match(run.stdout, /inputs unchanged \(signature match\)/, "a clean hit must reuse, not regenerate");
    // review-surfaces.HUMAN_REVIEW.15: cache reuse still presents the human
    // cockpit summary as the reviewer entrypoint.
    assert.match(run.stdout, /Human review: \.review-surfaces\/human_review\.md/);
    assert.match(run.stdout, /Verdict: [a-z_]+/);
    assert.match(run.stdout, /Review first: \d+ item\(s\)/);
    assert.match(run.stdout, /Blockers: \d+/);
    assert.match(run.stdout, /Suggested comments: \d+/);
    assert.match(run.stdout, /Missing evidence: \d+/);
    assert.doesNotMatch(run.stdout, /agent_handoff\.md/);
    assert.match(read(tmp, "review_packet.json"), /_clean_hit_sentinel/, "a clean hit must leave the packet untouched");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FIX (cache output dir): when config sets a custom output_dir and the run does
// NOT pass --out, the --cache snapshot must read the manifest/packet from the
// CONFIGURED dir (the same precedence collectInputs uses), not .review-surfaces.
// Before the fix the snapshot read .review-surfaces/manifest.json (absent), so a
// custom-output_dir repo ALWAYS missed the cache and silently regenerated.
const CUSTOM_OUTPUT_DIR = ".review-surfaces-custom";

function setupCustomOutputDirRepo(prefix: string): string {
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
      1: The source module exports the marker.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "module.ts"), "export const marker = 'example.SRC.1';\n");
  fs.writeFileSync(path.join(tmp, "README.md"), "# example\n");
  // Config points the output dir somewhere OTHER than .review-surfaces.
  fs.writeFileSync(
    path.join(tmp, "review-surfaces.config.yaml"),
    `schema_version: review-surfaces.config.v1\noutput_dir: ${CUSTOM_OUTPUT_DIR}\n`
  );
  // The custom output dir must be gitignored so its generated artifacts never
  // perturb the changed-file signature.
  fs.writeFileSync(path.join(tmp, ".gitignore"), `${CUSTOM_OUTPUT_DIR}/\n.review-surfaces/\n`);
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"],
    { cwd: tmp, stdio: "ignore" }
  );
  return tmp;
}

// Run `all` WITHOUT --out so the effective output dir comes from config.output_dir.
function runAllNoOut(cwd: string, extra: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "node",
    [CLI, "all", "--base", "HEAD", "--head", "HEAD", "--spec", "features/example.feature.yaml", "--provider", "mock", ...extra],
    { cwd, encoding: "utf8" }
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("review-surfaces --cache: a configured output_dir (no --out) is read for the cache snapshot", () => {
  const tmp = setupCustomOutputDirRepo("review-surfaces-cache-customdir-");
  try {
    // Prime: writes manifest/packet under the CONFIGURED dir, not .review-surfaces.
    const prime = runAllNoOut(tmp, ["--now", FROZEN, "--cache"]);
    assert.equal(prime.status, 0, prime.stderr);
    assert.ok(
      fs.existsSync(path.join(tmp, CUSTOM_OUTPUT_DIR, "manifest.json")),
      "artifacts must be written under the configured output_dir"
    );
    assert.ok(
      !fs.existsSync(path.join(tmp, ".review-surfaces", "manifest.json")),
      ".review-surfaces must NOT be used when config sets output_dir"
    );

    // Sentinel the on-disk packet in the CONFIGURED dir. A cache HIT must not touch it.
    const packetPath = path.join(tmp, CUSTOM_OUTPUT_DIR, "review_packet.json");
    const sentinel = fs
      .readFileSync(packetPath, "utf8")
      .replace("\"schema_version\"", "\"_custom_dir_sentinel\": true,\n  \"schema_version\"");
    fs.writeFileSync(packetPath, sentinel);

    // Second run with unchanged inputs: must be a cache HIT reading the configured dir.
    const hit = runAllNoOut(tmp, ["--now", FROZEN, "--cache"]);
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(
      hit.stdout,
      /inputs unchanged \(signature match\); reusing existing packet/,
      "a custom output_dir must still produce a cache HIT (snapshot read the configured dir)"
    );
    assert.match(
      fs.readFileSync(packetPath, "utf8"),
      /_custom_dir_sentinel/,
      "the cache hit must leave the configured-dir packet untouched"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
