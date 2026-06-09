import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { indexCommandTranscriptFiles, indexCommandTranscripts } from "../src/commands/transcripts";
import { recordCommandTranscript } from "../src/commands/runner";
import { SECRET_PATTERN_SOURCES, redactSecrets } from "../src/privacy/secrets";

// Extract bin/review-surfaces.js's standalone redact() so we can compare its
// ACTUAL output to redactSecrets() — bin is the no-dist `run` fallback and
// cannot require dist, so it carries a hand-mirrored copy of the patterns.
function loadBinRedact(): (value: string | undefined) => string | undefined {
  const binSource = fs.readFileSync(path.join(process.cwd(), "bin", "review-surfaces.js"), "utf8");
  const match = binSource.match(/function redact\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match, "could not extract redact() from bin/review-surfaces.js");
  // eslint-disable-next-line no-new-func
  return new Function(`return (${match[0]});`)() as (value: string | undefined) => string | undefined;
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

// R4.5: bin/review-surfaces.js carries a CJS duplicate of the secret patterns
// (it is the no-dist `run` fallback and cannot require dist). Pin it to the
// canonical SECRET_PATTERN_SOURCES so a pattern added to secrets.ts but forgotten
// in bin fails this test loudly. Only ONE such parity test should exist.
test("review-surfaces.PRIVACY.2 bin/review-surfaces.js redact() mirrors secrets.ts patterns", () => {
  const binPath = path.join(process.cwd(), "bin", "review-surfaces.js");
  const binSource = fs.readFileSync(binPath, "utf8");
  // (1) Presence guard: every canonical pattern source appears in bin, so a
  // pattern added to secrets.ts but forgotten in bin fails loudly.
  for (const source of SECRET_PATTERN_SOURCES) {
    assert.ok(
      binSource.includes(source),
      `bin/review-surfaces.js is missing the secret pattern: ${source}`
    );
  }
  // (2) BEHAVIORAL parity: bin's redact() must produce BYTE-IDENTICAL output to
  // redactSecrets().text over a battery covering every kind (incl. a repeated
  // secret to catch a dropped /g flag and an assignment to catch apply-order
  // drift). Substring presence alone would miss a flag/order/value-class change.
  const binRedact = loadBinRedact();
  const battery = [
    "-----BEGIN PRIVATE KEY-----\nMIIabcDEF0123\n-----END PRIVATE KEY-----",
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
