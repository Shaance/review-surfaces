import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGREEMENT_BENCHMARK_VERSION,
  compareAgreementBenchmarkRuns,
  parseAgreementBenchmarkGold,
  parseAgreementBenchmarkManifest,
  scoreAgreementBenchmarkRun
} from "../src/audit/benchmark";
import { runAgreementBenchmarkPair } from "../src/audit/benchmark-runner";
import { agreementBenchmarkOutputHash } from "../src/audit/benchmark-shared";
import type { AgreementAuditCandidate } from "../src/audit/contract";
import { groundAgreementAudit } from "../src/audit/grounding";
import { parseAgreementAuditInput } from "../src/audit/parse";
import { buildAuditPrompt } from "../src/audit/prompt";
import type { AgreementAdjudication, AgreementBenchmarkGold } from "../src/audit/benchmark";
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
    assert.match(product, /failed exact-head command contradicts a claimed pass/);
    assert.match(product, /every diverged agreement and every material unresolved agreement/);
    assert.doesNotMatch(product, /string \| undefined/);
  }
});

test("agreement benchmark includes a case larger than the legacy eight-item cap", () => {
  const gold = readJson<AgreementBenchmarkGold>(path.join(BENCH_ROOT, "cases", "large-agreement-set.gold.json"));
  assert.equal(gold.agreements.length, 10);
  const rename = gold.agreements.find((agreement) => agreement.id === "rename")!;
  assert.equal(rename.expected_state, "fulfilled");
  assert.deepEqual(rename.expected_diff_coordinates, [{ path: "src/job.ts", side: "add", line: 1 }]);
});

test("gold parsing rejects duplicate or wrong-role governing events", () => {
  const input = loadInput("clean-alignment");
  assert.throws(() => parseAgreementBenchmarkGold({
    version: AGREEMENT_BENCHMARK_VERSION,
    case_id: "invalid",
    source: "synthetic",
    clean: false,
    agreements: [{
      id: "bad",
      kind: "human_instruction",
      materiality: "material",
      expected_state: "unresolved",
      governing_event_ids: ["a1", "a1"],
      expected_diff_coordinates: [],
      expected_command_ids: []
    }]
  }, input), /non-user governing event|must be unique/);
});

test("gold parsing rejects command evidence not bound to the benchmark head", () => {
  const gold = readJson(path.join(BENCH_ROOT, "cases", "validation-contradiction.gold.json"));
  for (const headSha of [undefined, "a".repeat(40)]) {
    const input = loadInput("validation-contradiction");
    input.commands[0].head_sha = headSha;
    assert.throws(() => parseAgreementBenchmarkGold(gold, input), /not bound to the benchmark head/);
  }
});

test("gold parsing rejects evidence combinations grounding cannot satisfy", () => {
  const gold = readJson(path.join(BENCH_ROOT, "cases", "validation-contradiction.gold.json"));
  for (const status of ["passed", "unknown"] as const) {
    const input = loadInput("validation-contradiction");
    input.commands[0].status = status;
    assert.throws(() => parseAgreementBenchmarkGold(gold, input), /cannot be grounded.*failed exact-head command/);
  }
});

test("gold parsing rejects an empty diff line that candidates cannot cite", () => {
  const input = loadInput("late-correction");
  input.diff[0].text = "";
  const gold = readJson(path.join(BENCH_ROOT, "cases", "late-correction.gold.json"));
  assert.throws(() => parseAgreementBenchmarkGold(gold, input), /empty diff line that candidates cannot anchor/);
});

