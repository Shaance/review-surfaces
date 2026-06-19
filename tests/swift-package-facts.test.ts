import test from "node:test";
import assert from "node:assert/strict";
import { computeSwiftPackageFacts } from "../src/risks/swift-package-facts";

// ---------------------------------------------------------------------------
// review-surfaces.DEP_FACTS.6 — SwiftPM / Xcode package facts: direct
// requirements (Package.swift, XcodeGen, pbxproj) and resolved pins
// (Package.resolved), without executing manifests or guessing transitive
// attribution. originHash-only / formatting churn is no fact.
// ---------------------------------------------------------------------------

function facts(path: string, base: string | undefined, head: string | undefined) {
  return computeSwiftPackageFacts({ changedFiles: [{ path }], readBase: () => base, readHead: () => head });
}

test("review-surfaces.DEP_FACTS.6 Package.swift add/remove/major/loosen facts", () => {
  const base = `let p = Package(name: "X", dependencies: [
    .package(url: "https://github.com/apple/swift-nio.git", from: "2.0.0"),
    .package(url: "https://github.com/foo/bar.git", exact: "1.2.3"),
    .package(url: "https://github.com/gone/dep.git", from: "1.0.0")
  ])`;
  const head = `let p = Package(name: "X", dependencies: [
    .package(url: "https://github.com/apple/swift-nio.git", from: "3.0.0"),
    .package(url: "https://github.com/foo/bar.git", branch: "main"),
    .package(url: "https://github.com/new/dep.git", from: "1.0.0")
  ])`;
  const result = facts("Package.swift", base, head);
  const byKind = new Map(result.map((f) => [f.kind, f]));
  assert.ok(byKind.get("swift_package_major_change")?.detail.includes("2 → 3"));
  assert.equal(byKind.get("swift_package_requirement_loosened")?.package, "https://github.com/foo/bar");
  assert.equal(byKind.get("swift_package_removed")?.package, "https://github.com/gone/dep");
  assert.equal(byKind.get("swift_package_added")?.package, "https://github.com/new/dep");
  // Provenance: the fact names the manifest path.
  assert.ok(result.every((f) => f.source_path === "Package.swift"));
});

test("review-surfaces.DEP_FACTS.6 an unchanged Package.swift dependency set produces no fact", () => {
  const pkg = `let p = Package(dependencies: [ .package(url: "https://github.com/a/b.git", from: "1.0.0") ])`;
  assert.equal(facts("Package.swift", pkg, pkg).length, 0);
});

test("review-surfaces.DEP_FACTS.6 Package.resolved version/revision change is a pin fact", () => {
  const base = JSON.stringify({ version: 2, pins: [{ identity: "nio", location: "u", state: { version: "2.0.0", revision: "aaaaaaaa" } }] });
  const head = JSON.stringify({ version: 3, pins: [{ identity: "nio", location: "u", state: { version: "2.1.0", revision: "bbbbbbbb" } }] });
  const result = facts("Package.resolved", base, head);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "swift_package_pin_changed");
  assert.ok(/2\.0\.0 → 2\.1\.0/.test(result[0].detail));
});

test("review-surfaces.DEP_FACTS.6 an originHash-only Package.resolved rewrite is silent", () => {
  const base = JSON.stringify({ version: 2, pins: [{ identity: "nio", location: "u", state: { version: "2.0.0", revision: "aaaaaaaa" } }] });
  const head = JSON.stringify({ version: 3, originHash: "DIFFERENT", pins: [{ identity: "nio", location: "u", state: { version: "2.0.0", revision: "aaaaaaaa" } }] });
  assert.equal(facts("Package.resolved", base, head).length, 0, "identical pins with a new originHash are no fact");
});

test("review-surfaces.DEP_FACTS.6 XcodeGen project.yml package requirement change", () => {
  const base = `name: App
packages:
  NIO:
    url: https://github.com/apple/swift-nio.git
    from: 2.0.0
targets: {}
`;
  const head = `name: App
packages:
  NIO:
    url: https://github.com/apple/swift-nio.git
    from: 3.0.0
targets: {}
`;
  const result = facts("project.yml", base, head);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "swift_package_major_change");
  assert.equal(result[0].source_path, "project.yml");
});

test("review-surfaces.DEP_FACTS.6 pbxproj XCRemoteSwiftPackageReference requirement change", () => {
  const pbx = (min: string) => `{ objects = {
    PKG = { isa = XCRemoteSwiftPackageReference; repositoryURL = "https://github.com/apple/swift-nio.git"; requirement = { kind = upToNextMajorVersion; minimumVersion = ${min}; }; };
  }; }`;
  const result = facts("App.xcodeproj/project.pbxproj", pbx("2.0.0"), pbx("3.0.0"));
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "swift_package_major_change");
  assert.equal(result[0].source_path, "App.xcodeproj/project.pbxproj");
});

test("review-surfaces.DEP_FACTS.6 an unsupported Package.resolved (non-JSON) yields no guess", () => {
  assert.equal(facts("Package.resolved", "not json", "still not json").length, 0);
});

// --- Phase 4a Codex round 1: parser refinements ------------------------------

test("review-surfaces.DEP_FACTS.6 from: and .upToNextMajor(from:) are equivalent (no false change)", () => {
  const base = `let p = Package(dependencies: [ .package(url: "https://github.com/a/b.git", from: "1.2.3") ])`;
  const head = `let p = Package(dependencies: [ .package(url: "https://github.com/a/b.git", .upToNextMajor(from: "1.2.3")) ])`;
  assert.equal(facts("Package.swift", base, head).length, 0, "a from <-> upToNextMajor(from:) rewrite is not a requirement change");
});

test("review-surfaces.DEP_FACTS.6 an XcodeGen local-path package addition is a fact", () => {
  const base = "packages:\n";
  const head = "packages:\n  Local:\n    path: ../Local\n";
  assert.ok(facts("project.yml", base, head).some((f) => f.kind === "swift_package_added"), "a local-path package gets an identity and a fact");
});

test("review-surfaces.DEP_FACTS.6 an XcodeGen majorVersion change is a major-version fact", () => {
  const base = "packages:\n  Lib:\n    url: https://github.com/a/lib.git\n    majorVersion: 2.0.0\n";
  const head = "packages:\n  Lib:\n    url: https://github.com/a/lib.git\n    majorVersion: 3.0.0\n";
  assert.ok(facts("project.yml", base, head).some((f) => f.kind === "swift_package_major_change"), "majorVersion 2 -> 3 is a major change");
});

test("review-surfaces.DEP_FACTS.6 project.yaml (not only .yml) XcodeGen packages are scanned", () => {
  const base = "packages:\n  Lib:\n    url: https://github.com/a/lib.git\n    from: 1.0.0\n";
  const head = "packages:\n  Lib:\n    url: https://github.com/a/lib.git\n    from: 2.0.0\n";
  assert.ok(facts("project.yaml", base, head).some((f) => f.kind === "swift_package_major_change"), "project.yaml is scanned the same as project.yml");
});
