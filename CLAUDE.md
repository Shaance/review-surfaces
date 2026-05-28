# CLAUDE.md - review-surfaces

Use `AGENTS.md` as the shared repository entrypoint and source-of-truth workflow. This file adds Claude-specific startup context without duplicating the full agent rules.

## Worktree Startup

Detect worktrees first:

```bash
test -f .git && echo "WORKTREE" || echo "MAIN"
```

If this is a worktree, run:

```bash
./scripts/copy-env.sh
```

This copies optional local `.env.local` provider credentials from the main worktree when present. It also copies `.claude/settings.json` but never `.claude/settings.local.json`.

## Provider Guidance

- Default to `--provider mock` for deterministic offline dogfood runs.
- Use `--provider agent-file --agent-input <json-or-yaml>` when Claude or another coding agent should contribute bounded hypotheses without requiring network access.
- Use `--provider ai-sdk` only for optional live enrichment. Source `.env.local` in the shell first when needed, and do not paste or commit credentials.

## Required Discipline

- Preserve Acai IDs such as `review-surfaces.PRIVACY.2` and `review-surfaces.EVIDENCE.4` in tests, notes, and artifacts where useful.
- Do not treat LLM or agent-file output as proof until deterministic evidence validation accepts it.
- Keep `.review-surfaces/` artifacts compact and local-first; GitHub comments and CI renderers are later surfaces.
