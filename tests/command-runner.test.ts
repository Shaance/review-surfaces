import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { indexCommandTranscriptFiles, indexCommandTranscripts } from "../src/commands/transcripts";
import { recordCommandTranscript } from "../src/commands/runner";
import { SECRET_PATTERN_SOURCES, redactSecrets } from "../src/privacy/secrets";

function loadBinRedact(): (value: string | undefined) => string | undefined {
  const runtime = require(path.join(process.cwd(), "bin", "privacy-runtime.js")) as {
    redact(value: string | undefined): string | undefined;
  };
  return runtime.redact;
}

function copyNoDistBin(tmp: string): string {
  const fallbackBinDir = path.join(tmp, "package", "bin");
  fs.mkdirSync(fallbackBinDir, { recursive: true });
  for (const file of ["review-surfaces.js", "privacy-runtime.js", "bounded-stream-capture.js"]) {
    fs.copyFileSync(path.join(process.cwd(), "bin", file), path.join(fallbackBinDir, file));
  }
  return path.join(fallbackBinDir, "review-surfaces.js");
}

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
    headSha: "1111111111111111111111111111111111111111",
    now: sequenceNow("2026-05-28T12:00:00.000Z", "2026-05-28T12:00:00.250Z")
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.transcript.id, "CMD-RUN-001");
  assert.equal(result.transcript.status, "passed");
  assert.equal(result.transcript.head_sha, "1111111111111111111111111111111111111111");
  assert.equal(result.transcript.duration_ms, 250);
  assert.match(result.transcript.stdout_excerpt ?? "", /runner-ok/);
  assert.match(result.transcript.stdout_hash ?? "", /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(path.join(tmp, result.transcriptPath)));

  const indexed = await indexCommandTranscripts(tmp, [result.transcriptPath]);
  assert.equal(indexed[0].id, "CMD-RUN-001");
  assert.equal(indexed[0].status, "passed");
  assert.equal(indexed[0].head_sha, "1111111111111111111111111111111111111111");
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

test("review-surfaces.PRIVACY.2 a blocked secret after the retained output cap still blocks remote use", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-late-secret-"));
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  const result = await recordCommandTranscript({
    cwd: tmp,
    args: [process.execPath, "-e", `process.stdout.write('${"x".repeat(7000)} ${secret}')`],
    id: "CMD-RUN-LATE-SECRET",
    streamOutput: false,
    now: sequenceNow("2026-05-28T12:00:00.000Z", "2026-05-28T12:00:00.001Z")
  });

  assert.equal(result.transcript.truncated, true);
  assert.equal(result.transcript.secret_blocked, true);
  assert.doesNotMatch(result.transcript.stdout_excerpt ?? "", /sk-proj-/);
});

test("review-surfaces.PRIVACY.2 an unmatched PEM opener is redacted through the retained capture", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-open-pem-"));
  const result = await recordCommandTranscript({
    cwd: tmp,
    args: [
      process.execPath,
      "-e",
      "process.stdout.write('-'.repeat(5) + 'BEGIN PRIVATE KEY' + '-'.repeat(5) + '\\nMII-UNTERMINATED-KEY-MATERIAL\\n' + 'X'.repeat(6000))"
    ],
    id: "CMD-RUN-OPEN-PEM",
    streamOutput: false,
    now: sequenceNow("2026-05-28T12:00:00.000Z", "2026-05-28T12:00:00.001Z")
  });

  const excerpt = result.transcript.stdout_excerpt ?? "";
  assert.equal(result.transcript.truncated, true);
  assert.equal(result.transcript.secret_blocked, true);
  assert.match(excerpt, /\[REDACTED:private_key\]/);
  assert.doesNotMatch(excerpt, /BEGIN PRIVATE KEY|MII-UNTERMINATED/);
});

test("review-surfaces.PRIVACY.2 an unmatched PEM in the command field is blocked and redacted", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-command-pem-"));
  const result = await recordCommandTranscript({
    cwd: tmp,
    args: [
      process.execPath,
      "-e",
      "console.log('safe-output') // -----BEGIN PRIVATE KEY----- MII-COMMAND-KEY-PREFIX"
    ],
    id: "CMD-RUN-COMMAND-PEM",
    streamOutput: false,
    now: sequenceNow("2026-05-28T12:00:00.000Z", "2026-05-28T12:00:00.001Z")
  });

  assert.equal(result.transcript.secret_blocked, true);
  assert.match(result.transcript.command, /\[REDACTED:private_key\]/);
  assert.doesNotMatch(result.transcript.command, /BEGIN PRIVATE KEY|MII-COMMAND/);
});

