import test from "node:test";
import assert from "node:assert/strict";
import { buildAppleProjectModel } from "../src/collector/apple-project/build";
import { buildSwiftSymbolGraph } from "../src/collector/swift-symbol-graph";

// ---------------------------------------------------------------------------
// review-surfaces.BLAST_RADIUS.4 — Apple project model + target-aware Swift symbol
// graph. The model parsers (XcodeGen/SwiftPM/pbxproj/scheme/test-plan) supply
// target membership; the graph connects a referencing file to the file declaring
// the unique type it uses, scoped to the relevant target/module.
// ---------------------------------------------------------------------------

function modelOf(files: Record<string, string>) {
  return buildAppleProjectModel({ files: Object.keys(files), read: (p) => files[p] });
}
function graphOf(files: Record<string, string>, model = modelOf(files)) {
  return buildSwiftSymbolGraph({ files: Object.keys(files).filter((f) => f.endsWith(".swift")), read: (p) => files[p], model });
}

test("review-surfaces.BLAST_RADIUS.4 XcodeGen project.yml resolves app + unit-test targets", () => {
  const model = modelOf({
    "project.yml": `name: App
targets:
  App: { type: application, sources: [Sources/App] }
  AppTests:
    type: bundle.unit-test
    sources: [Tests/AppTests]
    dependencies: [{target: App}]
`
  });
  assert.deepEqual(
    model.targets.map((t) => `${t.name}:${t.kind}`),
    ["App:application", "AppTests:unit_test"]
  );
  const tests = model.targets.find((t) => t.name === "AppTests");
  assert.deepEqual(tests?.source_paths, ["Tests/AppTests"]);
  assert.deepEqual(tests?.dependency_target_ids, ["App"]);
  assert.deepEqual(tests?.provenance, ["xcodegen"]);
});

test("review-surfaces.BLAST_RADIUS.4 a minimal pbxproj resolves native targets and Swift source membership", () => {
  const pbx = `// !$*UTF8*$!
{ archiveVersion = 1; objects = {
  APP = { isa = PBXNativeTarget; name = App; productType = "com.apple.product-type.application"; buildPhases = (APPSRC); };
  APPSRC = { isa = PBXSourcesBuildPhase; files = (BF_A); };
  BF_A = { isa = PBXBuildFile; fileRef = FR_A; };
  FR_A = { isa = PBXFileReference; path = "Model.swift"; sourceTree = "<group>"; };
  UT = { isa = PBXNativeTarget; name = AppTests; productType = "com.apple.product-type.bundle.unit-test"; buildPhases = (UTSRC); };
  UTSRC = { isa = PBXSourcesBuildPhase; files = (BF_U); };
  BF_U = { isa = PBXBuildFile; fileRef = FR_U; };
  FR_U = { isa = PBXFileReference; path = "ModelTests.swift"; sourceTree = "<group>"; };
  UI = { isa = PBXNativeTarget; name = AppUITests; productType = "com.apple.product-type.bundle.ui-testing"; buildPhases = (UISRC); };
  UISRC = { isa = PBXSourcesBuildPhase; files = (BF_UI); };
  BF_UI = { isa = PBXBuildFile; fileRef = FR_UI; };
  FR_UI = { isa = PBXFileReference; path = "Flow.swift"; sourceTree = "<group>"; };
  GAPP = { isa = PBXGroup; children = (FR_A); path = "Sources"; sourceTree = "<group>"; };
  GUT = { isa = PBXGroup; children = (FR_U); path = "Tests"; sourceTree = "<group>"; };
  GUI = { isa = PBXGroup; children = (FR_UI); path = "UITests"; sourceTree = "<group>"; };
}; }`;
  const model = buildAppleProjectModel({ files: ["App.xcodeproj/project.pbxproj"], read: () => pbx });
  assert.deepEqual(
    model.targets.map((t) => `${t.name}:${t.kind}`).sort(),
    ["App:application", "AppTests:unit_test", "AppUITests:ui_test"].sort()
  );
  assert.deepEqual(model.targets.find((t) => t.name === "App")?.source_paths, ["Sources/Model.swift"]);
});

test("review-surfaces.BLAST_RADIUS.4 a minimal SwiftPM package resolves targets and conventional roots", () => {
  const model = modelOf({
    "Package.swift": `// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "Lib", targets: [
  .target(name: "Lib"),
  .testTarget(name: "LibTests", dependencies: ["Lib"])
])
`
  });
  assert.deepEqual(model.targets.map((t) => `${t.name}:${t.kind}:${t.source_paths[0]}`).sort(), [
    "Lib:library:Sources/Lib",
    "LibTests:unit_test:Tests/LibTests"
  ]);
});

