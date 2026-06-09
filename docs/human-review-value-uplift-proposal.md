# Human Review Value Uplift: Grounded Narrative, Density, and Semantic Facts

**Working title:** Cockpit Value Uplift for `review-surfaces`
**Date:** 2026-06-09
**Status:** Product/design proposal with spec entries already landed in `features/review-surfaces.feature.yaml`
**Intended readers:** maintainers, implementation agents, human reviewers
**Primary goal:** Raise the per-line value of the human review cockpit for human readers. The cockpit architecture from `docs/human-first-review-surfaces-comprehensive-feature-proposal.md` is substantially implemented; this proposal addresses why the rendered result still reads agent-oriented, and what would make it stand out.

Spec anchors introduced for this proposal (all in `features/review-surfaces.feature.yaml`):

- `review-surfaces.HUMAN_REVIEW.19` – rollup deduplication / density
- `review-surfaces.HUMAN_REVIEW.20` – inline hunk excerpts in the review queue
- `review-surfaces.HUMAN_REVIEW.21` – reviewer-language rendering, identifiers as metadata
- `review-surfaces.NARRATIVE.1-5` – grounded change narrative with per-claim trust states
- `review-surfaces.SEMANTIC_DIFF.1-4` – semantic schema diff, API surface diff, test-weakening detection
- `review-surfaces.REVIEW_LOOP.1-4` – interactive review session feeding feedback memory
- `review-surfaces.PROVIDERS.7` – pending GitHub draft review export
- Hardening: `review-surfaces.CLI.8`, `review-surfaces.RENDER.8`, `review-surfaces.SCHEMA.3`

---

## 1. Diagnosis: why the current cockpit underdelivers for humans

The cockpit machinery (verdict, queue, trust audit, lenses, routes, evidence cards) exists and is tested. The problem is what the rendered surface *says*. Three observations from the current generated `.review-surfaces/human_review.md`:

### 1.1 It speaks the project's meta-language, not the reviewer's

Nearly every rendered line is about ACIDs, `RISK-001`, `CARD-004`, or evidence taxonomy ("requirement-specific test evidence exists, but implementation evidence is broad rather than exact"). The artifact never states what the change actually does. A reviewer's first questions — "what does this PR do?" and "what could it break?" — go unanswered; instead the surface answers "which requirement IDs lack evidence." That is traceability-ledger output: ideal for an agent, opaque to a human.

### 1.2 Information density is too low

In the current dogfood output, `TEST-001` through `TEST-006` are the same sentence with a different ACID. Questions 1-3 are identical apart from the ID. `CARD-001` through `CARD-004` are identical. A human reads two of these, concludes "template spam," and stops trusting the rest of the document. Repetition is free for agents and fatal for human trust.

### 1.3 Path-rule determinism can only say generic things

Because risks come from path/ID matching, the rendered "why this matters" is circular ("Ranked from whole-packet medium testing risk RISK-001"). The insight a reviewer actually pays for — "this makes schema field `x` required; existing artifacts will fail validation" — requires diff *semantics*, which path rules cannot produce.

The project's real differentiator — **LLM proposes, deterministic evidence validates** — is currently used only for bounded hypotheses in the evaluation section, never for the human-facing narrative. That is the lever this proposal pulls.

---

## 2. Proposal A: Grounded change narrative (`NARRATIVE.1-5`)

**The standout feature.** Most AI review tools produce fluent prose that may be wrong. `review-surfaces` can produce prose where **every sentence carries a verified/claimed trust state**, because the anchor-validation machinery already exists for PR narratives (`src/llm/pr-narrative.ts` anchor allowlisting, `EVIDENCE.3-4` invalid-reference handling).

### Design

- `human_review.md` opens with a bounded narrative (5-8 sentences): what the change does, why it matters, where risk concentrates.
- Produced through the existing provider boundary (`mock`, `agent-file`, `ai-sdk`). With `agent-file`, the coding agent that made the change can supply the narrative hypotheses offline.
- Each claim must cite allowlisted anchors: changed files, hunks, ACIDs, command transcripts, schema artifacts. Anchors are validated deterministically.
- Render with per-claim trust markers, e.g. `✓` (anchor-verified) vs `~` (claimed, anchor missing/invalid). Invalid-anchor claims are demoted and visibly marked, never silently dropped or rendered as fact.
- Hard rule restated from `HUMAN_TRUST.2`: the narrative never creates/clears blockers, never changes coverage, never alters the verdict (`NARRATIVE.4`).
- Mock provider or rejected narrative → deterministic fallback summary renders, command succeeds (`NARRATIVE.5`).

