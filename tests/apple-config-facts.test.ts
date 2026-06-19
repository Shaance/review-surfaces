import test from "node:test";
import assert from "node:assert/strict";
import { computeAppleConfigFacts } from "../src/risks/apple-config-facts";
import { parseStructuredDiff } from "../src/collector/diff-hunks";

// ---------------------------------------------------------------------------
// review-surfaces.CONFIG_FACTS.4/.5 — Apple privacy/capability/build-setting and
// project-structure (target/scheme/test-plan/drift) facts. A binary plist infers
// no absence; uncertain XcodeGen drift is advisory.
// ---------------------------------------------------------------------------

// Build a minimal structured diff that lists the given paths as changed.
function diffOf(paths: string[]) {
  const text = paths
    .flatMap((p) => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, "@@ -1,1 +1,1 @@", "-x", "+y"])
    .concat("")
    .join("\n");
  return parseStructuredDiff(text);
}
function facts(base: Record<string, string>, head: Record<string, string>) {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(head)])];
  return computeAppleConfigFacts({ diff: diffOf(paths), readBase: (p) => base[p], readHead: (p) => head[p] });
}

test("review-surfaces.CONFIG_FACTS.4 a new Info.plist usage description + ATS broadening are flagged", () => {
  const base = { "App/Info.plist": "<plist><dict><key>CFBundleVersion</key><string>1</string></dict></plist>" };
  const head = {
    "App/Info.plist":
      '<plist><dict><key>NSCameraUsageDescription</key><string>cam</string><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict></dict></plist>'
  };
  const result = facts(base, head);
  assert.ok(result.some((f) => f.kind === "ios_privacy_capability_change" && /NSCameraUsageDescription/.test(f.detail)));
  assert.ok(result.some((f) => f.kind === "ios_ats_broadened"));
  // A benign build-number bump did not produce a fact.
  assert.ok(!result.some((f) => /CFBundleVersion/.test(f.detail)));
});

test("review-surfaces.CONFIG_FACTS.4 entitlement addition/removal is flagged", () => {
  const base = { "App/App.entitlements": "<plist><dict><key>application-identifier</key><string>x</string></dict></plist>" };
  const head = { "App/App.entitlements": "<plist><dict><key>com.apple.security.application-groups</key><array/></dict></plist>" };
  const result = facts(base, head);
  assert.ok(result.some((f) => f.kind === "ios_privacy_capability_change" && /application-groups.*added/.test(f.detail)));
  assert.ok(result.some((f) => f.kind === "ios_privacy_capability_change" && /application-identifier.*removed/.test(f.detail)));
});

test("review-surfaces.CONFIG_FACTS.4 a privacy-manifest tracking change is flagged", () => {
  const base = { "App/PrivacyInfo.xcprivacy": "<plist><dict><key>NSPrivacyTracking</key><false/></dict></plist>" };
  const head = { "App/PrivacyInfo.xcprivacy": "<plist><dict><key>NSPrivacyTracking</key><true/></dict></plist>" };
  const result = facts(base, head);
  assert.ok(result.some((f) => f.kind === "ios_privacy_capability_change" && /NSPrivacyTracking/.test(f.detail)));
});

test("review-surfaces.CONFIG_FACTS.4 Swift version and strict-concurrency build-setting changes are flagged", () => {
  const base = { "Config/App.xcconfig": "SWIFT_VERSION = 5.0\n" };
  const head = { "Config/App.xcconfig": "SWIFT_VERSION = 6.0\nSWIFT_STRICT_CONCURRENCY = complete\n" };
  const result = facts(base, head);
  assert.ok(result.some((f) => f.kind === "ios_build_setting_change" && /SWIFT_VERSION 5\.0 → 6\.0/.test(f.detail)));
  assert.ok(result.some((f) => f.kind === "ios_build_setting_change" && /SWIFT_STRICT_CONCURRENCY/.test(f.detail)));
});

