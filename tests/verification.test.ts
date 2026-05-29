import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectInputs } from "../src/collector/collect";
import { defaultConfig } from "../src/config/config";
import { buildIntent } from "../src/intent/intent";
import { evaluateIntent, RequirementResult, verifyRequirementsWithTests } from "../src/evaluation/evaluate";
import { runEvaluationReasoning } from "../src/llm/reasoning";
import { ReasoningProvider, StructuredResult } from "../src/llm/provider";
import { MethodologyModel } from "../src/methodology/methodology";
import { analyzeRisks, RisksModel } from "../src/risks/risks";
import { validateJsonSchema } from "../src/schema/json-schema";
import { ReviewArea } from "../src/review-areas/areas";
import { defaultReviewSurfacesAreas } from "./helpers/review-areas";

// VERIFICATION LOOP (#2): partial -> satisfied ONLY when a real, parsed, PASSING
// test that MAPS to the requirement verifies it. The fixtures here drive the
// pass through evaluateIntent + verifyRequirementsWithTests (and, for the
// LLM-pinpointed path, runEvaluationReasoning with an injected stub provider).
// No network. Every HARD INVARIANT in the task gets its own assertion.

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

function batchedEvidence(entries: unknown[]): Record<string, unknown> {
  return { requirements: entries };
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
  return { summary: "risks", items: [], test_evidence: [], test_gaps: [], review_focus: [] };
}

// Build a temp repo with a single EVAL requirement, a BROAD implementation file
// (changed src file, no exact ACID mention) and an optional JUnit report. With
// the broad impl alone the evaluator yields a partial (impl present, no exact
// proof); the verification loop only promotes when a mapping passing test exists.
async function setupEvalRepo(options: {
  junitXml?: string;
  implMentionsAcid?: boolean;
}): Promise<{ tmp: string; collection: Awaited<ReturnType<typeof collectInputs>>; intent: Awaited<ReturnType<typeof buildIntent>> }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-verify-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: Evaluate implementation.
`
  );
  // Broad implementation: a real changed file in the EVAL area. It does NOT
  // mention the ACID (so it is broad impl, not exact) unless asked.
  fs.writeFileSync(
    path.join(tmp, "src", "evaluation", "evaluate.ts"),
    options.implMentionsAcid ? "export const acid = 'example.EVAL.1';\n" : "export const evaluate = true;\n"
  );
  if (options.junitXml !== undefined) {
    fs.writeFileSync(path.join(tmp, "junit.xml"), options.junitXml);
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    testOutputPaths: options.junitXml !== undefined ? ["junit.xml"] : undefined,
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/evaluation/evaluate.ts", status: "A", source: "working_tree" }];
  const intent = await buildIntent(tmp, collection);
  return { tmp, collection, intent };
}

// A passing JUnit case whose classname names the EVAL group token but does NOT
// reference the exact ACID, so it is GROUP-mapped (not exact-ACID-mapped). After
// the per-requirement tightening this NO LONGER promotes: it attaches as
// verified-but-broad test evidence and the requirement stays partial.
const GROUP_MAPPED_PASSING = `<?xml version="1.0"?>
<testsuite name="eval">
  <testcase name="eval area behaves correctly" classname="suite.EVAL" time="0.01"/>
</testsuite>
`;

// A passing JUnit case whose name references the EXACT ACID example.EVAL.1, so it
// is per-requirement proof (path (a)). With a broad impl this is a partial that
// the verification loop promotes to satisfied (deterministic, high confidence).
const EXACT_ACID_PASSING = `<?xml version="1.0"?>
<testsuite name="eval">
  <testcase name="example.EVAL.1 evaluator behaves correctly" classname="suite.EVAL" time="0.01"/>