### Model/contract sketch

```ts
interface NarrativeClaim {
  text: string;
  anchors: EvidenceRef[];          // validated
  trust: 'verified' | 'claimed';
  invalid_anchors?: string[];      // surfaced, not hidden
}
interface ChangeNarrative {
  claims: NarrativeClaim[];
  provider: 'mock' | 'agent-file' | 'ai-sdk';
  validated_at_head: string;       // head SHA the validation ran against
}
```

Add `narrative` as an optional-but-strict field to `HumanReviewModel` (see schema-strictness note in section 7).

### Acceptance criteria

- Fixture test: agent-file narrative with one valid-anchor claim and one bogus-path claim → rendered output marks the first `✓`, demotes the second to `~` with the invalid anchor listed; verdict unchanged in both cases.
- Mock run renders deterministic fallback with no narrative section failure.
- Narrative section is capped (config: `human_review.narrative.max_claims`, default ~8).

---

## 3. Proposal B: Density and reviewer language (`HUMAN_REVIEW.19-21`)

Cheapest change, largest immediate trust gain. Three renderer-level rules:

1. **Rollups (`.19`):** any set of findings identical modulo ACID renders once, listing the affected ACIDs. "Add focused tests for 6 HUMAN_TRUST/HUMAN_REVIEW requirements: `…list…`" replaces six near-identical `TEST-00x` blocks. The JSON model keeps per-item entries; only rendering aggregates. Applies to test plan, questions, evidence cards, and trust-audit missing items.
2. **Inline hunks (`.20`):** queue items that carry `hunk_header`/`line_start` render a bounded (~10-15 line) diff excerpt inline, sourced from collected diff inputs, respecting privacy exclusions. The reviewer acts without switching tools. This also honors the existing `HUMAN_TRUST.4` one-screen rule: excerpts appear in queue items, not the top summary.
3. **Reviewer language (`.21`):** every rendered sentence leads with file → behavior → action; ACIDs/risk IDs/card IDs move to trailing metadata. Banned pattern: prose whose subject is internal bookkeeping ("Ranked from whole-packet medium testing risk RISK-001"); the renderer must state the underlying reason instead ("104 requirements have implementation evidence but weak test evidence; this spec file is where they are defined").

### Acceptance criteria

- Golden fixture asserting that N identical templated test-plan items render as one rollup containing all N ACIDs.
- Golden fixture asserting a queue item with hunk anchors renders a fenced diff excerpt bounded to the cap.
- A lint-style renderer test asserting no rendered reviewer-facing line begins with an internal ID pattern (`RISK-\d`, `CARD-\d`, ACID) as the sentence subject.

---

## 4. Proposal C: Semantic change facts (`SEMANTIC_DIFF.1-4`)

Keep determinism, raise the information content of the facts themselves.

1. **Semantic schema diff (`.1`)** — first proof point, this repo is schema-heavy. When `schemas/*.json` change, structurally diff old vs new: properties added/removed, `required` changes, type/enum changes. The existing `schema_contract_change` PR risk currently fires on "schema file touched"; with this, it says "`risk_lens_findings` became required — v1 artifacts will fail validation." Feed specifics into the risk, the queue item, and the suggested comment.
2. **Exported API surface diff (`.2`)** — exported symbols added/removed/signature-changed in changed TypeScript files (TS compiler API or a bounded AST pass). Feeds contract-related risks and queue items.
3. **Test-weakening detector (`.3`)** — deleted test files, newly `skip`ped tests, removed assertions, regenerated snapshots, as a distinct deterministic risk class near the top of the surface. This is core to the agent-review positioning (section 6): "did the agent weaken tests to go green?"
4. **Concrete language (`.4`)** — semantic facts replace generic path-based phrasing wherever they flow (queue ranking, lenses, suggested comments).

### Acceptance criteria

- Fixture: schema change making a field required → queue item and suggested comment name the field and the compat consequence.
- Fixture: test file with an assertion removed → test-weakening risk fires; unrelated test edits do not fire it.
- Fixture: exported function signature change → API-surface fact attached to a contract risk.

---

## 5. Proposal D: Interactive review session (`REVIEW_LOOP.1-4`)

