# Agent goal: open-source readiness uplift, one PR per phase

Goal: make `review-surfaces` deliver value in the first five minutes on a **stranger's repository** — no Acai specs, no config, no prior context — and ship the repo hygiene required to open-source it. Each phase is its own PR, simplified, reviewed, and landed on `main` before the next begins (same discipline as `VISUAL_VALUE_UPLIFT_GOAL.md`).

This builds on the three completed uplifts (PRs #47–#69). Nothing here may regress them: the PR surface, queue ranking v2, the eval harness, the cockpit, the change map, drift facts, and the rounds trend are the foundation.

Use these as the contract:

- This file's **Cold-start evidence log** below — every fix in Phases 1–2 traces to an observed failure, not speculation.
- `features/review-surfaces.feature.yaml` — the requirements ledger. **Phase 0 creates the spec entries for this work.** Preserve Acai IDs in tests, notes, and artifacts.
- `AGENTS.md` and `.agents/skills/composed-review-loop/SKILL.md` — working rules and the review/landing workflow.

## Standing constraints

- Everything runs locally with `--provider mock` (network: git only). The merge gate is a clean review verdict plus `pnpm run local-gate` green.
- Byte-deterministic artifacts, redaction before every render, model-and-strict-schema-grow-first.
- **New standing rule for this uplift:** every heuristic that encodes *this repo's* layout (directory names, file conventions, schema locations) must either be derived from the target repo's own signals or degrade to an honest generic answer. The cold-start log shows three places this rule is currently violated.

## Cold-start evidence log (2026-06-11)

Method: built `main`, shallow-cloned `sindresorhus/got` (mid-size OSS TypeScript repo, no Acai specs, no config), ran `all --base HEAD~3 --head HEAD` with the mock provider, then `human --format html` and `validate --surface all`. Total packet time: ~5.5s. What worked: zero-config run succeeded end-to-end; change map, blast-radius halo, reading order, suggested comments, trust audit, and the HTML cockpit all rendered. The failures:

1. **`validate` is broken outside this repo (hard bug).** `validate --surface all` failed with `ENOENT: …/got/schemas/review_packet.schema.json` — schema paths resolve relative to the user's CWD, not the installed package. Any external user's first `validate` fails.
2. **Reading order misclassifies core source as "config or docs — read last".** `categoryOf()` in `src/human/change-graph.ts:242` hardcodes `src|bin|lib` as implementation; got's `source/` falls through to `config`. The tour told the reviewer to read `source/core/index.ts` (the heart of the change) *last*.
3. **False-positive "exported API signature changed".** A doc-comment-only addition inside the `PaginationOptions` type (`source/core/options.ts:796-797`, two TSDoc lines) was reported as a signature change, became the #1 "Review first" item, fired the API-contract lens, and generated a blocking suggested comment. The semantic differ compares printed node text including trivia.
4. **Spec-less repos drown in spec-shaped noise.** With zero Acai specs, every changed-file cluster fires a "Possible overreach: does not map to any requirement" finding (OVERREACH-001..003 covered 100% of the diff), three of six author questions were "resolve this intent gap", and a review-queue item's action was "map the changed file to an Acai requirement" — meaningless instructions in a repo that has never heard of Acai. The honest single question ("No Acai requirements were indexed; confirm intended task scope") already exists in `src/intent/intent.ts:183` but is buried under the per-cluster noise.
5. **Distribution gap (not a bug, a blocker).** The package is publish-ready (`bin`, `files`, `prepublishOnly`, no `private` flag) but unpublished — there is no `npx` path; the cold-start test required building from source. No LICENSE file exists. The README assumes Acai conventions, never states the TS/JS-first analysis scope, and shows none of the visuals shipped in #63–#69.

## Phase 0 — spec promotion (one PR, prerequisite)

Promote the work below into Acai requirements in `features/review-surfaces.feature.yaml`. Suggested families: `COLD_START.*` (Phases 1–2) and `DISTRIBUTION.*` (Phase 3) — reuse existing families where one fits (the validate fix may belong in an existing `VALIDATE.*`/`SCHEMA.*` family; resolve at promotion time as in prior uplifts). Acceptance criteria come from the evidence log: each Phase 1–2 requirement cites the observed failure it closes. Stage new ACIDs in `quality_gate.allow_missing` (keep `max_missing: 0`); each phase PR removes the ACIDs it ships; the gate is back to `allow_missing: []` when the final phase lands.

## Phases (strict order, one PR each)

1. **Cold-start correctness** — fix the three observed bugs.
   - *Schema resolution:* `validate` (and any other schema consumer) resolves `schemas/` relative to the package root (e.g. from `__dirname`/`require.resolve`), never the CWD. Regression test runs validate from a temp CWD outside the repo.
   - *Source-root detection:* `categoryOf()` derives implementation roots from the target repo's own signals — `tsconfig.json` `rootDir`/`include`, `package.json` `main`/`exports`/`files`, and as fallback "top-level dirs containing a majority of non-test `.ts/.js` files" — instead of the hardcoded `src|bin|lib` list. `source/` in got must classify as implementation. The same detection feeds the change-map clusters so map and tour stay in agreement (the Phase 2 hard rule from the visual uplift). Deterministic: detection reads committed files only, sorted iteration.
   - *Trivia-immune API diff:* the exported-API differ in `src/risks/semantic-diff.ts` compares comment-stripped, whitespace-normalized signatures (print the node via the TS printer with comments removed, or compare structural members). Seeded eval fixture: doc-comment-only edit inside an exported type asserts **no** `signature changed` fact (the got case, reduced).
   - Hard rule: each fix lands with a test named for its ACID reproducing the cold-start failure first.

2. **Spec-less mode** — when zero Acai specs are indexed, the packet stops speaking Acai.
   - One explicit, schema-visible mode flag (e.g. `intent.spec_mode: "acai" | "none"`), derived deterministically from `specCount === 0`.
   - In `none` mode: suppress per-cluster overreach findings and per-file "no requirement mapping" questions/actions (the existing single open question from `src/intent/intent.ts:183` is the only spec-shaped output); the review-queue "map to an Acai requirement" action and the intent-mismatch overreach section are replaced by a one-line honest note ("no requirement spec configured — intent checks limited to docs/constraints"). Renderers (md, html, sticky, PR comment) hide empty spec-coupled sections rather than rendering "0 requirement result(s)".
   - What must NOT change in `none` mode: test-weakening detection, trust audit, semantic facts, coverage, change map, reading order, drift — the no-spec value proposition is exactly these.
   - Hard rule: this is presentation/derivation logic, not a second pipeline — same packet schema, the flag and suppressions are model-level so every renderer inherits them. Dogfood: re-run the got cold-start; the packet must read as if the tool were designed for spec-less repos.

3. **Distribution and repo hygiene** — the literal open-sourcing PR.
   - Add a LICENSE (owner choice — default MIT unless told otherwise) and minimal CONTRIBUTING.md (pnpm setup, `local-gate`, `local-review`, PR expectations).
   - Move internal process docs (`CODEX_GOAL.md`, `HUMAN_REVIEW_UPLIFT_GOAL.md`, `NEXT_VALUE_UPLIFT_GOAL.md`, `VISUAL_VALUE_UPLIFT_GOAL.md`, this file, `docs/*brainstorm*`, `README.bootstrap.md`) to `docs/history/` with a short framing README ("this tool was built by agents and reviewed with itself" — it is a selling point, not clutter). Update any inbound references.
   - README rewrite for the stranger: lead with the three trust questions and an `npx review-surfaces all --base origin/main --head HEAD` quickstart that works on a spec-less repo (true after Phases 1–2); a "what you get" tour with **screenshots** of the cockpit, change map, and sticky comment from a real run; an explicit scope statement (analysis depth is TS/JS-first: import graph and API diff are TypeScript; coverage via lcov and test-weakening are language-agnostic); Acai specs introduced as the optional power-user layer, not the prerequisite.
   - Verify `pnpm pack` output installs and runs globally from the tarball in a temp dir (`COLD_START` smoke test in the local gate). Actual `npm publish` is the owner's manual step — prepare it, do not run it.

4. **Showcase (optional tail, separate PR).** A `docs/example/` with committed sample artifacts from a real external-repo run (redacted, deterministic inputs vendored as a fixture) so people can read a `human_review.md` and open a `human_review.html` before installing; link from the README. Skip if Phase 3's screenshots already feel sufficient.

## Per-phase loop

Identical to `VISUAL_VALUE_UPLIFT_GOAL.md`: branch `oss-phase-<n>-<slug>` from fresh `origin/main`; implement with ACID-named tests; `pnpm run local-gate` green; dogfood via `pnpm run local-review` **plus, for Phases 1–2, the external cold-start re-run** (clone or reuse a pinned-SHA `got` checkout, run `all`/`human --format html`/`validate`, read the output as a stranger would); remove the phase's ACIDs from `allow_missing`; simplify pass; PR with phase number, ACIDs, validation commands, dogfood verdict; autoland per repository gates; next phase only after merge.

## Success condition

All phases merged; `quality_gate` back to `max_missing: 0, allow_missing: []`. A user with no context can run `npx review-surfaces` (or the packed tarball) on a TypeScript repo with no specs and no config and get: a packet with zero Acai-shaped noise, correct reading order for that repo's layout, no trivia false positives, a working `validate`, a LICENSE, and a README whose first screen shows them what they just got.
