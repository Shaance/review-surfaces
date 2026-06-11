# Visual & Reviewer-Value Brainstorm — June 2026 (post next-value uplift)

Status: ideas selected (2026-06-11). Ideas **1–9 and 13** are in scope; the P3
carryovers (10–12) are explicitly out of scope. Nothing here is committed work
until promoted into `features/review-surfaces.feature.yaml` as Acai requirements.
Execution contract: `VISUAL_VALUE_UPLIFT_GOAL.md`, following the same
Phase-0-promotes-ACIDs pattern as `NEXT_VALUE_UPLIFT_GOAL.md`.

Each idea carries an **Approach** block: the recommended direction, the modules to
build on, and the pitfalls to avoid. Implementers own the details; the approach is
the contract for *how* the idea fits the existing architecture.

## Where we are

The next-value uplift (Phases 0–6, PRs #53–#62) is fully shipped: the PR surface
(sticky comment + artifact + since-last-review delta), queue ranking v2 with
`ranking_reasons`, coverage-delta evidence, time-budgeted mode, the seeded-regression
eval harness, fear-class facts (dependency, blast-radius, config/infra), the
single-file HTML cockpit, and team policy + provider intent synthesis. The quality
gate is strict again (`max_missing: 0`, `allow_missing: []`).

The honest gap: **every surface is prose and tables.** The only diagram wired
into a PR comment surface — the change-impact mermaid
(`src/diagrams/pr-change-diagram.ts` → `src/render/pr-comment.ts`) — is a
requirements hairball: changed files fan out into review areas, spec ACIDs, risk
candidates, and per-layer "… N more" overflow nodes. And it rarely renders in
practice: it lives only on the provider-narrative comment path, which is blocked
under `--provider mock` and skipped in favor of the diagram-less
`renderHumanPrComment` whenever a current `human_review.json` exists. It is
evidence-anchored but answers a question no reviewer asks — and almost no
reviewer ever sees it. Meanwhile the HTML cockpit (`src/human/render-html.ts`) contains
zero visual elements — no SVG, no graph, no per-line coverage color — and the data
for genuinely useful pictures is *already computed and schema-validated*:

- the reverse import graph and per-export blast radius (`src/collector/import-graph.ts`,
  `BLAST_RADIUS.*`),
- per-hunk coverage classification (`COVERAGE.*`, `CoverageEvidence` in
  `src/human/contract.ts`),
- per-item ranking evidence (`RANKING.*`, `ranking_reasons`),
- round-over-round deltas (`src/dogfood/compare.ts`, `PR_SURFACE.*`),
- dependency and config fact classes (`DEP_FACTS.*`, `CONFIG_FACTS.*`).

The next wave of value is turning facts the tool already knows into the *pictures
a reviewer builds in their head anyway* — and keeping the trust posture: every
node, edge, and color must trace to a deterministic fact. A diagram here is
evidence with a layout, never an illustration.

## The reviewer's questions (the lens for scoring)

Put a human in front of a 30-file agent-written PR. In order, they ask:

1. **What is this change, as a picture?** Which part of the system, what's the
   risky center vs. the mechanical periphery. *(Today: prose summary. Missing: the map.)*
2. **Where do I start reading?** GitHub orders files alphabetically; the queue
   orders by risk — neither is comprehension order. *(Missing: a dependency-ordered tour.)*
3. **What does this break that isn't in the diff?** *(Today: "used by 14 files (top: …)"
   as text. A picture shows the cone instantly.)*
4. **Are the changed lines actually tested?** *(Today: per-hunk counts in evidence
   cards. Missing: seeing which lines, on the excerpt itself.)*
5. **Did the architecture change shape?** New edges between modules that never
   depended on each other — what senior reviewers catch and tools don't. *(Missing entirely.)*
6. **Round 4 of the agent loop: is this converging?** *(Today: one-round delta.
   Missing: the trend.)*
7. **Why should I trust this tool's cut?** *(Today: `eval_scoreboard.json` exists
   but is buried in `.review-surfaces/`.)*

## Scoring

- **Value**: how much it changes a real reviewer's decision quality or time-to-decision.
- **Effort**: S (≤1 phase-sized PR), M (1–2 PRs), L (multi-phase).
- **Leverage**: how much it reuses what already exists (high leverage = mostly a
  renderer or a small fact source plugged into existing surfaces).

## Prioritized ideas

