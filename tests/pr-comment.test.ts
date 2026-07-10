import test from "node:test";
import assert from "node:assert/strict";
import { HUMAN_REVIEW_SCHEMA_VERSION } from "../src/human/contract";
import type { HumanReviewModel } from "../src/human/contract";
import { renderHumanPrComment, renderPrComment } from "../src/render/pr-comment";
import { PrReviewSurfaceModel, PR_SURFACE_SCHEMA_VERSION } from "../src/pr/contract";
import { notAssessedConversationAnalysis } from "../src/conversation/analysis";

function baseScope(): PrReviewSurfaceModel["scope"] {
  return {
    base_ref: "origin/main",
    head_ref: "HEAD",
    head_sha: "head",
    diff_source: "range",
    changed_files: [{ path: "src/render/comment.ts", status: "modified", areas: ["RENDER"], role: "implementation" }],
    affected_areas: [{ group_key: "RENDER", area_ids: ["render"], name: "Packet renderer", changed_files: ["src/render/comment.ts"] }],
    affected_requirements: [{ requirement_id: "x.RENDER.3", acai_id: "x.RENDER.3", title: "PR comment", group_key: "RENDER", reasons: [] }],
    out_of_scope_changed_files: []
  };
}

function readySurface(): PrReviewSurfaceModel {
  return {
    schema_version: PR_SURFACE_SCHEMA_VERSION,
    mode: "pr",
    spec_mode: "acai",
    status: "ready",
    scope: baseScope(),
    coverage: {
      base_available: true,
      summary: "1 in scope",
      in_scope_count: 1,
      deltas: [
        {
          requirement_id: "x.RENDER.3",
          acai_id: "x.RENDER.3",
          base_status: "partial",
          head_status: "satisfied",
          delta: "improved",
          reasons: ["base partial -> head satisfied"],
          head_evidence: [],
          missing_evidence: []
        }
      ],
      counts: { improved: 1, regressed: 0, unchanged: 0, new_requirement: 0, removed_requirement: 0, newly_in_scope: 0 }
    },
    risks: {
      summary: "1 PR risk",
      candidates: [
        { id: "PR-RISK-001", rule: "comment_surface_change", category: "maintainability", severity: "medium", summary: "comment renderer changed", evidence: [], suggested_checks: ["verify output"] }
      ]
    },
    diagram: { path: "diagrams/pr-change-impact.mmd", status: "valid", body: "flowchart LR\n  F0[\"src/render/comment.ts\"] --> R0[\"x.RENDER.3\"]", warnings: [] },
    narrative: {
      summary: "Reworks the comment renderer.",
      what_changed: [{ text: "Rewrote the sticky comment renderer", paths: ["src/render/comment.ts"] }],
      why_it_matters: [{ text: "RENDER.3 coverage improves", requirement_ids: ["x.RENDER.3"] }],
      review_first: [{ text: "Check the new rendering path", paths: ["src/render/comment.ts"] }],
      risk_narratives: [{ risk_id: "PR-RISK-001", text: "Confirm the comment output is unchanged for healthy packets" }]
    },
    llm: { required: true, provider: "agent-file", status: "applied" }
  };
}