test("review-surfaces.BLAST_RADIUS.4 scheme + test-plan references are read", () => {
  const model = modelOf({
    "project.yml": "name: App\ntargets:\n  App: { type: application, sources: [App] }\n",
    "App.xcodeproj/xcshareddata/xcschemes/App.xcscheme": `<?xml version="1.0"?>
<Scheme>
  <TestAction>
    <TestPlans>
      <TestPlanReference reference="container:Plans/Unit.xctestplan" default="YES"/>
    </TestPlans>
    <Testables>
      <TestableReference>
        <BuildableReference BlueprintName="AppTests" BuildableName="AppTests.xctest"/>
      </TestableReference>
    </Testables>
  </TestAction>
</Scheme>`,
    "Plans/Unit.xctestplan": JSON.stringify({
      testTargets: [
        { target: { name: "AppTests" }, enabled: true, skippedTests: ["AppTests/testSlow"] },
        { target: { name: "FlakyTests" }, enabled: false }
      ]
    })
  });
  const scheme = model.schemes.find((s) => s.name === "App");
  assert.deepEqual(scheme?.test_target_ids, ["AppTests"]);
  assert.deepEqual(scheme?.test_plan_paths, ["Plans/Unit.xctestplan"]);
  const plan = model.test_plans[0];
  assert.deepEqual(plan.test_target_ids, ["AppTests"], "a disabled test target is not selected");
  assert.deepEqual(plan.skipped_tests, ["AppTests/testSlow"]);
});

test("review-surfaces.BLAST_RADIUS.4 a unique type reference produces exactly one edge; extension Foo resolves", () => {
  const files = {
    "project.yml": "name: A\ntargets:\n  A: { type: framework, sources: [A] }\n",
    "A/Foo.swift": "public struct Foo {}",
    "A/UsesFoo.swift": "struct UsesFoo { let f = Foo() }",
    "A/ExtendsFoo.swift": "extension Foo { func extra() {} }"
  };
  const g = graphOf(files);
  assert.deepEqual(g.edgesByFile.get("A/UsesFoo.swift"), ["A/Foo.swift"]);
  assert.deepEqual(g.edgesByFile.get("A/ExtendsFoo.swift"), ["A/Foo.swift"], "extension Foo resolves to the unique Foo");
  assert.deepEqual(g.importersByFile.get("A/Foo.swift"), ["A/ExtendsFoo.swift", "A/UsesFoo.swift"]);
});

test("review-surfaces.BLAST_RADIUS.4 an ambiguous duplicate type name produces no edge", () => {
  const files = {
    "project.yml": "name: A\ntargets:\n  A: { type: framework, sources: [A] }\n",
    "A/Foo1.swift": "struct Foo {}",
    "A/Foo2.swift": "struct Foo {}",
    "A/UsesFoo.swift": "struct UsesFoo { let f = Foo() }"
  };
  const g = graphOf(files);
  assert.equal(g.edgesByFile.get("A/UsesFoo.swift"), undefined, "an ambiguous name emits no edge");
});

test("review-surfaces.BLAST_RADIUS.4 the same symbol name in separate targets does not cross-link", () => {
  const files = {
    "project.yml": "name: M\ntargets:\n  A: { type: framework, sources: [A] }\n  B: { type: framework, sources: [B] }\n",
    "A/Shared.swift": "public struct Shared {}",
    "A/UseA.swift": "struct UseA { let s = Shared() }",
    "B/Shared.swift": "public struct Shared {}",
    "B/UseB.swift": "struct UseB { let s = Shared() }"
  };
  const g = graphOf(files);
  assert.deepEqual(g.edgesByFile.get("A/UseA.swift"), ["A/Shared.swift"]);
  assert.deepEqual(g.edgesByFile.get("B/UseB.swift"), ["B/Shared.swift"]);
  // No cross-target edge despite the identical type name.
  assert.ok(!(g.edgesByFile.get("A/UseA.swift") ?? []).includes("B/Shared.swift"));
});

test("review-surfaces.BLAST_RADIUS.4 a test target referencing an imported module connects to the impl", () => {
  const files = {
    "project.yml": `name: App
targets:
  App: { type: application, sources: [Sources/App] }
  AppTests:
    type: bundle.unit-test
    sources: [Tests/AppTests]
    dependencies: [{target: App}]
`,
    "Sources/App/Greeter.swift": "public struct Greeter {}",
    "Tests/AppTests/GreeterTests.swift": "import XCTest\n@testable import App\nfinal class GreeterTests: XCTestCase { func t() { _ = Greeter() } }"
  };
  const g = graphOf(files);
  assert.deepEqual(g.edgesByFile.get("Tests/AppTests/GreeterTests.swift"), ["Sources/App/Greeter.swift"]);
});

