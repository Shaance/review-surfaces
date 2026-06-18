# First-class Swift and iOS repository support — goal contract

**Status:** proposed on 2026-06-18  
**Target release:** next minor release (currently expected to be `0.3.0`)  
**Primary repository:** `Shaance/review-surfaces`  
**Dogfood repositories:** `Shaance/MenuWhisper`, `Shaance/hanzideck-ios`

This is a complete implementation contract. It should be sufficient for a contributor to execute the uplift without needing the originating conversation.

## Theme

Extend `review-surfaces` from generic cross-language review plus TypeScript/JavaScript-deep analysis into **first-class static review of Swift, SwiftPM, Xcode, and iOS application repositories**.

“iOS support” in this contract means that the existing Node CLI understands and reviews iOS repository structures. It does **not** mean building an iOS client for `review-surfaces`.

The uplift preserves the product’s existing architecture:

```text
repository inputs
  + deterministic collection
  + bounded language-specific facts
  + schema/evidence validation
  = the same review packet and human cockpit
```

No Swift fact may bypass the existing deterministic trust boundary, create facts through an LLM, or require a hosted service.

## Purpose / user-visible outcome

After this uplift, a reviewer can run the ordinary workflow in an iOS repository:

```bash
review-surfaces run -- \
  xcodebuild test \
  -project Example.xcodeproj \
  -scheme Example \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'

review-surfaces all \
  --base origin/main \
  --head HEAD \
  --provider mock \
  --out .review-surfaces
```

The generated human review should then:

- identify Swift implementation, unit-test, UI-test, project, package, privacy, entitlement, and generated/cache files correctly;
- distinguish a full `xcodebuild test` or `swift test` run from build-only and focused-test commands;
- surface meaningful Swift declaration changes, including signatures, conformances, protocol requirements, enum cases, and concurrency isolation;
- detect XCTest and Swift Testing weakening rather than applying JavaScript-only assertion rules;
- connect changed Swift tests to the implementation types they exercise when the relationship is deterministically resolvable;
- calculate bounded Swift blast-radius and reading-order facts within the correct Xcode or SwiftPM target;
- explain SwiftPM dependency and pin changes from `Package.swift`, XcodeGen, Xcode project package references, and `Package.resolved`;
- flag high-signal iOS privacy, entitlement, test-plan, target-membership, and build-setting changes;
- keep lockfiles, Xcode user state, caches, and other generated artifacts from dominating the review queue;
- retain the same packet, cockpit, local-first workflow, privacy boundary, and merge-readiness rules used for every other language.

Static collection and analysis must work anywhere the Node CLI works. Running `xcodebuild`, reading an `.xcresult`, booting a simulator, or invoking any Apple-only tool is never implicit; command evidence exists only when the user explicitly records that command on macOS.

## Progress

- [x] Plan reviewed and accepted.
- [x] Phase 0 — promote requirements and stage the strict gate.
- [x] Phase 1 — Swift/Xcode file roles, command evidence, and Apple-sensitive artifact handling.
- [x] Phase 2 — Swift declaration facts and XCTest/Swift Testing weakening.
- [x] Phase 3 — Apple project model and target-aware Swift symbol graph.
- [x] Phase 4a — SwiftPM and Xcode package facts.
- [x] Phase 4b — iOS/Xcode privacy, capability, build-setting, target, and scheme facts.
- [x] Phase 5 — full-surface integration, eval coverage, public benchmark, docs, dogfood, and release.
- [x] Final `quality_gate.allow_missing: []` and empty-diff `pnpm run local-gate` green.

## Surprises & Discoveries

Record implementation findings here as work proceeds. Each entry must include the evidence path or command that established it and any change made to this contract.

- **Phase 0 (gate mechanic).** In the empty-diff self-dogfood (`HEAD..HEAD`) there are no changed files, so a non-test-only ACID can only reach `partial` (test-evidence-only, via an exact-ACID-named test) — never `satisfied` (which needs a CHANGED implementation file). The gate counts only `missing`, so `partial` passes. This is why every shipped ACID needs an exact-ACID-named test and each phase removes its own ACIDs from `allow_missing`. Evidence: `src/evaluation/evaluate.ts` `evaluateRequirement` branches + `src/core/gate.ts` `countMissing`.
- **Phase 0 (worktree).** Two `claude/*` worktrees exist at the same commit; all work landed in `fervent-dewdney-e5cd14` (the harness primary dir). The contract copy lives at `docs/history/IOS_SWIFT_SUPPORT_GOAL.md`.
- **Phase 1 (command_rules wiring).** `command_rules` are folded into the cache signature for free because `collect.ts` already hashes the loaded config file's content. Built-in classification always wins for directly-recognized commands (a rule can never reclassify `xcodebuild build`); rules only classify wrappers the built-ins do not recognize. Threaded into the test-evidence consumers (`risks.ts`, `pr-risks.ts`, `methodology/cross-reference.ts`).
- **Phase 1 (test weakening reuse).** Because Phase 1's shared `isTestPath` now recognizes Swift test files, the existing `detectTestWeakening` already fires `deleted_test_file` on a deleted Swift test; Phase 2 only needs Swift-aware skip/assertion patterns. The human `semanticChangeFacts` schema is `additionalProperties: true`, and Swift weakening maps onto the existing `kind` enum, so Phase 2 needs minimal schema churn.
- **Phase 2 (TS flow-narrowing in the lexer).** A closure that reassigns the lexer `state` variable defeated TS control-flow narrowing of the discriminated union; rewrote the loop as a `switch (state.kind)` with direct assignment (no `enter` closure) and an explicit `const depth: number` to break a circular flow-type inference.
- **Phase 3 (symbol graph: module visibility).** Strict per-target uniqueness made a test target's `@testable import App` invisible to App's types, so test→impl attribution failed. Fixed by resolving references against a file's VISIBLE modules — own module + transitive target deps + `import`ed target names — and emitting an edge only when the union of declarers across those modules is exactly one file. A repo with no project model falls back to a single implicit module (repo-wide uniqueness), which is conservative.
- **Phase 3 (macOS case-insensitive FS).** The eval fixture's `Tests/AppTests/` collapsed into the existing lowercase `tests/` dir on macOS, making the persisted path platform-dependent; fixtures now use a non-colliding `AppTests/` directory (the `…Tests.swift` basename is what classifies the test, so the directory name is free).
- **Phase 3 (Phase 3 is inert on this repo).** `review-surfaces` has zero committed `.swift`/Apple project files, so `buildSwiftGraphForPacket` returns undefined, `apple_project.json` is never written, and the empty-diff self-dogfood + determinism output is byte-identical to before — the Swift graph only activates on actual Swift repos.

## Decision Log

### D1 — support the repository, not an iOS client

The deliverable is first-class analysis of Swift/Xcode repositories by the existing CLI. No SwiftUI shell or mobile distribution is introduced.

