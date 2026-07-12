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
      "assistant: lint fails on Windows.",
      "assistant: tests succeed on Linux.",
      "assistant: the build succeeds locally.",
      "assistant: tests are succeeding now.",
      "assistant: manually tested the CLI.",
      "assistant: the tests should pass after this change.",
      "assistant: the tests should now be passing after this change.",
      "assistant: lint is expected to be green.",
      "assistant: I expected tests to pass.",
      "assistant: It was expected that tests pass.",
      "assistant: I expected, after the refactor, tests to pass.",
      "assistant: Tests should, in theory, pass.",
      "assistant: The CLI should be manually tested.",
      "assistant: Tests should be tested.",
      "assistant: Validation should be a success.",
      "assistant: tests are not succeeding.",
      "assistant: tests aren't passing.",
      "assistant: tests aren’t passing.",
      "assistant: tests haven't passed.",
      "assistant: tests have not consistently passed.",
      "assistant: tests no longer reliably pass.",
      "assistant: tests are not always passing.",
      "assistant: tests are not quite passing.",
      "assistant: tests did not fail.",
      "assistant: tests didn't fail.",
      "assistant: tests didn’t fail.",
      "assistant: tests aren't failing.",
      "assistant: Old tests didn't pass, but new tests passed.",
      "assistant: Old tests never failed, but new tests failed.",
      "assistant: Tests did not pass. After the fix tests passed.",
      "assistant: Tests did not, despite retries, pass.",
      "assistant: Tests were not, in fact, passing.",
      "assistant: Tests did not (despite retries) pass.",
      "assistant: Tests did not — despite retries — pass.",
      "assistant: No tests passed.",
      "assistant: Zero tests passed.",
      "assistant: None of the tests passed.",
      "assistant: No integration tests passed.",
      "assistant: None of the integration tests passed.",
      "assistant: Tests completed without any errors.",
      "assistant: Tests had no lint errors.",
      "assistant: Tests had no typecheck errors.",
      "assistant: Tests did not error or fail.",
      "assistant: Tests did not pass or succeed.",
      "assistant: Tests should pass, but did not pass.",
      "assistant: Tests might fail, but did not fail.",
      "assistant: Tests did not run because lint checks passed.",
      "assistant: Tests did not run because lint failed.",
      "assistant: None of the slow integration test cases passed.",
      "assistant: No doubt tests passed.",
      "assistant: There is no question tests passed.",
      "assistant: Tests: none passed.",
      "assistant: There is no chance tests passed.",
      "assistant: There is no chance tests errored.",
      "assistant: Tests are not so reliably passing.",
      "assistant: The build is not so green.",
      "assistant: Tests did not pass, or succeed.",
      "assistant: Neither tests passed nor checks passed.",
      "assistant: Neither lint nor tests passed.",
      "assistant: Tests did not pass initially then passed.",
      "assistant: Tests had no errors.",
      "assistant: Tests completed with zero errors.",
      "assistant: Tests passed without errors.",
      "assistant: The old build would fail, but the new build passed.",
      "assistant: The old build would fail and the new build passed.",
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
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("lint fails on Windows")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("tests succeed on Linux")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("build succeeds locally")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("tests are succeeding now")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("manually tested the CLI")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("should pass")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("should now be passing")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("expected to be green")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("I expected tests to pass")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("expected that tests pass")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("expected, after the refactor")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("should, in theory")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("should be manually tested")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("Tests should be tested")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("should be a success")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("not succeeding")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("aren't passing")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("aren’t passing")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("haven't passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("not consistently passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("no longer reliably pass")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("not always passing")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("not quite passing")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("did not fail")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("didn't fail")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("didn’t fail")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("aren't failing")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("new tests passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("new tests failed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("After the fix tests passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("despite retries")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("in fact")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("(despite retries)")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("— despite retries —")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("No tests passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("Zero tests passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("None of the tests passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("No integration tests passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("None of the integration tests passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("without any errors")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("no lint errors")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("no typecheck errors")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("did not error or fail")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("did not pass or succeed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("should pass, but did not pass")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("might fail, but did not fail")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("because lint checks passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("because lint failed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("slow integration test cases passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("No doubt tests passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("no question tests passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("none passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("no chance tests passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("no chance tests errored")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("not so reliably passing")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("not so green")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("did not pass, or succeed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("Neither tests passed nor checks passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("Neither lint nor tests passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("initially then passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("had no errors")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("zero errors")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("passed without errors")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("old build would fail, but the new build passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("old build would fail and the new build passed")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("add tests for this gap")));
  assert.ok(!methodology.claims_without_evidence.some((claim) => claim.includes("coverage is missing")));
  assert.ok(methodology.quality_flags.includes("test_claims_verified_by_command_transcripts"));
  assert.ok(methodology.quality_flags.includes("test_claims_without_command_evidence"));
  assert.ok(methodology.evidence.some((evidence) => evidence.kind === "command" && evidence.event_id === "CMD-PNPM-TEST"));
});

test("review-surfaces.REVIEWER_VALUE.1 evidence matching uses the full claim before persistence bounding", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const methodology = await buildMethodology(
    tmp,
    collectionFixture(tmp, {
      conversationEvents: [{
        id: "late-command",
        actor: "assistant",
        kind: "message",
        summary: `Validation passed after detailed analysis. ${"context ".repeat(300)} pnpm run test passed.`,
        raw_index: 0
      }],
      commandTranscripts: [{
        id: "CMD-PNPM-TEST",
        command: "pnpm run test",
        status: "passed",
        exit_code: 0,
        stdout_hash: "abc123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-PNPM-TEST.json"
      }]
    }),
    undefined,
    []
  );

  assert.equal(methodology.claims_without_evidence.length, 0);
  assert.equal(methodology.verified_claims.length, 1);
  assert.ok(methodology.verified_claims[0].startsWith("late-command:"));
  assert.match(methodology.verified_claims[0], /command transcript: CMD-PNPM-TEST/);
  assert.ok(methodology.verified_claims[0].length <= 1200);
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
      "assistant: pnpm run lint && pnpm run test passed after the implementation.",
      "assistant: pnpm run lint passed and pnpm run test passed.",
      "assistant: pnpm run lint failed and pnpm run test passed.",
      "assistant: pnpm run lint passed and pnpm run test:coverage passed.",
      "assistant: pnpm run lint passed, npm run smoke passed.",
      "assistant: pnpm run lint passed and also npm run smoke passed.",
      "assistant: pnpm test --grep old failed in CI passed",
      "assistant: Tests should pass, but pnpm run test failed.",
      "assistant: Tests might fail, but pnpm run test passed.",
      "assistant: Today's pnpm run test passed.",
      "assistant: I couldn't run this earlier; pnpm run test passed.",
      "assistant: pnpm run lint failed; it didn't block pnpm run test passed.",
      "assistant: On Node 22, pnpm run test passed."
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
          id: "CMD-PNPM-TEST-FAILED",
          command: "pnpm run test",
          status: "failed",
          exit_code: 1,
          stderr_hash: "failed123",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-PNPM-TEST-FAILED.json"
        },
        {
          id: "CMD-PNPM-LINT",
          command: "pnpm run lint",
          status: "passed",
          exit_code: 0,
          stdout_hash: "lint123",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-PNPM-LINT.json"
        },
        ...Array.from({ length: 4 }, (_value, index) => ({
          id: `CMD-PNPM-LINT-${index + 2}`,
          command: "pnpm run lint",
          status: "passed" as const,
          exit_code: 0,
          stdout_hash: `lint${index + 2}`,
          truncated: false,
          source_path: `.review-surfaces/commands/CMD-PNPM-LINT-${index + 2}.json`
        })),
        {
          id: "CMD-PNPM-LINT-FAILED",
          command: "pnpm run lint",
          status: "failed",
          exit_code: 1,
          stderr_hash: "lintfailed123",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-PNPM-LINT-FAILED.json"
        },
        {
          id: "CMD-PNPM-GREP-OLD",
          command: "pnpm test --grep old",
          status: "passed",
          exit_code: 0,
          stdout_hash: "old123",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-PNPM-GREP-OLD.json"
        },
        {
          id: "CMD-PNPM-COVERAGE-FAILED",
          command: "pnpm run test:coverage",
          status: "failed",
          exit_code: 1,
          stderr_hash: "coveragefailed123",
          truncated: false,
          source_path: ".review-surfaces/commands/CMD-PNPM-COVERAGE-FAILED.json"
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
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm run test failed after the implementation")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("test:coverage")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("npm run test passed") && !claim.includes("pnpm run")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("pnpm run lint and pnpm run test passed")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("pnpm run lint, pnpm run test passed")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("pnpm run lint && pnpm run test passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm run lint passed and pnpm run test passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm run lint failed and pnpm run test passed")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("pnpm run lint passed and pnpm run test:coverage passed")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("pnpm run lint passed, npm run smoke passed")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("pnpm run lint passed and also npm run smoke passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("Tests should pass, but pnpm run test failed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("Tests might fail, but pnpm run test passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("Today's pnpm run test passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("couldn't run this earlier; pnpm run test passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm run lint failed; it didn't block pnpm run test passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("On Node 22, pnpm run test passed")));
  assert.ok(!methodology.verified_claims.some((claim) => claim.includes("pnpm test --grep old failed in CI passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run test:coverage passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("npm run test passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run lint and pnpm run test passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run lint, pnpm run test passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run lint && pnpm run test passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm test --grep old failed in CI passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run lint passed and pnpm run test:coverage passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run lint passed, npm run smoke passed")));
  assert.ok(methodology.claims_without_evidence.some((claim) => claim.includes("pnpm run lint passed and also npm run smoke passed")));
});

test("review-surfaces.METHODOLOGY.2 preserves command arguments and strips result narratives", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const logPath = path.join(tmp, "conversation.md");
  fs.writeFileSync(logPath, [
    "assistant: pnpm test --filter success passed",
    "assistant: pnpm test passed with 20 tests",
    "assistant: pnpm test passed in 2s",
    "assistant: pnpm test passed without failures",
    "assistant: pnpm test passed successfully",
    "assistant: pnpm test --grep runs in CI passed",
    "assistant: pnpm test --filter with passed",
    "assistant: pnpm test --grep without cache passed",
    "assistant: npm run tested",
    "assistant: npm run tested passed",
    "assistant: npm run tested.",
    "assistant: pnpm run validated!",
    "assistant: pnpm test --grep failed in CI passed",
    "assistant: pnpm test --grep passing without cache passed",
    "assistant: pnpm test --grep \"failed in CI\" passed",
    "assistant: pnpm test --grep \"node works\" passed",
    "assistant: node --test tests/node.test.js passed",
    "assistant: pnpm test packages/node/foo.test.js passed",
    "assistant: `pnpm test --grep node` passed",
    "assistant: pnpm test passed on Node 22",
    "assistant: pnpm test passed under npm 10",
    "assistant: pnpm test passed, on Node 22",
    "assistant: pnpm test passed; Node 22 was used",
    "assistant: pnpm test passed on Node and npm 10",
    "assistant: pnpm test --grep old failed in CI passed",
    "assistant: pnpm test --test-name-pattern old passing without cache passed",
    "assistant: pnpm test passed with no errors",
    "assistant: pnpm test passed with zero errors",
    "assistant: pnpm test failed with 2 errors",
    "assistant: pnpm test passed with all checks passing"
  ].join("\n"));

  const methodology = await buildMethodology(
    tmp,
    collectionFixture(tmp, {
      commandTranscripts: [{
        id: "CMD-FILTER-SUCCESS",
        command: "pnpm test --filter success",
        status: "passed",
        exit_code: 0,
        stdout_hash: "abc123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-FILTER-SUCCESS.json"
      }, {
        id: "CMD-PNPM-TEST",
        command: "pnpm test",
        status: "passed",
        exit_code: 0,
        stdout_hash: "def456",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-PNPM-TEST.json"
      }, {
        id: "CMD-GREP-CI",
        command: "pnpm test --grep runs in CI",
        status: "passed",
        exit_code: 0,
        stdout_hash: "ghi789",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-GREP-CI.json"
      }, {
        id: "CMD-PNPM-TEST-FAILED",
        command: "pnpm test",
        status: "failed",
        exit_code: 1,
        stdout_hash: "failed123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-PNPM-TEST-FAILED.json"
      }, {
        id: "CMD-FILTER-WITH",
        command: "pnpm test --filter with",
        status: "passed",
        exit_code: 0,
        stdout_hash: "jkl012",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-FILTER-WITH.json"
      }, {
        id: "CMD-GREP-WITHOUT",
        command: "pnpm test --grep without cache",
        status: "passed",
        exit_code: 0,
        stdout_hash: "mno345",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-GREP-WITHOUT.json"
      }, {
        id: "CMD-NPM-TESTED",
        command: "npm run tested",
        status: "passed",
        exit_code: 0,
        stdout_hash: "pqr678",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-NPM-TESTED.json"
      }, {
        id: "CMD-PNPM-VALIDATED",
        command: "pnpm run validated",
        status: "passed",
        exit_code: 0,
        stdout_hash: "stu901",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-PNPM-VALIDATED.json"
      }, {
        id: "CMD-GREP-FAILED-CI",
        command: "pnpm test --grep failed in CI",
        status: "passed",
        exit_code: 0,
        stdout_hash: "vwx234",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-GREP-FAILED-CI.json"
      }, {
        id: "CMD-GREP-PASSING-CACHE",
        command: "pnpm test --grep passing without cache",
        status: "passed",
        exit_code: 0,
        stdout_hash: "yz5678",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-GREP-PASSING-CACHE.json"
      }, {
        id: "CMD-GREP-QUOTED-FAILED-CI",
        command: "pnpm test --grep \"failed in CI\"",
        status: "passed",
        exit_code: 0,
        stdout_hash: "quoted123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-GREP-QUOTED-FAILED-CI.json"
      }, {
        id: "CMD-GREP-QUOTED-NODE",
        command: "pnpm test --grep \"node works\"",
        status: "passed",
        exit_code: 0,
        stdout_hash: "quotednode123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-GREP-QUOTED-NODE.json"
      }, {
        id: "CMD-NODE-PATH",
        command: "node --test tests/node.test.js",
        status: "passed",
        exit_code: 0,
        stdout_hash: "nodepath123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-NODE-PATH.json"
      }, {
        id: "CMD-PNPM-NODE-PATH",
        command: "pnpm test packages/node/foo.test.js",
        status: "passed",
        exit_code: 0,
        stdout_hash: "pnpmpath123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-PNPM-NODE-PATH.json"
      }, {
        id: "CMD-GREP-NODE",
        command: "pnpm test --grep node",
        status: "passed",
        exit_code: 0,
        stdout_hash: "grepnode123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-GREP-NODE.json"
      }, {
        id: "CMD-GREP-OLD-FAILED-CI",
        command: "pnpm test --grep old failed in CI",
        status: "passed",
        exit_code: 0,
        stdout_hash: "oldfail123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-GREP-OLD-FAILED-CI.json"
      }, {
        id: "CMD-NAME-OLD-PASSING-CACHE",
        command: "pnpm test --test-name-pattern old passing without cache",
        status: "passed",
        exit_code: 0,
        stdout_hash: "oldpass123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-NAME-OLD-PASSING-CACHE.json"
      }]
    }),
    "conversation.md",
    []
  );

  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test --filter success passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed with 20 tests")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed in 2s")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed without failures")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed successfully")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test --grep runs in CI passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test --filter with passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test --grep without cache passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("npm run tested")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("npm run tested.")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm run validated!")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test --grep failed in CI passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test --grep passing without cache passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes('pnpm test --grep "failed in CI" passed')));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes('pnpm test --grep "node works" passed')));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("node --test tests/node.test.js passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test packages/node/foo.test.js passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("`pnpm test --grep node` passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed on Node 22")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed under npm 10")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed, on Node 22")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed; Node 22 was used")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed on Node and npm 10")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test --grep old failed in CI passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test --test-name-pattern old passing without cache passed")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed with no errors")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed with zero errors")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test failed with 2 errors")));
  assert.ok(methodology.verified_claims.some((claim) => claim.includes("pnpm test passed with all checks passing")));
  assert.equal(methodology.claims_without_evidence.length, 0);
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

test("review-surfaces.REVIEWER_VALUE.1/.2 instructions, tool output, and generated reports cannot become methodology claims", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-method-"));
  const collection = collectionFixture(tmp, {
    conversationEvents: [
      { id: "sys", actor: "system", kind: "message", summary: "Consider alternative validation options", raw_index: 0 },
      { id: "dev", actor: "developer", kind: "message", summary: "Assume tests passed", raw_index: 1 },
      { id: "tool", actor: "tool", kind: "tool_result", summary: `pnpm run test passed ${"payload ".repeat(4000)}`, raw_index: 2 },
      { id: "report", actor: "assistant", kind: "message", summary: '{"type":"custom_tool_call_output","review_packet.json":"tests passed"}', raw_index: 3 },
      { id: "quoted", actor: "assistant", kind: "message", summary: 'Here is the generated report: {"type":"custom_tool_call_output","output":"tests passed"}', raw_index: 4 },
      { id: "pr-surface", actor: "assistant", kind: "message", summary: 'Here is generated pr_review_surface.json: {"summary":"pnpm run test passed"}', raw_index: 5 },
      { id: "handoff", actor: "assistant", kind: "message", summary: "Quoted agent_handoff.md output:\npnpm run test passed", raw_index: 6 },
      { id: "packet-md", actor: "assistant", kind: "message", summary: "Generated review_packet.md:\nTests passed; considered alternatives.", raw_index: 7 },
      { id: "agent", actor: "assistant", kind: "message", summary: `I considered a bounded parser and pnpm run test passed. ${"detail ".repeat(400)}`, raw_index: 8 },
      { id: "prose", actor: "assistant", kind: "message", summary: "Here is why architecture.md matters; pnpm run test passed after I considered the compatibility tradeoff.", raw_index: 9 },
      { id: "user", actor: "user", kind: "message", summary: "I assume the compatibility requirement still applies.", raw_index: 10 },
      { id: "scaffold", actor: "user", kind: "message", summary: "Consider alternatives and assume tests passed. <environment_context><cwd>/repo</cwd></environment_context> # AGENTS.md instructions", raw_index: 11 },
      { id: "internal", actor: "user", kind: "message", summary: '<codex_internal_context source="goal">Research options; tests passed.</codex_internal_context>', raw_index: 12 },
      {
        id: "scaffolded-request",
        actor: "user",
        kind: "message",
        summary: "<environment_context><cwd>/repo</cwd></environment_context>\n## My request for Codex:\nI considered preserving retries and assume the current contract still applies.",
        raw_index: 13
      }
    ]
  });

  const methodology = await buildMethodology(tmp, collection, undefined, []);

  assert.ok(methodology.considered.some((entry) => entry.startsWith("agent:")));
  const scaffoldedRequest = methodology.considered.find((entry) => entry.startsWith("scaffolded-request:"));
  assert.ok(scaffoldedRequest, "the request after generated scaffolding remains reviewer evidence");
  assert.ok(!scaffoldedRequest.includes("environment_context"), "generated scaffolding is stripped before persistence");
  assert.ok(methodology.unchallenged_assumptions.some((entry) => entry.startsWith("user:")));
  assert.ok(methodology.unchallenged_assumptions.some((entry) => entry.startsWith("scaffolded-request:")));
  for (const id of ["sys:", "dev:", "tool:", "report:", "quoted:", "pr-surface:", "handoff:", "packet-md:", "scaffold:", "internal:"]) {
    assert.ok(!methodology.considered.some((entry) => entry.startsWith(id)));
    assert.ok(!methodology.unchallenged_assumptions.some((entry) => entry.startsWith(id)));
    assert.ok(!methodology.claims_without_evidence.some((entry) => entry.startsWith(id)), `${id} leaked into validation claims`);
  }
  assert.equal(methodology.claims_without_evidence.length, 2);
  assert.ok(methodology.claims_without_evidence[0].startsWith("agent:"));
  assert.ok(methodology.claims_without_evidence.some((entry) => entry.startsWith("prose:")));
  assert.ok(methodology.claims_without_evidence[0].length <= 1200);
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
