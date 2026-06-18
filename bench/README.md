# Real-world effectiveness benchmark (`BENCH.1`)

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
| **irrelevant in top-5** | a doc/generated/binary file leaked into the top 5 | **0%** |
| **focus recall@5** | of the annotated `expected_focus` paths, the share that appear in the top 5 | high |

Most metrics are **objective** and need no annotation. `expected_focus` is optional and
only adds the recall metric for cases that carry it — so the set scales to many diffs with
light curation, while a hand-annotated subset still measures "did it surface the right
file".

## Adding cases

Append to `manifest.json` — `id`, `lang`, `repo` (git URL), `base`/`head` SHAs, optionally
`expected_focus` (source paths a reviewer should land on), `expect_no_blockers` (default
true), `substantive` (default true). Pick commits that change real source alongside tests
/ docs / lockfiles so the floor's exclusion and ranking are exercised. The seed set is 6
cases (one per TS / Go / Python ×2 / Rust / Java); the intended target is **20–30**.

## Current findings (seed run)

The cold-start floor holds on every seeded language: **0% empty-queue, 0% false-blocker,
0% irrelevant-in-top-5, 100% focus recall@5**, top-is-code on 5/6.

- **`gson-jsonreader` ranks the test above the source.** `JsonReaderTest.java` (+14 lines)
  outranks `JsonReader.java` (a 2-line change) on churn. The source is still in the top 5
  (recall 100%), and a large new test block is legitimately worth reading, so this is a
  noted **ranking observation**, not a regression — a candidate for a future "prefer the
  implementation over its own test at comparable evidence" tie-break, tracked rather than
  chased here.
