import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CollectionResult } from "../src/collector/collect";
import { indexCommandTranscripts } from "../src/commands/transcripts";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { createReviewAreaMatcher } from "../src/review-areas/areas";
import { analyzeRisks } from "../src/risks/risks";
import { defaultReviewSurfacesAreas } from "./helpers/review-areas";
import { openAiProjectKeyFixture } from "./helpers/secret-fixtures";

test("review-surfaces.COLLECTOR.7 indexes bounded local command transcripts without preserving raw output", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-commands-"));
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "commands"), { recursive: true });
  const stdout = "x".repeat(1500);
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "commands", "local.json"),
    JSON.stringify({
      schema_version: "review-surfaces.command_transcripts.v1",
      commands: [
        {
          id: "CMD-TEST",
          command: "pnpm run test",
          exit_code: 0,
          duration_ms: 550,
          stdout
        }
      ]
    })
  );

  const transcripts = await indexCommandTranscripts(tmp, [".review-surfaces/commands/local.json"]);

  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].id, "CMD-TEST");
  assert.equal(transcripts[0].status, "passed");
  assert.equal(transcripts[0].stdout_excerpt?.length, 1200);
  assert.equal(transcripts[0].truncated, true);
  assert.match(transcripts[0].stdout_hash ?? "", /^[a-f0-9]{64}$/);
  assert.notEqual(transcripts[0].stdout_excerpt, stdout);
});

test("review-surfaces.PRIVACY.2 redacts command transcript command and excerpt text", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-command-redact-"));
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "commands", "local.json"),
    JSON.stringify({
      commands: [
        {
          command: "GOOGLE_GENERATIVE_AI_API_KEY=AIzaSyFakeSecretForTestingOnly000000 pnpm run test",
          exit_code: 0,
          stdout: "TOKEN=supersecretvalue npm output"
        }
      ]
    })
  );

  const transcripts = await indexCommandTranscripts(tmp, [".review-surfaces/commands/local.json"]);

  assert.doesNotMatch(transcripts[0].command, /AIzaSyFakeSecretForTestingOnly/);
  assert.doesNotMatch(transcripts[0].stdout_excerpt ?? "", /supersecretvalue/);
  // The command's AIza value is a Google API key (precise kind); the stdout's
  // bare TOKEN=value is a generic assignment (token_assignment catch-all).
  assert.match(transcripts[0].command, /\[REDACTED:google_api_key\]/);
  assert.match(transcripts[0].stdout_excerpt ?? "", /\[REDACTED:secret\]/);
  assert.equal(transcripts[0].secret_blocked, true);
});

test("review-surfaces.PRIVACY.2 preserves the block signal from an already-redacted command marker", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-command-block-marker-"));
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "commands", "local.json"),
    JSON.stringify({
      commands: [{ command: "OPENAI_API_KEY=[REDACTED:openai_key] pnpm test", exit_code: 0 }]
    })
  );

  const transcripts = await indexCommandTranscripts(tmp, [".review-surfaces/commands/local.json"]);

  assert.equal(transcripts[0].secret_blocked, true);
});

test("review-surfaces.COLLECTOR.7 omits oversized raw transcript output unless a bounded excerpt is supplied", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-command-large-"));
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "commands", "local.json"),
    JSON.stringify({
      commands: [
        { command: "pnpm run test", exit_code: 0, stdout: "x".repeat(20_001) },
        {
          command: "pnpm run test",
          exit_code: 0,
          stdout: "x".repeat(20_001),
          stdout_excerpt: "bounded test output",
          stdout_hash: "provided-hash"
        }
      ]
    })
  );

  const transcripts = await indexCommandTranscripts(tmp, [".review-surfaces/commands/local.json"]);

  assert.match(transcripts[0].stdout_excerpt ?? "", /omitted:stdout exceeded/);
  assert.equal(transcripts[0].stdout_hash, undefined);
  assert.equal(transcripts[0].truncated, true);
  assert.equal(transcripts[1].stdout_excerpt, "bounded test output");
  assert.equal(transcripts[1].stdout_hash, "provided-hash");
  assert.equal(transcripts[1].truncated, true);
});

