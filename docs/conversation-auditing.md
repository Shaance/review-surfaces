# Conversation auditing (zero-config for Claude Code & Codex)

review-surfaces can audit the **agent conversation that produced a diff** — the raw
session transcript — and judge whether the workflow made sense: what was considered,
what was researched, what assumptions went unchallenged, what was skipped, and whether
claims (e.g. "tests passed") are backed by recorded evidence. See the
`review-surfaces.METHODOLOGY.*` requirements.

This is **local-first and read-only**: discovery never copies raw transcript text or an
absolute home-dir session path into a persisted artifact, and a remote provider call is
blocked when the transcript holds high-risk secret material (PRIVACY.7).

## Zero-config discovery

With **no flags**, a run auto-discovers the single harness session that produced
`base..head` and audits it. Discovery spans two stores:

| Harness | Store | How a session is matched |
|---|---|---|
| **Claude Code** | `~/.claude/projects/<repo-slug>/*.jsonl` | The slug directory *is* the repo match; among that repo's sessions, the one that references the changed files wins, falling back to recency. |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | A **single global store** across every repo, so a rollout is scoped to this repo by its recorded `session_meta.cwd` (the Codex analogue of the Claude slug — a generic changed path like `README.md` would otherwise false-match other repos' sessions). Among this repo's rollouts the one referencing the changed files wins, falling back to recency. The scan is bounded to the most-recent rollouts. |

Selection is one deterministic total order across both stores: **most changed-files
referenced**, then **most recent in-session event**, then **greatest path**. The picked
session's absolute path is announced on **stderr only**; the persisted evidence anchor is
the gitignored repo-relative normalized log.

### "Why this transcript?" and the stale/wrong-session warning

Every discovery announces its basis on stderr, e.g.:

```
Auto-discovered conversation session: /Users/me/.codex/sessions/.../rollout-….jsonl (adapter codex; matched 3 changed file(s) in the reviewed range)
```

If the only session that could be found references **none** of the reviewed range, that
is a **hard warning**, not a silent pick — it is likely the wrong or a stale session:

```
WARNING: auto-discovered conversation session … does NOT reference any file in the
reviewed range — picked by recency alone, so it may be the wrong or a stale session.
Pass --conversation <path> to select the right transcript, or
--no-conversation-discovery to skip auto-discovery.
```

## Cursor (explicit `--conversation`)

Cursor stores its chat in a per-workspace SQLite database
(`…/Cursor/User/workspaceStorage/<hash>/state.vscdb`) with **no loose transcript file**,
so there is no zero-config discovery for Cursor. Export the relevant chat/composer to a
JSON file and pass it explicitly — the `cursor` adapter parses it:

```bash
review-surfaces all --conversation ./cursor-chat.json --conversation-format cursor
```

## Overriding discovery

| Flag | Effect |
|---|---|
| `--conversation <path>` | Audit this exact transcript; **always wins** over discovery. |
| `--conversation-format claude-code\|codex\|cursor\|normalized` | Force an adapter instead of content auto-detection. |
| `--no-conversation-discovery` | Skip auto-discovery entirely (no transcript is audited unless `--conversation` is given). |

`scripts/local-review.sh` forwards all three flags verbatim to `all`, so the local loop
gets the same zero-config default and the same overrides:

```bash
scripts/local-review.sh                                   # zero-config discovery
scripts/local-review.sh --conversation ./cursor-chat.json --conversation-format cursor
scripts/local-review.sh --no-conversation-discovery
```
