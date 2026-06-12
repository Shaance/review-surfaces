# Human-First Review Surfaces: Comprehensive Feature Proposal

**Working title:** Human Review Cockpit for `review-surfaces`
**Date:** 2026-06-08
**Status:** Raw product/design Markdown draft
**Intended readers:** maintainers, implementation agents, human reviewers, product/design reviewers
**Primary goal:** Reframe `review-surfaces` from an agent-oriented review packet compiler into a human-review decision cockpit that materially reduces review time, review uncertainty, and missed-risk probability.

---

## 1. Executive summary

The current `review-surfaces` direction is fundamentally sound: it collects specs, docs, diffs, tests, logs, and feedback, then produces deterministic, evidence-backed artifacts. The existing architecture is a strong foundation. The problem is product emphasis.

Right now, the product still reads like a **review packet compiler for agent-generated code changes**. That is useful, but not inherently differentiated. Many AI review tools can summarize a diff, list risks, and explain changes. The standout product should instead feel like:

> “Give me the fastest safe path through this review.”

The highest-value surface for a human reviewer is not a packet. It is a **review decision cockpit**:

- Can I approve this?
- What must I inspect first?
- What evidence is verified?
- What evidence is missing?
- What questions should I ask the author?
- Which files or hunks are risky?
- Which files can I safely skim?
- What review comments should I leave?
- What tests or manual checks would unblock approval?

The core change proposed in this document is to add a human-first layer over the existing evidence engine. The evidence engine remains local-first, deterministic, schema-validated, and privacy-conscious. The default rendered surface becomes action-oriented rather than packet-oriented.

---

## 2. Current-state diagnosis

### 2.1 What is already good

The current project already has several strong product primitives:

- Local-first execution.
- Evidence-backed claims.
- Deterministic artifact generation.
- Requirement coverage.
- Risk and test-gap analysis.
- Architecture diagrams and subsystem cards.
- Methodology audit.
- Agent handoff.
- PR-scoped sidecar.
- Anchored LLM narrative for PR mode.
- Privacy and secret-scanning boundaries.
- Structured schema contracts.
- Dogfood loop.

These are valuable building blocks. The concern is not that the current features are bad. The concern is that they are mostly **raw material for review**, not a finished reviewer experience.

### 2.2 Why it feels too agent-oriented

The generated packet is useful to a future agent because it preserves structured state: requirements, evidence, risks, methodology, diagrams, handoff, and deferrals.

A human reviewer, however, usually does not want to consume all that structure. A human reviewer wants a compressed, ranked, decision-relevant surface. The human wants to know:

- Where do I click first?
- What would block merge?
- What is probably noise?
- What did the agent claim without proof?
- What should I ask before approving?
- What evidence would change the decision?

The existing packet is more like a dossier. The target product should be more like a cockpit.

### 2.3 Why it does not yet feel groundbreaking

Most current outputs fall into familiar categories:

- Summary.
- Risk list.
- Coverage table.
- Test gaps.
- Diagram.
- Methodology notes.
- Evidence appendix.

Those are useful, but they do not yet change the reviewer’s workflow enough. To stand out, `review-surfaces` should produce **ranked reviewer actions** rather than only **summaries and classifications**.

The key differentiator should be:

> The tool does not merely explain the PR. It tells the reviewer how to review it.

---

## 3. Source context from the current repository

This document is grounded in the current repository direction. Useful source anchors:

- `README.md:5-17` — The project describes itself as a local-first, evidence-first review-packet compiler for agent-generated code changes, writing local artifacts under `.review-surfaces/`.
- `README.md:82-95` — The current output set includes `review_packet.json`, `review_packet.md`, `architecture.md`, `agent_handoff.md`, `pr_review_surface.json`, per-section YAML artifacts, inputs, and command transcripts.
- `docs/review-surfaces-trd.md:16-19` — The TRD says the product should not replace the reviewer; it should reduce reviewer reconstruction cost.
- `docs/review-surfaces-trd.md:128-139` — The TRD says output should be review-sized and answer: what changed, why, what proves it, what is missing, where to look first.
- `docs/review-surfaces-trd.md:295-314` — Current `review_packet.md` sections are review focus, intent, requirement coverage, architecture, methodology, test gaps, risks, dogfood findings, open questions, evidence appendix.
- `features/review-surfaces.feature.yaml:189-205` — Rendering requirements already mention compact/full modes and PR-mode comments that avoid whole-spec dumps.
- `features/review-surfaces.feature.yaml:241-243` — PR narrative output must answer what changed, why it matters, and where to look first.
- `schemas/pr_review_surface.schema.json:9-21` — PR surface schema currently requires schema version, mode, status, scope, coverage, risks, and LLM metadata.
- `schemas/pr_review_surface.schema.json:71-98` — The PR narrative schema currently models summary, what changed, why it matters, review first, and risk narratives.
- `src/render/pr-comment.ts:141-171` — The PR comment currently renders status, summary, what changed, why it matters, review first, affected coverage, PR risks, change impact diagram, and pointer to the full PR surface.
- `src/pr/contract.ts:80-143` — PR scope currently models changed files, affected areas, affected requirements, and out-of-scope changed files.
- `src/pr/contract.ts:160-185` — PR coverage currently models base/head status, deltas, head evidence, and missing evidence.
- `src/pr/contract.ts:189-216` — PR risks currently include deterministic risk rules and suggested checks.
- `src/risks/pr-risks.ts:61-94` — PR risk candidates are produced deterministically from PR facts.
- `src/llm/pr-narrative.ts:21-28` — PR narrative LLM is limited to prose and may cite only allowlisted anchors.

The proposed direction builds on these contracts rather than discarding them.

---

## 4. Product thesis

### 4.1 Current thesis

Current thesis:

> Local-first, evidence-first review packet compiler for agent-generated code changes.

This is accurate but not strong enough as a product promise.

### 4.2 Proposed thesis

Proposed thesis:

> A local-first review decision cockpit that turns diffs, specs, tests, logs, and feedback into an ordered human review path, with every recommendation tied to evidence.

Shorter version:

> The 10-minute safe review path through an agent-generated PR.

### 4.3 Why this is stronger

“Review packet compiler” describes the implementation.

“Review decision cockpit” describes the user value.

The best version of `review-surfaces` should not compete with generic AI code review comments. It should compete with the reviewer’s own reconstruction process. It should make the reviewer feel:

- I know what this PR is trying to do.
- I know what changed.
- I know what was verified.
- I know what is not verified.
- I know exactly where to start reviewing.
- I know what to ask before approval.
- I know what the author or agent must fix.

---

## 5. Target user workflows

## 5.1 Human reviewer workflow

The reviewer opens a PR or local branch and runs:

```bash
review-surfaces all \
  --review-scope pr \
  --base origin/main \
  --head HEAD \
  --provider ai-sdk \
  --out .review-surfaces
```

The reviewer should then see one default entrypoint:

```text
.review-surfaces/human_review.md
```

That file should answer:

1. Is this review ready?
2. What should I inspect first?
3. What might block merge?
4. What evidence is verified?
5. What evidence is missing?
6. What questions should I ask?
7. What comments should I leave?
8. What can I skim?

The reviewer should not need to start in `review_packet.md`.

## 5.2 Maintainer workflow

The maintainer wants to configure team review policy:

```yaml
human_review:
  decision_policy:
    block_on:
      - failed_tests
      - privacy_block
      - critical_risk
      - high_risk_without_manual_check
      - schema_contract_change_without_compatibility_test
  reviewer_preferences:
    always_prioritize:
      - ci_secret_boundary_change
      - public_schema_change
      - auth_or_permission_change
    downgrade:
      - lockfile_only_large_diff
```

The maintainer expects future packets to adapt to the team’s review rules.

## 5.3 Implementation agent workflow

The implementation agent still gets `agent_handoff.md`, but it is secondary. The agent can consume the same evidence and remediation tasks. The default surface should not be shaped around agent continuation.

## 5.4 CI / PR workflow

CI can post a compact PR comment:

