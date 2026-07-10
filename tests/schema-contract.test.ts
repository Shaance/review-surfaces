import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REQUIREMENT_STATUSES } from "../src/evaluation/status";
import { validateJsonSchema } from "../src/schema/json-schema";
import {
  PACKET_COMPARISON_DIRECTIONS,
  PACKET_CONFIDENCE_LEVELS,
  PACKET_DIAGRAM_STATUSES,
  PACKET_DIAGRAM_TYPES,
  PACKET_DOGFOOD_CATEGORIES,
  PACKET_DOGFOOD_SEVERITIES,
  PACKET_EVIDENCE_KINDS,
  PACKET_HELPFULNESS_VALUES,
  PACKET_PARTIAL_REASONS,
  PACKET_REMEDIATION_TYPES,
  PACKET_REQUIREMENT_STATUSES,
  PACKET_RISK_CATEGORIES,
  PACKET_RISK_DETECTABILITY,
  PACKET_RISK_LIKELIHOODS,
  PACKET_RISK_SEVERITIES,
  PACKET_RUN_MODES,
  PACKET_SCHEMA_VERSION,
  PACKET_SOURCE_KINDS,
  PACKET_TEST_EVIDENCE_KINDS,
  PACKET_TESTED_HOW,
  PACKET_VALIDATION_STATUSES,
  PACKET_WORKFLOW_SIGNAL_KINDS
} from "../src/schema/review-packet-contract";
import { RISK_LENSES } from "../src/human/contract";
import { PR_SURFACE_SCHEMA_VERSION } from "../src/pr/contract";
import {
  MAX_VISIBLE_CONVERSATION_INSIGHTS,
  REVIEWER_INSIGHT_EVIDENCE_STATES
} from "../src/conversation/review";
import { VERSION } from "../src/core/version";
import { fullyPopulatedReviewPacket, minimalReviewPacket } from "./helpers/review-packet";

const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "review_packet.schema.json"), "utf8"));
const humanReviewSchema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));
const prSurfaceSchema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "pr_review_surface.schema.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };

// The current writer emits these defaults even where the v1 read schema keeps a
// field optional for backward compatibility. Slice fixtures start complete so
// each schema test remains focused on its one mutation.
const HUMAN_REQUIRED_DEFAULTS = {
  narrative: { source: "fallback", provider: "mock", validated_at_head: "abc", claims: [] },
  conversation_analysis: {
    status: "not_assessed",
    provider: "mock",
    summary: "No conversation log was supplied; conversation intent was not assessed.",
    intent: [],
    refinements: [],
    decisions: [],
    constraints: [],
    non_goals: [],
    rejected_alternatives: [],
    claims: [],
    validation_claims: [],
    known_gaps: [],
    quality_flags: ["conversation_log_missing"]
  },
  review_insights: [],
  semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
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
  change_graph: { nodes: [], halo_nodes: [], edges: [], clusters: [], overview: { groups: [], halo_count: 0, edges: [] } },
  reading_order: { legs: [] },
  evidence_cards: [],
  feedback_effects: []
};

function withRequiredHumanFields<T extends Record<string, unknown>>(model: T): T & typeof HUMAN_REQUIRED_DEFAULTS {
  return { ...HUMAN_REQUIRED_DEFAULTS, ...model };
}

const enumContracts: Array<{
  name: string;
  path: string[];
  values: readonly string[];
}> = [
  {
    name: "manifest run_mode",
    path: ["$defs", "RunManifest", "properties", "run_mode", "enum"],
    values: PACKET_RUN_MODES
  },
  {
    name: "evidence kind",
    path: ["$defs", "EvidenceRef", "properties", "kind", "enum"],
    values: PACKET_EVIDENCE_KINDS
  },
  {
    name: "evidence confidence",
    path: ["$defs", "EvidenceRef", "properties", "confidence", "enum"],
    values: PACKET_CONFIDENCE_LEVELS
  },
  {
    name: "evidence validation_status",
    path: ["$defs", "EvidenceRef", "properties", "validation_status", "enum"],
    values: PACKET_VALIDATION_STATUSES
  },
  {
    name: "source kind",
    path: ["$defs", "SourceRef", "properties", "kind", "enum"],
    values: PACKET_SOURCE_KINDS
  },
  {
    name: "requirement confidence",
    path: ["$defs", "Requirement", "properties", "confidence", "enum"],
    values: PACKET_CONFIDENCE_LEVELS
  },
  {
    name: "requirement result status",
    path: ["$defs", "RequirementResult", "properties", "status", "enum"],
    values: PACKET_REQUIREMENT_STATUSES
  },
  {
    name: "requirement result partial_reason",
    path: ["$defs", "RequirementResult", "properties", "partial_reason", "enum"],
    values: PACKET_PARTIAL_REASONS
  },
  {
    name: "requirement result confidence",
    path: ["$defs", "RequirementResult", "properties", "confidence", "enum"],
    values: PACKET_CONFIDENCE_LEVELS
  },
  {
    name: "diagram validation status",
    path: ["$defs", "DiagramValidation", "properties", "status", "enum"],
    values: PACKET_DIAGRAM_STATUSES
  },
  {
    name: "diagram validation type",
    path: ["$defs", "DiagramValidation", "properties", "diagram_type", "enum"],
    values: PACKET_DIAGRAM_TYPES
  },
  {
    name: "risk category",
    path: ["$defs", "RiskItem", "properties", "category", "enum"],
    values: PACKET_RISK_CATEGORIES
  },
  {
    name: "risk severity",
    path: ["$defs", "RiskItem", "properties", "severity", "enum"],
    values: PACKET_RISK_SEVERITIES
  },
  {
    name: "risk likelihood",
    path: ["$defs", "RiskItem", "properties", "likelihood", "enum"],
    values: PACKET_RISK_LIKELIHOODS
  },
  {
    name: "risk detectability",
    path: ["$defs", "RiskItem", "properties", "detectability", "enum"],
    values: PACKET_RISK_DETECTABILITY
  },
  {
    name: "test evidence kind",
    path: ["$defs", "TestEvidence", "properties", "kind", "enum"],
    values: PACKET_TEST_EVIDENCE_KINDS
  },
  {
    name: "remediation type",
    path: ["$defs", "RemediationTask", "properties", "type", "enum"],
    values: PACKET_REMEDIATION_TYPES
  },
  {
    name: "dogfood finding category",
    path: ["$defs", "DogfoodFinding", "properties", "category", "enum"],
    values: PACKET_DOGFOOD_CATEGORIES
  },
  {
    name: "dogfood finding severity",
    path: ["$defs", "DogfoodFinding", "properties", "severity", "enum"],
    values: PACKET_DOGFOOD_SEVERITIES
  },
  {
    name: "packet comparison direction",
    path: ["$defs", "StatusChange", "properties", "direction", "enum"],
    values: PACKET_COMPARISON_DIRECTIONS
  },
  {
    name: "dogfood helped_agent",
    path: ["$defs", "Dogfood", "properties", "helped_agent", "enum"],
    values: PACKET_HELPFULNESS_VALUES
  },
  {
    name: "dogfood helped_reviewer",
    path: ["$defs", "Dogfood", "properties", "helped_reviewer", "enum"],
    values: PACKET_HELPFULNESS_VALUES
  },
  {
    name: "workflow finding signal_kind",
    path: ["$defs", "WorkflowFinding", "properties", "signal_kind", "enum"],
    values: PACKET_WORKFLOW_SIGNAL_KINDS
  },
  {
    name: "test gap tested_how",
    path: ["$defs", "TestGap", "properties", "tested_how", "enum"],
    values: PACKET_TESTED_HOW
  },
  {
    name: "missing automatic test tested_how",
    path: ["$defs", "MissingAutomaticTest", "properties", "tested_how", "enum"],
    values: PACKET_TESTED_HOW
  },
  {
    name: "missing manual check tested_how",
    path: ["$defs", "MissingManualCheck", "properties", "tested_how", "enum"],
    values: PACKET_TESTED_HOW
  }
];

