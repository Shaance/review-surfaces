// review-surfaces.COLLECTOR.8 — one shared source-kind classifier for Swift and
// Apple/Xcode repository inputs. PR scope, test indexing, the cold-start queue,
// generated-file exclusion, project modeling, and the semantic detectors all
// delegate here instead of each carrying a private list of Swift test suffixes or
// Apple file extensions (goal contract D5). Every predicate is PURE and keys only
// on the repo-relative POSIX path — no filesystem reads, no content inspection —
// so it is deterministic and safe to call from any stage.
//
// Scope of v1 (goal contract D2/D3): path-shape recognition only. XcodeGen's
// `project.yml`/`project.yaml` is recognized by name as an Apple project/config
// file (COLLECTOR.8 lists it explicitly); the CONTENT-aware project model that
// parses the XcodeGen shape and reconciles it with the generated `.xcodeproj`
// still lands in Phase 3.

function posix(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function baseName(filePath: string): string {
  const normalized = posix(filePath);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

// A path SEGMENT (directory or file component) equals one of `names`.
function hasPathSegment(filePath: string, names: ReadonlySet<string>): boolean {
  return posix(filePath)
    .split("/")
    .some((segment) => names.has(segment));
}

// --- Swift source / tests --------------------------------------------------

// A PascalCase path SEGMENT that marks a Swift/Xcode test target by convention. The
// dominant Xcode layout names the test target directory after the target with a
// `Tests`/`UITests` suffix (`MyAppTests/`, `MyAppUITests/`), NOT a bare `Tests/`, so
// the suffix is matched rather than an exact segment. Case-sensitive so lowercase
// words that merely end in "test" (`latest`, `contest`) are not test directories;
// `__Tests__` is the one underscored convention that needs an explicit allowance.
const SWIFT_TEST_DIR_SUFFIX = /(?:UI|Snapshot)?Tests?$/;

function hasSwiftTestDirSegment(filePath: string): boolean {
  return posix(filePath)
    .split("/")
    .some((segment) => segment === "__Tests__" || SWIFT_TEST_DIR_SUFFIX.test(segment));
}

// Test file basenames: `FooTests.swift`, `FooTest.swift`, `FooUITests.swift`,
// `FooUITest.swift`, `FooSnapshotTests.swift`. The plural `Tests.swift` is the
// dominant XCTest/Swift Testing convention and is exactly what the legacy
// `(?:Test|Spec)\.[^.]+$` heuristic missed.
const SWIFT_TEST_BASENAME = /(?:UI|Snapshot)?Tests?\.swift$/;

export function isSwiftFilePath(filePath: string): boolean {
  return posix(filePath).toLowerCase().endsWith(".swift");
}

export function isSwiftTestPath(filePath: string): boolean {
  if (!isSwiftFilePath(filePath)) {
    return false;
  }
  return SWIFT_TEST_BASENAME.test(baseName(filePath)) || hasSwiftTestDirSegment(filePath);
}

// A Swift implementation file: a `.swift` source that is NOT a test and NOT a
// generated/cache artifact.
export function isSwiftSourcePath(filePath: string): boolean {
  return isSwiftFilePath(filePath) && !isSwiftTestPath(filePath) && !isAppleGeneratedPath(filePath);
}

// --- Apple project / config files ------------------------------------------

// Distinctive Apple project/config extensions. `.plist` is included because in a
// repository it is essentially always an Apple/macOS property list and reviewers
// want Info.plist-family changes surfaced; the worst case is a benign config role.
const APPLE_CONFIG_EXTENSIONS: readonly string[] = [
  ".xcconfig",
  ".entitlements",
  ".xcscheme",
  ".xctestplan",
  ".xcprivacy",
  ".plist"
];

// Exact basenames that identify an Apple project/config file regardless of path.
// `project.yml`/`project.yaml` are the XcodeGen author-intent spec files; COLLECTOR.8
// requires the shared classifier to recognize them by name (Phase 3 adds the
// content-aware parse + generated-project reconciliation).
const APPLE_CONFIG_BASENAMES: ReadonlySet<string> = new Set([
  "Package.swift",
  "PrivacyInfo.xcprivacy",
  "project.pbxproj",
  "project.yml",
  "project.yaml"
]);

// A SwiftPM manifest: `Package.swift` or a version-specific `Package@swift-5.9.swift`.
// Recognized so the Swift DECLARATION differ skips it — its `let package = Package(...)`
// is build configuration, not an API surface (package facts handle manifest changes) —
// while it still classifies as Apple project config.
export function isSwiftPackageManifestPath(filePath: string): boolean {
  const base = baseName(filePath);
  return base === "Package.swift" || /^Package@swift-.+\.swift$/.test(base);
}

// `Package.resolved` is an Apple/SwiftPM LOCK file: recognized so dependency facts
// can read it (Phase 4a), but treated as lock/generated for baseline ranking so it
// never dominates the review queue. Kept separate from project/config.
export function isAppleLockPath(filePath: string): boolean {
  return baseName(filePath) === "Package.resolved";
}

// A reviewable Apple project/config file (Package.swift, the .pbxproj, XcodeGen
// project.yml/.yaml, schemes, test plans, xcconfig, entitlements, privacy manifest,
// Info.plist and other text plists). project.pbxproj is deliberately NOT treated as
// generated — it is often the source-of-truth project file (goal contract Phase 1).
export function isAppleProjectConfigPath(filePath: string): boolean {
  const base = baseName(filePath);
  // Version-specific SwiftPM manifests (`Package@swift-5.9.swift`) are project config
  // too, so a change to one lands in the manifest/package review focus rather than the
  // generic unknown path (the exact `Package.swift` is already in the basename set).
  if (isSwiftPackageManifestPath(filePath)) {
    return true;
  }
  if (APPLE_CONFIG_BASENAMES.has(base)) {
    return true;
  }
  const lower = base.toLowerCase();
  return APPLE_CONFIG_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// --- Apple generated / cache / user state ----------------------------------

// Directory components that hold generated build output or per-user Xcode state —
// never a manual review-focus item. `SourcePackages` is deliberately NOT listed: the
// bare name is too generic to mark generated globally without breaking "inert on
// non-Swift repos" (a non-Apple repo may keep real source under it). Xcode's MANAGED
// SourcePackages lives under DerivedData (and SwiftPM's checkouts under `.build` /
// `.swiftpm`), which are already covered here.
const APPLE_GENERATED_DIRS: ReadonlySet<string> = new Set([
  ".build",
  "DerivedData",
  "xcuserdata"
]);

// Build/result/output BUNDLE extensions: a generated Apple artifact whether it is a
// bundle directory (`App.xcarchive/…`, `TestResults.xcresult/…`, `App.dSYM/…`) or a
// single file (`App.ipa`, `Tests.xctestproducts`). Matched on any path SEGMENT so the
// bundle and everything inside it counts as generated.
const APPLE_GENERATED_BUNDLE = /\.(?:xcresult|xcarchive|dsym|xctestproducts|ipa)$/i;

export function isAppleGeneratedPath(filePath: string): boolean {
  const normalized = posix(filePath);
  if (hasPathSegment(normalized, APPLE_GENERATED_DIRS)) {
    return true;
  }
  // `.swiftpm/**` is XcodeGen/SwiftPM workspace + cache state. The shared playgrounds
  // package marker `.swiftpm/configuration` etc. is not review-focus.
  if (/(^|\/)\.swiftpm\//.test(normalized)) {
    return true;
  }
  if (normalized.split("/").some((segment) => APPLE_GENERATED_BUNDLE.test(segment))) {
    return true;
  }
  return /\.xcuserstate$/.test(baseName(normalized));
}

// --- Apple signing / provisioning / private material (privacy) -------------

// Signing/provisioning artifacts and private keys: excluded by default and never
// persisted (review-surfaces.PRIVACY.8). Distinct from generated state because the
// privacy boundary, not just ranking, must drop these.
const APPLE_SIGNING_EXTENSIONS: readonly string[] = [
  ".mobileprovision",
  ".provisionprofile",
  ".p12",
  ".p8", // App Store Connect API private key
  ".cer",
  ".certSigningRequest",
  ".keychain",
  ".keychain-db" // modern macOS keychain
];

export function isAppleSigningArtifactPath(filePath: string): boolean {
  const lower = baseName(filePath).toLowerCase();
  // Compare against lowercased extensions so a mixed-case canonical name like
  // `Foo.certSigningRequest` still matches the lowercased basename.
  if (APPLE_SIGNING_EXTENSIONS.some((ext) => lower.endsWith(ext.toLowerCase()))) {
    return true;
  }
  // Bare private-key material commonly committed by accident next to iOS configs.
  return lower.endsWith(".pem") || lower.endsWith(".key") || lower === "id_rsa";
}

// The union a reviewer never reads line-by-line on a cold start: generated/cache,
// per-user Xcode state, the SwiftPM lock, and signing material. Used by the
// cold-start floor's non-review-artifact exclusion (goal contract D5).
export function isAppleNonReviewArtifactPath(filePath: string): boolean {
  return isAppleGeneratedPath(filePath) || isAppleLockPath(filePath) || isAppleSigningArtifactPath(filePath);
}

// --- aggregate kind (for callers that want one switch) ---------------------

export type AppleSourceKind =
  | "swift_source"
  | "swift_test"
  | "apple_project_config"
  | "apple_lock"
  | "apple_generated"
  | "apple_signing"
  | "other";

// Single deterministic classification with a fixed precedence: generated/signing
// state wins over content roles (a `.swift` under DerivedData is generated, not
// source), then tests, then source, then project/lock config.
export function classifyAppleSourceKind(filePath: string): AppleSourceKind {
  if (isAppleSigningArtifactPath(filePath)) {
    return "apple_signing";
  }
  if (isAppleGeneratedPath(filePath)) {
    return "apple_generated";
  }
  if (isSwiftTestPath(filePath)) {
    return "swift_test";
  }
  // A SwiftPM manifest is a `.swift` file but is project CONFIG, not implementation
  // source — classify it before the generic Swift-source branch.
  if (isSwiftPackageManifestPath(filePath)) {
    return "apple_project_config";
  }
  if (isSwiftFilePath(filePath)) {
    return "swift_source";
  }
  if (isAppleLockPath(filePath)) {
    return "apple_lock";
  }
  if (isAppleProjectConfigPath(filePath)) {
    return "apple_project_config";
  }
  return "other";
}
