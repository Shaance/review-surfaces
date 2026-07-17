import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareAgreementBenchmarkRuns,
  parseAgreementBenchmarkGold,
  parseAgreementBenchmarkManifest,
  scoreAgreementBenchmarkRun
} from "../src/audit/benchmark";
import { runAgreementBenchmarkArm } from "../src/audit/benchmark-runner";
import type { AgreementAuditCandidate } from "../src/audit/contract";
import { groundAgreementAudit } from "../src/audit/grounding";
import { parseAgreementAuditInput } from "../src/audit/parse";
import { buildAuditPrompt } from "../src/audit/prompt";
import type { AgreementBenchmarkGold } from "../src/audit/benchmark";
import {
  AGREEMENT_BENCH_ROOT as BENCH_ROOT,
  agreementCandidate as agreement,
  loadAgreementInput as loadInput,
  readJson
} from "./helpers/agreement-audit";

test("agreement benchmark freezes six paired cases and keeps gold out of both prompts", () => {
  const manifest = parseAgreementBenchmarkManifest(readJson(path.join(BENCH_ROOT, "manifest.json")));
  assert.equal(manifest.cases.length, 6);
  for (const entry of manifest.cases) {
    assert.equal(fileDigest(path.join(BENCH_ROOT, entry.input)), entry.input_sha256);
    assert.equal(fileDigest(path.join(BENCH_ROOT, entry.gold)), entry.gold_sha256);
    const input = parseAgreementAuditInput(readJson(path.join(BENCH_ROOT, entry.input)));
    const gold = parseAgreementBenchmarkGold(readJson(path.join(BENCH_ROOT, entry.gold)), input);
    assert.equal(gold.case_id, entry.id);
    assert.ok(gold.agreements.length > 0);
    const baseline = buildAuditPrompt(input, "plain-agent");
    const product = buildAuditPrompt(input, "review-surfaces");
    assert.ok(!baseline.includes('"expected_state"'));
    assert.ok(!product.includes('"expected_state"'));
    assert.ok(!baseline.includes('"case_id"'));
    assert.ok(!product.includes('"case_id"'));
  }
});

test("agreement benchmark includes a case larger than the legacy eight-item cap", () => {
  const gold = readJson<AgreementBenchmarkGold>(path.join(BENCH_ROOT, "cases", "large-agreement-set.gold.json"));
  assert.equal(gold.agreements.length, 10);
});

test("gold parsing rejects duplicate or wrong-role governing events", () => {
  const input = loadInput("clean-alignment");
  assert.throws(() => parseAgreementBenchmarkGold({
    case_id: "invalid",
    source: "synthetic",
    clean: false,
    agreements: [{
      id: "bad",
      kind: "human_instruction",
      materiality: "material",
      expected_state: "unresolved",
      governing_event_ids: ["a1", "a1"]
    }]
  }, input), /non-user governing event|must be unique/);
});

test("benchmark manifest paths cannot escape the benchmark root", () => {
  const manifest = (input: string) => ({
    version: 1,
    cases: [{
      id: "escape",
      input,
      input_sha256: "a".repeat(64),
      gold: "cases/escape.gold.json",
      gold_sha256: "b".repeat(64)
    }]
  });
  assert.throws(() => parseAgreementBenchmarkManifest(manifest("../private.json")), /stay within the benchmark root/);
  assert.throws(() => parseAgreementBenchmarkManifest(manifest("..\\private.json")), /stay within the benchmark root/);
  assert.throws(() => parseAgreementBenchmarkManifest(manifest("C:\\private.json")), /stay within the benchmark root/);
});

