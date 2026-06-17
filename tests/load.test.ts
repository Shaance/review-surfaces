import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeEvaluationArtifact } from "../src/render/packet";
import { loadEvaluation, loadRisks } from "../src/render/load";
import { stringifyYaml } from "../src/core/simple-yaml";
import { EvaluationModel } from "../src/evaluation/evaluate";

// Phase 4a artifact loaders: a model written to evaluation.yaml and loaded back
// must reconstruct the same fields a monolithic `all` run would carry, so the
// composable flow (evaluate -> packet) equals the monolith.

function evaluationWithPartialReasons(): EvaluationModel {
  return {
    summary: "round-trip fixture",
    results: [
      {
        requirement_id: "REQ-1",
        acai_id: "review-surfaces.EVAL.1",
        status: "partial",
        summary: "implementation present, no exact test",
        partial_reason: "impl_no_test",
        evidence: [{ kind: "file", path: "src/a.ts", confidence: "medium" }],
        missing_evidence: [],
        review_focus: "Confirm a test exists",
        confidence: "medium"
      },
      {
        requirement_id: "REQ-2",
        acai_id: "review-surfaces.EVAL.2",
        status: "partial",
        summary: "broad area only",
        partial_reason: "broad_area_only",
        evidence: [],
        missing_evidence: [],
        review_focus: "",
        confidence: "low"
      },
      {
        requirement_id: "REQ-3",
        acai_id: "review-surfaces.EVAL.3",
        status: "satisfied",
        summary: "fully covered",
        evidence: [],
        missing_evidence: [],
        review_focus: "",
        confidence: "high"
      }
    ],
    overreach: [],
    acai_coverage: { "review-surfaces.EVAL.1": "partial", "review-surfaces.EVAL.3": "satisfied" }
  };
}

test("review-surfaces.EVAL loadEvaluation round-trip preserves partial_reason on partial results", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-load-roundtrip-"));
  try {
    const original = evaluationWithPartialReasons();
    await writeEvaluationArtifact(tmp, original);

    const loaded = loadEvaluation(tmp);
    assert.ok(loaded, "evaluation.yaml loads back");

    const byId = new Map(loaded!.results.map((result) => [result.requirement_id, result]));
    // The partial results keep their structured partial_reason labels.
    assert.equal(byId.get("REQ-1")?.status, "partial");
    assert.equal(byId.get("REQ-1")?.partial_reason, "impl_no_test");
    assert.equal(byId.get("REQ-2")?.status, "partial");
    assert.equal(byId.get("REQ-2")?.partial_reason, "broad_area_only");

    // A non-partial result has no partial_reason (it is partial-only).
    assert.equal(byId.get("REQ-3")?.status, "satisfied");
    assert.equal(byId.get("REQ-3")?.partial_reason, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.EVAL loadEvaluation ignores partial_reason on a non-partial status", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-load-nonpartial-"));
  try {
    // A malformed/stale artifact that put partial_reason on a satisfied result
    // must not carry it through: partial_reason is partial-only. Serialize with
    // the same writer the tool uses so the fixture parses identically.
    const stale = {
      summary: "stale",
      results: [
        {
          requirement_id: "REQ-1",
          acai_id: "review-surfaces.EVAL.1",
          status: "satisfied",
          summary: "covered",
          partial_reason: "impl_no_test",
          evidence: [],
          missing_evidence: [],
          review_focus: "",
          confidence: "high"
        }
      ],
      overreach: [],
      acai_coverage: {}
    };
    fs.writeFileSync(path.join(tmp, "evaluation.yaml"), stringifyYaml(stale));

    const loaded = loadEvaluation(tmp);
    assert.ok(loaded);
    assert.equal(loaded!.results[0]?.status, "satisfied");
    assert.equal(loaded!.results[0]?.partial_reason, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.RISK.4 loadRisks backfills missing-check lists from stale test_gaps", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-load-risks-stale-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "risks.yaml"),
      stringifyYaml({
        summary: "stale risks",
        items: [],
        test_evidence: [],
        test_gaps: [
          {
            id: "GAP-001",
            requirement_id: "REQ-043",
            acai_id: "review-surfaces.RISK.1",
            summary: "partial risk coverage",
            suggested_test: "Add a focused risk artifact test.",
            manual_check: "Inspect risks.yaml before trusting release coverage.",
            evidence: [{ kind: "spec", path: "features/review-surfaces.feature.yaml", confidence: "high" }]
          }
        ],
        review_focus: []
      })
    );

    const loaded = loadRisks(tmp);

    assert.ok(loaded);
    assert.equal(loaded!.missing_automatic_tests?.[0]?.id, "AUTO-001");
    assert.equal(loaded!.missing_automatic_tests?.[0]?.acai_id, "review-surfaces.RISK.1");
    assert.equal(loaded!.missing_automatic_tests?.[0]?.suggested_test, "Add a focused risk artifact test.");
    assert.equal(loaded!.missing_manual_checks?.[0]?.id, "MANUAL-001");
    assert.equal(loaded!.missing_manual_checks?.[0]?.acai_id, "review-surfaces.RISK.1");
    assert.equal(loaded!.missing_manual_checks?.[0]?.manual_check, "Inspect risks.yaml before trusting release coverage.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.RISK.7 loadRisks round-trips tested_how on the three gap lists", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-load-risks-tested-how-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "risks.yaml"),
      stringifyYaml({
        summary: "gaps with tested_how",
        items: [],
        test_evidence: [],
        test_gaps: [{ id: "GAP-001", summary: "gap", tested_how: "manual" }],
        missing_automatic_tests: [{ id: "CONV-GAP-001", summary: "auto gap", suggested_test: "add a test", tested_how: "unit" }],
        missing_manual_checks: [{ id: "CONV-GAP-002", summary: "manual gap", manual_check: "review it", tested_how: "mocked" }],
        review_focus: []
      })
    );
    const loaded = loadRisks(tmp);
    assert.ok(loaded);
    assert.equal(loaded!.test_gaps[0]?.tested_how, "manual");
    assert.equal(loaded!.missing_automatic_tests?.find((g) => g.id === "CONV-GAP-001")?.tested_how, "unit");
    assert.equal(loaded!.missing_manual_checks?.find((g) => g.id === "CONV-GAP-002")?.tested_how, "mocked");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
