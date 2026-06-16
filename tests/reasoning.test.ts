import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CollectionResult } from "../src/collector/collect";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { IntentModel } from "../src/intent/intent";
import { MethodologyModel } from "../src/methodology/methodology";
import { RisksModel } from "../src/risks/risks";
import { agentFileProvider, ReasoningProvider, StructuredResult } from "../src/llm/provider";
import { runReasoningStages } from "../src/llm/reasoning";
import { ReviewArea } from "../src/review-areas/areas";
import { rewriteReviewPacket, ReviewPacket } from "../src/render/packet";
import { validateJsonFile } from "../src/schema/json-schema";

// A stub provider that returns canned structured output per stage. No network.
function stubProvider(byStage: Record<string, unknown>): ReasoningProvider {
  return {
    name: "ai-sdk",
    async generateStructured(stage): Promise<StructuredResult> {
      if (stage in byStage) {
        return { ok: true, data: byStage[stage] };
      }
      return { ok: false, reason: "stub_no_data_for_stage" };
    }
  };
}

// Stage A #1: the evaluation candidate-evidence call is now BATCHED. One
// generateStructured call returns a `requirements` array; each entry keys its
// candidate_evidence by acai_id and/or requirement_id. This helper builds that
// batched response shape for tests.
interface BatchedReqEntry {
  acai_id?: string;
  requirement_id?: string;
  candidate_evidence?: unknown;
  rationale?: string;
  what_would_confirm?: string;
}

function batchedEvidence(entries: BatchedReqEntry[]): Record<string, unknown> {
  return { requirements: entries };
}

function baseCollection(cwd: string, overrides: Partial<CollectionResult> = {}): CollectionResult {
  return {
    cwd,
    outputDir: path.join(cwd, ".review-surfaces"),
    manifest: {
      tool_version: "0.1.0",
      created_at: "2026-05-28T00:00:00.000Z",
      repo: "fixture",
      base_ref: "HEAD",
      head_ref: "HEAD",
      head_sha: "abc",
      uncommitted_files: 0,
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
    repoIndex: { files: [], ecosystems: [], clusters: [] },
    privacy: {
      ignore_file: ".review-surfacesignore",
      ignore_patterns: [],
      ignored_changed_files: [],
      diff_redactions: [],
      remote_provider_blocked: false,
    secret_findings: []
    },
    git: { repo: "fixture", base_ref: "HEAD", head_ref: "HEAD", head_sha: "abc" },
    ...overrides
  } as CollectionResult;
}

function missingIntent(): IntentModel {
  return {
    summary: "Built deterministic intent.",
    spec_mode: "acai",
    requirements: [
      {
        id: "REQ-001",
        acai_id: "example.EVAL.1",
        requirement: "Evaluate implementation coverage.",
        source_refs: [{ kind: "spec", ref: "features/example.feature.yaml" }],
        constraints: [],
        assumptions: [],
        open_questions: [],
        confidence: "high"
      }
    ],
    constraints: [],
    non_goals: [],
    assumptions: ["Intent was built deterministically."],
    open_questions: [],
    sources: []
  };
}

function evaluationWithStatus(status: "missing" | "partial"): EvaluationModel {
  return {
    summary: "1 requirement evaluated.",
    results: [
      {
        requirement_id: "REQ-001",
        acai_id: "example.EVAL.1",
        status,
        summary: status === "missing" ? "No implementation or test evidence was found." : "Implementation evidence exists but tests are weak.",
        evidence: [],
        missing_evidence: [],
        review_focus: "Review whether this requirement needs implementation or tests.",
        confidence: "medium"
      }
    ],
    overreach: [],
    acai_coverage: { "example.EVAL.1": status }
  };
}

function emptyMethodology(): MethodologyModel {
  return {
    summary: "methodology",
    missing_logs: true,
    considered: [],
    research: [],
    decisions: [],
    unchallenged_assumptions: [],
    skipped_checks: [],
    claims_without_evidence: [],
    verified_claims: [],
    workflow_findings: [],
    quality_flags: [],
    evidence: []
  };
}

function emptyRisks(): RisksModel {
  return {
    summary: "risks",
    items: [],
    test_evidence: [],
    test_gaps: [],
    missing_automatic_tests: [],
    missing_manual_checks: [],
    review_focus: ["Start with missing and partial requirement results."]
  };
}

test("INVARIANT: a VALID LLM candidate ref upgrades missing -> partial at most, marked LLM-proposed, never satisfied", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-valid-"));
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.ts"), "export const x = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/evaluation/evaluate.ts"],
    changedFiles: [{ path: "src/evaluation/evaluate.ts", status: "A", source: "working_tree" }]
  });
  const evaluation = evaluationWithStatus("missing");

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        candidate_evidence: [
          // FINDING D: the candidate cites the requirement's EXACT ACID in its
          // note, a deterministic tie that legitimately upgrades missing ->
          // partial (an unrelated in-pool path would not; see the dedicated test).
          { kind: "file", path: "src/evaluation/evaluate.ts", note: "implements example.EVAL.1" }
        ],
        rationale: "This file appears to implement the requirement.",
        what_would_confirm: "An exact ACID mention or a focused test."
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.equal(result.status, "partial", "valid LLM evidence deterministically tied to the requirement may upgrade at most to partial");
  assert.notEqual(result.status, "satisfied");
  const proposed = result.evidence.find((ref) => ref.llm_proposed === true);
  assert.ok(proposed, "the attached candidate evidence carries the LLM-proposed marker");
  assert.equal(proposed?.validation_status, "valid");
  assert.match(proposed?.note ?? "", /LLM-proposed:/);
  assert.ok(["low", "medium"].includes(proposed?.confidence ?? "high"), "confidence is at most medium");
});

test("INVARIANT: an INVALID LLM candidate ref is rejected and does NOT upgrade status", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-invalid-"));
  const collection = baseCollection(tmp, { repositoryFiles: [], changedFiles: [] });
  const evaluation = evaluationWithStatus("missing");

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        // nonexistent path + bad line range + would-be unknown ACID territory
        candidate_evidence: [
          { kind: "file", path: "src/does-not-exist.ts", line_start: 999, line_end: 1000, note: "fabricated" }
        ],
        rationale: "guessing"
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.equal(result.status, "missing", "invalid LLM evidence must not upgrade status");
  assert.ok(!result.evidence.some((ref) => ref.llm_proposed === true), "no invalid evidence is attached as proof");
  const surfaced = result.missing_evidence.find((ref) => ref.validation_status === "invalid");
  assert.ok(surfaced, "the invalid ref is surfaced (not silently swallowed) as invalid evidence");
});