</testsuite>
`;

test("VERIFICATION #2 genuine promotion: a passing EXACT-ACID test + impl promotes partial -> satisfied with a verified marker", async () => {
  const { collection, intent } = await setupEvalRepo({ junitXml: EXACT_ACID_PASSING });

  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  // Before verification: broad implementation + exact test ACID evidence, but no
  // EXACT implementation ACID => partial (impl_broad_no_exact_test).
  const before = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(before?.status, "partial", "broad impl + exact-ACID test is partial pre-verification");

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "satisfied", "a passing exact-ACID test promotes partial -> satisfied");
  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "satisfied", "coverage is re-derived after promotion");
  assert.equal(result?.confidence, "high", "exact-ACID mapping yields high confidence");
  assert.equal(result?.partial_reason, undefined, "partial_reason is cleared on promotion");
  const verified = result?.evidence.find((ref) => ref.verified === true);
  assert.ok(verified, "the passing test is attached as VERIFIED evidence");
  assert.equal(verified?.kind, "test");
  assert.equal(verified?.validation_status, "valid");
  assert.equal(verified?.test_name, "example.EVAL.1 evaluator behaves correctly", "the REAL parsed test_name is carried");
  assert.match(verified?.note ?? "", /references its exact ACID/);
  assert.doesNotMatch(verified?.note ?? "", /pinpointed by LLM/);

  // The promoted evaluation still validates against the additive schema.
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "review_packet.schema.json"), "utf8"));
  assert.equal(validateJsonSchema(schema, packetWithEvaluationResults(evaluation.results)).valid, true);
});

test("VERIFICATION #2 group-only test does NOT promote: it stays partial but carries verified-but-broad test evidence", async () => {
  // A passing test that maps ONLY to the EVAL group (its classname names the
  // group token; no exact ACID, no LLM pinpoint). Per the tightening, a passing
  // "eval area" test does NOT prove example.EVAL.1 specifically, so the
  // requirement must STAY partial. The real passing area test is still recorded
  // as VERIFIED-but-BROAD test evidence so it remains auditable.
  const { collection, intent } = await setupEvalRepo({ junitXml: GROUP_MAPPED_PASSING });

  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const before = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(before?.status, "partial", "broad impl + group test is partial pre-verification");

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "partial", "a merely group-mapped passing test must NOT promote the requirement");
  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "partial", "coverage stays partial for the group-only case");
  assert.equal(result?.partial_reason, "broad_area_only", "the partial reason reflects a broad verified test exists");

  const verifiedBroad = result?.evidence.find((ref) => ref.verified === true);
  assert.ok(verifiedBroad, "the passing area test is attached as VERIFIED-but-BROAD evidence");
  assert.equal(verifiedBroad?.kind, "test");
  assert.equal(verifiedBroad?.validation_status, "valid");
  assert.equal(verifiedBroad?.test_name, "eval area behaves correctly", "the REAL parsed test_name is carried on the broad ref");
  assert.match(verifiedBroad?.note ?? "", /broad, not requirement-specific/);

  // The verified-but-broad partial still validates against the additive schema.
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "review_packet.schema.json"), "utf8"));
  assert.equal(validateJsonSchema(schema, packetWithEvaluationResults(evaluation.results)).valid, true);
});

test("VERIFICATION #2 INVARIANT: no --test-output / empty results => NO promotion (baseline unchanged)", async () => {
  // No JUnit report at all: collection.testResults is the empty result.
  const { collection, intent } = await setupEvalRepo({});
  assert.equal(collection.testResults.cases.length, 0, "no test results were ingested");

  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const baseline = JSON.parse(JSON.stringify(evaluation));

  const returned = verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(returned.acai_coverage["example.EVAL.1"], "partial", "no promotion without test output");
  assert.deepEqual(
    JSON.parse(JSON.stringify(evaluation)),
    baseline,
    "with no test results the verification loop is a byte-for-byte no-op"
  );
});

test("VERIFICATION #2 INVARIANT: a candidate test NOT present in the parsed results => NO promotion", async () => {
  // Real test results exist, but the only passing case references an UNRELATED
  // ACID/group; the requirement's would-be test simply is not in the report.
  const unrelated = `<?xml version="1.0"?>
<testsuite name="other">
  <testcase name="unrelated.OTHER.9 passes" classname="suite.OTHER" time="0.01"/>
</testsuite>
`;
  const { collection, intent } = await setupEvalRepo({ junitXml: unrelated });
  assert.ok(collection.testResults.cases.length > 0, "test results were ingested");

  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "partial", "no mapping passing case => no promotion");
  assert.ok(!result?.evidence.some((ref) => ref.verified === true), "no verified evidence attached");
});

test("VERIFICATION #2 INVARIANT: a mapping test present but FAILING or SKIPPED => NO promotion", async () => {
  // The case maps to the EVAL group but is FAILING; a second mapping case is SKIPPED.
  const failingOrSkipped = `<?xml version="1.0"?>
