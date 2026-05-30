import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateJsonSchema } from "../src/schema/json-schema";
import { minimalReviewPacket } from "./helpers/review-packet";

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

test("review-surfaces.SCHEMA.2 validates methodology and handoff M5 metadata", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "review_packet.schema.json"), "utf8"));
  const packet = minimalReviewPacket();
  packet.methodology.verified_claims = ["evt_0001: pnpm run test passed"];
  packet.methodology.quality_flags = ["test_claims_verified_by_command_transcripts"];
  packet.agent_handoff = {
    summary: "handoff fixture",
    current_milestone: "M5",
    relevant_acids: ["review-surfaces.METHODOLOGY.5"],
    implemented_changes: ["M src/methodology/methodology.ts"],
    commands_to_run: ["pnpm run test"],
    validation_evidence: ["TEST-TR-001 [direct]: Command transcript CMD-PNPM-TEST records exit 0"],
    failed_validation: [],
    methodology_flags: ["verified_claims_available"],
    next_tasks: ["Inspect packet"],
    open_risks: [],
    deferrals: ["Provider comments remain deferred"],
    artifact_paths: [".review-surfaces/review_packet.md"]
  };

  assert.equal(validateJsonSchema(schema, packet).valid, true);

  const staleMethodologyPacket = minimalReviewPacket();
  delete staleMethodologyPacket.methodology.verified_claims;
  delete staleMethodologyPacket.methodology.quality_flags;
  const invalidMethodology = validateJsonSchema(schema, staleMethodologyPacket);
  assert.equal(invalidMethodology.valid, false);
  assert.ok(invalidMethodology.issues.some((issue) => issue.path === "$.methodology" && issue.message.includes("verified_claims")));
  assert.ok(invalidMethodology.issues.some((issue) => issue.path === "$.methodology" && issue.message.includes("quality_flags")));

  const staleHandoffPacket = minimalReviewPacket();
  staleHandoffPacket.agent_handoff = {
    summary: "stale handoff fixture",
    next_tasks: ["Inspect packet"]
  };
  const invalidHandoff = validateJsonSchema(schema, staleHandoffPacket);
  assert.equal(invalidHandoff.valid, false);
  assert.ok(invalidHandoff.issues.some((issue) => issue.path === "$.agent_handoff" && issue.message.includes("validation_evidence")));
  assert.ok(invalidHandoff.issues.some((issue) => issue.path === "$.agent_handoff" && issue.message.includes("deferrals")));
});

test("review-surfaces.RISK.4 requires first-class missing-check lists in packet schema", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "review_packet.schema.json"), "utf8"));
  const packet = minimalReviewPacket();

  assert.equal(validateJsonSchema(schema, packet).valid, true);

  const stalePacket = minimalReviewPacket();
  delete stalePacket.risks.missing_automatic_tests;
  delete stalePacket.risks.missing_manual_checks;
  const invalid = validateJsonSchema(schema, stalePacket);

  assert.equal(invalid.valid, false);
  assert.ok(
    invalid.issues.some(
      (issue) => issue.path === "$.risks" && issue.message.includes("missing_automatic_tests")
    )
  );
  assert.ok(
    invalid.issues.some((issue) => issue.path === "$.risks" && issue.message.includes("missing_manual_checks"))
  );
});
