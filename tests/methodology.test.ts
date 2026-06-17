import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMethodology } from "../src/methodology/methodology";
import { CollectionResult } from "../src/collector/collect";

test("review-surfaces.COLLECTOR.5 marks missing conversation as not_provided", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const methodology = await buildMethodology(tmp, collectionFixture(tmp), undefined, []);

  assert.equal(methodology.missing_logs, true);
  assert.match(methodology.summary, /not_provided/);
});

test("review-surfaces.COLLECTOR.4 writes conversation.normalized.jsonl from a markdown conversation log", async () => {
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

test("review-surfaces.METHODOLOGY.7 the deterministic fallback marks the deep audit degraded and seeds an empty workflow_findings", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  fs.writeFileSync(path.join(tmp, "conversation.md"), "Considered backoff\nDecision: keep deterministic core\n");

  const methodology = await buildMethodology(tmp, collectionFixture(tmp), "conversation.md", []);

  // The deterministic builder is the FALLBACK: it flags the deep audit as not-run
  // and seeds workflow_findings: [] so the house tighter-than-schema array holds.
  assert.ok(methodology.quality_flags.includes("methodology_analysis_degraded"));
  assert.deepEqual(methodology.workflow_findings, []);
});

test("review-surfaces.METHODOLOGY.2 separates transcript-backed claims from unverified test claims", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const logPath = path.join(tmp, "conversation.md");
  fs.writeFileSync(
    logPath,
    [
      "assistant: pnpm run test passed after the implementation.",
      "assistant: tests are green for the workflow.",
      "assistant: all tests pass after the fix.",
      "assistant: failing tests are now green.",
      "assistant: manually tested the CLI.",
      "assistant: the tests should pass after this change.",
      "assistant: add tests for this gap.",
      "assistant: test coverage is missing for the workflow.",
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
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("all tests pass")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("failing tests are now green")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("manually tested the CLI")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("should pass")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("add tests for this gap")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("coverage is missing")));
  assert.ok(methodology.quality_flags.includes("test_claims_verified_by_command_transcripts"));
  assert.ok(methodology.quality_flags.includes("test_claims_without_command_evidence"));
  assert.ok(methodology.evidence.some((evidence) => evidence.kind === "command" && evidence.event_id === "CMD-PNPM-TEST"));
});

test("review-surfaces.METHODOLOGY.2 does not verify claims with failed command transcripts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const logPath = path.join(tmp, "conversation.md");
  fs.writeFileSync(logPath, "assistant: pnpm run test passed after the implementation.\n");

  const methodology = await buildMethodology(
    tmp,
    collectionFixture(tmp, {
      commandTranscripts: [
        {
          id: "CMD-PNPM-TEST",
          command: "pnpm run test",
          status: "failed",
          exit_code: 1,
          stderr_hash: "def456",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-PNPM-TEST.json"
        }
      ]
    }),
    "conversation.md",
    []
  );

  assert.equal(methodology.verified_claims.length, 0);
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run test passed")));
  assert.ok(!methodology.quality_flags.includes("test_claims_verified_by_command_transcripts"));
  assert.ok(methodology.quality_flags.includes("test_claims_without_command_evidence"));
});

test("review-surfaces.METHODOLOGY.2 verifies failed claims with failed command transcripts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const logPath = path.join(tmp, "conversation.md");
  fs.writeFileSync(logPath, "assistant: pnpm run test failed after the implementation.\n");

  const methodology = await buildMethodology(
    tmp,
    collectionFixture(tmp, {
      commandTranscripts: [
        {
          id: "CMD-PNPM-TEST",
          command: "pnpm run test",
          status: "failed",
          exit_code: 1,
          stderr_hash: "def456",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-PNPM-TEST.json"
        }
      ]
    }),
    "conversation.md",
    []
  );

  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm run test failed")));
  assert.equal(methodology.claims_without_evidence.length, 0);
  assert.ok(methodology.quality_flags.includes("test_claims_verified_by_command_transcripts"));
  assert.ok(!methodology.quality_flags.includes("test_claims_without_command_evidence"));
});

