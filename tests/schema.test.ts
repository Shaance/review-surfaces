import test from "node:test";
import assert from "node:assert/strict";
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
