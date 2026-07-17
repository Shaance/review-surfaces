# Execplan: simplification and reviewer usefulness

## Context

The post-uplift live audit found that review-surfaces is defensively correct but
still spends reviewer attention on mechanically true, low-value material. The
exact `2076964..171b414` range reproduces the main failures: a 527-line human
report, the review queue at line 233, and two internal TypeScript modules admitted
as high-priority compatibility findings solely because they have in-repo importers.

This program keeps the deterministic packet as the evidence ledger while making
reviewer usefulness, architectural compression, traceability, artifact freshness,
and iteration cost first-class quality concerns.

## Program decisions

1. Deliver serial milestones and land each one before reassessing the next.
2. Keep full evidence in machine and standalone artifacts; budget the default
   human surface around decisions and actions.
3. Treat package entry points, CLI/action contracts, persisted schemas, and
   configured contract paths as explicit surfaces. An ordinary export or importer
   is supporting evidence, not proof of a broken caller.
4. Replace heuristic requirement proof with explicit ownership and traceability;
   do not encourage ACID strings in implementation code as evidence.
5. Split orchestration by stable stages and behavior contracts, never by line
   count alone.
6. Preserve mandatory privacy, schema, determinism, exact-head, and evidence gates
   while introducing cheaper normal-development test lanes.

## Milestone 1: reviewer usefulness and adaptive attention

- Add curated usefulness judgments and metrics for precision, duplicate roots,
  actionability, first-action position, and postable comments.
- Replace importer-count admission with explicit contract-surface evidence.
- Put every independent approval decision before tours and exhaustive
  ledgers. Collapse duplicate roots and supporting diagnostics, never a distinct
  decision merely because the change is large.
- Reproduce `2076964..171b414` and require no internal compatibility finding, a
  decisions near the top, and a primary surface whose prose adapts before the
  physical GitHub comment limit is reached.

## Milestone 2: ownership and traceability

- Introduce one primary review-area owner per file with optional secondary tags.
- Add an explicit requirement → implementation → test traceability manifest.
- Make behavioral evidence and current-head command results the proof boundary.
- Remove overlapping config ownership and ACID-string-in-source recommendations.

## Milestone 3: orchestration and artifact trust

- Extract verdict/admission, queue ranking, trust projection, question/comment/test
  synthesis, CLI command handlers, and artifact/provenance loading
  behind small contracts.
- Add per-stage timings, typed degradation diagnostics, and an artifact-status
  command that reports current/stale provenance.
- Reject or loudly label handoff artifacts whose head/base/config signature does
  not match the checkout.

## Milestone 4: test architecture and product truth

- Split fast unit, artifact/integration, and subprocess-heavy CLI/E2E lanes.
- Restrict locale invariance to the locale-sensitive subset and reuse builds.
- Add curated false-positive/comment judgments, malformed-input fuzzing, density
  assertions, stage budgets, and an offline usefulness subset.
- Keep privacy, schema, evidence, determinism, and exact-head tests mandatory.

## Per-milestone completion loop

1. Focused tests and typecheck.
2. Triggered maintainability-decomposition and test-quality review.
3. Real-diff `local-review`; read the generated model, Markdown, and cockpit.
4. Simplify triad, then apply and revalidate safe findings.
5. Five valid whole-diff production review cycles with no unresolved P0/P1.
6. `local-gate`, commit intended files, push, open the PR, and monitor exact-head
   checks/review until safely merged.
7. Rebase the next milestone on merged `main` and reassess the backlog.

## Stop rule

The overall goal is complete only after all four milestones are landed and two
consecutive independent audits from the final base produce no P0/P1 improvement
that passes the anti-overengineering gates.