test("review-surfaces.PRIVACY.2 an imported oversized transcript scans the full raw output for blocked secrets", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-command-late-secret-"));
  const secret = openAiProjectKeyFixture();
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "commands", "local.json"),
    JSON.stringify({
      commands: [{
        command: "pnpm test",
        exit_code: 0,
        stdout: `${"x".repeat(20_001)} ${secret}`
      }]
    })
  );

  const transcripts = await indexCommandTranscripts(tmp, [".review-surfaces/commands/local.json"]);

  assert.equal(transcripts[0].secret_blocked, true);
  assert.doesNotMatch(transcripts[0].stdout_excerpt ?? "", /sk-proj-/);
});

test("review-surfaces.RISK.2 treats successful command transcripts as direct or indirect evidence", () => {
  const collection = {
    changedFiles: [],
    feedback: [],
    commandTranscripts: [
      {
        id: "CMD-001",
        command: "pnpm run test",
        status: "passed",
        exit_code: 0,
        head_sha: "abc123",
        truncated: false,
        source_path: ".review-surfaces/commands/local.json"
      },
      {
        id: "CMD-002",
        command: "pnpm run build",
        status: "passed",
        exit_code: 0,
        truncated: false,
        source_path: ".review-surfaces/commands/local.json"
      },
      {
        id: "CMD-004",
        command: "echo test",
        status: "passed",
        exit_code: 0,
        truncated: false,
        source_path: ".review-surfaces/commands/local.json"
      },
      {
        id: "CMD-005",
        command: "pnpm run test",
        status: "failed",
        exit_code: 0,
        truncated: false,
        source_path: ".review-surfaces/commands/local.json"
      },
      {
        id: "CMD-003",
        command: "pnpm run lint",
        status: "failed",
        exit_code: 1,
        truncated: false,
        source_path: ".review-surfaces/commands/local.json"
      },
      {
        id: "CMD-006",
        command: "./scripts/full-check.sh",
        status: "passed",
        exit_code: 0,
        head_sha: "abc123",
        truncated: false,
        source_path: ".review-surfaces/commands/local.json"
      }
    ],
    commandRules: [{ id: "full-check", match: "exact", command: "./scripts/full-check.sh", classification: "broad_test" }]
  } as unknown as CollectionResult;
  const evaluation: EvaluationModel = {
    summary: "no results",
    results: [],
    overreach: [],
    acai_coverage: {}
  };

  const risks = analyzeRisks(collection, evaluation, []);

  assert.equal(risks.test_evidence[0].kind, "direct");
  assert.equal(risks.test_evidence[1].kind, "indirect");
  assert.equal(risks.test_evidence[2].kind, "indirect");
  assert.equal(risks.test_evidence[3].kind, "missing");
  assert.equal(risks.test_evidence[4].kind, "missing");
  assert.equal(risks.test_evidence[5].kind, "direct");
  assert.equal(risks.test_evidence[0].evidence?.[0].path, ".review-surfaces/inputs/commands.json");
  assert.equal(risks.test_evidence[0].evidence?.[0].sha, "abc123");
});

test("review-surfaces.RISK.2 uses the actual commands.json path for custom output dirs and suppresses duplicate claims", () => {
  const collection = {
    outputDir: "/tmp/review-output",
    changedFiles: [],
    feedback: [
      {
        path: ".review-surfaces/feedback/manual.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "codex",
        findings: [],
        validation: {
          passed: ["pnpm run test"],
          failed: [],
          notes: []
        }
      }
    ],
    commandTranscriptOutputPath: "custom-out/inputs/commands.json",
    commandTranscripts: [
      {
        id: "CMD-001",
        command: "pnpm run test",
        status: "passed",
        exit_code: 0,
        truncated: false,
        source_path: ".review-surfaces/commands/local.json"
      }
    ]
  } as unknown as CollectionResult;
  const evaluation: EvaluationModel = {
    summary: "no results",
    results: [],
    overreach: [],
    acai_coverage: {}
  };

  const risks = analyzeRisks(collection, evaluation, ["pnpm run test"]);

  assert.equal(risks.test_evidence.length, 1);
  assert.equal(risks.test_evidence[0].kind, "direct");
  assert.equal(risks.test_evidence[0].evidence?.[0].path, "custom-out/inputs/commands.json");
});

