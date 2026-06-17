# Dogfooding plan for review-surfaces

The project should use its own partial capabilities as soon as they exist. Dogfooding is not a later marketing exercise; it is part of the product architecture.

## Milestone expectations

| Milestone | Expected self-use |
|---|---|
| M0 | Bootstrap files exist. Manual packet scaffold and first feedback file are acceptable. |
| M1 | Collector/indexer inspects this repo and preserves ACIDs from `features/review-surfaces.feature.yaml`. |
| M2 | Intent builder generates `intent.yaml` for this project. Misunderstood requirements become spec, prompt, or schema fixes. |
| M3 | Evaluator and risk analyzer compare the current branch against the feature spec and identify missing tests or overreach. |
| M4 | Diagrams are used to review whether module boundaries remain understandable. |
| M5 | Methodology audit, dogfood manager, and handoff renderer generate `dogfood.yaml` and `agent_handoff.md`. |
| M6 | GitHub/CI integration reuses local artifacts and does not redefine the core workflow. |

## Skill-assisted loop

Use `.agents/skills/review-surfaces-dogfood-loop/SKILL.md` when a self-review packet should drive the next product change (`review-surfaces.DOGFOOD.8`). Use `.agents/skills/review-surfaces-usage/SKILL.md` when applying the packet workflow to another repository (`review-surfaces.BOOTSTRAP.6`).

Use `.agents/skills/composed-review-loop/SKILL.md` when a review should combine the packet, command transcripts, dogfood findings, PR comments, and a full-diff code review into one synthesized readiness decision (`review-surfaces.DOGFOOD.9`).

The dogfood-loop skill should not replace the packet. It should make the loop repeatable: implement a scoped change, capture command evidence, generate local artifacts, inspect the packet, then convert useful findings into code, tests, schema, specs, docs, skills, feedback files, or explicit deferrals.

## Live-dogfood checklist (read the output, not just the gate)

The local gate (`scripts/local-gate.sh`) runs `--provider mock` over an empty `HEAD..HEAD` self-dogfood. It proves byte-stable determinism and schema validity, but it is **blind to whether a surface produces sensible output** — a fully green fixture suite can still ship a cockpit full of garbage. Passing the gate is necessary, not sufficient. Before calling a feature done:

1. **Run it on a real diff.** `pnpm run local-review` (all `--dogfood` over `origin/main...HEAD` + cockpit + validate), or to a scratch dir `node bin/review-surfaces.js all --provider mock --dogfood --base origin/main --head HEAD --out /tmp/dog`. Use the merge-base (`--base origin/main`), NOT `HEAD~1` — a single-commit range reviews only the last commit and misses earlier files in a multi-commit branch; keep `--dogfood` or `dogfood.yaml`/`agent_handoff.md` are not built. In a **Claude Code** session auto-discovery finds this repo's own transcript under `~/.claude/projects/<cwd-slug>/` (announced on stderr); in **Codex/Cursor** discovery scans only the Claude store, finds nothing, and degrades to `conversation_log_missing` — pass `--conversation <file>` there.
2. **Read what it generated**, not just whether it exited 0. `pnpm run local-review` writes to `.review-surfaces/` (the scratch command writes to `/tmp/dog/`); open `.review-surfaces/human_review.html` and read `.review-surfaces/human_review.json` `.methodology_audit` (`considered`/`research`/`workflow_findings`/`quality_flags`), `methodology.yaml`, and `risks.yaml` (`CONV-GAP-*`). (Substitute `/tmp/dog/...` if you used the scratch command.)
3. **Remember real sessions ≠ fixtures.** They carry kilobyte tool-call bodies, secret-shaped test strings, and loose event kinds that clean fixtures never exercise — the live run is what surfaces the gap.
4. **Validate the LLM leaves** (methodology audit, CONV-GAP) under a remote provider AND a real diff (CONV-GAP only grounds a gap on a CHANGED file, so an empty `HEAD..HEAD` range leaves it unexercised): `set -a; . ./.env.local; set +a` then `node bin/review-surfaces.js all --provider ai-sdk --dogfood --conversation <clean.md> --base origin/main --head HEAD --out /tmp/dog`. The privacy guard refuses to send when **either** the diff **or** the conversation holds a blocked-kind secret (`remote_provider_blocked` → "AI SDK provider skipped"), so a clean transcript is not enough — the **diff** must also be secret-free; if your branch edits the secret-shaped fixtures, validate over a separate secret-free range. Feed a **clean** synthetic transcript, confirm there is no "skipped" line, then check the right success signal: a clean transcript with no real gaps legitimately yields an empty gap set, so don't wait for `CONV-GAP-*` entries — confirm the degraded flags cleared (`methodology_analysis_degraded` gone; `risks.yaml` no longer carries `methodology_test_gap_degraded`).

See `.agents/skills/review-surfaces-dogfood-loop/SKILL.md` for the full procedure.

## Feedback file shape

Store manual feedback under `.review-surfaces/feedback/*.yaml`.

```yaml
schema_version: review-surfaces.feedback.v1
author: human
created_at: 2026-05-27T00:00:00Z
packet_path: .review-surfaces/review_packet.md
findings:
  - id: FB-001
    category: review_value
    severity: medium
    affected_section: Requirement coverage
    finding: The packet listed coverage but did not show the exact tests that prove the requirement.
    desired_change: Include direct and indirect test evidence separately.
```

## Product feedback categories

Use these categories for `dogfood.yaml` and feedback files:

- `usability`: command, setup, speed, or workflow friction;
- `review_value`: packet did not help the human reviewer focus;
- `evidence_quality`: claims lacked evidence or evidence was hard to inspect;
- `agent_workflow`: handoff or instructions were insufficient for the next agent;
- `schema`: structure was too loose, too strict, or missing fields;
- `diagram_quality`: diagrams were noisy, misleading, or not review-sized;
- `test_gap`: the product failed to identify or explain missing tests;
- `performance`: self-run was too slow or produced too much output.

## Deferral rule

Not every finding must be fixed immediately. A deferral is acceptable only when it records:

- finding ID;
- reason for deferral;
- relevant ACID or module;
- expected milestone;
- evidence or packet path that motivated the finding.
