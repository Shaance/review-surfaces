# Next-Value Brainstorm — June 2026

Status: brainstorm / pre-spec. Nothing here is committed work until promoted into
`features/review-surfaces.feature.yaml` as Acai requirements. Execution contract:
`NEXT_VALUE_UPLIFT_GOAL.md` (covers ideas 1–12; the P3 items are out of scope).

Each idea carries an **Approach** block: the recommended direction, the modules to
build on, and the pitfalls to avoid. Implementers own the details; the approach is
the contract for *how* the idea fits the existing architecture.

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
`.review-surfaces/` directory as a workflow artifact.

- Why now: distribution. Every other idea multiplies in value once the surface is
  in the PR itself. Also the most credible demo for adoption outside this repo.
- Constraints to keep: strict postability gate, redaction before render, never
  auto-posting suggested comments (sticky summary only; drafts stay drafts).
- Effort: M (action plumbing, sticky-comment upsert, idempotency on re-runs).

**Approach.** Do not start from scratch: this repo already runs a repo-local sticky
comment workflow (`.github/workflows/pr-review-comment.yml`, shipped as
`PROVIDERS.6`) with the hard parts solved — base-controlled `pull_request_target`
checkout so PR code never touches the write token, marker-based upsert
(`STICKY_MARKER` in `src/render/comment.ts`), symlink/realpath defenses, and a
best-effort posting step that never fails the check. The work is to *generalize* it:

1. Extract the steps into a composite action (`action.yml` at repo root, published
   from this repo) with inputs for provider (default `mock` — a consuming repo must
   get full value with zero secrets), base/head, output dir, and comment top-N. The
   repo-local workflow becomes a thin consumer of the action — one implementation,
   dogfooded here.
2. Change the comment body source: today it renders from the PR sidecar
   (`pr_review_surface.json` via `src/render/pr-comment.ts`); the sticky should
   render from `human_review.json` — add a compact "sticky summary" renderer next
   to the existing ones in `src/human/render.ts` (verdict, top queue items with
   their existing hunk excerpts, trust counts, link to the uploaded artifact).
   Reuse the rollup logic from `src/human/rollup.ts` so the comment stays short.
