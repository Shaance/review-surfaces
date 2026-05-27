# Codex goal comment: bootstrap and start implementing `review-surfaces`

Goal: turn this repository into the first working version of `review-surfaces`, a local-first review packet compiler for agent-generated code changes.

Use the bootstrap bundle as the project contract:

- `features/review-surfaces.feature.yaml` is the source-of-truth requirements ledger. Preserve Acai-style IDs such as `review-surfaces.COLLECTOR.2` in implementation notes, tests, and packet outputs where useful.
- `docs/review-surfaces-trd.md` explains the architecture, artifact model, milestones, and dogfooding loop.
- `schemas/review_packet.schema.json` is the initial machine-readable packet contract.
- `AGENTS.md` defines the working rules for agents in this repo.
- `.agents/skills/review-surfaces/SKILL.md` defines the local review-surfaces agent workflow.
- `docs/dogfooding.md` defines how the product must be used on itself while it is being built.

Do not start with GitHub comments, hosted services, dashboards, or CI-first workflows. Those are later renderers. The core product is the local `.review-surfaces/` artifact directory.

Recommended implementation strategy:

1. Inspect the existing repo. Reuse any useful local `AGENTS.md`, scripts, or coffee-agents bootstrap conventions if present, but do not create product dependencies on private local paths.
2. Create a TypeScript CLI package scaffold if one does not already exist.
3. Implement milestone M0 first:
   - CLI entrypoint and help output;
   - config loader;
   - `validate` command;
   - review packet schema validation;
   - mock/offline LLM provider interface;
   - basic tests and fixtures.
4. Implement the first deterministic vertical slice from M1:
   - parse `features/**/*.feature.yaml`;
   - support Acai string and object requirement notation;
   - generate ACIDs with shape `<feature-name>.<GROUP_KEY>.<ID>`;
   - collect changed files and basic git metadata;
   - write `.review-surfaces/manifest.json` and `.review-surfaces/inputs/specs.index.json`.
5. Produce a skeleton `review_packet.json` and `review_packet.md` with unknowns for modules that do not exist yet. Do not invent evidence.
6. Add tests for Acai parsing, ACID generation, config loading, schema validation, and minimal collection.
7. Run the strongest available self-review command. If the full CLI is not ready, create `.review-surfaces/feedback/manual-dogfood.yaml` explaining what could not yet be dogfooded and why.
8. Update `.review-surfaces/agent_handoff.md` or a handoff note with what was implemented, what passed, what failed, and the next recommended tasks.

Hard constraints:

- Local files first; provider integrations later.
- Deterministic shell, bounded LLM leaves.
- Every substantive claim needs evidence or must be marked unknown/hypothesis/missing evidence.
- Never claim tests passed unless commands were actually run or test output was inspected.
- Do not rely on hidden chat context; persist useful context into specs, docs, packet artifacts, or handoff files.
- Keep generated packets compact enough for a human reviewer.

First success condition: a maintainer can run a local command or test suite and see that the repo can parse its own Acai feature spec, validate the packet schema, and produce the first `.review-surfaces/` artifacts without network access.