test("review-surfaces.PRIVACY.2 a PEM closing beyond the raw cap cannot persist its header or key prefix", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-capped-pem-"));
  const output = `safe-prefix\n-----BEGIN PRIVATE KEY-----\nMII-CAPPED-KEY-PREFIX\n${"A".repeat(6000)}\n-----END PRIVATE KEY-----`;
  const result = await recordCommandTranscript({
    cwd: tmp,
    args: [
      process.execPath,
      "-e",
      `process.stdout.write('safe-prefix\\n' + '-'.repeat(5) + 'BEGIN PRIVATE KEY' + '-'.repeat(5) + '\\nMII-CAPPED-KEY-PREFIX\\n' + 'A'.repeat(6000) + '\\n' + '-'.repeat(5) + 'END PRIVATE KEY' + '-'.repeat(5))`
    ],
    id: "CMD-RUN-CAPPED-PEM",
    streamOutput: false,
    now: sequenceNow("2026-05-28T12:00:00.000Z", "2026-05-28T12:00:00.001Z")
  });

  const excerpt = result.transcript.stdout_excerpt ?? "";
  assert.equal(result.transcript.truncated, true);
  assert.equal(result.transcript.secret_blocked, true);
  assert.match(excerpt, /safe-prefix/);
  assert.match(excerpt, /\[REDACTED:private_key\]/);
  assert.doesNotMatch(excerpt, /BEGIN PRIVATE KEY|MII-CAPPED-KEY-PREFIX/);
  assert.equal(
    result.transcript.stdout_hash,
    crypto.createHash("sha256").update(output).digest("hex"),
    "the digest still covers the complete stream beyond the retained raw cap"
  );
});

test("review-surfaces.PRIVACY.2 the compiled runner wires capture blocking into persisted transcripts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-jwt-"));
  const result = await recordCommandTranscript({
    cwd: tmp,
    args: [process.execPath, "-e", "process.stdout.write('eyJ' + 'a'.repeat(5000) + '.' + 'b'.repeat(5000) + '.c')"],
    id: "CMD-RUN-JWT",
    streamOutput: false,
    now: sequenceNow("2026-05-28T12:00:00.000Z", "2026-05-28T12:00:00.001Z")
  });

  assert.equal(result.transcript.truncated, true);
  assert.equal(result.transcript.secret_blocked, true);
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

