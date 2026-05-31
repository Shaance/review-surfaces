---
name: composed-review-loop
description: Compose code review, local validation, generated review packets, dogfood findings, and follow-up fixes into one review workflow. Use when a user asks to enhance a review with review-surfaces, packet evidence, dogfood/self-review, composed review, or wants checks plus review evidence synthesized before merge or handoff.
---

# Skill: Composed Review Loop

Use this skill to review a change by composing multiple evidence sources instead
of relying on a single diff read. The goal is to catch both code defects and
process defects: stale artifacts, unsupported validation claims, missing proof,
overreach, and unclear handoffs.

## Relationship To Other Skills

- Use `$codex-reviewer` for full-diff code-review passes when it is available; otherwise perform an equivalent findings-first full-diff review yourself.
- Use `$production-review-loops` when it is available and the user asks for repeated hardening until production-grade.
- Use `review-surfaces` tooling when the repo provides it or when `bin/review-surfaces.js` / `pnpm run review-surfaces` is available.
- Use this skill as the orchestrator when review quality depends on combining code review, checks, generated packets, and handoff evidence.

Do not replace code review with generated packet output. Treat the packet as one
review input that can reveal evidence and workflow problems.

## Review Surfaces

Inspect these surfaces when available:

1. **Diff surface**: current branch diff, PR diff, staged patch, or provided patch.
2. **Check surface**: typecheck, lint, tests, build, runtime smoke checks, or user-specified commands.
3. **Transcript surface**: command transcripts that prove what ran, with exit codes and bounded output.
4. **Packet surface**: review packet, dogfood output, handoff, risks, SARIF/comment renderers, or equivalent generated artifacts.
5. **Review surface**: full-diff review findings, PR review threads, CI failures, and human comments.
6. **Handoff surface**: final summary of what changed, what is proven, what remains unknown, and what should happen next.

## Workflow

### 1. Establish Scope

Identify:

- the target diff or PR;
- base and head refs when available;
- the current head SHA when reviewing a PR, so stale checks or stale automated reviews are not treated as current evidence;
- whether edits are allowed or the user only wants advisory review;
- required commands and gates;
- whether `review-surfaces` packet generation is available.

If the repo has instructions such as `AGENTS.md`, read them before editing or
running project-specific commands.

### 2. Run The Best Local Checks

Run the strongest relevant checks that are practical for the task. Prefer the
repo's existing scripts over inventing new commands.

When `review-surfaces run` is available and command evidence matters, capture
important checks through transcript-backed commands, for example:

```bash
node bin/review-surfaces.js run --id CMD-BUILD --command-transcripts .review-surfaces/commands -- pnpm run build
node bin/review-surfaces.js run --id CMD-LINT --command-transcripts .review-surfaces/commands -- pnpm run lint
node bin/review-surfaces.js run --id CMD-TEST --command-transcripts .review-surfaces/commands -- pnpm run test
```

Keep the first recorded build command bootstrap-safe. Use a transcript runner
that works in a fresh checkout before `dist/` exists; if a repo wrapper requires
compiled output, use its bootstrap-safe `run` path, source entrypoint, or
documented local script for that first build transcript.

Use the repository's actual command names and IDs. Do not claim a check passed
unless command output or a transcript proves it.

### 3. Generate Packet Evidence

When `review-surfaces` is available, generate and validate the packet after the
current diff and command transcripts are in their final state:

```bash
node bin/review-surfaces.js all --base "$BASE_REF" --head "$HEAD_REF" --out .review-surfaces
node bin/review-surfaces.js validate .review-surfaces
```

Add repo-specific flags such as `--spec`, `--provider mock`, `--test-output`, or
custom `--out` when the project requires them. Add `--dogfood` only when
reviewing the `review-surfaces` repository itself or another repo explicitly
wants self-dogfood artifacts.

If packet generation is unavailable, create an equivalent manual evidence pass:
list changed files, checks run, validation status, known risks, missing evidence,
and handoff notes.

### 4. Inspect Packet As A Reviewer

Read the generated artifacts as evidence, not as truth. Check for:

- changed files missing from the packet or handoff;
- stale packet or handoff content after edits;
- base/head or current-head provenance that does not match the target diff or PR;
- validation claims without command transcripts or inspected output;
- failed commands shown as passing evidence;
- missing/partial/unknown requirement coverage relevant to the change;
- overreach files not mapped to an intended requirement or review area;
- LLM or agent hypotheses being treated as proof;
- secrets or private data appearing in generated review text;
- risk/test-gap sections that point to actionable fixes;
- generated comments/SARIF that would mislead a reviewer.

Convert every useful dogfood finding into one of:

- code change;
- test;
- schema or contract change;
- documentation or skill update;
- explicit deferral with reason;
- PR review note or handoff note.

### 5. Run Full-Diff Review

Run `$codex-reviewer` on the entire current diff as one patch when the skill is
available. If it is not available, perform the same findings-first full-diff
review yourself. Do not split the counted review into per-file chunks unless the
user explicitly narrows scope.

Focus the review on:

- regressions introduced by the patch;
- confusing architecture or ownership;
- missing tests for changed behavior;
- validation and generated-artifact fidelity;
- security/privacy risks;
- maintainability risks.

### 6. Synthesize And Fix

Deduplicate findings from checks, packet inspection, dogfood output, PR comments,
and the full-diff review pass.

Apply only fixes that are clearly in scope. After each fix batch:

- rerun impacted checks;
- regenerate packet artifacts if they are part of the deliverable;
- rerun the whole-diff review if code or behavior changed.

Do not commit stale generated artifacts. If generated artifacts are intentionally
not committed, say that explicitly in the handoff.

### 7. Exit Criteria

Finish only when all applicable conditions are true:

- relevant checks pass or intentional gaps are explicitly justified;
- transcript or inspected output supports validation claims;
- packet/handoff artifacts reflect the final diff;
- no actionable packet/dogfood findings remain unhandled;
- the full-diff review pass has no unresolved actionable findings;
- PR comments, review threads, and CI/check gates are resolved when reviewing a PR;
- the final response names remaining risks or says there are none known.

For PR autoland, do not merge unless repository-specific gates are satisfied,
including current-head automated review requirements when the repo has them.

## Output

Report:

- checks run and results;
- packet/dogfood findings that changed the work;
- code-review findings and fixes;
- generated artifacts inspected;
- remaining risks or explicit deferrals;
- final verdict: `ready`, `not ready`, or `blocked`.

Keep the summary concise. Put findings before summaries when acting in a review
stance.
