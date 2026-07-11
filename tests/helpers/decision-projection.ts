import type { PrReviewSurfaceModel, PrRiskCandidate } from "../../src/contracts/pr-review";
import { PR_SURFACE_SCHEMA_VERSION } from "../../src/contracts/pr-review";
import { fileEvidence } from "../../src/evidence/evidence";
import type { SemanticChangeFacts } from "../../src/risks/semantic-diff";
import type { ReviewPacket } from "../../src/render/packet";
import { minimalReviewPacket } from "./review-packet";

export function requirement(id: string, acid = `review-surfaces.${id}.1`) {
  return {
    id,
    acai_id: acid,
    title: id,
    requirement: `Deliver the reviewer outcome for ${id}.`,
    source_refs: [], constraints: [], assumptions: [], open_questions: [], confidence: "high" as const
  };
}

export function decisionPacket(): ReviewPacket {
  const value = minimalReviewPacket() as unknown as ReviewPacket;
  value.manifest = { ...value.manifest, base_sha: "base", head_sha: "head" };
  value.intent = {
    summary: "Make the review immediately useful to an approver.", spec_mode: "acai",
    requirements: [requirement("REQ-DECISION", "review-surfaces.REVIEWER_VALUE.4")],
    constraints: [], non_goals: [], assumptions: [], open_questions: [], sources: []
  };
  value.risks = {
    summary: "No packet-wide risks.", items: [],
    test_evidence: [{
      id: "TEST-PASS", kind: "direct", summary: "Focused validation passed.",
      evidence: [{ kind: "command", command: "pnpm test", sha: "head", confidence: "high", validation_status: "valid" }]
    }],
    test_gaps: [], missing_automatic_tests: [], missing_manual_checks: [], review_focus: []
  };
  return value;
}

export function decisionSurface(paths: string[], risks: PrRiskCandidate[] = [], affected = true): PrReviewSurfaceModel {
  return {
    schema_version: PR_SURFACE_SCHEMA_VERSION, mode: "pr", spec_mode: "acai", status: "ready",
    scope: {
      base_ref: "origin/main", base_sha: "base", head_ref: "HEAD", head_sha: "head", diff_source: "range",
      changed_files: paths.map((path) => ({ path, status: "M", areas: ["REVIEWER_VALUE"], role: "implementation" })),
      affected_areas: [],
      affected_requirements: affected ? [{
        requirement_id: "REQ-DECISION", acai_id: "review-surfaces.REVIEWER_VALUE.4", title: "Decision-first review",
        group_key: "REVIEWER_VALUE", reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: paths[0] }]
      }] : [],
      out_of_scope_changed_files: []
    },
    coverage: {
      base_available: true, summary: "Scoped coverage is available.", in_scope_count: affected ? 1 : 0, deltas: [],
      counts: { improved: 0, regressed: 0, unchanged: 0, new_requirement: 0, removed_requirement: 0, newly_in_scope: 0 }
    },
    risks: { summary: `${risks.length} scoped risks.`, candidates: risks },
    llm: { required: true, provider: "mock", status: "blocked" }
  };
}

export function decisionRisk(
  id: string,
  rule: PrRiskCandidate["rule"],
  path: string,
  severity: PrRiskCandidate["severity"] = "high"
): PrRiskCandidate {
  return {
    id, rule, category: rule.includes("test") || rule.includes("coverage") ? "testing" : "architecture", severity,
    summary: `${rule} affects ${path}.`, evidence: [fileEvidence(path, `${rule} changed in the reviewed range.`)],
    suggested_checks: [`Resolve ${rule} before approval.`]
  };
}

export const emptyDecisionSemanticFacts: SemanticChangeFacts = { schema_changes: [], api_changes: [], test_weakening: [] };
