# review-surfaces

A **local-first review decision cockpit for agent-generated code changes.**

`review-surfaces` reads a repository's Acai-style feature spec, docs, tests, and
git diff, then turns the evidence into the shortest safe human review path:
merge-readiness verdict, review-first queue, blockers, reviewer questions, trust
audit, concrete test plan, suggested comments, and skim-safe hints. The
schema-validated review packet remains the evidence backbone underneath the
human cockpit: intent, implementation-vs-intent evaluation, architecture
surfaces, methodology audit, risks, test gaps, command transcripts, and feedback.

Every claim is tied to local evidence (files, diffs, command transcripts,
feedback) rather than hidden chat context, and the project dogfoods its own
artifacts while it is being built. The output lives under `.review-surfaces/` as
compact, human-readable JSON/YAML/Markdown artifacts. Hosted Acai sync, CI
checks, and PR/MR integrations are optional renderers over the same local
evidence; the local human review surface is the default product entrypoint.

## Principles

- **Local-first.** Everything runs offline against the working tree. The
  default provider is `mock`, no network access is required, and artifacts are
  written to `.review-surfaces/` for a human (or the next agent) to read.
- **Evidence-first.** A claim is only as good as the local evidence behind it.
  Requirement coverage, risks, and methodology claims carry explicit evidence
  references with confidence and validation status. Unverifiable claims are
  marked `unknown` instead of being filled with plausible prose.
- **Deterministic shell.** The same inputs produce byte-stable artifacts:
  insertion-order keys, no YAML anchors/aliases, no line-wrapping surprises,
  and `undefined` fields are omitted rather than emitted. Humans and tests diff
  these files line-by-line.

## Requirements

