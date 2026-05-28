---
name: review-surfaces-usage
description: Use when running review-surfaces in any local repository to collect inputs, capture command transcripts, compile review packets, validate evidence, and record feedback without hosted services.
---

# review-surfaces usage

Covers `review-surfaces.BOOTSTRAP.6`.

Use this skill when applying `review-surfaces` to a repository, including repositories other than `review-surfaces`.

## Workflow

1. Identify the review range, usually `--base origin/main --head HEAD`.
2. Identify source contracts: `features/**/*.feature.yaml`, docs, tickets, AGENTS files, and local skills.
3. Capture important checks with `review-surfaces run -- <command>` so test claims have bounded command transcript evidence.
4. Run `review-surfaces all --out .review-surfaces` with `--dogfood` only when reviewing the `review-surfaces` repository itself.
5. Run `review-surfaces validate .review-surfaces` before treating the packet as evidence.
6. Inspect `.review-surfaces/review_packet.md`, `.review-surfaces/evaluation.yaml`, `.review-surfaces/risks.yaml`, and `.review-surfaces/agent_handoff.md`.
7. Convert packet findings into code changes, tests, spec updates, feedback files, or explicit deferrals.

## Evidence Rules

- Treat `.review-surfaces/` as the primary product surface.
- Do not use hosted comments, dashboards, CI, or provider calls as prerequisites for local packet generation.
- Do not claim a command passed unless a transcript or inspected output exists.
- Treat missing logs, missing tests, and missing implementation as missing evidence rather than prose to fill in.
- Keep packet output compact enough for a human reviewer to use.