<testsuite name="eval">
  <testcase name="eval area behaves correctly" classname="suite.EVAL" time="0.01">
    <failure message="boom">assertion failed</failure>
  </testcase>
  <testcase name="eval area later" classname="suite.EVAL" time="0.01">
    <skipped/>
  </testcase>
</testsuite>
`;
  const { collection, intent } = await setupEvalRepo({ junitXml: failingOrSkipped });
  assert.equal(collection.testResults.totals.passed, 0, "no passing cases in the report");
  assert.equal(collection.testResults.totals.failed, 1);
  assert.equal(collection.testResults.totals.skipped, 1);

  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "partial", "a failing/skipped mapping test never promotes");
  assert.ok(!result?.evidence.some((ref) => ref.verified === true), "no verified evidence attached");
});

test("VERIFICATION #2 INVARIANT: a passing test that does NOT map (LLM claim alone) => NO promotion", async () => {
  // Setup: a broad-impl EVAL requirement that is partial. A passing test exists
  // that does NOT map to EVAL (it references an unrelated group/ACID). The LLM
  // pinpoints THAT test for example.EVAL.1, but with NO group corroboration the
  // word alone must never promote.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-verify-nocorrob-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: Evaluate implementation.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.ts"), "export const evaluate = true;\n");
  // A real test file in the candidate pool so the LLM-proposed test ref validates,
  // but its parsed case maps to an UNRELATED area (no EVAL token, no EVAL ACID).
  fs.writeFileSync(path.join(tmp, "tests", "other.test.ts"), "test('cross-area passes', () => {});\n");
  fs.writeFileSync(
    path.join(tmp, "junit.xml"),
    `<?xml version="1.0"?>
<testsuite name="other">
  <testcase name="cross-area passes" classname="tests/other.test.ts" time="0.01"/>
</testsuite>
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    testOutputPaths: ["junit.xml"],
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/evaluation/evaluate.ts", status: "A", source: "working_tree" }];
  const intent = await buildIntent(tmp, collection);

  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "partial", "broad impl alone is partial");

  // The LLM pinpoints the cross-area test for this requirement.
  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: result?.requirement_id,
        candidate_evidence: [
          { kind: "test", path: "tests/other.test.ts", test_name: "cross-area passes", note: "this verifies it, trust me" }
        ],
        rationale: "The LLM claims this cross-area test covers the requirement."
      }
    ])
  });
  await runEvaluationReasoning(provider, { collection, intent, evaluation, methodology: emptyMethodology(), risks: emptyRisks() });
  // The reasoning stage attached the LLM-proposed test ref (the test file is in pool).
  assert.ok(
    result?.evidence.some((ref) => ref.kind === "test" && ref.llm_proposed === true && ref.test_name === "cross-area passes"),
    "the LLM-pinpointed test ref is present so the corroboration guard is exercised"
  );

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(result?.status, "partial", "a pure cross-area LLM claim with no group corroboration must NOT promote");
  assert.ok(!result?.evidence.some((ref) => ref.verified === true), "no verified evidence attached on the unmapped LLM claim");
});