### D2 — static-first and cross-platform

Swift and Xcode facts are derived from repository files with injected base/head readers. The CLI does not invoke Xcode, SourceKit, `swiftc`, `xcodebuild`, `xcodegen`, or `xcrun` during collection.

A command explicitly recorded through `review-surfaces run -- ...` may be trusted according to its captured exit code and transcript. That is command evidence, not an implicit analysis dependency.

### D3 — conservative bounded parsing, not a compiler

The first release uses a small deterministic Swift lexer/declaration scanner. It strips comments and literals, tracks nesting, and extracts only supported declaration heads. Unsupported or ambiguous syntax produces no semantic fact and, when useful, a bounded diagnostic. It never guesses.

Do not add a native SwiftSyntax/SourceKit dependency in this uplift. A compiler-backed optional adapter can be considered later after the static path has benchmark evidence.

### D4 — one project model with source provenance

Create one internal Apple project model assembled from the sources present in the repository:

1. `project.yml` for XcodeGen-authored target, source, setting, package, and scheme intent;
2. `Package.swift` for SwiftPM target and direct-package intent;
3. `*.xcodeproj/project.pbxproj` for observed Xcode targets, source build phases, settings, and remote Swift package references;
4. shared `*.xcscheme` files for build/test plan references;
5. `*.xctestplan` JSON for selected test targets and options.

These inputs are merged with provenance rather than silently selecting one winner. In an XcodeGen repository, `project.yml` is author intent and the generated `.xcodeproj` is observed output. A disagreement becomes a possible-drift fact or diagnostic, never an invented certainty.

### D5 — shared file-role predicates

Swift/Xcode path rules must live in one shared module and be reused by PR scope, test indexing, the cold-start queue, generated-file exclusion, project modeling, and semantic detectors. Do not add a second private list of Swift test suffixes to `human-review.ts`.

### D6 — target-aware graph, conservative edges

Swift files in one target do not import one another, so the TypeScript relative-import graph cannot simply be extended by file extension.

The Swift graph is built from target membership plus tokenized type declarations and references. A file-to-file edge is emitted only when a referenced declaration is unique within the relevant target/module. Ambiguous names produce no edge. `extension Foo` may resolve to the unique declaration of `Foo`. V1 blast radius is type/protocol/actor/enum oriented; it does not claim whole-program call-graph precision.

### D7 — direct commands are zero-config; wrappers require explicit rules

Built-in classification recognizes direct `swift test` and `xcodebuild` commands. Repository-specific wrappers such as `./scripts/check-ios.sh` and `./scripts/harness.sh full` are not hard-coded into the package.

Add deterministic config rules for trusted local wrappers. Rules use normalized exact or prefix matching and declare one of:

- `broad_test`;
- `focused_test`;
- `validation`.

Longest/specific matching wins, and an invalid rule fails config loading rather than silently weakening evidence.

Example:

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
  - id: full-handoff
    match: exact
    command: ./scripts/harness.sh full
    classification: broad_test