| # | Idea | Value | Effort | Leverage | Priority |
|---|------|-------|--------|----------|----------|
| 1 | Change-impact map v2: the reviewer-shaped picture (replaces the hairball) | Very high | M | High | **P0** |
| 2 | Guided diff tour: dependency-ordered reading plan | Very high | S–M | High | **P0** |
| 3 | Cockpit visual layer: inline SVG change map + click-to-filter | High | M | High | **P0** |
| 13 | Local review loop: scripted, Actions-free artifact production + merge gate | High | S | High | **P0** |
| 4 | Line-level coverage gutters on hunk excerpts | High | S–M | High | **P1** |
| 5 | Architecture-drift facts: new module-boundary edges | High | S–M | High | **P1** |
| 6 | At-a-glance header strip (lens chips, budget bar, review progress) | Med–High | S | High | **P1** |
| 7 | Review-round convergence trend across pushes | Med–High | S–M | Med | **P2** |
| 8 | Dependency-change tree in the supply-chain lens | Med | S–M | High | **P2** |
| 9 | Eval scoreboard surfacing (README + cockpit footer) | Med (strategic) | S | High | **P2** |
| 10 | Hunk rendering upgrades: syntax highlight, word-level diff | Med | M–L | Med | **P3** |
| 11 | SARIF completion → code-scanning annotations (carryover) | Low–Med | S | High | **P3** |
| 12 | VS Code queue panel (carryover) | Med | L | Low | **P3** |

---

## P0 — give the reviewer the picture

### 1. Change-impact map v2 — the picture a reviewer builds by hand
Replace the requirements hairball with the diagram reviewers actually need: changed
files as nodes, clustered by subsystem, import edges between them, and a dashed
"blast halo" of the top unchanged importers that depend on what changed. Node labels
carry churn (`+120/−15`); node styling carries the dominant risk lens (security,
supply-chain, contract). One look answers: what moved, what it touches, where the
risky center is.

- Why now: this is the single highest-leverage visual. All inputs exist — the
  import graph, blast-radius facts, lens assignments, per-file churn. The embed
  technique is proven too: `src/render/pr-comment.ts` already ships a
  `<details>`-wrapped ```` ```mermaid ```` block GitHub renders natively, with the
  fence-close and blank-line-after-`<summary>` bugs solved — but that embed lives
  on the provider-narrative path mock/default runs never take, so the map must
  target the comment renderers reviewers actually see (Approach step 3).
- Why mermaid first (not SVG): GitHub renders mermaid in comments for free — zero
  new render technology, and the map lands where reviewers already are. (In local
  `human_review.md` the mermaid block only renders in editor previews; the
  cockpit SVG of idea 3 is the local answer.)
- Effort: M (the graph model + a focused mermaid emitter; the old diagram retires).

**Approach.** Ship this as two pieces: a shared, schema-validated **change-graph
model**, then a mermaid emitter over it.

1. New `change_graph` section on the packet/human-review model (`src/human/contract.ts`
   + `schemas/human_review.schema.json`, strict): `nodes` (changed files: path,
   churn added/removed, dominant lens, status A/M/D/R), `halo_nodes` (unchanged
   importers from blast-radius facts — first K ≤ 2 per high-blast node,
   alphabetical exactly as the fact's bounded `used_by.top` list stores them), `edges`
   (importer → imported among those nodes, with a `kind: existing | new | removed`
   slot idea 5 fills later), `clusters` (top-level dir under `src/`, plus `tests/`,
   `schemas/`, config). Everything sorted; built from `buildImportGraph()` output
   restricted to changed files — no new parsing.
2. New `src/diagrams/change-map.ts` emitting `flowchart LR` with mermaid `subgraph`
   per cluster and `classDef` per lens. Hard caps, honestly rendered: ≤ ~25 changed
   nodes and ≤ ~10 halo nodes; overflow becomes one explicit `"+ N more files"`
   node per cluster — never silent truncation (same stance as the import graph's
   `truncated` flag).
3. Embed it where reviewers actually look — which is **not** today's embed point.
   The current "Change impact" block renders only on the provider-narrative path
   in `renderPrComment`: blocked under `--provider mock`, and skipped in favor of
   the diagram-less `renderHumanPrComment` whenever a current `human_review.json`
   exists. The map therefore goes into `renderHumanPrComment`, the sticky summary
   (`src/render/sticky-summary.ts`, as a collapsed `<details>` block so the
   sticky stays short), and a new embed in `human_review.md`, which today
   contains no diagram at all. The old narrative-path embed retires with the
   hairball; the spec/requirement-mapping diagram (`pr-change-impact.mmd`) keeps
   being written as a standalone agent-facing artifact but leaves the human
   surfaces — one diagram answers one question.
4. Two distinct safety layers, both existing patterns: escape labels with the
   `diagramLabel`-style sanitizer (`src/diagrams/diagrams.ts`; unify the private
   copy in `pr-change-diagram.ts` rather than adding a third), and keep the
   body-level fence-close guard at the embed point (the whole diagram is omitted
   if any line could close the ```` ```mermaid ```` fence, per
   `src/render/comment.ts`). Run redaction before render, and extend
   `scripts/determinism-check.sh` with a PR-scope run — today it exercises only
   repo-scope `all`, so the comment-embedded map would otherwise go unchecked.