test("VERIFICATION #2 LLM-PINPOINTED-AND-CORROBORATED: a pinpointed passing test whose cited file is group-mapped promotes with medium confidence", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-verify-pinpoint-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: Evaluate implementation.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.ts"), "export const evaluate = true;\n");
  // A real test file in the pool that maps to the EVAL group via the "evaluation"
  // test keyword. The parsed case name/classname are NEUTRAL (no EVAL token, no
  // ACID), so DETERMINISTIC mapping (path a) does NOT fire; only the LLM pinpoint
  // path (b), corroborated by the cited FILE's group, can promote.
  fs.writeFileSync(path.join(tmp, "tests", "evaluation.test.ts"), "test('focused behaviour check', () => {});\n");
  fs.writeFileSync(
    path.join(tmp, "junit.xml"),
    `<?xml version="1.0"?>
<testsuite name="Suite">
  <testcase name="focused behaviour check" classname="Suite" time="0.01"/>
</testsuite>
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    testOutputPaths: ["junit.xml"],
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/evaluation/evaluate.ts", status: "A", source: "working_tree" }];
  const intent = await buildIntent(tmp, collection);

  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "partial", "broad impl with a neutral-named passing case stays partial pre-verification");

  // The LLM pinpoints the passing test by name AND cites the EVAL-mapped test file.
  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: result?.requirement_id,
        candidate_evidence: [
          { kind: "test", path: "tests/evaluation.test.ts", test_name: "focused behaviour check", note: "pinpointed verifying test" }
        ],
        rationale: "This focused test exercises the evaluation behaviour."
      }
    ])
  });
  await runEvaluationReasoning(provider, { collection, intent, evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(result?.status, "satisfied", "a pinpointed-and-corroborated passing test promotes to satisfied");
  assert.equal(result?.confidence, "medium", "LLM-pinpointed mapping yields medium (not high) confidence");
  const verified = result?.evidence.find((ref) => ref.verified === true);
  assert.ok(verified, "verified evidence is attached");
  assert.equal(verified?.test_name, "focused behaviour check");
  assert.equal(verified?.confidence, "medium");
  assert.match(verified?.note ?? "", /pinpointed by LLM/);
});

test("VERIFICATION #2 INVARIANT: a requirement lacking implementation evidence (not test-only) => NO promotion even with a verified mapping passing test", async () => {
  // No implementation changed file at all for the EVAL requirement; only a
  // passing EXACT-ACID test exists. The exact-ACID test IS per-requirement proof,
  // so the ONLY thing blocking promotion is the missing implementation (Invariant
  // #3). The evaluator yields a test_no_impl partial.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-verify-noimpl-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: Evaluate implementation.
`
  );
  // A test file mapped to the EVAL group via its filename keyword, but NO impl.
  fs.writeFileSync(path.join(tmp, "tests", "evaluation.test.ts"), "test('eval surface', () => {});\n");
  fs.writeFileSync(
    path.join(tmp, "junit.xml"),
    `<?xml version="1.0"?>
<testsuite name="eval">
  <testcase name="example.EVAL.1 evaluator behaves correctly" classname="suite.EVAL" time="0.01"/>
</testsuite>
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    testOutputPaths: ["junit.xml"],
    dogfood: false
  });
  // No implementation file in the changed set.
  collection.changedFiles = [];
  const intent = await buildIntent(tmp, collection);

  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const before = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(before?.status, "partial", "test evidence but no impl is partial");

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "partial", "a verified test must NEVER satisfy a requirement that lacks implementation");
  assert.ok(!result?.evidence.some((ref) => ref.verified === true), "no verified evidence attached without impl");
});

// A minimal QUALITY review area that maps tests/quality.test.ts to the QUALITY
// group (the repo config declares no QUALITY test_keywords, so we supply our own
// for this test). This lets the LLM-pinpointed-and-corroborated path corroborate
// a QUALITY pinpoint by the cited test FILE's strict group mapping.
const QUALITY_TEST_ONLY_AREAS: ReviewArea[] = [
  {
    id: "SUB-QUALITY",
    name: "Quality gate",
    groupKey: "QUALITY",
    prefixes: ["tests/"],
    purpose: "Unit tests cover behaviour.",
    pattern: "test-only quality gate",
    testKeywords: ["quality"]
  }
];

test("VERIFICATION #2 test-only requirement: a verified passing test alone (no impl) may satisfy it", async () => {
  // QUALITY group test-only requirement with NO implementation. The requirement
  // stays partial pre-verification (the passing case name is NEUTRAL: no exact
  // ACID, so the evaluator cannot pre-satisfy it). The loop then promotes via the
  // LLM-PINPOINTED-AND-CORROBORATED path (the cited test FILE maps to QUALITY),
  // and the test-only exemption lets the verified test satisfy it WITHOUT impl.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-verify-testonly-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
constraints:
  QUALITY:
    requirements:
      1: Unit tests must cover behaviour.
`
  );
  // A real test file in the candidate pool that maps to the QUALITY group via the
  // "quality" filename token. Its parsed case name is NEUTRAL (no QUALITY token,
  // no exact ACID), so the deterministic exact-ACID path does NOT fire and the
  // evaluator does NOT pre-satisfy the test-only requirement.
  fs.writeFileSync(path.join(tmp, "tests", "quality.test.ts"), "test('behaviour passes', () => {});\n");
  fs.writeFileSync(
    path.join(tmp, "junit.xml"),
    `<?xml version="1.0"?>
<testsuite name="Suite">
  <testcase name="behaviour passes" classname="Suite" time="0.01"/>
</testsuite>
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    testOutputPaths: ["junit.xml"],
    dogfood: false
  });
  collection.changedFiles = [];
  const intent = await buildIntent(tmp, collection);

  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: QUALITY_TEST_ONLY_AREAS });
  const before = evaluation.results.find((r) => r.acai_id === "example.QUALITY.1");
  // Broad group-only test evidence (from the test path) with no exact ACID and no
  // impl => partial; the neutral-named case is not exact-ACID proof.
  assert.equal(before?.status, "partial", "broad test-only requirement starts partial");

  // The LLM pinpoints the passing test by name AND cites the QUALITY-mapped test file.
  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.QUALITY.1",
        requirement_id: before?.requirement_id,
        candidate_evidence: [
          { kind: "test", path: "tests/quality.test.ts", test_name: "behaviour passes", note: "pinpointed verifying test" }
        ],
        rationale: "This focused test covers the required behaviour."
      }
    ])
  });
  await runEvaluationReasoning(provider, { collection, intent, evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: QUALITY_TEST_ONLY_AREAS });

  const result = evaluation.results.find((r) => r.acai_id === "example.QUALITY.1");
  assert.equal(result?.status, "satisfied", "a test-only requirement may be satisfied by the verified passing test alone");
  assert.ok(result?.evidence.some((ref) => ref.verified === true), "verified evidence attached for the test-only promotion");
});

test("VERIFICATION #2 mock + --test-output: the DETERMINISTIC exact-ACID promotion still applies (no LLM path)", async () => {
  // With mock there are no LLM proposals; the deterministic exact-ACID passing
  // test + impl path must still promote. This is the principled deterministic
  // strengthening called out in the task.
  const { collection, intent } = await setupEvalRepo({ junitXml: EXACT_ACID_PASSING });
  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  // No reasoning stage is run (mock would be a no-op anyway); verification alone.
  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "satisfied", "deterministic exact-ACID promotion applies even without any LLM proposals");
  const verified = result?.evidence.find((ref) => ref.verified === true);
  assert.equal(verified?.confidence, "high");
});

test("VERIFICATION #2 mock + NO --test-output is a total no-op", async () => {
  const { collection, intent } = await setupEvalRepo({});
  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const baseline = JSON.stringify(evaluation);

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(JSON.stringify(evaluation), baseline, "mock + no --test-output leaves the evaluation byte-identical");
});

test("VERIFICATION #2 is idempotent: re-running over an already-verified result does not duplicate evidence", async () => {
  const { collection, intent } = await setupEvalRepo({ junitXml: GROUP_MAPPED_PASSING });
  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });
  const afterFirst = JSON.stringify(evaluation);
  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(JSON.stringify(evaluation), afterFirst, "a second verification pass is a no-op (idempotent)");
  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  const verifiedCount = result?.evidence.filter((ref) => ref.verified === true).length ?? 0;
  assert.equal(verifiedCount, 1, "exactly one verified ref, never duplicated");
});

// Minimal packet wrapper to validate promoted evaluation results against the
// additive schema (mirrors evaluation.test.ts).
function packetWithEvaluationResults(results: unknown[]): Record<string, unknown> {
  return {
    schema_version: "review-surfaces.packet.v1",
    manifest: {
      tool_version: "0.1.0",
      created_at: "2026-05-28T00:00:00.000Z",
      repo: "review-surfaces",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "abc",
      run_mode: "local",
      input_hashes: []
    },
    intent: { summary: "verification fixture", requirements: [] },
    evaluation: { summary: "verification fixture", results, overreach: [], acai_coverage: {} },
    architecture: {
      summary: "verification fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "verification fixture",
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
    },
    risks: { summary: "verification fixture", items: [], test_evidence: [], test_gaps: [], review_focus: [] }
  };
}

// --- VERIFICATION LOOP #2 soundness regressions (no UNSOUND satisfied) -------

// FINDING #1: an unrelated passing test whose NAME contains the group token as a
// word must NOT promote. The test name is free text, not provenance.
test("VERIFICATION #2 SOUNDNESS: a passing test whose NAME merely contains the group token does NOT promote", async () => {
  const unrelatedNameOnly = `<?xml version="1.0"?>
<testsuite name="perf">
  <testcase name="EVAL of latency budget under threshold" classname="perf.LatencyBenchmark" time="0.01"/>
</testsuite>
`;
  const { collection, intent } = await setupEvalRepo({ junitXml: unrelatedNameOnly });
  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const before = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(before?.status, "partial", "broad impl is partial pre-verification");

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "partial", "group token in the human-readable test NAME is not a basis for satisfied");
  assert.ok(!result?.evidence.some((ref) => ref.verified === true), "no verified evidence attached on a name-only token match");
});

// FINDING #2: a classname that merely CONTAINS a test_keyword as a substring
// (medieval contains eval) and is NOT a collected test path must NOT promote.
test("VERIFICATION #2 SOUNDNESS: a substring-keyword classname not in the test set does NOT promote", async () => {
  const substringClassname = `<?xml version="1.0"?>
<testsuite name="history">
  <testcase name="completely generic check" classname="tests/medieval_history.test.ts" time="0.01"/>
</testsuite>
`;
  const { collection, intent } = await setupEvalRepo({ junitXml: substringClassname });
  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "partial", "'eval' inside 'medieval' is not a whole-token keyword match and the path is not a collected test");
  assert.ok(!result?.evidence.some((ref) => ref.verified === true), "no verified evidence attached on a substring classname");
});

// FINDINGS #3 / #7: the LLM pinpoints a same-group file by name, but the ONLY
// passing case with that name belongs to a DIFFERENT area (its own classname maps
// to RISK). A name-only match across suites must be rejected.
test("VERIFICATION #2 SOUNDNESS: an LLM name-collision where the matched case belongs to a different area does NOT promote", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-verify-collision-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: Evaluate implementation.
  RISK:
    requirements:
      1: Analyze risks.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.ts"), "export const evaluate = true;\n");
  // A real EVAL-mapped test file the LLM can cite, but the ONLY parsed passing case
  // named "shared name" has a classname that maps to the RISK area (a known group),
  // not EVAL, so its OWN provenance contradicts the EVAL requirement.
  fs.writeFileSync(path.join(tmp, "tests", "evaluation.test.ts"), "test('shared name', () => {});\n");
  fs.writeFileSync(
    path.join(tmp, "junit.xml"),
    `<?xml version="1.0"?>
<testsuite name="risk">
  <testcase name="shared name" classname="suite.RISK" time="0.01"/>
</testsuite>
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    testOutputPaths: ["junit.xml"],
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/evaluation/evaluate.ts", status: "A", source: "working_tree" }];
  const intent = await buildIntent(tmp, collection);

  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "partial", "broad impl alone is partial");

  const provider = stubProvider({
    "evaluation-candidate-evidence": batchedEvidence([
      {
        acai_id: "example.EVAL.1",
        requirement_id: result?.requirement_id,
        candidate_evidence: [
          { kind: "test", path: "tests/evaluation.test.ts", test_name: "shared name", note: "pinpointed verifying test" }
        ],
        rationale: "Claims this EVAL test covers the requirement."
      }
    ])
  });
  await runEvaluationReasoning(provider, { collection, intent, evaluation, methodology: emptyMethodology(), risks: emptyRisks() });

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(result?.status, "partial", "a name-only collision whose matched case belongs to a different area must not promote");
  assert.ok(!result?.evidence.some((ref) => ref.verified === true), "no verified evidence attached on a cross-area name collision");
});