```md
## review-surfaces PR review

Status: Needs reviewer attention.

Review first:
1. `src/llm/pr-narrative.ts:257-306` — trust boundary for anchored narrative validation.
2. `schemas/pr_review_surface.schema.json` — schema contract change; compatibility check missing.
3. `.github/workflows/review-surfaces-pr.yml` — secret-bearing workflow boundary changed.

Blockers:
- Parsed test output missing.
- No manual check recorded for CI secret boundary.

Suggested comments:
- Blocking: request compatibility fixture for schema change.
- Clarifying: ask whether baseline-unavailable state is expected.
```

The full local artifact remains richer than the posted comment.

---

## 6. Target information architecture

### 6.1 Proposed artifact layout

Current layout is broadly useful, but the human and agent outputs should be separated more clearly.

Proposed:

```text
.review-surfaces/
  human/
    human_review.md
    review_queue.md
    suggested_comments.md
    trust_audit.md
    test_plan.md

  evidence/
    evidence_packet.md
    review_packet.json
    intent.yaml
    evaluation.yaml
    risks.yaml
    methodology.yaml
    architecture.md
    diagrams/
    inputs/
    commands/

  pr/
    pr_review_surface.json
    pr_review_comment.md
    pr_change_impact.mmd

  agent/
    agent_handoff.md
    next_tasks.md
    deferrals.md

  feedback/
    *.yaml
```

### 6.2 Backward-compatible layout option

To avoid breaking current scripts, keep current files and add human-first files:

```text
.review-surfaces/
  review_packet.md
  review_packet.json
  human_review.md
  review_queue.md
  suggested_comments.md
  trust_audit.md
  test_plan.md
  agent_handoff.md
  pr_review_surface.json
```

The important product change is the default entrypoint:

```text
Default reviewer entrypoint: .review-surfaces/human_review.md
Default machine entrypoint: .review-surfaces/review_packet.json
Default agent entrypoint: .review-surfaces/agent_handoff.md
```

---

## 7. Core proposed features

# Feature 1: Human Review Cockpit

## 7.1 Problem

The current packet gives the reviewer many useful sections, but the reviewer must still decide how to review. The tool should provide an ordered review plan.

## 7.2 User story

As a human reviewer, I want a compact decision brief so that I can decide where to focus before reading the full diff.

## 7.3 Output

File:

```text
.review-surfaces/human_review.md
```

Example:

```md
# Human Review

## Verdict

**Needs reviewer attention.**

This PR is reviewable, but approval should wait for one missing validation signal and one manual security check.

## Review first

1. `src/llm/pr-narrative.ts:257-306`
   - Why: trust boundary for allowlisted narrative anchors.
   - Action: verify off-allowlist items are dropped and tests cover root-level paths.
   - Evidence: `PR-RISK-002`, `review-surfaces.EVIDENCE.4`

2. `schemas/pr_review_surface.schema.json`
   - Why: public contract changed.
   - Action: confirm backward compatibility or versioning.
   - Evidence: `PR-RISK-004`

3. `.github/workflows/review-surfaces-pr.yml`
   - Why: CI secret-bearing workflow boundary changed.
   - Action: verify permissions and trusted-checkout separation.
   - Evidence: `PR-RISK-001`

## Blockers

- No parsed test-output artifact was supplied.
- CI secret-boundary change has no recorded manual check.

## Author questions

- Was the baseline evaluation intentionally unavailable?
- Is the PR surface schema change additive-only?
- Which manual procedure confirms no secret can be exposed to PR-controlled code?

## Verified evidence

- `pnpm test` command transcript exists and passed.
- Changed files were collected from `origin/main...HEAD`.
- PR risk candidates were generated from deterministic rules.

## Missing evidence

- No coverage report supplied.
- No manual CI-secret-boundary review recorded.
- No compatibility fixture for previous PR surface artifacts.

## Skim-safe

- `pnpm-lock.yaml` appears generated/lockfile-only.
- Docs-only changes do not affect runtime behavior, unless they alter public workflow instructions.
```

## 7.4 Data model

```ts
interface HumanReviewBrief {
  schema_version: "review-surfaces.human_review.v1";
  verdict: ReviewVerdict;
  confidence: "high" | "medium" | "low" | "unknown";
  summary: string;
  review_first: ReviewQueueItem[];
  blockers: ReviewBlocker[];
  author_questions: ReviewerQuestion[];
  verified_evidence: EvidenceSummary[];
  missing_evidence: MissingEvidenceSummary[];
  skim_safe: SkimSafeItem[];
  generated_from: {
    packet_path: string;
    pr_surface_path?: string;
    base_ref: string;
    head_ref: string;
    head_sha: string;
  };
}
```

```ts
type ReviewVerdict =
  | "probably_safe"
  | "reviewable_with_attention"
  | "needs_author_clarification"
  | "block_before_merge"
  | "no_signal";
```

## 7.5 Acceptance criteria

- The first screen must contain a verdict and top review actions.
- The surface must be useful without reading `review_packet.json`.
- Every blocker must cite evidence or missing evidence.
- Every review-first item must cite a path and preferably a hunk or line range.
- The output must remain deterministic under `mock`.
- LLM prose may improve wording, but must not set the verdict.
- If evidence is sparse, the verdict must degrade to `no_signal` or `needs_author_clarification`.

---

# Feature 2: Merge Readiness Decision Model

## 8.1 Problem

Reviewers need an explicit readiness decision, not just risk and coverage sections.

## 8.2 Proposed behavior

Produce a deterministic merge-readiness model from risk candidates, tests, coverage deltas, privacy state, schema changes, and configured policy.

## 8.3 Output example

```yaml
merge_readiness:
  decision: block_before_merge
  confidence: high
  reasons:
    - id: READY-001
      severity: high
      summary: CI secret-boundary files changed without recorded manual check.
      evidence:
        - kind: file
          path: .github/workflows/review-surfaces-pr.yml
      required_action: Record a manual check confirming secrets cannot reach PR-controlled code.

    - id: READY-002
      severity: medium
      summary: Public schema changed without compatibility fixture.
      evidence:
        - kind: file
          path: schemas/pr_review_surface.schema.json
      required_action: Add a fixture proving existing surfaces still validate or bump schema version.

  approval_conditions:
    - Add or record CI secret-boundary manual check.
    - Add schema compatibility test or document breaking version bump.
    - Provide parsed test output or command transcript.
```

## 8.4 Deterministic policy

Default policy:

```yaml
decision_policy:
  block_before_merge:
    - failed_tests
    - privacy_block
    - critical_risk
    - high_security_risk_without_manual_check
    - invalid_evidence_for_core_claim
  needs_author_clarification:
    - baseline_unavailable
    - unknown_intent
    - no_test_evidence
    - schema_change_without_compatibility_signal
  reviewable_with_attention:
    - medium_risk
    - untested_changed_impl
    - large_diff
  probably_safe:
    - docs_only
    - tests_passed
    - no_high_or_critical_risks
    - no_missing_required_evidence
```

## 8.5 Acceptance criteria

- The model must be explainable.
- A reviewer can see exactly why the decision was made.
- The decision must not depend on LLM free text.
- Team policy can override thresholds.
- The decision must degrade conservatively when evidence is missing.

---

# Feature 3: Hunk-Level Review Queue

## 9.1 Problem

Path-level anchors are useful but still force the reviewer to search through the diff. The next step is exact hunk-level review navigation.

## 9.2 Proposed behavior

Generate a ranked queue of review items, each anchored to a changed file and, where possible, exact hunk or line range.

## 9.3 Output example

```md
# Review Queue

## 1. Trust boundary: LLM narrative validation

- File: `src/llm/pr-narrative.ts`
- Lines: `257-306`
- Rank reason: validates whether LLM-authored PR prose can cite only deterministic anchors.
- Reviewer action: confirm invalid anchors are dropped and no fabricated path survives.
- Risk: `PR-RISK-002`
- Requirements: `review-surfaces.EVIDENCE.4`, `review-surfaces.EVIDENCE.7`
- Suggested question: “What tests prove off-allowlist paths are rejected?”

## 2. Public schema contract

- File: `schemas/pr_review_surface.schema.json`
- Lines: `71-98`
- Rank reason: narrative contract changed.
- Reviewer action: confirm compatibility with previous generated surfaces.
- Risk: `PR-RISK-004`
- Suggested question: “Is this contract additive-only?”
```

