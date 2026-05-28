import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMethodology } from "../src/methodology/methodology";
import { CollectionResult } from "../src/collector/collect";

test("methodology marks missing conversation as not_provided", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const methodology = await buildMethodology(tmp, collectionFixture(tmp), undefined, []);

  assert.equal(methodology.missing_logs, true);
  assert.match(methodology.summary, /not_provided/);
});

test("methodology normalizes markdown conversation logs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const logPath = path.join(tmp, "conversation.md");
  fs.writeFileSync(logPath, "Considered agent-file enrichment\nDecision: keep deterministic core\nSkipped AI smoke test\n");

  const methodology = await buildMethodology(
    tmp,
    collectionFixture(tmp),
    "conversation.md",
    ["pnpm run test"]
  );

  assert.equal(methodology.missing_logs, false);
  assert.ok(methodology.considered.length > 0);
  assert.ok(methodology.decisions.length > 0);
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "inputs", "conversation.normalized.jsonl")));
});

test("review-surfaces.METHODOLOGY.2 separates transcript-backed claims from unverified test claims", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const logPath = path.join(tmp, "conversation.md");
  fs.writeFileSync(
    logPath,
    [
      "assistant: pnpm run test passed after the implementation.",
      "assistant: tests are green for the workflow.",
      "assistant: Decision: keep local artifacts first."
    ].join("\n")
  );

  const methodology = await buildMethodology(
    tmp,
    collectionFixture(tmp, {
      commandTranscripts: [
        {
          id: "CMD-PNPM-TEST",
          command: "pnpm run test",
          status: "passed",
          exit_code: 0,
          stdout_hash: "abc123",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-PNPM-TEST.json"
        }
      ]
    }),
    "conversation.md",
    []
  );

  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm run test passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("tests are green")));
  assert.ok(methodology.quality_flags.includes("test_claims_verified_by_command_transcripts"));
  assert.ok(methodology.quality_flags.includes("test_claims_without_command_evidence"));
  assert.ok(methodology.evidence.some((evidence) => evidence.kind === "command" && evidence.event_id === "CMD-PNPM-TEST"));
});

function collectionFixture(tmp: string, overrides: Partial<CollectionResult> = {}): CollectionResult {
  return {
    cwd: tmp,
    outputDir: path.join(tmp, ".review-surfaces"),
    manifest: {
      tool_version: "0.1.0",
      created_at: "2026-05-28T00:00:00.000Z",
      repo: "fixture",
      base_ref: "HEAD",
      head_ref: "HEAD",
      head_sha: "abc",
      run_mode: "local",
      input_hashes: []
    },
    specIndex: { schema_version: "review-surfaces.specs.index.v1", specs: [] },
    changedFiles: [],
    docs: [],
    tests: [],
    feedback: [],
    commandTranscripts: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    repositoryFiles: [],
    privacy: {
      ignore_file: ".review-surfacesignore",
      ignore_patterns: [],
      ignored_changed_files: [],
      diff_redactions: [],
      remote_provider_blocked: false
    },
    git: {
      repo: "fixture",
      base_ref: "HEAD",
      head_ref: "HEAD",
      head_sha: "abc"
    },
    ...overrides
  } as CollectionResult;
}