3. Upload `.review-surfaces/` with `actions/upload-artifact` under a stable name
   keyed by PR number (this is also the state mechanism idea #2 needs).
4. Keep the posting step exactly as conservative as the current one: trusted `gh`
   over a generated file, never PR code holding the token. For fork PRs, generate
   and upload the artifact but skip posting (same stance as today).

Pitfall: don't fork the render path. The Action must call the same CLI commands a
local user runs (`all` → `comment`/new sticky renderer) so CI and local artifacts
can never disagree.

### 2. Re-review delta on push
`since_last_review.md` already computes improved/regressed/new/resolved when a
prior packet exists. Wire it into the PR loop: on each push the sticky comment
leads with **"what changed since your last review"** instead of restating everything.

- Why: re-review is where human attention actually collapses on agent-written PRs —
  round 4 of a Codex-style loop gets skimmed. This makes iteration rounds cheap.
- Effort: M, mostly state/plumbing on top of idea #1. Ship as the second half of
  the same milestone.

**Approach.** The comparison engine exists (`src/dogfood/compare.ts` feeds the
`since-last-review` command); the entire job is materializing the *previous*
packet in CI. Recommended state mechanism, in order of preference:

1. **Workflow artifact:** before generating, the action downloads the most recent
   `review-surfaces-pr-<n>` artifact from a previous run on the same PR
   (`gh api /repos/{repo}/actions/artifacts` filtered by name), unpacks it to a
   temp dir, and passes it as the prior-packet input. Artifacts expire (90 days
   default) — treat "no prior artifact" as the first-review case, never an error.
2. Embed a small fingerprint in the sticky comment itself (HTML comment with the
   prior run id + finding keys) as a fallback pointer when the artifact is gone.

Delta semantics to get right: compare against the packet from the last *posted
sticky*, not the last push — if a push fails midway, the next successful run should
still diff against what the reviewer last saw. Lead the sticky with the delta
section (resolved / regressed / new), collapse the unchanged remainder under a
`<details>` block. Item identity across runs must use stable finding keys (rule id
+ file path + anchor), not array positions — check what `compare.ts` keys on today
and harden if it's positional.

### 3. Queue ranking v2 (recorded as FB-2026-06-09-001)
Connect evidence we already collect to the ranking: a changed impl path whose
focused tests also changed *and* have a passing current-head transcript ranks lower;
a changed impl path with no test changes and no transcript ranks higher. Add a
visible "why ranked here" line per queue item.

- Why: the queue is the product. Ranking quality is what decides whether reviewers
  trust the top-7 cut in `human_review.md`.
- Effort: M. Deterministic, no provider work. Already has a dogfood finding and a
  defer note pointing at it.

**Approach.** Build it as a pure scoring pass over inputs that already exist, not a
new collector:

1. Compute a per-changed-impl-path **evidence score** from three deterministic
   signals: (a) did focused tests change alongside it — map test files to impl
   paths via import statements in the test file (the indexer in `src/indexer/`
   already lists test files; parse imports with the same `ts.createSourceFile`
   approach `src/risks/semantic-diff.ts` uses), falling back to path/basename
   heuristics; (b) is there a passing current-head command transcript whose
   classified scope (`src/commands/classify.ts`) covers those tests; (c) coverage
   facts once idea #6 lands. Higher evidence → lower urgency, and vice versa.
2. Apply the score as a *modifier* on the existing rank in
   `src/human/human-review.ts`, not a replacement — semantic-risk class remains
   the primary key, evidence breaks ties and demotes well-evidenced items.
3. Add `ranking_reasons: string[]` to the queue item in `src/human/contract.ts`
   and `schemas/human_review.schema.json` (strict schema: the field is required),
   rendered as one plain-language line per item ("no test changes touch this file;
   no transcript exercises it").

Pitfalls: determinism — identical inputs must produce byte-identical ordering
(stable tie-break on file path; `pnpm run determinism-check` must stay green). And
never let "evidence present" hide an item entirely; it moves down, it doesn't
disappear. Do not tune weights beyond the obvious before idea #11's harness exists.

---

## P1 — widen the facts reviewers fear most

### 4. Dependency / supply-chain lens
Semantic facts for `package.json` / lockfile changes: new dependencies (with age,
weekly downloads, install scripts), major version bumps, removed pins, transitive
additions. Render as a dedicated risk lens — agents adding a dependency is exactly
the "overreach" class the positioning promises to catch.

- Effort: S–M offline (lockfile diff is deterministic); registry metadata is an
  optional enrichment behind the existing provider boundary.

**Approach.** Model it directly on `src/risks/semantic-diff.ts`: a new
`src/risks/dependency-facts.ts` detector that takes base/head file contents (via
`readFileAtRef` in `src/collector/git.ts`) and emits typed facts.

1. Scope v1 to what's deterministic and offline: diff `package.json` (deps added/
   removed/moved between dep groups; semver-major bumps; range loosened, e.g.
   pinned → caret) and the lockfile for transitive additions and
   `requiresBuild`/install-script flags. Parse pnpm-lock.yaml first (it's what this
   repo dogfoods), then package-lock.json; treat unsupported lockfiles as "no
   lockfile facts" — never guess.
2. Emit into the existing risk plumbing (`src/risks/risks.ts` / `pr-risks.ts`) with
   a new lens id (`supply_chain`) added to the lens config, so rendering in
   `risk_lenses.md`, the queue, and suggested comments is free.
3. Severity heuristics, deterministic only: new dep with install scripts > new dep
   > major bump > range loosening. Each fact's queue language names the package and
   the concrete change ("adds `leftpad@2` with a postinstall script").
4. Registry metadata (package age, downloads): **defer entirely** in v1. When it
   comes, it goes behind the provider boundary like all network enrichment, and it
   adorns facts — it never creates or removes them.

### 5. Blast-radius facts
Phase 3.5 already parses the TS API surface with the AST. Extend it: for each
changed/removed export, find in-repo references and attach "used by N files
(top: …)" to the queue item and contract risks. Turns "signature changed" into
"signature changed and 14 call sites depend on it."

- Effort: M. High payoff per queue item.

**Approach.** Stay at module-graph altitude; do not reach for the TS type checker
(a full program is slow, needs tsconfig resolution, and adds nondeterminism risk).

1. Build a one-pass import graph: for every indexed source file (the indexer
   already enumerates them), parse with `ts.createSourceFile` (already a runtime
   dependency since Phase 3.5) and record import/re-export specifiers → resolved
   repo-relative module paths. Resolve specifiers with simple suffix rules
   (`./x` → `x.ts`/`x/index.ts`); skip path-alias resolution in v1, count it as a
   documented bound like the regex-era extractor bounds were.
2. For each changed/removed export from the existing surface diff, the blast
   radius = files importing that module which reference the symbol name (named
   import directly; namespace import → scan for `ns.symbol`). Attach
   `used_by: { count, top: [paths] }` (top 3–5, alphabetical for determinism).
3. Feed it to queue language and ranking (#3): a removed export with 14 importers
   outranks one with zero. Cache parsed files within the run — the graph is built
   once, both this and #3's test-import mapping consume it (extract a shared
   `src/collector/import-graph.ts`).

Pitfall: bound the work. Parse only indexed source files, skip generated dirs via
the existing ignore rules, and record a truncation note if the repo exceeds a file
cap — silent partial graphs would make "used by 0" a false reassurance.

### 6. Coverage-delta evidence
Ingest a coverage report when present and compute per-hunk: are the changed lines
executed by any test? Feeds evidence cards ("changed lines uncovered") and
ranking (#3).

- Why: "tests pass" is weak evidence if the changed lines were never executed. This
  is the strongest deterministic trust signal we don't yet have.
- Effort: M. Format parsing is commodity; mapping hunks→lines we already do.

**Approach.** There's precedent for exactly this shape: `src/tests-evidence/junit.ts`
already ingests an external test-result format as evidence. Mirror it:

1. New `src/tests-evidence/lcov.ts` parsing lcov (`SF:`/`DA:` records) — lcov
   first because every major JS runner (v8, istanbul, vitest, jest) can emit it;
   other formats can come later behind the same internal model
   (`Map<filePath, Set<coveredLine>>`).
2. Input channels: explicit `--coverage <path>` flag, plus auto-detect
   `coverage/lcov.info` when present. Record the report's provenance (path, hash,
   whether it postdates the head commit) in the manifest — a stale report must be
   marked stale, not trusted (`src/collector/artifact-provenance.ts` is the
   existing pattern for this).
3. Intersect with changed lines from `src/collector/diff-hunks.ts`: per hunk,
   covered/uncovered/partial. Emit evidence cards ("12 of 40 changed lines in
   `x.ts` are executed by tests") and feed the per-path evidence score in #3.
4. Honest-negative rule: *no report* renders as "no coverage evidence", which is
   different from "uncovered". Never penalize a repo for not providing coverage;
   only use it when it exists.

### 7. Single-file HTML cockpit
`human --format html`: one self-contained file (inline CSS/JS, no server, no CDN)
with collapsible hunks, lens filters, checkable queue items, and links between
queue ↔ evidence ↔ narrative claims. Markdown is fine in terminals; an HTML file is
shareable in Slack and dramatically more navigable for a 30-file diff.

- Effort: M. Pure renderer over `human_review.json` — zero analysis changes.

**Approach.** Treat it as a strict sibling of the markdown renderer: a new
`src/human/render-html.ts` that consumes the `HumanReviewModel` from
`src/human/contract.ts` and *nothing else* — if the HTML needs data the model
lacks, the model (and strict schema) grows first, so JSON/MD/HTML can never
diverge.

1. Zero dependencies: a template-literal renderer emitting one `.html` file with
   inline CSS and a small amount of vanilla JS (collapse/expand, lens filter,
   localStorage-persisted checkboxes). No framework, no build step, no CDN —
   the file must open from disk offline and be safe to attach in Slack.
2. Escape everything interpolated (hunk excerpts contain arbitrary diff text;
   build one `esc()` helper and use it on every interpolation) and re-run the
   redaction pass on render like the markdown renderers do.
3. Layout: verdict + narrative header, queue as the spine (each item: excerpt,
   evidence, ranking reason, link to its evidence card), lenses as filters rather
   than separate pages. Keep it printable.
4. Determinism check applies: byte-identical output for identical models — no
   timestamps in the HTML.

### 8. Time-budgeted review mode
`human --budget 15m` (or config): estimate per-item review cost and emit an
explicit cut: "read these 4, skim these 6, safe to defer the rest — here's why."
Makes the implicit top-7 cut an honest, tunable contract.

- Effort: S. Mostly ranking annotation + render.

**Approach.** A pure post-ranking annotation pass in `src/human/human-review.ts`:

1. Deterministic cost model, deliberately crude in v1: minutes ≈ base cost per
   item + hunk lines × per-line factor, weighted by risk class (contract changes
   read slower than rename churn). Round to whole minutes; document it as an
   estimate, not a promise.
2. Greedy fill by rank order into `read` until the budget is ~70% consumed, then
   `skim` (read the excerpt, not the file) to 100%, remainder `defer` — each defer
   carries its reason from the evidence score ("well-evidenced: focused tests
   changed and pass"). Never defer an item carrying a blocker; blockers are
   budget-exempt and the render says so.
3. Surface as a `review_plan` section on the model (strict schema grows), rendered
   in `human_review.md` and the HTML cockpit. Parse `15m`/`1h` durations; config
   default off.

---

## P2 — depth and durability

### 9. Config/infra semantic facts
Same treatment Phase 3 gave schemas/tests, applied to env vars, CI workflows,
Dockerfiles, and SQL/migrations — each a small deterministic detector feeding
existing risk lenses.

**Approach.** A family of independent detectors in `src/risks/` following the
`semantic-diff.ts` shape (base/head content in, typed facts out), each small enough
to review alone:

- **Env:** new/removed `process.env.X` references in changed code and `.env*`
  example-file key changes → "introduces env var `X` (no default)".
- **CI workflows:** for changed `.github/workflows/*`, diff the parsed YAML for
  `permissions:` broadening, new `secrets.*` references, new `pull_request_target`
  triggers, and unpinned third-party actions. This class feeds the security lens
  and is exactly where agent overreach is most dangerous.
- **Dockerfile:** new `RUN curl | sh` patterns, base-image change, dropped `USER`.
- **SQL/migrations:** flag destructive statements (`DROP TABLE/COLUMN`,
  `ALTER ... TYPE`, `TRUNCATE`, `DELETE` without `WHERE`) in changed `*.sql` /
  migration-dir files. Regex altitude is fine here — flagging for human attention,
  not proving semantics; say so in the fact language.

Each detector routes facts into existing lenses (security/privacy, cache/
provenance) rather than inventing new surfaces. Ship them as separate commits so a
noisy detector can be reverted alone, and extend the #11 fixtures with one seeded
case per detector.

### 10. Team-shared feedback policy
The walkthrough's feedback memory is local. Add a committed, schema-validated
`review-surfaces.policy.yaml`: suppression rules with reasons and expiry, severity
overrides, required manual checks per path glob. Mergeable via PR so the team —
not one laptop — owns false-positive tuning.

**Approach.** Compose with, don't replace, the Phase 4 feedback engine
(`src/feedback/feedback.ts`):

1. New `schemas/review_policy.schema.json` + loader (`src/feedback/policy.ts`).
   Every suppression requires `reason` and an absolute `expires` date; an expired
   rule is not silently dropped — it renders as its own finding ("policy
   suppression for X expired 2026-08-01"), which is how the policy file stays
   maintained.
2. Precedence: committed policy > local feedback files > defaults. Policy
   suppressions demote (downgrade + annotate "suppressed by policy: <reason>"),
   they never delete — same non-destructive stance the feedback engine already
   takes.
3. Match rules on the stable finding keys from #2 (rule id + path glob), not
   free text. Validate via `validate --surface` so a malformed policy fails loudly.
4. Natural follow-on (can be deferred): `review` walkthrough offers "promote this
   false-positive decision to team policy", writing the YAML entry for the human
   to commit. This is also the right home for the long-deferred `decision_policy`
   question from Phase 4 — resolve it here instead of keeping it open.

### 11. Effectiveness eval harness
A fixture suite of seeded regressions measuring: does the queue rank the seeded
issue in the top N? Run in CI as a regression gate on review quality itself.
Strategic: it's how we prove the trust-layer claim and how we safely tune ranking
without vibes.

**Approach.** The pipeline reads git refs, so fixtures must be real repos — but
committed fixture repos are miserable to maintain. Recommended: **programmatic
fixtures.**

1. A fixture builder for tests: creates a temp git repo, writes a small base
   project, commits, applies a seeded mutation, commits — then runs the real
   pipeline (`--provider mock`) against base..head and asserts on
   `human_review.json`. Each case is ~30 lines of builder calls, fully readable
   in the test file.
2. Seed one case per fact class we claim to catch: weakened test (removed
   assertion / added `.skip`), breaking API change with call sites, sneaky new
   dependency with install script, secret in diff, uncovered changed lines (with
   a synthetic lcov), destructive migration, CI permission broadening. Plus
   **negative fixtures** — benign rename/format-only changes that must NOT rank
   in the top N, so the gate also catches noise regressions.
3. Assertion shape: "finding with key K appears in the top N of the queue" and
   "no finding above severity S for the benign cases". Keep N generous (top 10)
   so the gate catches real regressions without freezing every ranking tweak.
4. Run inside `pnpm run test` (it's just tests) — CI gating is then automatic.
   Emit a small `eval_scoreboard.json` (cases passed / total per class) so the
   README can cite a concrete number later.

Sequencing note: this lands **before** further ranking tuning (it's Phase 3 in the
goal contract for exactly that reason).

### 12. Provider-assisted intent synthesis
Already deferred with rationale (FB-2026-05-28-007). Richer intent extraction from
sparse specs via the provider boundary, schema-bound, with the existing
verified/claimed trust marking. Raises `intent_mismatch.md` quality, which is
currently the thinnest surface.

**Approach.** Reuse the Phase 2 narrative machinery wholesale — it solved this
exact trust problem once already:

1. Provider request (via `src/llm/provider.ts`, all three providers) takes the
   indexed spec/doc excerpts and proposes *candidate* requirements:
   `{statement, anchors[], confidence}` — schema-bound like the narrative, with
   anchors restricted to the same allowlist mechanism (`src/core/anchor-tokens.ts`:
   spec sections, doc files, ACIDs).
2. Deterministic validation: a candidate whose anchors resolve becomes a
   `claimed` requirement rendered distinctly in `intent.yaml` /
   `intent_mismatch.md`; invalid anchors → demoted to open questions, never
   dropped silently. Provider candidates **never** change requirement coverage
   status or the verdict — they widen what the human is asked to confirm, exactly
   like narrative claims never touch blockers.
3. Deterministic extraction in `src/intent/intent.ts` remains the spine and the
   fallback; the agent-file provider gets the same contract so a coding agent can
   contribute hypotheses offline.
4. Dogfood check that decides success: run against a deliberately sparse spec
   fixture (an #11 case) and confirm `intent_mismatch.md` asks materially better
   questions than the deterministic baseline.

---

## P3 — opportunistic (out of scope for the current goal contract)

### 13. SARIF completion
`src/render/sarif.ts` exists as a skeleton. Finishing it gets queue items as native
GitHub code-scanning annotations with near-zero ongoing cost. Direction when picked
up: map queue items to SARIF results with stable rule ids (same finding keys as
#2/#10), wire `comment --format sarif` output into the idea-#1 action as an
optional upload step.

### 14. Editor integration
A VS Code panel reading `human_review.json` (queue, jump-to-hunk, accept/flag
writing the same feedback files as the walkthrough). High polish value, but L
effort and a new runtime to maintain — wait until the JSON contract has been
stable for a few milestones. Direction when picked up: the extension is a pure
consumer of `human_review.json` + writer of `feedback/*.yaml`; no analysis logic
crosses into the extension.

---

## Suggested sequencing

1. **Milestone "M6: PR surface"** — ideas #1 + #2. One theme: the cockpit arrives
   in the PR and stays current across pushes.
2. **Milestone "M7: ranking & evidence"** — ideas #3 + #6 + #8. One theme: the
   top of the queue is trustworthy and the cut is explicit.
3. **Eval harness** — idea #11, pulled ahead of further fact expansion so ranking
   changes land against a regression gate.
4. **Milestone "M8: fear-class facts"** — ideas #4 + #5 + #9. One theme: the
   change classes reviewers fear most become deterministic facts.
5. **HTML cockpit** — idea #7, placed after the fact phases on purpose: by then
   the model carries ranking reasons, the budget cut, coverage evidence, and the
   new fact classes, so the cockpit renders all of it on day one.
6. **Policy + intent** — ideas #10 + #12.

Existing discipline carries over unchanged: spec-first (promote chosen ideas to
ACIDs before implementation), deterministic evidence over LLM claims, mock provider
by default, dogfood every milestone on this repo.
