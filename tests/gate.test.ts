import test from "node:test";
import assert from "node:assert/strict";
import { CollectionResult } from "../src/collector/collect";
import { EvaluationModel, RequirementResult, RequirementStatus } from "../src/evaluation/evaluate";
import { ExitCodes } from "../src/core/exit-codes";
import { gateDecision, gateExitCode } from "../src/core/gate";
import { ProviderName } from "../src/llm/provider";
import type { RiskItem } from "../src/risks/risks";
import { fileEvidence, llmProposedEvidence } from "../src/evidence/evidence";
import { projectRunSummary } from "../src/render/summary-json";
import type { ReviewPacket } from "../src/render/packet";
import { minimalReviewPacket } from "./helpers/review-packet";

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

// review-surfaces.QUALITY_GATE.1: the --fail-on risk-severity gate. A
// deterministic risk item at or above the threshold trips the quality gate (10);
// a risk below the threshold does not; and an LLM-hypothesis-only risk NEVER
// trips it (an unverified hypothesis is not proof).
function riskItem(severity: RiskItem["severity"], hypothesisOnly = false): RiskItem {
  return {
    id: `RISK-${severity}`,
    category: "correctness",
    severity,
    summary: `a ${severity} risk`,
    // A hypothesis-only item has ONLY llm_proposed evidence; a deterministic item
    // has a plain (non-LLM) evidence ref.
    evidence: hypothesisOnly
      ? [llmProposedEvidence("file", { path: "src/a.ts", note: "guessed risk" })]
      : [fileEvidence("src/a.ts", "deterministic risk")]
  };
}

test("review-surfaces.QUALITY_GATE.1 --fail-on trips on a deterministic risk at/above the threshold, not below, and never on a hypothesis", () => {
  const clean = evaluation([result("satisfied")]);

  // A HIGH risk with --fail-on high trips the quality gate (10).
  const highRisk = [riskItem("high")];
  assert.equal(
    gateExitCode(clean, collection(false), "mock", { maxMissing: 0, failOnSeverity: "high" }, highRisk),
    ExitCodes.qualityGateFailed,
    "a high risk at --fail-on high must trip the gate"
  );

  // A MEDIUM risk is BELOW the high threshold -> does not trip.
  const mediumRisk = [riskItem("medium")];
  assert.equal(
    gateExitCode(clean, collection(false), "mock", { maxMissing: 0, failOnSeverity: "high" }, mediumRisk),
    ExitCodes.success,
    "a risk below the threshold must not trip the gate"
  );

  // An LLM-HYPOTHESIS-ONLY high risk does NOT trip the gate (excluded as not proof).
  const hypothesisHigh = [riskItem("high", true)];
  assert.equal(
    gateExitCode(clean, collection(false), "mock", { maxMissing: 0, failOnSeverity: "high" }, hypothesisHigh),
    ExitCodes.success,
    "a hypothesis-only risk must never trip the deterministic risk gate"
  );

  // Without a threshold, even a critical risk is ignored (legacy behavior).
  assert.equal(
    gateExitCode(clean, collection(false), "mock", { maxMissing: 0 }, [riskItem("critical")]),
    ExitCodes.success,
    "no --fail-on threshold means packet.risks are not inspected"
  );

  // The reason names the --fail-on gate.
  const decision = gateDecision(clean, collection(false), "mock", { maxMissing: 0, failOnSeverity: "high" }, highRisk);
  assert.match(decision.reason, /--fail-on/);
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

// review-surfaces.QUALITY_GATE.1 (Codex finding 1): the --json run-summary's
// gate_code must reflect the SAME gate context the command applied — including the
// collection + provider. On an ai-sdk run whose redacted diff is
// remote_provider_blocked, applyGate returns privacy code 5; the projection MUST
// report 5 too (not a spurious 0 from a mock-context recompute). Without the
// context (renderer-only), it gates as a local mock run and never trips privacy.
test("review-surfaces.QUALITY_GATE.1 projectRunSummary gate_code reflects the real gate context (privacy block 5)", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  // A clean evaluation: the ONLY thing that can trip is the privacy short-circuit,
  // and only when the provider makes a remote call AND the diff is remote-blocked.
  const remoteBlocked = collection(true);

  // The command's real gate context: ai-sdk over a remote_provider_blocked diff -> 5.
  const blocked = projectRunSummary(packet, { maxMissing: 0 }, [], { collection: remoteBlocked, provider: "ai-sdk" });
  assert.equal(blocked.gate_code, ExitCodes.privacyBlocked, "ai-sdk over a remote-blocked diff must project gate_code 5, matching the strict gate exit");

  // Same packet, same options, but the renderer-only default context: a local mock
  // run can never privacy-block, so the projection reports a clean 0.
  const rendererDefault = projectRunSummary(packet, { maxMissing: 0 }, []);
  assert.equal(rendererDefault.gate_code, ExitCodes.success, "the renderer-only default context gates as a local mock run (no privacy block)");

  // And a mock provider is offline even over a remote-blocked diff, so it never trips 5.
  const mockBlocked = projectRunSummary(packet, { maxMissing: 0 }, [], { collection: remoteBlocked, provider: "mock" });
  assert.equal(mockBlocked.gate_code, ExitCodes.success, "an offline mock run never privacy-blocks");
});

// review-surfaces.QUALITY_GATE.2 (Codex finding 7): requirement_counts must carry
// EVERY contract status with its canonical name — no dropped "unknown", no
// renamed "invalid_evidence". This is the pure-projection guard for the shape.
test("review-surfaces.QUALITY_GATE.2 requirement_counts includes every contract status with canonical names", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  const summary = projectRunSummary(packet);
  assert.deepEqual(
    Object.keys(summary.requirement_counts).sort(),
    ["invalid_evidence", "missing", "overreach", "partial", "satisfied", "unknown"],
    "requirement_counts must include all six contract statuses with canonical names"
  );
  assert.equal((summary.requirement_counts as Record<string, number>).invalid, undefined, "must not use the renamed 'invalid' bucket");
});