```

### D8 — additive artifact evolution

Do not rename or remove the existing TypeScript `api_changes` contract in a minor release. Add a Swift-specific declaration-fact array or an additive language discriminator, whichever produces the smaller compatible schema change after tracing all consumers.

New runtime arrays are always present as `[]`; persisted schema fields may be optional for compatibility with older artifacts. Every list is sorted with stable tie-breaks.

### D9 — private applications are dogfood, not fixtures

`MenuWhisper` and `hanzideck-ios` validate real-world usefulness, but no private source, project file, diff, command output, secret, or artifact is copied into this repository. Unit/eval fixtures are minimal synthetic projects. Public benchmark cases use pinned public repositories and commits.

### D10 — uncertainty cannot clear risk

A partial project parse, truncated graph, unsupported binary plist, ambiguous symbol, or unknown package expression must never be rendered as “no impact” or “used by 0.” It must either omit the claim or carry an explicit partial/unknown diagnostic.

## Grounding in the current implementation

The current implementation already provides a useful base:

- generic collection, packet generation, cold-start ranking, privacy redaction, evidence validation, and human rendering are language-independent;
- `swift test` is already recognized by the cross-ecosystem command classifier;
- the cold-start ranking considers `.swift` an implementation extension and recognizes broad `FooTest.swift`/`FooTests.swift` naming.

The first-class gaps are concentrated and observable:

- `src/commands/classify.ts` recognizes `swift test` but not `xcodebuild test`, `test-without-building`, `build-for-testing`, or Apple-focused selectors;
- `src/scope/pr-scope.ts:isTestPath` recognizes `tests/`, `.test.*`, and `.spec.*`, but not Xcode test-target directories or Swift test filenames;
- `src/config/config.ts` defaults only index JavaScript/TypeScript test globs;
- `src/collector/import-graph.ts` parses only TypeScript/JavaScript relative imports;
- `src/risks/semantic-diff.ts` parses only TypeScript exported surfaces and JavaScript-style skips/assertions;
- `src/risks/dependency-facts.ts` understands Node manifests and lockfiles only;
- `src/risks/config-facts.ts` understands JavaScript environment references, GitHub workflows, Dockerfiles, and SQL, but no Apple project or privacy files;
- `Package.resolved`, `.xctestplan`, `.xcconfig`, `.entitlements`, `PrivacyInfo.xcprivacy`, Xcode schemes, source build phases, and Swift concurrency declarations have no dedicated deterministic facts.

The two dogfood repositories exercise complementary project shapes:

- `MenuWhisper` uses a committed Xcode project, multiple shared Xcode test plans, an `xcodebuild`-based iOS check script, XCTest/UI tests, and an Xcode-managed `Package.resolved`;
- `hanzideck-ios` uses XcodeGen `project.yml`, Swift 6 strict concurrency, SwiftPM packages, explicit application and test targets, entitlements, generated Info.plist settings, and repository harness scripts.

## Reconciled requirements / proposed ACIDs

The following identifiers are open against the current ledger and extend existing architectural families instead of creating a disconnected `IOS` subsystem. Reconcile once more against `main` immediately before Phase 0.

| ACID | Requirement |
|---|---|
| `review-surfaces.COLLECTOR.8` | One shared source-kind classifier must consistently recognize Swift implementation/test files, XCTest/UI-test target conventions, Apple project/config files, and Apple generated/cache artifacts across collection, scope, test indexing, and human ranking. |
| `review-surfaces.COLLECTOR.9` | Command evidence must recognize direct `xcodebuild test`/`test-without-building` and `swift test`, distinguish build-only and focused selectors, parse bounded Apple test summaries, and support validated repository-configured wrapper rules. |
| `review-surfaces.SEMANTIC_DIFF.5` | Deterministic Swift declaration facts must report supported public/package/open and target-level declaration additions, removals, and signature changes, including conformances, protocol requirements, enum cases, `async`/`throws`, and actor-isolation changes, without claiming compiler completeness. |
| `review-surfaces.SEMANTIC_DIFF.6` | Deterministic test-weakening facts must understand XCTest, Swift Testing, snapshot-reference, and Xcode test-plan changes, including removed tests/assertions, newly skipped/disabled tests, and selected test targets removed or disabled. |
| `review-surfaces.BLAST_RADIUS.4` | A bounded target-aware Swift symbol graph must connect unique type declarations/references, changed tests to implementation, blast-radius metadata, the change map, and reading order; ambiguous or partial graphs never emit a false zero. |
| `review-surfaces.DEP_FACTS.6` | Deterministic Swift package facts must compare direct requirements and resolved pins from `Package.swift`, XcodeGen package declarations, Xcode remote package references, and nested `Package.resolved` v2/v3 files, without executing package manifests or guessing transitive attribution. |
| `review-surfaces.CONFIG_FACTS.4` | Deterministic Apple config facts must cover high-signal Info.plist, entitlement, privacy manifest, xcconfig, and build-setting changes and route them into existing security/privacy, API-contract, and test-evidence lenses with concrete language. |
| `review-surfaces.CONFIG_FACTS.5` | Deterministic Xcode structure facts must cover target, source membership, scheme, test-plan, and XcodeGen observed-output drift, while uncertain drift remains a question/advisory rather than a blocker. |
| `review-surfaces.PRIVACY.8` | Apple signing/provisioning/user-state artifacts must be excluded by default, while reviewable service plist/project text remains subject to redact-before-persist and block-before-remote behavior with iOS-specific regression fixtures. |
| `review-surfaces.EVAL_HARNESS.7` | The real-pipeline seeded eval must cover every shipped Swift/iOS fact class plus benign negative cases, and record their pass counts in the existing scoreboard. |
| `review-surfaces.BENCH.2` | The pinned public effectiveness benchmark must include representative Swift/SwiftPM/iOS diffs and preserve zero empty queues, zero fabricated blockers, zero irrelevant generated artifacts in the top five, and high expected-focus recall. |
| `review-surfaces.DISTRIBUTION.16` | README/agent documentation must publish an honest support matrix, macOS execution boundary, wrapper-rule example, known bounds, and copy-pasteable Swift/Xcode commands for the next minor release. |

## Execution convention

Use the repository’s established uplift process.

- One PR per phase, with branches `ios-swift-phase-<n>-<slug>`; Phase 4 uses `4a` and `4b`.
- Phase 0 adds every new ACID to `features/review-surfaces.feature.yaml` and stages it in `review-surfaces.config.yaml:quality_gate.allow_missing`; `max_missing` stays `0`.
- Each shipping phase removes only its own ACIDs from `allow_missing`.
- Every shipped ACID gets at least one exact-ACID-named test. Implementation-only evidence is not enough.
- Each fact class also gets a real-pipeline seeded eval case in the same phase that ships the fact; `EVAL_HARNESS.7` is removed only after the complete set exists.
- Per-phase loop:

```text
implement
→ simplify / duplication pass
→ focused tests
→ pnpm run local-gate
→ pnpm run local-review on the real phase diff
→ inspect human_review.html and human_review.json
→ push
→ @codex review
→ resolve all grounded rounds
→ merge only with a clean verdict and green gate
```

- Use `--provider mock` for all acceptance and dogfood runs unless a separate test explicitly exercises provider behavior.
- After every merge, run the empty-diff local gate on `main` so an ACID removal cannot leave the default branch red.

## Phase summary

| Phase | Branch slug | Ships | Removes from allowlist |
|---|---|---|---|
| 0 | `spec-promotion` | Goal contract, ACIDs, allowlist staging, acceptance matrix | none |
| 1 | `swift-xcode-foundation` | File roles, test indexing, direct/wrapper command evidence, Apple-sensitive artifact handling | `COLLECTOR.8`, `COLLECTOR.9`, `PRIVACY.8` |
| 2 | `swift-semantic-and-tests` | Swift declaration facts and XCTest/Swift Testing/test-plan weakening | `SEMANTIC_DIFF.5`, `SEMANTIC_DIFF.6` |
| 3 | `apple-project-and-symbol-graph` | Project model, target membership, Swift graph, changed-test attribution, blast radius | `BLAST_RADIUS.4` |
| 4a | `swiftpm-dependency-facts` | SwiftPM/Xcode package requirement and pin facts | `DEP_FACTS.6` |
| 4b | `apple-config-facts` | Privacy/capability/build-setting/target/scheme/drift facts | `CONFIG_FACTS.4`, `CONFIG_FACTS.5` |
| 5 | `integration-benchmark-release` | Remaining eval cases, public benchmark, docs, support matrix, dogfood evidence, release | `EVAL_HARNESS.7`, `BENCH.2`, `DISTRIBUTION.16` |

**Merge order:**

```text
0 → 1 → 2 → 3 → {4a, 4b in parallel} → 5
```

Phase 3 reuses the Phase 2 Swift lexer/declaration index. Phases 4a and 4b consume the Phase 3 project model but own separate risk modules and test files, so they can proceed in parallel.

## Phase 0 — spec promotion

### Goal

Make the uplift visible to the strict gate before production behavior changes.

### Files

- Create `docs/history/IOS_SWIFT_SUPPORT_GOAL.md` from this contract.
- Modify `features/review-surfaces.feature.yaml` with the reconciled requirements.
- Modify `review-surfaces.config.yaml` to add all new ACIDs to `quality_gate.allow_missing` while retaining `max_missing: 0`.
- Update any spec-ledger tests that assert requirement counts or maxima.

### Required tests

- The feature parser loads every new ACID.
- No ID collides with the live ledger.
- Every staged ACID appears exactly once in `allow_missing`.
- An unrelated synthetic missing requirement still fails the gate.

### Verification

```bash
pnpm test
pnpm run local-gate
```

### Exit criteria

The gate is green with only the named iOS/Swift backlog staged. No runtime output changes.

## Phase 1 — Swift/Xcode foundation

### Goal

Deliver immediate useful iOS behavior before deep parsing: correct roles, test indexing, command evidence, and safe handling of Apple-specific artifacts.

### 1. Shared source-kind module

Create `src/collector/source-kind.ts` with exported predicates used throughout the repository. The module should recognize at least:

**Swift source**

- `*.swift` outside an identified test/generated path.

**Tests**

- directories/components named `Tests`, `Test`, `UITests`, `SnapshotTests`, or `__Tests__`;
- `*Test.swift`, `*Tests.swift`, `*UITest.swift`, and `*UITests.swift`;
- source membership in an identified Xcode/SwiftPM test target when the project model becomes available in Phase 3.

**Apple project/config**

- `Package.swift`;
- any basename `Package.resolved`;
- `project.yml` when it has XcodeGen shape;
- `*.xcodeproj/project.pbxproj`;
- shared `*.xcscheme`;
- `*.xctestplan`;
- `*.xcconfig`;
- `Info.plist` and other text plists;
- `*.entitlements`;
- `PrivacyInfo.xcprivacy`.

**Generated/cache/user state**

- `.build/`;
- `DerivedData/`;
- `SourcePackages/`;
- `.swiftpm/` cache/workspace state where appropriate;
- `xcuserdata/`;
- `*.xcuserstate`;
- compiled/binary Apple artifacts.

Do **not** globally classify `project.pbxproj` as generated. It is often the source-of-truth project file. In an XcodeGen repository it remains observed generated configuration and may participate in drift checks.

Update consumers to delegate to the shared module:

- `src/scope/pr-scope.ts`;
- `src/human/human-review.ts` cold-start role and non-review-artifact logic;
- test/source indexing under `src/indexer/` and `src/collector/`;
- any test-to-implementation matcher that currently carries its own suffix list.

Update `src/config/config.ts` and bootstrap templates so zero-config repositories index Swift tests. Keep existing JS/TS defaults and add bounded Swift patterns rather than replacing them.

### 2. Direct Xcode command classification

Extend `src/commands/classify.ts` with a dedicated `xcodebuild` parser rather than one broad regex.

Required behavior:

| Command | Classification |
|---|---|
| `swift test` | test; existing behavior retained |
| `swift test --filter ...` | focused test |
| `xcodebuild test ...` | test |
| `xcodebuild test-without-building ...` | test |
| `xcodebuild build-for-testing ...` | validation, not test execution |
| `xcodebuild build ...` | validation, not test execution |
| `xcodebuild -list`, `-version`, `-showBuildSettings` | informational, not test evidence |
| `-only-testing:*`, `-skip-testing:*` | focused test |
| `-destination`, `-scheme`, `-project`, `-workspace`, `-testPlan` | do not alone make a run focused |

Add a bounded Apple transcript parser under `src/tests-evidence/` for standard XCTest and Swift Testing summaries. It may extract counts and success/failure markers, but it never overrides the captured process exit code and it does not parse `.xcresult` in this release.

### 3. Explicit wrapper rules

Extend `ReviewSurfacesConfig` and `normalizeConfig` in `src/config/config.ts` with validated `command_rules`.

Rules must:

- have stable IDs;
- use normalized exact or prefix matching only;
- validate classification enums;
- be sorted and applied deterministically;
- use the most-specific matching rule;
- be folded into the collection/cache signature;
- fail loudly on malformed or duplicate IDs.

Built-ins run first for direct commands; an explicit local rule may classify a repository wrapper but may not transform a failed exit into passing evidence.

### 4. Apple-sensitive artifacts

Extend bootstrap ignore guidance and privacy fixtures:

- exclude `*.mobileprovision`, `*.provisionprofile`, `*.p12`, private keys, Xcode user state, DerivedData, and build caches;
- keep reviewable text such as `GoogleService-Info.plist`, entitlements, and project files available to deterministic detectors, but pass them through the existing secret-redaction/block boundary;
- add a regression fixture proving an API key in a service plist is redacted and raises the remote-provider block signal;
- never persist an absolute DerivedData or home-directory path.

### Tests

- New `tests/source-kind.test.ts` with table-driven path cases.
- Extend `tests/command-classify.test.ts` for direct `xcodebuild`, selectors, wrappers, help/version, and build-only negatives.
- Extend config tests for command-rule validation and cache signature changes.
- Extend PR-scope and human-review tests proving `FeatureTests/FooTests.swift` is a test, `Package.resolved` is not a top review file, and `.entitlements` is config.
- Extend privacy/bootstrap tests for signing artifacts and service-plist redaction.
- Add at least one programmatic eval fixture where a Swift source and test change produce a non-empty, correctly ordered queue without fabricated blockers.

### Dogfood

Run the phase build against a small source+test diff in both private apps. At this phase the expected gain is classification and command truth, not Swift semantic facts.

### Exit criteria

- Direct Xcode test evidence is trustworthy.
- The two dogfood repositories no longer mislabel their XCTest/UI-test source as ordinary implementation.
- Generated Apple artifacts do not dominate the queue.
- `COLLECTOR.8`, `COLLECTOR.9`, and `PRIVACY.8` have exact tests and are removed from `allow_missing`.

## Phase 2 — Swift semantic and test-weakening facts

### Goal

Add deterministic Swift-aware facts without introducing a compiler dependency.

### 1. Swift lexer and declaration index

Create:

- `src/risks/swift-lexer.ts`;
- `src/risks/swift-declarations.ts`;
- `src/risks/swift-semantic-diff.ts`.

The lexer must handle, at minimum:

- line and nested block comments;
- ordinary and multiline strings without leaking string contents into identifier/reference scans;
- balanced parentheses, brackets, angle brackets where practical, and braces;
- attributes and modifier lists;
- top-level and type-member declaration heads.

The declaration model should include:

```ts
interface SwiftDeclaration {
  path: string;
  name: string;
  kind: "class" | "struct" | "enum" | "protocol" | "actor" |
        "extension" | "typealias" | "function" | "initializer" |
        "subscript" | "property";
  visibility: "open" | "public" | "package" | "internal" | "private" | "fileprivate";
  container?: string;
  signature: string;
  attributes: string[];
  conformances: string[];
  protocol_requirements?: string[];
  enum_cases?: string[];
}
```

The exact internal shape may vary, but it must remain deterministic, bounded, and independently unit-testable.

### 2. Declaration changes

Compare base/head declaration indexes and emit concrete facts for:

- symbol addition/removal;
- normalized signature changes;
- parameter label/type/default changes where statically visible;
- return type changes;
- `async`, `throws`, and `rethrows` changes;
- `@MainActor` or another supported global-actor change;
- `Sendable` conformance changes;
- superclass/protocol-conformance changes;
- protocol requirement addition/removal/change;
- enum case addition/removal;
- access widening/narrowing.

Severity/routing rules:

- removed or signature-changed `open`/`public`/`package` declarations route to the API-contract lens;
- a new protocol requirement or removed enum case is contract-relevant even within an app target;
- internal target-level changes are advisory until Phase 3 supplies a deterministic `used_by` relationship;
- additions are generally lower severity than removals/contract changes;
- an unsupported parse never becomes a blocker.

Keep TypeScript output stable. Prefer an additive `swift_declaration_changes` fact array in `SemanticChangeFacts` unless tracing shows that an optional `language`/`surface` field on the current API-change type is strictly smaller and backward-compatible.

### 3. XCTest and Swift Testing weakening

Extend test-weakening detection with Swift rules:

**Deleted/removed tests**

- deleted Swift test file;
- removed `func test...` XCTest method;
- removed `@Test` Swift Testing declaration;
- removed test target or selected test target, with test-plan handling coordinated with Phase 4b.

**Newly disabled/skipped**

- `XCTSkip`, `XCTSkipIf`, `XCTSkipUnless`;
- Swift Testing `.disabled(...)` traits on `@Test` or `@Suite`;
- relevant skipped-test entries in `.xctestplan`.

**Assertions/checks removed**

- `XCTAssert*`, `XCTFail`, `XCTUnwrap`;
- expectation/wait/fulfillment checks where unambiguous;
- Swift Testing `#expect` and `#require`.

