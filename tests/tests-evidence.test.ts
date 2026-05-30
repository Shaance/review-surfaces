import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectInputs } from "../src/collector/collect";
import { defaultConfig } from "../src/config/config";
import { buildIntent } from "../src/intent/intent";
import { evaluateIntent } from "../src/evaluation/evaluate";
import { analyzeRisks } from "../src/risks/risks";
import { ingestTestOutputs, parseJunitXml, splitTestOutputPaths } from "../src/tests-evidence/junit";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { CollectionResult } from "../src/collector/collect";
import { defaultReviewSurfacesAreas } from "./helpers/review-areas";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "junit");

test("review-surfaces.TESTS.1 parser normalizes status and names across shapes", () => {
  const wrapper = parseJunitXml(fs.readFileSync(path.join(FIXTURES, "testsuites-wrapper.xml"), "utf8"), "wrapper.xml");
  const bare = parseJunitXml(fs.readFileSync(path.join(FIXTURES, "bare-testsuite.xml"), "utf8"), "bare.xml");

  // testsuites wrapper -> two inner suites, single + array testcase shapes.
  assert.deepEqual(
    wrapper.suites.map((suite) => suite.name).sort(),
    ["evaluation", "risks"]
  );
  const passing = wrapper.cases.find((testCase) => testCase.name === "review-surfaces.EVAL.4 attaches parsed evidence");
  assert.equal(passing?.status, "passed");
  assert.equal(passing?.classname, "tests/evaluation.test.ts");
  const skipped = wrapper.cases.find((testCase) => testCase.name === "skipped scenario");
  assert.equal(skipped?.status, "skipped");
  const failing = wrapper.cases.find((testCase) => testCase.name === "failing risk case");
  assert.equal(failing?.status, "failed");
  // failure_message is redacted and bounded.
  assert.match(failing?.failure_message ?? "", /\[REDACTED:secret\]/);
  assert.doesNotMatch(failing?.failure_message ?? "", /abc123456/);

  // bare testsuite document (no wrapper) still parses both cases.
  assert.equal(bare.suites.length, 1);
  assert.equal(bare.cases.length, 2);
  assert.equal(bare.cases[0].status, "passed");
});

test("review-surfaces.TESTS.1 parser recurses into nested <testsuite> levels and keeps inner failing cases", () => {
  // Adversarial fixture: three levels of <testsuite> nesting. The deepest case
  // is FAILING. Nested suites must not silently drop cases (a failing test
  // vanishing is the most dangerous direction for an evidence tool).
  const nested = parseJunitXml(fs.readFileSync(path.join(FIXTURES, "nested-testsuite.xml"), "utf8"), "nested.xml");

  // Every suite level is collected (outer, middle, inner).
  assert.deepEqual(
    nested.suites.map((suite) => suite.name).sort(),
    ["inner", "middle", "outer"]
  );

  // All cases at every depth are present, attributed to the inner-most suite.
  const byName = new Map(nested.cases.map((testCase) => [testCase.name, testCase]));
  assert.deepEqual(
    [...byName.keys()].sort(),
    ["example.EVAL.1 nested failing test", "middle direct passing test", "outer direct passing test"]
  );

  const deepFailing = byName.get("example.EVAL.1 nested failing test");
  assert.equal(deepFailing?.status, "failed");
  assert.equal(deepFailing?.suite, "inner");
  // Failure message still redacted and bounded.
  assert.doesNotMatch(JSON.stringify(deepFailing), /abc123456/);

  assert.equal(byName.get("middle direct passing test")?.status, "passed");
  assert.equal(byName.get("middle direct passing test")?.suite, "middle");
  assert.equal(byName.get("outer direct passing test")?.status, "passed");
  assert.equal(byName.get("outer direct passing test")?.suite, "outer");

  // Totals reflect every nested case.
  assert.equal(nested.cases.length, 3);
});

