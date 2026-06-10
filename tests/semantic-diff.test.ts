import test from "node:test";
import assert from "node:assert/strict";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { computeSemanticChangeFacts, SemanticDiffSources } from "../src/risks/semantic-diff";

// ---------------------------------------------------------------------------
// review-surfaces.SEMANTIC_DIFF.1-3 — semantic facts from the meaning of the diff.
// ---------------------------------------------------------------------------

function sources(diffText: string, base: Record<string, string>, head: Record<string, string>): SemanticDiffSources {
  return {
    diff: parseStructuredDiff(diffText),
    readBase: (path) => base[path],
    readHead: (path) => head[path]
  };
}

// review-surfaces.SEMANTIC_DIFF.1: a schema change making a field required is
// reported with the field name and the kind of change.
test("review-surfaces.SEMANTIC_DIFF.1 reports a field that became required", () => {
  const path = "schemas/thing.schema.json";
  const oldSchema = JSON.stringify({ type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "string" } } });
  const newSchema = JSON.stringify({ type: "object", required: ["a", "b"], properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "string" } } });
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n");
  const facts = computeSemanticChangeFacts(sources(diffText, { [path]: oldSchema }, { [path]: newSchema }));
  assert.equal(facts.schema_changes.length, 1);
  const change = facts.schema_changes[0];
  assert.deepEqual(change.required_added, ["b"], "field b became required");
  assert.deepEqual(change.properties_added, ["c"], "property c was added");
  assert.ok(change.type_changes.some((t) => t.field === "properties.b" && t.from === "string" && t.to === "number"), "b changed type");
});

// review-surfaces.SEMANTIC_DIFF.1: an enum change is reported.
test("review-surfaces.SEMANTIC_DIFF.1 reports enum additions and removals", () => {
  const path = "schemas/status.schema.json";
  const oldSchema = JSON.stringify({ properties: { status: { enum: ["open", "closed"] } } });
  const newSchema = JSON.stringify({ properties: { status: { enum: ["open", "merged"] } } });
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const facts = computeSemanticChangeFacts(sources(diffText, { [path]: oldSchema }, { [path]: newSchema }));
  const enumChange = facts.schema_changes[0].enum_changes.find((e) => e.field === "properties.status");
  assert.ok(enumChange);
  assert.deepEqual(enumChange!.added, ["merged"]);
  assert.deepEqual(enumChange!.removed, ["closed"]);
});

// A pure schema ADD (no base version) is not diffed as a contract change.
test("review-surfaces.SEMANTIC_DIFF.1 does not diff a newly added schema", () => {
  const path = "schemas/new.schema.json";
  const diffText = [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1,1 @@", "+{}", ""].join("\n");
  const facts = computeSemanticChangeFacts(sources(diffText, {}, { [path]: "{}" }));
  assert.equal(facts.schema_changes.length, 0);
});

// review-surfaces.SEMANTIC_DIFF.3: a test file with an assertion removed fires
// the test-weakening signal; an unrelated test edit does not.
test("review-surfaces.SEMANTIC_DIFF.3 fires on a removed assertion, not on unrelated edits", () => {
  const path = "tests/sample.test.ts";
  const removedAssert = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,4 +1,3 @@",
    " test('x', () => {",
    "-  assert.equal(a, 1);",
    "   doSomething();",
    " });",
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(removedAssert, {}, {})).test_weakening;
  assert.ok(weakening.some((s) => s.kind === "removed_assertion" && s.path === path), "removed assertion fires");

  const unrelatedEdit = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    " test('x', () => {",
    "-  const a = 1;",
    "+  const a = 2;",
    "   assert.equal(a, a);",
    " });",
    ""
  ].join("\n");
  const noWeakening = computeSemanticChangeFacts(sources(unrelatedEdit, {}, {})).test_weakening;
  assert.ok(!noWeakening.some((s) => s.kind === "removed_assertion"), "an unrelated edit does not fire");
});

// A modified assertion (deleted + added) nets to zero and does not fire.
test("review-surfaces.SEMANTIC_DIFF.3 a modified assertion does not fire removed_assertion", () => {
  const path = "tests/mod.test.ts";
  const diffText = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    " test('x', () => {",
    "-  assert.equal(a, 1);",
    "+  assert.equal(a, 2);",
    " });",
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(diffText, {}, {})).test_weakening;
  assert.ok(!weakening.some((s) => s.kind === "removed_assertion"), "a modified assertion nets to zero");
});

