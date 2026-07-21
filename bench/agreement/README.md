# Agreement-audit benchmark

This benchmark asks whether `review-surfaces` adds value beyond giving the same
strong agent the same transcript and diff with a short, competent prompt.

The two arms differ only in prompt instructions:

- `plain-agent`: asks for the final request, commitments, mismatches, and reviewer decisions;
- `review-surfaces`: adds chronological supersession, atomic agreement coverage,
  strict evidence states, and explicit incompleteness rules.

Both arms receive the same `*.input.json`, candidate JSON contract, model,
context/output budget, and three runs per case. Neither receives `*.gold.json`.
After generation, a blinded adjudicator maps candidate-owned keys to the hidden
gold ledger and compares which surface enables the review decision faster.

The six development-calibration cases cover a clean control, a late correction, unauthorized
scope, omitted promised work, contradicted validation, and a ten-agreement task.
Three are sanitized from real review-surfaces development scenarios; three are
synthetic boundary cases.

Benchmark version 2 binds every hidden gold agreement to its exact expected
diff coordinates and command ids, so a semantically correct conclusion cannot
score by pointing at unrelated evidence. The manifest content-addresses each
input and hidden gold file. The runner refuses a fixture whose bytes no longer
match its recorded SHA-256 digest, records that gold digest on every score, and
rejects recorded comparisons that mix gold ledgers for one case.
Changing a case requires an explicit benchmark version rather than an in-place
edit during prompt comparison.

This calibration set and the initial prompt are introduced together, so these
cases are score-only and not sufficient holdout evidence of product superiority.
The separate completeness verifier and an immutable holdout now live under
`holdout/`. They were frozen before any live comparison. Check a recorded bundle
for shape, frozen-manifest hashes, matched arms, and output-bound preferences with:

```bash
node bin/agreement-audit.js benchmark-check \
  --manifest bench/agreement/holdout/manifest.json \
  --comparison /path/to/matched-results.json
```

This is deliberately an **untrusted consistency check**, not a release gate.
Recorded scores and preferences are caller-supplied; the command cannot prove
that model runs occurred or that reviewer judgments are authentic. Its JSON
therefore reports `evidence_trusted: false` and never reports `passes: true`.
Missing runs, altered manifest hashes, or missing judgments still fail the
consistency check; prior benchmark versions stay retained.

The benchmark is not complete until live outputs, adjudications, timing, token
cost, and blinded preference are recorded. Contract tests only prove that the
harness keeps gold out of prompts, preserves adaptive output, and checks the
recorded comparison rules; they do not prove product superiority. A future
release gate must recompute scores from provenance-bound raw outputs and verify
authenticated reviewer records.
