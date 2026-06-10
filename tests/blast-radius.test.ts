import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImportGraph, findSymbolImporters } from "../src/collector/import-graph";

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
