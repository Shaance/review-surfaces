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
PNPM_STORE_ROOT="$(dirname "$(pnpm store path)")"

# lint is the repo's typecheck alias (package.json), so one run covers both
# gate steps; test cleans, builds, and runs the full suite.
pnpm run lint
pnpm run test
pnpm run determinism-check

# review-surfaces.EVAL_HARNESS.6: the README scoreboard block must match the
# scoreboard the test run just regenerated.
node bin/review-surfaces.js scoreboard --check

# review-surfaces.DISTRIBUTION.4: packaging smoke test — the pnpm pack tarball
# must install and run from a directory outside this repository (the cold-start
# path a stranger takes). Prefer the local pnpm store, while allowing pnpm to
# fetch registry metadata needed to resolve the tarball's dependency ranges.
PACK_TMP="$(mktemp -d)"
trap 'rm -rf "$PACK_TMP"' EXIT
# `pnpm run test` above starts with a clean build. Package that exact tested
# dist instead of compiling a second time after the long subprocess matrix;
# publish-time `prepack` still guarantees a clean checkout builds before pack.
pnpm pack --config.ignore-scripts=true --pack-destination "$PACK_TMP" >/dev/null
TARBALL="$(ls "$PACK_TMP"/review-surfaces-*.tgz)"
printf '{"name":"pack-smoke","private":true}\n' > "$PACK_TMP/package.json"
# A locked checkout primes package contents but not necessarily pnpm's metadata
# mirror, so strict --offline installs are not a valid cold-start contract.
(cd "$PACK_TMP" && pnpm add "./$(basename "$TARBALL")" --prefer-offline --silent --store-dir "$PNPM_STORE_ROOT")
SMOKE_REPO="$PACK_TMP/smoke-repo"
mkdir -p "$SMOKE_REPO"
(
  cd "$SMOKE_REPO"
  git init -q -b main
  printf 'export const answer = 42;\n' > index.ts
  git -c user.email=gate@local -c user.name=gate add -A
  git -c user.email=gate@local -c user.name=gate commit -qm smoke
  "$PACK_TMP/node_modules/.bin/review-surfaces" all --provider mock --no-conversation-discovery --base HEAD --head HEAD --out .rs >/dev/null
  "$PACK_TMP/node_modules/.bin/review-surfaces" validate .rs --surface all >/dev/null
)
echo "pack smoke: PASS (tarball installs and runs outside the repo)"

# Strict empty-diff self-dogfood: every spec requirement must be satisfied (or
# explicitly allowlisted) with no diff to excuse it. Writes to a temp dir so the
# gate never clobbers the working tree's .review-surfaces artifacts.
GATE_OUT="$(mktemp -d)/out"
trap 'rm -rf "$PACK_TMP" "$(dirname "$GATE_OUT")"' EXIT
node bin/review-surfaces.js all \
  --provider mock \
  --no-conversation-discovery \
  --base HEAD \
  --head HEAD \
  --dogfood \
  --strict \
  --out "$GATE_OUT"

echo "local-gate: PASS (lint, typecheck, test, determinism-check, pack smoke, strict empty-diff self-dogfood)"
