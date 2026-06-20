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

test("exact-file area takes precedence over broad mappings for requirement_proof only", () => {
  const matcher = createReviewAreaMatcher([
    { id: "SUB-CORE", name: "Core", groupKey: "CORE", prefixes: ["src/core/"], purpose: "core", pattern: "core", testKeywords: [] },
    { id: "SUB-RELEASE", name: "Release", groupKey: "DISTRIBUTION", prefixes: ["src/core/version.ts", "package.json"], purpose: "release", pattern: "release", testKeywords: [] }
  ]);

  // requirement_proof: the EXACT-file release area wins over the broad src/core area.
  assert.deepEqual(matcher.groupsForPath("src/core/version.ts", { purpose: "requirement_proof" }), ["DISTRIBUTION"]);
  // review_surface (routing): still collects BOTH so the change map keeps full context.
  assert.deepEqual(matcher.groupsForPath("src/core/version.ts", { purpose: "review_surface" }), ["CORE", "DISTRIBUTION"]);
  // a non-exact core file is unaffected.
  assert.deepEqual(matcher.groupsForPath("src/core/files.ts", { purpose: "requirement_proof" }), ["CORE"]);
});

test("review-surfaces.DISTRIBUTION release files map to the SUB-RELEASE area in the real config", async () => {
  const matcher = createReviewAreaMatcher(await defaultReviewSurfacesAreas());
  for (const file of ["CHANGELOG.md", "src/core/version.ts", "package.json", "action.yml"]) {
    assert.deepEqual(
      matcher.groupsForPath(file, { purpose: "requirement_proof" }),
      ["DISTRIBUTION"],
      `${file} should be requirement-proof for DISTRIBUTION only`
    );
  }
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

test("configured review areas preserve compound test keyword matches", async () => {
  const areas = await defaultReviewSurfacesAreas();
  const matcher = createReviewAreaMatcher(areas);

  assert.ok(
    matcher.groupsForPath("tests/pr-surface-e2e.test.ts", { purpose: "review_surface" }).includes("PROVIDERS"),
    "tests/pr-surface-e2e.test.ts should count as PROVIDERS changed-test review signal"
  );
  assert.ok(
    matcher.groupsForPath("tests/pr-surface-e2e.test.ts", { purpose: "requirement_proof" }).includes("PROVIDERS"),
    "tests/pr-surface-e2e.test.ts should count as PROVIDERS validation evidence"
  );
  assert.equal(
    matcher.groupsForPath("tests/surface-pr-e2e.test.ts", { purpose: "review_surface" }).includes("PROVIDERS"),
    false,
    "compound keywords should match token order, not any separated token pair"
  );
});

test("configured review areas preserve plural and derived test-file mappings", async () => {
  const areas = await defaultReviewSurfacesAreas();
  const matcher = createReviewAreaMatcher(areas);

  assert.ok(
    matcher.groupsForPath("tests/risks.test.ts", { purpose: "review_surface" }).includes("RISK"),
    "tests/risks.test.ts should count as RISK changed-test review signal"
  );
  assert.ok(
    matcher.groupsForPath("tests/pr-risks.test.ts", { purpose: "requirement_proof" }).includes("RISK"),
    "tests/pr-risks.test.ts should count as RISK validation evidence"
  );
  assert.ok(
    matcher.groupsForPath("tests/diagrams.test.ts", { purpose: "review_surface" }).includes("ARCH"),
    "tests/diagrams.test.ts should count as ARCH changed-test review signal"
  );
  assert.ok(
    matcher.groupsForPath("tests/rendering-paths-redaction.test.ts", { purpose: "requirement_proof" }).includes("RENDER"),
    "tests/rendering-paths-redaction.test.ts should count as RENDER validation evidence"
  );
});