## 9.4 Data model

```ts
interface ReviewQueueItem {
  id: string; // REVIEW-001
  rank: number;
  title: string;
  path: string;
  old_path?: string;
  hunk_header?: string;
  line_start?: number;
  line_end?: number;
  reviewer_action: string;
  reason: string;
  evidence: EvidenceRef[];
  requirement_ids: string[];
  risk_ids: string[];
  confidence: "high" | "medium" | "low" | "unknown";
  priority: "blocker" | "high" | "medium" | "low";
  estimated_review_effort?: "quick" | "moderate" | "deep";
}
```

## 9.5 Ranking inputs

Use deterministic signals first:

- Coverage regression.
- Failed or skipped test evidence.
- Privacy-sensitive changes.
- CI secret-boundary changes.
- Schema contract changes.
- Public API changes.
- Deleted or renamed surfaces.
- Untested implementation changes.
- Large diff concentration.
- Out-of-scope changed files.
- Requirements with invalid or missing evidence.
- Files with high fan-in or high coupling.
- Files historically associated with reviewer comments, if local feedback exists.

LLM can propose a better title or reason, but not rank or anchor.

## 9.6 Acceptance criteria

- Every queue item must cite a changed file.
- A queue item should cite a diff hunk if the parser can resolve it.
- Items without path evidence must not be in the main queue; they go into “general questions.”
- The queue must be capped and sorted.
- The renderer must show why each item was ranked.

---

# Feature 4: Trust Audit

## 10.1 Problem

A key challenge with agent-generated PRs is distinguishing verified facts from agent claims. The methodology audit already has the right raw material, but it should be promoted to a top-level reviewer surface.

## 10.2 Output example

```md
# Trust Audit

## Verified facts

- `pnpm test` passed in command transcript `CMD-PNPM-TEST`.
- The PR changes 14 files and 620 added/deleted lines.
- `schemas/pr_review_surface.schema.json` changed.
- PR risk rule `schema_contract_change` fired from deterministic path matching.

## Claimed but not verified

- “All edge cases are covered.”
  - Status: unverified.
  - Missing evidence: no coverage artifact and no targeted fixture named.

- “The PR comment cannot leak secrets.”
  - Status: unverified.
  - Missing evidence: no manual CI secret-boundary check.

## Missing evidence

- No parsed JUnit output.
- No coverage summary.
- No manual check transcript.
- No baseline evaluation.

## Invalid evidence

- LLM-proposed path `src/foo.ts` was not in the changed-file allowlist.
```

## 10.3 Data model

```ts
interface TrustAudit {
  schema_version: "review-surfaces.trust_audit.v1";
  verified_facts: TrustFact[];
  claimed_not_verified: TrustClaim[];
  missing_evidence: MissingEvidenceSummary[];
  invalid_evidence: InvalidEvidenceSummary[];
  confidence_summary: string;
}
```

## 10.4 Acceptance criteria

- Claimed tests without command/test-output evidence must be highlighted.
- Author/agent claims must never be rendered as verified facts.
- Missing logs should become a useful finding, not a failure.
- The trust audit must appear near the top of `human_review.md`.

---

# Feature 5: Suggested Reviewer Comments

## 11.1 Problem

Reviewers do not only consume information. They produce comments. The product should help draft high-quality comments grounded in evidence.

## 11.2 Proposed behavior

Generate comments grouped by severity and purpose:

- Blocking.
- Clarifying.
- Non-blocking.
- Praise / acknowledgement, optional and disabled by default.
- Follow-up task suggestions.

Each comment must cite evidence.

## 11.3 Output example

```md
# Suggested Review Comments

## Blocking

### 1. Schema compatibility fixture missing

**File:** `schemas/pr_review_surface.schema.json`

Suggested comment:

> This changes the persisted PR surface contract. Can you add a compatibility fixture showing that an existing `pr_review_surface.json` still validates, or explicitly bump/version the schema if this is breaking?

Evidence:
- Risk: `PR-RISK-004`
- Requirement: `review-surfaces.SCHEMA.1`

## Clarifying

### 2. Baseline unavailable

**File:** `.review-surfaces/pr_review_surface.json`

Suggested comment:

> The surface says the baseline is unavailable, so coverage deltas are current-status only. Is that expected for this PR, or should CI fetch enough history to evaluate `origin/main`?

Evidence:
- Coverage: `base_available=false`

## Non-blocking

### 3. Link blocked-state validation errors

**File:** `src/render/pr-comment.ts`

Suggested comment:

> Consider rendering the validation error summary directly in the blocked PR comment so reviewers do not need to open the JSON surface first.
```

## 11.4 Data model

```ts
interface SuggestedReviewComment {
  id: string;
  severity: "blocking" | "clarifying" | "non_blocking";
  path?: string;
  line_start?: number;
  line_end?: number;
  body: string;
  evidence: EvidenceRef[];
  risk_ids: string[];
  requirement_ids: string[];
  confidence: "high" | "medium" | "low";
  ready_to_post: boolean;
}
```

## 11.5 Guardrails

- No comment without evidence.
- No comment should claim a bug unless evidence supports it.
- Comments should be phrased as review comments, not final judgments.
- Comments should not include secrets or raw sensitive logs.
- Comments should not be auto-posted unless explicitly configured.

## 11.6 Acceptance criteria

- Every suggested comment includes evidence.
- Comments are short enough to post directly.
- Blocking comments must map to blockers or high-risk findings.
- Clarifying comments must map to open questions or missing evidence.
- Non-blocking comments must not be presented as merge blockers.

---

# Feature 6: Intent Mismatch Detection

## 12.1 Problem

A PR can be technically correct but solve the wrong problem, exceed scope, or miss the intended outcome. Current coverage and overreach detection are useful but should be rendered more explicitly for human review.

## 12.2 Output example

```md
# Intent Mismatch

## Expected by spec

- PR-mode comments must avoid whole-spec coverage dumps.
- PR narrative must answer what changed, why it matters, and where to look first.
- LLM output must cite only validated deterministic anchors.

## Observed in diff

- `src/render/pr-comment.ts` renders PR-scoped sections and avoids the repo packet fallback.
- `src/llm/pr-narrative.ts` validates anchors against allowlists.
- `schemas/pr_review_surface.schema.json` defines narrative fields.

## Possible mismatch

- The rendered comment still points to JSON for detailed validation errors, which may slow human reviewers.
- No explicit human-review cockpit surface exists yet; output remains closer to a packet/comment renderer.

## Possible overreach

- SARIF renderer changed, but the PR objective appears focused on PR review surfaces.

## Missing intent

- No reviewer feedback memory is included.
- No hunk-level queue is generated.
```

## 12.3 Acceptance criteria

- The surface must distinguish missing implementation from ambiguous evidence.
- Overreach must cite changed files not mapped to stated intent.
- The renderer must not fabricate intent absent from specs/docs/tickets.
- Ambiguous intent should become reviewer questions.

---

# Feature 7: Concrete Test Plan Synthesis

## 13.1 Problem

“Missing test” is useful, but still vague. A reviewer or agent needs a concrete test recipe.

## 13.2 Proposed behavior

Render missing tests as ready-to-implement test plans.

## 13.3 Output example

```md
# Test Plan

## Required before approval

### 1. Blocked PR narrative does not fall back to repo packet

- Suggested file: `tests/pr-comment.test.ts`
- Scenario: `pr_review_surface.json` has `status=blocked` and `blocked_reason=invalid_llm_output`.
- Expected: rendered PR comment explains the block and does not render whole-repo packet content.
- Evidence gap: blocked PR surfaces can confuse reviewers if they silently fall back.
- Command: `pnpm run test -- tests/pr-comment.test.ts`

### 2. Off-allowlist root path is rejected

- Suggested file: `tests/pr-narrative.test.ts`
- Scenario: LLM text mentions `package.json` when it is not in `allowed_paths`.
- Expected: narrative item is dropped.
- Evidence gap: root-level file tokens have separate validation logic.
- Command: `pnpm run test -- tests/pr-narrative.test.ts`

## Manual checks

### 1. CI secret boundary

- Check: Confirm secret-bearing steps run only from trusted workflow code.
- Evidence to record: reviewer initials, date, workflow file inspected, conclusion.
- Suggested command: none; manual source review required.
```

