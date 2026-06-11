# Agent goal: implement the next-value uplift (M6–M8+), one PR per phase

Goal: implement the P0–P2 ideas of `docs/next-value-brainstorm-2026-06.md` (ideas 1–12; the P3 opportunistic items 13–14 are explicitly out of scope), sequentially, with each phase delivered as its own PR that is simplified, reviewed, and landed on `main` before the next phase begins.

This builds directly on the completed human review uplift (`HUMAN_REVIEW_UPLIFT_GOAL.md`, PRs #47–#52). Everything that uplift shipped — the `human_review.md` cockpit, ranked queue with hunk excerpts, trust-marked narrative, semantic change facts, walkthrough feedback memory, draft-review export — is the foundation; nothing here may regress it.

Use these as the contract:

- `docs/next-value-brainstorm-2026-06.md` — the brainstorm: per-idea rationale, value/effort scoring, and milestone sequencing.
- `features/review-surfaces.feature.yaml` — the source-of-truth requirements ledger. **The spec entries for this work do not exist yet; Phase 0 creates them.** Preserve Acai IDs in tests, notes, and artifacts.
- `AGENTS.md` and `.agents/skills/composed-review-loop/SKILL.md` — working rules and the review/landing workflow for this repo.

## Phase 0 — spec promotion (one PR, prerequisite for everything else)

Promote ideas 1–12 into Acai requirements in `features/review-surfaces.feature.yaml`, grouped to match the phases below (suggested families: `PR_SURFACE.*`, `RANKING.*`, `COVERAGE.*`, `DEP_FACTS.*`, `BLAST_RADIUS.*`, `CONFIG_FACTS.*`, `POLICY.*`, `EVAL.*`, plus extending `RENDER.*` for idea 7 and `INTENT.*` for idea 12 — reuse existing families where one already fits instead of inventing a parallel one). Each requirement gets concrete acceptance criteria derived from the brainstorm's per-idea notes. Stage all new not-yet-shipped ACIDs in `quality_gate.allow_missing` in `review-surfaces.config.yaml` with `max_missing` raised accordingly, and remove each ACID from the allowlist in the phase PR that ships it — the gate must be back to `max_missing: 0, allow_missing: []` when the final phase lands.

## Phases (strict order, one PR each)

1. **PR surface (M6)** — brainstorm ideas 1 + 2. A reusable GitHub Action / workflow that runs `all --review-scope pr` on the PR, posts one idempotent sticky comment rendered from `human_review.json` (verdict, top queue items with hunk excerpts, trust summary), and uploads the full `.review-surfaces/` directory as a workflow artifact. On subsequent pushes, recover the previous packet and lead the sticky comment with the `since_last_review` delta (improved/regressed/new/resolved) instead of restating everything. Hard rules: strict postability gate and redaction run before any render leaves the runner; suggested comments remain drafts — the Action never posts them.
2. **Ranking & evidence (M7)** — brainstorm ideas 3 + 6 + 8. Queue ranking v2 (FB-2026-06-09-001): connect changed tests and current-head command transcripts to changed impl paths; every queue item gains a visible "why ranked here" line. Coverage-delta evidence: ingest lcov/istanbul output (via `run` transcripts or `--coverage <path>`) and compute per-hunk whether changed lines are executed by any test, feeding evidence cards and the ranking. Time-budgeted mode (`--budget <duration>`): estimate per-item review cost and render an explicit read/skim/defer cut with reasons.
3. **Eval harness** — brainstorm idea 11, deliberately pulled ahead of further fact expansion: a fixture suite of seeded regressions (weakened test, breaking API change, sneaky new dependency, secret in diff, uncovered changed lines) measuring whether the queue ranks each seeded issue in the top N. Runs in CI as a regression gate on review quality itself. No ranking tuning beyond Phase 2 may land without this gate in place.
4. **Fear-class facts (M8)** — brainstorm ideas 4 + 5 + 9. Dependency/supply-chain lens: deterministic lockfile/`package.json` facts (new deps, install scripts, major bumps, removed pins; registry metadata only as optional provider enrichment). Blast-radius facts: extend the existing TS AST surface parsing so changed/removed exports carry "used by N files (top: …)" from in-repo reference resolution. Config/infra facts: deterministic detectors for env var changes, CI workflow permission/secret changes, Dockerfiles, and destructive SQL/migration operations — each feeding existing risk lenses. Extend the Phase 3 eval fixtures to seed each new fact class.
5. **HTML cockpit** — brainstorm idea 7. `human --format html`: a single self-contained HTML file (inline CSS/JS, no server, no CDN, no framework) rendered strictly from the `HumanReviewModel` — collapsible hunks, lens filters, checkable queue items, links between queue, evidence, and narrative claims. Placed after Phases 2–4 deliberately so it renders everything they added to the model (`ranking_reasons`, the budget cut, coverage evidence, the new fact classes). Hard rules: a sibling of the markdown renderer (if the HTML needs data the model lacks, the model and strict schema grow first), every interpolation escaped, redaction re-run on render, byte-deterministic output.
6. **Team policy + intent synthesis** — brainstorm ideas 10 + 12. A committed, schema-validated `review-surfaces.policy.yaml`: suppression rules with reason and expiry, severity overrides, required manual checks per path glob — merged via PR so the team owns false-positive tuning; the walkthrough's local feedback memory composes with it rather than being replaced. Then provider-assisted intent synthesis (deferred FB-2026-05-28-007): richer schema-bound intent extraction behind the provider boundary with the existing verified/claimed trust marking; deterministic extraction remains the fallback and the verdict stays provider-untouchable.

## Per-phase loop

For each phase, in order:

1. Start from fresh `origin/main` on a new branch named `value-phase-<n>-<slug>`. Never commit directly to `main`.
2. Implement the phase's ACIDs with tests that reference those ACIDs. Meet the acceptance criteria recorded in the spec during Phase 0.
3. Run `pnpm run lint`, `pnpm run typecheck`, and the full `pnpm run test`. All must pass; record transcripts with the run helper where useful.
4. Dogfood: run the tool on itself with `--provider mock`, regenerate `.review-surfaces/` artifacts, and read the resulting `human_review.md` as a human reviewer. For Phase 1 the dogfood additionally includes the sticky comment rendered on a real PR of this repo. If the phase did not visibly improve the rendered surface, record why in a dogfood feedback file before proceeding.
5. Remove the phase's ACIDs from `quality_gate.allow_missing` and confirm the strict gate passes.
6. **Simplify pass:** before opening or finalizing the PR, run the simplification skill on the change — the skill is named `simplify` if you are a Claude agent, `simplify triad` if you are a Codex agent. Apply its output; re-run tests after.
7. Open the PR with a body that lists the phase number, the ACIDs covered, the validation commands run, and the dogfood verdict.
8. **Autoland:** run the autoland flow. Respect the repository gates from `.agents/skills/composed-review-loop/SKILL.md` — do not merge unless the gates are satisfied (clean review verdict, green checks). The PR reviewer bot typically responds within ~3–11 minutes; address review findings and re-run the gates rather than overriding them. Heed FB-2026-06-08-006: inspect current-head review comments before autolanding.
9. **Do not begin the next phase until the current phase's PR is merged into `origin/main`.** After merge, sync `main` and start the next phase from it.

If a phase proves too large for one reviewable PR, you may split it into stacked PRs, but every PR must pass the same simplify + autoland gate, and the phase counts as done only when all its PRs are merged.

## Hard constraints

- Local files first; the GitHub Action is a renderer over local artifacts, never a separate analysis path. Provider integrations stay optional; default to `--provider mock` for all dogfood runs.
- Never treat LLM or agent-file output as proof until deterministic evidence validation accepts it (this applies doubly to the Phase 6 intent synthesis). LLM output never alters the verdict.
- All new fact sources (coverage, dependencies, blast radius, config) must be deterministic and offline by default; network-dependent enrichment goes behind the existing provider boundary.
- Redaction and the strict postability gate run before anything is posted to GitHub; the Action posts only the sticky summary comment — suggested review comments stay drafts for a human to submit.
- Every substantive claim needs evidence or must be marked unknown/hypothesis/missing evidence. Never claim tests passed without running them.
- Preserve Acai IDs everywhere they are useful; do not renumber or repurpose existing requirement IDs.
- Keep `.review-surfaces/` artifacts compact and local-first.
- Do not rely on hidden chat context; persist decisions into specs, docs, dogfood feedback files, or handoff notes.

## Success condition

All phases merged to `main` via individually simplified, reviewed, autolanded PRs; the quality gate is back to `max_missing: 0, allow_missing: []`; a PR on this repo shows one sticky comment that opens with the since-last-review delta on its second push; every queue item explains why it ranked where it did, with coverage evidence attached where a report exists; seeded-regression eval fixtures pass in CI and cover every shipped fact class; dependency, blast-radius, and config facts render in their lenses from the mock provider; `human --format html` emits a self-contained offline cockpit from the same model; `review-surfaces validate --surface all` passes on the regenerated artifacts.
