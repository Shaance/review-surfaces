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
import { defaultReviewSurfacesAreas } from "./helpers/review-areas";

test("evaluator emits satisfied, partial, and missing statuses conservatively", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-eval-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "intent"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "risks"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  INTENT:
    requirements:
      1: Build intent.
  RISK:
    requirements:
      1: Build risks.
  ARCH:
    requirements:
      1: Build diagrams.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "intent", "intent.ts"), "export const x = 'example.INTENT.1';\n");
  fs.writeFileSync(path.join(tmp, "tests", "intent.test.ts"), "test('example.INTENT.1 intent', () => {});\n");
  fs.writeFileSync(path.join(tmp, "src", "risks", "risks.ts"), "export const risk = true;\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [
    { path: "src/intent/intent.ts", status: "A", source: "working_tree" },
    { path: "src/risks/risks.ts", status: "A", source: "working_tree" }
  ];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.INTENT.1"], "satisfied");
  assert.equal(evaluation.acai_coverage["example.RISK.1"], "partial");
  assert.equal(evaluation.acai_coverage["example.ARCH.1"], "missing");
});

test("evaluator does not treat generated artifact ACID mentions as proof", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-generated-evidence-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".review-surfaces"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  INTENT:
    requirements:
      1: Build intent.
  DOGFOOD:
    requirements:
      1: Generate handoff.
`
  );
  fs.writeFileSync(path.join(tmp, ".review-surfaces", "agent_handoff.md"), "Mentions example.INTENT.1 but is generated output.\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [{ path: ".review-surfaces/agent_handoff.md", status: "M", source: "working_tree" }];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.INTENT.1"], "missing");
  assert.equal(evaluation.acai_coverage["example.DOGFOOD.1"], "partial");
});

test("evaluator keeps broad group evidence partial without exact requirement proof", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-broad-evidence-"));
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
  fs.writeFileSync(path.join(tmp, "tests", "evaluation.test.ts"), "test('evaluation', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/evaluation/evaluate.ts", status: "A", source: "working_tree" }];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "partial");
});

test("review-surfaces.EVAL.4 requires exact test ACID evidence before marking a requirement satisfied", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-exact-test-evidence-"));
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
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.ts"), "export const acid = 'example.EVAL.1';\n");
  fs.writeFileSync(path.join(tmp, "tests", "evaluation.test.ts"), "test('evaluation path evidence only', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/evaluation/evaluate.ts", status: "A", source: "working_tree" }];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "partial");
  assert.match(evaluation.results[0].missing_evidence[0].note ?? "", /No exact test ACID evidence/);
});

test("review-surfaces.EVAL.3 treats configured test globs as exact test evidence outside tests directory", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-configured-test-evidence-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "spec"), { recursive: true });
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
  fs.writeFileSync(path.join(tmp, "spec", "evaluation.test.ts"), "test('example.EVAL.1 configured glob evidence', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["spec/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/evaluation/evaluate.ts", status: "A", source: "working_tree" }];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "satisfied");
});

test("review-surfaces.EVAL.4 does not treat docs as exact implementation evidence", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-docs-not-implementation-"));
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
      1: Evaluate implementation.
`
  );
  fs.writeFileSync(path.join(tmp, "docs", "evaluation.md"), "Design notes mention example.EVAL.1.\n");
  fs.writeFileSync(path.join(tmp, "tests", "evaluation.test.ts"), "test('example.EVAL.1 test evidence', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: ["docs/**/*.md"], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [{ path: "docs/evaluation.md", status: "A", source: "working_tree" }];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "partial");
  assert.match(evaluation.results[0].missing_evidence[0].note ?? "", /No implementation evidence/);
});

test("review-surfaces.QUALITY.1 allows exact tests to satisfy test-only requirements", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-test-only-quality-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
constraints:
  QUALITY:
    requirements:
      1: Unit tests must cover exact evidence classification.
`
  );
  fs.writeFileSync(path.join(tmp, "tests", "evaluation.test.ts"), "test('example.QUALITY.1 exact test-only evidence', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.QUALITY.1"], "satisfied");
});

test("evaluator treats later provider integrations as unknown deferrals", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-deferral-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "llm"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  PROVIDERS:
    requirements:
      1: GitHub comment integration must reuse local artifacts.
constraints:
  EVIDENCE:
    requirements:
      1: The tool must work in local/offline mode with mock or disabled LLM modules.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "llm", "provider.ts"), "export const provider = true;\n");
  fs.writeFileSync(path.join(tmp, "tests", "provider.test.ts"), "test('provider', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/llm/provider.ts", status: "A", source: "working_tree" }];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.PROVIDERS.1"], "unknown");
  assert.equal(evaluation.overreach.length, 0);
});

test("review-surfaces.EVIDENCE.4 turns invalid evidence references into invalid_evidence", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-invalid-evidence-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
constraints:
  EVIDENCE:
    requirements:
      4: Invalid references must become invalid_evidence findings.
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  const evaluation = await evaluateIntent(tmp, collection, {
    summary: "Invalid evidence fixture.",
    requirements: [
      {
        id: "REQ-001",
        acai_id: "example.EVIDENCE.4",
        requirement: "Invalid references must become invalid_evidence findings.",
        source_refs: [{ kind: "file", ref: "missing-spec.md" }],
        constraints: [],
        assumptions: [],
        open_questions: [],
        confidence: "high"
      }
    ],
    constraints: [],
    non_goals: [],
    assumptions: [],
    open_questions: [],
    sources: []
  }, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.EVIDENCE.4"], "invalid_evidence");
  assert.equal(evaluation.results[0].evidence[0].validation_status, "invalid");
});
