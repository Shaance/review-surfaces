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
import { VERSION } from "../src/core/version";
import { fullyPopulatedReviewPacket, minimalReviewPacket } from "./helpers/review-packet";

const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "review_packet.schema.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };

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

// Ties the runtime VERSION constant into the packet contract: the manifest's
// tool_version is stamped from VERSION, and VERSION tracks package.json. (The
// raw VERSION === package.json check also lives in version.test.ts; here it
// guards the contract surface — the populated fixture's tool_version — directly.)
test("VERSION is in sync with package.json and stamps the fixture's manifest tool_version", () => {
  assert.equal(VERSION, packageJson.version);
  assert.equal((fullyPopulatedReviewPacket().manifest as { tool_version: string }).tool_version, VERSION);
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