test("review packet schema_version matches the runtime contract constant", () => {
  assert.equal(schemaAt(schema, ["properties", "schema_version", "const"]), PACKET_SCHEMA_VERSION);
});

test("counted requirement statuses are the packet statuses except overreach", () => {
  assert.deepEqual(REQUIREMENT_STATUSES, PACKET_REQUIREMENT_STATUSES.filter((status) => status !== "overreach"));
});

for (const contract of enumContracts) {
  test(`review packet schema enum matches runtime contract: ${contract.name}`, () => {
    assert.deepEqual(schemaAt(schema, contract.path), [...contract.values]);
  });
}

test("shared minimal review packet fixture stays schema-valid", () => {
  const result = validateJsonSchema(schema, minimalReviewPacket());
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

// R7 schema parity: the minimal fixture leaves every optional/array field empty,
// so a fully-populated packet (one element in EVERY array/optional field across
// all $defs, including the dogfood + agent_handoff conditional sections) is the
// only fixture that exercises every $def branch against the schema.
test("fully-populated review packet exercising every optional field stays schema-valid", () => {
  const result = validateJsonSchema(schema, fullyPopulatedReviewPacket());
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("a review packet with the wrong schema_version fails schema validation", () => {
  const bad = { ...minimalReviewPacket(), schema_version: "review-surfaces.packet.vX" };
  const result = validateJsonSchema(schema, bad);
  assert.equal(result.valid, false);
});

test("review-surfaces.SCHEMA.3 human review schema rejects stale partial v1 artifacts missing current slices", () => {
  const priorV1HumanReview = {
    schema_version: "review-surfaces.human_review.v1",
    mode: "pr",
    spec_mode: "acai",
    verdict: {
      decision: "needs_author_clarification",
      confidence: "medium",
      reasons: []
    },
    summary: "Prior v1 human review artifact fixture.",
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [],
      invalid_evidence: [],
      confidence_summary: "No prior risk-lens field."
    },
    test_plan: [],
    skim_safe: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      pr_surface_path: ".review-surfaces/pr_review_surface.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "abc123",
      uncommitted_files: 0
    }
  };

  // review-surfaces.SCHEMA.3: a partial artifact (no risk_lens_findings,
  // intent_mismatch, review_routes, since_last_review, evidence_cards,
  // feedback_effects) now fails validation instead of degrading quietly.
  const result = validateJsonSchema(humanReviewSchema, priorV1HumanReview);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => /review_routes/.test(issue.message)));
});

test("review-surfaces.SCHEMA.3 human review schema requires the narrative field", () => {
  // narrative is always emitted (provider or deterministic fallback), so a stale
  // artifact lacking it must fail validation and be rebuilt, not render empty.
  assert.ok(humanReviewSchema.required.includes("narrative"), "narrative must be a required field");
  const withoutNarrative = withRequiredHumanFields({
    schema_version: "review-surfaces.human_review.v1",
    mode: "repo",
    spec_mode: "acai",
    verdict: { decision: "no_signal", confidence: "low", reasons: [] },
    summary: "No narrative fixture.",
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: { verified_facts: [], claimed_not_verified: [], missing_evidence: [], invalid_evidence: [], confidence_summary: "x" },
    test_plan: [],
    skim_safe: [],
    generated_from: { packet_path: "p", base_ref: "origin/main", head_ref: "HEAD", head_sha: "abc", uncommitted_files: 0 }
  }) as Record<string, unknown>;
  delete withoutNarrative.narrative;
  const result = validateJsonSchema(humanReviewSchema, withoutNarrative);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => /narrative/.test(issue.message)));
});

test("review-surfaces.CONVERSATION_REVIEW.4 pre-conversation human v1 artifacts remain valid", () => {
  const legacy = validHumanReview();
  delete legacy.conversation_analysis;
  delete legacy.review_insights;

  const result = validateJsonSchema(humanReviewSchema, legacy);

  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(humanReviewSchema.required.includes("conversation_analysis"), false);
  assert.equal(humanReviewSchema.required.includes("review_insights"), false);
});

test("review-surfaces.CONVERSATION_REVIEW.4 persisted insights require completed analyzed conversation state", () => {
  const analyzed = {
    ...HUMAN_REQUIRED_DEFAULTS.conversation_analysis,
    status: "analyzed",
    provider: "ai-sdk",
    summary: "The final request preserves the reviewer-facing behavior.",
    intent: [{ text: "Preserve the reviewer-facing behavior.", event_ids: ["user-final"] }],
    quality_flags: []
  };
  const insight = {
    id: "CONV-INSIGHT-001",
    category: "intent_mismatch",
    title: "The change conflicts with the final request",
    summary: "The renderer behavior was removed.",
    why_it_matters: "The reviewer could approve behavior the user rejected.",
    reviewer_action: "Restore the behavior or confirm the scope change.",
    priority: "high",
    evidence_state: "contradicted",
    basis: "validated_anchors",
    conversation_event_ids: ["user-final"],
    paths: ["src/human/render.ts"],
    requirement_ids: [],
    risk_ids: [],
    command_ids: [],
    evidence: [{ kind: "conversation", event_id: "user-final", confidence: "high", validation_status: "valid" }]
  };
  const human = validHumanReview();
  human.conversation_analysis = analyzed;
  human.review_insights = [insight];
  const prSurface: Record<string, unknown> = {
    schema_version: "review-surfaces.pr_surface.v1",
    mode: "pr",
    spec_mode: "none",
    status: "ready",
    scope: {
      base_ref: "main",
      head_ref: "HEAD",
      head_sha: "abc123",
      diff_source: "range",
      changed_files: [],
      affected_areas: [],
      affected_requirements: [],
      out_of_scope_changed_files: []
    },
    coverage: {
      base_available: false,
      summary: "No requirements in scope.",
      in_scope_count: 0,
      deltas: [],
      counts: {}
    },
    risks: { summary: "No deterministic risks.", candidates: [] },
    llm: { required: true, provider: "ai-sdk", status: "applied" },
    narrative: {
      summary: "Reviewer-facing renderer behavior changed.",
      what_changed: [],
      why_it_matters: [],
      review_first: [],
      risk_narratives: []
    },
    conversation_analysis: analyzed,
    review_insights: [insight]
  };

  for (const { name, schemaValue, artifact } of [
    { name: "human", schemaValue: humanReviewSchema, artifact: human },
    { name: "PR", schemaValue: prSurfaceSchema, artifact: prSurface }
  ]) {
    assert.equal(validateJsonSchema(schemaValue, artifact).valid, true, `${name} analyzed fixture must be valid`);

    for (const analysis of [
      undefined,
      { ...analyzed, status: "not_assessed" },
      { ...analyzed, status: "degraded" },
      { ...analyzed, quality_flags: ["conversation_review_unavailable"] },
      { ...analyzed, quality_flags: ["conversation_review_invalid_payload"] }
    ]) {
      const invalid = structuredClone(artifact);
      if (analysis === undefined) {
        delete invalid.conversation_analysis;
      } else {
        invalid.conversation_analysis = analysis;
      }
      const result = validateJsonSchema(schemaValue, invalid);
      assert.equal(result.valid, false, `${name} must reject insights without completed analysis: ${JSON.stringify(analysis)}`);
    }
  }
});

