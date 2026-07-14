# Trust Audit

## Confidence summary

Medium confidence: 3 verified fact(s), 2 missing evidence item(s), and 0 unverified claim(s).

## Verified facts

- PR scope contains 6 changed file(s) and 2 deterministic PR risk candidate(s). Evidence: `documentation/4-pagination.md`, `package.json`, `source/core/index.ts`, `source/core/options.ts`
- Deterministic PR risk PR-RISK-001 (untested_changed_impl) fired: 2 implementation files changed in CLUSTER:SOURCE/CORE; no test is mapped to this validation area and no current-head command transcript exists. Evidence: `source/core/index.ts`, `source/core/options.ts`
- Deterministic PR risk PR-RISK-002 (unmapped_change) fired: 2 changed file(s) did not map to any review area. Evidence: `documentation/4-pagination.md`, `package.json`

## Claimed but not verified

- No unverified claims recorded.

## Missing evidence

- No command transcript or validation feedback was supplied to prove test execution. Evidence: `Run validation commands and preserve output externally or in a future command transcript artifact.`
- Baseline evaluation unavailable; coverage deltas are current-status only. Evidence: `coverage.base_available=false`

## Invalid evidence

- None recorded.
