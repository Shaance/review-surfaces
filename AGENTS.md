# AGENTS.md — review-surfaces

This repository is developed spec-first and dogfood-first.

## Source of truth

1. Treat `features/review-surfaces.feature.yaml` as the authoritative requirements ledger.
2. Treat `docs/review-surfaces-trd.md` as design context.
3. Treat `schemas/review_packet.schema.json` as the machine-readable packet contract.
4. Preserve Acai-style IDs such as `review-surfaces.INTENT.2` in implementation notes, tests, review packets, and remediation tasks where useful.
5. Treat local `coffee-agents` setup as optional bootstrap scaffolding only. Do not introduce public product dependencies on private local scripts or paths.

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

Preferred shape once package scripts exist:

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
