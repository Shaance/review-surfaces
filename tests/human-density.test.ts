import test from "node:test";
import assert from "node:assert/strict";
import { fileEvidence, missingEvidence } from "../src/evidence/evidence";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { renderHunkExcerpt, resolveStructuredExcerpt, DEFAULT_HUNK_EXCERPT_MAX_LINES } from "../src/human/hunk-excerpt";
import {
  extractAcids,
  fillAcidTemplate,
  leadsWithInternalId,
  normalizeAcidTemplate,
  rollupBy
} from "../src/human/rollup";
import { renderHumanReviewMarkdown, renderReviewQueueMarkdown } from "../src/human/render";
import { renderHumanReviewHtml } from "../src/human/render-html";
import type {
  HumanReviewModel,
  ReviewQueueItem,
  TestPlanItem
} from "../src/human/contract";
import { HUMAN_REVIEW_SCHEMA_VERSION } from "../src/human/contract";

// ---------------------------------------------------------------------------
// review-surfaces.HUMAN_REVIEW.19 / .20 / .21 — density, inline hunks, and
// reviewer-language rendering.
// ---------------------------------------------------------------------------

function baseModel(overrides: Partial<HumanReviewModel>): HumanReviewModel {
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: "repo",
    spec_mode: "acai",
    narrative: { source: "fallback", provider: "mock", validated_at_head: "abc", claims: [] },
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    change_graph: { nodes: [], halo_nodes: [], edges: [], clusters: [], overview: { groups: [], halo_count: 0, edges: [] } },
    reading_order: { legs: [] },
    verdict: { decision: "reviewable_with_attention", confidence: "medium", reasons: [] },
    summary: "Density fixture.",
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [],
      invalid_evidence: [],
      confidence_summary: "Medium confidence fixture."
    },
    risk_lens_findings: [],
    methodology_audit: { quality_flags: [], considered: [], research: [], workflow_findings: [] },
    intent_mismatch: {
      expected_by_spec: [],
      observed_in_diff: [],
      possible_mismatches: [],
      possible_overreach: [],
      missing_intent: []
    },
    review_routes: [],
    since_last_review: {
      unavailable_reason: "No previous packet.",
      improved: [],
      regressed: [],
      new_risks: [],
      resolved_risks: [],
      new_overreach: [],
      resolved_overreach: [],
      still_open: [],
      count_deltas: {
        satisfied: { before: 0, after: 0, delta: 0 },
        partial: { before: 0, after: 0, delta: 0 },
        missing: { before: 0, after: 0, delta: 0 },
        unknown: { before: 0, after: 0, delta: 0 },
        invalid_evidence: { before: 0, after: 0, delta: 0 }
      }
    },
    coverage_evidence: { status: "no_report", files: [] },
    review_plan: { enabled: false, read: [], skim: [], defer: [] },
    evidence_cards: [],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "abc123",
      uncommitted_files: 0
    },
    ...overrides
  };
}

function templatedTestItem(index: number, acid: string): TestPlanItem {
  return {
    id: `TEST-${String(index).padStart(3, "0")}`,
    kind: "automatic",
    priority: "recommended",
    suggested_file: "tests/human-review.test.ts",
    scenario: `Add a focused unit or fixture test tied to ${acid}.`,
    expected_result: "The generated human review JSON and Markdown retain deterministic behavior for this requirement.",
    command: "pnpm run test -- tests/human-review.test.ts",
    maps_to_requirements: [acid],
    maps_to_risks: [],
    evidence_gap: "Test evidence exists, but implementation evidence is missing or weak."
  };
}

