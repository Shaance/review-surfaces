import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDependencyFacts, dependencyFactSeverityRank } from "../src/risks/dependency-facts";

const BASE_PKG = JSON.stringify({
  dependencies: { left: "1.2.3", stable: "^2.0.0" },
  devDependencies: { tool: "3.0.0" }
});

test("review-surfaces.DEP_FACTS.1 package.json diff yields added/removed/moved/major/loosened facts", () => {
  const head = JSON.stringify({
    dependencies: { stable: "^3.0.0", fresh: "^1.0.0", tool: "3.0.0", left: "^1.2.3" }
  });
  const facts = computeDependencyFacts({
    changedFiles: [{ path: "package.json" }],
    readBase: () => BASE_PKG,
    readHead: () => head
  });
  const byKind = (kind: string) => facts.filter((fact) => fact.kind === kind);
  assert.equal(byKind("dependency_added")[0]?.package, "fresh");
  assert.equal(byKind("major_version_bump")[0]?.package, "stable");
  assert.equal(byKind("version_range_loosened")[0]?.package, "left");
  assert.equal(byKind("dependency_group_moved")[0]?.package, "tool");
  // Concrete language names the package and the change.
  assert.match(byKind("dependency_added")[0].detail, /adds `fresh@\^1\.0\.0`/);
});

test("review-surfaces.DEP_FACTS.1 pnpm-lock additions and requiresBuild yield transitive/install-script facts; unsupported lockfiles yield none", () => {
  const baseLock = "lockfileVersion: '9.0'\npackages:\n  /known@1.0.0:\n    resolution: {}\n";
  const headLock = "lockfileVersion: '9.0'\npackages:\n  /known@1.0.0:\n    resolution: {}\n  /sneaky@2.0.0:\n    resolution: {}\n    requiresBuild: true\n";
  const facts = computeDependencyFacts({
    changedFiles: [{ path: "pnpm-lock.yaml" }],
    readBase: () => baseLock,
    readHead: () => headLock
  });
  assert.ok(facts.some((fact) => fact.kind === "transitive_added" && fact.package === "sneaky"));
  assert.ok(facts.some((fact) => fact.kind === "install_scripts" && fact.package === "sneaky"));
  // Unsupported lockfile -> no lockfile facts, never a guess.
  const yarn = computeDependencyFacts({ changedFiles: [{ path: "yarn.lock" }], readBase: () => "x", readHead: () => "y" });
  assert.deepEqual(yarn, []);
});

test("review-surfaces.DEP_FACTS.1 pnpm peer-suffixed and scoped keys parse to the right package name", () => {
  const headLock = "lockfileVersion: '9.0'\npackages:\n  '@scope/pkg@1.0.0(peer@2.0.0)':\n    resolution: {}\n";
  const facts = computeDependencyFacts({
    changedFiles: [{ path: "pnpm-lock.yaml" }],
    readBase: () => "lockfileVersion: '9.0'\npackages: {}\n",
    readHead: () => headLock
  });
  assert.equal(facts.find((fact) => fact.kind === "transitive_added")?.package, "@scope/pkg");
});

test("review-surfaces.DEP_FACTS.2 severity ordering puts install scripts above new deps above major bumps above loosening", () => {
  assert.ok(dependencyFactSeverityRank("install_scripts") < dependencyFactSeverityRank("dependency_added"));
  assert.ok(dependencyFactSeverityRank("dependency_added") < dependencyFactSeverityRank("major_version_bump"));
  assert.ok(dependencyFactSeverityRank("major_version_bump") < dependencyFactSeverityRank("version_range_loosened"));
});