Pitfall: resist re-adding spec anchors to this diagram — requirements-per-file is
exactly what made v1 unreadable. Trust is carried by the underlying facts (every
edge cites the import graph; every halo node cites a blast-radius fact), not by
drawing more nodes.

### 2. Guided diff tour — comprehension order, not risk order
A numbered reading plan over the changed files: dependencies before dependents
(contracts/schemas → core impl → adapters/renderers → tests → config/docs), grouped
into legs, each step with one line of *why this position* ("defines the type 4
later files implement") and links to its queue items. The queue says *what needs
scrutiny*; the tour says *in what order understanding builds*. They are different
axes and should cross-link, not merge.

- Why: on a 30-file diff the first ten minutes are usually spent reconstructing
  this order by hand. We already have the import graph among changed files — the
  topological sort is nearly free. Note `review_routes.md` does NOT cover this: it
  orders *artifacts* (read verdict, then queue, then trust audit), not the diff.
- Effort: S–M. Deterministic, no provider work, pure model + render.

**Approach.**
1. Restrict the import graph to changed files, topologically sort with
   dependencies first. Cycles are real in TS codebases: collapse strongly connected
   components into one leg ("these 3 files form an import cycle — read together"),
   alphabetical inside, so the output is total and deterministic.
2. New `reading_order` section on the model (strict schema grows): legs, each with
   ordered steps `{path, why, queue_refs[]}`. The `why` line is derived, not
   freeform: "imported by N changed files", "test for step 3", "config — read last".
3. Render in `human_review.md` and the cockpit as the second section after the
   verdict; the sticky comment gets only the first leg (it must stay short —
   reuse the rollup discipline from `src/human/rollup.ts`).
4. Tie into idea 1: the map's left-to-right flow and the tour's numbering should
   agree — same underlying order, one as a picture, one as a checklist.

Pitfall: don't let the tour fight the queue. A blocker still leads the cockpit;
the tour is for the comprehension pass after the verdict is absorbed. And never
include unchanged files in the tour (halo files belong to the map, not the
reading plan).

### 3. Cockpit visual layer — the map, inline, clickable
Render the same `change_graph` as deterministic inline SVG in the HTML cockpit:
clusters as columns, nodes as rounded rects with churn and lens color, edges as
orthogonal paths, new/removed edges (idea 5) in red/grey. Clicking a node filters
the queue to that file — reusing the existing lens-filter mechanism.

- Why: the cockpit's whole pitch is "navigable for a 30-file diff"; a clickable
  map is the navigation. Markdown surfaces get mermaid (GitHub renders it); the
  cockpit cannot (no CDN, no framework), so it gets SVG.
- Effort: M. Pure renderer over the idea-1 model — zero analysis changes.

**Approach.**
1. Hand-rolled layout, not a library and **not an inlined mermaid.js** (~2 MB,
   nondeterministic layout, violates the no-framework rule and bloats a file meant
   to be attached in Slack). For a capped review-sized graph (≤ ~35 nodes) a
   layered layout is simple: column = cluster (ordered by the tour's leg order),
   row = stable sort within column, edges routed as cubic curves. Fixed `viewBox`,
   system font stack, every coordinate derived from sorted input → byte-identical
   output for identical models.
2. Escape every interpolated label through the `esc()` (redact-then-escape)
   helper — module-private in `src/human/render-html.ts` today, so export it or
   lift it to a shared module first; re-run redaction on render like the markdown
   renderers do.
3. Interactivity stays at the existing altitude (vanilla JS, localStorage):
   node click toggles a per-file queue filter (same `data-` attribute pattern as
   the lens filters); hover shows churn + blast count via `<title>` elements —
   which also makes the map degrade gracefully when printed.
4. Keep `render-html.ts` readable: the SVG emitter lives in its own module
   (`src/human/render-svg-map.ts`) consumed by the HTML renderer, mirroring how
   the markdown renderer composes sections.

Pitfall: do not invent a second graph model for SVG convenience. If the SVG needs
data the model lacks, the model and strict schema grow first — the established
rule that keeps JSON/MD/HTML from diverging.

### 13. Local review loop — everything CI produces, scripted, with zero Actions
*(Added at selection time, 2026-06-11.)* One scripted entry point that produces
every review surface locally — pipeline, sticky-comment preview, diagrams, HTML
cockpit, schema validation — plus a CI-equivalent gate script. Two audiences:
users without GitHub Actions minutes (real constraint: this repo's own Actions
are currently billing-blocked), and our own per-phase dogfood loop, which must
not depend on CI to see what a phase shipped.

- Why P0 and why first: every later phase's dogfood step consumes this. It also
  codifies the merge gate we already use in practice when Actions are unavailable
  (full local CI equivalent + clean review verdict) instead of leaving it as
  tribal knowledge.
- Effort: S. The CLI already does all the work (`all`, `comment --format sticky`,
  `human --format html`, `validate`, `dogfood`); this is orchestration + docs.

**Approach.**
1. `scripts/local-review.sh` (exposed as `pnpm run local-review`): build, run
   `all --provider mock` against `<base>..<head>` (default `origin/main..HEAD`),
   render the sticky-comment preview to a local file via `comment --format sticky`,
   render `human --format html`, run `validate --surface all`, then print a short
   index of the artifacts to open (`human_review.md`, `human_review.html`, the
   sticky preview, the diagrams). Network use: git only — the mock provider is
   the default for exactly this reason.
2. `scripts/local-gate.sh` (exposed as `pnpm run local-gate`): the merge gate as
   one command — `lint`, `typecheck`, full `test`, `determinism-check`, and the
   strict empty-diff self-dogfood (`all --base HEAD --head HEAD --strict`), which
   is the documented red-main footgun when a phase drops allowlist entries.
3. Support the round-trip the trend (idea 7) needs locally: `local-review`
   accepts `--previous <dir>` (or auto-uses the last run's packet) so
   `since-last-review` and the rounds ledger work from local prior packets — the
   CI artifact is one transport for prior rounds, a local directory is another,
   and the comparison engine (`src/dogfood/compare.ts`) doesn't care which.
4. Document both scripts in `README.md` and `AGENTS.md` as *the* way to produce
   and gate review surfaces without CI; the per-phase loop in the goal contract
   references them by name.

Pitfall: don't fork logic into bash. The scripts call the same CLI commands a
user types by hand — orchestration only, no flags or behavior that exist solely
in the script, or local and CI surfaces drift apart.

---

## P1 — visual evidence where the reviewer's eyes already are

### 4. Line-level coverage gutters on hunk excerpts
The cockpit's hunk excerpts gain a per-line gutter: covered (green), uncovered
(red), no-data (neutral). The markdown surfaces gain an honest one-liner per
excerpt ("4 of 12 changed lines uncovered: L120–L124"). Today the reviewer gets
per-hunk *counts* in evidence cards, far from the code; the question "is THIS
branch tested?" is answered at the excerpt or not at all.

- Effort: S–M. The lcov ingestion (`src/tests-evidence/lcov.ts`) already holds
  per-file instrumented/covered line sets internally; only the model exposure and
  render are new.

**Approach.**
1. Grow `CoverageEvidenceHunk` (`src/human/contract.ts`) with
   `uncovered_lines: number[]` (sorted, capped with an explicit `truncated` flag
   for pathological hunks); strict schema first.
2. HTML: gutter glyph + background tint per excerpt line, keyed by line number
   from the existing `line_start`/`hunk_header` fields. Print-safe (the tint must
   survive grayscale: pair color with a glyph).
3. Markdown: no per-line markup games — one summary line under the excerpt with
   the uncovered ranges. GitHub comments stay compact.
4. Honest-negative rules carry over verbatim: *no report* renders as "no coverage
   evidence" (never as red), and a stale report (provenance already recorded at
   ingestion) renders with its staleness note.

Pitfall: deleted lines have no coverage semantics — gutter only the added/context
lines on the new side, or the display will imply tested-ness for code that no
longer exists.

### 5. Architecture-drift facts — new module-boundary edges
A new deterministic fact class: this PR introduces an import edge between modules
that never depended on each other (`src/render → src/collector`), removes one, or
creates an import cycle. Rendered as a queue item ("new dependency edge:
render → collector — no prior edge existed between these modules") and drawn in
red on the map (ideas 1/3). This is the "senior reviewer catches it, tools don't"
class: layering violations by agents look locally reasonable in every single hunk.

- Effort: S–M. Head-side graph exists; the base side is bounded — only changed
  files can change edges.

**Approach.**
1. For each changed/deleted file, parse its *base* content (`readFileAtRef` in
   `src/collector/git.ts`) with the same import extraction the graph already uses;
   diff the resolved import sets per file. Aggregate to module altitude (top-level
   dir under `src/`): a new file-level edge is noise; a new *module-boundary* edge
   is signal. Emit `module_edge_added` / `module_edge_removed` / `import_cycle_created`
   facts following the `src/risks/semantic-diff.ts` detector shape.
2. Route into existing plumbing: a queue item via the risk register, an
   `architecture` lens tag, and `kind: new | removed` on the idea-1 `change_graph`
   edges so both renderers pick it up with zero extra work.
3. Respect rename detection from the diff status: a moved file re-creating its old
   edges from a new path is not drift. Resolver bounds (no tsconfig path aliases
   in v1) are documented exactly like the import graph's existing bounds — and a
   skipped-alias edge must count as "unknown", never as "removed".
4. Extend the eval harness (`EVAL_HARNESS.*`) with one seeded fixture: a benign
   change plus a new cross-module import, asserted to rank in the top N — the
   established discipline for every new fact class.

### 6. At-a-glance header strip
The cockpit's first screen becomes a dashboard-grade strip rendered purely from
existing model fields: verdict badge (exists), lens chips with counts (security 2,
supply-chain 1…) that activate the existing filters, the budget cut as a stacked
read/skim/defer bar with minutes, trust counts (✓ verified / ~ claimed / missing),
and a review-progress bar fed by the checkbox state already persisted in
localStorage.

- Effort: S. Zero new data; CSS + small JS over fields the model already carries
  (verdict, queue lens tags, `review_plan`, trust audit counts).

**Approach.** Pure render work in `render-html.ts`: chips reuse the lens-filter
toggles (a chip *is* the filter button, with a count); the budget bar is a CSS
flex strip with widths proportional to estimated minutes; progress recomputes on
checkbox change from the existing `data-queue-check` hooks. Printable: chips and
bars must carry text labels, not color alone. No charts library, no canvas.

---

## P2 — convergence, depth, and the trust story

### 7. Review-round convergence trend
For agent-written PRs the question by round 4 is "is this converging or churning?"
Extend the PR surface's prior-packet mechanism into a compact per-round ledger:
round, head SHA, new / resolved / regressed counts, verdict. Sticky comment and
cockpit render it as a small table — the shape (12 → 5 → 2 → 0) is the visual;
no chart needed.

- Effort: S–M. `src/dogfood/compare.ts` computes one-round deltas with stable
  finding keys; the artifact recovery shipped with `PR_SURFACE.*`.

**Approach.** Append a `rounds[]` ledger to the uploaded artifact: each CI run
carries forward the prior ledger plus one row for itself (counts come from the
existing compare output; identity stays on stable finding keys, never array
positions). Artifact expiry means partial history is *normal*: render "history
begins at round 3", never an error — same stance as "no prior artifact = first
review". Cap the rendered table at the last ~8 rounds, full ledger stays in the
artifact.

### 8. Dependency-change tree in the supply-chain lens
When a dependency change pulls transitive additions, render the chain as an
indented tree (or a small mermaid graph on GitHub surfaces): direct dep → new
transitives, install-script flags marked. Today the facts are flat lines; the tree
shows *why* one `package.json` line brought twelve packages.

- Effort: S–M, honestly scoped: `DependencyFact` is flat today —
  `transitive_added` facts carry no attribution to the direct dependency that
  pulled them (`src/risks/dependency-facts.ts` never reads the lockfile's
  dependency edges). The *tree* therefore needs one new piece of deterministic
  fact data: parse lockfile dependency edges to attribute each new transitive to
  its direct parent. The render itself is then a grouping pass. Lockfiles whose
  edges can't be resolved fall back to the honest flat output (direct-deps
  section + unattributed new-transitives list). Worth doing bundled with other
  render work, not as its own phase. Registry metadata stays deferred behind the
  provider boundary, exactly as before.

### 9. Eval scoreboard surfacing
`eval_scoreboard.json` (cases passed / total per fact class, regenerated by the
eval harness inside `pnpm run test`) is the proof behind the trust-layer claim,
and it's invisible. Surface it twice: a generated README table ("catches N/N
seeded regression classes in the top 10", regenerated from the scoreboard by a
small script) and one cockpit footer line citing the score and harness version.

- Effort: S. A small script + render line. Strategic value: it's the adoption
  argument, and it keeps the harness honest — a class that loses its seed shows
  up in the README diff.

**Approach.** Generate the README section from the scoreboard in a marker-delimited
block (like the sticky comment's marker-based upsert) so regeneration is
idempotent and diffs are reviewable. Never hand-edit inside the markers; the
local gate (idea 13) asserts the block is current.

---

## P3 — opportunistic (out of scope for the next goal contract)

### 10. Hunk rendering upgrades
Syntax highlighting and intra-line word diffs in the cockpit excerpts. Real polish
value, but the honest options are a vendored highlighter (dependency weight,
determinism risk) or a hand-rolled tokenizer (maintenance). Wait until the visual
layer (ideas 3/4/6) proves the cockpit is the surface reviewers actually live in.

### 11. SARIF completion (carryover)
Unchanged from the previous brainstorm: `src/render/sarif.ts` → native code-scanning
annotations, wired as an optional upload in the Action. Stable rule ids from the
existing finding keys.

### 12. VS Code queue panel (carryover)
Unchanged: a pure consumer of `human_review.json` + writer of feedback files. The
JSON contract has now been stable across two uplifts, which was the stated
precondition — but it remains L effort and a new runtime to maintain.

## Anti-ideas — visuals we should not build

Named so they don't creep in via "while we're at it":

- **Severity × likelihood heatmaps, pie charts of risk counts, radar charts.**
  Decoration over aggregates the queue already ranks; no reviewer decision changes.
- **Bundling mermaid.js (or any chart lib) into the cockpit.** Breaks
  no-CDN/no-framework, adds ~2 MB to a file meant for Slack, and surrenders byte
  determinism to a layout engine we don't control.
- **Rendering diagrams to PNG/screenshots.** Binary artifacts: non-diffable,
  non-redactable, non-reviewable.
- **Any visual element that can't cite its fact.** Every node, edge, gutter mark,
  and chip must trace to a deterministic fact in the packet — the same rule the
  narrative already follows. A picture that's merely *plausible* is the exact
  failure mode this tool exists to prevent.

## Suggested sequencing

0. **Local review loop** — idea #13, first on purpose: every later milestone's
   dogfood step runs through it, and it works with GitHub Actions entirely
   unavailable.
1. **Milestone "M9: the picture"** — ideas #1 + #2. One theme: the change-graph
   model exists, the map replaces the hairball on GitHub surfaces, and the tour
   gives reading order. Mermaid-first deliberately: GitHub renders it natively,
   so M9 ships reviewer-visible value with zero new render technology.
2. **Milestone "M10: the cockpit becomes visual"** — ideas #3 + #4 + #6. One
   theme: the HTML cockpit gains the SVG map, line-level coverage, and the
   at-a-glance strip — all renderers over models M9 and earlier phases already
   ship.
3. **Milestone "M11: drift and convergence"** — ideas #5 + #7. One theme: the
   facts only longitudinal/structural comparison can produce. #5 extends the eval
   harness with its seeded fixture, per the standing discipline. #7's rounds
   ledger must work from local prior packets (via #13), not only CI artifacts.
4. **P2 tail** — ideas #8 + #9, one closing phase of render + surfacing work.

Existing discipline carries over unchanged: spec-first (promote chosen ideas to
ACIDs in Phase 0 of the goal contract, staged in `quality_gate.allow_missing` and
removed as they ship), deterministic evidence over LLM claims, mock provider by
default, byte-deterministic artifacts, redaction before every render, dogfood
every milestone on this repo — locally, via idea #13. Suggested new ACID
families: `CHANGE_MAP.*`, `READING_ORDER.*`, `ARCH_DRIFT.*`, `TREND.*`,
`LOCAL_LOOP.*`; idea 4 extends `COVERAGE.*`, ideas 3/6/8 extend `RENDER.*`, idea
9 extends `EVAL_HARNESS.*` — reuse existing families where one fits instead of
inventing parallel ones (final family decisions happen at Phase 0 promotion, as
with `EVAL_HARNESS` vs `EVAL` last round).