test("review-surfaces.RISK.2 only records untranscripted validation-like commands as claimed test evidence", () => {
  const collection = {
    changedFiles: [],
    feedback: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    commandTranscripts: []
  } as unknown as CollectionResult;
  const evaluation: EvaluationModel = {
    summary: "no results",
    results: [],
    overreach: [],
    acai_coverage: {}
  };

  const risks = analyzeRisks(collection, evaluation, [
    "review-surfaces all --review-scope pr --provider mock --dogfood --out .review-surfaces",
    "pnpm run test:fast",
    "pnpm run build:fast"
  ]);

  assert.equal(risks.test_evidence.length, 2);
  assert.deepEqual(
    risks.test_evidence.map((item) => item.summary),
    [
      "Command invoked by this run context: pnpm run test:fast",
      "Command invoked by this run context: pnpm run build:fast"
    ]
  );
  assert.ok(
    !risks.test_evidence.some((item) => item.summary.includes("review-surfaces all")),
    "artifact-generation commands are methodology/provenance, not claimed test evidence"
  );
});

test("review-surfaces.METHODOLOGY.5 feeds unverified methodology claims into risk focus", () => {
  const collection = {
    changedFiles: [],
    feedback: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    commandTranscripts: []
  } as unknown as CollectionResult;
  const evaluation: EvaluationModel = {
    summary: "no results",
    results: [],
    overreach: [],
    acai_coverage: {}
  };
  const methodology = {
    summary: "methodology fixture",
    missing_logs: false,
    considered: [],
    research: [],
    decisions: [],
    unchallenged_assumptions: [],
    skipped_checks: [],
    claims_without_evidence: ["evt_0001: tests are green"],
    verified_claims: [],
    workflow_findings: [],
    quality_flags: ["test_claims_without_command_evidence"],
    evidence: []
  };

  const risks = analyzeRisks(collection, evaluation, [], methodology);

  assert.ok(risks.items.some((risk) => risk.summary.includes("methodology claim")));
  assert.ok(risks.review_focus.some((focus) => focus.includes("methodology claims without command evidence")));
});

test("source contract edits map to the bootstrap Acai review area", async () => {
  const areas = await defaultReviewSurfacesAreas();
  const matcher = createReviewAreaMatcher(areas);
  assert.ok(matcher.groupsForPath(".gitignore", { purpose: "review_surface" }).includes("BOOTSTRAP"));
  assert.ok(matcher.groupsForPath("features/review-surfaces.feature.yaml", { purpose: "review_surface" }).includes("BOOTSTRAP"));
  assert.ok(matcher.groupsForPath("docs/review-surfaces-trd.md", { purpose: "review_surface" }).includes("BOOTSTRAP"));
  assert.ok(matcher.groupsForPath("types/node-ambient.d.ts", { purpose: "review_surface" }).includes("BOOTSTRAP"));
});

test("pipeline stage files map to the CLI orchestration review area", async () => {
  const areas = await defaultReviewSurfacesAreas();
  const matcher = createReviewAreaMatcher(areas);
  assert.ok(matcher.groupsForPath("src/pipeline/stages.ts", { purpose: "review_surface" }).includes("CLI"));
});

test("review-surfaces.BOOTSTRAP.6, DOGFOOD.8, and DOGFOOD.9 skill files map to review areas", async () => {
  const areas = await defaultReviewSurfacesAreas();
  const matcher = createReviewAreaMatcher(areas);
  assert.ok(matcher.groupsForPath(".agents/skills/review-surfaces-usage/SKILL.md", { purpose: "review_surface" }).includes("BOOTSTRAP"));
  assert.ok(matcher.groupsForPath(".agents/skills/review-surfaces-dogfood-loop/SKILL.md", { purpose: "review_surface" }).includes("DOGFOOD"));
  assert.ok(matcher.groupsForPath(".agents/skills/composed-review-loop/SKILL.md", { purpose: "review_surface" }).includes("DOGFOOD"));
});
