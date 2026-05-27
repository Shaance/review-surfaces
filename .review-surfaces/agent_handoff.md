# Agent Handoff

First working local CLI slice exists: config loading, Acai indexing, collection, schema validation, and skeleton packet rendering.

## Current Milestone

M1

## Relevant ACIDs

- review-surfaces.CLI.1
- review-surfaces.COLLECTOR.2
- review-surfaces.RENDER.3
- review-surfaces.DOGFOOD.1

## Commands To Run

- `pnpm run typecheck`
- `pnpm run test`
- `pnpm run review-surfaces -- all --base origin/main --head HEAD --spec features/review-surfaces.feature.yaml --dogfood --out .review-surfaces`
- `pnpm run review-surfaces -- validate .review-surfaces/review_packet.json`

## Next Tasks

- Broaden fixture tests for overreach, sparse specs, and missing logs.
- Implement evaluator and risk modules with direct versus missing evidence separation.
- Replace skeleton architecture output with deterministic subsystem grouping and Mermaid diagrams.

## Open Risks

- Schema validation is local and intentionally small; replace or harden it before accepting arbitrary external schemas.

## Artifact Paths

- `.review-surfaces/manifest.json`
- `.review-surfaces/inputs/specs.index.json`
- `.review-surfaces/review_packet.json`
- `.review-surfaces/review_packet.md`