test("review-surfaces.EVAL.4 nested passing test still satisfies the exact-test ACID path", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-nested-eval-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
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
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.ts"), "export const acid = 'example.EVAL.1';\n");
  // The passing case referencing example.EVAL.1 is buried two suite levels deep.
  fs.writeFileSync(
    path.join(tmp, "junit.xml"),
    `<?xml version="1.0"?>
<testsuites>
  <testsuite name="outer">
    <testsuite name="inner">
      <testcase name="example.EVAL.1 is satisfied by a real passing test" classname="suite.eval" time="0.01"/>
    </testsuite>
  </testsuite>
</testsuites>
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [] },
    baseRef: "HEAD",
    headRef: "HEAD",
    testOutputPaths: ["junit.xml"],
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/evaluation/evaluate.ts", status: "A", source: "working_tree" }];

  // The nested passing case is visible in the collection.
  assert.equal(
    collection.testResults.cases.some((testCase) => testCase.name === "example.EVAL.1 is satisfied by a real passing test"),
    true
  );

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  // Nested-suite location must NOT degrade satisfied -> partial.
  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "satisfied");
  const result = evaluation.results.find((entry) => entry.acai_id === "example.EVAL.1");
  assert.ok(
    result?.evidence.some(
      (ref) => ref.kind === "test" && ref.test_name === "example.EVAL.1 is satisfied by a real passing test"
    ),
    "exact test evidence should carry the real parsed test_name even when nested"
  );
});

test("review-surfaces.TESTS.1 malformed XML degrades gracefully without throwing", () => {
  const malformed = fs.readFileSync(path.join(FIXTURES, "malformed.xml"), "utf8");
  let parsed;
  assert.doesNotThrow(() => {
    parsed = parseJunitXml(malformed, "malformed.xml");
  });
  assert.deepEqual(parsed, { suites: [], cases: [] });

  // A partial multi-file ingest keeps what parses and drops the malformed file.
  const results = ingestTestOutputs(process.cwd(), [
    path.join(FIXTURES, "bare-testsuite.xml"),
    path.join(FIXTURES, "malformed.xml")
  ]);
  assert.equal(results.totals.cases, 2);
  assert.deepEqual(results.source_paths.map((source) => path.basename(source)), ["bare-testsuite.xml"]);

  // Totally missing input yields empty results, never a throw.
  assert.doesNotThrow(() => ingestTestOutputs(process.cwd(), ["nope/does-not-exist.xml"]));
});

test("review-surfaces.TESTS.1 ingests multiple files plus optional coverage with totals", () => {
  const results = ingestTestOutputs(
    process.cwd(),
    [path.join(FIXTURES, "testsuites-wrapper.xml"), path.join(FIXTURES, "bare-testsuite.xml")],
    path.join(FIXTURES, "coverage-summary.json")
  );
  assert.equal(results.totals.suites, 3);
  assert.equal(results.totals.cases, 5);
  assert.equal(results.totals.passed, 3);
  assert.equal(results.totals.failed, 1);
  assert.equal(results.totals.skipped, 1);
  assert.equal(results.coverage?.total?.lines_pct, 92);
  assert.equal(results.coverage?.files[0].path, "src/tests-evidence/junit.ts");
});

test("splitTestOutputPaths accepts comma-separated paths and ignores blanks", () => {
  assert.deepEqual(splitTestOutputPaths("a.xml, b.xml ,, c.xml"), ["a.xml", "b.xml", "c.xml"]);
  assert.deepEqual(splitTestOutputPaths(undefined), []);
  assert.deepEqual(splitTestOutputPaths(""), []);
});

test("review-surfaces.RISK.2 surfaces parsed test names as direct evidence and failures as missing", () => {
  const testResults = ingestTestOutputs(process.cwd(), [path.join(FIXTURES, "testsuites-wrapper.xml")]);
  const collection = {
    changedFiles: [],
    feedback: [],
    commandTranscripts: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    testResults
  } as unknown as CollectionResult;
  const evaluation: EvaluationModel = { summary: "no results", results: [], overreach: [], acai_coverage: {} };

  const risks = analyzeRisks(collection, evaluation, []);

  const direct = risks.test_evidence.find((entry) => entry.kind === "direct");
  assert.ok(direct, "a passing parsed case should produce direct evidence");
  assert.equal(direct?.evidence?.[0].kind, "test");
  assert.equal(direct?.evidence?.[0].test_name, "review-surfaces.EVAL.4 attaches parsed evidence");
  assert.equal(direct?.evidence?.[0].validation_status, "valid");

  const failing = risks.test_evidence.find((entry) => entry.summary.includes("failing risk case"));
  assert.equal(failing?.kind, "missing");
  assert.doesNotMatch(JSON.stringify(failing), /abc123456/);

  // Parsed results lead the test_evidence list (stronger than transcripts).
  assert.ok(risks.test_evidence[0].id.startsWith("TEST-RESULT-"));
});

test("review-surfaces.RISK.2 prefers parsed results but keeps command transcripts too", () => {
  const testResults = ingestTestOutputs(process.cwd(), [path.join(FIXTURES, "bare-testsuite.xml")]);
  const collection = {
    changedFiles: [],
    feedback: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    commandTranscripts: [
      {
        id: "CMD-001",
        command: "pnpm run test",
        status: "passed",
        exit_code: 0,
        truncated: false,
        source_path: ".review-surfaces/commands/local.json"
      }
    ],
    feedbackFiles: [],
    testResults
  } as unknown as CollectionResult;
  const evaluation: EvaluationModel = { summary: "no results", results: [], overreach: [], acai_coverage: {} };

  const risks = analyzeRisks(collection, evaluation, []);
  assert.ok(risks.test_evidence.some((entry) => entry.id.startsWith("TEST-RESULT-")), "parsed results present");
  assert.ok(risks.test_evidence.some((entry) => entry.id.startsWith("TEST-TR-")), "transcript evidence retained");
  // Parsed results are listed before the transcript evidence.
  const firstParsed = risks.test_evidence.findIndex((entry) => entry.id.startsWith("TEST-RESULT-"));
  const firstTranscript = risks.test_evidence.findIndex((entry) => entry.id.startsWith("TEST-TR-"));
  assert.ok(firstParsed < firstTranscript);
});

test("review-surfaces.TESTS.1 collection writes tests.results.json and exposes collection.testResults", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-test-output-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "tests", "fixtures", "minimal-repo", "features", "example.feature.yaml"),
    path.join(tmp, "features", "example.feature.yaml")
  );
  fs.copyFileSync(path.join(FIXTURES, "testsuites-wrapper.xml"), path.join(tmp, "junit.xml"));
  fs.copyFileSync(path.join(FIXTURES, "coverage-summary.json"), path.join(tmp, "coverage.json"));
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [] },
    baseRef: "HEAD",
    headRef: "HEAD",
    testOutputPaths: ["junit.xml"],
    coverageOutputPath: "coverage.json",
    dogfood: false
  });

  assert.equal(collection.testResults.totals.cases, 3);
  assert.equal(collection.testResults.cases.some((testCase) => testCase.name === "failing risk case"), true);

  const artifactPath = path.join(tmp, ".review-surfaces", "inputs", "tests.results.json");
  assert.ok(fs.existsSync(artifactPath));
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.equal(artifact.schema_version, "review-surfaces.tests.results.v1");
  assert.equal(artifact.totals.passed, 1);
  assert.equal(artifact.coverage.total.lines_pct, 92);
  assert.doesNotMatch(JSON.stringify(artifact), /abc123456/);
});

test("review-surfaces.TESTS.1 no --test-output leaves behavior unchanged and deterministic", async () => {
  const setup = (): string => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-no-test-output-"));
    fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), "tests", "fixtures", "minimal-repo", "features", "example.feature.yaml"),
      path.join(tmp, "features", "example.feature.yaml")
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    return tmp;
  };

  const tmp = setup();
  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  // Empty results, no tests.results.json artifact written.
  assert.deepEqual(collection.testResults, {
    suites: [],
    cases: [],
    totals: { suites: 0, cases: 0, passed: 0, failed: 0, skipped: 0 },
    source_paths: []
  });
  assert.equal(fs.existsSync(path.join(tmp, ".review-surfaces", "inputs", "tests.results.json")), false);
});

test("review-surfaces.EVAL.4 attaches parsed test name as exact ACID test evidence when it clearly maps", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-parsed-eval-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
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
  // Exact implementation ACID evidence in a changed file, but NO test-path
  // evidence. Without the parsed JUnit case this requirement would be partial.
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.ts"), "export const acid = 'example.EVAL.1';\n");
  // A passing parsed JUnit case whose name references the ACID.
  fs.writeFileSync(
    path.join(tmp, "junit.xml"),
    `<?xml version="1.0"?>
<testsuite name="eval">
  <testcase name="example.EVAL.1 is satisfied by a real passing test" classname="suite.eval" time="0.01"/>
</testsuite>
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [] },
    baseRef: "HEAD",
    headRef: "HEAD",
    testOutputPaths: ["junit.xml"],
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/evaluation/evaluate.ts", status: "A", source: "working_tree" }];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  // Exact implementation + exact (parsed) test ACID evidence => satisfied.
  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "satisfied");
  const result = evaluation.results.find((entry) => entry.acai_id === "example.EVAL.1");
  assert.ok(
    result?.evidence.some(
      (ref) => ref.kind === "test" && ref.test_name === "example.EVAL.1 is satisfied by a real passing test"
    ),
    "exact test evidence should carry the real parsed test_name"
  );
});