test("review-surfaces.PRIVACY.2 no-dist run fallback detects secrets after its raw cap", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-fallback-secret-"));
  const fallbackBin = copyNoDistBin(tmp);

  const result = spawnSync(
    process.execPath,
    [
      fallbackBin,
      "run",
      "--id",
      "CMD-FALLBACK-LATE-SECRET",
      "--command-transcripts",
      "commands",
      "--",
      process.execPath,
      "-e",
      "process.stdout.write('x'.repeat(7000) + ' ' + ['sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz123456'].join(''))"
    ],
    { cwd: tmp, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const transcript = JSON.parse(
    fs.readFileSync(path.join(tmp, "commands", "CMD-FALLBACK-LATE-SECRET.json"), "utf8")
  ).commands[0];
  const output = `${"x".repeat(7000)} sk-proj-abcdefghijklmnopqrstuvwxyz123456`;
  assert.equal(transcript.truncated, true);
  assert.equal(transcript.secret_blocked, true);
  assert.doesNotMatch(transcript.stdout_excerpt ?? "", /sk-proj-/);
  assert.equal(
    transcript.stdout_hash,
    crypto.createHash("sha256").update(output).digest("hex"),
    "the no-dist wiring hashes the full stream beyond its retained excerpt"
  );
});

test("review-surfaces.PRIVACY.2 no-dist run fallback does not block long secret-free output", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-fallback-clean-"));
  const fallbackBin = copyNoDistBin(tmp);
  const outputLength = 2 * 1024 * 1024;

  const result = spawnSync(
    process.execPath,
    [
      fallbackBin,
      "run",
      "--id",
      "CMD-FALLBACK-LONG-CLEAN",
      "--command-transcripts",
      "commands",
      "--",
      process.execPath,
      "-e",
      `process.stdout.write("z".repeat(${outputLength}))`
    ],
    { cwd: tmp, encoding: "utf8", maxBuffer: outputLength + 1024 * 1024 }
  );

  assert.equal(result.status, 0, result.stderr);
  const transcript = JSON.parse(
    fs.readFileSync(path.join(tmp, "commands", "CMD-FALLBACK-LONG-CLEAN.json"), "utf8")
  ).commands[0];
  assert.equal(transcript.truncated, true);
  assert.equal(transcript.secret_blocked, undefined);
  assert.equal(
    transcript.stdout_hash,
    crypto.createHash("sha256").update("z".repeat(outputLength)).digest("hex"),
    "the fallback digest still covers clean output beyond the retained raw cap"
  );
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

// R4.5: redact BEFORE the final 1200-char bound. A secret straddling/following
// the boundary must be removed, NOT cut into an unredacted prefix. With the old
// slice-then-redact ordering the AKIA literal's first chars survived past 1200.
test("review-surfaces.PRIVACY.2 redacts a secret straddling the 1200 excerpt boundary before truncating", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-runner-straddle-"));
  // A space separates the filler from the secret so the standard word-boundary
  // anchored AWS pattern (\bAKIA...) matches as it would in real output (keys
  // appear after a space/quote/=, never glued to bulk word characters). The
  // secret still STRADDLES the 1200-char excerpt boundary, so this exercises the
  // redact-BEFORE-truncate ordering: the full raw stream is redacted, then bounded.
  const filler = "x".repeat(1195);
  const secret = "AKIAIOSFODNN7EXAMPLE"; // 20-char AWS access key id, blocked:true
  const result = await recordCommandTranscript({
    cwd: tmp,
    args: [process.execPath, "-e", `process.stdout.write('${filler} ${secret}')`],
    id: "CMD-RUN-STRADDLE",
    streamOutput: false,
    now: sequenceNow("2026-05-28T12:00:00.000Z", "2026-05-28T12:00:00.001Z")
  });

  const excerpt = result.transcript.stdout_excerpt ?? "";
  assert.ok(excerpt.length <= 1200, "excerpt is still bounded after redaction");
  assert.ok(!excerpt.includes("AKIA"), "no unredacted AKIA prefix leaks past the boundary");
  assert.ok(!excerpt.includes(secret), "the raw secret literal is absent");
  assert.equal(result.transcript.truncated, true);
});

// R4.5: compiled TypeScript and the no-dist bin shim consume the same packaged
// CommonJS runtime. Pin its exported sources and behavior through both entry
// points so the build cannot silently ship a stale copy.
test("review-surfaces.PRIVACY.2 shared bin privacy runtime matches the TypeScript wrapper", () => {
  const runtimePath = path.join(process.cwd(), "bin", "privacy-runtime.js");
  const runtime = require(runtimePath) as { SECRET_PATTERN_SOURCES: string[] };
  assert.deepEqual(runtime.SECRET_PATTERN_SOURCES, SECRET_PATTERN_SOURCES);
  // Runtime redaction stays byte-identical through the typed wrapper over a
  // battery covering every kind, repeated matches, and ordering behavior.
  const binRedact = loadBinRedact();
  const battery = [
    "-----BEGIN PRIVATE KEY-----\nMIIabcDEF0123\n-----END PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIabcDEF0123",
    "aws_key=AKIAIOSFODNN7EXAMPLE",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "auth ghp_0123456789012345678901234567890123456",
    "pat github_pat_0123456789012345678901_abcDEFghij",
    "slack xoxb-0123456789-abcdefghijkl",
    "openai sk-proj-01234567890123456789",
    "openai sk-01234567890123456789",
    "stripe sk_live_01234567890123456789",
    "google ya29.01234567890123456789",
    "jwt eyJhbGciOi.eyJzdWIiLCJ.SflKxwRJSMeKKF",
    "google AIzaSyA01234567890123456789012",
    "MY_TOKEN=supersecretvalue123",
    "AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLE",
    "the quick brown fox jumps"
  ];
  for (const input of battery) {
    assert.equal(
      binRedact(input),
      redactSecrets(input).text,
      `bin redact() diverges from redactSecrets() for: ${JSON.stringify(input)}`
    );
  }
});
