// review-surfaces.COLLECTOR.8 — one shared source-kind classifier for Swift and
// Apple/Xcode repository inputs. PR scope, test indexing, the cold-start queue,
// generated-file exclusion, project modeling, and the semantic detectors all
// delegate here instead of each carrying a private list of Swift test suffixes or
// Apple file extensions (goal contract D5). Every predicate is PURE and keys only
// on the repo-relative POSIX path — no filesystem reads, no content inspection —
// so it is deterministic and safe to call from any stage.
//
// Scope of v1 (goal contract D2/D3): path-shape recognition only. A name like
// `project.yml` is NOT classified as an Apple project file here because that needs
// content (XcodeGen shape); the content-aware project model lands in Phase 3.

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

// Directory components that mark a Swift/Xcode test target by convention.
const SWIFT_TEST_DIRS: ReadonlySet<string> = new Set([
  "Tests",
  "Test",
  "UITests",
  "UITest",
  "SnapshotTests",
  "__Tests__"
]);

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
  return SWIFT_TEST_BASENAME.test(baseName(filePath)) || hasPathSegment(filePath, SWIFT_TEST_DIRS);
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
const APPLE_CONFIG_BASENAMES: ReadonlySet<string> = new Set([
  "Package.swift",
  "PrivacyInfo.xcprivacy",
  "project.pbxproj"
]);

// `Package.resolved` is an Apple/SwiftPM LOCK file: recognized so dependency facts
// can read it (Phase 4a), but treated as lock/generated for baseline ranking so it
// never dominates the review queue. Kept separate from project/config.
export function isAppleLockPath(filePath: string): boolean {
  return baseName(filePath) === "Package.resolved";
}

// A reviewable Apple project/config file (Package.swift, the .pbxproj, schemes,
// test plans, xcconfig, entitlements, privacy manifest, Info.plist and other text
// plists). project.pbxproj is deliberately NOT treated as generated — it is often
// the source-of-truth project file (goal contract Phase 1).
export function isAppleProjectConfigPath(filePath: string): boolean {
  const base = baseName(filePath);
  if (APPLE_CONFIG_BASENAMES.has(base)) {
    return true;
  }
  const lower = base.toLowerCase();
  return APPLE_CONFIG_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// --- Apple generated / cache / user state ----------------------------------

// Directory components that hold generated build output, resolved package
// checkouts, or per-user Xcode state — never a manual review-focus item.
const APPLE_GENERATED_DIRS: ReadonlySet<string> = new Set([
  ".build",
  "DerivedData",
  "SourcePackages",
  "xcuserdata"
]);

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
  ".cer",
  ".certSigningRequest",
  ".keychain"
];

export function isAppleSigningArtifactPath(filePath: string): boolean {
  const lower = baseName(filePath).toLowerCase();
  if (APPLE_SIGNING_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
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