test("human review schema validates since-last-review comparison slices", () => {
  const humanReview = {
    schema_version: "review-surfaces.human_review.v1",
    mode: "pr",
    spec_mode: "acai",
    verdict: {
      decision: "reviewable_with_attention",
      confidence: "medium",
      reasons: []
    },
    summary: "Since-last-review schema fixture.",
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [],
      invalid_evidence: [],
      confidence_summary: "Fixture."
    },
    since_last_review: {
      previous_packet_path: ".review-surfaces-prev/review_packet.json",
      improved: [
        {
          id: "SLR-IMPROVED-001",
          category: "requirement",
          summary: "review-surfaces.HUMAN_REVIEW.11 improved.",
          acai_id: "review-surfaces.HUMAN_REVIEW.11",
          previous_status: "missing",
          current_status: "partial",
          direction: "improved",
          evidence: [
            {
              kind: "file",
              path: ".review-surfaces/review_packet.json",
              acai_id: "review-surfaces.HUMAN_REVIEW.11",
              confidence: "high",
              validation_status: "valid"
            }
          ]
        }
      ],
      regressed: [],
      new_risks: [
        {
          id: "SLR-NEW-RISK-001",
          category: "risk",
          summary: "New risk since last review.",
          severity: "medium",
          evidence: [{ kind: "file", path: ".review-surfaces/review_packet.json", confidence: "high", validation_status: "valid" }]
        }
      ],
      resolved_risks: [],
      new_overreach: [],
      resolved_overreach: [],
      still_open: [
        {
          id: "SLR-STILL-OPEN-001",
          category: "overreach",
          summary: "Overreach still open.",
          path: "src/still-open.ts",
          evidence: [{ kind: "file", path: ".review-surfaces/review_packet.json", confidence: "high", validation_status: "valid" }]
        }
      ],
      count_deltas: {
        satisfied: { before: 1, after: 1, delta: 0 },
        partial: { before: 0, after: 1, delta: 1 },
        missing: { before: 1, after: 0, delta: -1 },
        unknown: { before: 0, after: 0, delta: 0 },
        invalid_evidence: { before: 0, after: 0, delta: 0 }
      }
    },
    test_plan: [],
    skim_safe: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      pr_surface_path: ".review-surfaces/pr_review_surface.json",
      base_ref: "origin/main",
      base_sha: "base123",
      head_ref: "HEAD",
      head_sha: "abc123",
      uncommitted_files: 0
    }
  };

  const result = validateJsonSchema(humanReviewSchema, withRequiredHumanFields(humanReview));
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("human review schema validates review route slices", () => {
  const humanReview = {
    schema_version: "review-surfaces.human_review.v1",
    mode: "pr",
    spec_mode: "acai",
    verdict: {
      decision: "reviewable_with_attention",
      confidence: "medium",
      reasons: []
    },
    summary: "Review route schema fixture.",
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [],
      invalid_evidence: [],
      confidence_summary: "Fixture."
    },
    review_routes: [
      {
        id: "ROUTE-HUMAN",
        persona: "human_reviewer",
        title: "Human reviewer route",
        summary: "Default evidence-backed review path.",
        is_default: true,
        is_secondary: false,
        steps: [
          {
            id: "ROUTE-HUMAN-STEP-001",
            rank: 1,
            title: "Merge readiness verdict",
            action: "Start with the verdict.",
            evidence: [{ kind: "file", path: ".review-surfaces/review_packet.json", confidence: "high", validation_status: "valid" }],
            priority: "high",
            artifact: "human_review.md",
            queue_item_ids: ["REVIEW-001"],
            risk_lens_ids: ["LENS-001"],
            question_ids: ["QUESTION-001"],
            test_plan_ids: ["TEST-001"],
            suggested_comment_ids: ["SC-001"]
          }
        ]
      },
      {
        id: "ROUTE-AGENT",
        persona: "agent_continuation",
        title: "Agent-continuation route",
        summary: "Secondary continuation path.",
        is_default: false,
        is_secondary: true,
        steps: [
          {
            id: "ROUTE-AGENT-STEP-001",
            rank: 1,
            title: "Open risks",
            action: "Continue from open risks.",
            evidence: [{ kind: "file", path: ".review-surfaces/review_packet.json", confidence: "medium", validation_status: "not_checked" }],
            priority: "medium",
            queue_item_ids: [],
            risk_lens_ids: [],
            question_ids: [],
            test_plan_ids: [],
            suggested_comment_ids: []
          }
        ]
      }
    ],
    test_plan: [],
    skim_safe: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      pr_surface_path: ".review-surfaces/pr_review_surface.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "abc123",
      uncommitted_files: 0
    }
  };

  const result = validateJsonSchema(humanReviewSchema, withRequiredHumanFields(humanReview));
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("human review schema validates inline evidence cards", () => {
  const humanReview = {
    schema_version: "review-surfaces.human_review.v1",
    mode: "pr",
    spec_mode: "acai",
    verdict: {
      decision: "needs_author_clarification",
      confidence: "medium",
      reasons: []
    },
    summary: "Evidence card schema fixture.",
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [],
      invalid_evidence: [],
      confidence_summary: "Fixture."
    },
    evidence_cards: [
      {
        id: "CARD-001",
        title: "CI secret boundary",
        status: "mixed",
        summary: "CI secret-boundary files changed without recorded manual check.",
        direct_evidence: [
          {
            kind: "file",
            path: ".github/workflows/review-surfaces-pr.yml",
            confidence: "high",
            validation_status: "valid"
          }
        ],
        missing_evidence: [
          {
            kind: "unknown",
            note: "No manual CI secret-boundary check was recorded.",
            confidence: "unknown",
            validation_status: "unknown"
          }
        ],
        invalid_evidence: [],
        why_it_matters: "Secret-bearing workflow changes can expose credentials if trust boundaries are wrong.",
        reviewer_action: "Inspect workflow permissions and record the manual check.",
        source_ids: ["BLOCK-CI-SECRET-001"],
        risk_ids: ["PR-RISK-001"],
        requirement_ids: ["review-surfaces.HUMAN_REVIEW.13"],
        confidence: "medium",
        priority: "high"
      }
    ],
    test_plan: [],
    skim_safe: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      pr_surface_path: ".review-surfaces/pr_review_surface.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "abc123",
      uncommitted_files: 0
    }
  };

  const result = validateJsonSchema(humanReviewSchema, withRequiredHumanFields(humanReview));
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("human review schema validates intent-mismatch slices", () => {
  const humanReview = {
    schema_version: "review-surfaces.human_review.v1",
    mode: "pr",
    spec_mode: "acai",
    verdict: {
      decision: "needs_author_clarification",
      confidence: "medium",
      reasons: []
    },
    summary: "Intent mismatch schema fixture.",
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [],
      invalid_evidence: [],
      confidence_summary: "Fixture."
    },
    methodology_audit: { quality_flags: [], considered: [], research: [], workflow_findings: [] },
    intent_mismatch: {
      expected_by_spec: [
        {
          id: "INTENT-EXPECTED-001",
          summary: "review-surfaces.HUMAN_REVIEW.18: render intent mismatch.",
          evidence: [{ kind: "spec", path: "features/review-surfaces.feature.yaml", acai_id: "review-surfaces.HUMAN_REVIEW.18", confidence: "high", validation_status: "valid" }],
          requirement_ids: ["review-surfaces.HUMAN_REVIEW.18"],
          paths: ["features/review-surfaces.feature.yaml"],
          confidence: "high"
        }
      ],
      observed_in_diff: [
        {
          id: "INTENT-OBSERVED-001",
          summary: "Changed implementation file `src/human/human-review.ts` maps to HUMAN_REVIEW.",
          evidence: [{ kind: "file", path: "src/human/human-review.ts", confidence: "high", validation_status: "not_checked" }],
          requirement_ids: ["review-surfaces.HUMAN_REVIEW.18"],
          paths: ["src/human/human-review.ts"],
          confidence: "high"
        }
      ],
      possible_mismatches: [
        {
          id: "INTENT-MISMATCH-001",
          summary: "Partial implementation evidence for review-surfaces.HUMAN_REVIEW.18.",
          evidence: [{ kind: "unknown", note: "Fixture missing evidence.", confidence: "unknown", validation_status: "unknown" }],
          requirement_ids: ["review-surfaces.HUMAN_REVIEW.18"],
          paths: [],
          confidence: "medium",
          severity: "medium"
        }
      ],
      possible_overreach: [],
      missing_intent: []
    },
    test_plan: [],
    skim_safe: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      pr_surface_path: ".review-surfaces/pr_review_surface.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "abc123",
      uncommitted_files: 0
    }
  };

  const result = validateJsonSchema(humanReviewSchema, withRequiredHumanFields(humanReview));
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("human review schema rejects intent-mismatch items without evidence", () => {
  const humanReview = {
    schema_version: "review-surfaces.human_review.v1",
    mode: "pr",
    spec_mode: "acai",
    verdict: {
      decision: "needs_author_clarification",
      confidence: "medium",
      reasons: []
    },
    summary: "Intent mismatch schema fixture.",
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [],
      invalid_evidence: [],
      confidence_summary: "Fixture."
    },
    methodology_audit: { quality_flags: [], considered: [], research: [], workflow_findings: [] },
    intent_mismatch: {
      expected_by_spec: [
        {
          id: "INTENT-EXPECTED-001",
          summary: "Missing evidence fixture.",
          evidence: [],
          requirement_ids: ["review-surfaces.HUMAN_REVIEW.18"],
          paths: ["features/review-surfaces.feature.yaml"],
          confidence: "high"
        }
      ],
      observed_in_diff: [],
      possible_mismatches: [],
      possible_overreach: [],
      missing_intent: []
    },
    test_plan: [],
    skim_safe: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      pr_surface_path: ".review-surfaces/pr_review_surface.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "abc123",
      uncommitted_files: 0
    }
  };

  const result = validateJsonSchema(humanReviewSchema, withRequiredHumanFields(humanReview));
  assert.equal(result.valid, false);
});

