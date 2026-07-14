# Evidence Cards

Generated from `review_packet.json` and `pr_review_surface.json`.

- Test evidence lens fired from 1 deterministic risk(s) across source/core/index.ts, source/core/options.ts, test/abort.ts, test/pagination.ts. Action: Confirm parsed test output, coverage, command transcripts, and skipped-test handling still produce trustworthy review evidence. [Mixed evidence; medium; evidence: direct 4, missing 1, invalid 0] (`CARD-001`)
- No command transcript or validation feedback was supplied to prove test execution. Action: Ask the author to provide the missing evidence or record an explicit deferral. [Missing evidence; medium; evidence: direct 0, missing 1, invalid 0] (`CARD-002`)
- Baseline evaluation unavailable; coverage deltas are current-status only. Action: Ask the author to provide the missing evidence or record an explicit deferral. [Missing evidence; medium; evidence: direct 0, missing 1, invalid 0] (`CARD-003`)
- 2 implementation files changed in CLUSTER:SOURCE/CORE; no test is mapped to this validation area and no current-head command transcript exists. Action: Run or add the suggested check: Add or identify a focused test that exercises the changed implementation in source/core/index.ts. [Missing evidence; high; evidence: direct 0, missing 1, invalid 0] (`CARD-004`)
- PR scope contains 6 changed file(s) and 2 deterministic PR risk candidate(s). Action: Use this as supporting evidence; inspect only if it conflicts with higher-priority findings. [Unchecked direct evidence; low; evidence: direct 5, missing 0, invalid 0] (`CARD-005`)
- Deterministic PR risk PR-RISK-001 (untested_changed_impl) fired: 2 implementation files changed in CLUSTER:SOURCE/CORE; no test is mapped to this validation area and no current-head command transcript exists. Action: Use this as supporting evidence; inspect only if it conflicts with higher-priority findings. [Unchecked direct evidence; low; evidence: direct 2, missing 0, invalid 0] (`CARD-006`)