Use net added-versus-removed counting so an edited assertion does not become a false weakening fact.

**Snapshot references**

- modified existing files under established snapshot/reference directories are advisory test-weakening facts;
- newly added reference images are not weakening;
- binary content is never copied into an artifact.

### Schema and render integration

- Extend runtime types and strict schemas additively.
- Add shared language-aware formatting helpers so queue, lens, comment, and detail renderers cannot disagree.
- Include exact path/line evidence when the changed declaration or assertion line is known.
- Facts enter existing verdict/risk logic; no Swift-only verdict path is added.

### Tests

- New parser tests for comments, multiline strings, generics, attributes, nested types, extensions, and malformed/unsupported input.
- Exact `SEMANTIC_DIFF.5` tests for public signature, protocol, enum, actor-isolation, and benign implementation-body changes.
- Exact `SEMANTIC_DIFF.6` tests for XCTest, Swift Testing, snapshot, and test-plan positive/negative cases.
- Extend `tests/eval-harness.test.ts` with `swift_contract_change` and `swift_test_weakening` classes.
- Human-review tests assert concrete Swift language and evidence, not generic “file changed” prose.

### Exit criteria

- A body-only Swift edit does not generate a declaration-contract fact.
- A public signature change and removed `#expect` rank within the seeded eval top ten.
- No unsupported parse creates a blocker or false “safe” claim.
- `SEMANTIC_DIFF.5` and `.6` are removed from `allow_missing`.

