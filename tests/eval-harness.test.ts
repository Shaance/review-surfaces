// review-surfaces.EVAL_HARNESS.1-4: the effectiveness eval harness. Each case
// seeds one regression class into a real temp repo, runs the real pipeline with
// the mock provider, and asserts the seeded issue ranks in the top N of the
// queue (or blocks) — plus negative fixtures that must NOT rank. Runs inside
// `pnpm run test`, so CI gates review quality automatically; a scoreboard is
// emitted per fact class.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { HumanReviewModel } from "../src/human/contract";
import { createEvalFixture } from "./helpers/eval-fixture";

// review-surfaces.EVAL_HARNESS.3: keep N generous (top 10) so the gate catches
// real regressions without freezing every ranking tweak.
const TOP_N = 10;

const scoreboard: Record<string, { passed: number; total: number }> = {};

function record(klass: string, run: () => void): void {
  const entry = (scoreboard[klass] ??= { passed: 0, total: 0 });
  entry.total += 1;
  run();
  entry.passed += 1;
}

function topQueue(model: HumanReviewModel): HumanReviewModel["review_queue"] {
  return model.review_queue.slice(0, TOP_N);
}

function inTopQueue(model: HumanReviewModel, predicate: (item: HumanReviewModel["review_queue"][number]) => boolean): boolean {
  return topQueue(model).some(predicate);
}

after(() => {
  // review-surfaces.EVAL_HARNESS.4: cases passed / total per fact class.
  const outDir = path.join(process.cwd(), ".review-surfaces");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "eval_scoreboard.json"),
    `${JSON.stringify({ schema_version: "review-surfaces.eval_scoreboard.v1", top_n: TOP_N, classes: scoreboard }, null, 2)}\n`
  );
});

