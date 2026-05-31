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
} from "../../src/schema/review-packet-contract";
import { VERSION } from "../../src/core/version";

export interface MutableReviewPacketFixture {
  schema_version: string;
  manifest: Record<string, unknown>;
  intent: Record<string, unknown>;
  evaluation: Record<string, unknown>;
  architecture: Record<string, unknown>;
  methodology: Record<string, unknown>;
  risks: Record<string, unknown>;
  dogfood?: Record<string, unknown>;
  agent_handoff?: Record<string, unknown>;
}

export function minimalReviewPacket(): MutableReviewPacketFixture {
  return {
    schema_version: PACKET_SCHEMA_VERSION,
    manifest: {
      tool_version: "0.1.0",
      created_at: "2026-05-28T00:00:00.000Z",
      repo: "review-surfaces",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "abc",
      run_mode: "local",
      input_hashes: []
    },
    intent: {
      summary: "schema fixture",
      requirements: []
    },
    evaluation: {
      summary: "schema fixture",
      results: [],
      overreach: [],
      acai_coverage: {}
    },
    architecture: {
      summary: "schema fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "schema fixture",
      missing_logs: true,
      considered: [],
      research: [],
      decisions: [],
      unchallenged_assumptions: [],
      skipped_checks: [],
      claims_without_evidence: [],
      verified_claims: [],
      quality_flags: [],
      evidence: []
    },
    risks: {
      summary: "schema fixture",
      items: [],
      test_evidence: [],
      test_gaps: [],
      missing_automatic_tests: [],
      missing_manual_checks: [],
      review_focus: []
    }
  };
}

// A fully-populated EvidenceRef exercising every optional field of the $def.
function fullEvidenceRef(): Record<string, unknown> {
  return {
    kind: PACKET_EVIDENCE_KINDS[0],
    path: "src/api.ts",
    line_start: 1,
    line_end: 5,
    sha: "deadbeef",
    url: "https://example.test/evidence",
    acai_id: "review-surfaces.EVIDENCE.4",
    event_id: "EVT-1",
    test_name: "covers the api",
    command: "pnpm run test",
    excerpt_hash: "abc123",
    note: "fully-populated evidence",
    confidence: PACKET_CONFIDENCE_LEVELS[0],
    validation_status: PACKET_VALIDATION_STATUSES[0],
    llm_proposed: false,
    verified: true
  };
}