// Ties the runtime VERSION constant into the packet contract: the manifest's
// tool_version is stamped from VERSION, and VERSION tracks package.json. (The
// raw VERSION === package.json check also lives in version.test.ts; here it
// guards the contract surface — the populated fixture's tool_version — directly.)
test("VERSION is in sync with package.json and stamps the fixture's manifest tool_version", () => {
  assert.equal(VERSION, packageJson.version);
  assert.equal((fullyPopulatedReviewPacket().manifest as { tool_version: string }).tool_version, VERSION);
});

// A minimal-but-complete human review artifact that the strict schema accepts.
// review-surfaces.SCHEMA.4 flips additionalProperties:false on the top-level
// object and the high-churn nested objects, so these tests start from a clean
// artifact, drop in ONE unknown property, and assert the strict schema rejects
// it (the prior tests only ever covered missing-required rejection).
function validHumanReview(): Record<string, unknown> {
  return withRequiredHumanFields({
    schema_version: "review-surfaces.human_review.v1",
    mode: "pr",
    spec_mode: "acai",
    verdict: { decision: "probably_safe", confidence: "high", reasons: [] },
    summary: "Strict-schema unknown-property fixture.",
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      verified_facts: [],
      claimed_not_verified: [],
      missing_evidence: [],
      invalid_evidence: [],
      confidence_summary: "Fixture."
    },
    test_plan: [],
    skim_safe: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "abc123",
      uncommitted_files: 0
    }
  }) as Record<string, unknown>;
}

test("review-surfaces.SCHEMA.4 the clean human artifact validates before unknown-property mutation", () => {
  // Guards the negative tests below: the base artifact must be VALID so a later
  // rejection is attributable to the injected unknown property, not a stale base.
  const result = validateJsonSchema(humanReviewSchema, validHumanReview());
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("review-surfaces.SCHEMA.4 rejects an unknown top-level property", () => {
  const bogus = { ...validHumanReview(), reviewer_notez: "typo'd field that used to validate clean and render empty" };
  const result = validateJsonSchema(humanReviewSchema, bogus);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => /Unexpected property/.test(issue.message) && /reviewer_notez/.test(issue.path)),
    JSON.stringify(result.issues)
  );
});

test("review-surfaces.SCHEMA.4 rejects an unknown property on the verdict object", () => {
  const model = validHumanReview();
  model.verdict = { decision: "probably_safe", confidence: "high", reasons: [], desicion: "block_before_merge" };
  const result = validateJsonSchema(humanReviewSchema, model);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => /Unexpected property/.test(issue.message) && /desicion/.test(issue.path)),
    JSON.stringify(result.issues)
  );
});

test("review-surfaces.SCHEMA.4 rejects an unknown property on an evidence ref", () => {
  const model = validHumanReview();
  model.risk_lens_findings = [
    {
      id: "LENS-001",
      lens: "security_privacy",
      severity: "high",
      summary: "Strict evidence-ref fixture.",
      reviewer_action: "Inspect.",
      evidence: [
        {
          kind: "file",
          path: ".review-surfaces/review_packet.json",
          confidence: "high",
          validation_status: "valid",
          confidance: "high"
        }
      ],
      suggested_tests: [],
      suggested_comments: [],
      risk_ids: [],
      requirement_ids: [],
      paths: [],
      confidence: "high"
    }
  ];
  const result = validateJsonSchema(humanReviewSchema, model);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => /Unexpected property/.test(issue.message) && /confidance/.test(issue.path)),
    JSON.stringify(result.issues)
  );
});