## 13.4 Data model

```ts
interface TestPlanItem {
  id: string;
  kind: "automatic" | "manual";
  priority: "required" | "recommended" | "optional";
  suggested_file?: string;
  scenario: string;
  expected_result: string;
  command?: string;
  maps_to_requirements: string[];
  maps_to_risks: string[];
  evidence_gap: string;
}
```

## 13.5 Acceptance criteria

- Missing automatic tests must include a suggested test location, scenario, and expected result when possible.
- Missing manual checks must include a concrete manual procedure.
- Required tests/checks must align with merge-readiness blockers.
- The test plan must avoid inventing test framework APIs unless inferred from existing tests.

---

# Feature 8: Domain Risk Lenses

## 14.1 Problem

Current PR risks are useful but mostly generic and path/rule-based. To stand out, the product should apply domain-specific review lenses.

## 14.2 Proposed risk lenses

### 14.2.1 API / schema contract lens

Detects:

- JSON schema changes.
- Public TypeScript type changes.
- CLI option changes.
- Config contract changes.
- Output artifact shape changes.
- Backward compatibility risks.

Outputs:

- Compatibility requirement.
- Suggested fixture.
- Versioning decision.
- Consumer impact.

### 14.2.2 Security / privacy lens

Detects:

- Secret handling.
- Token handling.
- Redaction logic.
- Remote provider calls.
- CI secret boundary.
- PR-controlled code execution.
- Sensitive logs.

Outputs:

- Manual checks.
- Required tests.
- High-risk review queue items.

### 14.2.3 LLM trust-boundary lens

Detects:

- Prompt construction changes.
- Allowlist validation changes.
- Evidence validation changes.
- LLM status/classification changes.
- Narrative output changes.

Outputs:

- “Could the LLM fabricate this?” checks.
- Prompt and output hash validation checks.
- Anchor validation tests.

### 14.2.4 Test evidence lens

Detects:

- Test harness changes.
- JUnit parser changes.
- Coverage parser changes.
- Command transcript changes.
- Claimed tests without direct evidence.

Outputs:

- Missing test-output artifacts.
- Suspicious skipped tests.
- Suggested command transcripts.

### 14.2.5 Reviewer UX lens

Detects:

- Comment renderer changes.
- Markdown rendering changes.
- Mermaid diagram changes.
- Output truncation changes.
- Evidence appendix changes.
- Blocked-state messaging changes.

Outputs:

- Review comment rendering fixture requirements.
- Golden output checks.
- Manual readability review.

### 14.2.6 Cache / provenance lens

Detects:

- Cache signature changes.
- Artifact-stamping changes.
- Previous-packet comparison changes.
- Input hashing changes.

Outputs:

- Stale artifact risks.
- Reproducibility tests.
- Cache invalidation fixtures.

## 14.3 Data model

```ts
interface RiskLensFinding {
  id: string;
  lens:
    | "api_contract"
    | "security_privacy"
    | "llm_trust_boundary"
    | "test_evidence"
    | "reviewer_ux"
    | "cache_provenance"
    | "custom";
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  summary: string;
  reviewer_action: string;
  evidence: EvidenceRef[];
  suggested_tests: TestPlanItem[];
  suggested_comments: SuggestedReviewComment[];
}
```

## 14.4 Acceptance criteria

- Risk lenses must be deterministic by default.
- Lenses must be configurable.
- A lens must cite why it fired.
- A lens should produce reviewer actions, not just risk summaries.

---

# Feature 9: Skim-Safe and Noise Reduction

## 15.1 Problem

A good review assistant should not only say where to focus. It should also say where not to spend time.

## 15.2 Proposed behavior

Render a “skim-safe” section when evidence supports it.

## 15.3 Output example

```md
## Skim-safe

These files appear low-risk for this review:

- `pnpm-lock.yaml`
  - Reason: lockfile-only generated dependency update.
  - Caveat: inspect if dependency versions changed for runtime packages.

- `docs/review-surfaces-trd.md`
  - Reason: docs-only change.
  - Caveat: inspect if docs define product contract or user workflow.

- `.review-surfaces/diagrams/source-layout.mmd`
  - Reason: generated artifact.
  - Caveat: inspect only if generated artifacts are committed intentionally.
```

## 15.4 Data model

```ts
interface SkimSafeItem {
  path: string;
  reason: string;
  caveat?: string;
  evidence: EvidenceRef[];
  confidence: "high" | "medium" | "low";
}
```

## 15.5 Acceptance criteria

- The tool must not mark a file skim-safe if it is linked to a high-risk finding.
- Generated and lockfile paths can be skim-safe only if no runtime dependency risk is detected.
- Docs can be skim-safe only if they do not alter explicit product contracts, policies, or reviewer workflows.

---

# Feature 10: Reviewer Feedback Memory

## 16.1 Problem

Reviewers will quickly lose trust if the tool repeatedly surfaces noisy findings or misses team-specific risks. The dogfood feedback mechanism exists, but it should become a persistent review memory.

## 16.2 Proposed behavior

Allow local feedback files to teach the tool:

- False positives.
- False negatives.
- Team policies.
- Reviewer preferences.
- Always-review surfaces.
- Usually-skim surfaces.
- Required manual checks.

## 16.3 Feedback file example

```yaml
schema_version: review-surfaces.feedback.v1
reviewer: local
created_at: 2026-06-08

false_positives:
  - rule: large_diff
    path_pattern: pnpm-lock.yaml
    condition: lockfile_only
    action: downgrade_to_low

false_negatives:
  - description: Schema changes should always ask for compatibility tests.
    path_pattern: schemas/**/*.json
    desired_rule: schema_contract_change

team_policy:
  - id: POLICY-CI-SECRET-001
    trigger:
      path_pattern: .github/workflows/*.yml
    required_manual_check: Confirm PR-controlled code cannot access secrets.

reviewer_preferences:
  - prefer_hunk_links: true
  - max_top_review_items: 7
  - always_show_suggested_comments: true
```

## 16.4 Acceptance criteria

- Feedback must be local-first.
- Feedback must not silently override evidence.
- Feedback effects must be visible in the packet.
- The tool should explain when feedback downgraded or upgraded a finding.
- Feedback should be portable across repositories where possible.

---

# Feature 11: Before/After Packet Comparison for Reviewers

## 17.1 Problem

When a PR updates in response to review, the reviewer needs to know what changed since the last review, not just the current state.

## 17.2 Proposed behavior

Use previous packet comparison to produce a reviewer-focused delta.

## 17.3 Output example

```md
# Since Last Review

## Improved

- `review-surfaces.PROVIDERS.6`: missing -> partial
  - New evidence: added CI secret-boundary fixture.
- `PR-RISK-003`: resolved
  - Reason: test added for blocked PR comment rendering.

## Regressed

- `review-surfaces.SCHEMA.1`: satisfied -> partial
  - Reason: schema changed without updated fixture.

## New risks

- `PR-RISK-005`: root-level path validation changed.

## Still open

- No coverage artifact supplied.
- Manual check for CI secret boundary still missing.
```

## 17.4 Acceptance criteria

- The comparison must be reviewer-focused, not just raw count deltas.
- Resolved findings should be visible.
- Newly introduced risks should be visible.
- Persistently open risks should be visible.

---

# Feature 12: Reviewer Questions

## 18.1 Problem

A reviewer often needs to ask clarifying questions before approval. The tool can generate these directly from ambiguity, missing evidence, or conflicting sources.

## 18.2 Output example

