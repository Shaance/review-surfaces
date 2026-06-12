# Changelog

All notable changes to `review-surfaces` are documented here. The project was
built agent-first in five development uplifts, each landed phase by phase
behind the same local merge gate the tool itself enforces; the full working
contracts live in
[`docs/history/`](https://github.com/Shaance/review-surfaces/tree/main/docs/history)
(an absolute link because this changelog ships in the npm tarball, which does
not carry that directory).

## 0.2.0 — unreleased (intended first npm publish)

The package manifest already carries `0.2.0`, so the owner's single manual
step (`npm publish` after `pnpm run local-gate`) ships exactly this version.
The package name `review-surfaces` was verified unclaimed on 2026-06-12.

- Change-map legibility at scale (`MAP_SCALE.1-6`): a schema-visible overview
  level that leads on every surface when the file-level map cannot render
  legibly (groups merged from model clusters, honest counts that sum to 100%
  of the diff, aggregated edges with weights); per-group zoom views in the
  cockpit (click an overview group) and `human_review.md` (collapsed details
  per group) with explicit cross-group stub ports; wrapped SVG layouts so no
  rendered map ever exceeds the width budget — a visual that cannot render
  legibly summarizes, never shrinks.
- Showcase and publish trim (`DISTRIBUTION.5-8`): committed example artifacts
  under `docs/example/` from a pinned spec-less run, README screenshots
  regenerated from real runs, a cockpit pointer at the end of every
  `review-surfaces all` run, this changelog, and the remaining internal
  proposals moved to `docs/history/`.

## 0.1.0 — 2026-05-30 through 2026-06-12 (unpublished development history; never on npm)

The MVP and four uplifts, condensed. Every phase shipped with ACID-named
tests against `features/review-surfaces.feature.yaml`, byte-deterministic
artifacts, and redaction before every render.

### MVP (PR #11)

- Local-first review packet compiler: `collect`, `intent`, `evaluate`,
  `diagrams`, `methodology`, `risks`, `dogfood`, `handoff`, `packet`, `all`,
  `validate` over `.review-surfaces/` artifacts; Acai-compatible spec
  ingestion; mock/agent-file/ai-sdk provider boundary; privacy ignore +
  secret redaction; deterministic evidence validation.

### Human review uplift (PRs #47–#52)

- The human review surface: verdict, ranked review queue with rollups and
  hunk excerpts, grounded narrative with verified/claimed trust markers,
  deterministic semantic change facts (schema/API/test-weakening via the TS
  AST), an interactive `review` walkthrough, and a GitHub draft-review
  export.

### Next-value uplift (PRs #53–#62)

- The PR surface: sticky summary comment with since-last-review deltas and a
  composite GitHub Action; ranking v2 with evidence tiers; lcov coverage
  evidence and `--budget` review plans; the seeded-regression eval harness
  (gates ranking changes in CI); dependency/blast-radius/config fear-class
  facts; the self-contained HTML cockpit; team policy YAML and
  provider-assisted intent candidates that never affect coverage.

### Visual value uplift (PRs #63–#69)

- The change-graph model and map: mermaid + clickable SVG emitters, the
  guided reading-order tour, coverage gutters, the header strip,
  architecture-drift facts, the review-rounds trend ledger, attributed
  dependency-chain trees, and the scripted local loop (`pnpm run
  local-review` / `local-gate`) that produces and gates every surface with
  zero CI.

### Open-source readiness uplift (PRs #70–#73)

- Cold-start correctness on a stranger's repository: package-root schema
  resolution, implementation roots derived from the target repo's own
  signals, trivia-free API signature comparison, spec-less mode
  (`spec_mode: none` suppresses every Acai-shaped output), LICENSE (MIT),
  CONTRIBUTING, the stranger-first README, and a packaging smoke test in the
  local gate.