// review-surfaces.SEMANTIC_DIFF.3: deleted test files, newly skipped tests, and
// regenerated snapshots are detected.
test("review-surfaces.SEMANTIC_DIFF.3 detects deleted tests, skips, and snapshots", () => {
  const deleted = [`diff --git a/tests/gone.test.ts b/tests/gone.test.ts`, "deleted file mode 100644", `--- a/tests/gone.test.ts`, "+++ /dev/null", "@@ -1,1 +0,0 @@", "-test('x',()=>{});", ""].join("\n");
  assert.ok(computeSemanticChangeFacts(sources(deleted, {}, {})).test_weakening.some((s) => s.kind === "deleted_test_file"));

  const skipped = [`diff --git a/tests/s.test.ts b/tests/s.test.ts`, `--- a/tests/s.test.ts`, `+++ b/tests/s.test.ts`, "@@ -1,1 +1,1 @@", "-test('x', () => {});", "+test.skip('x', () => {});", ""].join("\n");
  assert.ok(computeSemanticChangeFacts(sources(skipped, {}, {})).test_weakening.some((s) => s.kind === "skipped_test"));

  const snap = [`diff --git a/tests/__snapshots__/a.snap b/tests/__snapshots__/a.snap`, `--- a/tests/__snapshots__/a.snap`, `+++ b/tests/__snapshots__/a.snap`, "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n");
  assert.ok(computeSemanticChangeFacts(sources(snap, {}, {})).test_weakening.some((s) => s.kind === "regenerated_snapshot"));
});

// A brand-new test file (status "A") whose added lines happen to contain
// `.skip(` or fixture assertion text inside string literals must NOT fire a
// skip/removed-assertion signal — it has no prior coverage to weaken. This
// guards the dogfood false positive where tests/semantic-diff.test.ts's own
// `test.skip(` fixture strings were flagged as "1 test newly skipped".
test("review-surfaces.SEMANTIC_DIFF.3 does not fire on a newly added test file", () => {
  const path = "tests/brand-new.test.ts";
  const diffText = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,5 @@",
    "+test('describes a skip fixture', () => {",
    "+  const fixture = \"+test.skip('x', () => {});\";",
    "+  assert.ok(detect(fixture));",
    "+});",
    "+test.skip('a genuinely skipped new test', () => {});",
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(diffText, {}, {})).test_weakening;
  assert.equal(weakening.length, 0, "a new test file weakens no prior coverage");
});

// review-surfaces.SEMANTIC_DIFF.2: an exported function signature change is
// reported as an API-surface fact.
test("review-surfaces.SEMANTIC_DIFF.2 reports exported signature, add, and remove changes", () => {
  const path = "src/api.ts";
  const oldText = "export function foo(a: string): void {}\nexport const bar = 1;\nexport function gone() {}\n";
  const newText = "export function foo(a: string, b: number): void {}\nexport const bar = 1;\nexport function added() {}\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const facts = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText }));
  assert.equal(facts.api_changes.length, 1);
  const api = facts.api_changes[0];
  assert.ok(api.signatures_changed.some((s) => s.name === "foo"), "foo signature changed");
  assert.deepEqual(api.exports_added, ["added"]);
  assert.deepEqual(api.exports_removed, ["gone"]);
});

// review-surfaces.SEMANTIC_DIFF.1: enum members that are not strings (numbers,
// booleans, null) are compared as JSON values, not dropped.
test("review-surfaces.SEMANTIC_DIFF.1 detects non-string enum changes", () => {
  const path = "schemas/code.schema.json";
  const oldSchema = JSON.stringify({ properties: { code: { enum: [1, 2] } } });
  const newSchema = JSON.stringify({ properties: { code: { enum: [1, 3] } } });
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldSchema }, { [path]: newSchema })).schema_changes[0];
  const enumChange = change.enum_changes.find((e) => e.field === "properties.code");
  assert.ok(enumChange, "a numeric enum change is reported");
  assert.deepEqual(enumChange!.added, ["3"]);
  assert.deepEqual(enumChange!.removed, ["2"]);
});

