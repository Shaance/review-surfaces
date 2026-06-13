# ci-trust uplift — goal contract

Status: **in progress** (started 2026-06-13). The seventh development uplift.

## Theme

Turn `review-surfaces` from a local-first packet generator into a
**CI-trustworthy gate** with leak-proof postable surfaces, strict schemas,
honest DX, and discoverable distribution — without any architecture shift.
Every item fits the existing pipeline (bug fixes, hardening, new
detectors/formats/flags, in-file extractions, doc/test additions). No rewrites,
no new frameworks, no dependency swaps.

## Grounding

A 73-finding discovery survey (ten parallel grounded audits + synthesis, run
2026-06-13) over the current tree. Three of the findings are
confirmed-by-reproduction bugs and led the prioritisation:

1. **Privacy ignore-filter fails open.** `filterIgnoredDiff`
   (`src/privacy/diff.ts:26`) parses the `diff --git` header with a greedy
   regex and *keeps* a section when the regex fails. A privacy-ignored file
   whose path is git-quoted or contains spaces (e.g. `secret café.env`) still
   leaks its `+API_TOKEN=…` lines into `diff.patch`. Reproduced live.
2. **`pending_review.json` is the only postable surface with zero
   redaction.** `src/render/draft-review.ts` interpolates suggested-comment
   bodies and the model summary with no `redactSecrets`, and
   `runCommentDraftReview` writes the payload to the artifact *and* dumps it to
   stdout. Every other postable surface (pr-comment, sticky, sarif, comment,
   md) redacts.
3. **`google_api_key` is `blocked:false`** (`src/privacy/secrets.ts:75`)
   against the in-file "all provider-token patterns are blocked:true"
   invariant — a live `AIza…` key is text-redacted but does not raise the
   remote-block signal, and it is the default provider's own key shape.