test("review-surfaces.SCHEMA.4 rejects an unknown property on a risk-lens finding", () => {
  const model = validHumanReview();
  model.risk_lens_findings = [
    {
      id: "LENS-001",
      lens: "security_privacy",
      severity: "high",
      summary: "Strict risk-lens fixture.",
      reviewer_action: "Inspect.",
      evidence: [],
      suggested_tests: [],
      suggested_comments: [],
      risk_ids: [],
      requirement_ids: [],
      paths: [],
      confidence: "high",
      lenz: "security_privacy"
    }
  ];
  const result = validateJsonSchema(humanReviewSchema, model);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => /Unexpected property/.test(issue.message) && /lenz/.test(issue.path)),
    JSON.stringify(result.issues)
  );
});

test("review-surfaces.SCHEMA.4 rejects an unknown property on a change-graph node", () => {
  const model = validHumanReview();
  model.change_graph = {
    nodes: [
      {
        path: "src/human/contract.ts",
        churn_added: 1,
        churn_removed: 0,
        status: "modified",
        cluster: "src",
        lenz: "architecture"
      }
    ],
    halo_nodes: [],
    edges: [],
    clusters: [],
    overview: { groups: [], halo_count: 0, edges: [] }
  };
  const result = validateJsonSchema(humanReviewSchema, model);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => /Unexpected property/.test(issue.message) && /lenz/.test(issue.path)),
    JSON.stringify(result.issues)
  );
});

// review-surfaces.SCHEMA.5: the packet schema bounds agent-influenceable arrays
// and free-text. These guard that the caps exist (a provider cannot bloat the
// packet unbounded while still validating) — mirroring the human uncovered_lines
// maxItems pattern, with generous caps that exceed any legitimate current packet.
test("review-surfaces.SCHEMA.5 per-item evidence and missing_evidence arrays carry a maxItems cap", () => {
  const evidenceCap = schemaAt(schema, ["$defs", "RequirementResult", "properties", "evidence", "maxItems"]);
  const missingCap = schemaAt(schema, ["$defs", "RequirementResult", "properties", "missing_evidence", "maxItems"]);
  assert.equal(typeof evidenceCap, "number");
  assert.ok((evidenceCap as number) >= 100);
  assert.equal(typeof missingCap, "number");
  assert.ok((missingCap as number) >= 100);
});

test("review-surfaces.SCHEMA.5 the big agent arrays carry maxItems caps", () => {
  const caps: Array<[string[], number]> = [
    [["$defs", "Evaluation", "properties", "results", "maxItems"], 217],
    [["$defs", "Evaluation", "properties", "overreach", "maxItems"], 4],
    [["$defs", "Intent", "properties", "requirements", "maxItems"], 217],
    [["$defs", "Intent", "properties", "claimed_candidates", "maxItems"], 217],
    [["$defs", "Risks", "properties", "items", "maxItems"], 3],
    [["$defs", "Dogfood", "properties", "findings", "maxItems"], 1]
  ];
  for (const [segments, currentMax] of caps) {
    const cap = schemaAt(schema, segments);
    assert.equal(typeof cap, "number", `expected numeric maxItems at ${segments.join(".")}`);
    assert.ok((cap as number) > currentMax, `${segments.join(".")} cap ${cap} must exceed current ${currentMax}`);
  }
});

test("review-surfaces.SCHEMA.5 intent free-text arrays carry maxItems caps and string maxLength", () => {
  for (const field of ["constraints", "non_goals", "assumptions", "open_questions"]) {
    const cap = schemaAt(schema, ["$defs", "Intent", "properties", field, "maxItems"]);
    assert.equal(typeof cap, "number", `expected numeric maxItems on intent.${field}`);
    const itemLen = schemaAt(schema, ["$defs", "Intent", "properties", field, "items", "maxLength"]);
    assert.equal(typeof itemLen, "number", `expected numeric maxLength on intent.${field}[]`);
  }
  assert.equal(typeof schemaAt(schema, ["$defs", "Intent", "properties", "summary", "maxLength"]), "number");
});

test("review-surfaces.SCHEMA.5 provider-claimed candidate statement/anchors carry maxLength and maxItems caps", () => {
  const base = ["$defs", "Intent", "properties", "claimed_candidates", "items", "properties"];
  const statementLen = schemaAt(schema, [...base, "statement", "maxLength"]);
  assert.equal(typeof statementLen, "number", "expected numeric maxLength on claimed_candidates[].statement");
  const anchorsCap = schemaAt(schema, [...base, "anchors", "maxItems"]);
  assert.equal(typeof anchorsCap, "number", "expected numeric maxItems on claimed_candidates[].anchors");
  const anchorItemLen = schemaAt(schema, [...base, "anchors", "items", "maxLength"]);
  assert.equal(typeof anchorItemLen, "number", "expected numeric maxLength on claimed_candidates[].anchors[]");
});

test("review-surfaces.SCHEMA.5 requirement free-text fields carry maxLength and maxItems caps", () => {
  // The intent.requirements count cap bounds how MANY requirements exist, but
  // each $defs.Requirement still carried unbounded free-text. Cap the body too:
  // requirement/title strings carry maxLength; constraints/assumptions/
  // open_questions arrays carry maxItems + per-item maxLength.
  const base = ["$defs", "Requirement", "properties"];
  for (const field of ["requirement", "title"]) {
    const cap = schemaAt(schema, [...base, field, "maxLength"]);
    assert.equal(typeof cap, "number", `expected numeric maxLength on requirement.${field}`);
  }
  for (const field of ["constraints", "assumptions", "open_questions"]) {
    const cap = schemaAt(schema, [...base, field, "maxItems"]);
    assert.equal(typeof cap, "number", `expected numeric maxItems on requirement.${field}`);
    const itemLen = schemaAt(schema, [...base, field, "items", "maxLength"]);
    assert.equal(typeof itemLen, "number", `expected numeric maxLength on requirement.${field}[]`);
  }
});

test("review-surfaces.SCHEMA.5 free-text string fields carry a maxLength cap", () => {
  const stringFields: string[][] = [
    ["$defs", "RequirementResult", "properties", "summary", "maxLength"],
    ["$defs", "RequirementResult", "properties", "review_focus", "maxLength"],
    ["$defs", "Evaluation", "properties", "summary", "maxLength"],
    ["$defs", "Risks", "properties", "summary", "maxLength"],
    ["$defs", "RiskItem", "properties", "summary", "maxLength"],
    ["$defs", "DogfoodFinding", "properties", "finding", "maxLength"],
    ["$defs", "EvidenceRef", "properties", "note", "maxLength"]
  ];
  for (const segments of stringFields) {
    const cap = schemaAt(schema, segments);
    assert.equal(typeof cap, "number", `expected numeric maxLength at ${segments.join(".")}`);
    assert.ok((cap as number) >= 800, `${segments.join(".")} cap ${cap} must exceed the longest legitimate field (~800 chars)`);
  }
});

