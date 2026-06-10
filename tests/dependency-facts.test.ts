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
