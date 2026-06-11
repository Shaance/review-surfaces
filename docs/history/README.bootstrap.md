# review-surfaces bootstrap bundle

Copy this bundle into the root of a new or existing `review-surfaces` repository.

## Files

```text
AGENTS.md
CODEX_GOAL.md
features/review-surfaces.feature.yaml
schemas/review_packet.schema.json
docs/review-surfaces-trd.md
docs/dogfooding.md
.agents/skills/review-surfaces/SKILL.md
```

## Intended use

1. Commit these files as the project bootstrap.
2. Give `CODEX_GOAL.md` to Codex or paste it as the implementation goal comment.
3. Ask the agent to implement M0 and the first deterministic M1 slice.
4. Require the agent to dogfood whatever exists and record missing capability explicitly.

## Core design choice

The product is not a PR comment bot. It is a local review packet compiler. GitHub/GitLab/CI integrations should consume `.review-surfaces/` artifacts later.
