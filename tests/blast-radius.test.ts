import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImportGraph, findSymbolImporters, findSymbolReferences, resolveRuntimeRelativeImports } from "../src/collector/import-graph";

const FILES: Record<string, string> = {
  "src/core.ts": "export function widely(): number { return 1; }\nexport function unused(): number { return 2; }",
  "src/a.ts": 'import { widely } from "./core";\nexport const a = widely();',
  "src/b.ts": 'import { widely } from "./core";\nexport const b = widely();',
  "src/c.ts": 'import * as core from "./core";\nexport const c = core.widely();',
  "src/d.ts": 'import { unrelated } from "./other";\nexport const d = 1;',
  "src/other.ts": "export const unrelated = 1;"
};
const read = (p: string): string | undefined => FILES[p];
const exists = (p: string): boolean => p in FILES;

test("review-surfaces.BLAST_RADIUS.1 the reverse import graph maps modules to sorted importers over indexed sources", () => {
  const graph = buildImportGraph({ files: Object.keys(FILES), read, exists });
  assert.deepEqual(graph.importers.get("src/core.ts"), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(graph.truncated, false);
});

test("review-surfaces.BLAST_RADIUS.2 symbol importers count named and namespace references, not mere module imports", () => {
  const graph = buildImportGraph({ files: Object.keys(FILES), read, exists });
  const widely = findSymbolImporters({ graph, modulePath: "src/core.ts", symbols: ["widely"], read });
  // a + b (named import) and c (core.widely namespace reference).
  assert.deepEqual(widely, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  // A symbol no importer references has zero users even though the module has importers.
  assert.deepEqual(findSymbolImporters({ graph, modulePath: "src/core.ts", symbols: ["unused"], read }), []);
});

test("review-surfaces.BLAST_RADIUS.3 the build is bounded by a file cap and reports truncation instead of a silent partial graph", () => {
  const graph = buildImportGraph({ files: Object.keys(FILES), read, exists, fileCap: 2 });
  assert.equal(graph.truncated, true);
  // Determinism: same inputs, same graph.
  const again = buildImportGraph({ files: Object.keys(FILES), read, exists, fileCap: 2 });
  assert.deepEqual([...graph.importers.entries()], [...again.importers.entries()]);
});

test("review-surfaces.BLAST_RADIUS.2 namespaced API members match only real qualified consumers", () => {
  const files: Record<string, string> = {
    "src/types.ts": "export namespace N { export interface Value { id: string } export interface Other { id: string } }",
    "src/direct.ts": 'import { N } from "./types"; export const value: N.Value = { id: "x" };',
    "src/aliased.ts": 'import { N as Models } from "./types"; export const value: Models.Value = { id: "x" };',
    "src/namespace.ts": 'import * as api from "./types"; export const value: api.N.Value = { id: "x" };',
    "src/import-equals.ts": 'import api = require("./types"); export const value: api.N.Value = { id: "x" };',
    "src/other.ts": 'import { N } from "./types"; export const other: N.Other = { id: "x" };',
    "src/decoy.ts": 'import { N } from "./types"; export const other: N.Other = { id: "x" }; // N.Value\nexport const text = "N.Value";',
    "src/barrel.ts": 'export { N } from "./types";'
  };
  const read = (filePath: string): string | undefined => files[filePath];
  const graph = buildImportGraph({ files: Object.keys(files), read, exists: (filePath) => filePath in files });

  assert.deepEqual(
    findSymbolImporters({ graph, modulePath: "src/types.ts", symbols: ["N.Value"], read }),
    ["src/aliased.ts", "src/barrel.ts", "src/direct.ts", "src/import-equals.ts", "src/namespace.ts"]
  );
  assert.deepEqual(
    findSymbolImporters({ graph, modulePath: "src/types.ts", symbols: ["namespace:N"], read }),
    ["src/aliased.ts", "src/barrel.ts", "src/decoy.ts", "src/direct.ts", "src/import-equals.ts", "src/namespace.ts", "src/other.ts"]
  );
  assert.deepEqual(
    findSymbolImporters({ graph, modulePath: "src/types.ts", symbols: ["export="], read }),
    ["src/import-equals.ts"]
  );
});

test("review-surfaces.REVIEWER_VALUE.11 distinguishes public re-exports from ordinary imports", () => {
  const files: Record<string, string> = {
    "src/core.ts": "export function value(): number { return 1; }",
    "src/named.ts": 'export { value as publicValue } from "./core";',
    "src/star.ts": 'export * from "./core";',
    "src/namespace.ts": 'export * as core from "./core";',
    "src/local.ts": 'import { value as localValue } from "./core"; export { localValue as localPublic };',
    "src/export-before.ts": 'export { lateValue as latePublic }; import { value as lateValue } from "./core";',
    "src/two-hop.ts": 'export { publicValue as finalValue } from "./named";',
    "src/caller.ts": 'import { value } from "./core"; export const result = value();'
  };
  const read = (filePath: string): string | undefined => files[filePath];
  const graph = buildImportGraph({ files: Object.keys(files), read, exists: (filePath) => filePath in files });
  assert.deepEqual(
    findSymbolReferences({ graph, modulePath: "src/core.ts", symbols: ["value"], read }).reexporters,
    ["src/export-before.ts", "src/local.ts", "src/named.ts", "src/namespace.ts", "src/star.ts", "src/two-hop.ts"]
  );
});

test("review-surfaces.REVIEWER_VALUE.11 star barrels do not expose default exports", () => {
  const files: Record<string, string> = {
    "src/core.ts": "export default function value(): number { return 1; }",
    "src/star.ts": 'export * from "./core";'
  };
  const read = (filePath: string): string | undefined => files[filePath];
  const graph = buildImportGraph({ files: Object.keys(files), read, exists: (filePath) => filePath in files });
  assert.deepEqual(findSymbolReferences({ graph, modulePath: "src/core.ts", symbols: ["default"], read }).reexporters, []);
});

test("review-surfaces.REVIEWER_VALUE.11 follows default and export-equals assignments through barrels", () => {
  const files: Record<string, string> = {
    "src/default-core.ts": "export default function value(): number { return 1; }",
    "src/default-mid.ts": 'import implementation from "./default-core"; export default implementation;',
    "src/default-public.ts": 'export { default as api } from "./default-mid";',
    "src/equals-core.ts": "const value = 1; export = value;",
    "src/equals-public.ts": 'import value = require("./equals-core"); export = value;'
  };
  const read = (filePath: string): string | undefined => files[filePath];
  const graph = buildImportGraph({ files: Object.keys(files), read, exists: (filePath) => filePath in files });
  assert.deepEqual(
    findSymbolReferences({ graph, modulePath: "src/default-core.ts", symbols: ["default"], read }).reexporters,
    ["src/default-mid.ts", "src/default-public.ts"]
  );
  assert.deepEqual(
    findSymbolReferences({ graph, modulePath: "src/equals-core.ts", symbols: ["export="], read }).reexporters,
    ["src/equals-public.ts"]
  );
});

test("review-surfaces.ARCH_DRIFT.1 declaration files never enter runtime emit analysis", () => {
  for (const filePath of ["types/public.d.ts", "types/public.d.mts", "types/public.d.cts"]) {
    assert.deepEqual(
      resolveRuntimeRelativeImports(filePath, 'import { Value } from "./value"; export interface Public extends Value {}', () => true),
      [],
      `${filePath} is declaration-only`
    );
  }
});
