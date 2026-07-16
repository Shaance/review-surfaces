# Execplan: reviewer decision surface remediation

## Context

The live audit showed that review-surfaces can be schema-valid in fixtures yet
invalid on a real transcript, can select the wrong conversation with high apparent
confidence, and can overwhelm reviewers with mechanically correct but
approval-irrelevant information. The program must improve reviewer value without
weakening deterministic evidence, privacy, or local-first operation.

Authoritative requirements are recorded as `review-surfaces.REVIEWER_VALUE.*` in
`features/review-surfaces.feature.yaml`.

## Architecture decisions

1. **Decision projection, not pipeline replacement.** Keep the packet as the
   evidence ledger and derive a smaller reviewer surface through strict admission,
   severity, and root-cause rules.
2. **Separate compliance from PR risk.** Whole-repository requirement coverage is
   supporting evidence; only requirements affected by the reviewed range can
   influence the top decision surface.
3. **Offline conversation baseline.** Deterministically reconstruct final user
   intent, corrections, explicit constraints, agent claims, and observed tool
   results. Provider output enriches but does not create the baseline.
4. **Provenance-based discovery.** Editing/apply operations, session timing, and
   actor/event roles outrank raw path-string matches.
5. **Usefulness gates.** Real transcript fixtures and PR-shaped scenarios measure
   false blockers, independent-decision actionability, duplicate roots, report
   density, and artifact validity.

The user approved these decisions by accepting the complete audit remediation
proposal and asking for all milestones to be implemented and autolanded.

## Milestone 1 — trust foundation

**Goal:** Every live artifact is valid, bounded, role-correct, and severity-coherent.

Primary files:

- `src/methodology/methodology.ts`
- conversation adapters/contracts as needed for event-role classification
- `src/human/human-review.ts`
- `schemas/review_packet.schema.json`
- live-session regression fixtures/tests
- `features/review-surfaces.feature.yaml`

Build sequence:

1. Add failing real-event regressions for unbounded custom tool outputs and
   system/developer/generated-report contamination.
2. Bound validation claims before persistence and restrict claims/methodology
   picks to eligible actors and event kinds.
3. Make schema-comment severity depend on actual breaking semantics and reconcile
   blocker/question/comment counts.
4. Add a real CLI generation + `validate --surface all` regression.
5. Run focused tests, full local gate, real dogfood, test-quality review,
   simplify-triad, production review loops, and two clean simplification audits.
6. Open PR 1, autoland it, update local `main`, and reassess.

Exit criteria:

- the previously invalid live transcript shape produces schema-valid artifacts;
- generated/system/tool-output text does not appear as agent intent or claims;
- additive optional schema fields cannot create blocking comments;
- displayed blocker counts agree with every blocking surface;
- local gate and real diff dogfood are green and inspected.

## Milestone 2 — decision-first reviewer signal

**Goal:** The top surface contains every independent decision that can affect
approval exactly once, with exhaustive diagnostic context moved behind supporting
detail. Decision count follows the change; it is not a fixed top-N budget.

Primary files:

- `src/human/human-review.ts`
- `src/human/render.ts`
- `src/human/render-html.ts`
- semantic/API/architecture fact routing
- human surface contracts and schemas
- reviewer-value tests and rendered examples

Build sequence:

1. Introduce a deterministic decision projection/root-cause model.
2. Restrict top risk admission to PR-scoped evidence and affected requirements.
3. Distinguish public/persisted contracts from internal TypeScript exports.
4. Collapse duplicate path/root-cause findings and ordinary dependency edges.
5. Render verdict, intent, and all independent approval decisions before tours/maps.
6. Adapt wording density to the change and preserve full ledgers in supporting
   artifacts; only GitHub's physical comment limit may force a compact mode.
7. Run the milestone quality, dogfood, simplification, PR, and autoland loop.

Exit criteria:

- review findings precede reading order and maps;
- repository-wide partial counts do not drive the verdict;
- duplicate root causes do not occupy multiple top slots;
- internal exports and ordinary layer edges are not treated as public breakage;
- a large real PR preserves every independent decision while compacting prose and
  relocating diagnostics before approaching GitHub's physical comment limit.

Implementation status (2026-07-11):

- added a schema-backed decision projection with authoritative active intent,
  one finding per independent root cause, and explicit supporting-ledger counts;
- made verdict, blockers, trust, validation, and projection share one reviewed-range
  admission policy, including clean-worktree/current-head validation provenance;
- canonicalized public/persisted contract removals and kept internal exports and
  ordinary import edges outside the approval-changing projection;
- made untracked working-tree review bounded and consistent across changed-file and
  diff artifacts, with privacy-aware selection and an explicit incomplete-scope
  warning when files are omitted;
