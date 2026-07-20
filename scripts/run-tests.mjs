#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const testDir = path.resolve("dist/tests");
const processHeavy = new Set([
  "artifact-provenance-input-hardening.test.js",
  "agreement-audit-cli.test.js",
  "agreement-audit-integrated.test.js",
  "bootstrap-handoff-cache.test.js",
  "cli.test.js",
  "cold-start.test.js",
  "collect.test.js",
  "command-runner.test.js",
  "comment.test.js",
  "conversation-discovery.test.js",
  "distribution.test.js",
  "evaluation.test.js",
  "evidence-soundness-cache.test.js",
  "foreign-repo-python.test.js",
  "foreign-repo.test.js",
  "frozen-clock-cache.test.js",
  "git-failure-mode.test.js",
  "init.test.js",
  "lcov.test.js",
  "packet-e2e.test.js",
  "pipeline-stage-composition.test.js",
  "pr-surface-action.test.js",
  "pr-surface-e2e.test.js",
  "previous-packet-handoff.test.js",
  "privacy.test.js",
  "range-truth.test.js",
  "rendering-paths-redaction.test.js",
  "sarif.test.js",
  "scoreboard.test.js",
  "tests-evidence.test.js",
  "untracked-collection.test.js",
  "verification.test.js"
]);
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort();
const pureFiles = files.filter((name) => !processHeavy.has(name)).map((name) => path.join(testDir, name));
const integrationFiles = files.filter((name) => processHeavy.has(name)).map((name) => path.join(testDir, name));
const runtimeArgs = process.argv.includes("--coverage") ? ["--experimental-test-coverage"] : [];

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Pure suites retain Node's normal parallel scheduling. Suites that spawn CLIs,
// git, or nested test processes share a small explicit concurrency budget so
// filesystem and CPU contention cannot turn the gate into a false slowdown.
// Coverage uses the same scheduler instead of bypassing this split.
if (pureFiles.length > 0) run([...runtimeArgs, "--test", ...pureFiles]);
if (integrationFiles.length > 0) {
  run([...runtimeArgs, "--test", "--test-concurrency=2", ...integrationFiles]);
}
