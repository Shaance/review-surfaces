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

test("review-surfaces.EVAL_HARNESS.1 the fixture builder creates a temp repo and runs the real pipeline", () => {
  const fixture = createEvalFixture("builder");
  try {
    fixture.write("src/calc.ts", `export function add(left: number, right: number): number {\n  return right + left;\n}\n`);
    fixture.commit("reorder addition");
    const model = fixture.run();
    // The REAL pipeline ran against base..head and produced a schema-shaped model.
    assert.equal(typeof model.verdict.decision, "string");
    assert.ok(Array.isArray(model.review_queue));
  } finally {
    fixture.cleanup();
  }
});

test("review-surfaces.EVAL_HARNESS.4 the scoreboard records passed/total per class", () => {
  // The after() hook writes the scoreboard; assert the recording mechanism,
  // then remove the synthetic class so it never pollutes the emitted file.
  record("scoreboard_self_check", () => {});
  assert.ok(scoreboard["scoreboard_self_check"].passed === 1 && scoreboard["scoreboard_self_check"].total === 1);
  delete scoreboard["scoreboard_self_check"];
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

test("review-surfaces.EVAL_HARNESS.2 a sneaky new dependency with an install script ranks in the top N (DEP_FACTS)", () => {
  const fixture = createEvalFixture("sneaky-dep");
  try {
    fixture.write("package.json", `{\n  "name": "fixture-app",\n  "dependencies": {}\n}\n`);
    fixture.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages: {}\n");
    fixture.commit("add manifest");
    const fixture2 = fixture; // mutate from this committed base
    fixture2.write("package.json", `{\n  "name": "fixture-app",\n  "dependencies": {\n    "leftpad": "^2.0.0"\n  }\n}\n`);
    fixture2.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages:\n  /leftpad@2.0.0:\n    resolution: {}\n    requiresBuild: true\n");
    fixture2.commit("add sneaky dependency");
    record("sneaky_dependency", () => {
      const model = fixture2.run(["--base", "HEAD~1"]);
      assert.ok(
        inTopQueue(model, (item) => /dependency/i.test(item.title) && /leftpad/.test(item.reason)),
        "the new dependency must rank in the top N with concrete language"
      );
      assert.ok(
        model.risk_lens_findings.some((finding) => finding.lens === "supply_chain"),
        "the supply_chain lens must fire"
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test("review-surfaces.EVAL_HARNESS.2 a breaking API change with call sites carries its blast radius (BLAST_RADIUS)", () => {
  const fixture = createEvalFixture("blast");
  try {
    fixture.write("src/caller1.ts", `import { add } from "./calc";\nexport const one = add(1, 2);\n`);
    fixture.write("src/caller2.ts", `import { add } from "./calc";\nexport const two = add(2, 3);\n`);
    fixture.commit("add callers");
    fixture.write(
      "src/calc.ts",
      `export function add(left: number, right: number, base: number): number {\n  return left + right + base;\n}\n`
    );
    fixture.commit("break add signature");
    record("blast_radius", () => {
      const model = fixture.run(["--base", "HEAD~1"]);
      const item = topQueue(model).find((entry) => entry.path === "src/calc.ts" && /API|signature/i.test(entry.title));
      assert.ok(item, "the API change must rank in the top N");
      assert.match(item.reason, /Used by 3 file\(s\)/); // caller1, caller2, and the base fixture test
      assert.match(item.reason, /caller1\.ts/);
    });
  } finally {
    fixture.cleanup();
  }
});

test("review-surfaces.EVAL_HARNESS.2 a destructive migration ranks in the top N (CONFIG_FACTS)", () => {
  const fixture = createEvalFixture("migration");
  try {
    fixture.write("migrations/0002_drop.sql", "DROP TABLE users;\n");
    fixture.commit("add destructive migration");
    record("destructive_migration", () => {
      const model = fixture.run();
      assert.ok(
        inTopQueue(model, (item) => item.path === "migrations/0002_drop.sql" && /destructive|DROP/i.test(`${item.title} ${item.reason}`)),
        "the destructive migration must rank in the top N"
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test("review-surfaces.EVAL_HARNESS.2 CI permission broadening ranks in the top N (CONFIG_FACTS)", () => {
  const fixture = createEvalFixture("ci-perms");
  try {
    fixture.write(".github/workflows/build.yml", "on: push\npermissions:\n  contents: read\njobs: {}\n");
    fixture.commit("add workflow");
    fixture.write(".github/workflows/build.yml", "on: push\npermissions:\n  contents: write\njobs: {}\n");
    fixture.commit("broaden permissions");
    record("ci_permission_broadening", () => {
      const model = fixture.run(["--base", "HEAD~1"]);
      assert.ok(
        inTopQueue(model, (item) => item.path === ".github/workflows/build.yml" && /workflow|permission/i.test(`${item.title} ${item.reason}`)),
        "the broadened workflow permissions must rank in the top N"
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
