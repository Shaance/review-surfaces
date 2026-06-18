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
  assert.equal(result.length, 0, "a binary head plist must not be read as 'key removed'");
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

test("review-surfaces.CONFIG_FACTS.5 a deliberate XcodeGen-vs-generated mismatch is an advisory drift fact", () => {
  const yml = "name: App\ntargets:\n  App: { type: application, sources: [App] }\n  Extra: { type: framework, sources: [Extra] }\n";
  const pbx = `{ objects = { T = { isa = PBXNativeTarget; name = App; productType = "com.apple.product-type.application"; buildPhases = (); }; }; }`;
  const result = facts(
    { "project.yml": yml, "App.xcodeproj/project.pbxproj": pbx },
    { "project.yml": yml, "App.xcodeproj/project.pbxproj": pbx }
  );
  const drift = result.find((f) => f.kind === "ios_generator_drift");
  assert.ok(drift && /Extra/.test(drift.detail) && /drift check/.test(drift.detail), "an intent-only target is advisory drift");
});