```md
# Questions for Author

## Blocking

1. The PR changes the CI secret boundary. What manual check confirms secrets remain isolated from PR-controlled code?

2. The PR changes the persisted PR surface schema. Is this additive-only? If yes, where is the compatibility fixture?

## Clarifying

3. The baseline evaluation is unavailable. Is this expected for CI, or should the workflow fetch the base ref?

4. The PR adds LLM narrative validation changes. Which fixture proves fabricated root-level paths are rejected?

## Optional

5. Should generated diagrams be posted in PR comments by default, or only linked?
```

## 18.3 Data model

```ts
interface ReviewerQuestion {
  id: string;
  severity: "blocking" | "clarifying" | "optional";
  question: string;
  reason: string;
  evidence: EvidenceRef[];
  maps_to_risks: string[];
  maps_to_requirements: string[];
}
```

## 18.4 Acceptance criteria

- Every blocking question must map to a blocker or high-risk missing evidence.
- Questions must be specific and answerable.
- Questions must not duplicate suggested comments unless the renderer intentionally combines them.

---

# Feature 13: Review Personas and Routes

## 19.1 Problem

Different reviewers care about different surfaces. A maintainer, security reviewer, and product reviewer need different paths.

## 19.2 Proposed behavior

Generate optional review routes:

```md
# Review Routes

## Maintainer route

1. Merge readiness verdict.
2. Schema and CLI contract changes.
3. Test plan.
4. Suggested blocking comments.

## Security route

1. CI secret-boundary changes.
2. Provider and redaction changes.
3. Privacy block status.
4. Manual check evidence.

## Product route

1. Intent mismatch.
2. Human review surface output.
3. Suggested comments.
4. Reviewer UX lens.

## Agent-continuation route

1. Open risks.
2. Missing tests.
3. Next tasks.
4. Deferrals.
```

## 19.3 Acceptance criteria

- Routes must be generated from the same evidence.
- Routes must not contradict each other.
- The default route is the human reviewer route.
- Agent route is secondary.

---

# Feature 14: Inline Evidence Cards

## 20.1 Problem

Evidence is often buried in appendices or JSON. Human reviewers need compact evidence cards.

## 20.2 Output example

```md
## Evidence Card: CI secret boundary

Status: Missing manual check.

Evidence:
- `.github/workflows/review-surfaces-pr.yml` changed.
- PR risk rule `ci_secret_boundary_change` fired.
- No command transcript or feedback file records a manual security review.

Why it matters:
- Secret-bearing CI steps can expose credentials if PR-controlled workflow or code is trusted incorrectly.

Reviewer action:
- Inspect workflow permissions and checkout boundaries.
- Ask author to record the manual check.
```

## 20.3 Acceptance criteria

- Cards must be short.
- Cards must cite evidence.
- Cards must have an action.
- Cards must distinguish direct evidence from missing evidence.

---

# Feature 15: Human Review JSON Contract

## 21.1 Problem

Markdown is useful for humans, but CI, dashboards, and future integrations need a stable machine contract.

## 21.2 Proposed schema

File:

```text
.review-surfaces/human_review.json
```

Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://review-surfaces.local/schemas/human_review.schema.v1.json",
  "title": "review-surfaces human review cockpit",
  "type": "object",
  "required": [
    "schema_version",
    "mode",
    "verdict",
    "summary",
    "review_queue",
    "blockers",
    "questions",
    "trust_audit",
    "test_plan"
  ],
  "properties": {
    "schema_version": {
      "const": "review-surfaces.human_review.v1"
    },
    "mode": {
      "enum": ["pr", "repo"]
    },
    "verdict": {
      "type": "object",
      "required": ["decision", "confidence", "reasons"],
      "properties": {
        "decision": {
          "enum": [
            "probably_safe",
            "reviewable_with_attention",
            "needs_author_clarification",
            "block_before_merge",
            "no_signal"
          ]
        },
        "confidence": {
          "enum": ["high", "medium", "low", "unknown"]
        },
        "reasons": {
          "type": "array"
        }
      }
    },
    "summary": {
      "type": "string",
      "maxLength": 2000
    },
    "review_queue": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/reviewQueueItem"
      }
    },
    "blockers": {
      "type": "array"
    },
    "questions": {
      "type": "array"
    },
    "suggested_comments": {
      "type": "array"
    },
    "trust_audit": {
      "type": "object"
    },
    "test_plan": {
      "type": "array"
    },
    "skim_safe": {
      "type": "array"
    }
  },
  "$defs": {
    "reviewQueueItem": {
      "type": "object",
      "required": ["id", "rank", "title", "path", "reason", "reviewer_action", "confidence"],
      "properties": {
        "id": { "type": "string" },
        "rank": { "type": "integer", "minimum": 1 },
        "title": { "type": "string" },
        "path": { "type": "string" },
        "line_start": { "type": "integer", "minimum": 1 },
        "line_end": { "type": "integer", "minimum": 1 },
        "hunk_header": { "type": "string" },
        "reason": { "type": "string" },
        "reviewer_action": { "type": "string" },
        "risk_ids": {
          "type": "array",
          "items": { "type": "string" }
        },
        "requirement_ids": {
          "type": "array",
          "items": { "type": "string" }
        },
        "confidence": {
          "enum": ["high", "medium", "low", "unknown"]
        }
      }
    }
  }
}
```

## 21.3 Acceptance criteria

- The schema must validate generated human review JSON.
- Markdown must render from the JSON, not recompute.
- PR comments should render from this human review model when available.
- The existing `pr_review_surface.json` can remain the lower-level PR fact model.

---

## 22. Proposed CLI changes

## 22.1 New commands

```bash
review-surfaces human
```

Build only the human review surface from existing packet/surface artifacts when available.

```bash
review-surfaces queue
```

Build or render the hunk-level review queue.

```bash
review-surfaces comments
```

Render suggested reviewer comments.

```bash
review-surfaces trust
```

Render the trust audit.

```bash
review-surfaces test-plan
```

Render concrete test plan.

## 22.2 Existing command changes

```bash
review-surfaces all --review-scope pr
```

Should write:

```text
.review-surfaces/human_review.md
.review-surfaces/human_review.json
.review-surfaces/review_queue.md
.review-surfaces/suggested_comments.md
.review-surfaces/trust_audit.md
.review-surfaces/test_plan.md
.review-surfaces/pr_review_surface.json
.review-surfaces/review_packet.json
.review-surfaces/agent_handoff.md
```

## 22.3 Default stdout summary

After `all`, print:

```text
Wrote review-surfaces artifacts to .review-surfaces

Human review: .review-surfaces/human_review.md
Verdict: needs_author_clarification
Review first: 5 item(s)
Blockers: 1
Suggested comments: 4
Missing evidence: 3
```

## 22.4 Acceptance criteria

- `all` still works as before.
- Existing packet artifacts remain.
- Human review output is generated by default unless disabled.
- Agent handoff remains opt-in or secondary in the terminal summary.

---

## 23. Feature spec additions

Add a new component to `features/review-surfaces.feature.yaml`.

```yaml
  HUMAN_REVIEW:
    name: Human reviewer cockpit
    description: Convert packet evidence into an ordered review decision surface for human reviewers.
    requirements:
      1:
        requirement: The default human surface must start with a merge-readiness verdict, top blockers, and an ordered review queue.
        note: The verdict must be deterministic and derived from evidence, risks, coverage, tests, privacy state, and configured policy, not from untrusted LLM prose.
      2:
        requirement: Review queue items must cite changed files and, when available, diff hunks or line ranges.
        note: Queue items without path or hunk evidence must be rendered as general questions, not as main review-first items.
      3:
        requirement: The human surface must separate verified facts, author or agent claims, missing evidence, and invalid evidence.
        note: Claimed tests without command transcript or parsed test-output evidence must be visible near the top of the surface.
      4:
        requirement: The human surface must generate reviewer questions for ambiguous intent, missing evidence, coverage regressions, and risky changes.
        note: Questions must be grouped by blocking, clarifying, and optional severity.
      5:
        requirement: Suggested reviewer comments must be grouped by blocking, clarifying, and non-blocking severity, and every suggested comment must cite evidence.
        note: Suggested comments are local drafts by default and must not be auto-posted without explicit user configuration.
      6:
        requirement: The human surface must include concrete test-plan items for missing automatic tests and concrete manual-check procedures for missing manual checks.
      7:
        requirement: The human surface must identify skim-safe files or areas only when no high-risk finding maps to them.
      8:
        requirement: Agent handoff must be rendered as a secondary surface and must not be the default reviewer entrypoint.
      9:
        requirement: The human review model must be emitted as schema-validated JSON and rendered to Markdown from that JSON.
      10:
        requirement: Reviewer feedback files must be able to tune false positives, team policies, required manual checks, and preferred review focus without overriding evidence silently.
