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
import { validateJsonSchema } from "../src/schema/json-schema";
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
  assert.equal(evaluation.acai_coverage["example.DOGFOOD.1"], "missing");
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

test("evaluator maps discovered changed tests outside configured test globs into group evidence", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-discovered-test-group-evidence-"));
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
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.test.ts"), "test('evaluation broad evidence', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/evaluation/evaluate.test.ts", status: "M", source: "working_tree" }];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });
  const result = evaluation.results.find((entry) => entry.acai_id === "example.EVAL.1");

  assert.equal(result?.status, "partial");
  assert.equal(result?.partial_reason, "test_no_impl");
  assert.ok(result?.evidence.some((ref) => ref.kind === "test" && ref.path === "src/evaluation/evaluate.test.ts"));
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

test("review-surfaces.EVAL.4 accepts exact implementation ACID evidence from unchanged source files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-unchanged-impl-evidence-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  CORE:
    requirements:
      1: Build core.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "core.ts"), "export const acid = 'example.CORE.1';\n");
  fs.writeFileSync(path.join(tmp, "tests", "core.test.ts"), "test('example.CORE.1 exact test evidence', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [{ path: "tests/core.test.ts", status: "M", source: "working_tree" }];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.CORE.1"], "satisfied");
});

test("review-surfaces.EVAL.4 does not treat config files as implementation proof", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-config-not-impl-evidence-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  CLI:
    requirements:
      1: Build command wiring.
      2: Configure command wiring.
`
  );
  fs.writeFileSync(path.join(tmp, "package.json"), "{ \"name\": \"example.CLI.1\" }\n");
  fs.writeFileSync(path.join(tmp, "vite.config.ts"), "export default 'example.CLI.2';\n");
  fs.writeFileSync(path.join(tmp, "tests", "cli.test.ts"), "test('example.CLI.2 exact test evidence', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [
    { path: "package.json", status: "M", source: "working_tree" },
    { path: "vite.config.ts", status: "M", source: "working_tree" }
  ];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.CLI.1"], "partial");
  assert.equal(evaluation.results.find((result) => result.acai_id === "example.CLI.1")?.partial_reason, "test_no_impl");
  assert.equal(evaluation.acai_coverage["example.CLI.2"], "partial");
  assert.equal(evaluation.results.find((result) => result.acai_id === "example.CLI.2")?.partial_reason, "test_no_impl");
});

test("review-surfaces.EVAL.3 reads unchanged implementation ACID proof from the reviewed head", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-head-proof-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  CORE:
    requirements:
      1: Build core behavior.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "core.ts"), "export const core = true;\n");
  fs.writeFileSync(path.join(tmp, "tests", "core.test.ts"), "test('example.CORE.1 exact test evidence', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "head"], { cwd: tmp, stdio: "ignore" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

  fs.writeFileSync(path.join(tmp, "src", "core.ts"), "export const core = 'example.CORE.1 dirty checkout only';\n");

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: head,
    headRef: head,
    dogfood: false
  });

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.CORE.1"], "partial");
  assert.equal(evaluation.results.find((result) => result.acai_id === "example.CORE.1")?.partial_reason, "test_no_impl");
});

test("review-surfaces.EVAL.3 scans exact ACID implementation proof outside targeted review areas", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-exact-proof-outside-area-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: Evaluate exact proof.
  LOCAL_LOOP:
    requirements:
      1: Run the local review loop.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.ts"), "export const evalProof = 'example.EVAL.1';\n");
  fs.writeFileSync(path.join(tmp, "scripts", "local-review.sh"), "# example.LOCAL_LOOP.1\n");
  fs.writeFileSync(
    path.join(tmp, "tests", "evaluation.test.ts"),
    "test('example.EVAL.1 exact test evidence', () => {});\ntest('example.LOCAL_LOOP.1 exact test evidence', () => {});\n"
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "head"], { cwd: tmp, stdio: "ignore" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: head,
    headRef: head,
    dogfood: false
  });

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "satisfied");
  assert.equal(evaluation.acai_coverage["example.LOCAL_LOOP.1"], "satisfied");
});

test("review-surfaces.EVAL.3 reports implementation-only exact proof as missing tests, not missing implementation", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-impl-only-proof-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "evaluation"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: Evaluate exact proof.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "evaluate.ts"), "export const evalProof = 'example.EVAL.1';\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "head"], { cwd: tmp, stdio: "ignore" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: head,
    headRef: head,
    dogfood: false
  });

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "partial");
  assert.equal(evaluation.results.find((result) => result.acai_id === "example.EVAL.1")?.partial_reason, "impl_no_test");
});

test("review-surfaces.EVAL.3 scans all targeted unchanged implementation proof candidates before applying the broad cap", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-targeted-proof-cap-"));
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
      1: Evaluate exact proof.
`
  );
  for (let index = 0; index < 520; index += 1) {
    fs.writeFileSync(path.join(tmp, "src", "evaluation", `a${String(index).padStart(3, "0")}.ts`), `export const n${index} = ${index};\n`);
  }
  fs.writeFileSync(path.join(tmp, "src", "evaluation", "z-proof.ts"), "export const evalProof = 'example.EVAL.1';\n");
  fs.writeFileSync(path.join(tmp, "tests", "evaluation.test.ts"), "test('example.EVAL.1 exact test evidence', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "head"], { cwd: tmp, stdio: "ignore" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: head,
    headRef: head,
    dogfood: false
  });

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "satisfied");
});

