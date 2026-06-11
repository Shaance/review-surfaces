#!/usr/bin/env bash
#
# review-surfaces.LOCAL_LOOP.1/.3: produce every review surface locally, with
# zero GitHub Actions involvement. Orchestration only — each step is the same
# CLI command a user types by hand (review-surfaces.LOCAL_LOOP.4); no analysis
# or behavior lives in this script.
#
# Usage: scripts/local-review.sh [--base <ref>] [--head <ref>] [--out <dir>]
#                                [--previous <dir>] [--provider <name>]
#
# Defaults: --base origin/main, --head HEAD, --out .review-surfaces,
# --provider mock (network use: git only). When --previous is omitted and a
# prior run's review_packet.json exists in the out directory, it is snapshotted
# and passed as the previous packet so since-last-review deltas work from local
# prior packets, not only CI artifacts (LOCAL_LOOP.3).
#
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BASE="origin/main"
HEAD="HEAD"
OUT=".review-surfaces"
PREVIOUS=""
PROVIDER="mock"

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --head) HEAD="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --previous) PREVIOUS="$2"; shift 2 ;;
    --provider) PROVIDER="$2"; shift 2 ;;
    *) echo "local-review: unknown option: $1" >&2; exit 2 ;;
  esac
done

pnpm run build

# LOCAL_LOOP.3: auto-detect the last local run's packet when --previous is not
# given, so the comparison engine sees a prior round regardless of transport.
PREV_ARGS=()
if [ -n "$PREVIOUS" ]; then
  PREV_ARGS=(--previous-packet "$PREVIOUS")
elif [ -f "$OUT/review_packet.json" ]; then
  # Snapshot to a STABLE path under the out directory: the CLI records the
  # resolved previous-packet path in dogfood/manifest data and folds it into
  # the cache signature, so a random mktemp path would make every run's
  # artifacts differ and point the rounds ledger at a transient /tmp file.
  PREV_SNAP="$OUT/previous/review_packet.json"
  mkdir -p "$OUT/previous"
  cp "$OUT/review_packet.json" "$PREV_SNAP"
  # The rounds ledger (TREND.1) lives in the sibling human_review.json — carry
  # it with the snapshot or every local round would restart at 1.
  if [ -f "$OUT/human_review.json" ]; then
    cp "$OUT/human_review.json" "$OUT/previous/human_review.json"
  fi
  PREV_ARGS=(--previous-packet "$PREV_SNAP")
  echo "local-review: comparing against previous local packet ($PREV_SNAP)"
fi

node bin/review-surfaces.js all \
  --provider "$PROVIDER" \
  --base "$BASE" \
  --head "$HEAD" \
  --dogfood \
  --out "$OUT" \
  "${PREV_ARGS[@]+"${PREV_ARGS[@]}"}"

node bin/review-surfaces.js comment --format sticky --out "$OUT"
node bin/review-surfaces.js human --format html --out "$OUT"
node bin/review-surfaces.js validate --surface all --out "$OUT"

echo
echo "local-review: artifacts to open"
echo "  $OUT/human_review.md        — human review surface (markdown)"
echo "  $OUT/human_review.html      — HTML cockpit (open in a browser)"
echo "  $OUT/comment.md             — sticky PR comment preview"
echo "  $OUT/diagrams/              — mermaid diagrams"
echo "  $OUT/review_packet.json     — full machine-readable packet"
