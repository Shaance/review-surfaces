---
name: review-surfaces-dogfood-loop
description: Use when improving review-surfaces itself by running the local packet pipeline, inspecting findings, and turning dogfood feedback into product changes or explicit deferrals.
---

# review-surfaces dogfood loop

Covers `review-surfaces.DOGFOOD.8`.

Use this skill when a change to `review-surfaces` should be reviewed by `review-surfaces` before handoff.

## Workflow

1. Read `features/review-surfaces.feature.yaml`, `docs/review-surfaces-trd.md`, `docs/dogfooding.md`, and the latest `.review-surfaces/agent_handoff.md` when present.
2. Choose the milestone and Acai IDs the change is meant to advance.
3. Implement the smallest local-first change that improves the packet compiler or its workflow.
4. Capture checks with `review-surfaces run -- <command>` when command transcript evidence is useful.
5. Run `review-surfaces all --dogfood --out .review-surfaces` against the current branch.
6. Inspect the generated packet for overstated coverage, missing evidence, test gaps, overreach, invalid evidence, and unclear handoff.
7. Convert each useful dogfood finding into one of: code, test, schema, spec, docs, skill update, feedback file, or explicit deferral with evidence.
8. Update `.review-surfaces/agent_handoff.md` or a feedback file so the next agent does not depend on hidden chat context.

## Review Rules

- Keep local files first; provider integrations and PR comments are later renderers.
- Prefer exact Acai IDs in tests and artifacts when they clarify evidence.
- Mark hypotheses and missing evidence directly; do not inflate coverage.
- Do not treat generated `.review-surfaces/` prose as proof for a requirement.
