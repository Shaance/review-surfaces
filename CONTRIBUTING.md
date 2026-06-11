# Contributing to review-surfaces

Thanks for your interest. This project is deliberately local-first: everything a
maintainer needs to validate a change runs on your machine with no CI minutes
and no network beyond `git`.

## Setup

- Node.js `>= 22`
- [pnpm](https://pnpm.io/) (the exact version is pinned via `packageManager` in
  `package.json`)

```bash
pnpm install --frozen-lockfile
pnpm run build
```

## The two commands that matter

```bash
pnpm run local-review   # produce every review surface for your branch
                        # (markdown cockpit, HTML cockpit, sticky preview,
                        # diagrams, machine-readable packet) and validate them
pnpm run local-gate     # the full merge gate: lint, typecheck, the whole test
                        # suite, determinism-check, the packaging smoke test,
                        # and the strict empty-diff self-dogfood
```

`local-gate` must pass before a PR is ready. `local-review` is how you read your
own change the way a reviewer will — this repository reviews itself with itself,
and dogfood findings are treated as product feedback (see `AGENTS.md`).

## PR expectations

- One focused change per PR; branch from a fresh `main`.
- Requirements live in `features/review-surfaces.feature.yaml` (Acai-style
  IDs such as `review-surfaces.COLD_START.1`). New behavior gets a requirement
  entry, and each requirement ships with at least one test whose name carries
  the full Acai ID — that ID string is how the self-dogfood gate links tests to
  requirements.
- Determinism is part of the contract: identical inputs must produce
  byte-identical artifacts. `pnpm run determinism-check` (included in
  `local-gate`) enforces this.
- Redaction and privacy guards are core pipeline, not provider-only concerns;
  never weaken them to make a feature easier to render.
- The PR description should list the validation commands you ran and what the
  self-review (`pnpm run local-review`) said about your own change.

## Working rules

`AGENTS.md` is the source-of-truth workflow for both human and agent
contributors. The short version: read the feature spec before editing, run the
strongest available validation after editing, and convert anything the tool
gets wrong about your own PR into a code change, test, spec update, or explicit
deferral — not a shrug.