function humanModel(): HumanReviewModel {
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: "pr",
    spec_mode: "acai",
    narrative: { source: "fallback", provider: "mock", validated_at_head: "abc", claims: [] },
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    change_graph: { nodes: [], halo_nodes: [], edges: [], clusters: [], overview: { groups: [], halo_count: 0, edges: [] } },
    reading_order: { legs: [] },
    verdict: {
      decision: "needs_author_clarification",
      confidence: "medium",
      reasons: [
        {
          id: "READY-001",
          severity: "medium",
          summary: "Schema compatibility evidence is missing.",
          evidence: [{ kind: "file", path: "schemas/human_review.schema.json", confidence: "medium" }],
          required_action: "Add or cite a compatibility fixture."
        }
      ]
    },
    summary: "The PR is reviewable, but approval should wait for a schema compatibility answer.",
    conversation_analysis: notAssessedConversationAnalysis("mock"),
    review_insights: [],
    review_queue: [
      {
        id: "REVIEW-001",
        rank: 1,
        title: "Schema contract change",
        path: "schemas/human_review.schema.json",
        line_start: 71,
        line_end: 98,
        reviewer_action: "Confirm compatibility or versioning.",
        reason: "Public human review contract changed.",
        evidence: [{ kind: "file", path: "schemas/human_review.schema.json", confidence: "medium" }],
        requirement_ids: ["review-surfaces.HUMAN_REVIEW.9"],
        risk_ids: ["PR-RISK-001"],
        ranking_reasons: [],
        confidence: "high",
        priority: "high"
      }
    ],
    blockers: [
      {
        id: "BLOCK-001",
        severity: "medium",
        summary: "Compatibility fixture missing.",
        evidence: [{ kind: "file", path: "schemas/human_review.schema.json", confidence: "medium" }],
        required_action: "Add fixture coverage before merge."
      }
    ],
    questions: [
      {
        id: "QUESTION-001",
        severity: "blocking",
        question: "Is the human review schema change additive-only?",
        reason: "Schema contract changed.",
        evidence: [{ kind: "file", path: "schemas/human_review.schema.json", confidence: "medium" }],
        maps_to_risks: ["PR-RISK-001"],
        maps_to_requirements: ["review-surfaces.HUMAN_REVIEW.9"]
      }
    ],
    suggested_comments: [
      {
        id: "SC-001",
        severity: "blocking",
        path: "schemas/human_review.schema.json",
        body: "Can you add a compatibility fixture for an existing human_review.json artifact?",
        evidence: [{ kind: "file", path: "schemas/human_review.schema.json", confidence: "medium" }],
        risk_ids: ["PR-RISK-001"],
        requirement_ids: ["review-surfaces.HUMAN_REVIEW.9"],
        confidence: "medium",
        ready_to_post: true
      }
    ],
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [],
      invalid_evidence: [],
      confidence_summary: "Medium confidence."
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
      pr_surface_path: ".review-surfaces/pr_review_surface.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "head",
      uncommitted_files: 0
    }
  };
}