test("review-surfaces.SCHEMA.5 methodology narrative summary and arrays carry maxLength and maxItems caps", () => {
  const summaryLen = schemaAt(schema, ["$defs", "Methodology", "properties", "summary", "maxLength"]);
  assert.equal(typeof summaryLen, "number", "expected numeric maxLength on methodology.summary");
  const stringArrays = [
    "considered",
    "research",
    "decisions",
    "unchallenged_assumptions",
    "skipped_checks",
    "claims_without_evidence",
    "verified_claims",
    "quality_flags"
  ];
  for (const field of stringArrays) {
    const cap = schemaAt(schema, ["$defs", "Methodology", "properties", field, "maxItems"]);
    assert.equal(typeof cap, "number", `expected numeric maxItems on methodology.${field}`);
    const itemLen = schemaAt(schema, ["$defs", "Methodology", "properties", field, "items", "maxLength"]);
    assert.equal(typeof itemLen, "number", `expected numeric maxLength on methodology.${field}[]`);
  }
  const evidenceCap = schemaAt(schema, ["$defs", "Methodology", "properties", "evidence", "maxItems"]);
  assert.equal(typeof evidenceCap, "number", "expected numeric maxItems on methodology.evidence");
});

// review-surfaces.SCHEMA.5: converge the remaining agent-influenceable / loaded-
// artifact narrative fields under one cap pass. Codex flagged uncapped fields one
// at a time across rounds (test-gap strings, dogfood.deferrals, remediation
// description, …); this pins the named fields AND structurally asserts that EVERY
// free-text string and array under the agent-influenceable $defs is bounded, so a
// provider/loaded artifact can't bloat the packet unbounded and no later round can
// find a still-uncapped narrative field.
test("review-surfaces.SCHEMA.5 test-gap narrative strings carry maxLength caps", () => {
  for (const field of ["summary", "suggested_test", "manual_check"]) {
    const cap = schemaAt(schema, ["$defs", "TestGap", "properties", field, "maxLength"]);
    assert.equal(typeof cap, "number", `expected numeric maxLength on TestGap.${field}`);
  }
  const evidenceCap = schemaAt(schema, ["$defs", "TestGap", "properties", "evidence", "maxItems"]);
  assert.equal(typeof evidenceCap, "number", "expected numeric maxItems on TestGap.evidence");
});

test("review-surfaces.SCHEMA.5 missing automatic/manual test narrative strings carry maxLength caps", () => {
  for (const field of ["summary", "suggested_test"]) {
    const cap = schemaAt(schema, ["$defs", "MissingAutomaticTest", "properties", field, "maxLength"]);
    assert.equal(typeof cap, "number", `expected numeric maxLength on MissingAutomaticTest.${field}`);
  }
  for (const field of ["summary", "manual_check"]) {
    const cap = schemaAt(schema, ["$defs", "MissingManualCheck", "properties", field, "maxLength"]);
    assert.equal(typeof cap, "number", `expected numeric maxLength on MissingManualCheck.${field}`);
  }
});

test("review-surfaces.SCHEMA.5 dogfood.deferrals array carries maxItems and per-item maxLength caps", () => {
  const cap = schemaAt(schema, ["$defs", "Dogfood", "properties", "deferrals", "maxItems"]);
  assert.equal(typeof cap, "number", "expected numeric maxItems on dogfood.deferrals");
  const itemLen = schemaAt(schema, ["$defs", "Dogfood", "properties", "deferrals", "items", "maxLength"]);
  assert.equal(typeof itemLen, "number", "expected numeric maxLength on dogfood.deferrals[]");
});

test("review-surfaces.SCHEMA.5 remediation-task description carries a maxLength cap", () => {
  const cap = schemaAt(schema, ["$defs", "RemediationTask", "properties", "description", "maxLength"]);
  assert.equal(typeof cap, "number", "expected numeric maxLength on RemediationTask.description");
});

test("review-surfaces.SCHEMA.5 subsystem-card narrative strings and arrays carry caps", () => {
  for (const field of ["name", "summary"]) {
    const cap = schemaAt(schema, ["$defs", "SubsystemCard", "properties", field, "maxLength"]);
    assert.equal(typeof cap, "number", `expected numeric maxLength on SubsystemCard.${field}`);
  }
  for (const field of ["files", "responsibilities", "interactions", "tests", "risks"]) {
    const cap = schemaAt(schema, ["$defs", "SubsystemCard", "properties", field, "maxItems"]);
    assert.equal(typeof cap, "number", `expected numeric maxItems on SubsystemCard.${field}`);
    const itemLen = schemaAt(schema, ["$defs", "SubsystemCard", "properties", field, "items", "maxLength"]);
    assert.equal(typeof itemLen, "number", `expected numeric maxLength on SubsystemCard.${field}[]`);
  }
});

test("review-surfaces.SCHEMA.5 architecture summary and arrays carry caps", () => {
  assert.equal(typeof schemaAt(schema, ["$defs", "Architecture", "properties", "summary", "maxLength"]), "number");
  for (const field of ["diagrams", "diagram_validation", "subsystems", "open_questions"]) {
    const cap = schemaAt(schema, ["$defs", "Architecture", "properties", field, "maxItems"]);
    assert.equal(typeof cap, "number", `expected numeric maxItems on architecture.${field}`);
  }
  for (const field of ["errors", "warnings"]) {
    const cap = schemaAt(schema, ["$defs", "DiagramValidation", "properties", field, "maxItems"]);
    assert.equal(typeof cap, "number", `expected numeric maxItems on DiagramValidation.${field}`);
    const itemLen = schemaAt(schema, ["$defs", "DiagramValidation", "properties", field, "items", "maxLength"]);
    assert.equal(typeof itemLen, "number", `expected numeric maxLength on DiagramValidation.${field}[]`);
  }
});

test("review-surfaces.SCHEMA.5 test-evidence and source-ref/intent-sources narrative fields carry caps", () => {
  assert.equal(typeof schemaAt(schema, ["$defs", "TestEvidence", "properties", "summary", "maxLength"]), "number");
  assert.equal(typeof schemaAt(schema, ["$defs", "TestEvidence", "properties", "requirement_ids", "maxItems"]), "number");
  assert.equal(typeof schemaAt(schema, ["$defs", "TestEvidence", "properties", "evidence", "maxItems"]), "number");
  assert.equal(typeof schemaAt(schema, ["$defs", "SourceRef", "properties", "title", "maxLength"]), "number");
  assert.equal(typeof schemaAt(schema, ["$defs", "SourceRef", "properties", "evidence", "maxItems"]), "number");
  assert.equal(typeof schemaAt(schema, ["$defs", "Intent", "properties", "sources", "maxItems"]), "number");
});