test("review-surfaces.BLAST_RADIUS.4 a truncated graph flags truncation rather than a false zero", () => {
  const files = {
    "A/Foo.swift": "public struct Foo {}",
    "A/Bar.swift": "struct Bar { let f = Foo() }"
  };
  const g = buildSwiftSymbolGraph({ files: Object.keys(files), read: (p) => (files as Record<string, string>)[p], fileCap: 1 });
  assert.equal(g.truncated, true, "exceeding the file cap flags truncation");
});

test("review-surfaces.BLAST_RADIUS.4 XcodeGen-vs-generated drift is advisory, never a hard fact", () => {
  const model = modelOf({
    "project.yml": "name: App\ntargets:\n  App: { type: application, sources: [App] }\n  Extra: { type: framework, sources: [Extra] }\n",
    "App.xcodeproj/project.pbxproj": `{ objects = {
      T = { isa = PBXNativeTarget; name = App; productType = "com.apple.product-type.application"; buildPhases = (); };
    }; }`
  });
  const drift = model.diagnostics.filter((d) => d.kind === "possible_drift");
  assert.ok(drift.some((d) => /Extra/.test(d.detail) && /drift check/.test(d.detail)), "a target only in project.yml is advisory drift");
});

// --- Phase 3 Codex round 1: parser/graph correctness regressions -------------

test("review-surfaces.BLAST_RADIUS.4 build accepts project.yaml and filters inputs before the cap", () => {
  const files: Record<string, string> = {
    "project.yaml": "name: App\ntargets:\n  App: { type: application, sources: [Sources/App] }\n"
  };
  for (let i = 0; i < 10; i += 1) {
    files[`AAA/Source${i}.swift`] = "struct X {}\n"; // sort BEFORE project.yaml
  }
  const model = buildAppleProjectModel({ files: Object.keys(files), read: (p) => files[p], fileCap: 3 });
  assert.ok(model.targets.some((t) => t.name === "App"), "project.yaml is parsed even with many source files before the cap");
});

test("review-surfaces.BLAST_RADIUS.4 pbxproj: SOURCE_ROOT refs are not group-prefixed; absolute refs are rejected", () => {
  const pbx = `// !$*UTF8*$!
{ objects = {
  APP = { isa = PBXNativeTarget; name = App; productType = "com.apple.product-type.application"; buildPhases = (P); };
  P = { isa = PBXSourcesBuildPhase; files = (B1, B2); };
  B1 = { isa = PBXBuildFile; fileRef = FR1; };
  B2 = { isa = PBXBuildFile; fileRef = FR2; };
  FR1 = { isa = PBXFileReference; path = "Sources/Root.swift"; sourceTree = "SOURCE_ROOT"; };
  FR2 = { isa = PBXFileReference; path = "/Users/me/Abs.swift"; sourceTree = "<absolute>"; };
  G = { isa = PBXGroup; children = (FR1, FR2); path = "GroupDir"; sourceTree = "<group>"; };
}; }`;
  const model = buildAppleProjectModel({ files: ["App.xcodeproj/project.pbxproj"], read: () => pbx });
  const app = model.targets.find((t) => t.name === "App");
  assert.deepEqual(app?.source_paths, ["Sources/Root.swift"], "SOURCE_ROOT path is project-relative; absolute path dropped");
});

test("review-surfaces.BLAST_RADIUS.4 pbxproj: synchronized folder groups become source roots; proxy deps resolve", () => {
  const pbx = `// !$*UTF8*$!
{ objects = {
  APP = { isa = PBXNativeTarget; name = App; productType = "com.apple.product-type.application"; buildPhases = (); fileSystemSynchronizedGroups = (SYNC); dependencies = (DEP); };
  SYNC = { isa = PBXFileSystemSynchronizedRootGroup; path = "App"; sourceTree = "<group>"; };
  DEP = { isa = PBXTargetDependency; targetProxy = PROXY; };
  PROXY = { isa = PBXContainerItemProxy; remoteGlobalIDString = CORE; remoteInfo = Core; };
  CORE = { isa = PBXNativeTarget; name = Core; productType = "com.apple.product-type.framework"; buildPhases = (); };
}; }`;
  const model = buildAppleProjectModel({ files: ["App.xcodeproj/project.pbxproj"], read: () => pbx });
  const app = model.targets.find((t) => t.name === "App");
  assert.deepEqual(app?.source_paths, ["App"], "synchronized root folder is a source root");
  assert.deepEqual(app?.dependency_target_ids, ["Core"], "PBXTargetDependency proxy resolves to the target name");
});

