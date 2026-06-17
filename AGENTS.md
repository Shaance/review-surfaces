# AGENTS.md — review-surfaces

This repository is developed spec-first and dogfood-first.

## Source of truth

1. Treat `features/review-surfaces.feature.yaml` as the authoritative requirements ledger.
2. Treat `docs/review-surfaces-trd.md` as design context.
3. Treat `schemas/review_packet.schema.json` as the machine-readable packet contract.
4. Preserve Acai-style IDs such as `review-surfaces.INTENT.2` in implementation notes, tests, review packets, and remediation tasks where useful.
5. Treat local `coffee-agents` setup as optional bootstrap scaffolding only. Do not introduce public product dependencies on private local scripts or paths.

## Start here

1. Detect whether this checkout is a git worktree:

```bash
test -f .git && echo "WORKTREE" || echo "MAIN"
```

2. If it is a worktree, copy optional local env and shared Claude project settings from the main worktree:

```bash
./scripts/copy-env.sh
```

Set `REVIEW_SURFACES_MAIN_WORKTREE=/absolute/path/to/main/worktree` if auto-detection chooses the wrong source. Secret ownership and expected keys live in `scripts/SECRETS.md`.

3. Install dependencies for this worktree when needed:

```bash
pnpm install --frozen-lockfile
```

4. Use offline mode by default:

```bash
pnpm run review-surfaces -- dogfood --provider mock --base origin/main --head HEAD --spec features/review-surfaces.feature.yaml --out .review-surfaces
```

Use `--provider agent-file --agent-input <json-or-yaml>` when a coding agent such as Codex or Claude contributes bounded local hypotheses. Use `--provider ai-sdk` only for optional live enrichment after privacy filtering; real credentials belong in `.env.local`, not committed files.

## Before editing

1. Read `features/review-surfaces.feature.yaml`.
2. Read `docs/review-surfaces-trd.md` for architecture and milestone context.
3. Read `.agents/skills/review-surfaces/SKILL.md` if present.
4. Read `.agents/skills/acai/SKILL.md` if present.
5. Read `.review-surfaces/agent_handoff.md` and `.review-surfaces/review_packet.md` if they exist.
6. Check the current milestone from the task prompt, handoff file, or feature spec.
7. Run the fastest available validation or test command for the current repo state.

## After editing

Run the strongest available local validation and self-review subset. Early milestones may not support every command yet.

Preferred: the scripted local loop (`review-surfaces.LOCAL_LOOP.*`) — it produces and gates every review surface with zero GitHub Actions involvement, which is also the merge gate while Actions remain unavailable:

```bash
pnpm run local-review   # pipeline (mock provider) + sticky preview + HTML cockpit + validate, with an artifact index
pnpm run local-gate     # lint, typecheck, full test, determinism-check, strict empty-diff self-dogfood
```

`local-review --previous <dir>` (or the automatic last-local-run detection) feeds since-last-review deltas from local prior packets. Both scripts are orchestration only: they run the same CLI commands you would type by hand, so no behavior exists only in CI or only in a script.

Equivalent manual shape:

```bash
pnpm run --if-present lint
pnpm run --if-present typecheck
pnpm run --if-present test
pnpm exec review-surfaces validate .review-surfaces || true
pnpm exec review-surfaces all \
  --base origin/main \
  --head HEAD \
  --spec features/review-surfaces.feature.yaml \
  --dogfood \
  --out .review-surfaces || true
```

Before the CLI exists, create or update a manual feedback file instead:

```text
.review-surfaces/feedback/manual-dogfood.yaml
```

Record what could not yet be run and why.

## Dogfood rule

**Run it on your own work, and read the output — not just the gate.** The local gate (`scripts/local-gate.sh`) uses `--provider mock` over an empty `HEAD..HEAD` self-dogfood: it proves byte-stable determinism and schema validity but is BLIND to whether a surface produces *sensible* output, so a green test suite can still ship a cockpit full of garbage. Before calling a feature done, run it against your branch's REAL diff (the merge-base range, with `--dogfood`) and read what it generates:

```bash
pnpm run local-review   # all --dogfood over origin/main...HEAD + cockpit + validate
```

In a **Claude Code** session auto-discovery finds this repo's own transcript (announced on stderr). Discovery is Claude-store-only, so in **Codex/Cursor** it degrades to `conversation_log_missing`; pass the transcript explicitly with the raw CLI (the `local-review` wrapper accepts only `--base`/`--head`/`--out`/`--previous`/`--provider`, not `--conversation`):

```bash
node bin/review-surfaces.js all --provider mock --dogfood --base origin/main --head HEAD --conversation <file> --out .review-surfaces
```

Open `.review-surfaces/human_review.html` and read `human_review.json` `.methodology_audit`. The LLM `audit`/CONV-GAP leaves need `--provider ai-sdk` over a CLEAN transcript and a real diff — see `.agents/skills/review-surfaces-dogfood-loop/SKILL.md` (a secret-bearing transcript OR diff, including the test fixtures, self-blocks the remote call by design).

A problem found while using `review-surfaces` to build `review-surfaces` is product feedback. Convert it into one of:

- code change;
- test;
- schema change;
- Acai spec update;
- AGENTS.md update;
- skill update;
- feedback file under `.review-surfaces/feedback/`;
- explicit deferral with reason and evidence.

Do not rely on hidden chat context for handoff. Update `agent_handoff.md`, the feature spec, or another local artifact instead.

## Review discipline

- Do not claim tests passed unless a command was run or test output was inspected.
- Do not invent file paths, line numbers, commands, ACIDs, or test names.
- Mark missing evidence as unknown rather than filling gaps with plausible prose.
- Keep generated review artifacts compact enough for a human reviewer to use.
- Treat `.review-surfacesignore`, secret redaction, and evidence validation as part of the core local pipeline, not provider-only concerns.