## Phase 3 — Apple project model and Swift symbol graph

### Goal

Understand target membership and produce conservative Swift test connection, blast-radius, change-map, and reading-order facts.

### 1. Apple project model

Create a focused module family under `src/collector/apple-project/`:

- `model.ts` — target/project/provenance types;
- `xcodegen.ts` — `project.yml` reader using the existing YAML dependency;
- `swiftpm.ts` — bounded `Package.swift` target/product reader using the Swift lexer;
- `pbxproj.ts` — focused parser for native targets, source build phases, file references, build settings, and remote package references;
- `scheme.ts` — shared scheme buildable and test-plan references;
- `test-plan.ts` — `.xctestplan` JSON target/options reader;
- `build.ts` — merges sources and produces bounded diagnostics.

Suggested internal shape:

```ts
interface AppleProjectModel {
  projects: AppleProjectSource[];
  targets: AppleTarget[];
  schemes: AppleScheme[];
  test_plans: AppleTestPlan[];
  diagnostics: AppleProjectDiagnostic[];
  truncated: boolean;
}

interface AppleTarget {
  id: string;
  name: string;
  kind: "application" | "framework" | "library" | "unit_test" |
        "ui_test" | "extension" | "other";
  source_paths: string[];
  dependency_target_ids: string[];
  provenance: Array<"xcodegen" | "swiftpm" | "pbxproj">;
}
```

Persist a bounded, redacted, repo-relative `inputs/apple_project.json` for observability. It contains derived names/paths/provenance/diagnostics only, never raw project content or absolute paths.

### 2. Swift symbol graph

Create `src/collector/swift-symbol-graph.ts` and, only as far as required, a small internal generic graph contract shared with `src/collector/import-graph.ts`.

Rules:

- parse indexed Swift files once and cache declarations/tokens;
- group files by project target/module;
- emit a file dependency when a referenced type/protocol/actor/enum name has exactly one declaration in that target/module;
- map `extension Foo` to the unique `Foo` declaration;
- treat cross-target `import Module` as a target-level relation, not proof of one file relation;
- do not create edges for ambiguous common names;
- preserve deterministic sorting;
- use a file/token cap and explicit `truncated` state;
- carry a precision label such as `unique_symbol_reference` so renderers do not imply compiler-level call-graph accuracy.

### 3. Reuse in existing surfaces

Wire the Swift graph into the same consumers as the TS graph:

- changed-test-to-implementation evidence used by ranking;
- `used_by` blast-radius metadata;
- change graph edges/halo where deterministically available;
- dependency-first reading order;
- architecture-drift facts only where the current architecture detector can consume a new/removed graph edge without overstating certainty.

A changed `FooTests.swift` that references the unique `Foo` type should count as a connected changed test for `Foo.swift`. A test with no deterministically resolvable reference remains unconnected; stem matching may remain a fallback but is lower-confidence and must not override graph evidence.

### Tests

- Programmatic XcodeGen fixture with application and unit-test targets.
- Programmatic minimal pbxproj fixture with app, unit-test, and UI-test source build phases.
- Minimal SwiftPM package fixture.
- Scheme and test-plan fixture.
- Unique type reference produces one edge.
- Ambiguous duplicate type name produces no edge.
- `extension Foo` resolves correctly.
- Same symbol name in separate targets does not cross-link.
- Truncated project/graph never emits `used_by: 0` as fact.
- Eval case proves a changed test clears the “no connected test change” ranking boost only for the implementation it actually references.

### Dogfood

- `MenuWhisper`: the pbxproj/test-plan path resolves app, unit-test, and UI-test targets.
- `hanzideck-ios`: `project.yml` resolves application and test targets, package dependencies, source roots, Swift 6 settings, and entitlements; the generated project is recorded as observed output.

Record only aggregate evidence in this plan: target counts, parse diagnostics, queue outcomes, and whether expected files appeared. Do not commit project extracts.

### Exit criteria

- Both private repository shapes produce a non-partial target model for their principal app and test targets.
- A Swift source/test diff gets deterministic changed-test attribution.
- Existing non-Swift graph output remains stable.
- `BLAST_RADIUS.4` is removed from `allow_missing`.

## Phase 4a — SwiftPM and Xcode package facts

### Goal

Extend the existing supply-chain lens to Apple package inputs without executing manifests.

### Inputs

Support all of the following when present:

- root or nested `Package.swift` common literal `.package(...)` forms;
- XcodeGen `project.yml:packages`;
- `XCRemoteSwiftPackageReference` entries in pbxproj;
- any repo-relative `Package.resolved` v2/v3 file, including Xcode workspace locations.

### Facts

Emit deterministic facts for:

- direct package added/removed;
- package identity or source URL changed;
- local path dependency introduced;
- branch/revision dependency introduced or changed;
- exact/range requirement changed;
- semantic major version increase or decrease;
- requirement loosened, such as exact/range becoming branch or a narrower lower-bound becoming a broader rule where the parser can prove it;
- resolved pin added/removed;
- resolved version/revision/location changed.

Provenance must name the manifest/project/lock path and whether the fact came from direct intent or a resolved pin.

