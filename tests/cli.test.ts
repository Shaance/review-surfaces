import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