// FINDING #4: a requirement the evaluator marked test_no_impl (its only file ref
// is a spec-referenced DOC, not implementation) must NOT promote even with a
// mapping passing test, per Invariant #3.
test("VERIFICATION #2 SOUNDNESS: a doc-only 'implementation' ref does NOT count as implementation for promotion", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-verify-docimpl-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "docs"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: The evaluator behaviour described in docs/notes.md must hold.
`
  );
  // A real doc the requirement TEXT references; directFileEvidence attaches it as
  // kind:file, but it is NOT implementation (isImplementationEvidencePath excludes docs/).
  fs.writeFileSync(path.join(tmp, "docs", "notes.md"), "# notes\nEvaluator behaviour.\n");
  // An EXACT-ACID passing test exists (per-requirement proof), so only the impl
  // gate should block promotion: the requirement's only file ref is a doc.
  fs.writeFileSync(path.join(tmp, "tests", "evaluation.test.ts"), "test('eval surface', () => {});\n");
  fs.writeFileSync(
    path.join(tmp, "junit.xml"),
    `<?xml version="1.0"?>
<testsuite name="eval">
  <testcase name="example.EVAL.1 behaviour holds" classname="suite.EVAL" time="0.01"/>
</testsuite>
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: ["docs/**/*.md"], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    testOutputPaths: ["junit.xml"],
    dogfood: false
  });
  // No implementation file changed; the requirement's only file ref is the doc.
  collection.changedFiles = [];
  const intent = await buildIntent(tmp, collection);

  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const before = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(before?.partial_reason, "test_no_impl", "the evaluator itself determined there is no implementation");
  assert.ok(
    before?.evidence.some((ref) => ref.kind === "file" && ref.path === "docs/notes.md"),
    "the doc is attached as a file ref (directFileEvidence), which must NOT count as implementation"
  );

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "partial", "a verified test must NEVER satisfy a requirement the evaluator marked test_no_impl");
  assert.ok(!result?.evidence.some((ref) => ref.verified === true), "no verified evidence attached when the only file ref is a doc");
});

