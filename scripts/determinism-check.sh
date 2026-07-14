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

# review-surfaces.CHANGE_MAP.4: determinism is checked for BOTH scopes — the
# repo-scope `all` and a PR-scope run, so the supporting HTML/SVG map and the
# reviewer-brief sidecars are covered, not just the repo-scope artifacts.
run() {
  local scope="$1"
  rm -rf "$OUT"
  node bin/review-surfaces.js all \
    --provider mock \
    --no-conversation-discovery \
    --base origin/main \
    --head HEAD \
    --spec features/review-surfaces.feature.yaml \
    --review-scope "$scope" \
    --dogfood \
    --strict \
    --now "$FROZEN" \
    --out "$OUT" >/dev/null
  # Materialize the reviewer-brief surfaces too: `all` alone never writes
  # comment.md, so nondeterminism in either compact or sticky formatting would
  # otherwise slip past this check (CHANGE_MAP.4).
  node bin/review-surfaces.js comment --review-scope "$scope" --out "$OUT" >/dev/null 2>&1
  mv "$OUT/comment.md" "$OUT/comment.$scope.md"
  node bin/review-surfaces.js comment --format sticky --out "$OUT" >/dev/null 2>&1
}

for SCOPE in repo pr; do
  rm -rf "$SNAP_A" "$SNAP_B"
  run "$SCOPE"
  cp -R "$OUT" "$SNAP_A"
  run "$SCOPE"
  cp -R "$OUT" "$SNAP_B"
  if ! diff -r "$SNAP_A" "$SNAP_B"; then
    echo "determinism-check: FAIL (non-deterministic output detected in $SCOPE scope)" >&2
    exit 1
  fi
done
echo "determinism-check: PASS (two runs byte-identical in repo and pr scope)"
