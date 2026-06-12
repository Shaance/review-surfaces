# Project history

This tool was built by coding agents and reviewed with itself.

The documents in this directory are the actual working contracts those agents
executed against — goal files for each development uplift, the brainstorm
documents the goals were distilled from, and the original bootstrap README.
They are kept (rather than deleted) because they are the provenance story:
every phase here was implemented agent-first, gated by `pnpm run local-gate`,
and reviewed using the very review surfaces this repository produces, plus an
independent automated reviewer, before merging.

Reading order, if you are curious how the product evolved:

1. `CODEX_GOAL.md` — the original MVP build contract (review packet pipeline).
2. `HUMAN_REVIEW_UPLIFT_GOAL.md` — the human reviewer cockpit uplift.
3. `next-value-brainstorm-2026-06.md` → `NEXT_VALUE_UPLIFT_GOAL.md` — the PR
   surface, ranking v2, coverage evidence, eval harness, and fear-class facts.
4. `visual-value-brainstorm-2026-06.md` → `VISUAL_VALUE_UPLIFT_GOAL.md` — the
   change map, guided diff tour, SVG cockpit visuals, drift facts, and rounds
   trend.
5. `OPEN_SOURCE_UPLIFT_GOAL.md` — the cold-start correctness, spec-less mode,
   and distribution work that made the tool usable on a stranger's repository.
6. `POLISH_UPLIFT_GOAL.md` — the pre-publish legibility-at-scale uplift: the
   change-map overview and zoom levels, the wrapped layouts, the committed
   example packet, and the publish trim.
7. `README.bootstrap.md` — the original spec-first bootstrap README.

The two product proposals the cockpit uplifts executed against also live here:
`human-first-review-surfaces-comprehensive-feature-proposal.md` (the original
human-review cockpit design) and `human-review-value-uplift-proposal.md` (the
per-line review-value diagnosis behind `HUMAN_REVIEW_UPLIFT_GOAL.md`).

None of these documents are needed to use or contribute to the tool today —
`README.md` and `CONTRIBUTING.md` at the repository root are the current
entrypoints, and `features/review-surfaces.feature.yaml` is the live
requirements ledger.