// review-surfaces.SCHEMA.5: tight caps (1000/5000/20000) bound PROVIDER/agent/
// loaded-FEEDBACK narrative. But two arrays are COLLECTOR-DETERMINISTIC, bounded
// by real repo/transcript size rather than provider narrative, so they get a HIGH
// ceiling (>=100000) that caps-for-safety without rejecting a legitimate large run:
//   - manifest.input_hashes: collect.ts hashes EVERY matched spec/doc/feedback/
//     command-transcript input; a big foreign repo can exceed the 1000 tier.
//   - risks.test_evidence: validationEvidenceFromCommandTranscripts emits one item
//     per ingested command transcript (plus parsed-JUnit/feedback/claimed sources),
//     so a large .review-surfaces/commands/*.json ingest can exceed the 1000 tier.
// And the command transcript's raw `command` string copies through unbounded (only
// stdout/stderr are length-capped), so EvidenceRef.command / Dogfood.command are
// free-text and must carry a maxLength (they are no longer identifier-allowlisted).
test("review-surfaces.SCHEMA.5 collector-deterministic arrays carry a HIGH maxItems ceiling", () => {
  const inputHashesCap = schemaAt(schema, ["$defs", "RunManifest", "properties", "input_hashes", "maxItems"]);
  assert.equal(typeof inputHashesCap, "number", "expected numeric maxItems on manifest.input_hashes");
  assert.ok(
    (inputHashesCap as number) >= 100000,
    `manifest.input_hashes cap ${inputHashesCap} must be a high ceiling (>=100000), not the 1000 narrative tier`
  );
  const testEvidenceCap = schemaAt(schema, ["$defs", "Risks", "properties", "test_evidence", "maxItems"]);
  assert.equal(typeof testEvidenceCap, "number", "expected numeric maxItems on risks.test_evidence");
  assert.ok(
    (testEvidenceCap as number) >= 100000,
    `risks.test_evidence cap ${testEvidenceCap} must be a high ceiling (>=100000), not the 1000 narrative tier`
  );
});

test("review-surfaces.SCHEMA.5 free-text command fields carry a maxLength cap", () => {
  // The command-transcript `command` string is copied through normalizeTranscript
  // with no length cap (only stdout/stderr excerpts are bounded), so it is
  // unbounded free-text — not an identifier — and must carry maxLength.
  const evidenceCommandLen = schemaAt(schema, ["$defs", "EvidenceRef", "properties", "command", "maxLength"]);
  assert.equal(typeof evidenceCommandLen, "number", "expected numeric maxLength on EvidenceRef.command");
  const dogfoodCommandLen = schemaAt(schema, ["$defs", "Dogfood", "properties", "command", "maxLength"]);
  assert.equal(typeof dogfoodCommandLen, "number", "expected numeric maxLength on Dogfood.command");
});

test("review-surfaces.SCHEMA.5 provider-controlled EvidenceRef identifier fields carry a maxLength cap", () => {
  // These look like identifiers but are PROVIDER-CONTROLLED free text in
  // provider-assisted runs: src/evaluation/candidate-evidence.ts copies a
  // candidate's entry.path / entry.test_name (including out-of-pool citations)
  // into an EvidenceRef that flows into the packet before validation, and
  // src/render/load.ts normalizes path/url/event_id/test_name (and sha/
  // excerpt_hash) straight off a loaded artifact record. So they must be bounded,
  // not identifier-allowlisted. sha/excerpt_hash carry a short hash-length cap;
  // kind/confidence/validation_status are enums; acai_id is pattern-bounded.
  for (const field of ["path", "url", "event_id", "test_name", "sha", "excerpt_hash"]) {
    const cap = schemaAt(schema, ["$defs", "EvidenceRef", "properties", field, "maxLength"]);
    assert.equal(typeof cap, "number", `expected numeric maxLength on EvidenceRef.${field}`);
  }
});

test("review-surfaces.SCHEMA.5 dogfood comparison string arrays carry caps", () => {
  assert.equal(typeof schemaAt(schema, ["$defs", "PacketComparison", "properties", "status_changes", "maxItems"]), "number");
  for (const field of ["new_overreach", "resolved_overreach", "new_risks", "resolved_risks"]) {
    const cap = schemaAt(schema, ["$defs", "PacketComparison", "properties", field, "maxItems"]);
    assert.equal(typeof cap, "number", `expected numeric maxItems on PacketComparison.${field}`);
    const itemLen = schemaAt(schema, ["$defs", "PacketComparison", "properties", field, "items", "maxLength"]);
    assert.equal(typeof itemLen, "number", `expected numeric maxLength on PacketComparison.${field}[]`);
  }
});

test("review-surfaces.SCHEMA.5 dogfood finding packet_section and agent_handoff narrative fields carry caps", () => {
  assert.equal(typeof schemaAt(schema, ["$defs", "DogfoodFinding", "properties", "packet_section", "maxLength"]), "number");
  assert.equal(typeof schemaAt(schema, ["$defs", "AgentHandoff", "properties", "summary", "maxLength"]), "number");
  for (const field of [
    "relevant_acids",
    "implemented_changes",
    "commands_to_run",
    "validation_evidence",
    "failed_validation",
    "methodology_flags",
    "next_tasks",
    "open_risks",
    "deferrals",
    "artifact_paths",
    "changes_since_last_packet"
  ]) {
    const cap = schemaAt(schema, ["$defs", "AgentHandoff", "properties", field, "maxItems"]);
    assert.equal(typeof cap, "number", `expected numeric maxItems on agent_handoff.${field}`);
    const itemLen = schemaAt(schema, ["$defs", "AgentHandoff", "properties", field, "items", "maxLength"]);
    assert.equal(typeof itemLen, "number", `expected numeric maxLength on agent_handoff.${field}[]`);
  }
});

