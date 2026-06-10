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

// A test file is not treated as an API surface.
test("review-surfaces.SEMANTIC_DIFF.2 ignores test files for API surface", () => {
  const path = "tests/x.test.ts";
  const facts = computeSemanticChangeFacts(
    sources([`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n"), { [path]: "export const a = 1;" }, { [path]: "export const a = 2;\nexport const b = 3;" })
  );
  assert.equal(facts.api_changes.length, 0);
});
