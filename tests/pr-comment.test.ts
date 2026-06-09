import test from "node:test";
import assert from "node:assert/strict";
import { HUMAN_REVIEW_SCHEMA_VERSION } from "../src/human/contract";
import type { HumanReviewModel } from "../src/human/contract";
import { renderHumanPrComment, renderPrComment } from "../src/render/pr-comment";
import { PrReviewSurfaceModel, PR_SURFACE_SCHEMA_VERSION } from "../src/pr/contract";

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
    evidence_cards: [],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      pr_surface_path: ".review-surfaces/pr_review_surface.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "head"
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
  assert.match(md, /```mermaid\nflowchart LR/);
  // The mermaid block only renders on GitHub when a BLANK LINE separates the
  // <details> raw-HTML opener from the ```mermaid fence (otherwise the fence is
  // absorbed as raw HTML). A prior `.filter(line => line !== "")` stripped it.
  assert.match(md, /<details><summary>Change impact diagram<\/summary>\n\n```mermaid/);
  // Section headings keep their preceding blank line (valid Markdown spacing).
  assert.match(md, /\n\n### What changed/);
  assert.match(md, /\n\n### Change impact/);
  // It must NOT contain the whole-spec coverage dump or the boilerplate focus.
  assert.doesNotMatch(md, /\d+ satisfied, \d+ partial, \d+ missing/);
  assert.doesNotMatch(md, /Start with missing and partial requirement results/);
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
  });
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

test("renderHumanPrComment is byte-deterministic for the same model", () => {
  const model = humanModel();
  assert.equal(renderHumanPrComment(model), renderHumanPrComment(model));
});

test("renderHumanPrComment caps suggested comments after filtering ready drafts", () => {
  const model = humanModel();
  model.suggested_comments = [
    { ...model.suggested_comments[0], id: "SC-NOT-READY-001", body: "not ready 1", ready_to_post: false },
    { ...model.suggested_comments[0], id: "SC-NOT-READY-002", body: "not ready 2", ready_to_post: false },
    { ...model.suggested_comments[0], id: "SC-NOT-READY-003", body: "not ready 3", ready_to_post: false },
    { ...model.suggested_comments[0], id: "SC-READY-001", body: "ready after non-ready drafts", ready_to_post: true }
  ];
  const md = renderHumanPrComment(model);
  assert.match(md, /ready after non-ready drafts/);
  assert.doesNotMatch(md, /No ready suggested comments generated/);
  assert.doesNotMatch(md, /not ready 1/);
});
