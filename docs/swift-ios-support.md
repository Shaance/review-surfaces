# Swift and iOS support

`review-surfaces` reviews Swift, SwiftPM, and Xcode repositories as a first-class
language. "iOS support" means the existing Node CLI **understands and reviews iOS
repository structures** — it does not mean an iOS client for the tool.

All Swift/Apple analysis is **static and cross-platform**: every fact is derived
from committed repository files through injected base/head readers. The CLI never
invokes Xcode, SourceKit, `swiftc`, `xcodebuild`, `xcodegen`, or `xcrun` during
collection or analysis. A command you explicitly record with
`review-surfaces run -- …` is trusted by its captured exit code and transcript;
that is command evidence, not an implicit analysis dependency.

## Support matrix

| Capability | Cross-platform static | Requires macOS/Xcode |
|---|---:|---:|
| Swift file/test/project/generated classification | yes | no |
| Swift declaration / test-weakening / package / config facts | yes | no |
| Target-aware graph from committed project files | yes | no |
| Recording an existing `xcodebuild` transcript | no | yes — the command is run by you |
| Direct `.xcresult` / `xccov` ingestion | not in v1 | deferred (lcov conversion remains the path) |
| Simulator / device execution | not provided | outside product scope |

## What is recognized

- **Source roles** — Swift implementation vs. XCTest/UI-test files (by name and
  target directory), Apple project/config files (`Package.swift`,
  `Package.resolved`, XcodeGen `project.yml`, `*.xcodeproj/project.pbxproj`,
  `*.xcscheme`, `*.xctestplan`, `*.xcconfig`, `Info.plist`, `*.entitlements`,
  `PrivacyInfo.xcprivacy`), and generated/cache artifacts (`.build/`,
  `DerivedData/`, `SourcePackages/`, `xcuserdata/`, `*.xcuserstate`). The
  `project.pbxproj` is **not** treated as generated — it is often the
  source-of-truth project file.
- **Command evidence** — direct `swift test` and `xcodebuild test` /
  `test-without-building` are test runs; `build` / `build-for-testing` are
  validation, not test execution; `-list` / `-version` / `-showBuildSettings`
  are informational; `--filter` / `-only-testing:` / `-skip-testing:` narrow a
  run to a focused test.
- **Swift declaration facts** — public/package/open and target-level additions,
  removals, and signature changes, including parameter/return changes,
  conformances, protocol requirements, enum cases, `async`/`throws`, and
  global-actor/`Sendable` isolation. A body-only edit produces no contract fact.
- **Test-weakening facts** — removed XCTest/Swift Testing tests and assertions
  (`XCTAssert*`, `XCTUnwrap`, `#expect`, `#require`), newly skipped/disabled
  tests (`XCTSkip*`, `.disabled(…)`), test-plan skips, and snapshot reference
  edits — counted net added-vs-removed so an edited assertion is not a false
  weakening.
- **Target-aware symbol graph** — connects a file referencing a type/protocol/
  actor/enum to the file declaring it, scoped to the relevant target/module, and
  feeds changed-test→implementation attribution, blast radius, the change map,
  and reading order. An ambiguous name (declared more than once in the module) or
  a truncated graph emits no edge — never a false "used by 0".
- **Package facts** — direct requirements from `Package.swift`, XcodeGen
  `packages`, and pbxproj `XCRemoteSwiftPackageReference`, plus resolved pins from
  `Package.resolved` v2/v3. A benign `originHash`-only rewrite is no fact.
- **Config / structure facts** — high-signal Info.plist usage descriptions, App
  Transport Security broadening, privacy-manifest tracking, entitlement/capability
  changes, build settings (`SWIFT_VERSION`, `SWIFT_STRICT_CONCURRENCY`,
  `IPHONEOS_DEPLOYMENT_TARGET`, …), and Xcode target/scheme/test-plan changes.
  XcodeGen-vs-generated drift is advisory ("run the repository drift check"),
  never a blocker.

## Wrapper command rules

Direct commands are zero-config. Repository wrappers are declared in
`review-surfaces.config.yaml` with normalized exact/prefix matching; the
most-specific rule wins and an invalid rule fails config loading:

```yaml
command_rules:
  - id: ios-full
    match: exact
    command: ./scripts/check-ios.sh
    classification: broad_test
  - id: ios-unit-only
    match: exact
    command: ./scripts/check-ios.sh --quick
    classification: focused_test
  - id: ios-build-lint
    match: exact
    command: ./scripts/harness.sh ios-quick
    classification: validation
```

A configured rule classifies a wrapper the built-ins do not recognize; it can
never reclassify a direct command (e.g. `xcodebuild build`) or turn a failed exit
into passing evidence.

## Known bounds

- No compiler or type checker. A small deterministic Swift lexer/declaration
  scanner extracts supported declaration heads; unsupported or ambiguous syntax
  produces no semantic fact.
- Objective-C / Objective-C++ stay generic (no dedicated semantic analysis).
- Binary plists are diagnostic-only — absence of a key is never inferred from one.
- CocoaPods and Carthage are not modeled; SwiftPM and Xcode packages are.
- `.xcresult`/`xccov` coverage is not ingested directly; convert to lcov.
- The symbol graph is type/protocol/actor/enum oriented — it does not claim
  whole-program call-graph precision.
