#!/usr/bin/env bash
#
# Determinism check: the same inputs + frozen clock must produce byte-identical
# artifacts across two independent runs. We MUST use the SAME --out path for both
# runs, because the absolute output directory is intentionally embedded in some
# artifacts (handoff file list, packet provided_artifacts paths, recorded command
# string). Diffing two DIFFERENT out dirs would falsely report drift.
#
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FROZEN="2026-01-01T00:00:00Z"
WORK="$(mktemp -d)"
OUT="$WORK/out" # single, stable out path reused by both runs
SNAP_A="$WORK/snapshot-a"
SNAP_B="$WORK/snapshot-b"
trap 'rm -rf "$WORK"' EXIT

run() {
  rm -rf "$OUT"
  node bin/review-surfaces.js all \
    --provider mock \
    --base origin/main \
    --head HEAD \
    --spec features/review-surfaces.feature.yaml \
    --dogfood \
    --strict \
    --now "$FROZEN" \
    --out "$OUT" >/dev/null
}

run
cp -R "$OUT" "$SNAP_A"
run
cp -R "$OUT" "$SNAP_B"

if diff -r "$SNAP_A" "$SNAP_B"; then
  echo "determinism-check: PASS (two runs byte-identical)"
else
  echo "determinism-check: FAIL (non-deterministic output detected)" >&2
  exit 1
fi