test("INVARIANT: the LLM cannot over-claim a status; the claimed status is ignored entirely", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-overclaim-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "real.ts"), "export const real = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/real.ts"],
    changedFiles: [{ path: "src/real.ts", status: "A", source: "working_tree" }]
  });
  const evaluation = evaluationWithStatus("missing");

  // The stub tries to dictate "satisfied" and floods evidence. The schema does
  // not even allow a status field; even if it did, the deterministic layer
  // ignores any claimed status.
  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        status: "satisfied",
        // The note cites the exact ACID (a deterministic tie under FINDING D) so
        // the only allowed change (missing -> partial) can fire; the claimed
        // "satisfied" is still ignored and the flood is still capped.
        candidate_evidence: Array.from({ length: 50 }, () => ({ kind: "file", path: "src/real.ts", note: "spam example.EVAL.1" })),
        rationale: "trust me it is done",
        what_would_confirm: "nothing"
      } as BatchedReqEntry
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.notEqual(result.status, "satisfied", "claimed satisfied is ignored");
  assert.equal(result.status, "partial", "valid evidence still only reaches partial");
  // Evidence is capped (de-duplicated + bounded), not flooded.
  const proposedCount = result.evidence.filter((ref) => ref.llm_proposed === true).length;
  assert.ok(proposedCount <= 4, `proposed evidence must be bounded, got ${proposedCount}`);
});

test("INVARIANT: a partial requirement is never raised by the LLM (only missing -> partial is allowed)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-partial-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "real.ts"), "export const real = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/real.ts"],
    changedFiles: [{ path: "src/real.ts", status: "A", source: "working_tree" }]
  });
  const evaluation = evaluationWithStatus("partial");

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        candidate_evidence: [{ kind: "test", path: "src/real.ts", note: "a test, allegedly" }],
        rationale: "more evidence"
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.equal(result.status, "partial", "partial stays partial; the LLM never raises it toward satisfied");
});

test("INVARIANT: a real repo file OUTSIDE the candidate pool (changed files + tests) cannot upgrade missing -> partial", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-offpool-"));
  fs.mkdirSync(path.join(tmp, "src", "llm"), { recursive: true });
  // A real, existing repository file that is NOT a changed file and NOT a test.
  fs.writeFileSync(path.join(tmp, "src", "llm", "reasoning.ts"), "export const x = 1;\n");
  fs.mkdirSync(path.join(tmp, "src", "feature"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "feature", "changed.ts"), "export const y = 1;\n");

  const collection = baseCollection(tmp, {
    // repositoryFiles includes the unrelated file so path-existence passes, but
    // the candidate pool (changedFiles + tests) does NOT include it.
    repositoryFiles: ["src/llm/reasoning.ts", "src/feature/changed.ts"],
    changedFiles: [{ path: "src/feature/changed.ts", status: "M", source: "working_tree" }]
  });
  const evaluation = evaluationWithStatus("missing");

  // The model cites a real file that exists but is unrelated to this requirement
  // and outside the candidate pool. Path-existence alone would have upgraded it.
  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        candidate_evidence: [{ kind: "file", path: "src/llm/reasoning.ts", note: "cited an unrelated real file" }],
        rationale: "This module implements the schema-bound reasoning stages.",
        what_would_confirm: "An exact ACID mention in code or a focused test."
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.equal(result.status, "missing", "an out-of-pool real file must NOT inflate the partial count");
  assert.ok(!result.evidence.some((ref) => ref.llm_proposed === true), "out-of-pool ref is never attached as proof");
  const surfaced = result.missing_evidence.find((ref) => ref.validation_status === "invalid");
  assert.ok(surfaced, "the out-of-pool ref is surfaced as invalid, not silently swallowed");
  assert.match(surfaced?.note ?? "", /candidate pool/);
});

// FINDING D (soundness): an in-pool, valid, EXISTING changed file that is NOT
// deterministically tied to the requirement (no exact ACID in its path/name/note,
// no strict group mapping) must ATTACH as a low-confidence hypothesis but must
// NOT upgrade missing -> partial. Otherwise an agent could cite any unrelated
// changed file, drop the missing count, and help --strict skip the quality gate.
test("FINDING D: an UNRELATED in-pool changed file attaches as a hypothesis but does NOT upgrade missing -> partial", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-unrelated-pool-"));
  fs.mkdirSync(path.join(tmp, "src", "billing"), { recursive: true });
  // A real, CHANGED, in-pool file that is unrelated to the EVAL requirement: its
  // path has no EVAL token, and there are no configured/fallback areas mapping it
  // to the EVAL group.
  fs.writeFileSync(path.join(tmp, "src", "billing", "invoice.ts"), "export const invoice = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/billing/invoice.ts"],
    changedFiles: [{ path: "src/billing/invoice.ts", status: "M", source: "working_tree" }]
  });
  const evaluation = evaluationWithStatus("missing");

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        // The cited path is real and IN the candidate pool (it is a changed file),
        // but it is unrelated to example.EVAL.1: no ACID, no group mapping.
        candidate_evidence: [{ kind: "file", path: "src/billing/invoice.ts", note: "I think this helps somehow" }],
        rationale: "Speculative association with the requirement.",
        what_would_confirm: "An exact ACID mention or a focused test."
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.equal(result.status, "missing", "an unrelated in-pool citation must NOT drop the missing count");
  // The hypothesis is still ATTACHED (it is in-pool and path-valid), just not as
  // a status-changing tie.
  const attached = result.evidence.find((ref) => ref.llm_proposed === true && ref.path === "src/billing/invoice.ts");
  assert.ok(attached, "the in-pool hypothesis is still attached as low-confidence llm_proposed evidence");
  assert.equal(attached?.validation_status, "valid", "the attached hypothesis validated (it exists and is in-pool)");
});

test("FINDING D: a DETERMINISTICALLY-mapped path (exact ACID in the note) DOES upgrade missing -> partial", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-tied-acid-"));
  fs.mkdirSync(path.join(tmp, "src", "billing"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "billing", "invoice.ts"), "export const invoice = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/billing/invoice.ts"],
    changedFiles: [{ path: "src/billing/invoice.ts", status: "M", source: "working_tree" }]
  });
  const evaluation = evaluationWithStatus("missing");

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        // Same unrelated PATH as the negative test, but now the citation
        // references the requirement's EXACT ACID, a deterministic tie.
        candidate_evidence: [{ kind: "file", path: "src/billing/invoice.ts", note: "implements example.EVAL.1 behaviour" }],
        rationale: "This file implements the exact requirement.",
        what_would_confirm: "A focused test."
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.equal(result.status, "partial", "an exact-ACID-tied valid citation upgrades missing -> partial");
  assert.ok(result.evidence.some((ref) => ref.llm_proposed === true), "the tied hypothesis is attached as proof-of-hypothesis");
});

test("FINDING D: a DETERMINISTICALLY group-mapped path (strict area mapping) DOES upgrade missing -> partial", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-tied-group-"));
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.ts"), "export const x = 1;\n");

  // A fallback area derived from a cluster whose id yields the EVAL group key and
  // whose directory prefix is src/evaluation/, so the requirement_proof matcher maps
  // the cited path to EVAL (a deterministic group tie, no ACID needed).
  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/evaluation/evaluate.ts"],
    changedFiles: [{ path: "src/evaluation/evaluate.ts", status: "M", source: "working_tree" }],
    repoIndex: {
      files: [],
      ecosystems: [],
      clusters: [
        { id: "EVAL", label: "Evaluation", language: "typescript", dirs: ["src/evaluation"], files: ["src/evaluation/evaluate.ts"] }
      ]
    }
  });
  const evaluation = evaluationWithStatus("missing");

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        // No ACID in the note; the tie comes from the STRICT group mapping of the
        // cited path (src/evaluation/ -> EVAL) under the cluster-derived area.
        candidate_evidence: [{ kind: "file", path: "src/evaluation/evaluate.ts", note: "implements evaluation" }],
        rationale: "This evaluation module implements the requirement.",
        what_would_confirm: "An exact ACID mention or a focused test."
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.equal(result.status, "partial", "a strict group-mapped valid citation upgrades missing -> partial");
});

