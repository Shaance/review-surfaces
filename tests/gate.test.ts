import test from "node:test";
import assert from "node:assert/strict";
import { CollectionResult } from "../src/collector/collect";
import { EvaluationModel, RequirementResult, RequirementStatus } from "../src/evaluation/evaluate";
import { ExitCodes } from "../src/core/exit-codes";
import { gateDecision, gateExitCode } from "../src/core/gate";
import { ProviderName } from "../src/llm/provider";

// gateExitCode only reads evaluation.results/overreach statuses and
// collection.privacy.remote_provider_blocked, so the test fixtures are minimal.

function result(status: RequirementStatus, requirementId = "REQ-1"): RequirementResult {
  return {
    requirement_id: requirementId,
    status,
    summary: `status ${status}`,
    evidence: [],
    missing_evidence: [],
    review_focus: "",
    confidence: "medium"
  };
}

function evaluation(results: RequirementResult[], overreach: RequirementResult[] = []): EvaluationModel {
  return { summary: "", results, overreach, acai_coverage: {} };
}

function collection(remoteBlocked: boolean): CollectionResult {
  return {
    privacy: { remote_provider_blocked: remoteBlocked }
  } as unknown as CollectionResult;
}

const DEFAULT_OPTIONS = { maxMissing: 0 };

test("review-surfaces.QUALITY.7 clean evaluation returns success (0) regardless of strict", () => {
  const clean = evaluation([result("satisfied"), result("partial", "REQ-2")]);
  assert.equal(gateExitCode(clean, collection(false), "mock", DEFAULT_OPTIONS), ExitCodes.success);
  assert.equal(gateExitCode(clean, collection(false), "ai-sdk", DEFAULT_OPTIONS), ExitCodes.success);
});

test("review-surfaces.EVIDENCE.4 invalid_evidence in results trips evidenceValidationFailed (4)", () => {
  const evalModel = evaluation([result("satisfied"), result("invalid_evidence", "REQ-2")]);
  assert.equal(gateExitCode(evalModel, collection(false), "mock", DEFAULT_OPTIONS), ExitCodes.evidenceValidationFailed);
});

test("review-surfaces.EVIDENCE.4 invalid_evidence in overreach also trips evidenceValidationFailed (4)", () => {
  const evalModel = evaluation([result("satisfied")], [result("invalid_evidence", "OVERREACH-001")]);
  assert.equal(gateExitCode(evalModel, collection(false), "mock", DEFAULT_OPTIONS), ExitCodes.evidenceValidationFailed);
});

test("review-surfaces.PRIVACY.2 ONLY a remote-calling provider (ai-sdk) trips privacyBlocked (5)", () => {
  const clean = evaluation([result("satisfied")]);
  // ai-sdk leaves the machine, so a remote-blocked diff MUST privacy-block.
  assert.equal(gateExitCode(clean, collection(true), "ai-sdk", DEFAULT_OPTIONS), ExitCodes.privacyBlocked);
});

test("review-surfaces.PRIVACY.2 agent-file is OFFLINE and must NOT privacy-block (continues to evidence/quality gates)", () => {
  // agent-file only reads a LOCAL --agent-input file; no remote call happens, so
  // a remote_provider_blocked diff must NOT short-circuit to code 5. A clean
  // evaluation continues through and passes (0).
  const clean = evaluation([result("satisfied")]);
  assert.equal(gateExitCode(clean, collection(true), "agent-file", DEFAULT_OPTIONS), ExitCodes.success);

  // And it still REACHES the downstream gates rather than stopping at privacy:
  // invalid_evidence -> 4, missing -> 10, even when remote-blocked.
  const badEvidence = evaluation([result("invalid_evidence")]);
  assert.equal(gateExitCode(badEvidence, collection(true), "agent-file", DEFAULT_OPTIONS), ExitCodes.evidenceValidationFailed);
  const missing = evaluation([result("missing")]);
  assert.equal(gateExitCode(missing, collection(true), "agent-file", DEFAULT_OPTIONS), ExitCodes.qualityGateFailed);
});

test("review-surfaces.PRIVACY.2 mock provider never trips privacyBlocked even when remote-blocked", () => {
  const clean = evaluation([result("satisfied")]);
  assert.equal(gateExitCode(clean, collection(true), "mock", DEFAULT_OPTIONS), ExitCodes.success);
});

test("review-surfaces.QUALITY.7 missing requirements trip qualityGateFailed (10) at default max_missing 0", () => {
  const evalModel = evaluation([result("satisfied"), result("missing", "REQ-2")]);
  assert.equal(gateExitCode(evalModel, collection(false), "mock", DEFAULT_OPTIONS), ExitCodes.qualityGateFailed);
});