// A review packet that fills at least one element of EVERY optional/array field
// across all $defs so the schema-parity test exercises every $def branch (not
// just the all-empty minimal fixture). Every enum value comes from the PACKET_*
// contract constants so the fixture cannot drift from the schema enums. This is
// a TEST fixture (never serialized as an artifact), so byte-stability does not
// bind it — readability as a single object literal is preferred.
export function fullyPopulatedReviewPacket(): MutableReviewPacketFixture {
  return {
    schema_version: PACKET_SCHEMA_VERSION,
    manifest: {
      tool_version: VERSION,
      created_at: "2026-05-28T00:00:00.000Z",
      repo: "review-surfaces",
      base_ref: "origin/main",
      head_ref: "HEAD",
      base_sha: "1111111111111111111111111111111111111111",
      head_sha: "2222222222222222222222222222222222222222",
      run_mode: PACKET_RUN_MODES[1],
      milestone: "M6",
      iteration_id: "iter-1",
      previous_packet_path: ".review-surfaces-prev/review_packet.json",
      input_hashes: [
        { path: "features/review-surfaces.feature.yaml", algorithm: "sha256", hash: "h1", kind: "spec" }
      ],
      signature: "sig-fixture",
      artifact_signatures: { "review_packet.json": "sig-fixture" }
    },
    intent: {
      summary: "fully-populated intent",
      requirements: [
        {
          id: "REQ-1",
          acai_id: "review-surfaces.PRIVACY.2",
          title: "Privacy redaction",
          requirement: "Secrets must be redacted from artifacts.",
          source_refs: [
            {
              kind: PACKET_SOURCE_KINDS[0],
              ref: "features/review-surfaces.feature.yaml",
              title: "Privacy spec",
              evidence: [fullEvidenceRef()]
            }
          ],
          constraints: ["local-first"],
          assumptions: ["deterministic output"],
          open_questions: ["which surfaces redact first?"],
          confidence: PACKET_CONFIDENCE_LEVELS[0],
          llm_derived: false
        }
      ],
      constraints: ["offline by default"],
      non_goals: ["network calls"],
      assumptions: ["mock provider is a no-op"],
      open_questions: ["future enrichment?"],
      sources: [
        {
          kind: PACKET_SOURCE_KINDS[1],
          ref: "AGENTS.md",
          title: "Agent workflow",
          evidence: [fullEvidenceRef()]
        }
      ]
    },
    evaluation: {
      summary: "fully-populated evaluation",
      results: [
        {
          requirement_id: "REQ-1",
          acai_id: "review-surfaces.PRIVACY.2",
          status: PACKET_REQUIREMENT_STATUSES[1],
          summary: "partial coverage",
          partial_reason: PACKET_PARTIAL_REASONS[0],
          evidence: [fullEvidenceRef()],
          missing_evidence: [fullEvidenceRef()],
          review_focus: "verify redaction on the comment surface",
          confidence: PACKET_CONFIDENCE_LEVELS[1]
        }
      ],
      overreach: [
        {
          requirement_id: "OVERREACH-1",
          acai_id: "review-surfaces.OVERREACH.1",
          status: "overreach",
          summary: "Unmapped cluster",
          evidence: [fullEvidenceRef()],
          confidence: PACKET_CONFIDENCE_LEVELS[3]
        }
      ],
      acai_coverage: { "review-surfaces.PRIVACY.2": "partial" }
    },
    architecture: {
      summary: "fully-populated architecture",
      diagrams: ["diagrams/pipeline.mmd"],
      diagram_validation: [
        {
          path: "diagrams/pipeline.mmd",
          status: PACKET_DIAGRAM_STATUSES[0],
          diagram_type: PACKET_DIAGRAM_TYPES[0],
          errors: [],
          warnings: ["a non-fatal warning"],
          evidence: [fullEvidenceRef()]
        }
      ],
      subsystems: [
        {
          id: "SUB-1",
          name: "Collector",
          summary: "Collects inputs",
          files: ["src/collector/collect.ts"],
          responsibilities: ["gather diff"],
          interactions: ["git"],
          tests: ["tests/collect.test.ts"],
          risks: ["empty diff"],
          evidence: [fullEvidenceRef()]
        }
      ],
      open_questions: ["how to render subsystem cards?"]
    },
    methodology: {
      summary: "fully-populated methodology",
      missing_logs: false,
      considered: ["an alternative approach"],
      research: ["a research note"],
      decisions: ["chose the deterministic path"],
      unchallenged_assumptions: ["an assumption"],
      skipped_checks: ["a skipped check"],
      claims_without_evidence: ["tests are green"],
      verified_claims: ["pnpm run test passed"],
      quality_flags: ["claims_without_evidence"],
      evidence: [fullEvidenceRef()]
    },
    risks: {
      summary: "fully-populated risks",
      items: [
        {
          id: "RISK-1",
          category: PACKET_RISK_CATEGORIES[0],
          severity: PACKET_RISK_SEVERITIES[2],
          likelihood: PACKET_RISK_LIKELIHOODS[1],
          detectability: PACKET_RISK_DETECTABILITY[1],
          summary: "A correctness risk",
          impact: "could drop evidence",
          evidence: [fullEvidenceRef()],
          suggested_checks: ["add a regression test"],
          manual_review: true
        }
      ],
      test_evidence: [
        {
          id: "TEST-RESULT-1",
          kind: PACKET_TEST_EVIDENCE_KINDS[0],
          summary: "direct test evidence",
          requirement_ids: ["REQ-1"],
          evidence: [fullEvidenceRef()]
        }
      ],
      test_gaps: [
        {
          id: "GAP-1",
          requirement_id: "REQ-1",
          acai_id: "review-surfaces.PRIVACY.2",
          summary: "no exact test",
          suggested_test: "add a redaction unit test",
          manual_check: "inspect the comment surface",
          evidence: [fullEvidenceRef()]
        }
      ],
      missing_automatic_tests: [
        {
          id: "MAT-1",
          requirement_id: "REQ-1",
          acai_id: "review-surfaces.PRIVACY.2",
          summary: "missing automatic test",
          suggested_test: "cover the redactor",
          evidence: [fullEvidenceRef()]
        }
      ],
      missing_manual_checks: [
        {
          id: "MMC-1",
          requirement_id: "REQ-1",
          acai_id: "review-surfaces.PRIVACY.2",
          summary: "missing manual check",
          manual_check: "verify the rendered comment",
          evidence: [fullEvidenceRef()]
        }
      ],
      review_focus: ["methodology claims without command evidence"]
    },
    dogfood: {
      milestone: "M6",
      command: "review-surfaces dogfood",
      summary: "fully-populated dogfood",
      helped_agent: PACKET_HELPFULNESS_VALUES[0],
      helped_reviewer: PACKET_HELPFULNESS_VALUES[1],
      previous_packet_path: ".review-surfaces-prev/review_packet.json",
      comparison: {
        status_changes: [
          {
            acai_id: "review-surfaces.PRIVACY.2",
            previous_status: "missing",
            current_status: "partial",
            direction: PACKET_COMPARISON_DIRECTIONS[0]
          }
        ],
        new_overreach: ["Unmapped cluster A"],
        resolved_overreach: ["Unmapped cluster B"],
        new_risks: ["RISK-2"],
        resolved_risks: ["RISK-0"],
        count_deltas: {
          satisfied: { before: 1, after: 2, delta: 1 },
          partial: { before: 0, after: 1, delta: 1 },
          missing: { before: 3, after: 1, delta: -2 },
          unknown: { before: 0, after: 0, delta: 0 },
          invalid_evidence: { before: 0, after: 0, delta: 0 }
        }
      },
      findings: [
        {
          id: "FB-1",
          category: PACKET_DOGFOOD_CATEGORIES[0],
          severity: PACKET_DOGFOOD_SEVERITIES[1],
          packet_section: "risks.test_evidence",
          finding: "needs locally recorded validation evidence",
          impact: "weaker evidence",
          evidence: [fullEvidenceRef()],
          remediation: {
            type: PACKET_REMEDIATION_TYPES[1],
            description: "add a unit test",
            acai_id: "review-surfaces.PRIVACY.2",
            target_milestone: "M7"
          }
        }
      ],
      remediation_tasks: [
        {
          type: PACKET_REMEDIATION_TYPES[0],
          description: "implement the fix",
          acai_id: "review-surfaces.PRIVACY.2",
          target_milestone: "M7"
        }
      ],
      deferrals: ["defer the live-provider enrichment"]
    },
    agent_handoff: {
      summary: "fully-populated handoff",
      current_milestone: "M6",
      relevant_acids: ["review-surfaces.PRIVACY.2"],
      implemented_changes: ["redact secrets in artifacts"],
      commands_to_run: ["pnpm run test"],
      validation_evidence: ["Parsed test passed: covers the api"],
      failed_validation: ["[claimed] pnpm run lint"],
      methodology_flags: ["claims_without_evidence"],
      next_tasks: ["wire config-derived prefixes"],
      open_risks: ["RISK-1"],
      deferrals: ["live provider enrichment"],
      artifact_paths: [".review-surfaces/review_packet.json"],
      changes_since_last_packet: ["partial coverage for review-surfaces.PRIVACY.2"]
    }
  };
}
