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
  PACKET_VALIDATION_STATUSES
} from "../src/schema/review-packet-contract";
import { RISK_LENSES } from "../src/human/contract";
import { PR_SURFACE_SCHEMA_VERSION } from "../src/pr/contract";
import { VERSION } from "../src/core/version";
import { fullyPopulatedReviewPacket, minimalReviewPacket } from "./helpers/review-packet";

const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "review_packet.schema.json"), "utf8"));
const humanReviewSchema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));
const prSurfaceSchema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "pr_review_surface.schema.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };

// review-surfaces.SCHEMA.3: the strict human schema requires every field the
// current model emits. These slice fixtures exercise one feature at a time, so
// fill the remaining required fields with empty defaults; the slice under test
// is preserved (spread last) and the test stays focused on that slice.
const HUMAN_REQUIRED_DEFAULTS = {
  narrative: { source: "fallback", provider: "mock", validated_at_head: "abc", claims: [] },
  semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
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
