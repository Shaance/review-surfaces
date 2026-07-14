<!-- review-surfaces:sticky -->
## review-surfaces

**Reviewable with attention.**

### Change purpose

Harden abort handling and cross-origin pagination. Attach abort listeners after request handlers run, strip inherited sensitive headers when pagination crosses origins, and document the behavior.

_From the PR title and description._

### Approval decision

1. **Current-head test evidence** — 2 changed implementation files share one unresolved validation question: the available evidence does not yet show that their behavior was exercised at the current head.
   - Review: Confirm the changed behavior is covered, add focused tests only where coverage is missing, and attach one current-head transcript for the relevant test run.
   - Evidence: `source/core/index.ts`, `source/core/options.ts`, `test/abort.ts`

<!-- review-surfaces:fingerprint head=a5b76bffb33d5fa8b0d1393cce410b88e7c2b848 queue=8e67fe5ed6574923dbce -->
