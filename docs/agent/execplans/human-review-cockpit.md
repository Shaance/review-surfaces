# Human Review Cockpit Execplan

## Context

The product proposal in `docs/history/human-first-review-surfaces-comprehensive-feature-proposal.md` reframes `review-surfaces` from a packet compiler into a human review decision cockpit. The existing PR surface already provides deterministic diff-scoped facts: changed files, affected requirements, scoped coverage, PR risks, and a gated narrative. The first implementation slice should turn those facts plus `review_packet.json` into a human-first artifact without changing the core packet contract.

Light prior-art scan: current AI review products tend to emphasize PR summaries, inline comments, risk scores, and suggested fixes. The differentiator to preserve here is deterministic, local, evidence-backed review routing: verdict, review-first queue, trust audit, questions, and concrete checks.

## Architecture

- Add `src/human/contract.ts` for `review-surfaces.human_review.v1`.
- Add deterministic builders in `src/human/human-review.ts`.
- Add Markdown and artifact writers in `src/human/render.ts`.
- Add `schemas/human_review.schema.json` and validate generated JSON before writing.
- Wire `all` to emit `human_review.json` and `human_review.md` by default in repo and PR modes.
- Add a `human` command that renders from existing `review_packet.json` plus optional `pr_review_surface.json` without recomputing the pipeline.
- Keep `review_packet.json` unchanged as the evidence backbone.

## Milestone M1

Goal: create a schema-validated human review brief from existing packet and PR surface facts.

Files:

- `features/review-surfaces.feature.yaml`: add `HUMAN_REVIEW` and `HUMAN_TRUST` requirements from the proposal.
- `review-surfaces.config.yaml`: map `src/human/` and `schemas/human_review.schema.json` to `HUMAN_REVIEW`.
- `src/human/*`: new contract, builder, and renderer.
- `src/cli/index.ts`: add `human` command and default `all` artifact emission.
- `src/collector/artifact-provenance.ts`: no M1 change; `human_review.json` and `human_review.md` are regenerated renderer outputs from the stamped packet/PR sidecar rather than independent provenance inputs.
- `schemas/human_review.schema.json`: machine contract.
- `tests/human-review.test.ts`: builder/schema/Markdown coverage.
- `tests/pr-surface-e2e.test.ts`: assert `all --review-scope pr` writes human artifacts.
- `README.md`: list the new default human artifact and command.

Verification:

- `pnpm run typecheck`
- `pnpm run test:fast`
- `pnpm run review-surfaces -- dogfood --provider mock --base origin/main --head HEAD --spec features/review-surfaces.feature.yaml --out .review-surfaces`
- `pnpm exec review-surfaces validate .review-surfaces`

Exit criteria:

- `all` writes `human_review.json` and `human_review.md`.
- `human_review.json` validates against `schemas/human_review.schema.json`.
- The first Markdown screen contains verdict, review-first items, blockers/questions, and trust audit.
- The builder is deterministic under `mock`.
- Dogfood output is inspected and any useful finding is converted into code, tests, schema, docs, feedback, or an explicit deferral.

## M1 Dogfood Findings

- Dogfood initially mapped `README.md` and the execplan as overreach, and mapped the new `HUMAN_TRUST` constraints as missing. Fixed by adding precise review-area mappings for the human cockpit, trust constraints, source docs, and dogfood execplans.
- Dogfood showed repo-mode `human_review.md` degraded readiness for missing evidence but generated no author questions and led with broad legacy test gaps. Fixed by promoting focused `HUMAN_REVIEW` / `HUMAN_TRUST` gaps into reviewer questions, suggested comments, and front-loaded test-plan items.
- Simplify triad correctness found nonzero command-transcript exits were not always merge blockers and stale PR sidecars could be mixed with a newer packet. Fixed with deterministic blocker detection and stale-sidecar rejection tests.
- Simplify triad reuse found schema/runtime enum drift risk and PR-risk metadata duplication. Fixed with schema parity tests and shared PR-risk metadata for titles, queue weights, and PR rule priority.

Deferred:

- Cache-hit human rendering still reparses packet/surface artifacts already read for cache validation; this is a moderate efficiency cleanup for a later cache helper pass.
- Human Markdown rendering and sidecar schema validation share patterns with existing comment/schema code; extracting common helpers is a useful reuse cleanup but broader than M1.

## Completed Follow-Up Milestones

- M2: stronger merge-readiness policy and blocker precedence.
  - Implemented deterministic readiness decisions, evidence-backed blockers, conservative missing-evidence degradation, and current-head manual-check clearing.
  - Primary anchors: `src/human/human-review.ts`, `tests/human-review.test.ts`.
- M3: hunk-level queue from parsed diff hunks.
  - Implemented review queue ranking with changed-file anchors, hunk headers, line ranges, renamed/deleted path handling, and pathless-risk question fallback.
  - Primary anchors: `src/human/human-review.ts`, `tests/human-review.test.ts`.
- M4: deeper trust audit and concrete test-plan synthesis.
  - Implemented verified/claimed/missing/invalid evidence separation, concrete automatic/manual test-plan items, and required-check preservation under caps.
  - Primary anchors: `src/human/human-review.ts`, `src/human/render.ts`, `tests/human-review.test.ts`.
- M5: suggested reviewer comments.
  - Implemented deterministic evidence-backed comment drafts grouped by blocking, clarifying, and non-blocking severity. Drafts are local-only and not auto-posted.
  - Primary anchors: `src/human/human-review.ts`, `src/render/pr-comment.ts`, `tests/human-review.test.ts`, `tests/pr-comment.test.ts`.
- M6: feedback memory and domain risk lenses.
  - Implemented local feedback policy effects, false-positive/false-negative tuning, required manual checks, review routes, evidence cards, since-last-review deltas, risk lenses, and config caps.
  - Primary anchors: `src/human/human-review.ts`, `src/config/config.ts`, `schemas/human_review.schema.json`, `tests/human-review.test.ts`, `tests/config.test.ts`, `tests/schema-contract.test.ts`.

## Additional Proposal Slices Landed

- PR comments now prefer a current schema-valid `human_review.json` while preserving `pr_review_surface.json` as the lower-level PR fact and postability model.
- `all` prints `human_review.md` as the default reviewer entrypoint with verdict, review-first count, blockers, suggested comments, and missing-evidence count.
- Standalone human artifacts are rendered from `human_review.json`: `review_queue.md`, `suggested_comments.md`, `trust_audit.md`, `risk_lenses.md`, `review_routes.md`, `evidence_cards.md`, `since_last_review.md`, `intent_mismatch.md`, and `test_plan.md`.
- `review-surfaces.HUMAN_REVIEW.18` implements explicit intent-mismatch findings for expected spec intent, observed diff behavior, possible mismatches, possible overreach, and missing intent mappings.

## Remaining Cleanup Candidates

- Cache-hit human rendering still reparses packet/surface artifacts already read for cache validation; this is a moderate efficiency cleanup for a later cache helper pass.
- Human Markdown rendering and sidecar schema validation share patterns with existing comment/schema code; extracting common helpers is a useful reuse cleanup when the next renderer change touches the same code.