// ---------------------------------------------------------------------------
// FINDING C (round 5): in a repo with `areas:` configured, the candidate-evidence
// stage must use the SAME config-derived review areas evaluateIntent uses (threaded
// via ReasoningOptions.reviewAreas). A config-area-mapped in-pool citation (e.g.
// src/cli/* for a *.CLI.* requirement) is then recognized as a DETERMINISTIC tie
// and upgrades missing -> partial -- whereas the fallback cluster areas would map
// the same path to CLUSTER:SRC/CLI (NOT CLI), leaving it a hypothesis-only and the
// requirement missing (tripping --strict). The round-4 Finding D soundness must NOT
// be re-loosened: an UNRELATED path (no config-group mapping, no ACID) still stays
// missing even when config areas are threaded.
// ---------------------------------------------------------------------------

// Intent + evaluation keyed to a CLI-group requirement (example.CLI.1).
function cliIntent(): IntentModel {
  return {
    summary: "Built deterministic intent.",
    spec_mode: "acai",
    requirements: [
      {
        id: "REQ-001",
        acai_id: "example.CLI.1",
        requirement: "The CLI dispatcher must parse commands.",
        source_refs: [{ kind: "spec", ref: "features/example.feature.yaml" }],
        constraints: [],
        assumptions: [],
        open_questions: [],
        confidence: "high"
      }
    ],
    constraints: [],
    non_goals: [],
    assumptions: [],
    open_questions: [],
    sources: []
  };
}

function cliMissingEvaluation(): EvaluationModel {
  return {
    summary: "1 requirement evaluated.",
    results: [
      {
        requirement_id: "REQ-001",
        acai_id: "example.CLI.1",
        status: "missing",
        summary: "No implementation or test evidence was found.",
        evidence: [],
        missing_evidence: [],
        review_focus: "Review whether this requirement needs implementation or tests.",
        confidence: "medium"
      }
    ],
    overreach: [],
    acai_coverage: { "example.CLI.1": "missing" }
  };
}

// A CONFIG-derived area mapping src/cli/ -> group CLI. Note the fallback cluster
// for the same path would be CLUSTER:SRC/CLI, which does NOT match the CLI group.
const CLI_CONFIG_AREAS: ReviewArea[] = [
  {
    id: "SUB-CLI",
    name: "CLI orchestration",
    groupKey: "CLI",
    prefixes: ["src/cli/"],
    purpose: "Parse commands and wire stages.",
    pattern: "command dispatcher",
    testKeywords: ["cli"]
  }
];

// A collection whose FALLBACK cluster yields CLUSTER:SRC/CLI for src/cli/ (NOT the
// CLI group), so without the config areas the citation is not a tie.
function cliCollection(tmp: string): CollectionResult {
  fs.mkdirSync(path.join(tmp, "src", "cli"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "other"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "cli", "index.ts"), "export const dispatch = () => 'ok';\n");
  fs.writeFileSync(path.join(tmp, "src", "other", "unrelated.ts"), "export const unrelated = 1;\n");
  return baseCollection(tmp, {
    repositoryFiles: ["src/cli/index.ts", "src/other/unrelated.ts"],
    changedFiles: [
      { path: "src/cli/index.ts", status: "M", source: "working_tree" },
      { path: "src/other/unrelated.ts", status: "A", source: "working_tree" }
    ],
    repoIndex: {
      files: [],
      ecosystems: [],
      clusters: [
        { id: "cluster:src/cli", label: "src/cli", language: "typescript", dirs: ["src/cli"], files: ["src/cli/index.ts"] },
        { id: "cluster:src/other", label: "src/other", language: "typescript", dirs: ["src/other"], files: ["src/other/unrelated.ts"] }
      ]
    }
  });
}

test("FINDING C: a config-area-mapped citation (src/cli/* for CLI.*) upgrades missing -> partial", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-findingC-mapped-"));
  const collection = cliCollection(tmp);
  const evaluation = cliMissingEvaluation();

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.CLI.1",
        requirement_id: "REQ-001",
        // In-pool, config-area-mapped (src/cli/ -> CLI) -- no ACID in the note, so
        // the tie comes ONLY from the threaded config areas.
        candidate_evidence: [{ kind: "file", path: "src/cli/index.ts", note: "the dispatcher" }],
        rationale: "Config-area-mapped citation.",
        what_would_confirm: "A focused test."
      }
    ])
  });

  await runReasoningStages(
    provider,
    { collection, intent: cliIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() },
    { reviewAreas: CLI_CONFIG_AREAS }
  );

  const result = evaluation.results[0];
  assert.equal(result.status, "partial", "a config-area-mapped (src/cli/ -> CLI) citation must upgrade missing -> partial");
  assert.ok(
    result.evidence.some((ref) => ref.llm_proposed === true && ref.path === "src/cli/index.ts"),
    "the config-mapped hypothesis is attached"
  );
});

test("FINDING C (regression baseline): WITHOUT the config areas, the same src/cli/ citation maps to a fallback cluster (NOT CLI) and stays missing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-findingC-fallback-"));
  const collection = cliCollection(tmp);
  const evaluation = cliMissingEvaluation();

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.CLI.1",
        requirement_id: "REQ-001",
        candidate_evidence: [{ kind: "file", path: "src/cli/index.ts", note: "the dispatcher" }],
        rationale: "Config-area-mapped citation."
      }
    ])
  });

  // No reviewAreas threaded -> the stage falls back to repo-index cluster areas,
  // whose group for src/cli/ is CLUSTER:SRC/CLI, not CLI. So the citation is a
  // hypothesis-only and the requirement stays missing. This is the bug FINDING C
  // fixes (the config areas above flip it to partial); it doubles as the proof the
  // upgrade is driven by the threaded config areas, not pool membership.
  await runReasoningStages(provider, {
    collection,
    intent: cliIntent(),
    evaluation,
    methodology: emptyMethodology(),
    risks: emptyRisks()
  });

  const result = evaluation.results[0];
  assert.equal(result.status, "missing", "without config areas the src/cli/ citation is not a CLI tie and stays missing");
  assert.ok(
    result.evidence.some((ref) => ref.llm_proposed === true && ref.path === "src/cli/index.ts"),
    "the citation is still attached as a hypothesis (proving it stays missing as a hypothesis, not a no-op)"
  );
});