// FINDINGS #6 / #8: when a partial result already carries the 8-ref evidence cap,
// a promotion must still leave a surviving verified:true marker (or it would claim
// "satisfied: a passing test verifies it" with no auditable proof).
test("VERIFICATION #2 SOUNDNESS: a promotion at the 8-ref evidence cap retains the verified marker", async () => {
  // An EXACT-ACID passing test + impl makes example.EVAL.1 promotable. We then
  // seed the partial result with 8 pre-existing evidence refs (1 impl + 7 files)
  // before running verification, so the verified ref would be sliced off the END
  // by uniqueEvidence(...).slice(0, 8) unless it is guaranteed to survive.
  const { collection, intent } = await setupEvalRepo({ junitXml: EXACT_ACID_PASSING });
  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const target = evaluation.results.find((r) => r.acai_id === "example.EVAL.1") as RequirementResult;
  assert.equal(target.status, "partial", "promotable partial before seeding");

  target.evidence = [
    { kind: "file", path: "src/evaluation/evaluate.ts", note: "impl", confidence: "high", validation_status: "not_checked" },
    { kind: "file", path: "src/a1.ts", note: "f1", confidence: "medium", validation_status: "not_checked" },
    { kind: "file", path: "src/a2.ts", note: "f2", confidence: "medium", validation_status: "not_checked" },
    { kind: "file", path: "src/a3.ts", note: "f3", confidence: "medium", validation_status: "not_checked" },
    { kind: "file", path: "src/a4.ts", note: "f4", confidence: "medium", validation_status: "not_checked" },
    { kind: "file", path: "src/a5.ts", note: "f5", confidence: "medium", validation_status: "not_checked" },
    { kind: "file", path: "src/a6.ts", note: "f6", confidence: "medium", validation_status: "not_checked" },
    { kind: "file", path: "src/a7.ts", note: "f7", confidence: "medium", validation_status: "not_checked" }
  ];
  assert.equal(target.evidence.length, 8, "result is at the 8-ref cap before promotion");

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(target.status, "satisfied", "the capped partial is promoted to satisfied");
  assert.ok(target.evidence.length <= 8, "the evidence cap is still respected after promotion");
  const verified = target.evidence.filter((ref) => ref.verified === true);
  assert.equal(verified.length, 1, "exactly one verified:true ref survives the cap so the promotion is auditable");
  assert.equal(verified[0]?.test_name, "example.EVAL.1 evaluator behaves correctly", "the surviving verified ref carries the real test_name");
});

