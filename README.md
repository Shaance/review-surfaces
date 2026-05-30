# review-surfaces

A **local-first, evidence-first review-packet compiler for agent-generated code changes.**

`review-surfaces` reads a repository's Acai-style feature spec, docs, tests, and
git diff, then compiles a deterministic *review packet*: intent, an
implementation-vs-intent evaluation, architecture surfaces (Mermaid diagrams
with validation), a methodology audit, and a ranked risks / test-gap report.
Every claim in the packet is tied to local evidence (files, diffs, command
transcripts, feedback) rather than hidden chat context, and it can dogfood
itself while it is being built.

The output lives under `.review-surfaces/` as compact, human-readable
JSON/YAML/Markdown artifacts. Hosted Acai sync, CI checks, and PR/MR comment
renderers are deliberately *later* surfaces — the local artifacts are the MVP.

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
pnpm install
pnpm run build
```

`pnpm run build` compiles the CommonJS CLI with `tsc`. The executable is
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

- `review_packet.json` — the schema-validated packet (validated against
  `schemas/review_packet.schema.json`).
- `review_packet.md` / `architecture.md` / `agent_handoff.md` — human-readable
  surfaces.
- `intent.yaml`, `evaluation.yaml`, `methodology.yaml`, `risks.yaml`,
  `dogfood.yaml` — per-section YAML artifacts.
- `inputs/` and `commands/` — collected input indexes and bounded command
  transcripts.

## Commands

| Command | What it does |
| --- | --- |
| `collect` | Write the run manifest and input indexes under `.review-surfaces`. |
| `all` | Run the whole local pipeline and write the full review packet. |
| `intent` / `evaluate` / `diagrams` / `methodology` / `risks` / `packet` / `handoff` | Run the available local pipeline and emit packet artifacts. (These currently run the same end-to-end pipeline as `all`.) |
| `dogfood` | Run the pipeline in dogfood mode (adds the `dogfood` and `agent_handoff` sections). |
| `validate [dir-or-json]` | Validate `review_packet.json` against `schemas/review_packet.schema.json`. Defaults to `.review-surfaces`. |
| `run [--id <id>] [--command-transcripts <dir>] -- <cmd>...` | Execute a local command and record a bounded command transcript as direct evidence. |
| `init [--force]` | Scaffold a repo for review-surfaces (create-or-validate): config, packet schema, `.review-surfacesignore`, a starter feature spec, the usage skill, and `AGENTS.md`. Existing files are never overwritten without `--force`; user-owned `AGENTS.md` and feature specs are preserved even with `--force`. |
| `bootstrap [--strict]` | Validate-only: report whether the expected scaffolding exists and parses. Exits `10` under `--strict` when a required target is missing or invalid. |
| `comment` | **Deferred.** Provider/PR comment rendering is intentionally not implemented; local artifacts are the MVP surface. |

Run `node bin/review-surfaces.js --help` for the full option list.

### Common options

- `--base <ref>` / `--head <ref>` — diff range (defaults `origin/main` … `HEAD`).
- `--spec <path>` — feature spec path (defaults to config).
- `--out <dir>` — output directory (defaults `.review-surfaces`).
- `--dogfood` — mark the run as dogfood and include the dogfood/handoff sections.
- `--config <path>` — config path (defaults `review-surfaces.config.yaml`).
- `--provider <name>` — enrichment provider: `mock` (default, offline),
  `agent-file` (bounded agent hypotheses via `--agent-input <json|yaml>`), or
  `ai-sdk` (optional live enrichment).

## Providers

- **`mock`** (default): fully deterministic, offline. Use this for normal runs,
  tests, and dogfooding.
- **`agent-file`**: lets a coding agent contribute bounded, schema-checked
  hypotheses via `--agent-input <json-or-yaml>` without network access.
- **`ai-sdk`**: optional live enrichment. Privacy filtering runs first; provider
  credentials belong in a local `.env.local`, never in committed files.

LLM and agent output is never treated as proof until deterministic evidence
validation accepts it.

## Testing

```bash
pnpm run test       # builds, then runs node --test over dist/tests/*.test.js
pnpm run typecheck  # tsc --noEmit
pnpm run lint       # alias for typecheck
```

## Project layout

- `src/` — the CLI and pipeline modules (collector, intent, evaluation,
  diagrams, methodology, risks, dogfood, render, schema, privacy, providers).
- `tests/` — `node --test` suite compiled to `dist/tests`.
- `schemas/review_packet.schema.json` — the draft 2020-12 packet contract.
- `features/review-surfaces.feature.yaml` — the authoritative requirements ledger.
- `.review-surfaces/` — generated, local-first artifacts.

## Learn more

- [`AGENTS.md`](./AGENTS.md) — shared repository entrypoint and source-of-truth workflow.
- [`docs/review-surfaces-trd.md`](./docs/review-surfaces-trd.md) — technical/design context.
- [`features/review-surfaces.feature.yaml`](./features/review-surfaces.feature.yaml) — the Acai-style feature spec and requirements ledger.