test("FINDING C (round-4 D soundness preserved): an UNRELATED path stays missing even with config areas threaded", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-findingC-unrelated-"));
  const collection = cliCollection(tmp);
  const evaluation = cliMissingEvaluation();

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.CLI.1",
        requirement_id: "REQ-001",
        // In-pool but src/other/ does NOT map to the CLI config group and the note
        // carries no ACID -> hypothesis only, status must stay missing.
        candidate_evidence: [{ kind: "file", path: "src/other/unrelated.ts", note: "I think this helps" }],
        rationale: "Speculative association."
      }
    ])
  });

  await runReasoningStages(
    provider,
    { collection, intent: cliIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() },
    { reviewAreas: CLI_CONFIG_AREAS }
  );

  const result = evaluation.results[0];
  assert.equal(result.status, "missing", "an unrelated, non-config-mapped citation must stay missing (D soundness not re-loosened)");
  assert.ok(
    result.evidence.some((ref) => ref.llm_proposed === true && ref.path === "src/other/unrelated.ts"),
    "the unrelated hypothesis is still attached (proving the guard kept it missing, not a no-op)"
  );
});

// ---------------------------------------------------------------------------
// FINDING D (round 5, EVIDENCE.4): a genuinely-invalid in-pool LLM-proposed ref
// (bad line range) must flip the requirement to invalid_evidence (not be quietly
// buried in missing_evidence with status unchanged), so the --strict exit-4
// evidence gate catches it. An out-of-pool ref (a valid-looking but out-of-scope
// citation) and a valid hypothesis must NOT trigger invalid_evidence.
// ---------------------------------------------------------------------------

test("FINDING D (EVIDENCE.4): a genuinely-invalid in-pool ref (out-of-range line) flips the requirement to invalid_evidence", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-findingD-invalid-"));
  fs.mkdirSync(path.join(tmp, "src", "billing"), { recursive: true });
  // A short, real, in-pool changed file. Citing a line range far past its length
  // makes validateEvidenceRef return invalid ("line range is outside the file").
  fs.writeFileSync(path.join(tmp, "src", "billing", "invoice.ts"), "export const invoice = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/billing/invoice.ts"],
    changedFiles: [{ path: "src/billing/invoice.ts", status: "M", source: "working_tree" }]
  });
  const evaluation = evaluationWithStatus("missing");

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        candidate_evidence: [
          { kind: "file", path: "src/billing/invoice.ts", line_start: 9000, line_end: 9001, note: "bad range" }
        ],
        rationale: "Invalid line range hypothesis."
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.equal(result.status, "invalid_evidence", "a genuinely-invalid LLM-proposed ref must flip the requirement to invalid_evidence");
  // The invalid ref is surfaced (so a reviewer / SARIF / comment can see it).
  assert.ok(
    result.missing_evidence.some((ref) => ref.validation_status === "invalid"),
    "the invalid ref is surfaced as invalid evidence"
  );
});

test("FINDING D (EVIDENCE.4): an OUT-OF-POOL ref stays a non-status-changing hypothesis (not invalid_evidence)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-findingD-outofpool-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  // A real repo file that is NOT in the candidate pool (not a changed file / test).
  fs.writeFileSync(path.join(tmp, "src", "elsewhere.ts"), "export const elsewhere = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/elsewhere.ts"],
    changedFiles: [] // empty pool: src/elsewhere.ts is out-of-pool
  });
  const evaluation = evaluationWithStatus("missing");

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        candidate_evidence: [{ kind: "file", path: "src/elsewhere.ts", note: "out of scope" }],
        rationale: "Out-of-pool citation."
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  // An out-of-pool ref is a rejected hypothesis, NOT a malformed reference: it must
  // not force the exit-4 evidence gate, so the requirement stays missing.
  assert.equal(result.status, "missing", "an out-of-pool ref must NOT flip the requirement to invalid_evidence");
  assert.ok(
    result.missing_evidence.some((ref) => ref.validation_status === "invalid"),
    "the out-of-pool ref is still surfaced as a rejected hypothesis"
  );
});

// ROUND-5 SOUNDNESS (the OTHER direction from round-4 Finding D): an untrusted
// agent/LLM ref must never DEGRADE a verdict the deterministic layer already backed
// with valid, non-LLM evidence. A deterministically-partial requirement that carries
// real valid deterministic evidence + one invalid in-pool agent candidate ref must
// STAY partial (keep partial_reason), surface the invalid ref, and NOT trip exit 4.
test("ROUND-5 SOUNDNESS: a deterministically-partial requirement with valid deterministic evidence is NOT demoted to invalid_evidence by one invalid agent ref", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-round5-partial-soundness-"));
  fs.mkdirSync(path.join(tmp, "src", "billing"), { recursive: true });
  // A short, real, in-pool changed file. Citing a line range far past its length
  // makes validateEvidenceRef return invalid ("line range is outside the file").
  fs.writeFileSync(path.join(tmp, "src", "billing", "invoice.ts"), "export const invoice = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/billing/invoice.ts"],
    changedFiles: [{ path: "src/billing/invoice.ts", status: "M", source: "working_tree" }]
  });

  // A deterministically-PARTIAL requirement WITH real, valid, deterministically-
  // collected (non-llm_proposed) evidence and a partial_reason -- exactly what the
  // deterministic evaluator produces for a partial verdict.
  const evaluation = evaluationWithStatus("partial");
  evaluation.results[0].partial_reason = "impl_no_test";
  evaluation.results[0].evidence = [
    {
      kind: "file",
      path: "src/billing/invoice.ts",
      line_start: 1,
      line_end: 1,
      note: "Deterministic implementation evidence.",
      confidence: "high",
      validation_status: "valid"
    }
  ];

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        // One genuinely-invalid in-pool agent candidate (out-of-range line).
        candidate_evidence: [
          { kind: "file", path: "src/billing/invoice.ts", line_start: 9000, line_end: 9001, note: "bad range" }
        ],
        rationale: "Invalid line range hypothesis."
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  // The untrusted invalid ref must NOT corrupt the sound deterministic verdict.
  assert.equal(result.status, "partial", "a deterministically-partial verdict backed by valid evidence must stay partial");
  assert.equal(result.partial_reason, "impl_no_test", "partial_reason must be preserved (not dropped by an invalid agent ref)");
  // The valid deterministic evidence is still present.
  assert.ok(
    result.evidence.some((ref) => !ref.llm_proposed && ref.validation_status === "valid"),
    "the valid deterministic evidence remains attached"
  );
  // The invalid agent ref is still surfaced for the reviewer.
  assert.ok(
    result.missing_evidence.some((ref) => ref.validation_status === "invalid"),
    "the invalid agent ref is still surfaced as a rejected hypothesis"
  );
});

// ROUND-5 SOUNDNESS (no re-loosening of round-4 Finding D): a requirement with NO
// valid deterministic evidence (e.g. "missing") + an invalid agent ref STILL flips
// to invalid_evidence and trips the exit-4 gate. Pairs with the test above to prove
// the fix is scoped, not a blanket loosening.
test("ROUND-5 SOUNDNESS: an unsupported requirement (no valid deterministic evidence) + invalid agent ref STILL flips to invalid_evidence", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-round5-missing-still-invalid-"));
  fs.mkdirSync(path.join(tmp, "src", "billing"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "billing", "invoice.ts"), "export const invoice = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/billing/invoice.ts"],
    changedFiles: [{ path: "src/billing/invoice.ts", status: "M", source: "working_tree" }]
  });
  // Missing requirement has no valid deterministic evidence.
  const evaluation = evaluationWithStatus("missing");

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: "REQ-001",
        candidate_evidence: [
          { kind: "file", path: "src/billing/invoice.ts", line_start: 9000, line_end: 9001, note: "bad range" }
        ],
        rationale: "Invalid line range hypothesis."
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.equal(result.status, "invalid_evidence", "an unsupported requirement with an invalid agent ref must still flip to invalid_evidence (round-4 D not re-loosened)");
});