// review-surfaces.QUALITY_GATE.2 (Codex finding 4): gateDecision counts
// invalid_evidence across BOTH evaluation.results AND evaluation.overreach (an
// overreach finding can itself fail evidence validation), so the projection's
// requirement_counts.invalid_evidence MUST do the same — otherwise gate_code (4)
// and the JSON counts (0 invalid) would disagree.
test("review-surfaces.QUALITY_GATE.2 invalid_evidence in an overreach entry is counted in requirement_counts AND trips gate_code 4", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  // Clean results; the ONLY invalid_evidence lives in an OVERREACH entry.
  packet.evaluation.results = [result("satisfied")];
  packet.evaluation.overreach = [result("invalid_evidence", "OVERREACH-001")];

  const summary = projectRunSummary(packet);
  assert.equal(
    summary.requirement_counts.invalid_evidence,
    1,
    "an overreach entry with status invalid_evidence must be counted in requirement_counts.invalid_evidence (matching gateDecision)"
  );
  // The `overreach` bucket stays the count of evaluation.overreach entries.
  assert.equal(summary.requirement_counts.overreach, 1, "the overreach bucket is the evaluation.overreach total");
  // And the gate_code agrees: the evidence gate (4) trips on the overreach invalid.
  assert.equal(
    summary.gate_code,
    ExitCodes.evidenceValidationFailed,
    "the same overreach invalid_evidence that the count reflects must trip gate_code 4"
  );
  // Cross-check against gateDecision directly over the same evaluation.
  assert.equal(
    gateExitCode(packet.evaluation as unknown as EvaluationModel, collection(false), "mock", DEFAULT_OPTIONS),
    ExitCodes.evidenceValidationFailed,
    "gateDecision counts the overreach invalid_evidence too, so the count and the code share one source of truth"
  );
});

// review-surfaces.QUALITY_GATE.2 (Codex finding 5): the no-human_review fallback
// for top_queue_ids must list only DETERMINISTIC risk ids — an LLM-hypothesis-only
// risk is never proof, so it is excluded here exactly as the gate and the
// risk-severity histogram exclude it. Passing an EMPTY queueIds forces the fallback.
test("review-surfaces.QUALITY_GATE.2 fallback top_queue_ids excludes LLM-hypothesis-only risks", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  packet.risks.items = [
    riskItem("high"),            // deterministic -> id "RISK-high"
    riskItem("medium", true),    // hypothesis-only -> id "RISK-medium" (must be dropped)
    riskItem("low")              // deterministic -> id "RISK-low"
  ] as unknown as ReviewPacket["risks"]["items"];

  // Empty queueIds -> the projection uses the deterministic risk-id fallback.
  const summary = projectRunSummary(packet, { maxMissing: 0 }, []);
  assert.deepEqual(
    summary.top_queue_ids,
    ["RISK-high", "RISK-low"],
    "the fallback queue must keep deterministic risk ids in order and drop the hypothesis-only risk"
  );
  assert.ok(
    !summary.top_queue_ids.includes("RISK-medium"),
    "an LLM-hypothesis-only risk must never appear in the fallback queue"
  );
});