// review-surfaces.SEMANTIC_DIFF.3: a newly-added snapshot file is a new test's
// first snapshot, not a regeneration that could mask a regression.
test("review-surfaces.SEMANTIC_DIFF.3 ignores an added snapshot but flags a modified one", () => {
  const added = [`diff --git a/tests/__snapshots__/new.snap b/tests/__snapshots__/new.snap`, "new file mode 100644", "--- /dev/null", `+++ b/tests/__snapshots__/new.snap`, "@@ -0,0 +1,1 @@", "+exports['x'] = `1`;", ""].join("\n");
  assert.equal(computeSemanticChangeFacts(sources(added, {}, {})).test_weakening.length, 0, "an added snapshot is not weakening");

  const modified = [`diff --git a/tests/__snapshots__/a.snap b/tests/__snapshots__/a.snap`, `--- a/tests/__snapshots__/a.snap`, `+++ b/tests/__snapshots__/a.snap`, "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n");
  assert.ok(computeSemanticChangeFacts(sources(modified, {}, {})).test_weakening.some((s) => s.kind === "regenerated_snapshot"), "a modified snapshot is flagged");
});

// review-surfaces.SEMANTIC_DIFF.3: a renamed test file still carries prior
// coverage, so a rename that also skips a test or drops an assertion fires.
test("review-surfaces.SEMANTIC_DIFF.3 inspects renamed test files for weakening", () => {
  const path = "tests/renamed.test.ts";
  const diffText = [
    `diff --git a/tests/old.test.ts b/${path}`,
    "similarity index 80%",
    `rename from tests/old.test.ts`,
    `rename to ${path}`,
    `--- a/tests/old.test.ts`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    "-test('x', () => { assert.equal(a, 1); });",
    "+test.skip('x', () => {});",
    " keep();",
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(diffText, {}, {})).test_weakening;
  assert.ok(weakening.some((s) => s.kind === "skipped_test"), "a renamed test that adds .skip fires");
});

// review-surfaces.SEMANTIC_DIFF.2: an added exported module reports its exports
// as additions; a deleted one reports removals.
test("review-surfaces.SEMANTIC_DIFF.2 reports added and deleted exported modules", () => {
  const addedPath = "src/added.ts";
  const addedDiff = [`diff --git a/${addedPath} b/${addedPath}`, "new file mode 100644", "--- /dev/null", `+++ b/${addedPath}`, "@@ -0,0 +1,1 @@", "+export const fresh = 1;", ""].join("\n");
  const addedChange = computeSemanticChangeFacts(sources(addedDiff, {}, { [addedPath]: "export const fresh = 1;\nexport function go() {}\n" })).api_changes[0];
  assert.ok(addedChange, "an added module produces an API change");
  assert.deepEqual(addedChange.exports_added.sort(), ["fresh", "go"]);

  const deletedPath = "src/gone.ts";
  const deletedDiff = [`diff --git a/${deletedPath} b/${deletedPath}`, "deleted file mode 100644", `--- a/${deletedPath}`, "+++ /dev/null", "@@ -1,1 +0,0 @@", "-export const old = 1;", ""].join("\n");
  const deletedChange = computeSemanticChangeFacts(sources(deletedDiff, { [deletedPath]: "export const old = 1;" }, {})).api_changes[0];
  assert.ok(deletedChange, "a deleted module produces an API change");
  assert.deepEqual(deletedChange.exports_removed, ["old"]);
});

// review-surfaces.SEMANTIC_DIFF.2: a changed interface body or type-alias RHS is
// a signature change (the common breaking TS API edit), not invisible.
test("review-surfaces.SEMANTIC_DIFF.2 detects interface body and type alias changes", () => {
  const path = "src/types.ts";
  const oldText = "export interface Options {\n  a: string;\n}\nexport type Result = A | B;\n";
  const newText = "export interface Options {\n  a: string;\n  b: number;\n}\nexport type Result = A | B | C;\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change, "an interface/type change produces an API change");
  assert.ok(change.signatures_changed.some((s) => s.name === "Options"), "interface member addition is a signature change");
  assert.ok(change.signatures_changed.some((s) => s.name === "Result"), "type alias RHS change is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.1: a contract change inside an array field's
// `items` schema is not invisible.
test("review-surfaces.SEMANTIC_DIFF.1 recurses into array item schemas", () => {
  const path = "schemas/tags.schema.json";
  const oldSchema = JSON.stringify({ properties: { tags: { type: "array", items: { type: "string" } } } });
  const newSchema = JSON.stringify({ properties: { tags: { type: "array", items: { type: "number" } } } });
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldSchema }, { [path]: newSchema })).schema_changes[0];
  assert.ok(change, "a change inside items is reported");
  assert.ok(change.type_changes.some((t) => t.field === "properties.tags.items" && t.from === "string" && t.to === "number"), "items.type change captured");
});

