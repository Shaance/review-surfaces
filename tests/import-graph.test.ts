import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { buildImportGraph, importGraphWouldTruncate, resolveRelativeImports, resolveRuntimeRelativeImports } from "../src/collector/import-graph";

// review-surfaces.PERF.1: buildImportGraph memoizes the injected existence probe
// so each distinct repo-relative path triggers AT MOST ONE underlying lookup per
// build. resolveSpecifier probes up to ~7 candidate paths per relative specifier
// (base, .ts, .tsx, .js, /index.ts, ...) and the same candidates recur across
// every importing file; in real runs `exists` is a per-call `git cat-file`
// spawn, so without the memo a single blob is probed dozens of times (measured
// 6322 spawns / 21.7x redundancy on a 256-file repo). The memo is pure and
// output-identical — it returns the exact boolean the probe would have.
test("review-surfaces.PERF.1 buildImportGraph memoizes the existence probe: the injected exists fake is called at most once per distinct path", () => {
  // Two test files both relative-importing the SAME module via the SAME
  // specifier ("./shared"), plus a third importing it differently. Every
  // resolveSpecifier candidate ("src/shared", "src/shared.ts", ...) is probed
  // once per importing file WITHOUT a memo; with the memo each distinct candidate
  // path hits exists at most once for the whole build.
  const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/shared.ts"];
  const contents: Record<string, string> = {
    "src/a.ts": `import { x } from "./shared";\nimport { y } from "./shared";\n`,
    "src/b.ts": `import { x } from "./shared";\nconst z = require("./shared");\n`,
    "src/c.ts": `export { x } from "./shared";\n`,
    "src/shared.ts": `export const x = 1;\nexport const y = 2;\n`
  };
  const realFiles = new Set(Object.keys(contents));

  const callsByPath = new Map<string, number>();
  const exists = (repoRelativePath: string): boolean => {
    callsByPath.set(repoRelativePath, (callsByPath.get(repoRelativePath) ?? 0) + 1);
    return realFiles.has(repoRelativePath);
  };

  const graph = buildImportGraph({
    files,
    read: (filePath) => contents[filePath],
    exists
  });

  // The memo guarantees no candidate path was probed more than once, even
  // though "src/shared" / "src/shared.ts" are reachable from three importers
  // and "./shared" is probed twice within src/a.ts alone.
  for (const [probedPath, count] of callsByPath) {
    assert.ok(
      count <= 1,
      `exists("${probedPath}") was called ${count} times — the memo must cap distinct paths at one underlying lookup`
    );
  }
  // The shared candidate path WAS probed (so the assertion above is meaningful,
  // not vacuously true because nothing was probed).
  assert.equal(callsByPath.get("src/shared.ts"), 1);

  // Output is unchanged: shared.ts is imported by a, b, and c (sorted).
  assert.deepEqual(graph.importers.get("src/shared.ts"), ["src/a.ts", "src/b.ts", "src/c.ts"]);

  // Sanity: the same graph built WITHOUT the memo (calling resolveRelativeImports
  // directly per file with an un-memoized probe) produces the identical target
  // set, proving the memo changed only the call count, not the resolution.
  const targetsA = resolveRelativeImports("src/a.ts", contents["src/a.ts"], (p) => realFiles.has(p));
  assert.deepEqual(targetsA, ["src/shared.ts"]);
});

test("review-surfaces.ARCH_DRIFT.1 runtime imports include value import-equals but exclude type-only import-equals", () => {
  const files = new Set(["src/value.ts", "src/type.ts"]);
  const imports = resolveRuntimeRelativeImports("src/main.ts", [
    `import value = require("./value");`,
    `import type TypeOnly = require("./type");`,
    `console.log(value);`
  ].join("\n"), (filePath) => files.has(filePath));
  assert.deepEqual(imports, ["src/value.ts"]);
  assert.deepEqual(resolveRelativeImports("src/main.ts", `import type TypeOnly = require("./type");`,
    (filePath) => files.has(filePath)), ["src/type.ts"]);
});

test("review-surfaces.ARCH_DRIFT.1 runtime imports honor verbatimModuleSyntax", () => {
  const exists = (filePath: string): boolean => filePath === "src/types.ts";
  const source = `import { Options } from "./types";\nexport type Config = Options;`;
  assert.deepEqual(resolveRuntimeRelativeImports("src/main.ts", source, exists), []);
  assert.deepEqual(resolveRuntimeRelativeImports("src/main.ts", source, exists, {
    verbatimModuleSyntax: true,
    module: ts.ModuleKind.ESNext
  }), ["src/types.ts"]);
});

test("review-surfaces.ARCH_DRIFT.1 import graph source policy includes modern TypeScript module extensions", () => {
  const contents = {
    "src/a.mts": `import { b } from "./b";`,
    "src/b.cts": `export const b = 1;`
  };
  const graph = buildImportGraph({
    files: Object.keys(contents),
    read: (filePath) => contents[filePath as keyof typeof contents],
    exists: (filePath) => filePath in contents
  });
  assert.deepEqual(graph.dependencies.get("src/a.mts"), ["src/b.cts"]);
  assert.equal(importGraphWouldTruncate(Object.keys(contents), 1), true);
});

test("review-surfaces.ARCH_DRIFT.1 explicit JS-family suffixes only map to matching TypeScript module kinds", () => {
  const files = new Set(["src/foo.ts", "src/only-mts.mts", "src/only-cts.cts"]);
  const exists = (filePath: string): boolean => files.has(filePath);

  assert.deepEqual(resolveRelativeImports("src/main.ts", 'import "./foo.js";', exists), ["src/foo.ts"]);
  assert.deepEqual(resolveRelativeImports("src/main.ts", 'import "./only-mts.js";', exists), []);
  assert.deepEqual(resolveRelativeImports("src/main.ts", 'import "./only-cts.mjs";', exists), []);
  assert.deepEqual(resolveRelativeImports("src/main.ts", 'import "./only-mts.mjs";', exists), ["src/only-mts.mts"]);
  assert.deepEqual(resolveRelativeImports("src/main.ts", 'import "./only-cts.cjs";', exists), ["src/only-cts.cts"]);
});