// FINDING #5: a requirement promoted partial -> satisfied must NOT be reported as
// a partial test gap nor counted in the "implementation evidence but weak test
// evidence" risk item. analyzeRisks must read the POST-promotion evaluation.
test("VERIFICATION #2 SOUNDNESS: a promoted requirement is not a partial test gap nor a weak-test risk", async () => {
  const { collection, intent } = await setupEvalRepo({ junitXml: EXACT_ACID_PASSING });
  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  // Risks computed BEFORE promotion: the requirement is a partial gap + weak-test risk.
  const stalePartialRisks = analyzeRisks(collection, evaluation, ["cmd"]);
  assert.ok(
    stalePartialRisks.test_gaps.some((gap) => gap.acai_id === "example.EVAL.1"),
    "pre-promotion the requirement is a partial test gap"
  );

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });
  assert.equal(
    evaluation.results.find((r) => r.acai_id === "example.EVAL.1")?.status,
    "satisfied",
    "the requirement was promoted"
  );

  // Risks computed AFTER promotion (the correct ordering): the requirement is gone
  // from test_gaps and the weak-test risk no longer counts it.
  const risks = analyzeRisks(collection, evaluation, ["cmd"]);
  assert.ok(
    !risks.test_gaps.some((gap) => gap.acai_id === "example.EVAL.1"),
    "a promoted/satisfied requirement is NOT listed as a partial test gap"
  );
  const weakTestRisk = risks.items.find((item) =>
    item.summary.includes("implementation evidence but weak or missing test evidence")
  );
  assert.equal(weakTestRisk, undefined, "the promoted requirement is not counted in the weak-test risk item");
});

