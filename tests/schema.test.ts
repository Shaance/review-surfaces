import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateJsonSchema } from "../src/schema/json-schema";

test("validates required review packet fields and enums", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["schema_version", "risks"],
    properties: {
      schema_version: { type: "string", const: "review-surfaces.packet.v1" },
      risks: {
        type: "object",
        required: ["summary"],
        properties: {
          summary: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] }
        }
      }
    }
  };

  assert.equal(
    validateJsonSchema(schema, {
      schema_version: "review-surfaces.packet.v1",
      risks: { summary: "ok", severity: "medium" }
    }).valid,
    true
  );

  const invalid = validateJsonSchema(schema, {
    schema_version: "wrong",
    risks: { summary: "ok", severity: "critical" },
    extra: true
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((issue: { message: string }) => issue.message.includes("Expected constant")));
  assert.ok(invalid.issues.some((issue: { message: string }) => issue.message.includes("Expected one of")));
  assert.ok(invalid.issues.some((issue: { message: string }) => issue.message.includes("Unexpected property")));
});

test("review-surfaces.SCHEMA.1 requires architecture diagram validation metadata", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "review_packet.schema.json"), "utf8"));
  const packet = minimalReviewPacket();

  assert.equal(validateJsonSchema(schema, packet).valid, true);

  const stalePacket = minimalReviewPacket();
  delete (stalePacket.architecture as { diagram_validation?: unknown }).diagram_validation;
  const invalid = validateJsonSchema(schema, stalePacket);

  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((issue) => issue.path === "$.architecture" && issue.message.includes("diagram_validation")));
});

function minimalReviewPacket(): {
  schema_version: string;
  manifest: Record<string, unknown>;
  intent: Record<string, unknown>;
  evaluation: Record<string, unknown>;
  architecture: Record<string, unknown>;
  methodology: Record<string, unknown>;
  risks: Record<string, unknown>;
} {
  return {
    schema_version: "review-surfaces.packet.v1",
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
      evidence: []
    },
    risks: {
      summary: "schema fixture",
      items: [],
      test_evidence: [],
      test_gaps: [],
      review_focus: []
    }
  };
}
