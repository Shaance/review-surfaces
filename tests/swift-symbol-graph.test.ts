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
