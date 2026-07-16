# Risk Lenses

Generated from `review_packet.json` and `pr_review_surface.json`.

## Test evidence lens (LENS-001)

Severity: medium
Confidence: high
Paths: `source/core/index.ts`, `source/core/options.ts`, `test/abort.ts`, `test/pagination.ts`
Linked risk IDs: `PR-RISK-001`
Requirements: none

Why this matters:
Test evidence lens fired from 1 deterministic risk(s) across source/core/index.ts, source/core/options.ts, test/abort.ts, test/pagination.ts.

Reviewer action:
Confirm parsed test output, coverage, command transcripts, and skipped-test handling still produce trustworthy review evidence.

Evidence:
- `source/core/index.ts`
- `source/core/options.ts`
- `No current-head validation covers this area group (source/core/index.ts, source/core/options.ts).`
- `test/abort.ts`
- `test/pagination.ts`

Suggested tests:
### Run or add a fixture proving test output, coverage, skipped tests, or command transcripts are parsed into the expected evidence state. — automatic (recommended; LENS-001-TEST-001)

- Expected: The human review trust audit distinguishes passed, failed, skipped, claimed, and missing validation evidence correctly.
- Suggested file: `tests/tests-evidence.test.ts`
- Command: `pnpm run test -- tests/tests-evidence.test.ts`
- Evidence gap: Test evidence lens fired from 1 deterministic risk(s) across source/core/index.ts, source/core/options.ts, test/abort.ts, test/pagination.ts.

Suggested comments:
### Clarifying comment on `source/core/index.ts` (LENS-001-SC-001)
Path: `source/core/index.ts`

> This fires the test evidence lens. Can you point to parsed test output or a command transcript proving the changed evidence path is trustworthy?

Evidence: `source/core/options.ts`, `No current-head validation covers this area group (source/core/index.ts, source/core/options.ts).`, `test/abort.ts`, `test/pagination.ts`

Ready to post: yes.
