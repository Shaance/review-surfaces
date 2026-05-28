import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
