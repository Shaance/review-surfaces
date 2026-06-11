#!/usr/bin/env bash
#
# review-surfaces.LOCAL_LOOP.2: the full merge gate as one command, with zero
# GitHub Actions involvement — lint, typecheck, the full test suite,
# determinism-check, and the strict empty-diff self-dogfood. The empty-diff run
# is the documented red-main footgun when a phase drops quality-gate allowlist
# entries; this script exists so it can never be skipped by accident.
# Orchestration only (LOCAL_LOOP.4): every step is the same command a user
# types by hand.
#
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# lint is the repo's typecheck alias (package.json), so one run covers both
# gate steps; test cleans, builds, and runs the full suite.
pnpm run lint
pnpm run test
pnpm run determinism-check

# review-surfaces.EVAL_HARNESS.6: the README scoreboard block must match the
# scoreboard the test run just regenerated.
node bin/review-surfaces.js scoreboard --check

# Strict empty-diff self-dogfood: every spec requirement must be satisfied (or
# explicitly allowlisted) with no diff to excuse it. Writes to a temp dir so the
# gate never clobbers the working tree's .review-surfaces artifacts.
GATE_OUT="$(mktemp -d)/out"
trap 'rm -rf "$(dirname "$GATE_OUT")"' EXIT
node bin/review-surfaces.js all \
  --provider mock \
  --base HEAD \
  --head HEAD \
  --dogfood \
  --strict \
  --out "$GATE_OUT"

echo "local-gate: PASS (lint, typecheck, test, determinism-check, strict empty-diff self-dogfood)"