Feedback memory exists (`HUMAN_REVIEW.10`) but nothing feeds it ergonomically — `feedback/*.yaml` is hand-written today. A guided loop turns the cockpit from a report into a tool and closes the learning loop:

- `review-surfaces next` (or `review`) steps through the ranked queue: inline hunk excerpt, reason, evidence; reviewer answers accept / flag / false-positive / needs-comment.
- Decisions persist into local feedback files; later runs downgrade or promote matching findings. Decisions never silently delete evidence (consistent with `HUMAN_REVIEW.10`).
- Comment drafts captured in-session land in `suggested_comments.md` marked draft or ready.
- Non-interactive environments (CI, piped stdout) print the next queue item and exit cleanly — no hang, no error.

### Acceptance criteria

- E2E fixture driving the loop with scripted stdin: marking an item false-positive writes a feedback entry; a rerun ranks the matching finding lower with a visible feedback-effect note.
- Non-TTY invocation exits 0 with the next item printed.

---

## 6. Positioning: the trust layer for agent-written code

Not a single feature — a framing that the above features complete. In 2026 most reviewed PRs are agent-authored, and the reviewer's real questions are:

1. **Did the agent overreach its instructions?** → intent mismatch (`HUMAN_REVIEW.18`, exists) + semantic facts make it concrete.
2. **Did the agent weaken tests to pass?** → `SEMANTIC_DIFF.3`.
3. **Did the agent claim things it didn't do?** → trust audit (`HUMAN_REVIEW.3`, exists); the narrative trust markers (`NARRATIVE.3`) put this on every sentence.

"The agent claims tests passed; no transcript backs it" is a headline no generic review bot has. README/positioning copy should lead with this once Proposals A-C land. No new spec entry needed beyond the ones above.

**Optional later surface (`PROVIDERS.7`):** export hunk-anchored suggested comments as a *pending GitHub draft review* the human edits and submits. Reviewers live in the diff view; a sticky comment is a pointer, a pending review is a workflow. Never auto-submits.

---

## 7. Hardening appendix (from external implementation review)

An external review of main confirmed the cockpit proposal is substantially implemented and identified contract/UX hardening gaps. Adopted as spec entries:

| Item | Spec anchor | Summary |
|---|---|---|
| Strict human schema | `SCHEMA.3` | `schemas/human_review.schema.json` must require all current `HumanReviewModel` fields (or add a versioned strict mode) so stale partial artifacts fail validation instead of degrading quietly. Any new `narrative` field follows the same strictness. |
| Validate all surfaces | `CLI.8` | `validate` must cover `human_review.json` and `pr_review_surface.json`, e.g. `--surface packet\|human\|pr\|all`. |
| Local comment exit code | `RENDER.8` | Local PR-comment render without `--post` exits 0 after writing diagnostics; postability failures are non-zero only when posting is requested or a strict flag is set. |

Two items from that review were considered and deliberately deferred, not adopted:

- **`human/`/`evidence/`/`agent/` directory split** — deferred; root-level layout is intentional for backward compatibility for now. Revisit if artifact count keeps growing.
- **Config-level `decision_policy`** — deferred until `REVIEW_LOOP` lands; session-captured feedback may make hand-written policy config partially redundant, and we should design policy-as-code with that data in hand.

---

## 8. Sequencing for implementation agents

Each phase is independently shippable and dogfoodable. Run `--provider mock` dogfood after each phase and judge the regenerated `human_review.md` by reading it as a human.

1. **Phase 1 — Density (B) + hardening (7).** Renderer-only rollups, inline hunks, reviewer-language pass; `SCHEMA.3`, `CLI.8`, `RENDER.8`. No model changes except what strictness requires. Smallest diff, immediate readability gain.
2. **Phase 2 — Grounded narrative (A).** Contract + schema field, anchor validation reuse, agent-file/mock paths, trust-marked rendering.
3. **Phase 3 — Semantic facts (C),** schema diff first, then test-weakening, then API surface diff.
4. **Phase 4 — Interactive loop (D),** then revisit deferred decision-policy config.
5. **Phase 5 — Positioning + `PROVIDERS.7`** draft-review export.

Discipline reminders for the implementing agent (per `AGENTS.md` / `CLAUDE.md`): preserve Acai IDs in tests and notes; never treat narrative/agent-file output as proof until deterministic validation accepts it; keep artifacts compact and local-first.
