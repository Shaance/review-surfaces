# human-value polish uplift — goal contract

Status: **in progress** (started 2026-06-14). The eighth development uplift, and
the last polish pass before the repository goes public.

## Theme

Raise the **signal-to-noise of every surface a human reviewer actually reads**.
`review-surfaces` already computes the right facts; this uplift makes the
rendered output crisp and trustworthy rather than noisy and templated. Every
item fits the existing pipeline (render-layer string changes, a few narrow
model-layer honesty fixes, doc/test/spec additions). No rewrites, no new
frameworks, no dependency swaps, and output stays byte-deterministic for
identical inputs.

## Grounding

A multi-agent discovery survey (eight surface-cluster reviewers, each wearing
the "busy senior reviewer" hat over the real self-review output, plus
adversarial per-finding verification, run 2026-06-14) over the current tree.
36 findings were confirmed real and worth fixing; three were rejected on
inspection (the narrative checkmark glyph, the evidence-gated `ready_to_post`
line, and the deliberately-multi-bucket intent-mismatch contract).

The five highest-leverage themes:

1. **Anchor honesty.** Two ranked queue items (project-wide aggregate
   statistics — "N requirement(s) have weak test evidence", "N changed file(s)
   did not map") borrowed an unrelated `firstChangedHunk` and advertised it as a
   "precise diff anchor" at "high" confidence. The single biggest trust leak.
2. **Standalone surfaces noisier than their summary.** `trust_audit.md`,
   `test_plan.md`, and `evidence_cards.md` exploded templated items that the
   embedded `human_review.md` sections already collapse via the shipped rollup
   helpers — the deep-dive surface a reviewer opens was worse than the summary
   they came from.
3. **Empty / echo trailer boilerplate.** "Requirements: none / Linked risk IDs:
   none", self-referential "Evidence: <the file already named>", a dead
   "Optional / No items" section, and a "Why ranked here" line that just
   restates the priority — all padding that trains the eye to skip the trailer.
4. **The HTML cockpit buried the pitch.** The first screen never named the three
   questions the README promises (overreach / weakened tests / unbacked claims),
   the summary restated the verdict badge in engine-internal counts, a 51-row
   reading-order wall preceded the ranked queue, and command anchors rendered as
   the literal word "command".
5. **Sticky-comment delta cried wolf.** One aggregate risk was reported as both
   resolved and new (its count is baked into the identity key), 39 phantom
   test-evidence flaps were the loudest line, every sub-bullet repeated its
   section-header prefix, and the verdict's only headline reason pointed at
   off-diff bookkeeping while the real in-diff risks never reached the Reasons
   block.

## Spec entries

New Acai requirements promoted ahead of (and shipped with) the implementation:

- `RANKING.4` — aggregate-rollup risks render at file level, never a borrowed
  "precise" anchor; `RANKING.5` — suppress the default "why ranked here" echo.
- `HUMAN_TRUST.6` — the verdict surfaces the top in-diff risk co-equally with a
  soft missing-evidence reason.
- `EVIDENCE.8` — feedback-recorded passed commands are claims, not Verified
  facts.
- `HUMAN_REVIEW.24` — summary leads with blocker/queue counts; `HUMAN_REVIEW.25`
  — suppress self-referential suggested-comment evidence; `HUMAN_REVIEW.26` —
  flag a skippable all-negation route; `HUMAN_REVIEW.27` — cockpit answers the
  three questions and uses honest evidence anchors. `HUMAN_REVIEW.23` extended to
  omit (not placeholder) the empty risk/requirement trailer.
- `READING_ORDER.3` — collapse the leg-header echo and cap the cockpit reading
  wall behind a details element.
- `TREND.3` — drop the redundant direction encoding; `TREND.4` — collapse
  homogeneous regressed flaps; `TREND.5` — dedupe a count-moved aggregate.

The rollup reuse (`test_plan.md` / `trust_audit.md` / `evidence_cards.md`), the
empty-section omission, the API call-to-action coherence, the suggested-comment
dedupe, the requirement-specific test-plan "Expected", and the draft-review body
prefixing extend existing requirements (`HUMAN_REVIEW.19/.21/.23`,
`RANKING.2`, `SEMANTIC_DIFF.4`, `PRIVACY.6`/`PROVIDERS.7`) rather than adding new
ones.

## Discipline

Every change keeps output byte-deterministic for identical inputs and validates
against the checked-in schemas. The four model-layer honesty changes (anchor
demotion, verdict reason, trust-bucket reclassification, since-delta dedupe) are
scoped narrowly with their schema/test risk recorded, and each new requirement
carries an exact-ACID implementation comment and a focused test.