test("review-surfaces.CONFIG_FACTS.4 a binary plist infers NO absence (diagnostic-only, no false removal)", () => {
  const base = { "App/Info.plist": "<plist><dict><key>NSCameraUsageDescription</key><string>cam</string></dict></plist>" };
  const head = { "App/Info.plist": "bplist00\u0000\u0000binarygarbage" };
  const result = facts(base, head);
  // A binary head plist must not be read as "key removed"; it carries an explicit
  // UNKNOWN diagnostic instead (goal contract D10).
  assert.ok(!result.some((f) => f.kind === "ios_privacy_capability_change"), "no false 'key removed' fact");
  assert.ok(result.length > 0 && result.every((f) => f.kind === "ios_config_unparsed"), "only an unknown diagnostic is emitted");
});

test("review-surfaces.CONFIG_FACTS.5 a removed test target / disabled test-plan target is a test-structure fact", () => {
  const baseYml = "name: App\ntargets:\n  App: { type: application, sources: [App] }\n  AppTests: { type: bundle.unit-test, sources: [Tests] }\n";
  const headYml = "name: App\ntargets:\n  App: { type: application, sources: [App] }\n";
  const ymlFacts = facts({ "project.yml": baseYml }, { "project.yml": headYml });
  assert.ok(ymlFacts.some((f) => f.kind === "ios_test_structure_change" && /test target `AppTests` removed/.test(f.detail)));

  const basePlan = JSON.stringify({ testTargets: [{ target: { name: "AppTests" }, enabled: true }] });
  const headPlan = JSON.stringify({ testTargets: [{ target: { name: "AppTests" }, enabled: false }] });
  const planFacts = facts({ "Plans/Unit.xctestplan": basePlan }, { "Plans/Unit.xctestplan": headPlan });
  assert.ok(planFacts.some((f) => f.kind === "ios_test_structure_change" && /AppTests.*removed or disabled/.test(f.detail)));
});

test("review-surfaces.CONFIG_FACTS.5 a scheme test target removal is a test-structure fact", () => {
  const scheme = (targets: string[]) =>
    `<?xml version="1.0"?><Scheme><TestAction><Testables>${targets
      .map((t) => `<TestableReference><BuildableReference BlueprintName="${t}"/></TestableReference>`)
      .join("")}</Testables></TestAction></Scheme>`;
  const result = facts(
    { "App.xcodeproj/xcshareddata/xcschemes/App.xcscheme": scheme(["AppTests", "SlowTests"]) },
    { "App.xcodeproj/xcshareddata/xcschemes/App.xcscheme": scheme(["AppTests"]) }
  );
  assert.ok(result.some((f) => f.kind === "ios_test_structure_change" && /SlowTests.*removed from the test action/.test(f.detail)));
});

test("review-surfaces.CONFIG_FACTS.5 XcodeGen and generated project agreeing yields NO drift fact", () => {
  const yml = "name: App\ntargets:\n  App: { type: application, sources: [App] }\n";
  const pbx = `{ objects = { T = { isa = PBXNativeTarget; name = App; productType = "com.apple.product-type.application"; buildPhases = (); }; }; }`;
  const result = facts(
    { "project.yml": yml, "App.xcodeproj/project.pbxproj": pbx },
    { "project.yml": yml, "App.xcodeproj/project.pbxproj": pbx }
  );
  assert.ok(!result.some((f) => f.kind === "ios_generator_drift"), "matching intent + observed -> no drift");
});

test("review-surfaces.CONFIG_FACTS.5 a NEWLY-introduced XcodeGen-vs-generated mismatch is an advisory drift fact", () => {
  // base agrees (App only); head adds Extra to project.yml without regenerating the
  // .xcodeproj, so the drift is introduced by THIS change (pre-existing drift is suppressed).
  const baseYml = "name: App\ntargets:\n  App: { type: application, sources: [App] }\n";
  const headYml = "name: App\ntargets:\n  App: { type: application, sources: [App] }\n  Extra: { type: framework, sources: [Extra] }\n";
  const pbx = `{ objects = { T = { isa = PBXNativeTarget; name = App; productType = "com.apple.product-type.application"; buildPhases = (); }; }; }`;
  const result = facts(
    { "project.yml": baseYml, "App.xcodeproj/project.pbxproj": pbx },
    { "project.yml": headYml, "App.xcodeproj/project.pbxproj": pbx }
  );
  const drift = result.find((f) => f.kind === "ios_generator_drift");
  assert.ok(drift && /Extra/.test(drift.detail) && /drift check/.test(drift.detail), "a newly intent-only target is advisory drift");
});