test("review-surfaces.CONFIG_FACTS.5 a skipped scheme testable is not counted as a selected test target", () => {
  const scheme = `<?xml version="1.0"?>
<Scheme><TestAction><Testables>
  <TestableReference skipped="NO"><BuildableReference BlueprintName="AppTests"/></TestableReference>
  <TestableReference skipped="YES"><BuildableReference BlueprintName="FlakyTests"/></TestableReference>
</Testables></TestAction></Scheme>`;
  const model = modelOf({ "App.xcodeproj/xcshareddata/xcschemes/App.xcscheme": scheme });
  const s = model.schemes[0];
  assert.deepEqual(s?.test_target_ids, ["AppTests"], "the skipped=YES testable (FlakyTests) is excluded");
});

test("review-surfaces.BLAST_RADIUS.4 SwiftPM nested .target dependency is not a target declaration", () => {
  const model = modelOf({
    "Package.swift": `// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "P", targets: [
  .target(name: "App", dependencies: [.target(name: "Core")]),
  .target(name: "Core", path: "Custom/Core")
])`
  });
  assert.deepEqual(model.targets.map((t) => t.name).sort(), ["App", "Core"], "no spurious extra Core target from the nested dependency call");
  const core = model.targets.find((t) => t.name === "Core");
  assert.deepEqual(core?.source_paths, ["Custom/Core"], "Core keeps its explicit path (no merged default Sources/Core)");
  const app = model.targets.find((t) => t.name === "App");
  assert.ok(app?.dependency_target_ids.includes("Core"), "App depends on Core");
});

test("review-surfaces.BLAST_RADIUS.4 an import clause does not create a false reference edge", () => {
  const g = graphOf({
    "project.yml": "name: App\ntargets:\n  App: { type: application, sources: [Sources] }\n  AppTests: { type: bundle.unit-test, sources: [Tests], dependencies: [{target: App}] }\n",
    "Sources/App.swift": "import SwiftUI\n@main struct App {}\n",
    "Tests/SmokeTests.swift": "@testable import App\nimport XCTest\nfinal class SmokeTests: XCTestCase { func testNothing() {} }\n"
  });
  // The test only IMPORTS App; it never references the `App` type, so no edge.
  assert.equal(g.edgesByFile.has("Tests/SmokeTests.swift"), false, "an import clause is not a type reference");
});

test("review-surfaces.BLAST_RADIUS.4 a file-cap-exceeded graph emits no edges (uniqueness is unsound on a slice)", () => {
  const files = {
    "A.swift": "struct Widget {}\n",
    "B.swift": "func use() { _ = Widget() }\n"
  };
  const g = buildSwiftSymbolGraph({ files: Object.keys(files), read: (p) => (files as Record<string, string>)[p], fileCap: 1 });
  assert.equal(g.truncated, true);
  assert.equal(g.edgesByFile.size, 0, "no edges from a truncated (capped) graph");
});

test("review-surfaces.BLAST_RADIUS.4 importersByFileType keys importers by the referenced type", () => {
  const g = graphOf({
    "Models.swift": "struct Foo {}\nstruct Bar {}\n",
    "UsesFoo.swift": "func a() { _ = Foo() }\n",
    "UsesBar.swift": "func b() { _ = Bar() }\n"
  });
  const byType = g.importersByFileType.get("Models.swift");
  assert.deepEqual(byType?.get("Foo"), ["UsesFoo.swift"], "Foo's importers exclude Bar's");
  assert.deepEqual(byType?.get("Bar"), ["UsesBar.swift"]);
});

// --- Phase 3 Codex round 2: graph/parser refinements -------------------------

test("review-surfaces.BLAST_RADIUS.4 a dependency target is visible only when actually imported", () => {
  const files = {
    "project.yml": "name: P\ntargets:\n  App: { type: application, sources: [Sources], dependencies: [{target: Core}] }\n  Core: { type: framework, sources: [Core] }\n",
    "Core/Widget.swift": "public struct Widget {}\n",
    "Sources/User.swift": "func use() { _ = Widget() }\n"
  };
  assert.equal(graphOf(files).edgesByFile.has("Sources/User.swift"), false, "no edge to Core without an explicit import");
  const withImport = { ...files, "Sources/User.swift": "import Core\nfunc use() { _ = Widget() }\n" };
  assert.deepEqual(graphOf(withImport).edgesByFile.get("Sources/User.swift"), ["Core/Widget.swift"], "an explicit import Core connects the edge");
});

