import test from "node:test";
import assert from "node:assert/strict";
import { computeArchDriftFacts } from "../src/risks/arch-drift";
import { buildChangeGraphSections } from "../src/human/change-graph";

function readerFor(files: Record<string, string>): { read: (filePath: string) => string | undefined; exists: (filePath: string) => boolean } {
  return {
    read: (filePath) => files[filePath],
    exists: (filePath) => filePath in files
  };
}

test("review-surfaces.ARCH_DRIFT.1 emits one canonical concrete runtime cycle alongside module-edge facts", () => {
  const base = readerFor({
    "src/core/util.ts": `export const u = 1;`,
    "src/render/view.ts": `export const v = 1;`,
    "src/old/dep.ts": `export const d = 1;`,
    "src/render/legacy.ts": `import { d } from "../old/dep";\nexport const l = d;`
  });
  const head = readerFor({
    "src/core/util.ts": `import { v } from "../render/view";\nexport const u = v;`,
    "src/render/view.ts": `import { u } from "../core/util";\nexport const v = u;`,
    "src/old/dep.ts": `export const d = 1;`,
    "src/render/legacy.ts": `export const l = 1;`
  });
  const result = computeArchDriftFacts({
    changedFiles: [
      { path: "src/render/view.ts", status: "M" },
      { path: "src/core/util.ts", status: "M" },
      { path: "src/render/legacy.ts", status: "M" }
    ],
    readBase: base.read,
    readHead: head.read,
    existsBase: base.exists,
    existsHead: head.exists
  });
  const kinds = result.facts.map((fact) => `${fact.kind}:${fact.from_module}->${fact.to_module}`).sort();
  assert.deepEqual(kinds, [
    "import_cycle_created:src/core->src/render",
    "module_edge_added:src/core->src/render",
    "module_edge_added:src/render->src/core",
    "module_edge_removed:src/render->src/old"
  ]);
  const added = result.facts.find((fact) => fact.kind === "module_edge_added" && fact.from_module === "src/render");
  assert.deepEqual(added?.files, ["src/render/view.ts"]);
  assert.match(added?.detail ?? "", /no import between these modules existed at the base/);
  const cycle = result.facts.find((fact) => fact.kind === "import_cycle_created");
  assert.deepEqual(cycle?.cycle, ["src/core/util.ts", "src/render/view.ts", "src/core/util.ts"]);
  assert.match(cycle?.detail ?? "", /runtime import cycle created/);
  // File-level deltas for the map renderers.
  assert.ok(result.file_edges.added.some((edge) => edge.importer === "src/render/view.ts" && edge.imported === "src/core/util.ts"));
  assert.ok(result.file_edges.removed.some((edge) => edge.importer === "src/render/legacy.ts" && edge.imported === "src/old/dep.ts"));
});

test("review-surfaces.ARCH_DRIFT.1 applies default TypeScript type erasure to explicit and implicit type-only imports", () => {
  const base = readerFor({
    "src/core/types.ts": `export interface Options { enabled: boolean }`,
    "src/render/view.ts": `export const view = "ok";`
  });
  const head = readerFor({
    "src/core/types.ts": `export interface Options { enabled: boolean }`,
    "src/render/view.ts": `import type { Options } from "../core/types";\nexport type ViewOptions = Options;`,
    "src/render/implicit.ts": `import { Options } from "../core/types";\nexport type ImplicitOptions = Options;`
  });
  const result = computeArchDriftFacts({
    changedFiles: [
      { path: "src/render/view.ts", status: "M" },
      { path: "src/render/implicit.ts", status: "A" }
    ],
    readBase: base.read,
    readHead: head.read,
    existsBase: base.exists,
    existsHead: head.exists
  });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.file_edges.added, []);
});

test("review-surfaces.ARCH_DRIFT.1 suppresses directory-aggregate cycles without a concrete file return path", () => {
  const base = readerFor({
    "src/a/one.ts": `export const one = 1;`,
    "src/a/two.ts": `export const two = 2;`,
    "src/b/one.ts": `export const one = 1;`,
    "src/b/two.ts": `export const two = 2;`
  });
  const head = readerFor({
    "src/a/one.ts": `import { one } from "../b/one";\nexport const value = one;`,
    "src/a/two.ts": `export const two = 2;`,
    "src/b/one.ts": `export const one = 1;`,
    "src/b/two.ts": `import { two } from "../a/two";\nexport const value = two;`
  });
  const result = computeArchDriftFacts({
    changedFiles: [
      { path: "src/a/one.ts", status: "M" },
      { path: "src/b/two.ts", status: "M" }
    ],
    readBase: base.read,
    readHead: head.read,
    existsBase: base.exists,
    existsHead: head.exists
  });
  assert.equal(result.facts.filter((fact) => fact.kind === "import_cycle_created").length, 0);
  assert.equal(result.facts.filter((fact) => fact.kind === "module_edge_added").length, 2);
});