// --- Phase 4b Codex round 1: parser/coverage fixes ---------------------------

test("review-surfaces.CONFIG_FACTS.4 a binary plist emits an UNKNOWN diagnostic, never inferred absence", () => {
  const base = { "App/Info.plist": "<plist><dict><key>NSCameraUsageDescription</key><string>x</string></dict></plist>" };
  const head = { "App/Info.plist": "bplist00 garbage" };
  const result = facts(base, head);
  assert.ok(result.some((f) => f.kind === "ios_config_unparsed"), "binary plist -> ios_config_unparsed");
  assert.ok(!result.some((f) => f.kind === "ios_privacy_capability_change"), "no false key-removed fact");
});

test("review-surfaces.CONFIG_FACTS.4 a value change under an existing entitlement key is flagged", () => {
  const base = { "App/App.entitlements": "<plist><dict><key>com.apple.security.application-groups</key><array><string>group.a</string></array></dict></plist>" };
  const head = { "App/App.entitlements": "<plist><dict><key>com.apple.security.application-groups</key><array><string>group.a</string><string>group.b</string></array></dict></plist>" };
  assert.ok(facts(base, head).some((f) => f.kind === "ios_privacy_capability_change" && /value changed/.test(f.detail)), "an added app group is a capability change");
});

test("review-surfaces.CONFIG_FACTS.4 a conditional + secret-bearing xcconfig setting is flagged and redacted", () => {
  const base = { "Config/App.xcconfig": "SWIFT_VERSION = 5.9\n" };
  const head = { "Config/App.xcconfig": "SWIFT_VERSION[sdk=iphoneos*] = 6.0\nOTHER_SWIFT_FLAGS = -DAPI_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv\n" };
  const result = facts(base, head);
  assert.ok(result.some((f) => f.kind === "ios_build_setting_change" && /SWIFT_VERSION/.test(f.detail)), "conditional SWIFT_VERSION change detected");
  const flags = result.find((f) => /OTHER_SWIFT_FLAGS/.test(f.detail));
  assert.ok(flags && !/AIzaSyA1234567890/.test(flags.detail), "the credential token is redacted in the fact detail");
});

test("review-surfaces.CONFIG_FACTS.4 build settings change in project.yml (not only xcconfig) is flagged", () => {
  const base = { "project.yml": "name: App\nsettings:\n  SWIFT_VERSION: 5.9\ntargets:\n  App: { type: application, sources: [Sources] }\n" };
  const head = { "project.yml": "name: App\nsettings:\n  SWIFT_VERSION: 6.0\ntargets:\n  App: { type: application, sources: [Sources] }\n" };
  assert.ok(facts(base, head).some((f) => f.kind === "ios_build_setting_change" && /SWIFT_VERSION/.test(f.detail)), "XcodeGen build-setting change detected");
});

test("review-surfaces.CONFIG_FACTS.5 a project.yaml test-target removal is flagged (not only project.yml)", () => {
  const base = { "project.yaml": "name: App\ntargets:\n  App: { type: application, sources: [Sources] }\n  AppTests: { type: bundle.unit-test, sources: [Tests] }\n" };
  const head = { "project.yaml": "name: App\ntargets:\n  App: { type: application, sources: [Sources] }\n" };
  assert.ok(facts(base, head).some((f) => f.kind === "ios_test_structure_change"), "project.yaml is scanned for structure facts");
});

test("review-surfaces.CONFIG_FACTS.5 a dropped target dependency is a structure change", () => {
  const base = { "project.yml": "name: App\ntargets:\n  App: { type: application, sources: [Sources], dependencies: [{target: Core}] }\n  Core: { type: framework, sources: [Core] }\n" };
  const head = { "project.yml": "name: App\ntargets:\n  App: { type: application, sources: [Sources] }\n  Core: { type: framework, sources: [Core] }\n" };
  assert.ok(facts(base, head).some((f) => f.kind === "ios_target_structure_change" && /dependencies changed/.test(f.detail)), "a dropped dependency is flagged");
});

