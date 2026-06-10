import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRelativeImports } from "../src/collector/import-graph";
import { computeRankingEvidence } from "../src/risks/ranking-evidence";
import { isTestPath } from "../src/scope/pr-scope";
import { parseStructuredDiff } from "../src/collector/diff-hunks";

const REPO = new Set([
  "src/foo.ts",
  "src/bar/index.ts",
  "src/cli/index.ts",
  "tests/foo.test.ts"
]);
const exists = (p: string): boolean => REPO.has(p);

test("review-surfaces.RANKING.1 resolveRelativeImports resolves relative TS imports (with .js suffix and index) and skips bare specifiers", () => {
  const content = [
    `import { foo } from "../src/foo.js";`,
    `import { bar } from "../src/bar";`,
    `import { ts } from "typescript";`,
    `const x = require("../src/foo");`
  ].join("\n");
  const targets = resolveRelativeImports("tests/foo.test.ts", content, exists);
  assert.deepEqual(targets, ["src/bar/index.ts", "src/foo.ts"]);
  // Bare specifier (node_modules) is not resolved.
  assert.ok(!targets.includes("typescript"));
});

function diffWith(paths: string[]): ReturnType<typeof parseStructuredDiff> {
  const lines: string[] = [];
  for (const p of paths) {
    lines.push(`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, "@@ -1,1 +1,2 @@", " ctx", "+changed");
  }
  return parseStructuredDiff(lines.join("\n"));
}

test("review-surfaces.RANKING.1 a changed test importing a changed impl maps to that impl (import signal)", () => {
  const diff = diffWith(["src/foo.ts", "tests/foo.test.ts"]);
  const evidence = computeRankingEvidence({
    diff,
    isTestPath,
    readHead: (p) => (p === "tests/foo.test.ts" ? `import { foo } from "../src/foo";` : undefined),
    exists
  });
  assert.deepEqual(evidence.changed_tests_by_impl, { "src/foo.ts": ["tests/foo.test.ts"] });
});

test("review-surfaces.RANKING.1 basename fallback maps a changed test to a changed impl when imports do not resolve", () => {
  const diff = diffWith(["src/foo.ts", "tests/foo.test.ts"]);
  const evidence = computeRankingEvidence({
    diff,
    isTestPath,
    // No resolvable import (path alias / no content) — basename foo.test.ts -> foo.ts.
    readHead: () => `import { foo } from "@app/foo";`,
    exists
  });
  assert.deepEqual(evidence.changed_tests_by_impl, { "src/foo.ts": ["tests/foo.test.ts"] });
});

test("review-surfaces.RANKING.1 a resolved import suppresses the basename fallback (no false same-stem match)", () => {
  const repo = new Set(["src/foo.ts", "src/legacy/foo.ts", "tests/foo.test.ts"]);
  const diff = diffWith(["src/foo.ts", "src/legacy/foo.ts", "tests/foo.test.ts"]);
  const evidence = computeRankingEvidence({
    diff,
    isTestPath,
    // Imports resolve to src/foo.ts only; src/legacy/foo.ts shares the stem but is
    // NOT imported and must not be marked as having a focused test.
    readHead: (p) => (p === "tests/foo.test.ts" ? `import { foo } from "../src/foo";` : undefined),
    exists: (p) => repo.has(p)
  });
  assert.deepEqual(evidence.changed_tests_by_impl, { "src/foo.ts": ["tests/foo.test.ts"] });
  assert.ok(!("src/legacy/foo.ts" in evidence.changed_tests_by_impl));
});

test("review-surfaces.RANKING.3 computeRankingEvidence is deterministic and sorted for identical inputs", () => {
  const diff = diffWith(["src/foo.ts", "src/cli/index.ts", "tests/foo.test.ts"]);
  const args = {
    diff,
    isTestPath,
    readHead: (p: string) => (p === "tests/foo.test.ts" ? `import "../src/foo"; import "../src/cli/index";` : undefined),
    exists
  };
  const a = computeRankingEvidence(args);
  const b = computeRankingEvidence(args);
  assert.deepEqual(a, b);
  // Tests listed per impl are sorted; impl keys are sorted.
  assert.deepEqual(Object.keys(a.changed_tests_by_impl), ["src/cli/index.ts", "src/foo.ts"]);
});

test("review-surfaces.RANKING.1 a changed impl with no co-changed test yields no test-change signal", () => {
  const diff = diffWith(["src/foo.ts"]);
  const evidence = computeRankingEvidence({ diff, isTestPath, readHead: () => undefined, exists });
  assert.deepEqual(evidence.changed_tests_by_impl, {});
});
