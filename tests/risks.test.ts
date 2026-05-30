import test from "node:test";
import assert from "node:assert/strict";
import { CollectionResult } from "../src/collector/collect";
import { fileEvidence, missingEvidence, specEvidence } from "../src/evidence/evidence";
import { EvaluationModel, RequirementResult } from "../src/evaluation/evaluate";
import { analyzeRisks, RiskItem } from "../src/risks/risks";

test("review-surfaces.RISK.1 review-surfaces.RISK.3 review-surfaces.RISK.5 emits an evidence-backed risk register", () => {
  const risks = analyzeRisks(collectionFixture(), evaluationFixture(), []);

  assert.ok(risks.items.length >= 3, "risk register includes risk items");
  assert.ok(risks.test_evidence.length >= 1, "risk model includes test evidence");
  assert.ok(risks.test_gaps.length >= 1, "risk model includes test gaps");
  assert.ok(risks.review_focus.length >= 1, "risk model includes review focus");

  for (const risk of risks.items) {
    assert.ok(risk.summary);
    assertRiskLabels(risk);
    assert.ok(risk.suggested_checks?.length, `${risk.id} should include suggested checks`);
    assert.ok(risk.evidence?.length, `${risk.id} should cite evidence or a missing-evidence marker`);
    assert.ok(
      risk.evidence.some((ref) => ref.kind === "unknown" || ref.path || ref.acai_id || ref.command || ref.event_id || ref.llm_proposed),
      `${risk.id} should not be an unsupported assertion`
    );
  }
});

test("review-surfaces.RISK.4 lists missing automatic tests separately from missing manual checks", () => {
  const risks = analyzeRisks(collectionFixture(), evaluationFixture(), []);

  assert.ok(risks.missing_automatic_tests?.length, "automatic test gaps are first-class");
  assert.ok(risks.missing_manual_checks?.length, "manual checks are first-class");
  assert.equal(risks.missing_automatic_tests?.[0].acai_id, "review-surfaces.RISK.1");
  assert.equal(risks.missing_manual_checks?.[0].acai_id, "review-surfaces.RISK.1");
  assert.ok(risks.missing_automatic_tests?.every((gap) => gap.suggested_test && !("manual_check" in gap)));
  assert.ok(risks.missing_manual_checks?.every((gap) => gap.manual_check && !("suggested_test" in gap)));
});

function collectionFixture(): CollectionResult {
  return {
    changedFiles: [{ path: "src/risks/risks.ts", status: "M", source: "working_tree" }],
    feedback: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    commandTranscripts: [
      {
        id: "CMD-RISK-TEST",
        command: "pnpm run test",
        status: "passed",
        exit_code: 0,
        truncated: false,
        source_path: ".review-surfaces/commands/risk.json"
      }
    ]
  } as unknown as CollectionResult;
}

function evaluationFixture(): EvaluationModel {
  return {
    summary: "risk fixture",
    results: [
      result("REQ-RISK-1", "review-surfaces.RISK.1", "missing", "No risk artifact proof yet.", [], [
        specEvidence("features/review-surfaces.feature.yaml", "review-surfaces.RISK.1")
      ]),
      result("REQ-RISK-3", "review-surfaces.RISK.3", "partial", "Risk labels need exact test evidence.", [
        fileEvidence("src/risks/risks.ts", "RiskItem preserves severity, likelihood, and detectability.")
      ]),
      result("REQ-RISK-5", "review-surfaces.RISK.5", "unknown", "Evidence-backed risk findings need manual confirmation.", [], [
        missingEvidence("No evidence citation supplied for this fixture requirement.")
      ])
    ],
    overreach: [
      result("OVER-001", undefined, "overreach", "Changed file did not map to an explicit requirement.", [
        fileEvidence("src/unmapped.ts", "Unmapped fixture file.")
      ])
    ],
    acai_coverage: {
      "review-surfaces.RISK.1": "missing",
      "review-surfaces.RISK.3": "partial",
      "review-surfaces.RISK.5": "unknown"
    }
  };
}

function result(
  requirementId: string,
  acaiId: string | undefined,
  status: RequirementResult["status"],
  summary: string,
  evidence = [fileEvidence("src/risks/risks.ts")],
  missing = [missingEvidence("missing fixture evidence")]
): RequirementResult {
  return {
    requirement_id: requirementId,
    acai_id: acaiId,
    status,
    summary,
    evidence,
    missing_evidence: missing,
    review_focus: "Inspect risk analyzer output.",
    confidence: "medium"
  };
}

function assertRiskLabels(risk: RiskItem): void {
  assert.ok(["low", "medium", "high", "critical", "unknown"].includes(risk.severity));
  assert.ok(risk.likelihood === undefined || ["low", "medium", "high", "unknown"].includes(risk.likelihood));
  assert.ok(risk.detectability === undefined || ["easy", "moderate", "hard", "unknown"].includes(risk.detectability));
}
