# Execplan: agreement-audit product integration

## Context

The agreement audit has a strong deterministic grounding core, but the public
product does not yet deliver that value as one coherent journey. A reviewer must
prepare JSON, run an external agent, provide candidate JSON, and finalize it;
clean results cannot be separately verified; evidence is hard to inspect; and
the README still teaches the legacy packet compiler as the main product.

The source of truth remains `docs/agreement-audit-v0.md`. This plan integrates
the existing collection, provider, grounding, and benchmark layers without
weakening exact-head provenance or inventing research evidence.

## Product decisions

1. **One command is the default journey.** `review-surfaces audit` collects the
   exact review range, conversation, diff, and command evidence; runs extraction
   and a separate completeness pass; grounds the result; and writes both JSON
   and reviewer-first Markdown.
2. **Collection owns provenance.** Audit inputs are derived from the repository
   and snapshotted conversation/command artifacts. Session discovery establishes
   likely production provenance, not scope completeness; explicit completeness
   assertions remain labeled in the result.
3. **Clean is a verified state.** `no_mismatch_found` is allowed only when every
   eligible conversation event has exactly one supported disposition and the
   separately generated completeness pass reports no missing agreement and its
   event/key relationships pass deterministic checks.
4. **Results are decision surfaces.** Findings separate the reviewer decision
   from the recommended author follow-up, include exact-source links or bounded
   transcript context, and compare stable decision keys with a previous audit.
5. **Claims follow evidence.** The public docs lead with the agreement audit.
   Calibration and frozen holdout data are named separately, and the product-
   value gate remains explicitly unproven until blinded reviewer judgments exist.

## Milestone 1 — trusted one-command journey

Build a narrow integration layer that maps the existing collector output into an
`AgreementAuditInput`, invokes the configured structured provider for extraction
and completeness, and writes the final artifacts. Preserve the advanced
`agreement-audit prompt/finalize` commands for offline/manual operation.

Exit criteria:

- a new user can reach a grounded result with one documented command;
- the result records exact base/head SHAs and snapshot provenance;
- incomplete or ambiguous collection fails closed with a useful next action;
- provider failure preserves collected inputs and explains how to resume.

## Milestone 2 — trustworthy clean and inspectable decisions

Add a strict completeness contract and parser, deterministic validation against
the candidate and eligible events, exact blob links for diff evidence, bounded
conversation context, clear reviewer/author roles, and previous-audit decision
deltas.

Exit criteria:

- an unverified clean candidate remains `cannot_audit`;
- a fully covered, separately verified clean candidate becomes
  `no_mismatch_found`;
- duplicate, missing, or unsupported dispositions fail closed;
- each decision exposes its source evidence and action owner;
- reruns distinguish new, unchanged, and resolved decisions.

## Milestone 3 — honest public surface and release evidence

Make the README and CLI help lead with the agreement audit, group the packet
compiler under an explicit legacy heading, add frozen holdout cases and an
honestly labeled recorded-bundle checker, and document the still-required
provenance-bound blinded reviewer study.

Exit criteria:

- the quickstart teaches the coherent audit journey;
- calibration cases cannot be mistaken for holdout evidence;
- recorded comparison checks cannot be presented as trusted release evidence or
  satisfied into a product-superiority claim with fabricated judgments.

## Verification

At milestone boundaries:

```bash
pnpm run build:fast
node --test dist/tests/agreement-audit*.test.js dist/tests/agreement-benchmark.test.js
pnpm run local-review
pnpm run local-gate
```

The final verification must also run the real CLI on the current branch, inspect
the rendered Markdown and JSON, review the full diff, and keep the blinded value
claim labeled as a remaining evidence gap unless representative judgments are
actually supplied.

## Decision log

- 2026-07-20: integrate existing trusted components instead of adding a second
  audit stack.
- 2026-07-20: keep manual prompt/finalize as an advanced recovery route.
- 2026-07-20: do not manufacture user-research or holdout success claims.