test("review-surfaces.ARCH_DRIFT.1 proves a concrete cycle through unchanged runtime files", () => {
  const base = readerFor({
    "src/a/start.ts": `export const start = 1;`,
    "src/b/middle.ts": `import { end } from "../c/end";\nexport const middle = end;`,
    "src/c/end.ts": `import { start } from "../a/start";\nexport const end = start;`
  });
  const head = readerFor({
    ...Object.fromEntries(["src/b/middle.ts", "src/c/end.ts"].map((filePath) => [filePath, base.read(filePath) as string])),
    "src/a/start.ts": `import { middle } from "../b/middle";\nexport const start = middle;`
  });
  const result = computeArchDriftFacts({
    changedFiles: [{ path: "src/a/start.ts", status: "M" }],
    readBase: base.read,
    readHead: head.read,
    existsBase: base.exists,
    existsHead: head.exists,
    headFileDependencies: new Map([
      ["src/a/start.ts", ["src/b/middle.ts"]],
      ["src/b/middle.ts", ["src/c/end.ts"]],
      ["src/c/end.ts", ["src/a/start.ts"]]
    ])
  });
  assert.deepEqual(
    result.facts.find((fact) => fact.kind === "import_cycle_created")?.cycle,
    ["src/a/start.ts", "src/b/middle.ts", "src/c/end.ts", "src/a/start.ts"]
  );
});

test("review-surfaces.ARCH_DRIFT.2 drift edge deltas set kind new/removed on change_graph edges (and removed edges never enter the tour topology)", () => {
  const sections = buildChangeGraphSections({
    files: [
      { path: "src/core/util.ts", status: "M", added: 1, removed: 0 },
      { path: "src/render/view.ts", status: "M", added: 2, removed: 0 },
      { path: "src/render/legacy.ts", status: "M", added: 0, removed: 2 }
    ],
    edges: [{ importer: "src/render/view.ts", imported: "src/core/util.ts" }],
    usedBy: [],
    lensFindings: [],
    reviewQueue: [],
    driftEdges: {
      added: [{ importer: "src/render/view.ts", imported: "src/core/util.ts" }],
      removed: [{ importer: "src/render/legacy.ts", imported: "src/core/util.ts" }]
    }
  });
  assert.deepEqual(sections.change_graph.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })), [
    { from: "src/render/legacy.ts", to: "src/core/util.ts", kind: "removed" },
    { from: "src/render/view.ts", to: "src/core/util.ts", kind: "new" }
  ]);
  assert.deepEqual(
    sections.change_graph.edges.map((edge) => edge.insight_source),
    ["fallback", "fallback"]
  );
  assert.match(sections.change_graph.edges[0]?.summary ?? "", /stopped using/);
  assert.match(sections.change_graph.edges[1]?.summary ?? "", /now uses/);
  // The removed edge is not a head dependency: the tour must not order
  // src/core/util.ts before src/render/legacy.ts because of it.
  const flat = sections.reading_order.legs.flatMap((leg) => leg.steps.map((step) => step.path));
  assert.equal(flat.length, 3);
});

test("review-surfaces.ARCH_DRIFT.3 a rename re-creating its old edges is not drift, and unresolvable imports count as unknown, never removed", () => {
  // Rename: src/render/old-name.ts -> src/render/new-name.ts, same resolved import.
  const base = readerFor({
    "src/render/old-name.ts": `import { u } from "../core/util";\nexport const o = u;`,
    "src/core/util.ts": `export const u = 1;`
  });
  const head = readerFor({
    "src/render/new-name.ts": `import { u } from "../core/util";\nexport const o = u;`,
    "src/core/util.ts": `export const u = 1;`
  });
  const renamed = computeArchDriftFacts({
    changedFiles: [{ path: "src/render/new-name.ts", old_path: "src/render/old-name.ts", status: "R" }],
    readBase: base.read,
    readHead: head.read,
    existsBase: base.exists,
    existsHead: head.exists
  });
  assert.deepEqual(renamed.facts, []);
  assert.deepEqual(renamed.file_edges.added, []);

  // Alias imports do not resolve: dropping one must NOT count as removed.
  const aliasBase = readerFor({ "src/render/view.ts": `import { x } from "@app/alias";\nexport const v = x;` });
  const aliasHead = readerFor({ "src/render/view.ts": `export const v = 1;` });
  const alias = computeArchDriftFacts({
    changedFiles: [{ path: "src/render/view.ts", status: "M" }],
    readBase: aliasBase.read,
    readHead: aliasHead.read,
    existsBase: aliasBase.exists,
    existsHead: aliasHead.exists
  });
  assert.deepEqual(alias.facts, []);
});