test("review-surfaces.DEP_FACTS.5 a major-version DOWNGRADE (^3 -> ^2) produces a fact, not only an upward bump", () => {
  const base = JSON.stringify({ dependencies: { lib: "^3.0.0", up: "^1.0.0" } });
  const head = JSON.stringify({ dependencies: { lib: "^2.1.0", up: "^2.0.0" } });
  const facts = computeDependencyFacts({
    changedFiles: [{ path: "package.json" }],
    readBase: () => base,
    readHead: () => head
  });
  const downgrade = facts.find((fact) => fact.kind === "major_version_downgrade");
  assert.ok(downgrade, "a ^3 -> ^2 change must produce a major_version_downgrade fact");
  assert.equal(downgrade?.package, "lib");
  assert.match(downgrade!.detail, /downgrades `lib` \^3\.0\.0 -> \^2\.1\.0 \(major\)/);
  // The upward change still fires as a bump (both directions are surfaced).
  assert.ok(facts.some((fact) => fact.kind === "major_version_bump" && fact.package === "up"));
  // The downgrade ranks at the same supply-chain severity as a bump.
  assert.equal(
    dependencyFactSeverityRank("major_version_downgrade"),
    dependencyFactSeverityRank("major_version_bump")
  );
});

test("review-surfaces.PERF.2 transitive attribution is output-identical with edge sets pre-sorted once (per-visit sort removed from the BFS)", () => {
  // A wide lockfile: one direct root (root-pkg) fanning out to MANY transitives
  // whose lockfile dependency edges are recorded in NON-alphabetical key order.
  // The attribution BFS used to `[...edges].sort()` on EVERY visit to keep the
  // traversal deterministic; the LockGraph now pre-sorts each node's edge list
  // ONCE at build time, so that per-visit sort is gone from the hot loop. This
  // fixture proves the optimization preserved behaviour: every transitive is
  // still attributed to the one direct root that pulls it, regardless of the
  // unsorted edge order in the lockfile.
  const headManifest = JSON.stringify({ dependencies: { "root-pkg": "^1.0.0" } });
  const baseLock = JSON.stringify({
    lockfileVersion: 3,
    packages: { "node_modules/root-pkg": { version: "1.0.0" } }
  });
  // Edges deliberately listed out of order (zeta before alpha before mid) so a
  // missing/incorrect ordering would surface as non-deterministic attribution.
  const headLock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "node_modules/root-pkg": {
        version: "1.1.0",
        dependencies: { "zeta-dep": "^1.0.0", "alpha-dep": "^1.0.0", "mid-dep": "^1.0.0" }
      },
      "node_modules/zeta-dep": { version: "1.0.0", dependencies: { "deep-dep": "^1.0.0" } },
      "node_modules/alpha-dep": { version: "1.0.0" },
      "node_modules/mid-dep": { version: "1.0.0" },
      "node_modules/deep-dep": { version: "1.0.0" }
    }
  });
  const compute = () =>
    computeDependencyFacts({
      changedFiles: [{ path: "package-lock.json" }],
      readBase: (filePath) => (filePath === "package-lock.json" ? baseLock : undefined),
      readHead: (filePath) =>
        filePath === "package-lock.json" ? headLock : filePath === "package.json" ? headManifest : undefined
    });

  const facts = compute();
  const attributed = facts
    .filter((fact) => fact.kind === "transitive_added")
    .map((fact) => ({ package: fact.package, via: fact.via }));

  // Expected attribution is UNCHANGED by the pre-sort: every transitive (direct
  // edges AND the deep one reached through zeta-dep) attributes to root-pkg.
  assert.deepEqual(attributed, [
    { package: "alpha-dep", via: "root-pkg" },
    { package: "deep-dep", via: "root-pkg" },
    { package: "mid-dep", via: "root-pkg" },
    { package: "zeta-dep", via: "root-pkg" }
  ]);

  // Determinism preserved: identical inputs -> identical attributed output, so
  // pre-sorting once (not per visit) did not perturb the traversal order.
  assert.deepEqual(compute(), facts);
});

test("review-surfaces.DEP_FACTS.3 facts are deterministic, offline, and carry no registry metadata", () => {
  const head = JSON.stringify({ dependencies: { fresh: "^1.0.0" } });
  const args = { changedFiles: [{ path: "package.json" }], readBase: () => "{}", readHead: () => head };
  const a = computeDependencyFacts(args);
  const b = computeDependencyFacts(args);
  // Identical inputs -> identical facts (pure content function, no network).
  assert.deepEqual(a, b);
  // No registry adornments exist on the deterministic fact shape.
  for (const fact of a) {
    assert.deepEqual(Object.keys(fact).sort(), ["detail", "kind", "package", "source_path"]);
  }
});