// Stage A #3: build N pool files src/f000.ts.. plus a matching changed-file
// pool, and a batched response where every requirement cites a unique pair of
// valid in-pool files. Lets a test exceed the global cap deterministically.
function manyPoolFiles(tmp: string, count: number): string[] {
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const rel = `src/f${String(i).padStart(3, "0")}.ts`;
    fs.writeFileSync(path.join(tmp, rel), `export const f${i} = ${i};\n`);
    paths.push(rel);
  }
  return paths;
}

// The candidate pool is bounded to the first POOL_SIZE changed-files/tests, so
// every test that wants its cited paths to validate must index within it.
const POOL_SIZE = 40;

test("review-surfaces.EVIDENCE.4 Stage A #3: a GLOBAL cap bounds total LLM-proposed evidence across all requirements", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-globalcap-"));
  // 40 in-pool files (the whole candidate pool); 50 missing requirements each
  // cite 2 in-pool files = 100 candidate refs demanded, far above the 40 cap.
  const poolPaths = manyPoolFiles(tmp, POOL_SIZE);

  const reqCount = 50;
  const ids = Array.from({ length: reqCount }, (_, i) => `example.REQ.${i + 1}`);
  const intent: IntentModel = {
    summary: "Many missing requirements.",
    spec_mode: "acai",
    requirements: ids.map((acai, i) => ({
      id: `REQ-${String(i + 1).padStart(3, "0")}`,
      acai_id: acai,
      requirement: `Requirement ${i + 1}.`,
      source_refs: [],
      constraints: [],
      assumptions: [],
      open_questions: [],
      confidence: "high" as const
    })),
    constraints: [],
    non_goals: [],
    assumptions: [],
    open_questions: [],
    sources: []
  };
  const evaluation: EvaluationModel = {
    summary: `${reqCount} requirements evaluated.`,
    results: ids.map((acai, i) => ({
      requirement_id: `REQ-${String(i + 1).padStart(3, "0")}`,
      acai_id: acai,
      status: "missing" as const,
      summary: "No evidence.",
      evidence: [],
      missing_evidence: [],
      review_focus: "Review.",
      confidence: "medium" as const
    })),
    overreach: [],
    acai_coverage: Object.fromEntries(ids.map((acai) => [acai, "missing"]))
  };

  const collection = baseCollection(tmp, {
    repositoryFiles: poolPaths,
    changedFiles: poolPaths.map((p) => ({ path: p, status: "A" as const, source: "working_tree" as const }))
  });

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence(
      ids.map((acai, i) => ({
        acai_id: acai,
        requirement_id: `REQ-${String(i + 1).padStart(3, "0")}`,
        candidate_evidence: [
          { kind: "file", path: poolPaths[(i * 2) % POOL_SIZE], note: `impl for ${acai}` },
          { kind: "file", path: poolPaths[(i * 2 + 1) % POOL_SIZE], note: `impl2 for ${acai}` }
        ],
        rationale: `Distinct rationale for ${acai}.`
      }))
    )
  });

  await runReasoningStages(provider, { collection, intent, evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const totalProposed = evaluation.results.reduce(
    (sum, r) => sum + r.evidence.filter((ref) => ref.llm_proposed === true).length,
    0
  );
  assert.ok(totalProposed > 0, "some LLM-proposed evidence was attached");
  assert.ok(totalProposed <= 40, `global cap must bound total LLM-proposed evidence, got ${totalProposed}`);
  assert.equal(totalProposed, 40, "exactly the global cap is spent when demand exceeds it");
  // Per-requirement cap still holds.
  for (const r of evaluation.results) {
    const perReq = r.evidence.filter((ref) => ref.llm_proposed === true).length;
    assert.ok(perReq <= 4, `per-requirement cap still holds, got ${perReq}`);
  }
});

test("review-surfaces.EVIDENCE.4 Stage A #3: ranking spends the cap on the WEAKEST requirements first", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-rank-"));
  const poolPaths = manyPoolFiles(tmp, POOL_SIZE);

  // Mix of statuses. Under the cap, the weakest (missing > unknown >
  // partial-without-test > partial-with-test) must win the budget. We make the
  // missing requirements alone demand more than the 40-ref cap so the partial
  // requirements should be starved entirely.
  type Spec = { acai: string; status: "missing" | "unknown" | "partial"; withTest: boolean };
  const specs: Spec[] = [];
  // Two partials WITH deterministic test evidence (weakest rank: 3).
  specs.push({ acai: "example.PWT.1", status: "partial", withTest: true });
  specs.push({ acai: "example.PWT.2", status: "partial", withTest: true });
  // Two partials WITHOUT test evidence (rank 2).
  specs.push({ acai: "example.PNT.1", status: "partial", withTest: false });
  specs.push({ acai: "example.PNT.2", status: "partial", withTest: false });
  // One unknown (rank 1).
  specs.push({ acai: "example.UNK.1", status: "unknown", withTest: false });
  // 30 missing (rank 0); 30 * 2 refs = 60 demanded, above the 40 cap.
  for (let i = 1; i <= 30; i += 1) {
    specs.push({ acai: `example.MISS.${i}`, status: "missing", withTest: false });
  }

  const intent: IntentModel = {
    summary: "Mixed-strength requirements.",
    spec_mode: "acai",
    requirements: specs.map((spec, i) => ({
      id: `REQ-${String(i + 1).padStart(3, "0")}`,
      acai_id: spec.acai,
      requirement: `Requirement ${spec.acai}.`,
      source_refs: [],
      constraints: [],
      assumptions: [],
      open_questions: [],
      confidence: "high" as const
    })),
    constraints: [],
    non_goals: [],
    assumptions: [],
    open_questions: [],
    sources: []
  };
  const evaluation: EvaluationModel = {
    summary: `${specs.length} requirements evaluated.`,
    results: specs.map((spec, i) => ({
      requirement_id: `REQ-${String(i + 1).padStart(3, "0")}`,
      acai_id: spec.acai,
      status: spec.status,
      summary: "Deterministic result.",
      // Partial-with-test carries a deterministic (non-LLM) test ref so the
      // ranker can see it already has test evidence.
      evidence: spec.withTest
        ? [{ kind: "test" as const, path: poolPaths[0], note: "deterministic test", confidence: "high" as const, validation_status: "valid" as const }]
        : [],
      missing_evidence: [],
      review_focus: "Review.",
      confidence: "medium" as const
    })),
    overreach: [],
    acai_coverage: Object.fromEntries(specs.map((spec) => [spec.acai, spec.status]))
  };

  const collection = baseCollection(tmp, {
    repositoryFiles: poolPaths,
    changedFiles: poolPaths.map((p) => ({ path: p, status: "A" as const, source: "working_tree" as const }))
  });

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence(
      specs.map((spec, i) => ({
        acai_id: spec.acai,
        requirement_id: `REQ-${String(i + 1).padStart(3, "0")}`,
        candidate_evidence: [
          { kind: "file", path: poolPaths[(i * 2) % POOL_SIZE], note: `impl for ${spec.acai}` },
          { kind: "file", path: poolPaths[(i * 2 + 1) % POOL_SIZE], note: `impl2 for ${spec.acai}` }
        ],
        rationale: `Distinct rationale for ${spec.acai}.`
      }))
    )
  });

  await runReasoningStages(provider, { collection, intent, evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const proposedFor = (acai: string) =>
    evaluation.results.find((r) => r.acai_id === acai)!.evidence.filter((ref) => ref.llm_proposed === true).length;

  // The cap is spent on the missing requirements; the partials are starved.
  const missingTotal = specs
    .filter((s) => s.status === "missing")
    .reduce((sum, s) => sum + proposedFor(s.acai), 0);
  assert.ok(missingTotal > 0, "missing requirements receive hypotheses first");

  assert.equal(proposedFor("example.PWT.1"), 0, "partial-with-test is lowest priority and gets no budget");
  assert.equal(proposedFor("example.PWT.2"), 0, "partial-with-test is lowest priority and gets no budget");
  assert.equal(proposedFor("example.PNT.1"), 0, "partial-without-test loses to the 60-ref missing demand");
  assert.equal(proposedFor("example.PNT.2"), 0, "partial-without-test loses to the 60-ref missing demand");

  // Total stays under the global cap.
  const totalProposed = evaluation.results.reduce(
    (sum, r) => sum + r.evidence.filter((ref) => ref.llm_proposed === true).length,
    0
  );
  assert.ok(totalProposed <= 40, `global cap holds under ranking, got ${totalProposed}`);

  // No partial requirement was upgraded by the LLM (the guardrail), and no
  // missing requirement that received valid evidence exceeded partial.
  for (const r of evaluation.results) {
    assert.notEqual(r.status, "satisfied", "LLM never reaches satisfied");
    if (specs.find((s) => s.acai === r.acai_id)?.status === "partial") {
      assert.equal(r.status, "partial", "partial requirements are never raised by the LLM");
    }
  }
});

