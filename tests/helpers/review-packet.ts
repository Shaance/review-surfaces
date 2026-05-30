import { PACKET_SCHEMA_VERSION } from "../../src/schema/review-packet-contract";

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