test("adjudicated benchmark score is independent of candidate wording and enforces release gates", () => {
  const input = loadInput("late-correction");
  const candidate: AgreementAuditCandidate = {
    final_goal: { text: "Remove Swift analysis but retain the privacy boundary.", conversation_event_ids: ["u1", "u2"] },
    agreements: [
      agreement({ key: "wording-a", statement: "Swift code is removed.", conversation_event_ids: ["u1"], materiality: "material", diff_citations: [{ path: "src/swift/project.ts", side: "delete", line: 1, contains: "inspectSwiftProject" }] }),
      agreement({ key: "wording-c", statement: "Swift documentation removal is not evidenced.", state: "unresolved", conversation_event_ids: ["u1"], reviewer_action: "Confirm or remove the documentation." }),
      agreement({ key: "wording-d", statement: "Swift test removal is not evidenced.", state: "unresolved", conversation_event_ids: ["u1"], reviewer_action: "Confirm or remove the dedicated tests." }),
      agreement({ key: "wording-b", kind: "human_boundary", statement: "A retained privacy rule is deleted.", state: "diverged", conversation_event_ids: ["u2"], diff_citations: [{ path: "src/privacy/ignore.ts", side: "delete", line: 4, contains: "DerivedData" }], reviewer_action: "Restore it." })
    ],
    complete: true,
    limitations: []
  };
  const audit = groundAgreementAudit(input, candidate);
  const gold = parseAgreementBenchmarkGold(readJson(path.join(BENCH_ROOT, "cases", "late-correction.gold.json")), input);
  const score = scoreAgreementBenchmarkRun(audit, gold, {
    matches: [
      { candidate_key: "wording-a", gold_id: "remove-swift-code" },
      { candidate_key: "wording-c", gold_id: "remove-swift-docs" },
      { candidate_key: "wording-d", gold_id: "remove-swift-tests" },
      { candidate_key: "wording-b", gold_id: "retain-privacy-boundary" }
    ],
    false_positive_candidate_keys: []
  }, {
    run_id: "product-1",
    pair_id: "pair-1",
    model_id: "model-a",
    model_config_hash: "config-a",
    input_hash: "input-a",
    output_hash: "output-a",
    generation_ms: 1
  });
  assert.equal(score.material_f1, 1);
  assert.deepEqual(score.failures, []);

  const baseline = [1, 2, 3].map((run) => ({ ...score, run_id: `baseline-${run}`, pair_id: `pair-${run}`, material_f1: 0.7 }));
  const product = [1, 2, 3].map((run) => ({ ...score, run_id: `product-${run}`, pair_id: `pair-${run}` }));
  const preferences = [1, 2, 3].map((run) => ({
    case_id: "late-correction",
    pair_id: `pair-${run}`,
    baseline_output_hash: "output-a",
    product_output_hash: "output-a",
    decision_time_ms: 100,
    preferred: run === 3 ? "baseline" as const : "product" as const
  }));
  const comparison = compareAgreementBenchmarkRuns({
    required_case_ids: ["late-correction"], baseline, product, preferences
  });
  assert.equal(comparison.passes, true);

  const failedBaseline = compareAgreementBenchmarkRuns({
    required_case_ids: ["late-correction"],
    baseline: baseline.map((run) => ({ ...run, failures: ["candidate generation was incomplete"] })),
    product,
    preferences
  });
  assert.equal(failedBaseline.passes, false);
  assert.ok(failedBaseline.failures.some((failure) => /baseline runs failed/.test(failure)));

  const unboundPreference = compareAgreementBenchmarkRuns({
    required_case_ids: ["late-correction"],
    baseline,
    product,
    preferences: preferences.map((preference, index) =>
      index === 0 ? { ...preference, product_output_hash: "different-output" } : preference
    )
  });
  assert.ok(unboundPreference.failures.some((failure) => /not bound to the scored outputs/.test(failure)));

  const duplicatePairs = compareAgreementBenchmarkRuns({
    required_case_ids: ["late-correction"],
    baseline: baseline.map((run) => ({ ...run, pair_id: "pair-1" })),
    product: product.map((run) => ({ ...run, pair_id: "pair-1" })),
    preferences: [preferences[0]]
  });
  assert.ok(duplicatePairs.failures.some((failure) => /three unique pair ids/.test(failure)));
});

test("six-case runner keeps gold behind generation and cannot pass a tied plain-agent comparison", async () => {
  const seenPrompts: string[] = [];
  const runArm = (mode: "plain-agent" | "review-surfaces") => runAgreementBenchmarkArm({
    root: BENCH_ROOT,
    mode,
    model_id: "fake-model",
    model_config_hash: "same-config",
    generate: async ({ prompt }) => {
      seenPrompts.push(prompt);
      assert.ok(!prompt.includes('"expected_state"'));
      return {
        final_goal: { text: "Review the requested work.", conversation_event_ids: ["u1"] },
        agreements: [],
        complete: true,
        limitations: []
      };
    },
    adjudicate: async () => ({ matches: [], false_positive_candidate_keys: [] })
  });
  const [baseline, product] = await Promise.all([runArm("plain-agent"), runArm("review-surfaces")]);
  assert.equal(baseline.scores.length, 18);
  assert.equal(product.scores.length, 18);
  assert.equal(seenPrompts.length, 36);
  for (const artifact of [...baseline.artifacts, ...product.artifacts]) {
    assert.equal(artifact.output_hash, crypto.createHash("sha256").update(artifact.markdown).digest("hex"));
  }
  const comparison = compareAgreementBenchmarkRuns({
    required_case_ids: baseline.case_ids,
    baseline: baseline.scores,
    product: product.scores,
    preferences: baseline.scores.map((score) => {
      const productScore = product.scores.find((candidate) => candidate.case_id === score.case_id && candidate.pair_id === score.pair_id)!;
      return {
        case_id: score.case_id,
        pair_id: score.pair_id,
        baseline_output_hash: score.output_hash,
        product_output_hash: productScore.output_hash,
        decision_time_ms: 100,
        preferred: "tie" as const
      };
    })
  });
  assert.equal(comparison.passes, false);
  assert.ok(comparison.failures.some((failure) => /macro-F1 uplift/.test(failure)));
  assert.ok(comparison.failures.some((failure) => /preference/.test(failure)));

  const missingCase = compareAgreementBenchmarkRuns({
    required_case_ids: baseline.case_ids,
    baseline: baseline.scores,
    product: product.scores.filter((score) => score.case_id !== "clean-alignment"),
    preferences: baseline.scores.filter((score) => score.case_id !== "clean-alignment").map((score) => {
      const productScore = product.scores.find((candidate) => candidate.case_id === score.case_id && candidate.pair_id === score.pair_id)!;
      return {
        case_id: score.case_id,
        pair_id: score.pair_id,
        baseline_output_hash: score.output_hash,
        product_output_hash: productScore.output_hash,
        decision_time_ms: 100,
        preferred: "product" as const
      };
    })
  });
  assert.ok(missingCase.failures.some((failure) => /manifest case set/.test(failure)));
});

test("benchmark runner rejects a fixture changed after the manifest was frozen", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agreement-benchmark-"));
  try {
    fs.cpSync(BENCH_ROOT, root, { recursive: true });
    fs.appendFileSync(path.join(root, "cases", "clean-alignment.input.json"), "\n");
    await assert.rejects(() => runAgreementBenchmarkArm({
      root,
      mode: "review-surfaces",
      model_id: "unreached",
      model_config_hash: "unreached",
      generate: async () => { throw new Error("generation must not start"); },
      adjudicate: async () => ({ matches: [], false_positive_candidate_keys: [] })
    }), /does not match its frozen SHA-256 digest/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fileDigest(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
