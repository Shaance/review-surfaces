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

## Proactive live dogfood — read the OUTPUT, not just the gate

The local gate (`scripts/local-gate.sh`) runs `--provider mock` over an EMPTY
`HEAD..HEAD` self-dogfood. That proves byte-stable determinism and schema validity
— it does NOT prove a feature produces *sensible* output. **Passing the gate is
necessary, not sufficient.** A green suite of fixture tests can hide a surface that
dumps garbage on a real session. So run the tool against a REAL diff and read what
it generates:

```bash
pnpm run local-review        # all --dogfood over origin/main...HEAD, + cockpit + validate, to .review-surfaces
# or, to a scratch dir (the raw bin shim needs a built dist/ — run `pnpm run build` first):
node bin/review-surfaces.js all --provider mock --dogfood --base origin/main --head HEAD --out /tmp/dog
```

Use the branch's merge-base (`--base origin/main`), NOT `HEAD~1` — a single-commit
range reviews only the last commit and misses files changed earlier in a multi-commit
branch. Keep `--dogfood` or `dogfood.yaml` and `agent_handoff.md` are not built.

In a **Claude Code** session, auto-discovery finds this repo's own transcript under
`~/.claude/projects/<cwd-slug>/` (announced on stderr). In a **Codex or Cursor**
session discovery finds nothing (it scans only the Claude store) and the run degrades
to `conversation_log_missing` — pass `--conversation <file>` explicitly there. Then
open and READ:

- `.review-surfaces/human_review.html` (or `/tmp/dog/...`) — the cockpit (incl. the "Agent workflow audit" card).
- `human_review.json` → `.methodology_audit` — `considered`/`research`, `workflow_findings`, `quality_flags`.
- `methodology.yaml`, `risks.yaml` (look for `CONV-GAP-*`).

Real sessions are NOT the test fixtures: they carry kilobyte tool-call bodies,
secret-shaped test strings, and loose event kinds. Clean fixtures hide that, so a
live run is what surfaces it (e.g. it caught the methodology pick dumping whole tool
bodies onto the cockpit — a bug the full test suite missed).

### Validating the LLM leaves (`ai-sdk`)

The methodology *audit* and CONV-GAP leaves need a remote provider AND a real diff
(CONV-GAP only grounds a gap on a CHANGED file, so an empty `HEAD..HEAD` range leaves
it unexercised). `ai-sdk` DEFAULTS to Google, so an unqualified run needs
`GOOGLE_GENERATIVE_AI_API_KEY`; if `.env.local` only has an Anthropic or OpenAI key,
pass the matching `--model` (`anthropic:<id>` / `openai:<id>`) so that provider's key
is read instead — otherwise the run skips with "GOOGLE_GENERATIVE_AI_API_KEY is not set":

```bash
set -a; . ./.env.local; set +a   # source the provider key; never paste or commit it
pnpm run build                   # the raw bin shim refuses to run an unbuilt dist/
node bin/review-surfaces.js all --provider ai-sdk --dogfood --conversation <clean.md> --base origin/main --head HEAD --out /tmp/dog
#   add e.g. --model anthropic:claude-sonnet-4-6  (or --model openai:gpt-...) for a non-Google key
```

The privacy guard REFUSES to send a transcript or diff that holds a blocked-kind
secret (`remote_provider_blocked` → "AI SDK provider skipped because collected
inputs contained high-risk secret material") — nothing leaves the machine. The block
fires when EITHER the diff OR the conversation carries a blocked-kind secret, so a
clean transcript is NOT enough on its own — the DIFF must also be secret-free. The
real session and the secret-bearing test fixtures self-block by design, so feed a
CLEAN synthetic transcript (no secret strings) via `--conversation`; and if your
branch's real diff edits those secret-shaped fixtures, validate the leaves over a
SEPARATE secret-free range instead of this branch (otherwise the run still skips).
Confirm there is no "skipped" line. Then check the right success signal: a clean
transcript with no real gaps legitimately produces an EMPTY gap set, so "`CONV-GAP-*`
appeared" is NOT the criterion. Check instead that the degraded flags cleared —
`methodology_analysis_degraded` is gone and `risks.yaml` no longer carries
`methodology_test_gap_degraded` — and read any `workflow_findings` / `CONV-GAP-*`
records that did populate.

## Review Rules

- Keep local files first; provider integrations and PR comments are later renderers.
- Prefer exact Acai IDs in tests and artifacts when they clarify evidence.
- Mark hypotheses and missing evidence directly; do not inflate coverage.
- Do not treat generated `.review-surfaces/` prose as proof for a requirement.