- rendered verdict → intent → findings before supporting machinery on Markdown,
  HTML, sticky, and PR-comment surfaces;
- decomposed admission, projection, presentation, and focused regression suites;
- explicitly deferred batching the bounded per-untracked-file Git diff subprocesses:
  the current 200-file / 10 MiB cap is correct and deterministic, while an in-process
  patch emitter would add path-quoting and binary-diff risk without reviewer-value gain.

## Milestone 3 — local-first conversation intelligence

**Goal:** A correct, useful conversation brief exists without a remote provider,
and session selection is honest about provenance.

Primary files:

- `src/conversation/analysis.ts`
- new narrowly named deterministic conversation brief module(s)
- `src/conversation/discovery.ts`
- adapters and normalized event contracts
- conversation presentation/renderers
- discovery and live-session fixtures

Build sequence:

1. Derive active user intent, later corrections, constraints, explicit non-goals,
   agent validation claims, and observed tool results from strict actor/event rules.
2. Merge provider enrichment over the baseline without weakening citations.
3. Replace path substring scoring with edit/tool provenance plus timing and weak
   match penalties.
4. Persist selection confidence and explain why a session was chosen.
5. Add wrong-session regressions using audit/report-output contamination.
6. Run the milestone quality, dogfood, simplification, PR, and autoland loop.

Exit criteria:

- mock/offline mode renders a useful cited conversation brief;
- provider failure preserves that brief instead of replacing it with an empty card;
- a later audit session mentioning every path cannot outrank the producing session;
- weak discovery renders an explicit inconclusive state.

Implementation status (2026-07-11): complete locally, pending PR/autoland.

- Added a deterministic, cited offline brief that preserves original intent,
  later corrections, constraints, non-goals, claims, and structured validation
  outcomes across provider failure and additive enrichment.
- Kept assistant validation claims separate from observations; observations now
  require adapter-owned process status joined to a recognized validation command,
  so invocations and result prose cannot manufacture proof.
- Replaced path-reference selection with exact producer provenance across Claude,
  Codex CLI, and Codex desktop `patch_apply_end` records; low-confidence or
  ambiguous candidates are rejected before normalization and their safe reasons
  persist into methodology artifacts.
- Real-diff dogfood selected this task's Codex producer with high confidence,
  retained the original audit goal plus the milestone/autoland refinement, and
  no longer classified shell startup prose as passing validation.

## Milestone 4 — usefulness evaluation

**Goal:** CI and dogfood catch reviewer-hostile output even when structural tests pass.

Primary files:

- benchmark/evaluation harness
- real-session sanitized fixtures
- reviewer-value score contract and schema
- local review/gate scripts and documentation
- generated example artifacts

Build sequence:

1. Add sanitized Claude/Codex/Cursor and PR-shaped cases covering the observed
   failure classes.
2. Score artifact validity, false blockers, actionability of every independent
   decision, duplicate root causes, density, severity coherence, and
   session-selection correctness.
3. Make deterministic regressions part of the local gate; keep subjective/manual
   scoring explicit and non-fabricated.
4. Refresh examples and docs through the real CLI.
5. Run full hardening, E2E dogfood, simplification stop criteria, PR, and autoland.

Exit criteria:

- the five initiating failures are encoded as real-workflow regressions;
- local gate fails for invalid or reviewer-hostile deterministic output;
- benchmark output distinguishes structural validity from reviewer usefulness;
- two consecutive final audits find no P0/P1 work that passes the
  anti-overengineering gates.

## Verification commands

At each milestone boundary, use the repository-approved entrypoints:

```bash
pnpm run local-review
pnpm run local-gate
node bin/review-surfaces.js validate .review-surfaces --surface all
```

When Corepack cannot resolve the pinned package manager without network access,
use the already-installed project binaries only for diagnosis; the milestone is
not complete until the normal `pnpm` entrypoints run successfully.

Every PR must also pass:

- focused regression tests for the milestone;
- full-diff simplify triad (correctness, efficiency, reuse);
- triggered maintainability-decomposition and test-quality-review;
- production review loops using the codex-reviewer rubric;
- live real-diff dogfood whose generated output is read, not merely validated;
- current-head GitHub checks, review threads, conflict state, and Codex clean
  signal under the autoland workflow.

## Decision log

- 2026-07-10: preserve the deterministic packet, add a decision projection.
- 2026-07-10: use four serial PRs; each must merge before the next starts.
- 2026-07-10: default offline operation must remain useful.
- 2026-07-10: real-session validity and reviewer-value metrics are release gates.
- 2026-07-10: iterative simplification stops only after two consecutive audits
  produce no actionable P0/P1 findings.