test("review-surfaces.EVAL.3 scans repo-wide implementation proof beyond 500 untargeted files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-broad-proof-cap-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "misc"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: Evaluate broad proof.
`
  );
  for (let index = 0; index < 520; index += 1) {
    fs.writeFileSync(path.join(tmp, "src", "misc", `a${String(index).padStart(3, "0")}.ts`), `export const n${index} = ${index};\n`);
  }
  fs.writeFileSync(path.join(tmp, "src", "misc", "z-proof.ts"), "export const evalProof = 'example.EVAL.1';\n");
  fs.writeFileSync(path.join(tmp, "tests", "misc.test.ts"), "test('example.EVAL.1 broad test evidence', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "head"], { cwd: tmp, stdio: "ignore" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: head,
    headRef: head,
    dogfood: false
  });

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  assert.equal(evaluation.acai_coverage["example.EVAL.1"], "satisfied");
});

test("review-surfaces.EVAL.3 keeps test-path proof strict when area prefixes appear as nested substrings", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-strict-test-proof-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "special"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests", "fixtures", "src", "special"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  SPECIAL:
    requirements:
      1: Build special behavior.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "special", "feature.ts"), "export const special = true;\n");
  fs.writeFileSync(path.join(tmp, "tests", "fixtures", "src", "special", "example.test.ts"), "test('fixture path only', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/special/feature.ts", status: "A", source: "working_tree" }];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, {
    areas: [{
      id: "SPECIAL",
      name: "Special",
      groupKey: "SPECIAL",
      prefixes: ["src/special/"],
      purpose: "Special behavior.",
      pattern: "special",
      testKeywords: []
    }]
  });

  assert.equal(evaluation.acai_coverage["example.SPECIAL.1"], "partial");
  assert.equal(evaluation.results.find((result) => result.acai_id === "example.SPECIAL.1")?.partial_reason, "impl_no_test");
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

test("review-surfaces.EVAL.3 treats changed discovered tests as exact test evidence outside configured globs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-discovered-test-proof-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  EVAL:
    requirements:
      1: Evaluate discovered test proof.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "foo.ts"), "export const evalProof = 'example.EVAL.1';\n");
  fs.writeFileSync(path.join(tmp, "src", "foo.test.ts"), "test('example.EVAL.1 discovered exact test evidence', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "head"], { cwd: tmp, stdio: "ignore" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: head,
    headRef: head,
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/foo.test.ts", status: "M", source: "diff" }];

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
      1: GitLab and Gerrit adapters must remain optional later provider integrations.
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
    spec_mode: "acai",
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

// #5: partial_reason lifts the partial sub-cases the evaluator already
// distinguishes in prose into a structured enum. A changed implementation file
// with no test mapped to its group -> impl_no_test; a test mapped to a group
// with no implementation change -> test_no_impl. The field is set deterministically
// only when status === "partial".
test("review-surfaces.EVAL.5 sets partial_reason for impl-no-test and test-no-impl partials", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-partial-reason-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "risks"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "diagrams"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  RISK:
    requirements:
      1: Build risks.
  ARCH:
    requirements:
      1: Build diagrams.
`
  );
  // RISK: implementation changed, but no test maps to the RISK group -> impl_no_test.
  fs.writeFileSync(path.join(tmp, "src", "risks", "risks.ts"), "export const risk = true;\n");
  // ARCH: a test whose filename matches the ARCH test_keyword ("diagram") maps to
  // the ARCH group, but no implementation file changed -> test_no_impl.
  fs.writeFileSync(path.join(tmp, "tests", "diagram.test.ts"), "test('diagram surfaces', () => {});\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const collection = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: ["tests/**/*.test.ts"] },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });
  collection.changedFiles = [{ path: "src/risks/risks.ts", status: "A", source: "working_tree" }];

  const intent = await buildIntent(tmp, collection);
  const evaluation = await evaluateIntent(tmp, collection, intent, { areas: await defaultReviewSurfacesAreas() });

  const risk = evaluation.results.find((result) => result.acai_id === "example.RISK.1");
  const arch = evaluation.results.find((result) => result.acai_id === "example.ARCH.1");

  assert.equal(risk?.status, "partial");
  assert.equal(risk?.partial_reason, "impl_no_test");
  assert.equal(arch?.status, "partial");
  assert.equal(arch?.partial_reason, "test_no_impl");

  // Non-partial results never carry a partial_reason.
  for (const result of evaluation.results) {
    if (result.status !== "partial") {
      assert.equal(result.partial_reason, undefined, `${result.requirement_id} should not carry partial_reason`);
    }
  }

  // The new optional partial_reason field is additive: a packet carrying these
  // evaluation results (with partial_reason present) still validates against the
  // checked-in schema. A bogus partial_reason value is rejected by the enum.
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "review_packet.schema.json"), "utf8"));
  const packet = packetWithEvaluationResults(evaluation.results);
  assert.equal(validateJsonSchema(schema, packet).valid, true);

  const bogus = packetWithEvaluationResults([
    { ...(risk as unknown as Record<string, unknown>), partial_reason: "not_a_real_reason" }
  ]);
  const invalid = validateJsonSchema(schema, bogus);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((issue: { message: string }) => issue.message.includes("Expected one of")));
});

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
      uncommitted_files: 0,
      run_mode: "local",
      input_hashes: []
    },
    intent: { summary: "partial_reason fixture", spec_mode: "acai", requirements: [] },
    evaluation: { summary: "partial_reason fixture", results, overreach: [], acai_coverage: {} },
    architecture: {
      summary: "partial_reason fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "partial_reason fixture",
      missing_logs: true,
      considered: [],
      research: [],
      decisions: [],
      unchallenged_assumptions: [],
      skipped_checks: [],
      claims_without_evidence: [],
      verified_claims: [],
      workflow_findings: [],
      quality_flags: [],
      evidence: []
    },
    risks: {
      summary: "partial_reason fixture",
      items: [],
      test_evidence: [],
      test_gaps: [],
      missing_automatic_tests: [],
      missing_manual_checks: [],
      review_focus: []
    }
  };
}
