#!/bin/bash
#
# Copy local-only environment files into the current worktree.
#
# Why: git worktrees do not share untracked files like .env.local.
#
# Usage:
#   ./scripts/copy-env.sh
#
# Optional:
#   REVIEW_SURFACES_MAIN_WORKTREE=/absolute/path/to/main/worktree ./scripts/copy-env.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

SOURCE_ROOT="${REVIEW_SURFACES_MAIN_WORKTREE:-}"

if [ -z "$SOURCE_ROOT" ]; then
  common_dir="$(git -C "$WORKTREE_ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -z "$common_dir" ]; then
    echo "Unable to determine git common dir. Are you running this inside a git checkout?" >&2
    exit 1
  fi

  if [[ "$common_dir" = /* ]]; then
    common_dir_abs="$common_dir"
  else
    common_dir_abs="$WORKTREE_ROOT/$common_dir"
  fi

  common_dir_abs="$(cd -- "$common_dir_abs" && pwd -P)"
  SOURCE_ROOT="$(cd -- "$common_dir_abs/.." && pwd -P)"
fi

if [ -z "$SOURCE_ROOT" ]; then
  echo "Unable to locate main worktree." >&2
  echo "Set REVIEW_SURFACES_MAIN_WORKTREE=/absolute/path/to/main/worktree and re-run." >&2
  exit 1
fi

copy_optional_file() {
  local rel_path="$1"
  local source_file="$SOURCE_ROOT/$rel_path"
  local dest_file="$WORKTREE_ROOT/$rel_path"

  if [ ! -f "$source_file" ]; then
    echo "Note: $source_file not found; skipped." >&2
    return
  fi

  if [ "$SOURCE_ROOT" = "$WORKTREE_ROOT" ]; then
    echo "Using main worktree $rel_path (already in this worktree)."
    return
  fi

  mkdir -p "$(dirname -- "$dest_file")"
  cp "$source_file" "$dest_file"
  echo "Copied $source_file -> $dest_file"
}

copy_optional_file ".env.local"

CLAUDE_SRC="$SOURCE_ROOT/.claude/settings.json"
CLAUDE_DEST="$WORKTREE_ROOT/.claude/settings.json"
if [ -f "$CLAUDE_SRC" ]; then
  if [ "$SOURCE_ROOT" = "$WORKTREE_ROOT" ]; then
    echo "Using main worktree .claude/settings.json (already in this worktree)."
  else
    mkdir -p "$(dirname -- "$CLAUDE_DEST")"
    cp "$CLAUDE_SRC" "$CLAUDE_DEST"
    echo "Copied $CLAUDE_SRC -> $CLAUDE_DEST"
  fi
else
  echo "Note: $CLAUDE_SRC not found; skipped." >&2
fi