test("review-surfaces.QUALITY.7 max_missing tolerance suppresses the quality gate", () => {
  const evalModel = evaluation([result("missing"), result("missing", "REQ-2")]);
  // 2 missing, allowed up to 2 -> success; allowed up to 1 -> fail.
  assert.equal(gateExitCode(evalModel, collection(false), "mock", { maxMissing: 2 }), ExitCodes.success);
  assert.equal(gateExitCode(evalModel, collection(false), "mock", { maxMissing: 1 }), ExitCodes.qualityGateFailed);
});

test("review-surfaces.QUALITY.7 gate ordering: privacy (5) before evidence (4) before quality (10)", () => {
  // All three conditions present at once.
  const all = evaluation(
    [result("invalid_evidence"), result("missing", "REQ-2")],
    [result("invalid_evidence", "OVERREACH-001")]
  );
  // privacy wins first
  assert.equal(gateExitCode(all, collection(true), "ai-sdk", DEFAULT_OPTIONS), ExitCodes.privacyBlocked);

  // with mock provider, privacy never applies -> evidence (4) wins over quality (10)
  assert.equal(gateExitCode(all, collection(true), "mock", DEFAULT_OPTIONS), ExitCodes.evidenceValidationFailed);

  // evidence (4) before quality (10) even with a non-mock provider when not remote-blocked
  assert.equal(gateExitCode(all, collection(false), "ai-sdk", DEFAULT_OPTIONS), ExitCodes.evidenceValidationFailed);

  // only missing requirements remain -> quality (10)
  const onlyMissing = evaluation([result("missing")]);
  assert.equal(gateExitCode(onlyMissing, collection(false), "ai-sdk", DEFAULT_OPTIONS), ExitCodes.qualityGateFailed);
});

test("review-surfaces.QUALITY.7 gateDecision returns a reason string for each tripped gate", () => {
  const providerName: ProviderName = "ai-sdk";
  const privacy = gateDecision(evaluation([result("satisfied")]), collection(true), providerName, DEFAULT_OPTIONS);
  assert.equal(privacy.code, ExitCodes.privacyBlocked);
  assert.match(privacy.reason, /Privacy block/);

  const evidence = gateDecision(evaluation([result("invalid_evidence")]), collection(false), "mock", DEFAULT_OPTIONS);
  assert.equal(evidence.code, ExitCodes.evidenceValidationFailed);
  assert.match(evidence.reason, /invalid_evidence/);

  const quality = gateDecision(evaluation([result("missing")]), collection(false), "mock", DEFAULT_OPTIONS);
  assert.equal(quality.code, ExitCodes.qualityGateFailed);
  assert.match(quality.reason, /missing requirement/);

  const ok = gateDecision(evaluation([result("satisfied")]), collection(false), "mock", DEFAULT_OPTIONS);
  assert.equal(ok.code, ExitCodes.success);
});

// review-surfaces.QUALITY: an allowlisted "missing" requirement (a planned,
// not-yet-implemented backlog) is excluded from the gate count, but an UNRELATED
// requirement regressing to missing still trips the gate — the allowlist must
// not mask a swapped regression.
test("review-surfaces.QUALITY allow_missing excludes the planned backlog but not other regressions", () => {
  const planned = evaluation([result("missing", "REQ-PLANNED-1"), result("missing", "REQ-PLANNED-2")]);
  const allowed = { maxMissing: 0, allowMissing: ["REQ-PLANNED-1", "REQ-PLANNED-2"] };
  // Both missing requirements are allowlisted -> gate passes at maxMissing 0.
  assert.equal(gateExitCode(planned, collection(false), "mock", allowed), ExitCodes.success);

  // An unrelated requirement regresses to missing while the planned ones stay
  // missing: the total count is unchanged, but the regression is NOT allowlisted,
  // so the gate trips.
  const swapped = evaluation([
    result("missing", "REQ-PLANNED-1"),
    result("missing", "REQ-PLANNED-2"),
    result("missing", "REQ-REGRESSION")
  ]);
  assert.equal(gateExitCode(swapped, collection(false), "mock", allowed), ExitCodes.qualityGateFailed);
});

// review-surfaces.QUALITY: a blank allow_missing entry must not match a result
// that simply has no acai_id (which would silently exclude it from the gate).
test("review-surfaces.QUALITY blank allow_missing entries are ignored", () => {
  const evalModel = evaluation([result("missing", "REQ-NO-ACID")]);
  const withBlank = { maxMissing: 0, allowMissing: ["", "review-surfaces.PLANNED.1"] };
  assert.equal(
    gateExitCode(evalModel, collection(false), "mock", withBlank),
    ExitCodes.qualityGateFailed,
    "a blank allowlist entry must not exclude a non-Acai missing requirement"
  );
});