```

Add constraints:

```yaml
constraints:
  HUMAN_TRUST:
    name: Human reviewer trust
    description: Human surfaces must be action-oriented, bounded, evidence-backed, and conservative when evidence is missing.
    requirements:
      1:
        requirement: Merge-readiness decisions must degrade conservatively when required evidence is missing.
      2:
        requirement: LLM output may improve prose but must not create blockers, clear blockers, set coverage status, or set merge-readiness verdicts.
      3:
        requirement: Every human-review action must cite evidence or be explicitly marked as a question, assumption, or missing-evidence item.
      4:
        requirement: Human-review Markdown must fit on one readable screen for the top summary and link to deeper artifacts for details.
      5:
        requirement: Human surfaces must avoid generic AI review boilerplate.
```

---

## 24. Implementation architecture

## 24.1 New pipeline stage

Add a stage after PR surface assembly and full packet generation:

```text
collect
  -> intent
  -> evaluate
  -> methodology
  -> risks
  -> architecture
  -> pr_surface
  -> human_review
  -> render
```

## 24.2 Inputs

The human review stage consumes:

- `review_packet.json`
- `pr_review_surface.json`, when in PR mode
- `evaluation.yaml`
- `risks.yaml`
- `methodology.yaml`
- `inputs/diff.patch`
- `inputs/changed_files.json`
- `inputs/commands.json`
- parsed test output
- coverage summary
- feedback files
- config policy

## 24.3 Outputs

- `human_review.json`
- `human_review.md`
- `review_queue.md`
- `suggested_comments.md`
- `trust_audit.md`
- `test_plan.md`

## 24.4 Module proposal

```text
src/human/
  contract.ts
  decision.ts
  queue.ts
  trust-audit.ts
  comments.ts
  test-plan.ts
  skim-safe.ts
  feedback-policy.ts
  render.ts
  human-review.ts

schemas/
  human_review.schema.json

tests/
  human-review.test.ts
  review-queue.test.ts
  trust-audit.test.ts
  suggested-comments.test.ts
  human-decision.test.ts
  feedback-policy.test.ts
```

## 24.5 Deterministic / LLM split

Deterministic:

- Verdict.
- Blockers.
- Queue ranking.
- Evidence classification.
- Missing evidence.
- Risk lens firing.
- Test-plan structure.
- Skim-safe classification.
- Feedback policy application.

LLM-assisted:

- Comment wording.
- Reviewer question wording.
- Summary prose.
- Queue item titles.
- Condensing evidence cards.
- Explaining why a risk matters.

Validation:

- LLM text must cite only allowlisted paths, requirements, risks, queue IDs, or evidence IDs.
- LLM suggestions must be dropped if anchors are invalid.
- LLM must not create new IDs or statuses.

---

## 25. Review queue ranking algorithm

## 25.1 Inputs

```ts
interface ReviewQueueRankingInput {
  prSurface?: PrReviewSurfaceModel;
  packet: ReviewPacket;
  diff: StructuredDiff;
  risks: RiskItem[];
  prRisks: PrRiskCandidate[];
  coverageDeltas: PrRequirementCoverageDelta[];
  trustAudit: TrustAudit;
  config: HumanReviewConfig;
  feedback: ReviewerFeedback[];
}
```

## 25.2 Scoring

Example deterministic scoring:

```ts
score =
  severityWeight(risk.severity)
  + evidenceWeight(evidence.kind)
  + changedSurfaceWeight(file.role)
  + coverageDeltaWeight(delta)
  + lensWeight(lens)
  + feedbackPolicyWeight(policy)
  + hunkConfidenceWeight(hunk)
  - skimSafePenalty(file)
```

Example weights:

```yaml
weights:
  critical_risk: 100
  high_risk: 75
  medium_risk: 40
  low_risk: 15
  coverage_regression: 85
  failed_tests: 90
  privacy_block: 100
  ci_secret_boundary_change: 90
  schema_contract_change: 65
  llm_trust_boundary_change: 70
  untested_changed_impl: 45
  unmapped_change: 25
  large_diff: 20
  exact_hunk_anchor_bonus: 10
  missing_evidence_bonus: 20
```

## 25.3 Ranking output

- Sort descending by score.
- Break ties by severity, path, requirement ID.
- Cap top queue to 5 or 7 in `human_review.md`.
- Full queue in `review_queue.md`.

## 25.4 Acceptance criteria

- Ranking is deterministic.
- Ranking is explainable.
- Each item carries a rank reason.
- Config and feedback can tune ranking.

---

## 26. Merge-readiness decision algorithm

## 26.1 Inputs

- PR risks.
- Whole-packet risks.
- Test evidence.
- Coverage deltas.
- Privacy state.
- Evidence validation.
- Trust audit.
- Team policy.
- Reviewer feedback.

## 26.2 Example decision rules

```ts
if (privacy.remote_provider_blocked) {
  decision = "block_before_merge";
}

if (hasFailedTests) {
  decision = "block_before_merge";
}

if (hasCriticalRisk) {
  decision = "block_before_merge";
}

if (hasHighSecurityRisk && !hasManualCheck) {
  decision = "block_before_merge";
}

if (hasInvalidEvidenceForCoreClaim) {
  decision = "needs_author_clarification";
}

if (baselineUnavailable && coverageDeltaNeeded) {
  decision = "needs_author_clarification";
}

if (hasUntestedImplementationChange) {
  decision = max(decision, "reviewable_with_attention");
}

if (docsOnly && testsNotNeeded && noHighRisk) {
  decision = "probably_safe";
}
```

## 26.3 Decision precedence

```text
block_before_merge
  > needs_author_clarification
  > reviewable_with_attention
  > probably_safe
  > no_signal
```

## 26.4 Acceptance criteria

- Block decisions must have clear required actions.
- “Probably safe” must require positive evidence, not merely absence of findings.
- Missing inputs should not produce false confidence.
- Decision policy must be testable with fixtures.

---

## 27. Renderer design

## 27.1 `human_review.md` top-level format

```md
# Human Review

## Verdict

## Review first

## Blockers

## Questions for author

## Trust audit

## Test plan

## Suggested comments

## Skim-safe

## Evidence pointers
```

## 27.2 PR comment format

The PR comment should be shorter than `human_review.md`:

```md
## review-surfaces PR review

**Verdict:** Needs author clarification.

### Review first

1. `src/llm/pr-narrative.ts:257-306` — LLM anchor validation trust boundary.
2. `schemas/pr_review_surface.schema.json` — schema contract change.
3. `.github/workflows/review-surfaces-pr.yml` — CI secret boundary.

### Blockers

- Manual CI secret-boundary check missing.

### Questions

- Is the schema change additive-only?
- Should CI fetch the base ref to compute coverage deltas?

