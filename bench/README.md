# Real-world effectiveness benchmark (`BENCH.1` + `BENCH.2`)

The local gate (`scripts/local-gate.sh`) is a fast, seeded, empty-diff self-dogfood: it
proves byte-stable determinism and schema validity but is **blind to whether a surface
produces *sensible* output**. This benchmark is the complementary, on-demand check — it
runs the **full `all` pipeline** (mock provider) over **pinned real PR-shaped diffs across
languages** and scores the review surface against the failure modes the tool exists to
avoid. It is deliberately **not** part of CI (it needs network to clone), and it does not
gate the build; run it when you change ranking, the cold-start floor, or classification:

```bash
pnpm run build && node bench/run.mjs
```

It writes [`SCORECARD.md`](./SCORECARD.md) and exits non-zero if any case hit a core
failure mode (empty queue on a substantive diff, or a fabricated blocker).

## What it measures

Each case in [`manifest.json`](./manifest.json) pins a public repo + base/head commit
SHAs (deterministic given the SHAs). `bench/run.mjs` clones just those two commits into a
gitignored `bench/.cache/`, runs `all --provider mock --base <base> --head <head>`, and
reads `human_review.json`.

| Metric | Meaning | Target |
|---|---|---|
| **empty-queue rate** | substantive code diffs that produced **0** review-first items | **0%** |
| **false-blocker rate** | spec-less runs that **fabricated** a blocker | **0%** |
| **top item is code/impl** | the #1 review-focus item is a source file (not a doc/lock/test) | high |
| **irrelevant in top-5** | a doc / generated / lockfile / binary leaked into the top 5 | **0%** |
| **focus recall@5** | of the annotated `expected_focus` paths, the share that appear in the top 5 | high |

Most metrics are **objective** and need no annotation. `expected_focus` is optional and
only adds the recall metric for cases that carry it — so the set scales to many diffs with
light curation, while a hand-annotated subset still measures "did it surface the right
file".

## Adding cases

Append to `manifest.json` — `id`, `lang`, `repo` (git URL), `base`/`head` SHAs, optionally
`expected_focus` (source paths a reviewer should land on), `expect_no_blockers` (default
true), `substantive` (default true). Pick commits that change real source alongside tests
/ docs / lockfiles so the floor's exclusion and ranking are exercised. The set is **32
cases** across TS / JS / Go / Python / Rust / Java / Kotlin / Ruby / Swift, leaning on
exclusion-stress diffs; the intended target is **20–30** and is met.

## Swift / SwiftPM / iOS coverage (`BENCH.2`)

The `lang: "swift"` cases (ten) are pinned public Swift/SwiftPM/iOS diffs spanning the
six shapes `BENCH.2` requires, so the cold-start floor, Apple config/dependency facts, and
generated/lock/binary exclusion are all exercised on real Apple-shaped diffs:

| case | shape | what it stresses |
|---|---|---|
| `swift-argument-parser-name-conformance` | SwiftPM public-declaration change **+** source with matching XCTest | public conformance in `NameSpecification.swift`; the docc article (`.md`) and `NameSpecificationTests.swift` stay out of the top-5 |
| `swift-argument-parser-invalid-cast` | single-file Swift source change | the floor still queues a 1-file impl change |
| `swift-argument-parser-flag-diagnostic` | single-file Swift source change | `@Flag` diagnostic edit in `Flag.swift` (source-only range, verified) |
| `swift-snapshot-record-api` | SwiftPM public-declaration/deprecation change | new public API in `AssertSnapshot.swift` + deprecation shims in `Deprecations.swift` |
| `swift-snapshot-assert-source` | **mixed** source+tests+docs+generated-churn | 8 source files + a Swift Testing test + a docc migration article + **five binary `.png` snapshots and a `.txt` snapshot** — source ranks, the doc and the generated/binary snapshots are excluded |
| `swift-snapshot-swift-testing-attachments` | Swift Testing integration change | single-file change to the Swift Testing surface (distinct from the weakening case) |
| `swift-snapshot-swift-testing-weakening` | **Swift Testing weakening** | a `@Test` removed from a Swift Testing `@Suite` (TestScoping refactor) — the test-weakening detector flags `removed_test_method` and **leads the queue with the weakened test**; the `ci.yml` and package manifests stay out of the top-5 |
| `swift-snapshot-testing-package-pin` | **package requirement/pin change** | swift-syntax bump in `Package.swift`/`Package@swift-5.9.swift` + the `Package.resolved` lock — the requirement leads and the resolved pin is surfaced as a dep fact; `Package.resolved` is a lock (`allow_top_roles` opts this subject-is-the-pin case out of the irrelevant check), never a fabricated blocker |
| `alamofire-privacy-manifest` | **entitlement/privacy-manifest config change** | new `PrivacyInfo.xcprivacy` (+ `.pbxproj` ref + `Package.swift` resource) surfaced as Apple privacy/config facts; all-config diff, not a fabricated blocker |
| `swift-snapshot-testing-image-precision` | mixed source + **three regenerated binary `.png` snapshots** (exclusion-stress, unannotated) | 14 `Snapshotting/*.swift` files; the three binaries never leak into the top-5 |