test("agent-file noise control: one rationale broadcast to many requirements collapses to a single global review_focus line", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-noise-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "real.ts"), "export const real = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/real.ts"],
    changedFiles: [{ path: "src/real.ts", status: "A", source: "working_tree" }]
  });

  // Nine missing requirements, all enrichable. The intent has matching ids so
  // labels resolve to acai_ids.
  const ids = Array.from({ length: 9 }, (_, i) => `example.REQ.${i + 1}`);
  const intent: IntentModel = {
    summary: "Many requirements.",
    spec_mode: "acai",
    requirements: ids.map((acai, i) => ({
      id: `REQ-${String(i + 1).padStart(3, "0")}`,
      acai_id: acai,
      requirement: `Requirement ${i + 1}.`,
      source_refs: [{ kind: "spec", ref: "features/x.feature.yaml" }],
      constraints: [],
      assumptions: [],
      open_questions: [],
      confidence: "high"
    })),
    constraints: [],
    non_goals: [],
    assumptions: [],
    open_questions: [],
    sources: []
  };
  const evaluation: EvaluationModel = {
    summary: "9 requirements evaluated.",
    results: ids.map((acai, i) => ({
      requirement_id: `REQ-${String(i + 1).padStart(3, "0")}`,
      acai_id: acai,
      status: "missing" as const,
      summary: "No implementation or test evidence was found.",
      evidence: [],
      missing_evidence: [],
      review_focus: "Review whether this requirement needs implementation or tests.",
      confidence: "medium" as const
    })),
    overreach: [],
    acai_coverage: Object.fromEntries(ids.map((acai) => [acai, "missing"]))
  };
  const risks = emptyRisks();
  const globalBefore = risks.review_focus.length;

  // The agent-file failure mode: the SAME rationale + what_would_confirm + a
  // single cited file is returned for EVERY requirement, now as one batched
  // response carrying an entry per requirement.
  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence(
      ids.map((acai, i) => ({
        acai_id: acai,
        requirement_id: `REQ-${String(i + 1).padStart(3, "0")}`,
        candidate_evidence: [{ kind: "file", path: "src/real.ts", note: "broadcast file" }],
        rationale: "This module implements the schema-bound reasoning stages.",
        what_would_confirm: "An exact ACID mention in code or a focused test."
      }))
    )
  });

  await runReasoningStages(provider, { collection, intent, evaluation, methodology: emptyMethodology(), risks });

  // Exactly one global review_focus line was added for the shared hypothesis.
  const added = risks.review_focus.slice(globalBefore);
  const llmLines = added.filter((line) => line.startsWith("LLM-proposed:"));
  assert.equal(llmLines.length, 1, `the shared rationale must collapse to one global line, got ${llmLines.length}`);
  assert.match(llmLines[0], /9 requirements share this hypothesis/);
  assert.match(llmLines[0], /This module implements the schema-bound reasoning stages\./);
  // The verbatim rationale is NOT repeated once per requirement.
  const verbatimCount = added.filter((line) => line.includes("This module implements the schema-bound reasoning stages.")).length;
  assert.equal(verbatimCount, 1, "the identical rationale text appears once, not once per requirement");
});

test("distinct rationales remain distinct global review_focus lines", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-distinct-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "real.ts"), "export const real = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/real.ts"],
    changedFiles: [{ path: "src/real.ts", status: "A", source: "working_tree" }]
  });
  const intent: IntentModel = {
    summary: "Two requirements.",
    spec_mode: "acai",
    requirements: ["example.A.1", "example.B.1"].map((acai, i) => ({
      id: `REQ-${String(i + 1).padStart(3, "0")}`,
      acai_id: acai,
      requirement: `Requirement ${i + 1}.`,
      source_refs: [],
      constraints: [],
      assumptions: [],
      open_questions: [],
      confidence: "high" as const
    })),
    constraints: [],
    non_goals: [],
    assumptions: [],
    open_questions: [],
    sources: []
  };
  const evaluation: EvaluationModel = {
    summary: "2 requirements evaluated.",
    results: ["example.A.1", "example.B.1"].map((acai, i) => ({
      requirement_id: `REQ-${String(i + 1).padStart(3, "0")}`,
      acai_id: acai,
      status: "missing" as const,
      summary: "No evidence.",
      evidence: [],
      missing_evidence: [],
      review_focus: "Review.",
      confidence: "medium" as const
    })),
    overreach: [],
    acai_coverage: { "example.A.1": "missing", "example.B.1": "missing" }
  };
  const risks = emptyRisks();
  const globalBefore = risks.review_focus.length;

  // The single batched call returns a DIFFERENT rationale per requirement.
  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.A.1",
        requirement_id: "REQ-001",
        rationale: "Distinct rationale number 1.",
        what_would_confirm: "A focused test."
      },
      {
        acai_id: "example.B.1",
        requirement_id: "REQ-002",
        rationale: "Distinct rationale number 2.",
        what_would_confirm: "A focused test."
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent, evaluation, methodology: emptyMethodology(), risks });

  const added = risks.review_focus.slice(globalBefore).filter((line) => line.startsWith("LLM-proposed:"));
  assert.equal(added.length, 2, "two materially different rationales remain two distinct lines");
  assert.ok(!added.some((line) => /requirements share this hypothesis/.test(line)), "distinct rationales are not collapsed");
});