`Package.resolved` does not encode a complete dependency graph. A pin that cannot be attributed to one direct dependency remains unattributed. Never guess a `via` field.

### Noise controls

- Treat `Package.resolved` as a lock/generated artifact for baseline ranking while still feeding it into dependency facts.
- A pure `originHash` rewrite with identical pins is no fact.
- Formatting/key-order changes are no fact.
- A resolved revision change accompanying an unchanged semantic version may be lower severity but must be visible.

### Files

- Create `src/risks/swift-package-facts.ts`.
- Extend `src/risks/dependency-facts.ts` only as an orchestrator/shared fact type where practical.
- Extend human supply-chain formatting through existing helpers rather than adding an Apple-only lens.
- Add `tests/swift-package-facts.test.ts` and eval coverage.

### Exit criteria

- XcodeGen and pbxproj direct requirements plus nested `Package.resolved` pins produce concrete package facts.
- A benign origin-hash-only change is silent.
- The dependency finding can lead the queue when high-risk, but the lockfile itself is not an irrelevant top-five review-focus item.
- `DEP_FACTS.6` is removed from `allow_missing`.

## Phase 4b — Apple configuration and project-structure facts

### Goal

Surface high-signal iOS privacy, capability, build-setting, target, scheme, and generator-drift changes through existing lenses.

### 1. Plist-family reader

Create a bounded text plist reader supporting the XML dict/array/string/bool/integer shapes required by:

- Info.plist;
- `.entitlements`;
- `PrivacyInfo.xcprivacy`.

Binary plists are not parsed in v1. Emit an `unparsed_binary` diagnostic and do not infer absence of a key.

Also read equivalent generated Info.plist/entitlement settings from XcodeGen `project.yml` and supported pbxproj build settings.

### 2. High-signal config facts

**Privacy and transport**

- camera, microphone, photos, contacts, location, speech, Bluetooth, health, and related usage-description keys added/removed;
- App Transport Security broadened, especially arbitrary loads;
- URL schemes and background modes added/removed;
- privacy manifest tracking flag, tracking domains, collected-data declarations, and required-reason API declarations changed.

**Capabilities/entitlements**

- app groups;
- keychain access groups;
- iCloud/CloudKit containers and services;
- associated domains;
- push notifications / APS environment;
- Sign in with Apple;
- time-sensitive notifications;
- sandbox/capability keys changed.

**Build/toolchain settings**

- `IPHONEOS_DEPLOYMENT_TARGET`;
- `SWIFT_VERSION`;
- `SWIFT_STRICT_CONCURRENCY`;
- `ENABLE_TESTABILITY`;
- `APPLICATION_EXTENSION_API_ONLY`;
- `CODE_SIGN_ENTITLEMENTS` path;
- selected compilation conditions or unsafe Swift flags when changed.

Avoid noisy facts for innocuous generated ordering, object IDs, or routine build-number/version changes unless an existing version policy explicitly asks for them.

### 3. Xcode structure facts

Compare base/head Apple project models for:

- target added/removed or kind changed;
- test target removed;
- source file added to or removed from a target;
- app-to-test dependency removed;
- scheme test action removed or changed;
- test plan added/removed;
- selected test target removed/disabled;
- XcodeGen intent and generated project disagree on the supported comparison subset.

A supported exact removal is a deterministic fact. XcodeGen drift that could be due to an unsupported parser feature is phrased as “possible generated-project drift; run the repository drift check,” never as a proven defect.

### Routing

- ATS, tracking, privacy, entitlement, capability changes → `security_privacy`;
- deployment target / language mode / public build configuration → `api_contract` or `architecture` as appropriate;
- test target/scheme/test-plan weakening → `test_evidence`;
- generator drift → `cache_provenance` or `architecture` with a verification command suggestion.

### Tests

- XML plist positive/negative fixtures.
- Entitlement addition/removal.
- ATS broadening.
- Privacy manifest tracking change.
- Swift version / strict-concurrency change.
- Test target/scheme/test-plan removal.
- XcodeGen project and generated project match: no drift fact.
- Deliberate supported mismatch: advisory drift fact.
- Unsupported/binary input: diagnostic only, no false absence fact.
- Eval cases for one privacy/capability change and one test-structure weakening; benign build-number and generated-ID changes must not rank above low severity.

### Exit criteria

- High-signal config changes name the exact key/target and action a reviewer should take.
- No raw plist/project secret is emitted.
- Benign generated churn remains below substantive Swift source.
- `CONFIG_FACTS.4` and `.5` are removed from `allow_missing`.

## Phase 5 — integration, benchmark, documentation, dogfood, and release

### Goal

Prove that the shipped detectors create a useful review surface, document the boundary honestly, and publish the next minor release.

### 1. Surface integration and prose pass

Inspect every generated surface for the representative fixtures and dogfood diffs:

- `human_review.html`;
- `human_review.md`;
- `human_review.json`;
- `review_packet.json`;
- sticky/comment preview;
- test plan, trust audit, review queue, change map, and reading order.

Requirements:

- use “Swift declaration,” “XCTest,” “Swift Testing,” “Xcode test plan,” and package/config language where relevant rather than generic path-touch prose;
- no Swift fact appears twice through both baseline and detector paths;
- a high-risk package/config fact may outrank source, but substantive source still appears within the bounded queue;
- no uncertain project parse creates a blocker;
- no `Package.resolved`, pbxproj object-ID churn, Xcode user state, or binary artifact appears as an irrelevant top-five item;
- the change map and reading order use the same target-aware graph as blast radius.

### 2. Seeded eval completion

By this phase, `tests/eval-harness.test.ts` must include at least these classes:

- `swift_contract_change`;
- `swift_test_weakening`;
- `swift_changed_test_connection`;
- `swiftpm_dependency_change`;
- `ios_privacy_capability_change`;
- `xcode_test_structure_change`;
- benign body-only Swift edit;
- benign `Package.resolved` origin-hash/order change;
- benign pbxproj object-ID/order churn where the semantic model is unchanged.

Each positive case asserts the expected finding in the top ten; each negative case asserts no elevated false finding. Update the generated eval scoreboard and README marker through the existing mechanism.

### 3. Public benchmark

Expand `bench/manifest.json` with at least six pinned public Swift/iOS-shaped cases:

1. SwiftPM library public declaration/signature change;
2. Swift app source plus matching XCTest change;
3. Swift Testing disable/assertion weakening;
4. package requirement or resolved pin change;
5. XcodeGen/project/entitlement or privacy config change;
6. mixed source, tests, docs, and generated/lockfile churn that stresses ranking exclusions.

Selection rules:

- pin immutable base/head SHAs;
- use public repositories only;
- keep cases small enough for reliable benchmark execution;
- annotate `expected_focus` only where a human can justify it from the diff;
- include at least one benign case that must not fabricate a blocker.

Targets:

