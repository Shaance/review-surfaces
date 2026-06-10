# Next-Value Brainstorm — June 2026

Status: brainstorm / pre-spec. Nothing here is committed work until promoted into
`features/review-surfaces.feature.yaml` as Acai requirements.

## Where we are

The human review uplift (Phases 1–5, PRs #47–#52) shipped the local cockpit:
`human_review.md` entrypoint, ranked queue with inline hunk excerpts, trust-marked
narrative, semantic change facts (schema contracts, API surface, test-weakening),
the interactive `review` walkthrough with feedback memory, and draft-review export
(`comment --format review`). The quality gate is strict again (`allow_missing: []`).

The honest gap: **the artifacts are excellent, but they live in a local directory.**
Most reviewers live in GitHub. The next wave of value is (a) meeting reviewers where
they are, (b) making the queue ranking smarter with evidence we already collect, and
(c) widening semantic facts to the change classes reviewers fear most (dependencies,
config, blast radius, coverage).

## Scoring

- **Value**: how much it changes a real reviewer's decision quality or time-to-decision.
- **Effort**: S (≤1 phase-sized PR), M (1–2 PRs), L (multi-phase).
- **Leverage**: how much it reuses what already exists (high leverage = mostly a renderer
  or a new fact source plugged into existing surfaces).

## Prioritized ideas

| # | Idea | Value | Effort | Leverage | Priority |
|---|------|-------|--------|----------|----------|
| 1 | GitHub Action: sticky PR comment + artifact upload | Very high | M | High | **P0** |
| 2 | Re-review delta on push (`since-last-review` on GitHub) | Very high | M | High | **P0** |
| 3 | Queue ranking v2: transcripts + changed tests → impl paths | High | M | High | **P0** |
| 4 | Dependency / supply-chain lens | High | S–M | High | **P1** |
| 5 | Blast-radius facts (reverse deps of changed exports) | High | M | Med | **P1** |
| 6 | Coverage-delta evidence (changed lines covered?) | High | M | Med | **P1** |
| 7 | Single-file HTML cockpit (`human --format html`) | Med–High | M | High | **P1** |
| 8 | Time-budgeted review mode (`--budget 15m`) | Med | S | High | **P1** |
| 9 | Config/infra semantic facts (env, CI, migrations) | Med | S–M | High | **P2** |
| 10 | Team-shared feedback policy (committed, mergeable) | Med | S | High | **P2** |
| 11 | Effectiveness eval harness (seeded-bug benchmark) | Med (strategic) | L | Low | **P2** |
| 12 | Provider-assisted intent synthesis (deferred FB-2026-05-28-007) | Med | M | Med | **P2** |
| 13 | SARIF completion → GitHub code scanning annotations | Low–Med | S | High | **P3** |
| 14 | Editor integration (VS Code queue panel) | Med | L | Low | **P3** |

---

## P0 — meet reviewers where they are, sharpen the queue

### 1. GitHub Action: sticky PR comment + artifact upload
A reusable workflow / composite action that runs `all --review-scope pr` on the PR,
posts (or updates) one sticky comment rendered from `human_review.json` — verdict,
top queue items with hunk excerpts, trust audit summary — and uploads the full
`.review-surfaces/` directory as a workflow artifact. The local artifacts already
exist; this is M6 as a renderer, not new analysis.

- Why now: distribution. Every other idea multiplies in value once the surface is
  in the PR itself. Also the most credible demo for adoption outside this repo.
- Constraints to keep: strict postability gate, redaction before render, never
  auto-posting suggested comments (sticky summary only; drafts stay drafts).
- Effort: M (action plumbing, sticky-comment upsert, idempotency on re-runs).

### 2. Re-review delta on push
`since_last_review.md` already computes improved/regressed/new/resolved when a
prior packet exists. Wire it into the PR loop: cache the previous packet (workflow
artifact or comment-embedded hash), and on each push the sticky comment leads with
**"what changed since your last review"** instead of restating everything.

- Why: re-review is where human attention actually collapses on agent-written PRs —
  round 4 of a Codex-style loop gets skimmed. This makes iteration rounds cheap.
- Effort: M, mostly state/plumbing on top of idea #1. Ship as the second half of
  the same milestone.

### 3. Queue ranking v2 (recorded as FB-2026-06-09-001)
Connect evidence we already collect to the ranking: a changed impl path whose
focused tests also changed *and* have a passing current-head transcript ranks lower;
a changed impl path with no test changes and no transcript ranks higher. Add a
visible "why ranked here" line per queue item.

- Why: the queue is the product. Ranking quality is what decides whether reviewers
  trust the top-7 cut in `human_review.md`.
- Effort: M. Deterministic, no provider work. Already has a dogfood finding and a
  defer note pointing at it.

---

## P1 — widen the facts reviewers fear most

### 4. Dependency / supply-chain lens
Semantic facts for `package.json` / lockfile changes: new dependencies (with age,
weekly downloads, install scripts), major version bumps, removed pins, transitive
additions. Render as a dedicated risk lens — agents adding a dependency is exactly
the "overreach" class the positioning promises to catch.

- Effort: S–M offline (lockfile diff is deterministic); registry metadata is an
  optional enrichment behind the existing provider boundary.

### 5. Blast-radius facts
Phase 3.5 already parses the TS API surface with the AST. Extend it: for each
changed/removed export, find in-repo references and attach "used by N files
(top: …)" to the queue item and contract risks. Turns "signature changed" into
"signature changed and 14 call sites depend on it."

- Effort: M (reference resolution can start as project-wide identifier search,
  upgrade to ts-morph later). High payoff per queue item.

### 6. Coverage-delta evidence
Ingest a coverage report (lcov/istanbul) when present — via `run -- pnpm test` or a
`--coverage <path>` input — and compute per-hunk: are the changed lines executed by
any test? Feeds evidence cards ("changed lines uncovered") and ranking (#3).

- Why: "tests pass" is weak evidence if the changed lines were never executed. This
  is the strongest deterministic trust signal we don't yet have.
- Effort: M. Format parsing is commodity; mapping hunks→lines we already do.

### 7. Single-file HTML cockpit
`human --format html`: one self-contained file (inline CSS/JS, no server, no CDN)
with collapsible hunks, lens filters, checkable queue items, and links between
queue ↔ evidence ↔ narrative claims. Markdown is fine in terminals; an HTML file is
shareable in Slack and dramatically more navigable for a 30-file diff.

- Effort: M. Pure renderer over `human_review.json` — zero analysis changes, and a
  natural prerequisite skeleton for any future hosted dashboard.

### 8. Time-budgeted review mode
`human --budget 15m` (or config): estimate per-item review cost (hunk size ×
risk class) and emit an explicit cut: "read these 4, skim these 6, safe to defer
the rest — here's why." Makes the implicit top-7 cut an honest, tunable contract.

- Effort: S. Mostly ranking annotation + render.

---

## P2 — depth and durability

### 9. Config/infra semantic facts
Same treatment Phase 3 gave schemas/tests, applied to: env var additions/removals,
CI workflow changes (new permissions, new secrets read), Dockerfiles, and SQL/
migration files (destructive ops flagged: DROP, column type changes). Each is a
small deterministic detector feeding existing risk lenses.

### 10. Team-shared feedback policy
The walkthrough's feedback memory is local. Add a committed, schema-validated
`review-surfaces.policy.yaml`: suppression rules with reasons and expiry, severity
overrides, required manual checks per path glob. Mergeable via PR so the team —
not one laptop — owns false-positive tuning. (Builds on the Phase 4 feedback files.)

### 11. Effectiveness eval harness
A fixture suite of seeded regressions (weakened test, breaking API change, sneaky
dependency, secret in diff) measuring: does the queue rank the seeded issue in the
top N? Run in CI as a regression gate on review quality itself, and publish the
score in the README. Strategic: it's how we prove the trust-layer claim and how we
safely tune ranking (#3) without vibes.

### 12. Provider-assisted intent synthesis
Already deferred with rationale (FB-2026-05-28-007). Worth doing after #1–#3:
richer intent extraction from sparse specs via the provider boundary, schema-bound,
with the existing verified/claimed trust marking. Raises `intent_mismatch.md`
quality, which is currently the thinnest surface.

---

## P3 — opportunistic

### 13. SARIF completion
`comment --format sarif` exists as a skeleton. Finishing it gets queue items as
native GitHub code-scanning annotations with near-zero ongoing cost. Do it
alongside #1 if cheap.

### 14. Editor integration
A VS Code panel reading `human_review.json` (queue, jump-to-hunk, accept/flag
writing the same feedback files as the walkthrough). High polish value, but L
effort and a new runtime to maintain — wait until the JSON contract has been
stable for a few milestones.

---

## Suggested sequencing

1. **Milestone "M6: PR surface"** — ideas #1 + #2 (+ #13 if cheap). One theme:
   the cockpit arrives in the PR and stays current across pushes.
2. **Milestone "M7: ranking & evidence"** — ideas #3 + #6 + #8. One theme: the
   top of the queue is trustworthy and the cut is explicit.
3. **Milestone "M8: fear-class facts"** — ideas #4 + #5 + #9. One theme: the
   change classes reviewers fear most become deterministic facts.
4. Promote #11 (eval harness) before any further ranking tuning beyond M7.

Existing discipline carries over unchanged: spec-first (promote chosen ideas to
ACIDs before implementation), deterministic evidence over LLM claims, mock provider
by default, dogfood every milestone on this repo.