- Node.js `>= 22`
- [pnpm](https://pnpm.io/) (`pnpm@10.8.0` is pinned via `packageManager`)
- A git checkout with a base ref (defaults to `origin/main`) to diff against

## Install

```bash
pnpm install --frozen-lockfile
pnpm run build
```

CI and reproducible installs use `--frozen-lockfile` so `pnpm-lock.yaml` is treated
as authoritative; drop the flag only when intentionally updating dependencies.

`pnpm run build` clears stale compiled output, then compiles the CommonJS CLI with
`tsc`. The executable is
`bin/review-surfaces.js` (also exposed as the `review-surfaces` bin and via the
`pnpm run review-surfaces` script).

## Zero-to-packet quickstart

Compile a full review packet for the current branch, offline, in dogfood mode:

```bash
node bin/review-surfaces.js all \
  --base origin/main \
  --head HEAD \
  --spec features/review-surfaces.feature.yaml \
  --dogfood \
  --provider mock \
  --out .review-surfaces
```

Then validate the emitted packet against the schema:

```bash
node bin/review-surfaces.js validate .review-surfaces
```

You can also run the same flow through the package script (it builds first):

```bash
pnpm run review-surfaces -- all --base origin/main --head HEAD \
  --spec features/review-surfaces.feature.yaml --dogfood --provider mock \
  --out .review-surfaces
```

After a run, look under `.review-surfaces/`:

`all` prints the human entrypoint first, with the deterministic verdict and
counts for review-first items, blockers, suggested comments, and missing
evidence so reviewers do not need to start in the packet JSON.

- `human_review.md` / `human_review.json` — the default human reviewer
  entrypoint: verdict, review-first queue, blockers/questions, trust audit,
  review routes, evidence cards, suggested comments, test-plan items, skim-safe
  hints, and evidence pointers.
- `review_queue.md`, `suggested_comments.md`, `trust_audit.md`,
  `risk_lenses.md`, `review_routes.md`, `evidence_cards.md`,
  `since_last_review.md`, `test_plan.md` — standalone human cockpit sections
  rendered from `human_review.json` for reviewers who want a focused queue,
  comment drafts, trust audit, risk lenses, persona routes, compact evidence
  cards, since-last-review deltas, or test plan.
- `review_packet.json` — the schema-validated packet (validated against
  `schemas/review_packet.schema.json`).
- `review_packet.md` / `architecture.md` / `agent_handoff.md` — human-readable
  surfaces.
- `pr_review_surface.json` — when `all --surface-mode pr` is used, the
  diff-scoped PR sidecar with changed files, affected requirements, coverage
  deltas, deterministic PR risks, validated LLM narrative, and a change-impact
  diagram.
- `intent.yaml`, `evaluation.yaml`, `methodology.yaml`, `risks.yaml`,
  `dogfood.yaml` — per-section YAML artifacts.
- `inputs/` and `commands/` — collected input indexes and bounded command
  transcripts.

## Commands

| Command | What it does |
| --- | --- |
| `collect` | Write the run manifest and input indexes under `.review-surfaces`. |
| `all` | Run the whole local pipeline and write the full review packet. Add `--surface-mode pr` to also write the PR-scoped sidecar. |
| `intent` / `evaluate` / `diagrams` / `methodology` / `risks` / `packet` / `handoff` | Run the available local pipeline and emit packet artifacts. (These currently run the same end-to-end pipeline as `all`.) |
| `dogfood` | Run the pipeline in dogfood mode (adds the `dogfood` and `agent_handoff` sections). |
| `validate [dir-or-json]` | Validate `review_packet.json` against `schemas/review_packet.schema.json`. Defaults to `.review-surfaces`. |
| `run [--id <id>] [--command-transcripts <dir>] -- <cmd>...` | Execute a local command and record a bounded command transcript as direct evidence. |
| `human` | Render `human_review.json`, `human_review.md`, and standalone human artifacts from existing local packet artifacts without recomputing the pipeline. |
| `queue` / `comments` / `trust` / `risk-lenses` / `routes` / `evidence-cards` / `since-last-review` / `test-plan` | Render the focused standalone human artifacts from `human_review.json`. |
| `init [--force]` | Scaffold a repo for review-surfaces (create-or-validate): config, packet schema, `.review-surfacesignore`, a starter feature spec, the usage skill, and `AGENTS.md`. Existing files are never overwritten without `--force`; user-owned `AGENTS.md` and feature specs are preserved even with `--force`. |
| `bootstrap [--strict]` | Validate-only: report whether the expected scaffolding exists and parses. Exits `10` under `--strict` when a required target is missing or invalid. |
| `comment` | Render a local review surface. `--mode repo` reads `review_packet.json`; `--mode pr` prefers a current schema-valid `human_review.json` and keeps `pr_review_surface.json` as the lower-level PR fact/postability gate. |

Run `node bin/review-surfaces.js --help` for the full option list.

### Common options

- `--base <ref>` / `--head <ref>` — diff range (defaults `origin/main` … `HEAD`).
- `--spec <path>` — feature spec path (defaults to config).
- `--out <dir>` — output directory (defaults `.review-surfaces`).
- `--mode pr|repo|auto` — `comment` surface mode. `repo` keeps the whole-packet
  comment; `pr` renders the human review model when available, backed by the PR
  sidecar.
- `--surface-mode pr|repo|auto` — `all` sidecar mode. `pr` writes
  `pr_review_surface.json`.
- `--dogfood` — mark the run as dogfood and include the dogfood/handoff sections.
- `--config <path>` — config path (defaults `review-surfaces.config.yaml`).
- `--provider <name>` — enrichment provider: `mock` (default, offline),
  `agent-file` (bounded agent hypotheses via `--agent-input <json|yaml>`), or
  `ai-sdk` (optional live enrichment).

### Human review config

`review-surfaces.config.yaml` can tune bounded human-review output without
changing the evidence engine:

```yaml
human_review:
  enabled: true
  default_entrypoint: true
  max_review_first: 20
  max_suggested_comments: 10
  max_questions: 10
  risk_lenses:
    api_contract: true
    security_privacy: true
    llm_trust_boundary: true
    test_evidence: true
    reviewer_ux: true
    cache_provenance: true
  required_manual_checks:
    - id: ci_secret_boundary
      path_patterns:
        - .github/workflows/**
      prompt: Confirm PR-controlled code cannot access secrets.
```

`human_review.md` still renders a compact top seven from the model; this cap
controls the generated JSON and full `review_queue.md`. Required manual checks
matched by changed paths become blockers, reviewer questions, and required
manual test-plan items until current-head feedback or transcript evidence records
the check.

## Providers

- **`mock`** (default): fully deterministic, offline. Use this for normal runs,
  tests, and dogfooding.
- **`agent-file`**: lets a coding agent contribute bounded, schema-checked
  hypotheses via `--agent-input <json-or-yaml>` without network access.
- **`ai-sdk`**: optional live enrichment. Privacy filtering runs first; provider
  credentials belong in a local `.env.local`, never in committed files.

LLM and agent output is never treated as proof until deterministic evidence
validation accepts it.

For posted PR comments, use PR mode with a non-mock provider:

```bash
node bin/review-surfaces.js all --surface-mode pr --provider ai-sdk \
  --base origin/main --head HEAD --spec features/review-surfaces.feature.yaml
node bin/review-surfaces.js comment --mode pr --out .review-surfaces
```

`agent-file` is useful for local deterministic PR-mode tests. `mock` may build a
blocked PR surface for diagnostics, but it does not satisfy the required PR
narrative.

## Testing

```bash
pnpm run test       # cleans/builds, then runs node --test over dist/tests/*.test.js
pnpm run typecheck  # tsc --noEmit
pnpm run lint       # alias for typecheck
```

## Project layout

- `src/` — the CLI and pipeline modules (collector, intent, evaluation,
  diagrams, methodology, risks, dogfood, render, schema, privacy, providers).
- `tests/` — `node --test` suite compiled to `dist/tests`.
- `schemas/review_packet.schema.json` — the draft 2020-12 packet contract.
- `schemas/pr_review_surface.schema.json` — the draft 2020-12 PR sidecar
  contract.
- `features/review-surfaces.feature.yaml` — the authoritative requirements ledger.
- `.review-surfaces/` — generated, local-first artifacts.

## Learn more

- [`AGENTS.md`](./AGENTS.md) — shared repository entrypoint and source-of-truth workflow.
- [`docs/review-surfaces-trd.md`](./docs/review-surfaces-trd.md) — technical/design context.
- [`features/review-surfaces.feature.yaml`](./features/review-surfaces.feature.yaml) — the Acai-style feature spec and requirements ledger.