Full human review: `.review-surfaces/human_review.md`.
```

## 27.3 Rendering rules

- Top summary must be compact.
- Long detail lists go to linked artifacts.
- Markdown must be stable and bounded.
- All free text must be redacted before truncation.
- Mermaid blocks must be validated before embedding.
- Suggested comments must be in `<details>` if long.

---

## 28. Configuration

## 28.1 Proposed config

```yaml
human_review:
  enabled: true
  default_entrypoint: true
  max_review_first: 7
  max_suggested_comments: 10
  max_questions: 10

  verdict_policy:
    block_on:
      - privacy_block
      - failed_tests
      - critical_risk
      - high_security_risk_without_manual_check
      - invalid_evidence_for_core_claim
    clarify_on:
      - baseline_unavailable
      - no_test_evidence
      - unknown_intent
      - schema_change_without_compatibility_test
    attention_on:
      - untested_changed_impl
      - large_diff
      - unmapped_change

  required_manual_checks:
    - id: ci_secret_boundary
      path_patterns:
        - ".github/workflows/**"
        - "src/llm/provider*"
        - "src/render/post-comment*"
      prompt: "Confirm PR-controlled code cannot access secrets."

  skim_safe:
    generated_paths:
      - "dist/**"
      - "pnpm-lock.yaml"
    docs_paths:
      - "docs/**"
      - "*.md"

  risk_lenses:
    api_contract: true
    security_privacy: true
    llm_trust_boundary: true
    test_evidence: true
    reviewer_ux: true
    cache_provenance: true
```

## 28.2 Acceptance criteria

- Defaults must work without config.
- Config must not make unsafe claims.
- Team policy effects must be visible in output.
- Unknown config keys should be warned or ignored consistently.

---

## 29. Suggested implementation roadmap

## M1: Human review brief skeleton

Goal: Create `human_review.md` and `human_review.json` from existing packet and PR surface.

Deliver:

- `src/human/contract.ts`
- `src/human/human-review.ts`
- `src/human/render.ts`
- schema file
- basic verdict from existing risk/test signals
- top review-first list from PR risks
- tests for stable rendering

Acceptance:

- `review-surfaces all` writes `human_review.md`.
- Default terminal output points to `human_review.md`.

## M2: Merge-readiness decision model

Goal: Add deterministic verdict and blockers.

Deliver:

- `src/human/decision.ts`
- policy config
- blocker model
- required actions
- tests for policy precedence

Acceptance:

- Failed tests block.
- Privacy block blocks.
- High security risk without manual check blocks.
- Missing evidence produces clarification, not false approval.

## M3: Hunk-level review queue

Goal: Generate a ranked queue with file and hunk anchors.

Deliver:

- diff hunk indexing
- risk-to-hunk mapping
- queue ranking
- `review_queue.md`
- tests for queue ordering and anchors

Acceptance:

- Queue items cite changed files.
- High-risk items rank above low-risk items.
- Hunk anchors appear where resolvable.

## M4: Trust audit and concrete test plan

Goal: Promote verified/claimed/missing evidence and make test gaps actionable.

Deliver:

- `trust_audit.md`
- `test_plan.md`
- claimed-vs-verified rendering
- suggested test file/scenario/expected result
- manual check procedures

Acceptance:

- Claimed tests without command evidence are visible.
- Missing automatic tests include scenarios.
- Missing manual checks include procedures.

## M5: Suggested reviewer comments

Goal: Generate evidence-backed draft comments.

Deliver:

- deterministic comment candidates
- optional LLM wording
- anchor validation
- `suggested_comments.md`
- PR comment compact rendering

Acceptance:

- Every comment cites evidence.
- Blocking comments map to blockers.
- Comments are not auto-posted by default.

## M6: Feedback memory and domain lenses

Goal: Make reviewer feedback and team policy tune the surface.

Deliver:

- feedback parser
- false-positive/false-negative policy
- risk lenses
- policy effect annotations
- tests for feedback application

Acceptance:

- Feedback can downgrade noisy lockfile-only large-diff findings.
- Schema changes can be configured to require compatibility tests.
- Policy changes are visible in output.

---

## 30. Test strategy

## 30.1 Fixture categories

Add fixtures for:

- docs-only PR
- lockfile-only PR
- schema contract change
- CI secret-boundary change
- LLM prompt/anchor validation change
- renderer change
- failed tests
- skipped tests
- no test evidence
- baseline unavailable
- coverage regression
- untested implementation change
- unmapped change
- large diff
- feedback false positive
- feedback required manual check
- prior packet comparison

## 30.2 Golden tests

Golden tests should assert:

- headings
- verdict
- number of review-first items
- blocker IDs
- evidence anchors
- absence of generic boilerplate
- redaction behavior
- deterministic ordering

Avoid brittle full-prose snapshots unless using `mock`.

## 30.3 Example tests

```ts
test("human review blocks on CI secret-boundary change without manual check", async () => {
  const result = await runFixture("ci-secret-boundary-no-manual-check");
  assert.equal(result.human.verdict.decision, "block_before_merge");
  assert.match(result.markdown, /CI secret-boundary/);
  assert.match(result.markdown, /manual check/);
});
```

```ts
test("review queue ranks schema contract change above large diff", async () => {
  const result = await runFixture("schema-change-large-diff");
  const queue = result.human.review_queue;
  assert.equal(queue[0].risk_ids.includes("PR-RISK-SCHEMA"), true);
});
```

```ts
test("suggested comments all cite evidence", async () => {
  const result = await runFixture("suggested-comments");
  for (const comment of result.human.suggested_comments) {
    assert.ok(comment.evidence.length > 0);
  }
});
```

---

## 31. Success metrics

## 31.1 Reviewer value metrics

Measure through dogfood feedback:

- Did the surface reduce time to first meaningful review comment?
- Did the reviewer inspect the top-ranked queue first?
- Were suggested questions useful?
- Were any blockers false positives?
- Were any important risks missing?
- Did the reviewer need to open `review_packet.json`?
- Was the top summary enough to decide review strategy?

## 31.2 Output quality metrics

- Percent of queue items with hunk anchors.
- Percent of suggested comments with valid evidence.
- Number of invalid evidence references.
- Number of missing evidence items.
- False positive rate per risk rule.
- Review-first item click/usefulness rating.
- Human reviewer helpfulness score from feedback.

## 31.3 Product milestone target

The product is meaningfully improved when a reviewer can say:

> “I used the human review surface as my review plan and it correctly pointed me to the parts I would have found manually.”

---

## 32. Non-goals

The human review cockpit should not:

- Auto-approve PRs.
- Replace human judgment.
- Auto-post comments by default.
- Treat LLM text as evidence.
- Invent tests, paths, requirements, or statuses.
- Hide missing evidence.
- Hide the underlying packet.
- Make remote provider calls mandatory.
- Require hosted Acai or GitHub integration for local value.
- Turn into a long generic AI essay.

---

## 33. Risks of this direction

## 33.1 Risk: overconfident verdicts

Mitigation:

- Conservative default decisions.
- Clear confidence.
- Missing evidence lowers confidence.
- LLM cannot set verdict.

## 33.2 Risk: noisy review queue

Mitigation:

- Feedback memory.
- Configurable ranking.
- Skim-safe section.
- “Why ranked” explanation.
- Cap top queue.

## 33.3 Risk: too many generated comments

Mitigation:

- Group by severity.
- Cap output.
- Require evidence.
- Mark as drafts.
- Do not auto-post by default.

## 33.4 Risk: hunk anchors are wrong

Mitigation:

- Validate hunk ranges against parsed diff.
- Drop invalid anchors.
- Fall back to file-level anchors.
- Mark confidence.

## 33.5 Risk: human surface duplicates existing packet

Mitigation:

- Human surface should be decision/action-first.
- Evidence packet remains appendix.
- Human surface should avoid full coverage dumps.
- Top summary should fit on one screen.

---

## 34. Example full `human_review.md`

```md
# Human Review

Generated from `.review-surfaces/review_packet.json` and `.review-surfaces/pr_review_surface.json`.

## Verdict

**Needs author clarification.**

The PR is reviewable, but approval should wait for a schema compatibility answer and one missing manual security check.

Confidence: medium.

Reasons:
- Public PR surface schema changed.
- CI / secret-boundary related files changed.
- No manual check evidence recorded.
- Tests are present but no coverage artifact was supplied.

## Review first

1. `schemas/pr_review_surface.schema.json`
   - Action: confirm compatibility or version bump.
   - Why ranked: schema contract change.
   - Risk: `PR-RISK-004`.

2. `src/llm/pr-narrative.ts:257-306`
   - Action: inspect anchor allowlist validation.
   - Why ranked: LLM trust-boundary change.
   - Risk: `PR-RISK-002`.

