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
import { ReasoningProvider, StructuredResult } from "../src/llm/provider";
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
    "evaluation-candidate-evidence": {
      candidate_evidence: [
        { kind: "file", path: "src/evaluation/evaluate.ts", note: "implements evaluation" }
      ],
      rationale: "This file appears to implement the requirement.",
      what_would_confirm: "An exact ACID mention or a focused test."
    }
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
    "evaluation-candidate-evidence": {
      // nonexistent path + bad line range + would-be unknown ACID territory
      candidate_evidence: [
        { kind: "file", path: "src/does-not-exist.ts", line_start: 999, line_end: 1000, note: "fabricated" }
      ],
      rationale: "guessing"
    }
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
    "evaluation-candidate-evidence": {
      status: "satisfied",
      candidate_evidence: Array.from({ length: 50 }, () => ({ kind: "file", path: "src/real.ts", note: "spam" })),
      rationale: "trust me it is done",
      what_would_confirm: "nothing"
    } as Record<string, unknown>
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
    "evaluation-candidate-evidence": {
      candidate_evidence: [{ kind: "test", path: "src/real.ts", note: "a test, allegedly" }],
      rationale: "more evidence"
    }
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
    "evaluation-candidate-evidence": {
      candidate_evidence: [{ kind: "file", path: "src/llm/reasoning.ts", note: "cited an unrelated real file" }],
      rationale: "This module implements the schema-bound reasoning stages.",
      what_would_confirm: "An exact ACID mention in code or a focused test."
    }
  });

  await runReasoningStages(provider, { collection, intent: missingIntent(), evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  const result = evaluation.results[0];
  assert.equal(result.status, "missing", "an out-of-pool real file must NOT inflate the partial count");
  assert.ok(!result.evidence.some((ref) => ref.llm_proposed === true), "out-of-pool ref is never attached as proof");
  const surfaced = result.missing_evidence.find((ref) => ref.validation_status === "invalid");
  assert.ok(surfaced, "the out-of-pool ref is surfaced as invalid, not silently swallowed");
  assert.match(surfaced?.note ?? "", /candidate pool/);
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
  // single cited (out-of-pool) file is returned for EVERY requirement.
  const provider = stubProvider({
    "evaluation-candidate-evidence": {
      candidate_evidence: [{ kind: "file", path: "src/real.ts", note: "broadcast file" }],
      rationale: "This module implements the schema-bound reasoning stages.",
      what_would_confirm: "An exact ACID mention in code or a focused test."
    }
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

  // Provider returns a DIFFERENT rationale per call (alternating).
  let call = 0;
  const provider: ReasoningProvider = {
    name: "ai-sdk",
    async generateStructured(stage): Promise<StructuredResult> {
      if (stage !== "evaluation-candidate-evidence") {
        return { ok: false, reason: "n/a" };
      }
      call += 1;
      return {
        ok: true,
        data: {
          rationale: `Distinct rationale number ${call}.`,
          what_would_confirm: "A focused test."
        }
      };
    }
  };

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
