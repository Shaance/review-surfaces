# Conversation auditing (zero-config for Claude Code & Codex)

review-surfaces can audit the **agent conversation that produced a diff** — the raw
session transcript — at two levels:

1. a workflow audit judges what was considered, researched, assumed, or skipped;
2. a conversation-first reviewer model reconstructs final intent, later
   refinements, decisions, constraints, non-goals, rejected alternatives, claims,
   validation claims, and known gaps, then reconciles that model with the diff.

See the `review-surfaces.METHODOLOGY.*` and
`review-surfaces.CONVERSATION_REVIEW.*` requirements.

This is **local-first and read-only**: discovery never copies raw transcript text or an
absolute home-dir session path into a persisted artifact, and a remote provider call is
blocked when the transcript holds high-risk secret material (PRIVACY.7).

## What appears on the reviewer surface

With a conversation and configured AI provider, the analysis reads events in
chronological windows and performs a final reduction pass. This matters because a
late user correction must override an earlier broad request or rejected assistant
suggestion. Every extracted item cites exact normalized event IDs; fabricated IDs
are removed, and active intent/constraints must include a user-event citation.

The reconciliation pass receives only the analysis plus one bounded review
context: changed paths and line-numbered diff lines, scoped requirement IDs,
deterministic risk IDs, and captured command transcripts. Runtime validation uses
that exact same prompt-visible context, so a model cannot earn grounding from a
hidden event, line 221, file 41, or command 31. It groups
implementation/test/doc/spec symptoms by root cause and emits at most three
reviewer insights:

Analysis status:

| Status | Meaning |
|---|---|
| `analyzed` | The conversation was reconstructed successfully. The rendered status adds a `partial` qualifier when bounded input, failed windows, or bounded diff reconciliation limits completeness. |
| `not_assessed` | No usable conversation log or diff was available, so no conversation conclusion was attempted. |
| `degraded` | Conversation analysis failed or returned invalid data; the caveat is rendered and never presented as a clean result. |

Insight evidence state:

| Evidence state | Meaning |
|---|---|
| `supported` (rendered “Aligned with intent”) | The AI-inferred relationship has validated conversation plus exact diff/path-related risk anchors; anchor validity does not independently prove the relationship. |
| `contradicted` (rendered “Conflicts with intent”) | The AI infers a conflict and its cited conversation plus exact diff/path-related risk anchors validate; the semantic relationship remains AI-authored. |
| `unverified` (rendered “Needs verification”) | The reconciliation lacks enough deterministic anchors, an input was partial, or a proposed citation was rejected. |

The reviewer sees the cited stated goal, later refinements, constraints,
why each finding matters, the action to take, and compact event plus exact-line
evidence. The insights are advisory: they render before the generic review queue
in Markdown, HTML, sticky, and both PR-comment paths, but cannot create or clear
blockers, alter coverage, or change merge readiness.

Command transcript ingestion preserves a separate privacy-block bit before
redacting command/output text. Diff, conversation, or command material that held
a blocked secret prevents a remote reconciliation call even though persisted
artifacts contain only `[REDACTED:…]` markers.

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