test("review-surfaces.METHODOLOGY.2 requires exact command matches for verified claims", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const logPath = path.join(tmp, "conversation.md");
  fs.writeFileSync(
    logPath,
    [
      "assistant: pnpm run test passed after the implementation.",
      "assistant: `pnpm run test` passed after the implementation.",
      "assistant: pnpm run test failed after the implementation.",
      "assistant: pnpm run test:coverage passed after the implementation.",
      "assistant: npm run test passed after the implementation.",
      "assistant: pnpm run test -- --runInBand passed after the implementation.",
      "assistant: pnpm exec vitest passed after the implementation.",
      "assistant: tsc --noEmit passed after the implementation.",
      "assistant: tsc -p tsconfig.json --noEmit passed after the implementation.",
      "assistant: node --test dist/tests/*.test.js passed after the implementation.",
      "assistant: pnpm run lint and pnpm run test passed after the implementation.",
      "assistant: pnpm run lint, pnpm run test passed after the implementation.",
      "assistant: pnpm run lint && pnpm run test passed after the implementation."
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
        },
        {
          id: "CMD-PNPM-TEST-RUNINBAND",
          command: "pnpm run test -- --runInBand",
          status: "passed",
          exit_code: 0,
          stdout_hash: "def456",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-PNPM-TEST-RUNINBAND.json"
        },
        {
          id: "CMD-PNPM-VITEST",
          command: "pnpm exec vitest",
          status: "passed",
          exit_code: 0,
          stdout_hash: "fed654",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-PNPM-VITEST.json"
        },
        {
          id: "CMD-TSC-NOEMIT",
          command: "tsc --noEmit",
          status: "passed",
          exit_code: 0,
          stdout_hash: "ace456",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-TSC-NOEMIT.json"
        },
        {
          id: "CMD-TSC-PROJECT",
          command: "tsc -p tsconfig.json --noEmit",
          status: "passed",
          exit_code: 0,
          stdout_hash: "bdf789",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-TSC-PROJECT.json"
        },
        {
          id: "CMD-NODE-TEST-GLOB",
          command: "node --test dist/tests/*.test.js",
          status: "passed",
          exit_code: 0,
          stdout_hash: "cde987",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-NODE-TEST-GLOB.json"
        }
      ]
    }),
    "conversation.md",
    []
  );

  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm run test passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("`pnpm run test` passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm run test -- --runInBand passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm exec vitest passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("tsc --noEmit passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("tsc -p tsconfig.json --noEmit passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("node --test dist/tests/*.test.js passed")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("pnpm run test failed")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("test:coverage")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("npm run test passed") && !claim.includes("pnpm run")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("pnpm run lint and pnpm run test passed")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("pnpm run lint, pnpm run test passed")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("pnpm run lint && pnpm run test passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run test:coverage passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run test failed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("npm run test passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run lint and pnpm run test passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run lint, pnpm run test passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run lint && pnpm run test passed")));
});

test("review-surfaces.METHODOLOGY.2 scans all validation claims and redacts conversation secrets", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const logPath = path.join(tmp, "conversation.md");
  fs.writeFileSync(
    logPath,
    [
      ...Array.from({ length: 12 }, (_value, index) => `assistant: validation check ${index + 1} passed.`),
      "assistant: SECRET_TOKEN=abc123456 pnpm run test passed after the implementation."
    ].join("\n")
  );

  const methodology = await buildMethodology(tmp, collectionFixture(tmp), "conversation.md", []);

  assert.equal(methodology.claims_without_evidence.length, 13);
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run test passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("abc123456")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("SECRET_TOKEN=[REDACTED:secret]")));
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
      remote_provider_blocked: false,
    secret_findings: []
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

test("review-surfaces.METHODOLOGY.4 an adapter that matched but produced zero events degrades as a missing log", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  fs.writeFileSync(path.join(tmp, "empty.json"), JSON.stringify({ messages: [] }));
  const methodology = await buildMethodology(tmp, collectionFixture(tmp), "empty.json", []);
  assert.equal(methodology.missing_logs, true);
  assert.ok(methodology.quality_flags.includes("conversation_log_missing"));
});

test("review-surfaces.METHODOLOGY.1 considered/research pick from natural-language turns only, bounded (not tool bodies)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const collection = collectionFixture(tmp, {
    conversationEvents: [
      // A tool_result whose body happens to contain the trigger words "read"/"option"
      // — it must NOT be picked (it is an embedded body, not reasoning).
      { id: "t0", actor: "tool", kind: "tool_result", summary: `Read(file): ${"x".repeat(2000)} option to read context`, raw_index: 0 },
      // A real assistant message stating a considered alternative — picked + bounded.
      { id: "m0", actor: "assistant", kind: "message", summary: `I considered ${"y".repeat(400)} as an alternative`, raw_index: 1 },
      // A normalized log's CUSTOM (loose) kind is still natural language — must be
      // picked, not whitelisted out (Codex P2).
      { id: "c0", actor: "assistant", kind: "analysis", summary: "considered streaming as an alternative", raw_index: 2 },
      // A SHORT tool_call (a bounded invocation) IS research evidence — kept (Codex P2).
      { id: "tc0", actor: "assistant", kind: "tool_call", tool: "Read", summary: "Read(docs/goal.md) for research context", raw_index: 3 },
      // A LONG tool_call body matching a keyword deep inside is noise — excluded.
      { id: "tc1", actor: "assistant", kind: "tool_call", tool: "Write", summary: `Write(${"z".repeat(2000)} considered)`, raw_index: 4 },
      // A SHORT edit/write body is STILL noise (an embedded body, not research) —
      // excluded by tool type, not just length (Codex P2).
      { id: "tc2", actor: "assistant", kind: "tool_call", tool: "Edit", summary: "Edit(src/options.ts): considered context", raw_index: 5 }
    ]
  });
  const methodology = await buildMethodology(tmp, collection, undefined, []);
  assert.ok(!methodology.considered.some((entry) => entry.startsWith("t0:")), "a tool_result body is not picked as a considered alternative");
  assert.ok(!methodology.considered.some((entry) => entry.startsWith("tc1:")), "a long tool_call body is not picked");
  assert.ok(!methodology.considered.some((entry) => entry.startsWith("tc2:")), "a SHORT edit/write body is excluded by tool type, not just length");
  const picked = methodology.considered.find((entry) => entry.startsWith("m0:"));
  assert.ok(picked, "the natural-language message is picked");
  assert.ok(picked.length <= 250 && picked.endsWith("…"), "the picked entry is bounded/truncated");
  assert.ok(methodology.considered.some((entry) => entry.startsWith("c0:")), "a custom non-tool kind is still picked (loose kinds, not a whitelist)");
  assert.ok(methodology.research.some((entry) => entry.startsWith("tc0:")), "a short tool_call (bounded invocation) is kept as research evidence");
});

test("review-surfaces.METHODOLOGY.7 the generated conversation evidence carries a real event_id (valid under the new rule)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  fs.writeFileSync(path.join(tmp, "conversation.md"), "user: add a retry\nassistant: done\n");
  const methodology = await buildMethodology(tmp, collectionFixture(tmp), "conversation.md", []);
  const conv = methodology.evidence.find((e) => e.kind === "conversation");
  assert.ok(conv);
  assert.ok(typeof conv.event_id === "string" && conv.event_id.length > 0);
});

test("review-surfaces.METHODOLOGY.7 a missing/unusable conversation also flags methodology_analysis_degraded", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const methodology = await buildMethodology(tmp, collectionFixture(tmp), undefined, []);
  assert.ok(methodology.quality_flags.includes("conversation_log_missing"));
  assert.ok(methodology.quality_flags.includes("methodology_analysis_degraded"));
});

// review-surfaces.PRIVACY.1 (Phase 5b): an AUTO-DISCOVERED session lives at an
// absolute ~/.claude home-dir path. The persisted conversation EvidenceRef must
// carry the repo-relative normalized-log anchor (collection.conversationEvidencePath),
// NEVER that absolute path — which would fail isSafeRepositoryPath and leak a
// username-bearing path into a public artifact.
test("review-surfaces.PRIVACY.1 a discovered session's evidence anchor is repo-relative, never the absolute home-dir path", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const absoluteSessionPath = "/Users/someone/.claude/projects/-repo-app/abc123.jsonl";
  const collection = collectionFixture(tmp, {
    conversationEvents: [{ id: "e0", actor: "user", kind: "message", summary: "add a retry", raw_index: 0 }],
    conversationSource: "claude-code",
    conversationEvidencePath: "inputs/conversation.normalized.jsonl"
  });
  // buildMethodology is called with the absolute discovered path (as collect would
  // pass it), but the persisted evidence must use the safe anchor instead.
  const methodology = await buildMethodology(tmp, collection, absoluteSessionPath, []);
  const conv = methodology.evidence.find((e) => e.kind === "conversation");
  assert.ok(conv);
  assert.equal(conv.path, "inputs/conversation.normalized.jsonl", "the evidence anchor is the repo-relative normalized log");
  assert.ok(!String(conv.path).includes(".claude"), "the absolute home-dir session path must not appear in persisted evidence");
});
