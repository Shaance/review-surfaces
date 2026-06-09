# Agent goal: implement the human review value uplift, one PR per phase

Goal: implement all 5 phases of `docs/human-review-value-uplift-proposal.md`, sequentially, with each phase delivered as its own PR that is simplified, reviewed, and landed on `main` before the next phase begins.

Use these as the contract:

- `docs/human-review-value-uplift-proposal.md` — the proposal: diagnosis, per-phase design sketches, and acceptance criteria.
- `features/review-surfaces.feature.yaml` — the source-of-truth requirements ledger. The spec entries for this work are already landed; preserve Acai IDs in tests, notes, and artifacts.
- `AGENTS.md` and `.agents/skills/composed-review-loop/SKILL.md` — working rules and the review/landing workflow for this repo.

## Phases (strict order, one PR each)

1. **Density + hardening** — `review-surfaces.HUMAN_REVIEW.19`, `.20`, `.21`, `review-surfaces.SCHEMA.3`, `review-surfaces.CLI.8`, `review-surfaces.RENDER.8`. Renderer rollups, inline hunk excerpts, reviewer-language pass, strict human schema, `validate --surface`, local comment exit-code fix.
2. **Grounded narrative** — `review-surfaces.NARRATIVE.1` through `.5`. Provider-written narrative with per-claim anchor validation and verified/claimed trust markers; never touches the verdict.
3. **Semantic change facts** — `review-surfaces.SEMANTIC_DIFF.1` through `.4`. Implement in this order: semantic schema diff, test-weakening detector, exported API surface diff.
4. **Interactive review session** — `review-surfaces.REVIEW_LOOP.1` through `.4`. The queue walkthrough command feeding feedback memory; then revisit the deferred decision-policy config question and record a decision (implement or explicit deferral).
5. **Positioning + draft review export** — README/positioning reframe ("trust layer for agent-written code") and `review-surfaces.PROVIDERS.7`.

## Per-phase loop

For each phase, in order:

1. Start from fresh `origin/main` on a new branch named `uplift-phase-<n>-<slug>`. Never commit directly to `main`.
2. Implement the phase's ACIDs with tests that reference those ACIDs. Meet the acceptance criteria listed for the phase in the proposal doc.
3. Run `pnpm run lint`, `pnpm run typecheck`, and the full `pnpm run test`. All must pass; record transcripts with the run helper where useful.
4. Dogfood: run the tool on itself with `--provider mock`, regenerate `.review-surfaces/` artifacts, and read the resulting `human_review.md` as a human reviewer. If the phase did not visibly improve the rendered surface, record why in a dogfood feedback file before proceeding.
5. **Simplify pass:** before opening or finalizing the PR, run the simplification skill on the change — the skill is named `simplify` if you are a Claude agent, `simplify triad` if you are a Codex agent. Apply its output; re-run tests after.
6. Open the PR with a body that lists the phase number, the ACIDs covered, the validation commands run, and the dogfood verdict.
7. **Autoland:** run the autoland flow. Respect the repository gates from `.agents/skills/composed-review-loop/SKILL.md` — do not merge unless the gates are satisfied (clean review verdict, green checks). The PR reviewer bot typically responds within ~3–11 minutes; address review findings and re-run the gates rather than overriding them.
8. **Do not begin the next phase until the current phase's PR is merged into `origin/main`.** After merge, sync `main` and start the next phase from it.

If a phase proves too large for one reviewable PR, you may split it into stacked PRs, but every PR must pass the same simplify + autoland gate, and the phase counts as done only when all its PRs are merged.

## Hard constraints

- Local files first; provider integrations stay optional. Default to `--provider mock` for all dogfood runs.
- Never treat LLM or agent-file output as proof until deterministic evidence validation accepts it (this applies doubly to the Phase 2 narrative).
- Every substantive claim needs evidence or must be marked unknown/hypothesis/missing evidence. Never claim tests passed without running them.
- Preserve Acai IDs everywhere they are useful; do not renumber or repurpose existing requirement IDs.
- Keep `.review-surfaces/` artifacts compact and local-first.
- Do not rely on hidden chat context; persist decisions into specs, docs, dogfood feedback files, or handoff notes.

## Success condition

All 5 phases merged to `main` via individually simplified, reviewed, autolanded PRs; the regenerated mock-provider `human_review.md` opens with a trust-marked narrative, contains no repeated templated findings, shows inline hunks in the review queue, names concrete contract changes instead of path-touch facts, and `review-surfaces validate --surface all` passes on the generated artifacts.
