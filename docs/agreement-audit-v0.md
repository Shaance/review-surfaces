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

The audit does not emit a clean conclusion from one model's `complete=true`
claim. A separate completeness pass must give every eligible user, assistant,
and agent event exactly one disposition; each represented event must point to
its own atomic agreement. The deterministic validator rejects duplicate,
missing, broad, or unsupported dispositions. Because both ledgers remain
model-generated, structural validation alone cannot certify clause-level
completeness. The operator must review them and supply the content-bound
confirmation token from `audit.json`; if regeneration changes any input or ledger
byte, the token no longer matches. Only then may the audit unlock the deliberately
narrow clean message:

> No conversation-grounded mismatch was found for `<head>`. Code correctness was
> not assessed.

When the conversation scope is missing or incomplete, the audit says it cannot
conclude. It does not fall back to a generic risk inventory.

There is no fixed word or decision limit. The output contains every independently
material agreement proposed by the agent and accepted by grounding. Transport
limits must produce continuation plus an explicit incomplete state; they may not
silently hide decisions.

## Default integrated journey

The public command derives the exact evidence rather than accepting a prepared
input object:

```text
Git merge-base/head + snapshotted conversation + command transcripts
  -> normalized, content-addressed audit input
  -> schema-bound agreement extraction
  -> separate completeness pass
  -> deterministic citation, scope, and completeness grounding
  -> adaptive Markdown and JSON agreement audit
```

```bash
review-surfaces audit --base origin/main
```

Every selected transcript set is treated as partial unless the operator passes
`--conversation-scope complete`. High-confidence auto-discovery can identify a
likely producing session, but does not prove that no other governing session
exists. The completeness assertion is recorded as a caveat in the result. A
working-tree diff is refused because immutable exact-line links require a
committed or explicitly pinned head.

The first structurally complete run remains protective and prints a confirmation
token. After reviewing `agreement-audit-candidate.json` and
`agreement-audit-completeness.json`, rerun with
`--confirm-extraction <token>`. This deliberate second step is the minimum safe
friction needed to prevent two model passes from jointly omitting a clause. The
confirmation path reuses the reviewed saved ledgers rather than regenerating them.

## Advanced manual recovery

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

After an agent writes the candidate JSON, generate a separate completeness prompt:

```bash
node bin/agreement-audit.js completeness-prompt \
  --input bench/agreement/cases/late-correction.input.json \
  --candidate /path/to/candidate.json
```

Then validate and render both outputs:

```bash
node bin/agreement-audit.js finalize \
  --input bench/agreement/cases/late-correction.input.json \
  --candidate /path/to/candidate.json \
  --completeness /path/to/completeness.json \
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

The comparison protocol requires both arms to use the same model, input, output
contract, context/output budget, and three runs per case. The intended product
evidence thresholds are:

- valid exact citations for every material conclusion;
- no false mismatch on the clean case;
- at least 0.15 macro-F1 uplift over the plain-agent prompt; and
- at least 2:1 blinded reviewer preference for faster, clearer decisions.

The manifest content-addresses every input and hidden gold file. The runner
refuses changed fixtures, records the hidden-gold digest on each score, rejects
recorded comparisons that mix gold ledgers for a case, binds each preference to
the exact candidate output, and records generation and reviewer-decision time.
At least two thirds of all paired judgments must prefer the product in addition
to the 2:1 preference gate.

Because the first calibration set and prompt were introduced together, those six
cases cannot alone prove generalization. `bench/agreement/holdout/manifest.json`
now freezes a separate three-case holdout before any live comparison. The
`benchmark-check` command checks recorded bundles for exactly three matched runs
per arm per case, frozen manifest hashes, and output-bound blinded preference
judgments. It is not a release gate: scores and reviewer records are supplied by
the caller, so its output explicitly remains untrusted and can never claim a
pass. A future release gate must recompute results from provenance-bound raw
outputs and authenticate reviewer records.
Later fixture or gold changes require a new benchmark version; prior versions
remain immutable.

The repository still does **not** claim that the product has beaten the baseline
until matched live runs and blinded judgments are recorded. Provider truncation
may never be represented as a complete audit.