test("benchmark manifest paths cannot escape the benchmark root", () => {
  const manifest = (input: string) => ({
    version: AGREEMENT_BENCHMARK_VERSION,
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
      agreement({ key: "wording-b", kind: "human_boundary", statement: "A retained privacy rule is deleted.", state: "diverged", conversation_event_ids: ["u2"], diff_citations: [{ path: "src/privacy/ignore.ts", side: "delete", line: 4, contains: "DerivedData" }], reviewer_action: "Restore it." }),
      agreement({ key: "wording-e", kind: "human_boundary", statement: "A retained privacy regression test is deleted.", state: "diverged", conversation_event_ids: ["u2"], diff_citations: [{ path: "tests/privacy.test.ts", side: "delete", line: 10, contains: "isIgnored" }], reviewer_action: "Restore the regression test." })
    ],
    complete: true,
    limitations: []
  };
  const audit = groundAgreementAudit(input, candidate);
  const gold = parseAgreementBenchmarkGold(readJson(path.join(BENCH_ROOT, "cases", "late-correction.gold.json")), input);
  const adjudication = {
    matches: [
      { candidate_key: "wording-a", gold_id: "remove-swift-code" },
      { candidate_key: "wording-c", gold_id: "remove-swift-docs" },
      { candidate_key: "wording-d", gold_id: "remove-swift-tests" },
      { candidate_key: "wording-b", gold_id: "retain-privacy-defaults" },
      { candidate_key: "wording-e", gold_id: "retain-privacy-tests" }
    ],
    false_positive_candidate_keys: []
  };
  const runMetadata = {
    run_id: "product-1",
    pair_id: "pair-1",
    model_id: "model-a",
    model_config_hash: "config-a",
    input_hash: "input-a",
    output_hash: "output-a",
    generation_ms: 1
  };
  const score = scoreAgreementBenchmarkRun(audit, gold, adjudication, runMetadata);
  assert.equal(score.material_f1, 1);
  assert.deepEqual(score.failures, []);

  assert.throws(() => scoreAgreementBenchmarkRun(audit, gold, {
    matches: [{ candidate_key: "missing", gold_id: "remove-swift-code" }],
    false_positive_candidate_keys: []
  }, runMetadata), /unknown candidate missing/);
  assert.throws(() => scoreAgreementBenchmarkRun(audit, gold, {
    matches: [
      { candidate_key: "wording-a", gold_id: "remove-swift-code" },
      { candidate_key: "wording-a", gold_id: "remove-swift-docs" }
    ],
    false_positive_candidate_keys: []
  }, runMetadata), /must be one-to-one/);
  assert.throws(() => scoreAgreementBenchmarkRun(audit, gold, {
    matches: [],
    false_positive_candidate_keys: ["missing"]
  }, runMetadata), /unknown false-positive candidate missing/);
  assert.throws(() => scoreAgreementBenchmarkRun(
    audit,
    gold,
    null,
    runMetadata
  ), /adjudication must be an object/);

  const unrelatedEvidenceAudit = {
    ...audit,
    agreements: audit.agreements.map((item) =>
      item.key === "wording-e"
        ? { ...item, diff_citations: audit.agreements.find((candidate) => candidate.key === "wording-a")!.diff_citations }
        : item
    )
  };
  const unrelatedEvidenceScore = scoreAgreementBenchmarkRun(unrelatedEvidenceAudit, gold, adjudication, {
    ...runMetadata,
    run_id: "unrelated-evidence",
    pair_id: "unrelated-evidence",
    output_hash: "output-unrelated-evidence"
  });
  assert.ok(unrelatedEvidenceScore.material_f1 < 1);
  assert.equal(unrelatedEvidenceScore.exact_citation_gate, false);
  assert.ok(unrelatedEvidenceScore.failures.some((failure) => /exact evidence/.test(failure)));

  const overCitedAudit = {
    ...audit,
    agreements: audit.agreements.map((item) =>
      item.key === "wording-a" ? { ...item, conversation_event_ids: ["u1", "u2"] } : item
    )
  };
  const overCitedScore = scoreAgreementBenchmarkRun(overCitedAudit, gold, adjudication, {
    ...runMetadata,
    run_id: "over-cited",
    pair_id: "over-cited",
    output_hash: "output-over-cited"
  });
  assert.ok(overCitedScore.material_f1 < 1);

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

  const malformedPreference = compareAgreementBenchmarkRuns({
    required_case_ids: ["late-correction"],
    baseline,
    product,
    preferences: preferences.map((preference, index) =>
      index === 2 ? { ...preference, preferred: "invalid" as "product" } : preference
    )
  });
  assert.equal(malformedPreference.passes, false);
  assert.ok(malformedPreference.failures.some((failure) => /preference outcome is invalid/.test(failure)));

  const mixedModel = compareAgreementBenchmarkRuns({
    required_case_ids: ["late-correction"],
    baseline: baseline.map((run, index) => index === 2 ? { ...run, model_id: "model-b", model_config_hash: "config-b" } : run),
    product: product.map((run, index) => index === 2 ? { ...run, model_id: "model-b", model_config_hash: "config-b" } : run),
    preferences
  });
  assert.ok(mixedModel.failures.some((failure) => /one model and config across all runs/.test(failure)));

  const mixedInput = compareAgreementBenchmarkRuns({
    required_case_ids: ["late-correction"],
    baseline: baseline.map((run, index) => index === 2 ? { ...run, input_hash: "input-b" } : run),
    product: product.map((run, index) => index === 2 ? { ...run, input_hash: "input-b" } : run),
    preferences
  });
  assert.ok(mixedInput.failures.some((failure) => /one frozen input across all runs/.test(failure)));

  const invalidRecordedScore = compareAgreementBenchmarkRuns({
    required_case_ids: ["late-correction"],
    baseline,
    product: product.map((run, index) => index === 0 ? { ...run, material_f1: 99 } : run),
    preferences
  });
  assert.equal(invalidRecordedScore.passes, false);
  assert.ok(invalidRecordedScore.failures.some((failure) => /invalid recorded fields/.test(failure)));
  assert.ok(Number.isFinite(invalidRecordedScore.product_macro_f1));

  const nullRecordedScore = compareAgreementBenchmarkRuns({
    required_case_ids: ["late-correction"],
    baseline,
    product: [null, ...product.slice(1)] as unknown as typeof product,
    preferences
  });
  assert.equal(nullRecordedScore.passes, false);
  assert.ok(nullRecordedScore.failures.some((failure) => /invalid recorded fields/.test(failure)));

  const blankBindingScore = compareAgreementBenchmarkRuns({
    required_case_ids: ["late-correction"],
    baseline,
    product: product.map((run, index) => index === 0 ? { ...run, output_hash: "   " } : run),
    preferences
  });
  assert.equal(blankBindingScore.passes, false);
  assert.ok(blankBindingScore.failures.some((failure) => /invalid recorded fields/.test(failure)));

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
  const { baseline, product } = await runAgreementBenchmarkPair({
    root: BENCH_ROOT,
    model_id: "fake-model",
    model_config_hash: "same-config",
    generate: async (request) => {
      assert.equal("case_id" in request, false);
      const { prompt } = request;
      seenPrompts.push(prompt);
      assert.ok(!prompt.includes('"expected_state"'));
      return emptyCandidate();
    },
    adjudicate: async () => emptyAdjudication()
  });
  assert.equal(baseline.scores.length, 18);
  assert.equal(product.scores.length, 18);
  assert.equal(seenPrompts.length, 36);
  for (const artifact of [...baseline.artifacts, ...product.artifacts]) {
    assert.equal(
      artifact.output_hash,
      agreementBenchmarkOutputHash(artifact.audit, artifact.markdown)
    );
    assert.notEqual(
      artifact.output_hash,
      agreementBenchmarkOutputHash(
        { ...artifact.audit, candidate_complete: !artifact.audit.candidate_complete },
        artifact.markdown
      )
    );
    assert.notEqual(artifact.output_hash, agreementBenchmarkOutputHash(artifact.audit, `${artifact.markdown}\n`));
    assert.notEqual(artifact.output_hash, crypto.createHash("sha256").update(artifact.markdown).digest("hex"));
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

test("concurrent benchmark generation finishes before any hidden gold is exposed", async () => {
  let generationCount = 0;
  await runAgreementBenchmarkPair({
    root: BENCH_ROOT,
    model_id: "fake-model",
    model_config_hash: "same-config",
    case_concurrency: 3,
    generate: async () => {
      generationCount += 1;
      return emptyCandidate();
    },
    adjudicate: async () => {
      assert.equal(generationCount, 36);
      return emptyAdjudication();
    }
  });
});

test("adjudicator mutation cannot alter scored audits or hidden gold", async () => {
  const { baseline, product } = await runAgreementBenchmarkPair({
    root: BENCH_ROOT,
    model_id: "fake-model",
    model_config_hash: "same-config",
    generate: async () => emptyCandidate(),
    adjudicate: async ({ audit, gold }) => {
      audit.limitations.push("adjudicator mutation");
      gold.agreements.length = 0;
      return emptyAdjudication();
    }
  });
  assert.ok([...baseline.scores, ...product.scores].every((score) => score.recall === 0));
  assert.ok([...baseline.artifacts, ...product.artifacts].every((artifact) =>
    !artifact.audit.limitations.includes("adjudicator mutation")
  ));
});

test("concurrent benchmark workers stop scheduling generation after the first failure", async () => {
  let generationCount = 0;
  let releaseBlockedGeneration!: () => void;
  const blockedGeneration = new Promise<void>((resolve) => { releaseBlockedGeneration = resolve; });
  const run = runAgreementBenchmarkPair({
    root: BENCH_ROOT,
    model_id: "fake-model",
    model_config_hash: "same-config",
    case_concurrency: 2,
    generate: async () => {
      generationCount += 1;
      if (generationCount === 1) {
        await Promise.resolve();
        throw new Error("provider failed");
      }
      await blockedGeneration;
      return emptyCandidate();
    },
    adjudicate: async () => emptyAdjudication()
  });
  await assert.rejects(run, /provider failed/);
  releaseBlockedGeneration();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(generationCount, 2);
});

test("benchmark runner rejects changed input or gold before provider generation", async () => {
  for (const file of ["large-agreement-set.input.json", "large-agreement-set.gold.json"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agreement-benchmark-"));
    try {
      fs.cpSync(BENCH_ROOT, root, { recursive: true });
      fs.appendFileSync(path.join(root, "cases", file), "\n");
      let generationCount = 0;
      await assert.rejects(() => runAgreementBenchmarkPair({
        root,
        model_id: "unreached",
        model_config_hash: "unreached",
        generate: async () => {
          generationCount += 1;
          throw new Error("generation must not start");
        },
        adjudicate: async () => emptyAdjudication()
      }), /does not match its frozen SHA-256 digest/);
      assert.equal(generationCount, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function fileDigest(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function emptyCandidate(): AgreementAuditCandidate {
  return {
    final_goal: { text: "Review the requested work.", conversation_event_ids: ["u1"] },
    agreements: [],
    complete: true,
    limitations: []
  };
}

function emptyAdjudication(): AgreementAdjudication {
  return { matches: [], false_positive_candidate_keys: [] };
}
