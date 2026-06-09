import test from "node:test";
import assert from "node:assert/strict";
import { createReviewAreaMatcher, ReviewArea } from "../src/review-areas/areas";
import { defaultReviewSurfacesAreas } from "./helpers/review-areas";

const AREAS: ReviewArea[] = [
  {
    id: "SUB-CLI",
    name: "CLI",
    groupKey: "CLI",
    prefixes: ["src/cli/"],
    purpose: "CLI command handling.",
    pattern: "dispatcher",
    testKeywords: ["cli"]
  }
];

test("review area matcher makes review_surface and requirement_proof semantics explicit", () => {
  const matcher = createReviewAreaMatcher(AREAS);

  assert.deepEqual(matcher.groupsForPath("docs/examples/src/cli/readme.md", { purpose: "review_surface" }), ["CLI"]);
  assert.deepEqual(matcher.groupsForPath("docs/examples/src/cli/readme.md", { purpose: "requirement_proof" }), []);

  assert.deepEqual(matcher.groupsForPath("tests/clinical.test.ts", { purpose: "review_surface" }), []);
  assert.deepEqual(matcher.groupsForPath("tests/clinical.test.ts", { purpose: "requirement_proof" }), []);

  assert.deepEqual(matcher.groupsForPath("tests/cli.test.ts", { purpose: "requirement_proof" }), ["CLI"]);
});

test("review area matcher token-scopes test keywords case-insensitively", () => {
  const matcher = createReviewAreaMatcher([{ ...AREAS[0], testKeywords: ["CLI"] }]);

  assert.deepEqual(matcher.groupsForPath("tests/clinical.test.ts", { purpose: "review_surface" }), []);
  assert.deepEqual(matcher.groupsForPath("tests/CLI.test.ts", { purpose: "review_surface" }), ["CLI"]);
  assert.deepEqual(matcher.groupsForPath("tests/cli.test.ts", { purpose: "requirement_proof" }), ["CLI"]);
});

test("review area matcher exposes diagnostics without enforcing config validity", () => {
  const matcher = createReviewAreaMatcher(AREAS);
  const diagnostic = matcher.explainPath("tests/cli.test.ts", { purpose: "requirement_proof" });

  assert.equal(diagnostic.path, "tests/cli.test.ts");
  assert.equal(diagnostic.purpose, "requirement_proof");
  assert.deepEqual(diagnostic.groups, ["CLI"]);
  assert.deepEqual(diagnostic.matches, [
    { areaId: "SUB-CLI", groupKey: "CLI", reason: "test_keyword", matched: "cli" }
  ]);
});

test("configured review areas map init scaffolding tests to BOOTSTRAP", async () => {
  const areas = await defaultReviewSurfacesAreas();
  const matcher = createReviewAreaMatcher(areas);

  assert.ok(
    matcher.groupsForPath("tests/init.test.ts", { purpose: "requirement_proof" }).includes("BOOTSTRAP"),
    "tests/init.test.ts should count as BOOTSTRAP validation evidence"
  );
  assert.ok(
    matcher.groupsForPath("tests/init.test.ts", { purpose: "review_surface" }).includes("BOOTSTRAP"),
    "tests/init.test.ts should count as a BOOTSTRAP changed-test review signal"
  );
  assert.equal(
    matcher.groupsForPath("tests/initialization.test.ts", { purpose: "review_surface" }).includes("BOOTSTRAP"),
    false,
    "tests/initialization.test.ts must not match the shorter init keyword"
  );
});

test("configured review areas map review-area matcher tests to EVIDENCE", async () => {
  const areas = await defaultReviewSurfacesAreas();
  const matcher = createReviewAreaMatcher(areas);

  assert.ok(
    matcher.groupsForPath("tests/review-areas.test.ts", { purpose: "review_surface" }).includes("EVIDENCE"),
    "tests/review-areas.test.ts should count as EVIDENCE changed-test review signal"
  );
  assert.ok(
    matcher.groupsForPath("tests/review-areas.test.ts", { purpose: "requirement_proof" }).includes("EVIDENCE"),
    "tests/review-areas.test.ts should count as EVIDENCE validation evidence"
  );
});

test("configured review areas map methodology tests to METHODOLOGY", async () => {
  const areas = await defaultReviewSurfacesAreas();
  const matcher = createReviewAreaMatcher(areas);

  assert.ok(
    matcher.groupsForPath("tests/methodology.test.ts", { purpose: "review_surface" }).includes("METHODOLOGY"),
    "tests/methodology.test.ts should count as METHODOLOGY changed-test review signal"
  );
  assert.ok(
    matcher.groupsForPath("tests/methodology.test.ts", { purpose: "requirement_proof" }).includes("METHODOLOGY"),
    "tests/methodology.test.ts should count as METHODOLOGY validation evidence"
  );
});
