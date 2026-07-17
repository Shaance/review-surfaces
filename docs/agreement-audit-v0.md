# Agreement audit v0

## The one job

When a coding agent says work is ready, the human needs to know whether the
change matches the **final agreement** reached across the conversation, so they
can focus review on ignored corrections, crossed boundaries, unfinished
commitments, and unsupported validation claims.

This is not a generic code reviewer. A strong coding agent can already inspect a
diff. `review-surfaces` earns its existence only through the trust envelope around
that reasoning:

- exact transcript snapshots, including more than one session;
- explicit complete, partial, ambiguous, or missing conversation scope;
- one exact base/head range;
- citations restricted to supplied conversation events, exact diff lines, and
  head-bound command evidence;
- a clean result derived by the validator, never declared by the model; and
- an inconclusive result whenever evidence is truncated, rejected, or incomplete.

## Reviewer experience

The first visible section answers only: **what needs my decision now?** Each item
states the divergence or unresolved agreement, the decision required, and the
exact evidence. The final goal, fulfilled agreements, provenance, and limitations
are supporting detail.

Milestone one does not emit a clean conclusion from one model's `complete=true`
claim. If it finds no decision, it says extraction completeness was not
independently verified and remains inconclusive. A later independent completeness
verifier may unlock the deliberately narrow clean message:

> No conversation-grounded mismatch was found for `<head>`. Code correctness was
> not assessed.

When the conversation scope is missing or incomplete, the audit says it cannot
conclude. It does not fall back to a generic risk inventory.

There is no fixed word or decision limit. The output contains every independently
material agreement proposed by the agent and accepted by grounding. Transport
limits must produce continuation plus an explicit incomplete state; they may not
silently hide decisions.

## Milestone-one vertical slice

Build the isolated spine:

```text
normalized conversations + exact diff/head + commands
  -> same-contract agent candidate
  -> deterministic citation and scope grounding
  -> adaptive Markdown agreement audit
```

Generate either the plain-agent baseline prompt or the product prompt:

```bash
pnpm run build:fast
node bin/agreement-audit.js prompt \
  --input bench/agreement/cases/late-correction.input.json \
  --mode review-surfaces
```

After an agent writes the candidate JSON, validate and render it:

```bash
node bin/agreement-audit.js finalize \
  --input bench/agreement/cases/late-correction.input.json \
  --candidate /path/to/candidate.json \
  --out .agreement-audit
```

`audit.json` is the grounded machine result. `audit.md` is the reviewer surface.
An incomplete audit exits with code 4.

## Falsifiable benchmark

`bench/agreement/` content-addresses six development calibration pairs:

1. clean alignment;
2. a violated late correction;
3. unauthorized scope;
4. promised work omitted from the diff;
5. an agent validation claim contradicted by exact-head evidence; and
6. ten independent agreements, so a fixed eight-item cap fails visibly.

The gold ledger is loaded only by the evaluator. It is not included in either
candidate prompt. Candidate-to-gold semantic matches require blinded adjudication;
exact citation validation remains automatic.

The harness requires both arms to use the same model, input, output contract,
context/output budget, and three runs per case. Its release gate requires:

- valid exact citations for every material conclusion;
- no false mismatch on the clean case;
- at least 0.15 macro-F1 uplift over the plain-agent prompt; and
- at least 2:1 blinded reviewer preference for faster, clearer decisions.

The manifest content-addresses every input and hidden gold file. The runner
refuses changed fixtures, binds each preference to the exact candidate output,
and records generation and reviewer-decision time. At least two thirds of all
paired judgments must prefer the product in addition to the 2:1 preference gate.

Because this first calibration set and prompt are introduced together, these six
cases cannot alone prove generalization. This milestone is score-only and is not
an executable release gate. Before live gating or a superiority claim, milestone
two must add the independent completeness verifier and a separate holdout
manifest frozen and landed before any prompt changes or live runs. Later fixture
or gold changes require a new benchmark version; prior versions remain immutable.

This milestone establishes the harness and the validation half of the trust
contract. It does **not** independently derive the diff, head, command, or
transcript hashes from Git and conversation storage. The CLI's `finalize` command
therefore labels its evidence as supplied JSON. Trusted collection is milestone
two, and no exact-head provenance claim is warranted before it ships.

This milestone also does **not** claim that the product has beaten the baseline
until the matched live runs and blinded judgments are recorded. Adaptive
provider-context chunking is deferred with provider integration; truncation may
never be represented as a complete audit.