test("review-surfaces.EVAL_HARNESS.2 weakened test ranks in the top N", () => {
  const fixture = createEvalFixture("weakened-test");
  try {
    fixture.write(
      "tests/calc.test.ts",
      `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/calc";

test.skip("app.CORE.1 add sums two numbers", () => {
  assert.equal(add(1, 2), 3);
});
`
    );
    fixture.commit("skip the test");
    record("weakened_test", () => {
      const model = fixture.run();
      assert.ok(
        inTopQueue(model, (item) => item.path === "tests/calc.test.ts" && /skip|weaken/i.test(`${item.title} ${item.reason}`)),
        "seeded skipped test must rank in the top N"
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test("review-surfaces.EVAL_HARNESS.2 breaking API change ranks in the top N", () => {
  const fixture = createEvalFixture("api-break");
  try {
    fixture.write(
      "src/calc.ts",
      `export function add(left: number, right: number, base: number): number {
  return left + right + base;
}
`
    );
    fixture.commit("break add signature");
    record("api_break", () => {
      const model = fixture.run();
      assert.ok(
        inTopQueue(model, (item) => item.path === "src/calc.ts" && /API|signature|export/i.test(`${item.title} ${item.reason}`)),
        "seeded exported-signature change must rank in the top N"
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test("review-surfaces.EVAL_HARNESS.2 schema contract change ranks in the top N", () => {
  const fixture = createEvalFixture("schema-change");
  try {
    fixture.write(
      "schemas/thing.schema.json",
      `{
  "type": "object",
  "required": ["name", "size"],
  "properties": {
    "name": { "type": "string" },
    "size": { "type": "integer" }
  }
}
`
    );
    fixture.commit("make size required");
    record("schema_change", () => {
      const model = fixture.run();
      assert.ok(
        inTopQueue(model, (item) => item.path === "schemas/thing.schema.json" && /required|contract|schema/i.test(`${item.title} ${item.reason}`)),
        "seeded schema-contract change must rank in the top N"
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test("review-surfaces.EVAL_HARNESS.2 a committed secret ranks in the top N and blocks", () => {
  const fixture = createEvalFixture("secret");
  try {
    const token = `ghp_${"a".repeat(36)}`;
    fixture.write(
      "src/calc.ts",
      `export function add(left: number, right: number): number {
  return left + right;
}
export const token = "${token}";
`
    );
    fixture.commit("commit a token");
    record("secret_in_diff", () => {
      const model = fixture.run();
      assert.ok(
        inTopQueue(model, (item) => item.path === "src/calc.ts" && /secret/i.test(`${item.title} ${item.reason}`)),
        "seeded secret must rank in the top N"
      );
      assert.ok(model.blockers.some((blocker) => /secret/i.test(blocker.summary)), "a committed secret must block");
      // The secret value itself never enters the model.
      assert.ok(!JSON.stringify(model).includes(token), "the secret text must not leak into the model");
    });
  } finally {
    fixture.cleanup();
  }
});

test("review-surfaces.EVAL_HARNESS.2 uncovered changed lines (synthetic lcov) produce coverage evidence", () => {
  const fixture = createEvalFixture("uncovered");
  try {
    fixture.write(
      "src/calc.ts",
      `export function add(left: number, right: number): number {
  return left + right;
}
export function risky(value: number): number {
  return value / 0;
}
`
    );
    fixture.commit("add uncovered function");
    // Synthetic lcov written AFTER the head commit (so it is current): the new
    // lines 4-6 are instrumented but never executed.
    fixture.write(
      "report.lcov",
      ["TN:", "SF:src/calc.ts", "DA:1,5", "DA:2,5", "DA:4,0", "DA:5,0", "DA:6,0", "end_of_record", ""].join("\n")
    );
    record("uncovered_changed_lines", () => {
      const model = fixture.run(["--coverage", "report.lcov"]);
      assert.equal(model.coverage_evidence.status, "report");
      assert.ok(
        model.evidence_cards.some((card) => /uncovered/i.test(card.title) && /src\/calc\.ts/.test(card.summary)),
        "uncovered changed lines must produce an evidence card"
      );
      assert.ok(
        inTopQueue(model, (item) => item.path === "src/calc.ts" && item.ranking_reasons.some((reason) => /executed by any test/.test(reason))),
        "the uncovered file's queue item must carry the coverage ranking reason"
      );
    });
  } finally {
    fixture.cleanup();
  }
});

// --- Negative fixtures (review-surfaces.EVAL_HARNESS.2/.3) -------------------

test("review-surfaces.EVAL_HARNESS.3 a literal [REDACTED:...] placeholder in docs does not block", () => {
  const fixture = createEvalFixture("placeholder");
  try {
    fixture.write("README.md", "# fixture app\n\nExpected output: `[REDACTED:github_token]`\n");
    fixture.commit("document the redaction marker");
    record("benign_redaction_placeholder", () => {
      const model = fixture.run();
      assert.equal(model.blockers.length, 0, "a literal placeholder must not block");
      assert.ok(!topQueue(model).some((item) => /secret/i.test(item.title)), "no secret finding for a placeholder");
    });
  } finally {
    fixture.cleanup();
  }
});

test("review-surfaces.EVAL_HARNESS.3 a rename-only change does not rank high or block", () => {
  const fixture = createEvalFixture("rename-only");
  try {
    fixture.rename("src/util.ts", "src/helper.ts");
    fixture.commit("rename util to helper");
    record("benign_rename", () => {
      const model = fixture.run();
      assert.equal(model.blockers.length, 0, "a pure rename must not block");
      assert.ok(
        !topQueue(model).some((item) => item.priority === "blocker" || item.priority === "high"),
        "a pure rename must not produce a high-priority queue item"
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test("review-surfaces.EVAL_HARNESS.3 a format-only change does not rank high or block", () => {
  const fixture = createEvalFixture("format-only");
  try {
    fixture.write(
      "src/util.ts",
      `export function double(value: number): number {
    return value * 2;
}
`
    );
    fixture.commit("reindent only");
    record("benign_format", () => {
      const model = fixture.run();
      assert.equal(model.blockers.length, 0, "a format-only change must not block");
      assert.ok(
        !topQueue(model).some((item) => item.priority === "blocker" || item.priority === "high"),
        "a format-only change must not produce a high-priority queue item"
      );
    });
  } finally {
    fixture.cleanup();
  }
});