test("renderPrComment renders a PR-SPECIFIC surface (what changed / coverage delta / risks / diagram), not a whole-spec dump", () => {
  const md = renderPrComment(readySurface());
  assert.match(md, /review-surfaces:sticky/);
  assert.match(md, /## review-surfaces PR review/);
  assert.match(md, /### What changed/);
  assert.match(md, /Rewrote the sticky comment renderer.*src\/render\/comment\.ts/s);
  assert.match(md, /### Why it matters/);
  assert.match(md, /### Review first/);
  assert.match(md, /### Affected coverage/);
  assert.match(md, /x\.RENDER\.3: partial -> satisfied \(improved\)/);
  assert.match(md, /### PR risks/);
  assert.match(md, /PR-RISK-001 \[medium\]/);
  // review-surfaces.CHANGE_MAP.3: the requirements-hairball "Change impact"
  // embed is retired from the narrative path; pr-change-impact.mmd remains a
  // standalone agent-facing artifact off the human surfaces.
  assert.doesNotMatch(md, /### Change impact/);
  assert.doesNotMatch(md, /```mermaid/);
  // Section headings keep their preceding blank line (valid Markdown spacing).
  assert.match(md, /\n\n### What changed/);
  // It must NOT contain the whole-spec coverage dump or the boilerplate focus.
  assert.doesNotMatch(md, /\d+ satisfied, \d+ partial, \d+ missing/);
  assert.doesNotMatch(md, /Start with missing and partial requirement results/);
});

test("review-surfaces.CONVERSATION_REVIEW.4 lower-level PR fallback still renders conversation reviewer value", () => {
  const surface = readySurface();
  surface.conversation_analysis = {
    ...notAssessedConversationAnalysis("ai-sdk"),
    status: "analyzed",
    summary: "The final request keeps the sticky marker stable.",
    intent: [{ text: "Keep the sticky marker stable.", event_ids: ["evt-final"] }],
    quality_flags: []
  };
  surface.review_insights = [{
    id: "CONV-INSIGHT-001",
    category: "intent_mismatch",
    title: "Sticky marker changed",
    summary: "The diff changes the marker the final request retained.",
    why_it_matters: "The update workflow may stop finding its existing comment.",
    reviewer_action: "Compare the marker with the final conversation constraint.",
    priority: "high",
    evidence_state: "contradicted",
    basis: "validated_anchors",
    conversation_event_ids: ["evt-final"],
    paths: ["src/render/comment.ts"],
    requirement_ids: [],
    risk_ids: [],
    command_ids: [],
    evidence: [{
      kind: "diff",
      path: "src/render/comment.ts",
      line_start: 42,
      line_end: 42,
      confidence: "high",
      validation_status: "valid",
      llm_proposed: true
    }]
  }, {
    id: "CONV-INSIGHT-002",
    category: "validation_gap",
    title: "Marker migration is unverified",
    summary: "The conversation does not establish a migration path.",
    why_it_matters: "Existing comments may need an explicit compatibility check.",
    reviewer_action: "Verify the update path against an existing comment.",
    priority: "medium",
    evidence_state: "unverified",
    basis: "ai_reconciliation",
    conversation_event_ids: ["evt-final"],
    paths: ["src/render/comment.ts"],
    requirement_ids: [],
    risk_ids: [],
    command_ids: [],
    evidence: []
  }];

  const md = renderPrComment(surface);

  assert.ok(md.indexOf("### Conversation-aware insights") < md.indexOf("### What changed"));
  const topIdx = md.indexOf("Sticky marker changed");
  const detailsIdx = md.indexOf("<summary>Conversation context, grounding and 1 more insight</summary>");
  assert.ok(topIdx > -1 && topIdx < detailsIdx, "the top insight renders before the disclosure");
  assert.ok(md.indexOf("Marker migration is unverified") > detailsIdx, "the remaining insight stays accessible");
  assert.ok(md.indexOf("Stated goal") > detailsIdx, "conversation context moves into the disclosure");
  assert.match(md, /Stated goal.*Keep the sticky marker stable/);
  assert.match(md, /Why it matters: The update workflow may stop finding its existing comment/);
  assert.match(md, /diff `src\/render\/comment\.ts:L42`/);
});

test("renderPrComment shows a clear blocked message (no whole-repo fallback) when the narrative is unavailable", () => {
  const blocked: PrReviewSurfaceModel = { ...readySurface(), status: "blocked", blocked_reason: "llm_unavailable", narrative: undefined, llm: { required: true, provider: "mock", status: "blocked" } };
  const md = renderPrComment(blocked);
  assert.match(md, /\*\*Status:\*\* blocked \(`llm_unavailable`\)/);
  assert.match(md, /requires an LLM provider/i);
  // Still PR-specific: reports the deterministic scope counts for this diff.
  assert.match(md, /1 changed file\(s\), 1 affected requirement\(s\), 1 PR risk\(s\)/);
  // Never the generic sections.
  assert.doesNotMatch(md, /### What changed/);
  assert.doesNotMatch(md, /Top review focus/);
});

test("renderPrComment distinguishes a runtime LLM FAILURE from a missing provider", () => {
  const failed: PrReviewSurfaceModel = {
    ...readySurface(),
    status: "blocked",
    blocked_reason: "llm_failed",
    narrative: undefined,
    llm: { required: true, provider: "ai-sdk", status: "failed", validation_errors: ["ai_sdk_error: request timed out"] }
  };
  const md = renderPrComment(failed);
  assert.match(md, /\*\*Status:\*\* blocked \(`llm_failed`\)/);
  assert.match(md, /failed at runtime/i);
  // Must NOT misdiagnose a runtime failure as a missing/unconfigured key.
  assert.doesNotMatch(md, /configured key/i);
});

test("renderPrComment points the 'Full PR surface' link at the ACTUAL surface path (honors --out)", () => {
  const md = renderPrComment(readySurface(), { surfacePath: "custom-out/pr_review_surface.json" });
  assert.match(md, /Full PR surface: `custom-out\/pr_review_surface\.json`/);
  assert.doesNotMatch(md, /\.review-surfaces\/pr_review_surface\.json/);
});

test("renderPrComment blocked message points at the actual surface path too", () => {
  const blocked: PrReviewSurfaceModel = { ...readySurface(), status: "blocked", blocked_reason: "llm_unavailable", narrative: undefined, llm: { required: true, provider: "mock", status: "blocked" } };
  const md = renderPrComment(blocked, { surfacePath: "custom-out/pr_review_surface.json" });
  assert.match(md, /See `custom-out\/pr_review_surface\.json`/);
  assert.doesNotMatch(md, /\.review-surfaces\/pr_review_surface\.json/);
});

test("renderPrComment is byte-deterministic for the same surface", () => {
  const surface = readySurface();
  assert.equal(renderPrComment(surface), renderPrComment(surface));
});

test("renderHumanPrComment renders the compact PR comment from human_review.json model", () => {
  const md = renderHumanPrComment(humanModel(), {
    humanReviewPath: "custom-out/human_review.md",
    humanReviewJsonPath: "custom-out/human_review.json",
    surfacePath: "custom-out/pr_review_surface.json"
  }).markdown;
  assert.match(md, /review-surfaces:sticky/);
  assert.match(md, /## review-surfaces PR review/);
  assert.match(md, /\*\*Verdict:\*\* Needs author clarification\./);
  assert.match(md, /### Review first/);
  assert.match(md, /`schemas\/human_review\.schema\.json:71-98` - Schema contract change/);
  assert.match(md, /### Blockers/);
  assert.match(md, /Compatibility fixture missing/);
  assert.match(md, /### Questions/);
  assert.match(md, /Is the human review schema change additive-only/);
  assert.match(md, /### Suggested comments/);
  assert.match(md, /Can you add a compatibility fixture/);
  assert.match(md, /Full human review: `custom-out\/human_review\.md`/);
  assert.match(md, /Human review JSON: `custom-out\/human_review\.json`/);
  assert.match(md, /Lower-level PR facts: `custom-out\/pr_review_surface\.json`/);
  assert.doesNotMatch(md, /### Affected coverage/);
  assert.doesNotMatch(md, /### What changed/);
});

test("renderHumanPrComment puts conversation-aware reviewer value before the queue", () => {
  const review = humanModel();
  review.conversation_analysis = {
    ...notAssessedConversationAnalysis("ai-sdk"),
    status: "analyzed",
    summary: "The final conversation narrowed the compatibility promise.",
    intent: [{ text: "Keep compatibility narrow.", event_ids: ["evt-final"] }],
    quality_flags: []
  };
  review.review_insights = [{
    id: "CONV-INSIGHT-001",
    category: "scope_surprise",
    title: "Compatibility scope expanded",
    summary: "The diff broadens a contract the conversation explicitly narrowed.",
    why_it_matters: "Reviewers need to confirm the wider compatibility burden.",
    reviewer_action: "Compare the schema change with the final author refinement.",
    priority: "high",
    evidence_state: "contradicted",
    basis: "validated_anchors",
    conversation_event_ids: ["evt-final"],
    paths: ["schemas/human_review.schema.json"],
    requirement_ids: [],
    risk_ids: [],
    command_ids: [],
    evidence: []
  }, {
    id: "CONV-INSIGHT-002",
    category: "validation_gap",
    title: "Compatibility proof is missing",
    summary: "The final scope has no focused compatibility transcript.",
    why_it_matters: "The reviewer cannot confirm the narrowed promise.",
    reviewer_action: "Run the focused compatibility check.",
    priority: "medium",
    evidence_state: "unverified",
    basis: "ai_reconciliation",
    conversation_event_ids: ["evt-final"],
    paths: ["schemas/human_review.schema.json"],
    requirement_ids: [],
    risk_ids: [],
    command_ids: [],
    evidence: []
  }];

  const md = renderHumanPrComment(review).markdown;
  assert.ok(md.indexOf("### Conversation-aware insights") < md.indexOf("### Review first"));
  const topIdx = md.indexOf("Compatibility scope expanded");
  const detailsIdx = md.indexOf("<summary>Conversation context, grounding and 1 more insight</summary>");
  assert.ok(topIdx > -1 && topIdx < detailsIdx, "the human PR comment leads with the top insight");
  assert.ok(md.indexOf("Compatibility proof is missing") > detailsIdx, "the second insight remains accessible");
  assert.ok(md.indexOf("Stated goal") > detailsIdx, "fuller conversation context remains accessible");
  assert.match(md, /\[Conflicts with intent · high\] Compatibility scope expanded/);
  assert.match(md, /Why it matters: Reviewers need to confirm the wider compatibility burden/);
  assert.match(md, /events `evt-final`; paths `schemas\/human_review\.schema\.json`/);
  assert.equal(review.verdict.decision, "needs_author_clarification");
});

test("renderHumanPrComment is byte-deterministic for the same model", () => {
  const model = humanModel();
  assert.deepEqual(renderHumanPrComment(model), renderHumanPrComment(model));
});

test("renderHumanPrComment caps suggested comments after filtering ready drafts", () => {
  const model = humanModel();
  model.suggested_comments = [
    { ...model.suggested_comments[0], id: "SC-NOT-READY-001", body: "not ready 1", ready_to_post: false },
    { ...model.suggested_comments[0], id: "SC-NOT-READY-002", body: "not ready 2", ready_to_post: false },
    { ...model.suggested_comments[0], id: "SC-NOT-READY-003", body: "not ready 3", ready_to_post: false },
    { ...model.suggested_comments[0], id: "SC-READY-001", body: "ready after non-ready drafts", ready_to_post: true }
  ];
  const md = renderHumanPrComment(model).markdown;
  assert.match(md, /ready after non-ready drafts/);
  assert.doesNotMatch(md, /No ready suggested comments generated/);
  assert.doesNotMatch(md, /not ready 1/);
});
