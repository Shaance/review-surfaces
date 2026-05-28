import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { indexCommandTranscriptFiles, indexCommandTranscripts } from "../src/commands/transcripts";
import { recordCommandTranscript } from "../src/commands/runner";

function sequenceNow(...dates: string[]): () => Date {
  const values = dates.map((date) => new Date(date));
  return () => values.shift() ?? new Date(dates[dates.length - 1]);
}

test("review-surfaces.CLI.7 records a passing command as a bounded transcript", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-"));
  const result = await recordCommandTranscript({
    cwd: tmp,
    args: [process.execPath, "-e", "console.log('runner-ok')"],
    id: "CMD-RUN-001",
    streamOutput: false,
    now: sequenceNow("2026-05-28T12:00:00.000Z", "2026-05-28T12:00:00.250Z")
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.transcript.id, "CMD-RUN-001");
  assert.equal(result.transcript.status, "passed");
  assert.equal(result.transcript.duration_ms, 250);
  assert.match(result.transcript.stdout_excerpt ?? "", /runner-ok/);
  assert.match(result.transcript.stdout_hash ?? "", /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(path.join(tmp, result.transcriptPath)));

  const indexed = await indexCommandTranscripts(tmp, [result.transcriptPath]);
  assert.equal(indexed[0].id, "CMD-RUN-001");
  assert.equal(indexed[0].status, "passed");
});

test("review-surfaces.CLI.7 records a failed command and preserves its exit code", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-fail-"));
  const result = await recordCommandTranscript({
    cwd: tmp,
    args: [process.execPath, "-e", "console.error('runner-failed'); process.exit(7)"],
    id: "CMD-RUN-FAIL",
    streamOutput: false,
    now: sequenceNow("2026-05-28T12:00:00.000Z", "2026-05-28T12:00:01.000Z")
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.transcript.status, "failed");
  assert.equal(result.transcript.exit_code, 7);
  assert.match(result.transcript.stderr_excerpt ?? "", /runner-failed/);
});

test("review-surfaces.PRIVACY.2 redacts and bounds transcript output captured by run", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-redact-"));
  const secret = "AIzaSyFakeSecretForRunnerOnly000000000";
  const result = await recordCommandTranscript({
    cwd: tmp,
    args: [process.execPath, "-e", `console.log('${secret} ${"x".repeat(2000)}')`],
    id: "CMD-RUN-REDACT",
    streamOutput: false,
    now: sequenceNow("2026-05-28T12:00:00.000Z", "2026-05-28T12:00:00.001Z")
  });

  assert.equal(result.transcript.truncated, true);
  assert.ok((result.transcript.stdout_excerpt ?? "").length <= 1200);
  assert.doesNotMatch(result.transcript.command, /AIzaSyFakeSecretForRunnerOnly/);
  assert.doesNotMatch(result.transcript.stdout_excerpt ?? "", /AIzaSyFakeSecretForRunnerOnly/);
  assert.match(result.transcript.stdout_excerpt ?? "", /\[REDACTED:/);
});

test("review-surfaces.CLI.7 run command writes transcripts from the CLI", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-cli-"));
  const cli = path.join(process.cwd(), "dist", "src", "cli", "index.js");
  const result = spawnSync(
    "node",
    [
      cli,
      "run",
      "--id",
      "CMD-CLI-001",
      "--command-transcripts",
      ".review-surfaces/commands",
      "--",
      process.execPath,
      "-e",
      "console.log('cli-run-ok')"
    ],
    { cwd: tmp, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cli-run-ok/);
  assert.match(result.stderr, /Recorded command transcript/);
  const transcriptPath = path.join(tmp, ".review-surfaces", "commands", "CMD-CLI-001.json");
  assert.ok(fs.existsSync(transcriptPath));
  const parsed = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
  assert.equal(parsed.commands[0].id, "CMD-CLI-001");
  assert.equal(parsed.commands[0].status, "passed");
});

test("review-surfaces.CLI.7 run respects --out when no transcript directory is supplied", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-cli-out-"));
  const cli = path.join(process.cwd(), "dist", "src", "cli", "index.js");
  const result = spawnSync(
    "node",
    [
      cli,
      "run",
      "--id",
      "CMD-CLI-OUT",
      "--out",
      "custom-surfaces",
      "--",
      process.execPath,
      "-e",
      "console.log('cli-out-ok')"
    ],
    { cwd: tmp, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(tmp, "custom-surfaces", "commands", "CMD-CLI-OUT.json")));
});

test("review-surfaces.CLI.7 uses deterministic default transcript IDs and overwrites stale runs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-deterministic-"));
  const first = await recordCommandTranscript({
    cwd: tmp,
    args: [process.execPath, "-e", "console.log('first')"],
    streamOutput: false,
    now: sequenceNow("2026-05-28T12:00:00.000Z", "2026-05-28T12:00:00.100Z")
  });
  const second = await recordCommandTranscript({
    cwd: tmp,
    args: [process.execPath, "-e", "console.log('first')"],
    streamOutput: false,
    now: sequenceNow("2026-05-28T12:30:00.000Z", "2026-05-28T12:30:00.100Z")
  });

  assert.equal(first.transcriptPath, second.transcriptPath);
  const transcriptDir = path.join(tmp, ".review-surfaces", "commands");
  assert.equal(fs.readdirSync(transcriptDir).filter((file) => file.endsWith(".json")).length, 1);
});

test("review-surfaces.COLLECTOR.7 returns transcript source hashes from the indexing pass", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-transcript-hash-"));
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "commands", "local.json"),
    JSON.stringify({ commands: [{ id: "CMD-HASH", command: "pnpm run test", exit_code: 0 }] })
  );

  const result = await indexCommandTranscriptFiles(tmp, [".review-surfaces/commands/local.json"]);

  assert.equal(result.transcripts[0].id, "CMD-HASH");
  assert.equal(result.sourceHashes[0].path, ".review-surfaces/commands/local.json");
  assert.equal(result.sourceHashes[0].kind, "command_transcript");
  assert.match(result.sourceHashes[0].hash, /^[a-f0-9]{64}$/);
});