// review-surfaces.HUMAN_REVIEW.19: N templated test-plan items that differ only
// by ACID render as a single rollup listing all N ACIDs and item IDs.
test("review-surfaces.HUMAN_REVIEW.19 rolls up templated test-plan items into one block", () => {
  const acids = [
    "review-surfaces.HUMAN_TRUST.1",
    "review-surfaces.HUMAN_TRUST.2",
    "review-surfaces.HUMAN_TRUST.3"
  ];
  const model = baseModel({
    test_plan: acids.map((acid, i) => templatedTestItem(i + 1, acid))
  });
  const md = renderHumanReviewMarkdown(model);
  const testPlanSection = md.split("## Test plan")[1].split("\n## ")[0];
  // Exactly one rollup heading for the three identical-modulo-ACID items.
  const headings = testPlanSection.match(/^### /gm) ?? [];
  assert.equal(headings.length, 1, "three templated items must collapse to one rollup");
  // All three ACIDs and all three item IDs are listed in the single block.
  for (const acid of acids) {
    assert.ok(testPlanSection.includes(acid), `rollup must list ${acid}`);
  }
  for (const id of ["TEST-001", "TEST-002", "TEST-003"]) {
    assert.ok(testPlanSection.includes(id), `rollup must list ${id}`);
  }
  // The same sentence is not repeated once per ACID.
  const sentenceCount = (testPlanSection.match(/Add a focused unit or fixture test/g) ?? []).length;
  assert.equal(sentenceCount, 1, "templated sentence must appear once, not per-ACID");
});

// review-surfaces.HUMAN_REVIEW.19: rolling up happens before the display cap, so
// a distinct item beyond the raw item cap is not hidden behind earlier duplicates.
test("review-surfaces.HUMAN_REVIEW.19 rolls up before capping so distinct items survive", () => {
  const dupes = Array.from({ length: 9 }, (_unused, i) => ({
    ...templatedTestItem(i + 1, `review-surfaces.HUMAN_TRUST.${i + 1}`),
    evidence_gap: "Identical templated gap."
  }));
  const distinct: TestPlanItem = {
    ...templatedTestItem(99, "review-surfaces.CLI.8"),
    evidence_gap: "A distinct required test the reviewer must not lose.",
    priority: "required"
  };
  const model = baseModel({ test_plan: [...dupes, distinct] });
  const section = renderHumanReviewMarkdown(model).split("## Test plan")[1].split("\n## ")[0];
  assert.match(section, /A distinct required test the reviewer must not lose\./, "the distinct item must survive the cap");
});

// review-surfaces.HUMAN_REVIEW.19: a rollup must list every affected ACID, even
// when the only difference is an ACID embedded in the expected_result/command.
test("review-surfaces.HUMAN_REVIEW.19 lists ACIDs that differ only in the expected result", () => {
  const items: TestPlanItem[] = ["review-surfaces.CLI.1", "review-surfaces.CLI.2"].map((acid, i) => ({
    id: `TEST-${i + 1}`,
    kind: "automatic",
    priority: "recommended",
    scenario: "Add a focused test.",
    expected_result: `The behavior for ${acid} is retained.`,
    maps_to_requirements: [],
    maps_to_risks: [],
    evidence_gap: "Weak test evidence."
  }));
  const section = renderHumanReviewMarkdown(baseModel({ test_plan: items })).split("## Test plan")[1].split("\n## ")[0];
  assert.match(section, /review-surfaces\.CLI\.1/);
  assert.match(section, /review-surfaces\.CLI\.2/, "both ACIDs must be listed even though they differ only in expected_result");
});

// review-surfaces.HUMAN_REVIEW.20: a queue item with hunk/line anchors renders a
// bounded fenced diff excerpt inline.
test("review-surfaces.HUMAN_REVIEW.20 renders a bounded inline hunk excerpt for an anchored queue item", () => {
  const diffText = [
    "diff --git a/src/sample.ts b/src/sample.ts",
    "--- a/src/sample.ts",
    "+++ b/src/sample.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " const d = 5;",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  const queueItem: ReviewQueueItem = {
    id: "REVIEW-001",
    rank: 1,
    title: "Changed implementation file",
    path: "src/sample.ts",
    hunk_header: "@@ -1,3 +1,4 @@",
    line_start: 2,
    line_end: 3,
    reviewer_action: "Inspect the changed lines.",
    reason: "Modifies a constant other code depends on.",
    evidence: [fileEvidence("src/sample.ts")],
    requirement_ids: [],
    risk_ids: ["RISK-001"],
    ranking_reasons: [],
    confidence: "high",
    priority: "medium"
  };
  const model = baseModel({ review_queue: [queueItem] });
  const md = renderHumanReviewMarkdown(model, { diff });
  assert.match(md, /```diff/, "anchored queue item must render a fenced diff excerpt");
  assert.match(md, /\+const b = 3;/, "excerpt must contain the changed added line");
  assert.match(md, /-const b = 2;/, "excerpt must contain the changed removed line");

  // Without a diff context, the same queue item renders no excerpt (graceful).
  const noExcerpt = renderHumanReviewMarkdown(model, {});
  assert.doesNotMatch(noExcerpt, /```diff/);

  // Standalone queue artifact also honors the excerpt.
  const queueMd = renderReviewQueueMarkdown(model, { diff });
  assert.match(queueMd, /```diff/);
});

test("review-surfaces.HUMAN_REVIEW.20 bounds the excerpt to the configured cap", () => {
  const header = "@@ -1,40 +1,40 @@";
  const body = Array.from({ length: 40 }, (_unused, i) => ` line ${i + 1}`);
  body[20] = "+changed line";
  const diffText = [
    "diff --git a/src/big.ts b/src/big.ts",
    "--- a/src/big.ts",
    "+++ b/src/big.ts",
    header,
    ...body,
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  const excerpt = renderHunkExcerpt(diff, { path: "src/big.ts", hunk_header: header, line_start: 21, line_end: 21 });
  assert.ok(excerpt, "excerpt should render");
  // Body lines = everything except the opening fence+lang, the header, and the
  // closing fence. The body (including any elision markers) must stay within the
  // configured cap.
  const allLines = excerpt!.split("\n");
  const excerptBody = allLines.slice(2, allLines.length - 1); // drop ```diff, header, closing fence
  assert.ok(
    excerptBody.length <= DEFAULT_HUNK_EXCERPT_MAX_LINES,
    `excerpt body (incl. elision markers) must stay within the cap, got ${excerptBody.length} lines`
  );
  assert.match(excerpt!, /elided/, "a long hunk must mark elided context");
});

// review-surfaces.HUMAN_REVIEW.20: a replacement-rename (rename A->B plus a new
// A) resolves the excerpt to B (the anchor's primary path), not the unrelated A
// that appears earlier in the diff.
test("review-surfaces.HUMAN_REVIEW.20 prefers the anchor path over old_path for replacement renames", () => {
  const diffText = [
    // The new A file appears FIRST in the diff.
    "diff --git a/src/a.ts b/src/a.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/a.ts",
    "@@ -0,0 +1,1 @@",
    "+const brandNewA = 1;",
    // The rename A->B appears second.
    "diff --git a/src/a.ts b/src/b.ts",
    "rename from src/a.ts",
    "rename to src/b.ts",
    "--- a/src/a.ts",
    "+++ b/src/b.ts",
    "@@ -1,1 +1,1 @@",
    "-const movedToB = 0;",
    "+const movedToB = 1;",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  // Anchor for B carries old_path A; must resolve to B, not the new A.
  const excerpt = renderHunkExcerpt(diff, { path: "src/b.ts", old_path: "src/a.ts", line_start: 1, line_end: 1 });
  assert.ok(excerpt, "excerpt should resolve to the rename target");
  assert.match(excerpt!, /movedToB/, "must take the excerpt from the anchor path B");
  assert.doesNotMatch(excerpt!, /brandNewA/, "must not take the excerpt from the unrelated new A");
});

// review-surfaces.HUMAN_REVIEW.20: a git-quoted diff path (escaped special
// chars) is decoded so it matches the real anchor filename and the excerpt
// resolves.
test("review-surfaces.HUMAN_REVIEW.20 decodes git-quoted diff paths for excerpt matching", () => {
  const diffText = [
    'diff --git "a/src/weird\\tname.ts" "b/src/weird\\tname.ts"',
    '--- "a/src/weird\\tname.ts"',
    '+++ "b/src/weird\\tname.ts"',
    "@@ -1,1 +1,1 @@",
    "-const x = 0;",
    "+const x = 1;",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  // The parsed file path is the real (decoded) filename with a literal tab.
  assert.equal(diff.files[0].path, "src/weird\tname.ts");
  // An anchor carrying the real filename resolves the excerpt.
  const excerpt = renderHunkExcerpt(diff, { path: "src/weird\tname.ts", line_start: 1, line_end: 1 });
  assert.ok(excerpt, "decoded path should match the anchor and render an excerpt");
  assert.match(excerpt!, /const x = 1;/);
});

// review-surfaces.HUMAN_REVIEW.20: an explicit old-side anchor (side: "old")
// resolves to the rename source even when a replacement file re-adds the same
// path and its line range coincides.
test("review-surfaces.HUMAN_REVIEW.20 uses the anchor side hint to resolve a replacement rename", () => {
  const diffText = [
    // New file at src/a.ts whose change is at new line 1 (coincides with the rename source's old line 1).
    "diff --git a/src/a.ts b/src/a.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/a.ts",
    "@@ -0,0 +1,1 @@",
    "+const replacementA = 1;",
    // Rename src/a.ts -> src/b.ts; old side carries the source line at old line 1.
    "diff --git a/src/a.ts b/src/b.ts",
    "rename from src/a.ts",
    "rename to src/b.ts",
    "--- a/src/a.ts",
    "+++ b/src/b.ts",
    "@@ -1,1 +5,1 @@",
    "-const sourceA = 0;",
    "+const inB = 1;",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  // Old-side anchor with the side hint: must resolve to the rename source, not the new file.
  const excerpt = renderHunkExcerpt(diff, { path: "src/a.ts", line_start: 1, line_end: 1, side: "old" });
  assert.ok(excerpt, "old-side anchor should resolve");
  assert.match(excerpt!, /sourceA/, "side hint must pick the rename source's old-side hunk");
  assert.doesNotMatch(excerpt!, /replacementA/, "must not pick the coinciding-line replacement file");
});

// review-surfaces.HUMAN_REVIEW.20: a side-aware line overlap takes precedence
// over a header that happens to match a different hunk, so the excerpt shows the
// hunk the line anchor points at.
test("review-surfaces.HUMAN_REVIEW.20 prefers the line-overlap hunk over a header matching another hunk", () => {
  const diffText = [
    "diff --git a/src/two-hunks.ts b/src/two-hunks.ts",
    "--- a/src/two-hunks.ts",
    "+++ b/src/two-hunks.ts",
    "@@ -1,1 +1,1 @@",
    "-const first = 0;",
    "+const first = 1;",
    "@@ -10,1 +10,1 @@",
    "-const second = 0;",
    "+const second = 1;",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  // The header names the FIRST hunk, but the line anchor points into the SECOND.
  const excerpt = renderHunkExcerpt(diff, { path: "src/two-hunks.ts", hunk_header: "@@ -1,1 +1,1 @@", line_start: 10, line_end: 10 });
  assert.ok(excerpt, "should render");
  assert.match(excerpt!, /const second = 1;/, "the line anchor must win over the header");
  assert.match(excerpt!, /@@ -10,1 \+10,1 @@/, "header names the line-selected hunk");
  assert.doesNotMatch(excerpt!, /const first = 1;/);
});

// review-surfaces.HUMAN_REVIEW.20: a chain replacement (rename B->C appearing
// before A->B) must resolve a `path: B` anchor to the A->B file (whose new path
// is B), not the B->C file (whose old_path is B).
test("review-surfaces.HUMAN_REVIEW.20 matches the anchor's new path before old-path renames", () => {
  const diffText = [
    // B -> C appears FIRST; its old_path is B.
    "diff --git a/src/b.ts b/src/c.ts",
    "rename from src/b.ts",
    "rename to src/c.ts",
    "--- a/src/b.ts",
    "+++ b/src/c.ts",
    "@@ -1,1 +1,1 @@",
    "-const inC = 0;",
    "+const inC = 1;",
    // A -> B appears second; its new path is B.
    "diff --git a/src/a.ts b/src/b.ts",
    "rename from src/a.ts",
    "rename to src/b.ts",
    "--- a/src/a.ts",
    "+++ b/src/b.ts",
    "@@ -1,1 +1,1 @@",
    "-const inB = 0;",
    "+const inB = 1;",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  const excerpt = renderHunkExcerpt(diff, { path: "src/b.ts", old_path: "src/a.ts", line_start: 1, line_end: 1 });
  assert.ok(excerpt, "excerpt should resolve to the file whose new path is B");
  assert.match(excerpt!, /inB/, "must take the excerpt from the A->B file (new path B)");
  assert.doesNotMatch(excerpt!, /inC/, "must not resolve to the B->C file via its old_path");
});

// review-surfaces.HUMAN_REVIEW.20: an OLD-side anchor pointing at a rename source
// resolves to the rename (the source hunk), not the unrelated replacement file
// that reuses the same path on the new side.
test("review-surfaces.HUMAN_REVIEW.20 resolves an old-side rename anchor to the rename source, not the replacement file", () => {
  const diffText = [
    // A new file A is added (new-side path a.ts).
    "diff --git a/src/a.ts b/src/a.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/a.ts",
    "@@ -0,0 +1,1 @@",
    "+const newA = 1;",
    // A is renamed to B; the old side (a.ts) carries the removed line at line 5.
    "diff --git a/src/a.ts b/src/b.ts",
    "rename from src/a.ts",
    "rename to src/b.ts",
    "--- a/src/a.ts",
    "+++ b/src/b.ts",
    "@@ -5,1 +9,1 @@",
    "-const removedFromA = 0;",
    "+const inB = 1;",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  // Old-side anchor: path is the old path a.ts, line is an old-side line (5).
  const excerpt = renderHunkExcerpt(diff, { path: "src/a.ts", line_start: 5, line_end: 5 });
  assert.ok(excerpt, "old-side anchor should resolve to the rename source hunk");
  assert.match(excerpt!, /removedFromA/, "must show the rename source's old-side hunk");
  assert.doesNotMatch(excerpt!, /newA/, "must not resolve to the unrelated replacement file");
});

// review-surfaces.HUMAN_REVIEW.19: a rollup that merged items differing only by
// an ACID in the command renders the command through the ACID template instead
// of naming only the first requirement.
test("review-surfaces.HUMAN_REVIEW.19 normalizes a rolled-up command", () => {
  const items: TestPlanItem[] = ["review-surfaces.CLI.1", "review-surfaces.CLI.2"].map((acid, i) => ({
    id: `TEST-${i + 1}`,
    kind: "automatic",
    priority: "recommended",
    scenario: "Add a focused test.",
    expected_result: "Behavior retained.",
    command: `pnpm run test -- ${acid}`,
    maps_to_requirements: [acid],
    maps_to_risks: [],
    evidence_gap: "Weak test evidence."
  }));
  const section = renderHumanReviewMarkdown(baseModel({ test_plan: items })).split("## Test plan")[1].split("\n## ")[0];
  assert.match(section, /Command: `pnpm run test -- the listed requirements`/, "merged command must be ACID-templated");
  assert.doesNotMatch(section, /pnpm run test -- review-surfaces\.CLI\.1`/, "must not show only the first ACID's command");
});

// review-surfaces.HUMAN_REVIEW.20/.21: when an excerpt renders, the separate
// "Hunk:" metadata line is suppressed so it cannot contradict the excerpt header.
test("review-surfaces.HUMAN_REVIEW.20 suppresses the Hunk metadata line when an excerpt renders", () => {
  const diffText = [
    "diff --git a/src/s.ts b/src/s.ts",
    "--- a/src/s.ts",
    "+++ b/src/s.ts",
    "@@ -1,2 +1,2 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  const item: ReviewQueueItem = {
    id: "REVIEW-001", rank: 1, title: "Changed file", path: "src/s.ts",
    hunk_header: "@@ -1,2 +1,2 @@", line_start: 2, line_end: 2,
    reviewer_action: "Inspect.", reason: "Changed a constant.",
    evidence: [fileEvidence("src/s.ts")], requirement_ids: [], risk_ids: [], ranking_reasons: [],
    confidence: "high", priority: "medium"
  };
  const md = renderHumanReviewMarkdown(baseModel({ review_queue: [item] }), { diff });
  const reviewFirst = md.split("## Review first")[1].split("\n## ")[0];
  assert.match(reviewFirst, /```diff/, "excerpt renders");
  assert.doesNotMatch(reviewFirst, /- Hunk: `/, "the separate Hunk: line is suppressed when an excerpt renders");
});

// review-surfaces.HUMAN_REVIEW.20: when a long hunk has multiple changed
// clusters, the excerpt centers on the queue item's anchored line, not the first
// change in the hunk.
test("review-surfaces.HUMAN_REVIEW.20 centers the excerpt on the anchored line, not the first change", () => {
  const header = "@@ -1,40 +1,40 @@";
  const lines: string[] = [];
  for (let i = 1; i <= 40; i += 1) {
    if (i === 3) {
      lines.push("+early change near the top");
    } else if (i === 34) {
      lines.push("+ANCHORED change the reviewer must see");
    } else {
      lines.push(` context line ${i}`);
    }
  }
  const diffText = ["diff --git a/src/multi.ts b/src/multi.ts", "--- a/src/multi.ts", "+++ b/src/multi.ts", header, ...lines, ""].join("\n");
  const diff = parseStructuredDiff(diffText);
  const excerpt = renderHunkExcerpt(diff, { path: "src/multi.ts", hunk_header: header, line_start: 34, line_end: 34 }, 10);
  assert.ok(excerpt, "excerpt should render");
  assert.match(excerpt!, /ANCHORED change the reviewer must see/, "excerpt must include the anchored later cluster");
  assert.doesNotMatch(excerpt!, /early change near the top/, "excerpt must not window on the unrelated first change");
});

// review-surfaces.HUMAN_REVIEW.19: rollups must preserve the evidence pointers
// the per-item renderer carried (questions, evidence cards, trust gaps).
test("review-surfaces.HUMAN_REVIEW.19 rollups preserve evidence across grouped items", () => {
  const model = baseModel({
    questions: [1, 2].map((n) => ({
      id: `Q-00${n}`,
      severity: "clarifying" as const,
      question: `What evidence closes review-surfaces.HUMAN_TRUST.${n}?`,
      reason: "Partial coverage.",
      evidence: [fileEvidence(`tests/q${n}.test.ts`)],
      maps_to_risks: [],
      maps_to_requirements: [`review-surfaces.HUMAN_TRUST.${n}`]
    })),
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [1, 2].map((n) => ({
        id: `ME-00${n}`,
        summary: `Missing manual review check for review-surfaces.BOOTSTRAP.${n}.`,
        evidence: [fileEvidence(`src/bootstrap${n}.ts`)]
      })),
      invalid_evidence: [],
      confidence_summary: "Fixture."
    },
    evidence_cards: [1, 2].map((n) => ({
      id: `CARD-00${n}`,
      title: "Missing manual check",
      status: "missing_evidence" as const,
      summary: `Missing manual review check for review-surfaces.BOOTSTRAP.${n}.`,
      direct_evidence: [],
      missing_evidence: [missingEvidence(`No evidence ${n}`)],
      invalid_evidence: [],
      why_it_matters: "Required.",
      reviewer_action: "Ask the author to provide the evidence.",
      source_ids: [],
      risk_ids: [],
      requirement_ids: [`review-surfaces.BOOTSTRAP.${n}`],
      confidence: "medium" as const,
      priority: "medium" as const
    }))
  });
  const md = renderHumanReviewMarkdown(model);
  const questions = md.split("## Questions for author")[1].split("\n## ")[0];
  assert.match(questions, /evidence: .*tests\/q1\.test\.ts/, "rolled-up question must keep evidence pointers");
  assert.match(questions, /tests\/q2\.test\.ts/, "rolled-up question must union evidence across items");
  const trust = md.split("Missing:")[1].split("\n\n")[0];
  assert.match(trust, /src\/bootstrap1\.ts/);
  assert.match(trust, /src\/bootstrap2\.ts/, "rolled-up trust gap must union evidence across requirements");
  assert.match(trust, /review-surfaces\.BOOTSTRAP\.1/, "rolled-up trust gap must list the affected ACIDs");
  assert.match(trust, /review-surfaces\.BOOTSTRAP\.2/);
  const cards = md.split("## Evidence cards")[1].split("\n## ")[0];
  assert.match(cards, /evidence: direct 0, missing 2, invalid 0/, "evidence card rollup must show the unioned evidence mix");
});

// review-surfaces.HUMAN_REVIEW.19: a trust-gap rollup must list ACIDs that are
// carried only in structured evidence metadata (EvidenceRef.acai_id), not just
// those embedded in the summary prose.
test("review-surfaces.HUMAN_REVIEW.19 trust rollup lists ACIDs from evidence metadata", () => {
  const model = baseModel({
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [1, 2].map((n) => ({
        id: `ME-${n}`,
        // Generic prose with NO ACID; the requirement lives only in evidence.
        summary: "Missing implementation evidence for a required area.",
        evidence: [{ kind: "file" as const, path: `src/x${n}.ts`, acai_id: `review-surfaces.SEMANTIC_DIFF.${n}`, confidence: "medium" as const }]
      })),
      invalid_evidence: [],
      confidence_summary: "Fixture."
    }
  });
  const trust = renderHumanReviewMarkdown(model).split("Missing:")[1].split("\n\n")[0];
  assert.match(trust, /review-surfaces\.SEMANTIC_DIFF\.1/, "must list ACID from evidence metadata");
  assert.match(trust, /review-surfaces\.SEMANTIC_DIFF\.2/);
});

// review-surfaces.HUMAN_REVIEW.19: a trust rollup that unions more than four
// distinct evidence refs marks the omission instead of looking fully evidenced.
test("review-surfaces.HUMAN_REVIEW.19 trust rollup marks omitted evidence past the cap", () => {
  const model = baseModel({
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [1, 2, 3, 4, 5, 6].map((n) => ({
        id: `ME-${n}`,
        summary: `Missing implementation evidence for review-surfaces.SEMANTIC_DIFF.${n}.`,
        evidence: [fileEvidence(`src/file${n}.ts`)]
      })),
      invalid_evidence: [],
      confidence_summary: "Fixture."
    }
  });
  const trust = renderHumanReviewMarkdown(model).split("Missing:")[1].split("\n\n")[0];
  assert.match(trust, /\(\+\d+ more\)/, "rolled-up trust evidence past the 4-ref cap must show a (+N more) marker");
});

// review-surfaces.HUMAN_REVIEW.20: a stale/out-of-range anchor must omit the
// excerpt rather than showing an unrelated first-changed hunk.
test("review-surfaces.HUMAN_REVIEW.20 omits the excerpt when the anchor matches no hunk", () => {
  const diffText = [
    "diff --git a/src/sample.ts b/src/sample.ts",
    "--- a/src/sample.ts",
    "+++ b/src/sample.ts",
    "@@ -1,2 +1,2 @@",
    "-const a = 1;",
    "+const a = 2;",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  // Anchor to a line far outside any hunk: no overlap, and a hunk_header that
  // does not match. The excerpt must be omitted, not faked from the first hunk.
  const excerpt = renderHunkExcerpt(diff, { path: "src/sample.ts", hunk_header: "@@ -900,2 +900,2 @@", line_start: 950, line_end: 950 });
  assert.equal(excerpt, undefined, "a stale anchor must not render an unrelated hunk");
  // An item with NO anchor still falls back to the first changed hunk.
  const fallback = renderHunkExcerpt(diff, { path: "src/sample.ts" });
  assert.ok(fallback, "an unanchored item falls back to the first changed hunk");
});

// review-surfaces.HUMAN_REVIEW.20: when a stale hunk_header fails to match but a
// line anchor selects a real hunk, the rendered header names the SELECTED hunk,
// not the stale anchor header.
test("review-surfaces.HUMAN_REVIEW.20 renders the selected hunk's header, not a stale anchor header", () => {
  const diffText = [
    "diff --git a/src/two.ts b/src/two.ts",
    "--- a/src/two.ts",
    "+++ b/src/two.ts",
    "@@ -1,2 +1,2 @@",
    "-const a = 1;",
    "+const a = 2;",
    "@@ -10,2 +10,2 @@",
    "-const b = 1;",
    "+const b = 2;",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  // Stale header that matches no hunk, but a line anchor that overlaps the SECOND hunk.
  const excerpt = renderHunkExcerpt(diff, { path: "src/two.ts", hunk_header: "@@ -99,2 +99,2 @@", line_start: 10, line_end: 10 });
  assert.ok(excerpt, "line anchor should still select a hunk");
  assert.match(excerpt!, /@@ -10,2 \+10,2 @@/, "header must name the selected hunk");
  assert.doesNotMatch(excerpt!, /@@ -99,2 \+99,2 @@/, "the stale anchor header must not be shown");
  assert.match(excerpt!, /const b = 2;/, "body must come from the selected hunk");
});

// review-surfaces.HUMAN_REVIEW.20: a diff line containing a ``` fence must not
// prematurely close the excerpt's own fence.
test("review-surfaces.HUMAN_REVIEW.20 uses a fence that diff content cannot close", () => {
  const diffText = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,2 +1,2 @@",
    "-old text",
    "+```ts",
    " const x = 1;",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  const excerpt = renderHunkExcerpt(diff, { path: "README.md", hunk_header: "@@ -1,2 +1,2 @@", line_start: 1, line_end: 1 });
  assert.ok(excerpt, "excerpt should render");
  // The opening fence must be longer than the backtick run in the content.
  const opening = excerpt!.split("\n")[0];
  assert.ok(opening.startsWith("````"), `fence must be >=4 backticks, got: ${opening}`);
  assert.match(excerpt!, /```ts/, "the backtick content is preserved inside the longer fence");
});

// review-surfaces.HUMAN_REVIEW.20: a queue item anchored to a rename's old path
// windows on old-side line numbers.
test("review-surfaces.HUMAN_REVIEW.20 anchors rename excerpts on the old-side line", () => {
  const diffText = [
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
    "--- a/src/old-name.ts",
    "+++ b/src/new-name.ts",
    "@@ -10,3 +20,3 @@",
    " context",
    "-removed at old line 11",
    "+added at new line 21",
    ""
  ].join("\n");
  const diff = parseStructuredDiff(diffText);
  // Anchor to the OLD path and an old-side line number (11).
  const excerpt = renderHunkExcerpt(diff, { path: "src/old-name.ts", old_path: "src/old-name.ts", line_start: 11, line_end: 11 });
  assert.ok(excerpt, "excerpt should render for a rename anchored to the old path");
  assert.match(excerpt!, /removed at old line 11/);
});

// review-surfaces.HUMAN_REVIEW.21: no reviewer-facing line on the default human
// surface leads with an internal identifier as its subject.
test("review-surfaces.HUMAN_REVIEW.21 keeps internal identifiers out of the sentence subject", () => {
  const model = baseModel({
    verdict: {
      decision: "needs_author_clarification",
      confidence: "medium",
      reasons: [
        {
          id: "READY-MISSING-EVIDENCE",
          severity: "medium",
          summary: "Required review evidence is missing or claimed without proof.",
          evidence: [missingEvidence("No transcript")],
          required_action: "Record validation evidence."
        }
      ]
    },
    evidence_cards: [
      {
        id: "CARD-001",
        title: "Missing manual check",
        status: "missing_evidence",
        summary: "Missing manual review check for review-surfaces.BOOTSTRAP.1.",
        direct_evidence: [],
        missing_evidence: [missingEvidence("No evidence")],
        invalid_evidence: [],
        why_it_matters: "The check is required.",
        reviewer_action: "Ask the author to provide the evidence.",
        source_ids: [],
        risk_ids: [],
        requirement_ids: ["review-surfaces.BOOTSTRAP.1"],
        confidence: "medium",
        priority: "medium"
      }
    ],
    feedback_effects: [
      {
        id: "FB-001",
        kind: "false_positive",
        summary: "Downgraded a noisy finding.",
        action: "Lowered its review priority.",
        evidence: [fileEvidence("feedback/local.yaml")],
        paths: [],
        risk_ids: ["RISK-002"],
        confidence: "medium"
      }
    ]
  });
  const md = renderHumanReviewMarkdown(model);
  const offenders = reviewerFacingViolations(md);
  assert.deepEqual(offenders, [], `lines must not lead with an internal id: ${offenders.join(" | ")}`);
});

// Scan rendered markdown for reviewer-facing lines that lead with an internal
// id, skipping fenced code blocks (diff excerpts legitimately start with +/-/@@).
function reviewerFacingViolations(markdown: string): string[] {
  const offenders: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (leadsWithInternalId(line)) {
      offenders.push(line);
    }
  }
  return offenders;
}

// ---- rollup unit helpers --------------------------------------------------

test("normalizeAcidTemplate and extractAcids handle prefixed and bare ACIDs", () => {
  assert.deepEqual(extractAcids("close review-surfaces.HUMAN_TRUST.1 and BOOTSTRAP.4"), [
    "review-surfaces.HUMAN_TRUST.1",
    "BOOTSTRAP.4"
  ]);
  assert.equal(
    normalizeAcidTemplate("Add a test tied to review-surfaces.HUMAN_TRUST.1."),
    normalizeAcidTemplate("Add a test tied to review-surfaces.CLI.8.")
  );
});

test("fillAcidTemplate inlines a single ACID and pluralizes a group", () => {
  const template = normalizeAcidTemplate("Close review-surfaces.CLI.8 now.");
  assert.equal(fillAcidTemplate(template, ["review-surfaces.CLI.8"]), "Close review-surfaces.CLI.8 now.");
  assert.equal(fillAcidTemplate(template, ["a.B.1", "a.B.2"]), "Close the listed requirements now.");
});

test("fillAcidTemplate preserves prose between multiple ACID placeholders", () => {
  const template = normalizeAcidTemplate("Compare review-surfaces.A.1 to review-surfaces.B.2 carefully.");
  // Both placeholders are filled and the connecting prose ("to", "carefully") is kept.
  assert.equal(
    fillAcidTemplate(template, ["review-surfaces.A.1", "review-surfaces.B.2"]),
    "Compare the listed requirements to the listed requirements carefully."
  );
});

test("rollupBy groups by template key and unions ACIDs in first-seen order", () => {
  const items = [
    { key: "x", acid: "a.A.1" },
    { key: "y", acid: "a.B.1" },
    { key: "x", acid: "a.A.2" }
  ];
  const groups = rollupBy(items, (item) => item.key, (item) => [item.acid]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].acids, ["a.A.1", "a.A.2"]);
  assert.equal(groups[0].items.length, 2);
  assert.deepEqual(groups[1].acids, ["a.B.1"]);
});

test("leadsWithInternalId flags id-subject lines but not reviewer prose", () => {
  assert.ok(leadsWithInternalId("- CARD-001 [missing]: foo"));
  assert.ok(leadsWithInternalId("RISK-002: something"));
  assert.ok(leadsWithInternalId("### review-surfaces.HUMAN_TRUST.1 needs a test"));
  assert.ok(leadsWithInternalId("READY-MISSING-EVIDENCE [medium]: x"));
  assert.ok(!leadsWithInternalId("- Missing manual review check for the listed requirements."));
  assert.ok(!leadsWithInternalId("1. What evidence closes the requirement?"));
  assert.ok(!leadsWithInternalId("Changed implementation file in src/cli."));
});

// review-surfaces.PRIVACY.6 — resolveStructuredExcerpt (the cockpit/gutter path)
// redacts each line AND can now propagate the high-confidence block signal, at
// API parity with renderHunkExcerpt. Before, it dropped the signal on the floor.
test("review-surfaces.PRIVACY.6 resolveStructuredExcerpt redacts excerpt lines and raises the block signal", () => {
  const token = `ghp_${"D".repeat(36)}`;
  const diff = parseStructuredDiff([
    "diff --git a/src/cfg.ts b/src/cfg.ts",
    "--- a/src/cfg.ts",
    "+++ b/src/cfg.ts",
    "@@ -1,2 +1,2 @@",
    " const a = 1;",
    '-const token = "old";',
    `+const token = "${token}";`,
    ""
  ].join("\n"));
  const state = { blocked: false };
  const excerpt = resolveStructuredExcerpt(diff, { path: "src/cfg.ts", line_start: 2, line_end: 2 }, DEFAULT_HUNK_EXCERPT_MAX_LINES, state);
  assert.ok(excerpt, "an excerpt resolves for the anchored hunk");
  const body = excerpt!.lines.map((line) => line.text).join("\n");
  assert.ok(!body.includes(token), "the raw github token must not survive into the excerpt");
  assert.match(body, /\[REDACTED:github_token\]/, "the excerpt line keeps its redaction marker");
  assert.equal(state.blocked, true, "the secret raises the block signal through resolveStructuredExcerpt");
});

// review-surfaces.PRIVACY.6 — the persisted HTML cockpit wires the excerpt
// redaction-block signal through to a visible, greppable notice, so the signal
// is no longer dropped for human_review.html.
test("review-surfaces.PRIVACY.6 the HTML cockpit surfaces the excerpt redaction-block signal", () => {
  const token = `ghp_${"E".repeat(36)}`;
  const secretDiff = parseStructuredDiff([
    "diff --git a/src/cfg.ts b/src/cfg.ts",
    "--- a/src/cfg.ts",
    "+++ b/src/cfg.ts",
    "@@ -1,2 +1,2 @@",
    " const a = 1;",
    '-const token = "old";',
    `+const token = "${token}";`,
    ""
  ].join("\n"));
  const queueItem: ReviewQueueItem = {
    id: "REVIEW-001", rank: 1, title: "Changed config", path: "src/cfg.ts",
    hunk_header: "@@ -1,2 +1,2 @@", line_start: 2, line_end: 2,
    reviewer_action: "Inspect.", reason: "Changes a token.",
    evidence: [fileEvidence("src/cfg.ts")], requirement_ids: [], risk_ids: [],
    ranking_reasons: [], confidence: "high", priority: "high"
  };
  const html = renderHumanReviewHtml(baseModel({ review_queue: [queueItem] }), { diff: secretDiff });
  assert.ok(!html.includes(token), "the raw token must not survive into the persisted cockpit");
  assert.match(html, /\[REDACTED:github_token\]/, "the cockpit excerpt is redacted");
  assert.match(html, /data-excerpt-redaction="blocked"/, "the cockpit surfaces the redaction-block signal");

  const cleanDiff = parseStructuredDiff([
    "diff --git a/src/cfg.ts b/src/cfg.ts",
    "--- a/src/cfg.ts",
    "+++ b/src/cfg.ts",
    "@@ -1,2 +1,2 @@",
    " const a = 1;",
    "-const x = 2;",
    "+const x = 3;",
    ""
  ].join("\n"));
  const cleanHtml = renderHumanReviewHtml(baseModel({ review_queue: [queueItem] }), { diff: cleanDiff });
  assert.doesNotMatch(cleanHtml, /data-excerpt-redaction="blocked"/, "no secret => no redaction notice (byte-stable)");
});

// review-surfaces.PRIVACY.6 — the cockpit block signal must also cover blocked
// secrets that reach esc()'d MODEL fields (summary, narrative, reasons, cards),
// not only diff excerpts.
test("review-surfaces.PRIVACY.6 the HTML cockpit surfaces a blocked secret in a model field too", () => {
  const token = `ghp_${"F".repeat(36)}`;
  const html = renderHumanReviewHtml(baseModel({ summary: `Audit: key ${token} was committed.` }), {});
  assert.ok(!html.includes(token), "the model-summary secret must be redacted out of the cockpit");
  assert.match(html, /\[REDACTED:github_token\]/, "the summary keeps its redaction marker");
  assert.match(html, /data-excerpt-redaction="blocked"/, "the block signal is surfaced for a model-field secret, not just excerpts");
});
