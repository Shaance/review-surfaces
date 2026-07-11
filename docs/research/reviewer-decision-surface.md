# Research: reviewer decision surfaces

## Problem

The current product is evidence-rich but decision-poor. A live self-review can
produce a clean-looking cockpit whose first actionable queue item appears after
an exhaustive reading order and change map. Repository-wide requirement counts,
keyword-picked methodology excerpts, and mechanically detected API/import changes
can dominate the result even when they do not change whether a reviewer should
approve the pull request.

The audit that initiated this program reproduced five concrete failure classes:

1. A real Codex transcript produced a packet that violated its own `maxLength`
   schema contract even though focused schema and conversation tests passed.
2. Transcript discovery selected the audit session instead of the implementation
   session because changed path strings appeared in generated report output.
3. The 50 KB human Markdown put an 80-file tour and map before the ranked queue.
4. Additive optional schema fields generated blocking, ready-to-post comments.
5. The default offline path rendered no useful conversation reconstruction.

## External evidence

Google's reviewer guide recommends a three-stage navigation model: establish that
the change makes sense, inspect the most important part first, then read the rest
in an appropriate sequence. Its broader review guidance treats design,
functionality, complexity, tests, and code health as reviewer judgments rather
than an inventory of every detectable fact. It also explicitly distinguishes
required changes from suggestions and warns against blocking progress on
low-importance polish.

Microsoft Research's study of modern code review found that change understanding
is the key challenge and that existing tools often fail to meet reviewers'
understanding needs. Defect detection matters, but knowledge transfer, awareness,
and alternative solutions are also important outcomes. This supports a surface
that explains intent and approval-changing evidence before presenting exhaustive
mechanical detail.

GitHub's review workflow reinforces a useful separation: a reviewer examines
individual files, tracks progress, leaves anchored comments, and finally submits
one approval/request-changes decision. The product should assist those decisions,
not replace them with a large undifferentiated scorecard.

Sources:

- Google Engineering Practices, “Navigating a CL in review”:
  https://google.github.io/eng-practices/review/reviewer/navigate.html
- Google Engineering Practices, “The Standard of Code Review”:
  https://google.github.io/eng-practices/review/reviewer/standard.html
- Google Engineering Practices, “What to look for in a code review”:
  https://google.github.io/eng-practices/review/reviewer/looking-for.html
- Bird and Bacchelli, “Expectations, Outcomes, and Challenges of Modern Code
  Review,” ICSE 2013:
  https://www.microsoft.com/en-us/research/publication/expectations-outcomes-and-challenges-of-modern-code-review/
- GitHub Docs, “Reviewing proposed changes in a pull request”:
  https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request
- Ajv security guidance: generated/provider-influenced strings and arrays should
  be bounded before validation; schema `maxLength` is a guard, not a substitute
  for producing valid bounded artifacts:
  https://github.com/ajv-validator/ajv/blob/master/docs/security.md

## Viable approaches

### A. Renderer-only reordering

Move the current queue above the map and collapse large sections. This is low
risk and improves time-to-first-finding, but it preserves inflated risks, false
blocking comments, duplicate findings, and low-quality conversation inputs.

### B. Decision projection over the existing evidence graph

Keep the packet and deterministic facts as the evidence backbone, but introduce a
reviewer-decision projection with strict admission rules. Only PR-scoped,
approval-changing, evidence-backed root causes enter the top surface. Repository
compliance, maps, tours, and methodology remain available as supporting detail.

### C. Replace the pipeline with provider-written review prose

This may produce more natural summaries, but it conflicts with local-first,
deterministic trust boundaries and makes correctness dependent on a remote model.

## Chosen direction

Use approach B, delivered incrementally. Renderer-only improvements are included
where they support the decision projection, while deterministic evidence remains
the source of truth. Provider analysis may enrich reviewer language but cannot be
required for a useful offline report or determine blockers.

The top surface will optimize for:

- time to first useful finding;
- false-blocking rate;
- actionable findings in the top five;
- duplicate root-cause rate;
- agreement between displayed severity and the final decision;
- percentage of suggested comments a reviewer would actually post;
- real-session artifact validity.

## Constraints

- Preserve local/offline operation and current machine-readable evidence.
- Keep LLM output advisory and unable to create or clear blockers.
- Do not hide missing evidence, but distinguish incomplete input from author fault.
- Never ingest generated review output as methodology or validation claims.
- Keep each milestone independently releasable and small enough to review.
- Reassess from merged `main` after every milestone; do not stack all four changes
  into one large pull request.

