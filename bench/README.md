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

It writes [`SCORECARD.md`](./SCORECARD.md) and exits non-zero if a case errors or hits
a core failure mode: empty substantive queue, fabricated blocker, or a curated
usefulness/actionability/density gate.

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
| **curated finding precision** | share of human-judged queue findings that are actionable rather than mechanical | high |
| **curated comment precision** | share of human-judged suggested comments a reviewer would actually post | high |
| **curated actionable recall** | required actionable findings/comments that remain present | **100%** |
| **first concrete action line** | Markdown line where the first reviewer action appears | within the case budget (about 30) |
| **primary surface lines** | lines before reading-order/map support machinery begins | within the case budget (about 100) |
| **duplicate decision roots** | repeated manifestations of one root cause in the decision projection | **0** |
| **reviewer-value rating** | explicit 1–5 human judgment: “did this reduce reconstruction work?” | **≥4/5** |

Most metrics are **objective** and need no annotation. `expected_focus` is optional and
only adds the recall metric for cases that carry it — so the set scales to many diffs with
light curation, while a hand-annotated subset still measures "did it surface the right
file".

## Adding cases

Append to `manifest.json` — `id`, `lang`, `repo` (git URL), `base`/`head` SHAs, optionally
`expected_focus` (source paths a reviewer should land on), `expect_no_blockers` (default
true), `substantive` (default true), and an optional `usefulness` block containing curated
finding/comment judgments, density budgets, duplicate-root limits, and a manual reviewer
rating. Unjudged findings remain unscored rather than being guessed actionable or false.
Pick commits that change real source alongside tests
/ docs / lockfiles so the floor's exclusion and ranking are exercised. The seed set is 6
cases (across TS / JS / Go / Python / Rust / Java / Kotlin / Ruby, leaning on
exclusion-stress diffs); the intended target is **20–30**.

## Current findings (23-case run)

The exclusion side is clean and the floor holds on every language: **0% empty-queue,
0% false-blocker, 0% irrelevant-in-top-5** (docs, `go.sum`/`Cargo.lock`/`uv.lock`,
CI workflows, `package.json`/`pom.xml`/`Cargo.toml` config all correctly kept out of the
top 5), **98% focus recall@5**, **top-is-code on 20/23**, **100% curated
finding/comment precision and recall**, and a **4/5 reviewer-value rating**. The final
case is this repository's curated `2076964..171b414` usefulness regression; it measures
decision precision and attention budgets rather than adding another language.

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

The benchmark drove a real floor fix (the `express-send` augmentation) — exactly its
purpose: surface gaps on real diffs, then confirm the fix closes them.