Plus: `human_review.schema.json` is `additionalProperties:true` in 55 places (a
bogus field + a typo'd `risk_lens_finding` validate clean); `review_packet`
schema has zero `maxItems`/`maxLength` caps (a ~700 KB packet still validates);
the gate never inspects `packet.risks` (no `--fail-on`); `action.yml` has no
`outputs`/step-summary/branding; the npm tarball ships 1.6 MB of compiled
`dist/tests`; `--help` omits eight real flags; the import graph re-spawns `git
cat-file` ~21× redundantly (6322 spawns on a 256-file repo); and ~10 proven
behaviours (PRIVACY.5, COLLECTOR.4/5, EVIDENCE.5, INTENT.3, CLI.3,
PROVIDERS.7-redaction) have no exact-ACID test, leaving `main` one empty-diff
run from a red strict self-dogfood gate.

## Execution convention (unchanged from prior uplifts)

- One PR per phase, branch `ci-trust-phase-<n>-<slug>`.
- **Phase 0** promotes every new requirement (ACID) into
  `features/review-surfaces.feature.yaml` and stages them in
  `review-surfaces.config.yaml` `quality_gate.allow_missing` (`max_missing`
  stays 0). Each later phase **removes its own ACIDs** from `allow_missing` in
  the PR that ships them. The gate must end at `allow_missing: []`.
- Every shipped requirement gets an exact-ACID-named test (the recurring
  red-main lesson: an impl-only requirement flips to "missing" on a later
  empty-diff run and reddens the strict gate).
- Per-phase loop: implement → simplify pass → `pnpm run local-gate` green →
  push → `@codex review` → resolve rounds → merge on clean verdict + green
  local gate.

## Reconciled ACIDs

The synthesis proposed numbers that collided with the live ledger; reconciled
against the real maxima (CLI .8, COLLECTOR .7, SCHEMA .3, DEP_FACTS .4,
HUMAN_REVIEW .21, DISTRIBUTION .13):

| Phase | Slug | New ACIDs | Also anchors (existing) |
| --- | --- | --- | --- |
| 0 | spec-promotion | *(stages all 19 below)* | — |
| 1 | privacy-leak-hardening | `PRIVACY.6` | `PRIVACY.5` |
| 2 | schema-strictness | `SCHEMA.4`, `.5`, `.6` | — |
| 3 | quality-gate-and-ci-surfaces | `QUALITY_GATE.1-3`, `ACTION_IO.1-3`, `DEP_FACTS.5` | — |
| 4 | cli-honesty | `CLI.9`, `.10` | `CLI.3`, `COLLECTOR.4`, `.5`, `INTENT.3`, `EVIDENCE.5` |
| 5 | human-render-polish | `HUMAN_REVIEW.22`, `.23` | — |
| 6 | head-tree-perf | `PERF.1`, `.2` | — |
| 7 | distribution-trim-and-docs | `DISTRIBUTION.14`, `.15` | `DOGFOOD.8`, `.9` |

`QUALITY_GATE`, `ACTION_IO`, and `PERF` are new `components` families;
`PRIVACY.6`/`SCHEMA.4-6` extend their existing `constraints` families.

## Phases

- **Phase 1 — privacy-leak-hardening** (`PRIVACY.6`). Fail closed in
  `filterIgnoredDiff` (reuse the quote-aware `parseDiffGitHeader` from
  `diff-hunks.ts`; drop a section whose header cannot be parsed into both
  paths). Redact `draft-review.ts` `commentBody`/`reviewBody`/summary and
  return a `blocked` flag; `google_api_key` → `blocked:true`; thread the
  excerpt block-signal through `resolveStructuredExcerpt`. Anchor `PRIVACY.5`
  (block-before-LLM) with an exact-ACID test. The one
  `runCommentDraftReview` stdout-suppression line lives in `cli/index.ts` and
  is therefore landed by Phase 4 (which owns that file).
  Files: `src/privacy/diff.ts`, `secrets.ts`, `src/render/draft-review.ts`,
  `src/human/hunk-excerpt.ts`, `render-html.ts` + tests.

- **Phase 2 — schema-strictness** (`SCHEMA.4-6`). Flip the human schema
  top-level + hot nested objects to `additionalProperties:false` behind reject
  tests; add `maxItems`/`maxLength` caps to the packet schema mirroring the
  `uncovered_lines`+`truncated` pattern; add the missing
  `pr_review_surface` version-const guard and hoist/guard the duplicated
  lens & evidence-kind enums to their runtime source of truth.
  Files: `schemas/*.json`, `tests/schema-contract.test.ts`.

- **Phase 3 — quality-gate-and-ci-surfaces** (`QUALITY_GATE.1-3`,
  `ACTION_IO.1-3`, `DEP_FACTS.5`). `--fail-on <severity>` risk gate
  (`gate.ts` + `config.ts`); deterministic `comment --format json` renderer
  and `all`/`packet --json` summary reading the packet; `action.yml`
  `outputs:` + `$GITHUB_STEP_SUMMARY` + `branding:`; major-version-downgrade
  dependency fact. Depends on Phase 4 (needs `cli/index.ts` wiring).
  Files: `src/core/gate.ts`, `config.ts`, `src/render/sarif.ts`, `packet.ts`,
  `src/risks/dependency-facts.ts`, `action.yml` + tests + (post-rebase)
  `cli/index.ts`.

- **Phase 4 — cli-honesty** (`CLI.9`, `.10`). Owns `cli/index.ts`. Reject
  unknown commands/flags with nearest-match suggestion (`KNOWN_FLAGS`
  allow-list); complete `--help` (every command + every flag, tested via an
  exported `COMMANDS` iteration); `displayPath` helper for outside-cwd `--out`;
  `errorMessage` import dedup; validate-policy message fix; the draft-review
  blocked-payload stdout suppression (consumes Phase 1's flag). Co-locates the
  existing-ACID test anchors (`CLI.3`, `COLLECTOR.4/5`, `INTENT.3`,
  `EVIDENCE.5`). Depends on Phase 1.

- **Phase 5 — human-render-polish** (`HUMAN_REVIEW.22`, `.23`). Lead test-plan
  rollup headings with the distinguishing field (no more 5 identical
  headings); strip doubled `.?` punctuation; relabel the empty
  `Risk: none` line; fix `collectCommits` first-tab truncation; in-file
  dedups (`isElevatedSeverity`, `isBlockingRiskLensFinding`).
  Files: `src/human/render.ts`, `human-review.ts`, `src/collector/git.ts`,
  `tests/human-review.test.ts`.

- **Phase 6 — head-tree-perf** (`PERF.1`, `.2`). Memoize the injected
  existence probe in `buildImportGraph`; precompute `areaIdsByGroupKey` in
  pr-scope; pre-sort the transitive-attribution BFS edge sets. Pure,
  output-identical, guarded by tests asserting the reduced work. Final phase →
  empties `allow_missing`. Depends on Phase 3 (shared dep-facts test file).
  Files: `src/collector/import-graph.ts`, `src/scope/pr-scope.ts`,
  `src/collector/collect.ts` + tests.

- **Phase 7 — distribution-trim-and-docs** (`DISTRIBUTION.14`, `.15`). Stop
  shipping `dist/tests` (narrow `files`/tsconfig) with a pack-manifest test;
  README "Use as a GitHub Action" `uses:` snippet + an exit-code table;
  reconcile the stale CHANGELOG uplift count; light `DOGFOOD.8/.9` SKILL
  section-presence assertions.
  Files: `package.json`, `tsconfig.json`, `README.md`, `CHANGELOG.md`,
  `tests/distribution.test.ts`.

## Conflict strategy (merge without conflicts)

Hot-file ownership is the backbone. Each hot file is owned by exactly one
phase:

- `cli/index.ts` → **Phase 4 only** (Phase 3 rebases onto a merged Phase 4
  before touching it).
- `features/review-surfaces.feature.yaml` + `review-surfaces.config.yaml` →
  **Phase 0 only** (each later phase removes only its own distinct
  `allow_missing` lines, order-independent).
- `schemas/*` + `tests/schema-contract.test.ts` → **Phase 2 only**.
- `src/human/render.ts` + `human-review.ts` + `src/collector/git.ts` →
  **Phase 5 only**.
- `README.md`/`package.json`/`tsconfig.json`/`CHANGELOG.md`/`tests/distribution.test.ts`
  → **Phase 7 only**.

Soft test-file overlaps are serialised by dependency edges:
`tests/provider.test.ts` (Phase 1 anchors PRIVACY.5, Phase 4 anchors
EVIDENCE.5) → Phase 4 depends on Phase 1; `tests/dependency-facts.test.ts`
(Phase 3 DEP_FACTS.5, Phase 6 PERF.2) → Phase 6 depends on Phase 3.

**Merge order:** `0 → {1, 2, 5, 7 in parallel} → 4 → 3 → 6`.

## Excluded (documented deferrals)

Dropped to keep the phasing conflict-free and the risk low; each can ride a
future cleanup/uplift:

- Per-subcommand `--help` routing (redesign of the flat help dispatch).
- `--quiet` inverse of `--verbose` (net-new output mode across many stdout
  sites; risks byte-stable output).
- `git cat-file --batch` blob reader (reworks git primitives + cli wiring; the
  Phase 6 memo captures most of the spawn win deterministically).
- `safeJsonParse` / `isRecord` / `seqId` helper consolidations (mechanical,
  no behaviour/ACID value, churn on hot files).
- `runAll` cache-reuse in-file extraction (pure refactor on the hottest file).
- A dedicated `tests/guards.test.ts` (only the `errorMessage` dedup ships).
- `diff-stats` surface (spans four files across three phases' ownership).
- Stage-YAML (intent/evaluation/…) schema validation in `validate` (effort-L,
  spans Phase 2 + Phase 4 ownership; borders on a pipeline change).
- The `head-import-graph-rebuilt-3x` reuse (needs `cli/index.ts` wiring; the
  Phase 6 memo is the safer, larger win).

## Success criteria

- All 19 staged ACIDs land phase by phase; `allow_missing` ends `[]`,
  `max_missing: 0`.
- The three confirmed leaks are closed with reproduction tests; no postable or
  persisted surface emits an unredacted secret.
- `validate --surface human` rejects an unknown property; the packet schema
  caps agent-influenceable arrays.
- `review-surfaces all --fail-on high` and a machine-readable JSON summary
  work; `action.yml` declares outputs + branding + a step summary.
- `--help` lists every command and flag (asserted by test); unknown flags are
  rejected with a suggestion; outside-cwd `--out` prints clean paths.
- The npm tarball carries no `dist/tests`; README documents Action usage + exit
  codes.
- Post-merge empty-diff `local-gate` on `main` stays green throughout.