test("review-surfaces.INTENT.6 schema-bound candidates with validated anchors land in the claimed section; invalid anchors demote to open questions", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-sparse-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "api.ts"), "export const api = 1;\n");

  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/api.ts"],
    changedFiles: [{ path: "src/api.ts", status: "A", source: "working_tree" }]
  });

  // Sparse intent: NO authoritative acai-backed requirement.
  const intent: IntentModel = {
    summary: "Sparse foreign repo.",
    spec_mode: "acai",
    requirements: [],
    constraints: [],
    non_goals: [],
    assumptions: [],
    open_questions: [],
    sources: []
  };

  const provider = stubProvider({
    "intent-synthesis": {
      summary: "An API module changed.",
      assumptions: ["The API layer is the main surface."],
      non_goals: ["No persistence layer in scope."],
      open_questions: ["Is there a test harness?"],
      candidate_requirements: [
        { statement: "The API module should expose a stable surface.", anchors: ["src/api.ts"], confidence: "medium" },
        // This one cites a nonexistent path: demoted to an open question, never dropped silently.
        { statement: "Fabricated requirement.", anchors: ["src/ghost.ts"] }
      ]
    }
  });

  await runReasoningStages(provider, { collection, intent, evaluation: { summary: "x", results: [], overreach: [], acai_coverage: {} }, methodology: emptyMethodology(), risks: emptyRisks() });

  // review-surfaces.INTENT.7: candidates live in the SEPARATE claimed section —
  // never in requirements, so the evaluator can never score them.
  assert.equal(intent.requirements.length, 0, "provider candidates never enter intent.requirements");
  assert.equal(intent.claimed_candidates?.length, 1, "the valid-anchored candidate is claimed");
  const candidate = intent.claimed_candidates![0];
  assert.equal(candidate.trust, "claimed");
  assert.deepEqual(candidate.anchors, ["src/api.ts"]);
  assert.notEqual(candidate.confidence, "high" as never);
  // The invalid-anchored candidate is demoted to an open question naming the token.
  assert.ok(intent.open_questions.some((q) => /invalid anchor/.test(q) && /src\/ghost\.ts/.test(q)), "invalid anchor demotes, never drops silently");
  assert.ok(intent.assumptions.some((item) => item.startsWith("LLM-proposed:")), "narrative additions are marked");
});

test("review-surfaces.INTENT.7 candidates never enter requirements even with an authoritative spec", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-authoritative-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "api.ts"), "export const api = 1;\n");

  const collection = baseCollection(tmp, { repositoryFiles: ["src/api.ts"] });
  const intent = missingIntent(); // has authoritative example.EVAL.1
  const before = intent.requirements.length;

  const provider = stubProvider({
    "intent-synthesis": {
      candidate_requirements: [
        { statement: "An additional intent hypothesis.", anchors: ["src/api.ts"] }
      ]
    }
  });

  await runReasoningStages(provider, { collection, intent, evaluation: evaluationWithStatus("missing"), methodology: emptyMethodology(), risks: emptyRisks() });

  assert.equal(intent.requirements.length, before, "requirements are never touched by provider candidates");
  assert.ok(!intent.requirements.some((req) => req.llm_derived));
  assert.equal(intent.claimed_candidates?.length, 1, "the candidate is recorded in the claimed section instead");
});

test("mock provider is a guaranteed no-op: deterministic packet is byte-stable", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-mock-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "real.ts"), "export const real = 1;\n");

  const collection = baseCollection(tmp, { repositoryFiles: ["src/real.ts"] });
  const intent = missingIntent();
  const evaluation = evaluationWithStatus("missing");
  const methodology = emptyMethodology();
  const risks = emptyRisks();

  const before = JSON.stringify({ intent, evaluation, methodology, risks });

  const mock: ReasoningProvider = {
    name: "mock",
    async generateStructured(): Promise<StructuredResult> {
      // Even if the mock somehow returned data, runReasoningStages short-circuits
      // on name === "mock" before consulting it.
      return { ok: true, data: { candidate_evidence: [{ kind: "file", path: "src/real.ts" }] } };
    }
  };

  await runReasoningStages(mock, { collection, intent, evaluation, methodology, risks });

  assert.equal(JSON.stringify({ intent, evaluation, methodology, risks }), before, "mock leaves every model byte-identical");
});

test("a provider that returns not-ok for every stage leaves the deterministic packet unchanged", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-notok-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "real.ts"), "export const real = 1;\n");

  const collection = baseCollection(tmp, { repositoryFiles: ["src/real.ts"] });
  const intent = missingIntent();
  const evaluation = evaluationWithStatus("missing");
  const methodology = emptyMethodology();
  const risks = emptyRisks();
  const before = JSON.stringify({ intent, evaluation, methodology, risks });

  const notOk: ReasoningProvider = {
    name: "ai-sdk",
    async generateStructured(): Promise<StructuredResult> {
      return { ok: false, reason: "missing_anthropic_api_key" };
    }
  };

  await runReasoningStages(notOk, { collection, intent, evaluation, methodology, risks });

  assert.equal(JSON.stringify({ intent, evaluation, methodology, risks }), before, "a non-ok provider is a no-op per stage");
});

test("methodology + risk narrative are appended as labeled hypotheses, never overriding deterministic findings", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-narrative-"));
  const collection = baseCollection(tmp);
  const methodology = emptyMethodology();
  const risks = emptyRisks();
  const deterministicRiskCount = risks.items.length;

  const provider = stubProvider({
    "methodology-risk-narrative": {
      considered: ["Considered a streaming approach."],
      decisions: ["Chose deterministic-first."],
      risk_narratives: ["Possible race condition under concurrency."]
    }
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation: evaluationWithStatus("missing"), methodology, risks });

  assert.ok(methodology.considered.some((item) => item.startsWith("LLM-proposed:")));
  assert.ok(methodology.decisions.some((item) => item.startsWith("LLM-proposed:")));
  const llmRisk = risks.items.find((item) => item.id.startsWith("LLM-RISK-"));
  assert.ok(llmRisk, "risk narrative is appended");
  assert.equal(llmRisk?.severity, "unknown");
  assert.match(llmRisk?.summary ?? "", /LLM-proposed:/);
  assert.equal(llmRisk?.evidence?.[0].llm_proposed, true);
  assert.equal(risks.items.length, deterministicRiskCount + 1, "deterministic risks are preserved, narrative appended");
});

