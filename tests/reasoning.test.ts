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
      remote_provider_blocked: false
    },
    git: { repo: "fixture", base_ref: "HEAD", head_ref: "HEAD", head_sha: "abc" },
    ...overrides
  } as CollectionResult;
}

function missingIntent(): IntentModel {
  return {
    summary: "Built deterministic intent.",
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
          { kind: "file", path: "src/evaluation/evaluate.ts", note: "implements evaluation" }
        ],
        rationale: "This file appears to implement the requirement.",
        what_would_confirm: "An exact ACID mention or a focused test."
      }
    ])
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.equal(result.status, "partial", "valid LLM evidence may upgrade at most to partial");
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
        candidate_evidence: Array.from({ length: 50 }, () => ({ kind: "file", path: "src/real.ts", note: "spam" })),
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

test("intent synthesis proposes non-authoritative requirements only when the spec is sparse", async () => {
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
        { requirement: "The API module should expose a stable surface.", title: "API surface", source_ref: { kind: "file", path: "src/api.ts", note: "changed file" } },
        // This one cites a nonexistent path and must be dropped.
        { requirement: "Fabricated requirement.", source_ref: { kind: "file", path: "src/ghost.ts" } }
      ]
    }
  });

  await runReasoningStages(provider, { collection, intent, evaluation: { summary: "x", results: [], overreach: [], acai_coverage: {} }, methodology: emptyMethodology(), risks: emptyRisks() });

  const proposed = intent.requirements.filter((req) => req.llm_derived);
  assert.equal(proposed.length, 1, "only the requirement with a valid source ref is kept");
  const requirement = proposed[0];
  assert.equal(requirement.acai_id, undefined, "no fabricated acai_id");
  assert.notEqual(requirement.confidence, "high", "proposed requirements are never high confidence");
  assert.equal(requirement.llm_derived, true);
  assert.equal(requirement.source_refs[0].evidence?.[0].validation_status, "valid");
  assert.ok(intent.assumptions.some((item) => item.startsWith("LLM-proposed:")), "narrative additions are marked");
});

test("intent synthesis never adds candidate requirements when authoritative Acai requirements exist", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-authoritative-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "api.ts"), "export const api = 1;\n");

  const collection = baseCollection(tmp, { repositoryFiles: ["src/api.ts"] });
  const intent = missingIntent(); // has authoritative example.EVAL.1
  const before = intent.requirements.length;

  const provider = stubProvider({
    "intent-synthesis": {
      candidate_requirements: [
        { requirement: "Should be ignored.", source_ref: { kind: "file", path: "src/api.ts" } }
      ]
    }
  });

  await runReasoningStages(provider, { collection, intent, evaluation: evaluationWithStatus("missing"), methodology: emptyMethodology(), risks: emptyRisks() });

  assert.equal(intent.requirements.length, before, "authoritative spec means no proposed requirements");
  assert.ok(!intent.requirements.some((req) => req.llm_derived));
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
      run_mode: "local"
    },
    intent: {
      summary: "render fixture",
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
        requirement: `Requirement leaking password=${secrets.password}`,
        title: `Title with API_KEY=${secrets.apikey}`,
        source_ref: { kind: "file", path: "src/real.ts", note: `note has SECRET=${secrets.risksecret}` }
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

  // The redaction boundary visibly ran on each consumed reasoning field.
  assert.match(intent.assumptions.join("\n"), /\[REDACTED:google_api_key\]/);
  assert.match(intent.non_goals.join("\n"), /\[REDACTED:secret\]/);
  assert.match(intent.open_questions.join("\n"), /\[REDACTED:secret\]/);
  assert.match(intent.summary, /\[REDACTED:secret\]/);
  assert.match(methodology.considered.join("\n"), /\[REDACTED:secret\]/);
  assert.match(methodology.decisions.join("\n"), /\[REDACTED:secret\]/);
  assert.match(
    risks.items.map((item) => item.summary).join("\n"),
    /\[REDACTED:google_api_key\]/
  );

  // The candidate-requirement title / requirement text / source-ref note are
  // also redacted (these bypass markHypothesis and land directly in intent).
  const proposed = intent.requirements.find((req) => req.llm_derived);
  assert.ok(proposed, "the candidate requirement with a valid source ref is built");
  assert.match(JSON.stringify(proposed), /\[REDACTED:secret\]/);
  assert.ok(!JSON.stringify(proposed).includes(secrets.apikey), "candidate title api key redacted");
  assert.ok(!JSON.stringify(proposed).includes(secrets.password), "candidate requirement password redacted");
  assert.ok(!JSON.stringify(proposed).includes(secrets.risksecret), "candidate source-ref note secret redacted");
});