// FINDING A: resultHasImplementationEvidence used an EMPTY test-path set, so a
// deterministic file ref pointing at a COLLECTED TEST file (directFileEvidence
// fired because the requirement text names tests/foo.test.ts) was wrongly counted
// as IMPLEMENTATION evidence. Combined with a passing exact-ACID test that is
// per-requirement proof, the verification loop then promoted a NON-test-only
// requirement to satisfied using only test-file evidence. A test file must NEVER
// count as implementation, so the requirement must STAY partial.
test("VERIFICATION #2 SOUNDNESS: a tests/ file ref does NOT count as implementation; a verified exact-ACID test must NOT promote", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-verify-testimpl-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: The evaluator behaviour covered by tests/eval-behaviour.test.ts must hold.
`
  );
  // A REAL collected test file the requirement TEXT references. directFileEvidence
  // attaches it as a kind:file ref with path tests/eval-behaviour.test.ts. Its
  // tests/ prefix is NOT excluded by isImplementationEvidencePath's path rules, so
  // ONLY the collected-test-path set can reject it as implementation.
  fs.writeFileSync(path.join(tmp, "tests", "eval-behaviour.test.ts"), "test('eval behaviour', () => {});\n");
  // An EXACT-ACID passing test exists (per-requirement proof). Only the impl gate
  // should block: the requirement's sole non-test file ref is a tests/ path.
  fs.writeFileSync(
    path.join(tmp, "junit.xml"),
    `<?xml version="1.0"?>
<testsuite name="eval">
  <testcase name="example.EVAL.1 behaviour holds" classname="suite.EVAL" time="0.01"/>
</testsuite>
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    testOutputPaths: ["junit.xml"],
    dogfood: false
  });
  // No implementation file changed; the requirement's only file ref is the test file.
  collection.changedFiles = [];
  const intent = await buildIntent(tmp, collection);

  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const before = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(before?.status, "partial", "the requirement starts partial (no genuine implementation)");
  assert.ok(
    before?.evidence.some((ref) => ref.kind === "file" && ref.path === "tests/eval-behaviour.test.ts"),
    "the tests/ file is attached as a file ref (directFileEvidence) that must NOT count as implementation"
  );

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(
    result?.status,
    "partial",
    "a verified exact-ACID test must NOT promote a non-test-only requirement whose only file ref is a collected test path"
  );
  assert.ok(
    !result?.evidence.some((ref) => ref.verified === true),
    "no verified promotion marker is attached when the only non-test evidence is a tests/ file ref"
  );
});

// FINDING A (positive control): the SAME shape but with a GENUINE non-test
// implementation file present DOES promote on the passing exact-ACID test, proving
// the fix rejects only test-file evidence and not real implementation evidence.
test("VERIFICATION #2 SOUNDNESS: genuine non-test impl + a verified exact-ACID test still promotes", async () => {
  // setupEvalRepo wires a real src/evaluation/evaluate.ts changed file (genuine
  // implementation, not a test file) plus an EXACT-ACID passing test.
  const { collection, intent } = await setupEvalRepo({ junitXml: EXACT_ACID_PASSING });
  const evaluation = await evaluateIntent(collection.cwd, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const before = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(before?.status, "partial", "genuine impl + exact-ACID test starts partial pre-verification");
  assert.ok(
    before?.evidence.some((ref) => ref.kind === "file" && ref.path === "src/evaluation/evaluate.ts"),
    "the genuine implementation file is attached as a file ref"
  );

  verifyRequirementsWithTests(collection, intent, evaluation, { areas: await defaultReviewSurfacesAreas() });

  const result = evaluation.results.find((r) => r.acai_id === "example.EVAL.1");
  assert.equal(result?.status, "satisfied", "genuine non-test implementation still satisfies the impl gate, so the verified test promotes");
  assert.ok(result?.evidence.some((ref) => ref.verified === true), "a verified promotion marker is attached");
});