test("review-surfaces.EVIDENCE.6: renderer visibly distinguishes LLM hypotheses and the JSON still validates", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-render-"));
  const packet: ReviewPacket = {
    schema_version: "review-surfaces.packet.v1",
    manifest: {
      tool_version: "0.1.0",
      created_at: "2026-05-28T00:00:00.000Z",
      repo: "fixture",
      base_ref: "HEAD",
      head_ref: "HEAD",
      head_sha: "abc",
      uncommitted_files: 0,
      run_mode: "local"
    },
    intent: {
      summary: "render fixture",
      spec_mode: "acai",
      requirements: [
        {
          id: "REQ-001",
          acai_id: "example.EVAL.1",
          requirement: "Authoritative requirement.",
          source_refs: [],
          constraints: [],
          assumptions: [],
          open_questions: [],
          confidence: "high"
        },
        {
          id: "REQ-LLM-002",
          requirement: "LLM-proposed requirement.",
          source_refs: [],
          constraints: [],
          assumptions: [],
          open_questions: [],
          confidence: "low",
          llm_derived: true
        }
      ],
      constraints: [],
      non_goals: [],
      assumptions: [],
      open_questions: [],
      sources: []
    },
    evaluation: {
      summary: "render fixture",
      results: [
        {
          requirement_id: "REQ-001",
          acai_id: "example.EVAL.1",
          status: "partial",
          summary: "Status raised by LLM-proposed candidate evidence.",
          evidence: [
            {
              kind: "file",
              path: "src/real.ts",
              note: "LLM-proposed: candidate evidence.",
              confidence: "low",
              validation_status: "valid",
              llm_proposed: true
            }
          ],
          missing_evidence: [],
          review_focus: "Review focus.",
          confidence: "low"
        }
      ],
      overreach: [],
      acai_coverage: { "example.EVAL.1": "partial" }
    },
    architecture: { summary: "render fixture", diagrams: [], diagram_validation: [], subsystems: [], open_questions: [] },
    methodology: {
      summary: "render fixture",
      missing_logs: false,
      considered: [],
      research: [],
      decisions: [],
      unchallenged_assumptions: [],
      skipped_checks: [],
      claims_without_evidence: [],
      verified_claims: [],
      workflow_findings: [],
      quality_flags: [],
      evidence: []
    },
    risks: {
      summary: "render fixture",
      items: [
        {
          id: "LLM-RISK-001",
          category: "unknown",
          severity: "unknown",
          summary: "LLM-proposed: a hypothesis risk.",
          evidence: [{ kind: "unknown", confidence: "low", validation_status: "unknown", llm_proposed: true }]
        }
      ],
      test_evidence: [],
      test_gaps: [],
      missing_automatic_tests: [],
      missing_manual_checks: [],
      review_focus: []
    }
  };

  await rewriteReviewPacket(tmp, packet);
  const markdown = fs.readFileSync(path.join(tmp, "review_packet.md"), "utf8");
  assert.match(markdown, /LLM-proposed, non-authoritative/);
  assert.match(markdown, /includes LLM-proposed evidence/);
  assert.match(markdown, /LLM\/agent hypotheses/);

  // The JSON with the new llm_proposed/llm_derived fields still validates.
  const result = await validateJsonFile(
    path.join(process.cwd(), "schemas", "review_packet.schema.json"),
    path.join(tmp, "review_packet.json")
  );
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("review-surfaces.PRIVACY.2 agent-file reasoning stages redact secrets before they reach the packet", async () => {
  // Regression: secrets in a local --agent-input file reach the packet through
  // the REASONING stages (intent synthesis + risk narrative), not only through
  // provider.ts mergeEnrichment. The agent-file provider returns the same parsed
  // file to EVERY stage, so a recognizable secret planted in each consumed field
  // must be redacted before it is written into intent / methodology / risks.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-agentfile-redact-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "real.ts"), "export const real = 1;\n");

  const secrets = {
    google: "AIzaSyRAWGOOGLEKEY1234567890abcdefghijkl",
    ghtoken: "ghp_RAWTOKEN1234567890abcdefghijklmnop",
    apikey: "sk-RAWSECRETabcdef123456",
    password: "hunter2hunter2",
    risksecret: "topsecretvalue9999"
  };

  const agentFile = {
    // Consumed by the intent-synthesis stage.
    assumptions: [`Shared key AIzaSy=${secrets.google} present`],
    non_goals: [`GH_TOKEN=${secrets.ghtoken} should be rotated`],
    open_questions: [`Is API_KEY=${secrets.apikey} hardcoded?`],
    summary: `Summary that mentions SECRET=${secrets.risksecret}`,
    candidate_requirements: [
      {
        statement: `Requirement leaking password=${secrets.password} and API_KEY=${secrets.apikey}`,
        anchors: ["src/real.ts"]
      }
    ],
    // Consumed by the methodology + risk narrative stage.
    considered: [`Considered password=${secrets.password} approach`],
    decisions: [`Decided to keep API_KEY=${secrets.apikey}`],
    risk_narratives: [`Risk: google key AIzaSy=${secrets.google} committed`]
  };
  fs.writeFileSync(path.join(tmp, "agent.json"), JSON.stringify(agentFile));

  const provider = agentFileProvider({ cwd: tmp, agentInput: "agent.json" });

  // Sparse intent so candidate_requirements are actually built (foreign-repo path).
  const intent: IntentModel = {
    summary: "Sparse foreign repo.",
    spec_mode: "acai",
    requirements: [],
    constraints: [],
    non_goals: [],
    assumptions: [],
    open_questions: [],
    sources: []
  };
  const evaluation: EvaluationModel = { summary: "x", results: [], overreach: [], acai_coverage: {} };
  const methodology = emptyMethodology();
  const risks = emptyRisks();
  const collection = baseCollection(tmp, {
    repositoryFiles: ["src/real.ts"],
    changedFiles: [{ path: "src/real.ts", status: "A", source: "working_tree" }]
  });

  await runReasoningStages(provider, { collection, intent, evaluation, methodology, risks });

  // No raw secret VALUE may survive anywhere in the merged models.
  const serialized = JSON.stringify({ intent, evaluation, methodology, risks });
  for (const [name, raw] of Object.entries(secrets)) {
    assert.ok(!serialized.includes(raw), `raw ${name} secret must be redacted out of the packet`);
  }

  // The redaction boundary visibly ran on each consumed reasoning field. The
  // precise kind shows through when the value is a recognized provider token
  // (google AIza -> google_api_key; apikey sk- -> openai_key); generic
  // KEY=value shapes (ghtoken<36, risksecret, password) fall to token_assignment.
  assert.match(intent.assumptions.join("\n"), /\[REDACTED:google_api_key\]/);
  assert.match(intent.non_goals.join("\n"), /\[REDACTED:secret\]/);
  assert.match(intent.open_questions.join("\n"), /\[REDACTED:openai_key\]/);
  assert.match(intent.summary, /\[REDACTED:secret\]/);
  assert.match(methodology.considered.join("\n"), /\[REDACTED:secret\]/);
  assert.match(methodology.decisions.join("\n"), /\[REDACTED:openai_key\]/);
  assert.match(
    risks.items.map((item) => item.summary).join("\n"),
    /\[REDACTED:google_api_key\]/
  );

  // The candidate statement is also redacted before landing in the claimed
  // section (it bypasses markHypothesis and lands directly in intent).
  const candidate = intent.claimed_candidates?.[0];
  assert.ok(candidate, "the valid-anchored candidate is claimed");
  assert.match(candidate.statement, /\[REDACTED:secret\]/);
  assert.ok(!candidate.statement.includes(secrets.apikey), "candidate api key redacted");
  assert.ok(!candidate.statement.includes(secrets.password), "candidate password redacted");
});