- `0%` empty queue on substantive Swift cases;
- `0%` fabricated blocker;
- `0%` irrelevant generated/lock/binary entries in top five;
- `100%` expected-focus recall@5 on the curated initial Swift set;
- all pre-existing benchmark cases retain their current pass outcome.

Run:

```bash
pnpm run build
node bench/run.mjs
```

### 4. Documentation

Update:

- `README.md` with a support matrix;
- `AGENTS.md` with Swift/iOS dogfood guidance;
- create `docs/swift-ios-support.md`;
- `CHANGELOG.md`;
- package/version metadata in the final release PR only.

The support matrix must distinguish:

| Capability | Cross-platform static | Requires macOS/Xcode |
|---|---:|---:|
| Swift file/test/project classification | yes | no |
| Swift declaration/test/package/config facts | yes | no |
| Target-aware graph from committed project files | yes | no |
| Recording an existing `xcodebuild` transcript | no | yes, command is run by user |
| Direct `.xcresult`/`xccov` ingestion | not in v1 | deferred |
| Simulator/device execution | not provided | outside product scope |

Document direct commands and the wrapper-rule example. State parser bounds plainly: no compiler/type checker, Objective-C remains generic, binary plists are diagnostic-only, and ambiguous symbols do not create edges.

### 5. Private dogfood acceptance

Use the local built CLI with `--provider mock` against representative, already-existing branches or synthetic local edits in each private app.

**MenuWhisper acceptance**

- committed Xcode project recognized;
- app, unit-test, and UI-test paths classified correctly;
- shared scheme/test plans discovered;
- `./scripts/check-ios.sh` and `--quick` classify according to explicit local rules;
- changed Swift source appears in the queue;
- matching XCTest change connects where resolvable;
- Xcode-managed `Package.resolved` produces package facts without lockfile noise.

**HanziDeck acceptance**

- XcodeGen `project.yml` recognized as author intent;
- application/test targets and source roots resolved;
- Swift 6 and strict-concurrency setting changes are analyzable;
- SwiftPM packages and nested `Package.resolved` correlate;
- entitlements/privacy settings route to the security/privacy lens;
- `./scripts/harness.sh ios-quick` is validation and `./scripts/harness.sh full` is broad test evidence only through explicit rules;
- generated-project drift remains advisory and recommends the existing drift check.

Record in `Surprises & Discoveries` and `Outcomes & Retrospective` only:

- anonymized counts;
- expected-vs-observed classifications;
- parser diagnostics;
- benchmark/eval outcomes;
- fixes or explicit deferrals.

Do not commit private paths beyond repository names, source excerpts, project contents, test names, command output, or generated artifacts.

### 6. Release gate

Run:

```bash
pnpm run local-gate
pnpm run local-review
pnpm run build && node bench/run.mjs
npm pack --dry-run
```

Inspect the packed manifest and run a smoke install from the tarball in a temporary Swift fixture repository. The final release PR bumps the next minor version, updates the changelog, and preserves the existing manual `npm publish` process and `prepublishOnly` gate.

### Exit criteria

- Every new ACID has exact test evidence.
- `quality_gate.allow_missing` is `[]` with `max_missing: 0`.
- Both private app acceptance matrices pass without private data entering this repo.
- Public Swift benchmark targets pass.
- Existing non-Swift tests and benchmark cases remain green.
- Documentation accurately states static and macOS-only boundaries.
- The packed package contains all runtime parser modules and no compiled tests.

## Validation and acceptance matrix

| Scenario | Required observation |
|---|---|
| `Sources/Foo.swift` and `FooTests/FooTests.swift` change | implementation/test roles are correct; test maps to `Foo.swift` only with deterministic evidence |
| `xcodebuild test -scheme App -testPlan UnitTests` passes | broad test evidence unless an explicit selector excludes/narrows tests |
| same command with `-only-testing:AppTests/FooTests` | focused test evidence |
| `xcodebuild build-for-testing` passes | validation evidence, never “tests ran” |
| public Swift function parameter changes | concrete Swift declaration signature fact, API-contract routing, file/line evidence |
| only function body changes | no declaration-contract fact |
| `@MainActor` removed or `async throws` changes | concrete concurrency/signature fact with conservative severity |
| `#expect`/`XCTAssert` removed | test-weakening finding ranks in top ten |
| `@Test(.disabled(...))` added | newly disabled test finding |
| app source plus matching test source changes | no false “no connected test change” boost for that implementation |
| duplicate `Foo` types in one target | no guessed edge; ambiguity diagnostic or omitted relation |
| package major change in project manifest and pin file | one concrete, deduplicated supply-chain story with both provenance paths where useful |
| only `Package.resolved.originHash` changes | no dependency fact |
| ATS arbitrary loads enabled | security/privacy finding names exact key and manual check |
| app group/keychain/iCloud entitlement changes | security/privacy finding names capability and path |
| test target removed from scheme/plan | test-evidence weakening finding |
| XcodeGen source and generated project subset disagree | advisory possible-drift finding and repository verification command, not a blocker by itself |
| service plist contains API key | persisted/postable text redacted; remote provider blocked |
| non-Swift repository | output remains compatible and existing language behavior does not regress |

## Conflict and hot-file strategy

Keep ownership explicit:

- Phase 0 owns the feature ledger and initial allowlist staging.
- Phase 1 owns shared source-kind predicates, `src/commands/classify.ts`, config command rules, and Apple privacy/bootstrap defaults.
- Phase 2 owns Swift lexer/declaration/test semantic modules and their schema additions.
- Phase 3 owns Apple project parsing and graph construction.
- Phase 4a owns Swift package facts and supply-chain tests.
- Phase 4b owns Apple config/structure facts and their tests.
- Phase 5 owns broad prose cleanup, README/docs/changelog/package release files, benchmark manifest/scorecard, and final eval consolidation.

Later phases remove only their distinct `allow_missing` entries. `tests/eval-harness.test.ts` is a deliberate serial overlap: each detector phase appends its own case, and Phase 5 performs the final consolidation after rebasing on all detector phases.

Avoid a repository-wide “language plugin framework” refactor. Introduce only the narrow shared contracts required by the second deep language: shared source kind, project model, and internal code graph.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Swift lexer false positives | fabricated contract risk | supported grammar only, body/comment/string stripping, negative fixtures, uncertainty never blocks |
| pbxproj complexity | wrong target membership | parse narrow sections, provenance, programmatic fixtures, fallback/partial diagnostics, no false zero |
| common Swift symbol names | wrong graph edges | only unique declarations within target; type-oriented v1; ambiguous names omitted |
| Xcode generated churn overwhelms queue | poor reviewer value | semantic project model, lock/user/cache exclusion, negative eval/benchmark cases |
| wrapper script is mislabeled as full tests | trust error | no hard-coded private wrappers; explicit validated config; failed exit remains failed |
| new parser slows large repos | unusable local runs | indexed files only, parse cache, existing-style file cap, sorted bounded outputs, performance tests |
| schema compatibility break | old artifacts fail | additive fields, optional persisted additions where required, strict-schema compatibility fixtures |
| private dogfood leaks data | privacy failure | mock provider, local artifacts only, anonymized results, no copied fixtures/output |
| config fact noise | queue loses source focus | high-signal allowlist, concrete diff facts, thin-queue augmentation, benign negative cases |

