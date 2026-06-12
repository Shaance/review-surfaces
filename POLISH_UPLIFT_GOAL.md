# Agent goal: pre-publish polish uplift — legibility at scale, one PR per phase

Goal: before the first `npm publish`, make the change map **legible at any diff size** — a high-level overview that always fits, plus zoomed per-subsystem detail on demand — and close the last first-impression gaps (showcase, README truth, publish trim). Each phase is its own PR, simplified, reviewed, and landed on `main` before the next begins (same discipline as `docs/history/OPEN_SOURCE_UPLIFT_GOAL.md`).

This builds on the four completed uplifts (PRs #47–#73). Nothing here may regress them: cold-start correctness, spec-less mode, the queue, the eval harness, the cockpit, and map/tour agreement are the foundation.

Use these as the contract:

- This file's **Legibility evidence log** below — every fix in Phases 1–2 traces to an observed failure, not speculation.
- `features/review-surfaces.feature.yaml` — the requirements ledger. **Phase 0 creates the spec entries.** Preserve Acai IDs in tests, notes, and artifacts.
- `AGENTS.md` and `.agents/skills/composed-review-loop/SKILL.md` — working rules and the review/landing workflow.

## Standing constraints

- Everything runs locally with `--provider mock` (network: git only). Merge gate: clean review verdict plus `pnpm run local-gate` green.
- Byte-deterministic artifacts, redaction before every render, model-and-strict-schema-grow-first.
- **New standing rule for this uplift:** a visual that cannot render legibly must *summarize*, never *shrink*. Scale-to-fit below ~90% of natural size is a rendering bug, and overflow stays explicit ("+ N more"), never silent — including edges.

## Legibility evidence log (2026-06-12)

Method: built `main` (`aefc63c`), ran `all` + `human --format html` + `comment --format sticky` with the mock provider on three ranges — this repo `aefc63c~1..aefc63c` (PR #73, 24 files) and `aefc63c~8..aefc63c` (the last 8 PRs, 99 files, +5796/−508), and a fresh shallow clone of `sindresorhus/got` at `a5b76bffb` (`HEAD~3`, the original cold-start range, and `HEAD~40`, 87 files). Verified still-good: `validate` from a foreign CWD passes, the spec-less got packet has zero Acai-shaped output, the cockpit stays one self-contained ~86 KB file. The failures:

1. **The cockpit SVG map scales itself into illegibility.** `renderChangeMapSvg` lays out one 200px column per cluster + 60px gap (`src/human/render-svg-map.ts:19-21,178`) and emits `width="100%"` with `max-width` = natural width (`:181-182`), so the ~980px cockpit column scales the map down linearly. Observed: PR #73 → 7 columns, viewBox 1792×702, rendered at ~55% (12px labels ≈ 6.5px); got `HEAD~40` → 2052×972 at ~48%; the 8-PR range → 23 clusters, viewBox **6212×540, rendered at ~16% (≈ 2px labels)**. Full-size rendering survives only up to ~4 columns (got `HEAD~3`: 1012×162 ✓). The README's own `docs/images/change-map.png` is a 4680×768 ribbon — the screenshot that sells the feature demonstrates the bug.
2. **One-column-per-cluster is simultaneously too big and too empty.** In the 8-PR run, 12 of 23 clusters hold exactly one file yet each costs a full 260px column; `MAX_CHANGED_NODES = 25` leaves 74 of 99 files represented only as "+ N more files" texts; and edges touching capped files are silently skipped (`render-svg-map.ts:157-164`, `src/diagrams/change-map.ts:80-88`) — 228 model edges mostly vanish with no note, violating the never-silent rule. The map is neither an overview (most files hidden) nor a detail view (what's shown is unreadable).
3. **Mermaid surfaces sprawl the same way.** The 8-PR `human_review.md` embeds a 151-line `flowchart LR` with ~24 subgraphs; in the sticky comment, that diagram is 151 of 251 total lines. The only size control is the 12 KB embed guard (`src/render/change-map-embed.ts:13`), which deletes the map entirely — honest but value-zero.
4. **No zoom level exists, although the model is already two-level.** `clusterOfPath` (`src/core/source-roots.ts:184-193`) emits `root/subdir` clusters beneath top-level segments (`src/human` under `src`; got's `source/core` under `source`), so a high-level grouping is *derivable deterministically* — but both emitters flatten to one level, and the cockpit's only interaction is node-click-filters-queue (`render-svg-map.ts:108`). A reviewer cannot ask "show me just `src`" anywhere.
5. **Showcase gap (carried from the OSS uplift's skipped Phase 4).** No committed sample artifacts exist; a stranger cannot read a `human_review.md` or open a cockpit before installing. The three README PNGs are the only preview, and the map one is illegible (failure 1).
6. **Publish-trim loose ends (verified 2026-06-12).** The npm name `review-surfaces` is unclaimed (registry 404) and the package metadata is publish-ready, but: the `all` terminal summary never mentions the HTML cockpit, so the flagship surface is invisible on the quickstart path; there is no `CHANGELOG.md` for the npm listing; and `docs/` still mixes internal proposal docs with user-facing docs while their siblings live in `docs/history/`.

Observed but deliberately out of scope: pipeline runtime (17–22s on this repo's ranges — tolerable locally; revisit only on user feedback), mermaid dark-mode theming on GitHub (no failure observable offline), SVG pan/zoom libraries (rejected: wrapping + drill-down solves it dependency-free), publish automation/provenance workflows (`npm publish` stays the owner's manual step).

## Phase 0 — spec promotion (one PR, prerequisite)

Promote the work below into Acai requirements in `features/review-surfaces.feature.yaml`. Suggested families: `MAP_SCALE.*` (Phases 1–2; reuse `CHANGE_MAP.*`/`RENDER.*` where an existing requirement already owns the surface — resolve at promotion time as in prior uplifts) and `SHOWCASE.*` or `DISTRIBUTION.5+` (Phase 3). Acceptance criteria cite the evidence-log failure each requirement closes. Stage new ACIDs in `quality_gate.allow_missing` (keep `max_missing: 0`); each phase PR removes the ACIDs it ships; the gate is back to `allow_missing: []` when the final phase lands.

## Phases (strict order, one PR each)

1. **Overview level — the map summarizes when it cannot stay legible.**
   - `change_graph` grows a schema-visible `overview`: groups = model clusters merged by first path segment (`(root)` stays itself), each carrying file count, cluster count, churn totals, dominant lens (deterministic tie-break), and review-queue item count; one aggregate dashed halo entry; aggregated inter-group edges with weight = underlying edge count and `has_new`/`has_removed` flags. Derived from the same model the tour and queue use — no renderer-local clustering. Additive, strict-schema-first.
   - One legibility-budget helper (single module, shared constants) decides per surface which level leads; renderers may not carry private thresholds. When the file-level map exceeds the budget, the overview leads on **every** surface (cockpit SVG, md mermaid, sticky) — same-model dual emitters, as today.
   - Honest by construction: group file counts sum to the full changed-file count (asserted in tests — closes the 74-hidden-files half of failure 2), and aggregated edge weights account for every model edge between groups (closes the silent-edge half).
   - Small diffs unchanged: got `a5b76bffb` `HEAD~3` keeps the file-level map leading, same structure as today.
   - Hard rule: ACID-named tests first, reproducing failure 1's 8-PR fixture (23 clusters) and asserting the overview leads, fits the budget, and sums add up. Dogfood: the 8-PR sticky diagram drops from 151 lines to an overview a reviewer can actually read.

2. **Zoom level — per-subsystem detail, and nothing ever renders shrunk.**
   - Each overview group gets a detail view: its model clusters and files, intra-group edges, cross-group edges as stub ports (e.g. "→ src/render ×3"), and its share of the halo; per-view node cap with explicit "+ N more".
   - Wrapped layout everywhere: columns wrap into rows (and long file stacks wrap too) so **no rendered SVG — overview, detail, or small-diff file-level — exceeds the width budget**; height grows, width never. This alone must lift the typical-PR case (failure 1, `aefc63c~1`, 1792px → ~55%) back to ≥ ~94% as a single wrapped file-level map.
   - Cockpit: clicking an overview group toggles its pre-rendered, hidden detail SVG — vanilla JS, no library, deterministic markup, same `data-` pattern as existing filters; file clicks inside a detail view keep filtering the queue exactly as today.
   - md: one `<details>` block per group with its detail mermaid (deterministic order, embed guard per block); the sticky comment stays overview-only.
   - Hard rules: map/tour agreement holds (detail views use the model clusters the queue/tour reference, verbatim); every changed file appears in exactly one detail view (asserted on the 99-file fixture); ACID-named tests land before fixes. Dogfood: open the 8-PR cockpit and review it — overview legible at 100%, drill into `src` and `tests` answers "what changed in this subsystem" without squinting.

3. **First-impression tail — showcase, README truth, publish trim.**
   - `docs/example/`: committed sample artifacts (`human_review.md`, `human_review.html`, `comment.md`) from the pinned got cold-start (`a5b76bffb`, `HEAD~3`, frozen `--now`, redaction verified), with a short framing README stating the exact commands that generated them; linked from the main README ("read a packet before installing"). This is the OSS uplift's skipped Phase 4, now unblocked because the artifacts are worth showing.
   - README: regenerate `docs/images/change-map.png` from a real run so it shows the overview at legible width (it currently demonstrates failure 1); refresh `cockpit.png` if the fold changed; update "The change map" copy to describe overview ↔ zoom.
   - Quickstart surfacing: the `all` terminal summary ends with a cockpit pointer (`review-surfaces human --format html`) — decide at implementation whether `all` should also write `human_review.html` directly; either way the stranger learns the cockpit exists from their first run.
   - Publish trim: add `CHANGELOG.md` (condensed 0.1.0 history — the five uplifts — plus an Unreleased section; suggest `0.2.0` for first publish; publishing itself stays manual). Move `docs/*-proposal*.md` into `docs/history/` with inbound references updated; move this file there too and index it in the history README.

## Per-phase loop

Identical to the OSS uplift: branch `polish-phase-<n>-<slug>` from fresh `origin/main`; implement with ACID-named tests; `pnpm run local-gate` green; dogfood via `pnpm run local-review` **plus the pinned legibility re-runs** (this repo `aefc63c~1..aefc63c` and `aefc63c~8..aefc63c`; got at `a5b76bffb`, `HEAD~3` and `HEAD~40` — read the cockpit and sticky output as a reviewer would); remove the phase's ACIDs from `allow_missing`; simplify pass; PR with phase number, ACIDs, validation commands, dogfood verdict; autoland per repository gates; next phase only after merge.

## Success condition

All phases merged; gate back to `max_missing: 0, allow_missing: []`. On the pinned wide ranges, every rendered map either fits the legibility budget at full size or leads with an overview whose counts cover 100% of the diff, with every changed file reachable through exactly one zoom view; the typical-PR map renders ≥ ~94% of natural size; the README's map screenshot is readable in place; a stranger can read a committed example packet before installing, sees the cockpit pointer on their first `all` run, and finds a CHANGELOG when the package goes up — with `npm publish` remaining the owner's single manual step.
