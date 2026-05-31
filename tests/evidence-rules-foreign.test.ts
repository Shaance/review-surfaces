import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NON_IMPLEMENTATION_PREFIXES,
  isImplementationEvidencePath
} from "../src/evaluation/evidence-rules";

// Guards the F-SRC R4 refactor that makes isImplementationEvidencePath's
// exclusion prefixes config-derivable (default-arg behavior must stay
// byte-identical to today). Part (a) PINS the current truth table so the
// refactor cannot drift the implementation/non-implementation classification
// (which feeds requirement STATUS). Part (b) proves the new options seam: a
// foreign repo can opt out of the review-surfaces-biased exclusions so its
// docs/*.py is treated as implementation.

test("isImplementationEvidencePath default behavior is byte-identical to today", () => {
  const testPaths = new Set<string>(["tests/api.test.ts"]);

  // Implementation paths -> true.
  assert.equal(isImplementationEvidencePath("src/api.ts", testPaths), true);

  // The review-surfaces-biased non-implementation prefixes/exacts -> false.
  assert.equal(isImplementationEvidencePath("docs/x.md", testPaths), false);
  assert.equal(isImplementationEvidencePath("features/a.feature.yaml", testPaths), false);
  assert.equal(isImplementationEvidencePath(".agents/skills/s.md", testPaths), false);
  assert.equal(isImplementationEvidencePath(".review-surfaces/p.json", testPaths), false);
  assert.equal(isImplementationEvidencePath("AGENTS.md", testPaths), false);
  assert.equal(isImplementationEvidencePath("CLAUDE.md", testPaths), false);
  assert.equal(isImplementationEvidencePath("README.md", testPaths), false);
  assert.equal(isImplementationEvidencePath("README", testPaths), false);

  // A known test path -> false.
  assert.equal(isImplementationEvidencePath("tests/api.test.ts", testPaths), false);

  // Sanity: the exported default prefix list contains the docs/ bias the
  // foreign-repo override below removes.
  assert.ok(
    DEFAULT_NON_IMPLEMENTATION_PREFIXES.includes("docs/"),
    "docs/ must be one of the default non-implementation prefixes"
  );
});

test("isImplementationEvidencePath options seam unbiases a foreign repo's docs/*.py", () => {
  // A foreign (non review-surfaces) repo can pass empty exclusion lists so that
  // paths the default would treat as non-implementation (e.g. a docs/ server
  // module) are classified as implementation.
  assert.equal(
    isImplementationEvidencePath("docs/server.py", new Set<string>(), {
      nonImplementationPrefixes: [],
      nonImplementationExact: [],
      nonImplementationStartsWith: []
    }),
    true,
    "with empty exclusion options a foreign docs/*.py is implementation"
  );
});
