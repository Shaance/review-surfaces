---
name: review-surfaces
description: Use when implementing, testing, or dogfooding the review-surfaces repository. Enforces spec-first work from features/review-surfaces.feature.yaml and local-first review packet artifacts under .review-surfaces.
---

# review-surfaces

Use this skill when working inside the `review-surfaces` repository.

## Related Skills

- Use `.agents/skills/review-surfaces-usage/SKILL.md` for the reusable local packet workflow in another repository.
- Use `.agents/skills/review-surfaces-dogfood-loop/SKILL.md` when a self-review packet should drive product improvements.

## Source Order

1. Read `features/review-surfaces.feature.yaml`.
2. Read `docs/review-surfaces-trd.md`.
3. Read `docs/dogfooding.md`.
4. Read `.review-surfaces/agent_handoff.md` and `.review-surfaces/review_packet.md` when present.

## Workflow

1. Identify the active milestone and relevant Acai-style IDs.
2. Make the smallest local-first change that moves the milestone forward.
3. Keep provider integrations, hosted services, and PR comments out of the core path until the local artifact pipeline is useful.
4. Run the strongest available local checks.
5. Run `review-surfaces all --dogfood --out .review-surfaces` when the CLI exists.
6. Record generated limitations or product friction as dogfood findings, feedback files, code changes, tests, schema updates, or explicit deferrals.

## Evidence Rules

- Preserve IDs such as `review-surfaces.COLLECTOR.2` in tests and artifacts where useful.
- Do not claim tests passed unless command output was inspected.
- Mark missing files, logs, tests, and evidence as unknown or missing evidence.
- Do not rely on private local scripts, hidden chat context, or coffee-agents paths as product dependencies.