test("review-surfaces.BLAST_RADIUS.4 a partial project model suppresses edges", () => {
  const files = { "A.swift": "struct W {}\n", "B.swift": "func u() { _ = W() }\n" };
  const model = modelOf({});
  model.truncated = true;
  const g = buildSwiftSymbolGraph({ files: Object.keys(files), read: (p) => (files as Record<string, string>)[p], model });
  assert.equal(g.truncated, true);
  assert.equal(g.edgesByFile.size, 0, "a truncated/partial model emits no edges");
});

test("review-surfaces.BLAST_RADIUS.4 a file-private type is not a cross-file declarer", () => {
  const g = graphOf({
    "A.swift": "private struct Secret {}\n",
    "B.swift": "func u() { _ = Secret() }\n"
  });
  assert.equal(g.edgesByFile.has("B.swift"), false, "a private/fileprivate type cannot be referenced cross-file");
});

test("review-surfaces.BLAST_RADIUS.4 XcodeGen normalizes ../ source roots", () => {
  const model = modelOf({ "ios/project.yml": "name: P\ntargets:\n  App: { type: application, sources: [../Shared] }\n" });
  assert.deepEqual(model.targets.find((t) => t.name === "App")?.source_paths, ["Shared"], "ios/../Shared normalizes to Shared");
});

test("review-surfaces.BLAST_RADIUS.4 pbxproj normalizes ../ file paths", () => {
  const pbx = `// !$*UTF8*$!
{ objects = {
  APP = { isa = PBXNativeTarget; name = App; productType = "com.apple.product-type.application"; buildPhases = (P); };
  P = { isa = PBXSourcesBuildPhase; files = (B); };
  B = { isa = PBXBuildFile; fileRef = FR; };
  FR = { isa = PBXFileReference; path = "../Shared/Foo.swift"; sourceTree = "<group>"; };
}; }`;
  const model = buildAppleProjectModel({ files: ["ios/App.xcodeproj/project.pbxproj"], read: () => pbx });
  const paths = model.targets.find((t) => t.name === "App")?.source_paths ?? [];
  assert.ok(paths.includes("Shared/Foo.swift"), `expected normalized Shared/Foo.swift, got ${JSON.stringify(paths)}`);
  assert.ok(!paths.some((p) => p.includes("..")), "no unresolved .. segments persist");
});

test("review-surfaces.BLAST_RADIUS.4 referrersByType indexes PascalCase references (removed-decl blast radius)", () => {
  const g = graphOf({
    "Models.swift": "struct Removed {}\n",
    "Caller.swift": "func u() { _ = Removed() }\n"
  });
  assert.ok((g.referrersByType.get("Removed") ?? []).includes("Caller.swift"), "a file referencing the removed type name is indexed");
});

// --- Phase 3 Codex round 3: parser/graph bug fixes ---------------------------

test("review-surfaces.BLAST_RADIUS.4 SwiftPM normalizes an explicit ../ source path", () => {
  const model = modelOf({
    "ios/Package.swift": `// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "P", targets: [ .target(name: "Core", path: "../Shared/Core") ])`
  });
  assert.deepEqual(model.targets.find((t) => t.name === "Core")?.source_paths, ["Shared/Core"], "ios/../Shared/Core normalizes to Shared/Core");
});

test("review-surfaces.BLAST_RADIUS.4 a SwiftPM manifest with no recoverable targets marks the model partial", () => {
  const model = modelOf({
    "Package.swift": `// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "P", targets: makeTargets())`
  });
  assert.equal(model.truncated, true, "a present manifest with no literal targets is partial/unknown");
});

test("review-surfaces.BLAST_RADIUS.4 a modeled file importing a NON-dependency target gets no edge", () => {
  const g = graphOf({
    "project.yml": "name: P\ntargets:\n  App: { type: application, sources: [Sources] }\n  Other: { type: framework, sources: [Other] }\n",
    "Other/Widget.swift": "public struct Widget {}\n",
    "Sources/User.swift": "import Other\nfunc u() { _ = Widget() }\n"
  });
  assert.equal(g.edgesByFile.has("Sources/User.swift"), false, "the model declares no App->Other dependency, so no cross-target edge");
});