On these ten cases `node bench/run.mjs` holds the full `BENCH.2` bar: **0 empty queues,
0 fabricated blockers, 0 irrelevant generated/lock/binary entries in the top-5, and 100%
expected-focus recall** on the nine annotated cases (the image-precision case is left
unannotated on purpose — it only stresses binary exclusion). Two cases legitimately lead
with a non-`code` top item that IS their reviewed subject — `alamofire-privacy-manifest`
leads with the privacy manifest (role `other`) and `swift-snapshot-swift-testing-weakening`
leads with the weakened test (role `test`) — which is correct for those shapes, not a
top-is-code miss.

## Current findings (32-case run)

The exclusion side is clean and the floor holds on every language including Swift: **0%
empty-queue, 0% false-blocker, 0% irrelevant-in-top-5** — incidental churn (docs,
`go.sum`/`Cargo.lock`/`uv.lock`/`Package.resolved`, and binary `.png` snapshots) is
correctly kept out of the top 5 — **100% focus recall@5**, **top-is-code on 27/32**. CI
workflow changes are NOT excluded — a `.github/workflows/*` edit is hand-written,
security-relevant supply-chain config that the tool deliberately SURFACES (e.g.
`gin-debug` ranks `.github/workflows/gin.yml` at #2). The runner classifies it as a
distinct `ci` role so it is tracked (never silently counted as `code`) but, unlike a
lock/generated/binary, it is not an exclusion failure. Three Swift cases
intentionally LEAD with a non-`code` top item because that item IS the reviewed subject
(privacy manifest, removed test, dependency pin), and the scorecard reflects that:
`alamofire-privacy-manifest` surfaces `Source/PrivacyInfo.xcprivacy` as the top item (a
privacy-manifest review, role `other`, not a miss), `swift-snapshot-swift-testing-weakening`
leads with the weakened `SwiftTestingTests.swift` (role `test`), and
`swift-snapshot-testing-package-pin` leads with `Package.swift` and also
surfaces the `Package.resolved` resolved-pin fact (`Package.resolved` is now classified as
a SwiftPM lock; the pin case opts that role out of the irrelevant check via
`allow_top_roles`, every other case keeps strict lock exclusion).

- **`express-send`: a dependency change used to hide the source change — now FIXED.** The
  diff bumps `content-disposition` in `package.json` *and* edits `lib/response.js`. The
  dependency detector queues the bump, so the queue was non-empty — and the cold-start
  floor originally fired only when the queue was **empty**, so `lib/response.js` was never
  ranked (recall 0%). The benchmark caught this; the floor now **augments** a thin
  detector-only queue with review-focus items for uncovered impl source (`HUMAN_REVIEW.28`),
  so `lib/response.js` is surfaced (recall **100%**). The dep finding still leads the queue
  (a major bump is worth flagging first), which is why the #1 item is `package.json` — so
  this case is correct, not a top-is-code miss to chase.
- **`gson-jsonreader`: the test outranks its source.** `JsonReaderTest.java` (+14 lines)
  outranks `JsonReader.java` (a 2-line change) on churn. The source is still in the top 5
  (recall 100%), and a large new test block is legitimately worth reading, so this is a
  ranking **observation**, not a regression — a candidate for a future "prefer the
  implementation over its own test at comparable evidence" tie-break, tracked not chased.
- **`alamofire-privacy-manifest`: the top item is the privacy manifest, not code.** A
  privacy-manifest/config-only diff has no impl source, so the `PrivacyInfo.xcprivacy`
  facts legitimately lead (role `other`). This is the third non-code-top case and is
  correct behavior for the config shape, not a ranking gap.

The benchmark drove a real floor fix (the `express-send` augmentation) — exactly its
purpose: surface gaps on real diffs, then confirm the fix closes them.