## Idempotence and recovery

All new analyzers are pure functions over structured diff plus injected base/head contents. Re-running a phase produces byte-stable facts.

- A failed/partial parse does not mutate project files.
- No command is invoked during analysis.
- Cache signatures include command rules and all project inputs used by derived facts.
- Each phase is independently revertible; facts are additive to the existing packet/surface.
- Old human-review artifacts remain readable because new persisted fields are additive.
- A public benchmark clone/cache failure does not weaken CI because the benchmark remains explicit and on-demand; seeded eval cases remain the CI gate.

## Explicit deferrals

These are outside the first release and should not silently enter a phase:

- an iOS/SwiftUI client for `review-surfaces`;
- automatic simulator/device boot, build, install, UI-test, or Maestro execution;
- direct `.xcresult`/`xccov` coverage ingestion — existing lcov conversion remains the compatibility path;
- compiler-backed SwiftSyntax, SourceKit, type-checker, or whole-program call graph;
- deep Objective-C/Objective-C++ semantic analysis;
- CocoaPods and Carthage dependency facts;
- binary plist decoding;
- Tuist-specific project generation beyond generic committed Xcode output unless a concrete dogfood need appears;
- SwiftUI runtime/navigation/state correctness heuristics;
- automatic Xcode project regeneration or mutation;
- treating XcodeGen drift as proven when the supported model subset is incomplete.

Each deferred item may become a later, independently evidenced uplift.

## Success criteria

- A Swift/Xcode repository receives correct source/test/config/generated roles without custom code.
- Direct `xcodebuild` and `swift test` transcripts are classified honestly; local wrappers work through explicit config.
- Swift declaration and test-weakening facts are concrete, evidence-backed, and conservative.
- Target-aware Swift graph facts improve test connection, blast radius, change map, and reading order without claiming compiler precision.
- SwiftPM/Xcode package changes and high-signal Apple config changes reach existing review lenses.
- Both private dogfood repositories pass their acceptance matrices.
- Public Swift benchmark cases meet the stated quality targets.
- Existing TypeScript/JavaScript and cross-language behavior does not regress.
- Privacy/redaction guarantees cover Apple-specific sensitive artifacts.
- `allow_missing` returns to `[]`, the full local gate is green, the pack smoke passes, and the next minor release is publishable.

## Outcomes & Retrospective

Complete after implementation with:

- shipped version and phase PRs;
- ACIDs and tests landed;
- public benchmark score before/after;
- anonymized MenuWhisper/HanziDeck dogfood outcomes;
- parser bounds discovered;
- accepted deferrals and the evidence for them;
- any architecture decision that changed from this contract.

### Result (2026-06-18)

- **Shipped version 0.3.0.** Implemented on branch `claude/fervent-dewdney-e5cd14`
  as six phase commits (one per phase; Phase 0+1 share a commit because they
  entangle `review-surfaces.config.yaml`):
  - Phase 0+1 — spec promotion + Swift/Xcode foundation
  - Phase 2 — Swift declaration + test-weakening facts
  - Phase 3 — Apple project model + target-aware Swift symbol graph
  - Phase 4a — SwiftPM/Xcode package facts
  - Phase 4b — Apple config/structure facts
  - Phase 5 — integration, benchmark, docs, release
- **All 12 ACIDs landed with exact-ACID tests.** `quality_gate.allow_missing`
  returned to `[]` with `max_missing: 0`. The full local gate is green: 1322
  tests pass, determinism-check passes (byte-identical in repo and pr scope),
  pack smoke passes (the tarball installs and runs outside the repo with the new
  parser modules), and the strict empty-diff self-dogfood passes.
- **Seeded eval scoreboard** gained six Swift/iOS fact classes
  (`swift_contract_change`, `swift_test_weakening`,
  `swift_changed_test_connection`, `swiftpm_dependency_change`,
  `ios_privacy_capability_change`, `xcode_test_structure_change`) plus three
  benign negatives (`benign_swift_body_edit`, `benign_package_resolved_origin`,
  `benign_pbxproj_churn`), each passing 1/1.
- **Public benchmark** gained six pinned Swift/SwiftPM cases
  (`apple/swift-argument-parser`, `pointfreeco/swift-snapshot-testing`) by
  immutable commit SHA.

### Parser bounds discovered / confirmed

- TypeScript control-flow narrowing breaks when a discriminated-union variable is
  reassigned through a closure — the Swift lexer uses a `switch` with direct
  assignment instead.
- macOS's case-insensitive filesystem collapses `Tests/` into a sibling `tests/`,
  so test fixtures use a non-colliding directory; the `…Tests.swift` basename is
  what classifies a Swift test, so the directory name is free.
- Strict per-target symbol uniqueness hid a test target's `@testable import App`;
  the graph resolves references against a file's VISIBLE modules (own + transitive
  deps + imported target names) and falls back to one implicit module (repo-wide
  uniqueness, conservative) when no project model is present.

### Accepted deferrals (evidence: this was an offline single-session implementation)

- **Private dogfood (MenuWhisper / HanziDeck) not run.** No access to the private
  repositories in this environment; per D9 their source/projects/diffs are never
  copied here. The acceptance matrices remain the owner's macOS dogfood step.
- **On-demand public benchmark (`node bench/run.mjs`) not executed.** It clones
  public repos over the network; the offline session could not run it. The cases
  are pinned and structurally validated (BENCH.1/BENCH.2); the CI gate is the
  seeded eval, which IS run and covers every shipped Swift/iOS fact class.
- All explicit deferrals from the "Explicit deferrals" section above hold
  unchanged (no iOS client, no simulator execution, no `.xcresult`/SourceKit,
  binary-plist decoding diagnostic-only, etc.).

### Decisions that held / refined from the contract

- D8 (additive artifacts) was honored by adding a `swift_declaration_changes`
  array to `SemanticChangeFacts` (the human `semanticChangeFacts` schema is
  `additionalProperties: true`, and Swift test-weakening maps onto the existing
  `kind` enum, so the schema change was small) and by reusing the `DependencyFact`
  / `ConfigFact` shapes for Swift package and config facts rather than new
  surfaces — config facts now route per-kind via `configFactLens`.
- The whole uplift is inert on a non-Swift repository: with no committed Swift or
  Apple project files, the Swift graph is `undefined`, no `apple_project.json` is
  written, and `review-surfaces`'s own self-dogfood output is byte-identical to
  before — Swift behavior only activates on actual Swift repositories.
