import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAppleSourceKind,
  isAppleGeneratedPath,
  isAppleLockPath,
  isAppleNonReviewArtifactPath,
  isAppleProjectConfigPath,
  isAppleSigningArtifactPath,
  isSwiftSourcePath,
  isSwiftTestPath
} from "../src/collector/source-kind";
import { classifyRole, isTestPath } from "../src/scope/pr-scope";
import { classifyFile } from "../src/indexer/indexer";

// review-surfaces.COLLECTOR.8: one shared source-kind classifier recognizes Swift
// implementation/test files, Apple project/config files, and Apple generated/cache
// artifacts, and every consumer (PR scope, indexer, cold-start ranking) delegates
// to it instead of carrying a private Swift suffix list.

test("review-surfaces.COLLECTOR.8 Swift test paths are recognized by file name and target directory", () => {
  const tests = [
    "FooTests.swift",
    "FooTest.swift",
    "AppUITests.swift",
    "WidgetUITest.swift",
    "ViewSnapshotTests.swift",
    "Tests/AppTests/FooTests.swift",
    "Tests/AppTests/SharedHelpers.swift", // helper in a Tests/ target dir
    "MyApp/UITests/LoginFlow.swift"
  ];
  for (const path of tests) {
    assert.equal(isSwiftTestPath(path), true, `${path} should be a Swift test`);
  }
  const notTests = ["Sources/Foo.swift", "App/Models/User.swift", "latest.swift", "contest.swift"];
  for (const path of notTests) {
    assert.equal(isSwiftTestPath(path), false, `${path} should NOT be a Swift test`);
  }
});

test("review-surfaces.COLLECTOR.8 Swift implementation excludes tests and generated output", () => {
  assert.equal(isSwiftSourcePath("Sources/App/User.swift"), true);
  assert.equal(isSwiftSourcePath("FooTests.swift"), false);
  assert.equal(isSwiftSourcePath(".build/checkouts/Dep/Sources/Dep.swift"), false);
});

test("review-surfaces.COLLECTOR.8 Apple project/config files are recognized (pbxproj is NOT generated)", () => {
  const configs = [
    "App.xcodeproj/project.pbxproj",
    "Package.swift",
    "Config/App.xcconfig",
    "App/App.entitlements",
    "App.xcodeproj/xcshareddata/xcschemes/App.xcscheme",
    "Plans/Unit.xctestplan",
    "App/PrivacyInfo.xcprivacy",
    "App/Info.plist"
  ];
  for (const path of configs) {
    assert.equal(isAppleProjectConfigPath(path), true, `${path} should be Apple project/config`);
  }
  // project.pbxproj is source-of-truth project text, never globally generated.
  assert.equal(isAppleGeneratedPath("App.xcodeproj/project.pbxproj"), false);
  assert.equal(isAppleProjectConfigPath("Sources/Foo.swift"), false);
});

test("review-surfaces.COLLECTOR.8 Package.resolved is a lock, not project/config", () => {
  assert.equal(isAppleLockPath("Package.resolved"), true);
  assert.equal(
    isAppleLockPath("App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"),
    true
  );
  assert.equal(isAppleProjectConfigPath("Package.resolved"), false);
});

test("review-surfaces.COLLECTOR.8 Apple generated/cache/user-state paths are recognized", () => {
  for (const path of [
    ".build/release/App",
    "DerivedData/App/Build/Products/x.o",
    ".swiftpm/configuration/x",
    "SourcePackages/checkouts/Dep/x",
    "App.xcodeproj/project.xcworkspace/xcuserdata/me.xcuserdatad/UserInterfaceState.xcuserstate",
    "App.xcuserstate"
  ]) {
    assert.equal(isAppleGeneratedPath(path), true, `${path} should be generated/cache`);
  }
});

test("review-surfaces.COLLECTOR.8 + PRIVACY.8 signing artifacts and non-review union", () => {
  for (const path of ["App.mobileprovision", "Dev.provisionprofile", "cert.p12", "secret.key", "key.pem"]) {
    assert.equal(isAppleSigningArtifactPath(path), true, `${path} should be a signing artifact`);
  }
  assert.equal(isAppleNonReviewArtifactPath("Package.resolved"), true);
  assert.equal(isAppleNonReviewArtifactPath("App.mobileprovision"), true);
  assert.equal(isAppleNonReviewArtifactPath(".build/x"), true);
  assert.equal(isAppleNonReviewArtifactPath("Sources/Foo.swift"), false);
});

test("review-surfaces.COLLECTOR.8 classifyAppleSourceKind precedence", () => {
  assert.equal(classifyAppleSourceKind("Sources/App/User.swift"), "swift_source");
  assert.equal(classifyAppleSourceKind("Tests/AppTests/UserTests.swift"), "swift_test");
  assert.equal(classifyAppleSourceKind(".build/checkouts/Dep/Sources/Dep.swift"), "apple_generated");
  assert.equal(classifyAppleSourceKind("App.xcodeproj/project.pbxproj"), "apple_project_config");
  assert.equal(classifyAppleSourceKind("Package.resolved"), "apple_lock");
  assert.equal(classifyAppleSourceKind("App.mobileprovision"), "apple_signing");
  assert.equal(classifyAppleSourceKind("README.md"), "other");
});

// --- consumers delegate to the shared module --------------------------------

test("review-surfaces.COLLECTOR.8 PR-scope classifyRole uses the shared Swift/Apple rules", () => {
  assert.equal(isTestPath("FeatureTests/FooTests.swift"), true);
  assert.equal(classifyRole("FeatureTests/FooTests.swift", []), "test");
  assert.equal(classifyRole("App/App.entitlements", []), "config");
  // pbxproj is config (source of truth), never generated.
  assert.equal(classifyRole("App.xcodeproj/project.pbxproj", []), "config");
  // Package.resolved and build caches rank as generated, not implementation.
  assert.equal(classifyRole("Package.resolved", []), "generated");
  assert.equal(classifyRole(".build/release/App", []), "generated");
  // A Swift source with a threaded area is implementation, not test.
  assert.equal(classifyRole("Sources/App/User.swift", ["APP"]), "implementation");
});

test("review-surfaces.COLLECTOR.8 indexer classifyFile uses the shared Swift/Apple rules", () => {
  assert.equal(classifyFile("Tests/AppTests/FooTests.swift"), "test");
  assert.equal(classifyFile("Sources/App/User.swift"), "source");
  assert.equal(classifyFile("Package.resolved"), "lockfile");
  assert.equal(classifyFile("App/App.entitlements"), "config");
  assert.equal(classifyFile("App.xcodeproj/project.pbxproj"), "config");
  assert.equal(classifyFile(".build/release/App.o"), "generated");
});