// review-surfaces.SEMANTIC_DIFF.2: a renamed module surfaces the removed old
// import path as well as the added new one.
test("review-surfaces.SEMANTIC_DIFF.2 reports removed exports at a renamed module's old path", () => {
  const oldPath = "src/api.ts";
  const newPath = "src/api2.ts";
  const diffText = [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 90%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    "@@ -1,1 +1,1 @@",
    "-export const moved = 1;",
    "+export const moved = 2;",
    ""
  ].join("\n");
  // Base content lives at the OLD path; head content at the new path.
  const change = computeSemanticChangeFacts({
    diff: parseStructuredDiff(diffText),
    readBase: (p) => (p === oldPath ? "export const moved = 1;\nexport const dropped = 9;" : undefined),
    readHead: (p) => (p === newPath ? "export const moved = 2;" : undefined)
  }).api_changes[0];
  assert.ok(change, "a renamed module produces an API change");
  assert.deepEqual(change.exports_removed, ["dropped"], "the export only in the old version is reported removed");
});

// review-surfaces.SEMANTIC_DIFF.2: a multi-line exported function signature is
// captured whole (param/return type changes on continuation lines are detected).
test("review-surfaces.SEMANTIC_DIFF.2 captures multi-line function signatures", () => {
  const path = "src/build.ts";
  const oldText = "export function build(\n  a: string,\n  b: number\n): Result {\n  return x;\n}\n";
  const newText = "export function build(\n  a: string,\n  b: string\n): Result {\n  return x;\n}\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "build"), "param-type change on a continuation line is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: default-exported function/class APIs are
// tracked under the `default` import contract (not the internal local name, so
// renaming only the local name of a default export is not a breaking change).
test("review-surfaces.SEMANTIC_DIFF.2 detects default-exported signature changes", () => {
  const path = "src/handler.ts";
  const oldText = "export default function handler(req: Req): void {}\n";
  const newText = "export default function handler(req: Req, res: Res): void {}\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "default"), "default export signature change captured");
});

// review-surfaces.SEMANTIC_DIFF.2: a semicolon-less type alias does not swallow
// the exports that follow it.
test("review-surfaces.SEMANTIC_DIFF.2 a semicolonless type alias does not swallow later exports", () => {
  const path = "src/nosemi.ts";
  // No semicolons (e.g. a project with ASI/no-semi style).
  const oldText = "export type Result = A | B\nexport const after = 1\n";
  const newText = "export type Result = A | B\nexport const after = 2\nexport const added = 3\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change, "an API change is reported");
  // `added` must be seen as a new export, not swallowed into the type alias.
  assert.deepEqual(change.exports_added, ["added"]);
  // The type alias itself did not change, so it must NOT be a fabricated signature change.
  assert.ok(!change.signatures_changed.some((s) => s.name === "Result"), "the unchanged alias is not a fabricated change");
});

// review-surfaces.SEMANTIC_DIFF.1: a renamed-and-edited schema is diffed against
// its old path, not silently skipped.
test("review-surfaces.SEMANTIC_DIFF.1 diffs a renamed schema against its old path", () => {
  const oldPath = "schemas/old.schema.json";
  const newPath = "schemas/new.schema.json";
  const diffText = [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 90%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    "@@ -1,1 +1,1 @@",
    "-x",
    "+y",
    ""
  ].join("\n");
  const change = computeSemanticChangeFacts({
    diff: parseStructuredDiff(diffText),
    readBase: (p) => (p === oldPath ? JSON.stringify({ required: ["a"], properties: { a: {} } }) : undefined),
    readHead: (p) => (p === newPath ? JSON.stringify({ required: ["a", "b"], properties: { a: {}, b: {} } }) : undefined)
  }).schema_changes[0];
  assert.ok(change, "a renamed schema is diffed");
  assert.deepEqual(change.required_added, ["b"]);
});

// review-surfaces.SEMANTIC_DIFF.2: a function whose return type is an inline
// object literal does not get truncated at the type-literal brace.
test("review-surfaces.SEMANTIC_DIFF.2 does not stop a signature at a return-type object brace", () => {
  const path = "src/ret.ts";
  const oldText = "export function f(): { a: string } {\n  return { a: '' };\n}\n";
  const newText = "export function f(): { a: number } {\n  return { a: 0 };\n}\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "f"), "return-type object field change is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: declaration (.d.ts) files are part of the API
// surface.
test("review-surfaces.SEMANTIC_DIFF.2 includes .d.ts declaration files", () => {
  const path = "src/public.d.ts";
  const oldText = "export declare interface Options { a: string; }\n";
  const newText = "export declare interface Options { a: string; b: number; }\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "Options"), "a .d.ts interface change is an API change");
});

// review-surfaces.SEMANTIC_DIFF.2: exported abstract classes are recognized.
test("review-surfaces.SEMANTIC_DIFF.2 recognizes exported abstract classes", () => {
  const path = "src/base.ts";
  const oldText = "export abstract class Base extends Foo {}\n";
  const newText = "export abstract class Base extends Bar {}\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "Base"), "abstract class extends change is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.1: a newly-added allOf branch that introduces a
// required field is surfaced, not invisible because the array grew.
test("review-surfaces.SEMANTIC_DIFF.1 diffs an added schema composition branch", () => {
  const path = "schemas/compose.schema.json";
  const oldSchema = JSON.stringify({ allOf: [{ required: ["a"] }] });
  const newSchema = JSON.stringify({ allOf: [{ required: ["a"] }, { required: ["b"], properties: { b: {} } }] });
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldSchema }, { [path]: newSchema })).schema_changes[0];
  assert.ok(change, "the added branch produces a contract change");
  assert.ok(change.required_added.some((f) => f.includes("allOf[1].b")), "the new branch's required field is reported");
});

// review-surfaces.SEMANTIC_DIFF.2: a changed overload in an overload set is a
// signature change (the AST keeps every signature for the shared name).
test("review-surfaces.SEMANTIC_DIFF.2 tracks overload set changes", () => {
  const path = "src/overload.ts";
  const oldText = "export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: any): any { return a; }\n";
  const newText = "export function f(a: string): string;\nexport function f(a: boolean): boolean;\nexport function f(a: any): any { return a; }\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "f"), "an altered overload is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: an exported const arrow function's parameter
// change is a signature change; its body is not.
test("review-surfaces.SEMANTIC_DIFF.2 captures const arrow-function signatures, not bodies", () => {
  const path = "src/arrow.ts";
  const paramChange = computeSemanticChangeFacts(sources(
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n"),
    { [path]: "export const f = (a: string): void => { run(a); };" },
    { [path]: "export const f = (a: number): void => { run(a); };" }
  )).api_changes[0];
  assert.ok(paramChange && paramChange.signatures_changed.some((s) => s.name === "f"), "arrow param-type change is a signature change");

  const bodyOnly = computeSemanticChangeFacts(sources(
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n"),
    { [path]: "export const f = (a: string): void => { run(a); };" },
    { [path]: "export const f = (a: string): void => { walk(a); };" }
  )).api_changes;
  assert.equal(bodyOnly.length, 0, "an arrow body-only change is not an API signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: adding/removing an `export *` re-export is a
// surface change keyed by the source module.
test("review-surfaces.SEMANTIC_DIFF.2 detects added star re-exports", () => {
  const path = "src/barrel.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export * from \"./a\";" }, { [path]: "export * from \"./a\";\nexport * from \"./b\";" })).api_changes[0];
  assert.ok(change, "a new star re-export is reported");
  assert.ok(change.exports_added.some((e) => e.includes("./b")), "the added star re-export is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: an exported namespace's presence is tracked.
test("review-surfaces.SEMANTIC_DIFF.2 tracks added/removed exported namespaces", () => {
  const path = "src/ns.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export const x = 1;" }, { [path]: "export const x = 1;\nexport namespace N { export const y = 2; }" })).api_changes[0];
  assert.ok(change && change.exports_added.some((e) => e.includes("N")), "an added exported namespace is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: a re-export whose source module changes is a
// fact (and does not collide with a local export of the same name).
test("review-surfaces.SEMANTIC_DIFF.2 detects a changed re-export source module", () => {
  const path = "src/barrel.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export { thing } from \"./a\";" }, { [path]: "export { thing } from \"./b\";" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "thing"), "the re-export origin change is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: destructuring exports record each bound name.
test("review-surfaces.SEMANTIC_DIFF.2 records destructuring exports", () => {
  const path = "src/destructure.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export const { a } = src;" }, { [path]: "export const { a, b } = src;" })).api_changes[0];
  assert.ok(change && change.exports_added.includes("b"), "a newly destructured export name is surfaced");
});

// A test file is not treated as an API surface.
test("review-surfaces.SEMANTIC_DIFF.2 ignores test files for API surface", () => {
  const path = "tests/x.test.ts";
  const facts = computeSemanticChangeFacts(
    sources([`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n"), { [path]: "export const a = 1;" }, { [path]: "export const a = 2;\nexport const b = 3;" })
  );
  assert.equal(facts.api_changes.length, 0);
});