test("review-surfaces.CONFIG_FACTS.5 a focused xctestplan selectedTests narrowing is flagged", () => {
  const base = { "Plans/Unit.xctestplan": JSON.stringify({ testTargets: [{ target: { name: "AppTests" } }] }) };
  const head = { "Plans/Unit.xctestplan": JSON.stringify({ testTargets: [{ target: { name: "AppTests" }, selectedTests: ["AppTests/FooTests/testA"] }] }) };
  assert.ok(facts(base, head).some((f) => f.kind === "ios_test_structure_change" && /focused selection/.test(f.detail)), "a selectedTests narrowing is flagged");
});

test("review-surfaces.CONFIG_FACTS.5 a generated Apple bundle plist produces no config fact", () => {
  const base = { "Build/App.xcarchive/Info.plist": "<plist><dict></dict></plist>" };
  const head = { "Build/App.xcarchive/Info.plist": "<plist><dict><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict></dict></plist>" };
  assert.equal(facts(base, head).length, 0, "a generated .xcarchive plist is not a review-focus config change");
});

test("review-surfaces.CONFIG_FACTS.5 an unparseable project.yml side yields an unknown diagnostic, not all-removed", () => {
  const base = { "project.yml": "name: App\ntargets:\n  App: { type: application, sources: [Sources] }\n  AppTests: { type: bundle.unit-test, sources: [Tests] }\n" };
  const head = { "project.yml": "{ this is not valid xcodegen yaml :::" };
  const result = facts(base, head);
  assert.ok(result.some((f) => f.kind === "ios_config_unparsed"), "an unparseable side -> unknown diagnostic");
  assert.ok(!result.some((f) => f.kind === "ios_test_structure_change"), "no false test-target-removed facts from parser uncertainty");
});

// --- Phase 4b Codex round 2: refinements ------------------------------------

test("review-surfaces.CONFIG_FACTS.5 a test target dropping a dependency is a TEST structure change", () => {
  const base = { "project.yml": "name: App\ntargets:\n  App: { type: application, sources: [Sources] }\n  AppTests: { type: bundle.unit-test, sources: [Tests], dependencies: [{target: App}] }\n" };
  const head = { "project.yml": "name: App\ntargets:\n  App: { type: application, sources: [Sources] }\n  AppTests: { type: bundle.unit-test, sources: [Tests] }\n" };
  assert.ok(facts(base, head).some((f) => f.kind === "ios_test_structure_change" && /dependencies changed/.test(f.detail)), "a test target's dropped dependency is test-evidence relevant");
});

test("review-surfaces.CONFIG_FACTS.5 a malformed test plan yields an unknown diagnostic, not all-removed", () => {
  const base = { "Plans/Unit.xctestplan": JSON.stringify({ testTargets: [{ target: { name: "AppTests" } }] }) };
  const head = { "Plans/Unit.xctestplan": "{ not valid json :::" };
  const result = facts(base, head);
  assert.ok(result.some((f) => f.kind === "ios_config_unparsed"), "a malformed test plan -> unknown diagnostic");
  assert.ok(!result.some((f) => f.kind === "ios_test_structure_change"), "no false target-removed fact from the parse failure");
});

test("review-surfaces.CONFIG_FACTS.5 only NEWLY-introduced generator drift is reported (pre-existing drift suppressed)", () => {
  const pbx = "// !$*UTF8*$!\n{ objects = { F = { isa = PBXNativeTarget; name = Foo; productType = \"com.apple.product-type.application\"; buildPhases = (); }; }; }";
  const base = {
    "project.yml": "name: P\ntargets:\n  Foo: { type: application, sources: [Foo] }\n  Bar: { type: framework, sources: [Bar] }\n",
    "App.xcodeproj/project.pbxproj": pbx
  };
  const head = {
    "project.yml": "name: P\ntargets:\n  Foo: { type: application, sources: [Foo] }\n  Bar: { type: framework, sources: [Bar] }\n  Baz: { type: framework, sources: [Baz] }\n",
    "App.xcodeproj/project.pbxproj": pbx
  };
  const drift = facts(base, head).filter((f) => f.kind === "ios_generator_drift");
  assert.ok(drift.some((f) => /Baz/.test(f.detail)), "the NEW drift (Baz) is reported");
  assert.ok(!drift.some((f) => /Bar/.test(f.detail)), "the pre-existing drift (Bar) is suppressed");
});
