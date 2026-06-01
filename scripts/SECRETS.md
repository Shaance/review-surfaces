# Secrets Reference

Complements `AGENTS.md` and `CLAUDE.md`. This repository is local-first, so live provider credentials are optional and must stay out of Git.

## Local Secret Files

### `.env.local`

Purpose:
- Optional live AI SDK enrichment with `--provider ai-sdk`.
- Local shell convenience while keeping the default `mock` provider offline.

Expected keys:

| Key | Required | Used in | Notes |
|---|---:|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | No | `review-surfaces --provider ai-sdk` | Google Gemini key for optional enrichment only. The mock provider and `agent-file` provider do not require it. |
| `REVIEW_SURFACES_AI_MODEL` | No | `review-surfaces --provider ai-sdk` | Defaults to `gemini-2.5-flash` when unset. |

GitHub PR comments use the same `GOOGLE_GENERATIVE_AI_API_KEY` secret when
`review-comment` runs in PR mode. The workflow checks out trusted tool code at
the base SHA and runs it against a credentialless PR subject checkout so the key
is not exposed to PR-controlled install/build/executable code.

Use `./scripts/copy-env.sh` in a git worktree to copy `.env.local` from the main worktree when it exists. The script also copies `.claude/settings.json` but intentionally does not copy `.claude/settings.local.json`.

## Provider Safety

- Default provider: `mock`, no network.
- Coding-agent path: `--provider agent-file --agent-input <json-or-yaml>` for bounded local JSON/YAML produced by Codex, Claude, or another coding agent.
- Live LLM path: `--provider ai-sdk` only after local collection and privacy filtering. Remote prompts are secret-scanned and redacted; high-risk private key material blocks the remote call.

Do not commit `.env.local`, copied local settings, provider transcripts, or raw conversation logs.
