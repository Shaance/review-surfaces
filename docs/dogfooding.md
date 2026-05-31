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
