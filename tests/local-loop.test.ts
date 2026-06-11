import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// review-surfaces.LOCAL_LOOP.1-4: the scripted local review loop. These tests
// pin the orchestration contract — the scripts exist, are executable, are
// exposed as pnpm scripts, call the exact CLI commands a user types by hand
// (orchestration only, no behavior of their own), and are documented in
// README.md and AGENTS.md. The scripts' runtime behavior is exercised by the
// per-phase dogfood loop itself (local-gate runs the suite that runs this test).

const root = process.cwd();
const localReview = fs.readFileSync(path.join(root, "scripts", "local-review.sh"), "utf8");
const localGate = fs.readFileSync(path.join(root, "scripts", "local-gate.sh"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const agentsMd = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(path.join(root, "scripts", file), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

test("review-surfaces.LOCAL_LOOP.1 local-review.sh builds, runs the mock pipeline against origin/main..HEAD, renders sticky + html, validates all surfaces, and prints an artifact index", () => {
  assert.ok(isExecutable("local-review.sh"), "scripts/local-review.sh must be executable");
  assert.equal(packageJson.scripts["local-review"], "./scripts/local-review.sh");
  // Defaults: mock provider, origin/main..HEAD (network use: git only).
  assert.match(localReview, /origin\/main/);
  assert.match(localReview, /mock/);
  // Each step is the same CLI command a user types by hand.
  assert.match(localReview, /pnpm run build/);
  assert.match(localReview, /node bin\/review-surfaces\.js all/);
  assert.match(localReview, /comment --format sticky/);
  assert.match(localReview, /human --format html/);
  assert.match(localReview, /validate --surface all/);
  // The artifact index names the surfaces a reviewer opens.
  assert.match(localReview, /human_review\.md/);
  assert.match(localReview, /human_review\.html/);
  assert.match(localReview, /comment\.md/);
});

test("review-surfaces.LOCAL_LOOP.2 local-gate.sh runs lint, typecheck, full test, determinism-check, and the strict empty-diff self-dogfood as one command", () => {
  assert.ok(isExecutable("local-gate.sh"), "scripts/local-gate.sh must be executable");
  assert.equal(packageJson.scripts["local-gate"], "./scripts/local-gate.sh");
  // lint is the repo's typecheck alias, so the lint step covers the spec's
  // lint + typecheck gate steps in one run.
  assert.match(localGate, /pnpm run lint/);
  assert.match(localGate, /pnpm run test/);
  assert.match(localGate, /pnpm run determinism-check/);
  // The strict empty-diff self-dogfood: the documented red-main footgun guard.
  assert.match(localGate, /--base HEAD/);
  assert.match(localGate, /--head HEAD/);
  assert.match(localGate, /--strict/);
  // set -euo pipefail so any failing step fails the gate.
  assert.match(localGate, /set -euo pipefail/);
});

test("review-surfaces.LOCAL_LOOP.3 local-review accepts --previous and auto-detects the last local run's packet", () => {
  // Explicit previous-round input...
  assert.match(localReview, /--previous\)/);
  // ...passed through to the CLI's existing comparison flag (the comparison
  // engine is transport-indifferent; the script only chooses the input).
  assert.match(localReview, /--previous-packet/);
  // Auto-detection of the last local run when --previous is omitted.
  assert.match(localReview, /review_packet\.json/);
});

test("review-surfaces.LOCAL_LOOP.4 both scripts are documented in README.md and AGENTS.md and contain orchestration only", () => {
  for (const doc of [readme, agentsMd]) {
    assert.match(doc, /pnpm run local-review/);
    assert.match(doc, /pnpm run local-gate/);
  }
  // Orchestration only: every node invocation in the scripts goes through the
  // public CLI entrypoint — no inline node -e logic, no analysis in bash.
  for (const script of [localReview, localGate]) {
    const nodeCalls = script.split("\n").filter((line) => /\bnode\b/.test(line) && !line.trim().startsWith("#"));
    for (const call of nodeCalls) {
      assert.match(call, /node bin\/review-surfaces\.js/, `non-CLI node call in script: ${call}`);
    }
    assert.doesNotMatch(script, /node -e/);
  }
});
