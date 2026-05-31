import test from "node:test";
import assert from "node:assert/strict";
import { renderPrComment } from "../src/render/pr-comment";
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

test("renderPrComment is byte-deterministic for the same surface", () => {
  const surface = readySurface();
  assert.equal(renderPrComment(surface), renderPrComment(surface));
});