3. `.github/workflows/review-surfaces-pr.yml`
   - Action: inspect secret-bearing workflow boundary.
   - Why ranked: CI secret-boundary change.
   - Risk: `PR-RISK-001`.

4. `src/render/pr-comment.ts`
   - Action: verify blocked PR surface renders clear instructions and does not fall back to repo packet.
   - Why ranked: human review surface changed.
   - Risk: `PR-RISK-003`.

## Blockers

- Missing manual CI secret-boundary check.
  - Required action: confirm PR-controlled code cannot access secrets.
  - Evidence: `.github/workflows/review-surfaces-pr.yml`.

## Questions for author

1. Is the PR surface schema change additive-only?
2. Should CI fetch base history so coverage deltas can compare against `origin/main`?
3. Which test proves off-allowlist root-level paths are rejected?
4. Was the blocked PR-surface behavior tested against real GitHub Markdown rendering?

## Trust audit

Verified:
- Changed files were collected from the base/head diff.
- PR risk candidates were generated deterministically.
- LLM narrative anchors were allowlist validated before rendering.

Claimed but not verified:
- Full coverage was not verified because no coverage artifact was supplied.
- Manual CI secret-boundary review was not recorded.

Missing:
- Coverage report.
- Manual CI secret-boundary check.
- Compatibility fixture for prior PR surface JSON.

## Test plan

Required:
- Add schema compatibility fixture for `pr_review_surface.schema.json`.
- Add blocked PR comment rendering test.
- Add off-allowlist root path validation test.

Manual:
- Inspect workflow permissions and checkout boundaries.

## Suggested comments

Blocking:
> This changes the PR surface schema. Can you add a compatibility fixture for an existing `pr_review_surface.json`, or explicitly version this as a breaking contract change?

Clarifying:
> The surface reports baseline unavailable, so coverage deltas are current-status only. Is that expected in CI?

Non-blocking:
> Consider rendering blocked-surface validation errors directly in the PR comment to avoid requiring reviewers to open the JSON artifact.

## Skim-safe

- `pnpm-lock.yaml`: lockfile-only generated change. Inspect only if runtime dependency versions changed.
- Generated diagrams: inspect only if generated artifacts are intentionally committed.

## Evidence pointers

- Full packet: `.review-surfaces/review_packet.json`
- PR surface: `.review-surfaces/pr_review_surface.json`
- Risk register: `.review-surfaces/risks.yaml`
- Evaluation: `.review-surfaces/evaluation.yaml`
```

---

## 35. Example `review_queue.md`

```md
# Review Queue

## REVIEW-001 — Schema contract change

Priority: high
Confidence: high
File: `schemas/pr_review_surface.schema.json`
Lines: `71-98`

Why this matters:
The PR surface schema is a persisted contract. Changes can break existing artifacts, CI renderers, or downstream integrations.

Reviewer action:
Confirm the change is additive-only or accompanied by a schema version bump and compatibility fixture.

Evidence:
- `PR-RISK-004`
- `review-surfaces.SCHEMA.1`

Suggested comment:
> This changes the PR surface schema. Can you add a compatibility fixture for an existing generated surface?

---

## REVIEW-002 — LLM anchor validation trust boundary

Priority: high
Confidence: high
File: `src/llm/pr-narrative.ts`
Lines: `257-306`

Why this matters:
This code determines whether LLM-authored review prose can cite only deterministic anchors. A bug here could let fabricated paths or requirements into reviewer-facing comments.

Reviewer action:
Inspect anchor validation and tests for fabricated paths, root-level filenames, ACIDs, and risk IDs.

Evidence:
- `PR-RISK-002`
- `review-surfaces.EVIDENCE.4`
- `review-surfaces.EVIDENCE.7`

Suggested comment:
> Which tests prove that off-allowlist root-level files and ACIDs are rejected?
```

---

## 36. Example `suggested_comments.md`

```md
# Suggested Reviewer Comments

## Blocking

### SC-001 — Missing schema compatibility fixture

Path: `schemas/pr_review_surface.schema.json`

> This changes the persisted PR surface schema. Can you add a compatibility fixture showing an existing `pr_review_surface.json` still validates, or explicitly bump the schema version if this is a breaking change?

Evidence:
- `PR-RISK-004`
- `review-surfaces.SCHEMA.1`

Ready to post: yes.

## Clarifying

### SC-002 — Baseline unavailable

> The PR surface reports that the baseline is unavailable, so coverage deltas are current-status only. Is that expected for this workflow, or should CI fetch the base ref?

Evidence:
- `coverage.base_available=false`

Ready to post: yes.

## Non-blocking

### SC-003 — Improve blocked-state usability

Path: `src/render/pr-comment.ts`

> Consider rendering the main validation error directly in the blocked PR comment so reviewers do not need to open `pr_review_surface.json` first.

Evidence:
- blocked PR surface renderer.
- reviewer UX lens.

Ready to post: yes.
```

---

## 37. Example `trust_audit.md`

```md
# Trust Audit

## Confidence summary

Medium confidence. The diff and risk candidates are deterministic, but coverage and manual security evidence are incomplete.

## Verified facts

- The diff was collected from `origin/main...HEAD`.
- The PR changes files in schema, renderer, and LLM narrative areas.
- Deterministic PR risks fired for schema contract and LLM trust-boundary changes.
- Command transcript `CMD-PNPM-TEST` exists and passed.

## Claimed but not verified

- “All coverage is complete.”
  - No coverage artifact supplied.

- “Secret boundary is safe.”
  - No manual review evidence supplied.

## Missing evidence

- Coverage artifact.
- Manual CI secret-boundary check.
- Previous artifact compatibility fixture.

## Invalid evidence

None recorded.
```

---

## 38. Example `test_plan.md`

```md
# Test Plan

## Required automatic tests

### TEST-001 — Schema compatibility fixture

Suggested file: `tests/pr-surface-schema.test.ts`

Scenario:
Load a previous valid `pr_review_surface.json` fixture and validate it against the current schema.

Expected:
The fixture validates, or the schema version is intentionally bumped.

Command:
`pnpm run test -- tests/pr-surface-schema.test.ts`

Maps to:
- `review-surfaces.SCHEMA.1`
- `PR-RISK-004`

### TEST-002 — Blocked PR comment does not fall back

Suggested file: `tests/pr-comment.test.ts`

Scenario:
Render a blocked PR surface with `blocked_reason=invalid_llm_output`.

Expected:
The comment explains the block and does not render the whole-repo packet.

Command:
`pnpm run test -- tests/pr-comment.test.ts`

## Required manual checks

### MANUAL-001 — CI secret boundary

Procedure:
Inspect workflow and provider changes to confirm secret-bearing steps run only from trusted code and cannot be influenced by PR-controlled files.

Record:
- reviewer
- date
- files inspected
- conclusion
```

---

## 39. Product positioning

## 39.1 Old positioning

> Evidence-backed review packet compiler for agent-generated code changes.

## 39.2 New positioning

> Human-first review cockpit for agent-generated PRs.

## 39.3 One-liner

> `review-surfaces` gives reviewers the shortest safe path through a PR, with every recommendation backed by local evidence.

## 39.4 Differentiation

Most AI review tools produce comments or summaries. `review-surfaces` should produce:

- a decision brief,
- a ranked review queue,
- a trust audit,
- concrete missing-evidence actions,
- suggested reviewer comments,
- hunk-level anchors,
- and local evidence contracts.

The product should be judged by how quickly a reviewer can perform a better review, not by how much text it generates.

---

## 40. Final recommendation

Build the next major feature slice around:

> “The 10-minute safe review path.”

The minimum compelling version is:

1. `human_review.md`
2. deterministic merge-readiness verdict
3. ranked review queue
4. blockers and author questions
5. trust audit
6. suggested comments
7. concrete test plan

This would turn the existing evidence engine into a product that feels meaningfully different from a generic AI summary.

The strongest product move is to make the default output human-first and decision-oriented while preserving the existing packet as the evidence backbone.