// Structural convergence guard: walk the WHOLE packet schema and assert that
// EVERY free-text string and EVERY array is bounded, EXCEPT a small, explicit
// allowlist of pure identifiers / SHAs / paths / status+milestone labels / map
// values (the fields review-surfaces.SCHEMA.5 deliberately leaves uncapped per
// its design). A new uncapped narrative string or array fails this test the
// moment it is added — so Codex cannot find an uncapped agent field one round
// at a time; the cap is enforced structurally, not field-by-field.
test("review-surfaces.SCHEMA.5 every agent-influenceable string/array in the packet schema is bounded", () => {
  // Pure identifier / structural / status-label / map-value string fields that
  // are intentionally NOT free-text and are excluded from the maxLength cap.
  const stringAllowlist = new Set<string>([
    "$defs.RunManifest.properties.tool_version",
    "$defs.RunManifest.properties.repo",
    "$defs.RunManifest.properties.base_ref",
    "$defs.RunManifest.properties.head_ref",
    "$defs.RunManifest.properties.base_sha",
    "$defs.RunManifest.properties.head_sha",
    "$defs.RunManifest.properties.milestone",
    "$defs.RunManifest.properties.iteration_id",
    "$defs.RunManifest.properties.previous_packet_path",
    "$defs.RunManifest.properties.signature",
    "$defs.RunManifest.properties.artifact_signatures.additionalProperties",
    "$defs.RunManifest.properties.coverage.properties.source_path",
    "$defs.RunManifest.properties.coverage.properties.hash",
    "$defs.RunManifest.properties.coverage.properties.head_committed_at",
    "$defs.RunManifest.properties.coverage.properties.report_modified_at",
    "$defs.InputHash.properties.path",
    "$defs.InputHash.properties.algorithm",
    "$defs.InputHash.properties.hash",
    "$defs.InputHash.properties.kind",
    "$defs.SourceRef.properties.ref",
    "$defs.Requirement.properties.id",
    "$defs.Requirement.properties.acai_id",
    "$defs.Intent.properties.claimed_candidates.items.properties.id",
    "$defs.RequirementResult.properties.requirement_id",
    "$defs.RequirementResult.properties.acai_id",
    "$defs.Evaluation.properties.acai_coverage.additionalProperties",
    "$defs.SubsystemCard.properties.id",
    "$defs.DiagramValidation.properties.path",
    "$defs.RiskItem.properties.id",
    "$defs.TestEvidence.properties.id",
    "$defs.TestGap.properties.id",
    "$defs.TestGap.properties.requirement_id",
    "$defs.TestGap.properties.acai_id",
    "$defs.MissingAutomaticTest.properties.id",
    "$defs.MissingAutomaticTest.properties.requirement_id",
    "$defs.MissingAutomaticTest.properties.acai_id",
    "$defs.MissingManualCheck.properties.id",
    "$defs.MissingManualCheck.properties.requirement_id",
    "$defs.MissingManualCheck.properties.acai_id",
    "$defs.RemediationTask.properties.acai_id",
    "$defs.RemediationTask.properties.target_milestone",
    "$defs.DogfoodFinding.properties.id",
    "$defs.StatusChange.properties.acai_id",
    "$defs.StatusChange.properties.previous_status",
    "$defs.StatusChange.properties.current_status",
    "$defs.Dogfood.properties.milestone",
    "$defs.Dogfood.properties.previous_packet_path",
    "$defs.AgentHandoff.properties.current_milestone"
  ]);

  const arraysWithoutCap: string[] = [];
  const stringsWithoutCap: string[] = [];
  const walk = (node: unknown, segments: string[]): void => {
    if (!isRecord(node)) {
      return;
    }
    if (node.type === "array" && node.maxItems === undefined) {
      arraysWithoutCap.push(segments.join("."));
    }
    if (
      node.type === "string" &&
      node.maxLength === undefined &&
      node.enum === undefined &&
      node.const === undefined &&
      node.format === undefined &&
      node.pattern === undefined &&
      !stringAllowlist.has(segments.join("."))
    ) {
      stringsWithoutCap.push(segments.join("."));
    }
    for (const key of Object.keys(node)) {
      walk((node as Record<string, unknown>)[key], [...segments, key]);
    }
  };
  walk(schema, []);

  assert.deepEqual(arraysWithoutCap, [], `every array must carry maxItems; uncapped: ${arraysWithoutCap.join(", ")}`);
  assert.deepEqual(
    stringsWithoutCap,
    [],
    `every free-text string must carry maxLength (or be allowlisted as an identifier); uncapped: ${stringsWithoutCap.join(", ")}`
  );
});

// review-surfaces.SCHEMA.6: schema-version and enum drift is test-guarded across
// every artifact schema. The packet and human consts were already guarded; these
// add the pr_surface const, hoist + tie the risk-lens enum, and tie the human
// evidence-kind/validation-status enums to their runtime source of truth.
test("review-surfaces.SCHEMA.6 pr_surface schema_version const matches PR_SURFACE_SCHEMA_VERSION", () => {
  assert.equal(schemaAt(prSurfaceSchema, ["properties", "schema_version", "const"]), PR_SURFACE_SCHEMA_VERSION);
});

test("review-surfaces.SCHEMA.6 the hoisted human risk-lens enum equals RISK_LENSES", () => {
  // The lens enum was inline-duplicated three times. It is now a single $def
  // (#/$defs/riskLens) the two change-graph sites $ref; the riskLensFinding copy
  // stays inline (it is the site the existing human-review.test.ts guard pins),
  // so this test ALSO ties that inline copy to the hoisted $def, removing the
  // last drift path. Guard the $def against the runtime source of truth.
  const hoisted = schemaAt(humanReviewSchema, ["$defs", "riskLens", "enum"]);
  assert.deepEqual(hoisted, [...RISK_LENSES]);
  // riskLensFinding's inline lens enum must equal the hoisted $def (no drift).
  assert.deepEqual(
    schemaAt(humanReviewSchema, ["$defs", "riskLensFinding", "properties", "lens", "enum"]),
    hoisted
  );
  // The two change-graph lens sites $ref the single hoisted $def, not a re-inlined enum.
  assert.equal(
    schemaAt(humanReviewSchema, [
      "properties",
      "change_graph",
      "properties",
      "nodes",
      "items",
      "properties",
      "lens",
      "$ref"
    ]),
    "#/$defs/riskLens"
  );
  assert.equal(
    schemaAt(humanReviewSchema, [
      "properties",
      "change_graph",
      "properties",
      "overview",
      "properties",
      "groups",
      "items",
      "properties",
      "lens",
      "$ref"
    ]),
    "#/$defs/riskLens"
  );
});

test("review-surfaces.SCHEMA.6 human evidence-kind and validation-status enums match runtime contracts", () => {
  assert.deepEqual(schemaAt(humanReviewSchema, ["$defs", "evidenceRef", "properties", "kind", "enum"]), [
    ...PACKET_EVIDENCE_KINDS
  ]);
  assert.deepEqual(
    schemaAt(humanReviewSchema, ["$defs", "evidenceRef", "properties", "validation_status", "enum"]),
    [...PACKET_VALIDATION_STATUSES]
  );
});

test("review-surfaces.CONVERSATION_REVIEW.3 persisted conversation schemas stay fully aligned", () => {
  const humanCrossFieldRules = schemaAt(humanReviewSchema, ["allOf"]) as unknown[];
  const prCrossFieldRules = schemaAt(prSurfaceSchema, ["allOf"]) as unknown[];
  assert.deepEqual(
    humanCrossFieldRules[0],
    prCrossFieldRules.at(-1),
    "conversation cross-field invariants must match across human and PR surfaces"
  );
  for (const property of ["conversation_analysis", "review_insights"]) {
    assert.deepEqual(
      schemaAt(humanReviewSchema, ["properties", property]),
      schemaAt(prSurfaceSchema, ["properties", property]),
      `${property} must have one persisted shape across human and PR surfaces`
    );
  }
  for (const definition of [
    "conversationAnalysisItem",
    "conversationAnalysisItems",
    "conversationAnalysis",
    "insightStringArray",
    "reviewerInsight"
  ]) {
    assert.deepEqual(
      schemaAt(humanReviewSchema, ["$defs", definition]),
      schemaAt(prSurfaceSchema, ["$defs", definition]),
      `${definition} must have one persisted shape across human and PR surfaces`
    );
  }
  assert.equal(
    schemaAt(humanReviewSchema, ["properties", "review_insights", "maxItems"]),
    MAX_VISIBLE_CONVERSATION_INSIGHTS
  );
  assert.deepEqual(
    schemaAt(humanReviewSchema, ["$defs", "reviewerInsight", "properties", "evidence_state", "enum"]),
    [...REVIEWER_INSIGHT_EVIDENCE_STATES]
  );
});

function schemaAt(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    assert.ok(isRecord(current), `Expected object before ${segment} in ${segments.join(".")}`);
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
