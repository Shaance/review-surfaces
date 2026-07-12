import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MethodologyModel } from "../src/methodology/methodology";
import { loadMethodology } from "../src/render/load";
import { writeMethodologyArtifact } from "../src/render/packet";
import { validateJsonSchema } from "../src/schema/json-schema";
import { minimalReviewPacket } from "./helpers/review-packet";

const packetSchema = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "schemas", "review_packet.schema.json"),
  "utf8"
));

function methodology(
  discovery?: NonNullable<MethodologyModel["conversation_discovery"]>
): MethodologyModel {
  return {
    summary: "Conversation discovery fixture.",
    missing_logs: discovery?.status !== "admitted",
    considered: [],
    research: [],
    decisions: [],
    unchallenged_assumptions: [],
    skipped_checks: [],
    claims_without_evidence: [],
    verified_claims: [],
    quality_flags: [],
    evidence: [],
    workflow_findings: [],
    ...(discovery ? { conversation_discovery: discovery } : {})
  };
}

test("review-surfaces.CONVERSATION_REVIEW.7 discovery provenance survives writer, schema, and loader boundaries", async () => {
  const variants: Array<NonNullable<MethodologyModel["conversation_discovery"]>> = [{
    status: "admitted",
    confidence: "high",
    ambiguous: false,
    mutated_changed_files: 3,
    weak_matched_files: 1,
    reason_codes: ["exact_changed_path_mutation", "reviewed_commit_observed"]
  }, {
    status: "rejected",
    confidence: "low",
    ambiguous: true,
    mutated_changed_files: 1,
    weak_matched_files: 2,
    reason_codes: ["exact_changed_path_mutation", "ambiguous_producer_candidates"]
  }];

  for (const discovery of variants) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-discovery-persist-"));
    try {
      const model = methodology(discovery);
      await writeMethodologyArtifact(outputDir, model);
      assert.deepEqual(loadMethodology(outputDir), model);

      const packet = minimalReviewPacket();
      packet.methodology = model as unknown as Record<string, unknown>;
      const validation = validateJsonSchema(packetSchema, packet);
      assert.equal(validation.valid, true, JSON.stringify(validation.issues));
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 legacy methodology may omit discovery provenance", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-discovery-legacy-"));
  try {
    const legacy = methodology();
    await writeMethodologyArtifact(outputDir, legacy);
    const loaded = loadMethodology(outputDir);
    assert.deepEqual(loaded, legacy);
    assert.equal(loaded?.conversation_discovery, undefined);

    const packet = minimalReviewPacket();
    packet.methodology = legacy as unknown as Record<string, unknown>;
    const validation = validateJsonSchema(packetSchema, packet);
    assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
