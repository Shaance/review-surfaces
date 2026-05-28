import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReviewPacket, PacketInputs, ReviewPacket, rewriteReviewPacket } from "../src/render/packet";

test("review-surfaces.PRIVACY.2 redacts methodology claims when rendering packet markdown", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-render-redact-"));
  const packet: ReviewPacket = {
    schema_version: "review-surfaces.packet.v1",
    manifest: {},
    intent: {
      summary: "render fixture",
      requirements: [],
      constraints: [],
      non_goals: [],
      assumptions: [],
      open_questions: [],
      sources: []
    },
    evaluation: {
      summary: "render fixture",
      results: [],
      overreach: [],
      acai_coverage: {}
    },
    architecture: {
      summary: "render fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "render fixture",
      missing_logs: false,
      considered: [],
      research: [],
      decisions: [],
      unchallenged_assumptions: [],
      skipped_checks: [],
      claims_without_evidence: ["evt_raw: SECRET_TOKEN=abc123456 tests are green"],
      verified_claims: ["evt_raw: API_KEY=abc123456 pnpm run test passed"],
      quality_flags: [],
      evidence: []
    },
    risks: {
      summary: "render fixture",
      items: [],
      test_evidence: [],
      test_gaps: [],
      review_focus: []
    }
  };

  await rewriteReviewPacket(tmp, packet);

  const markdown = fs.readFileSync(path.join(tmp, "review_packet.md"), "utf8");
  assert.doesNotMatch(markdown, /abc123456/);
  assert.match(markdown, /SECRET_TOKEN=\[REDACTED:secret\]/);
  assert.match(markdown, /API_KEY=\[REDACTED:secret\]/);
});

test("review-surfaces.PRIVACY.2 redacts and prioritizes generated handoff validation summaries", () => {
  const packet = createReviewPacket({
    collection: {
      manifest: { milestone: "M5" },
      changedFiles: []
    },
    intent: {
      summary: "render fixture",
      requirements: [],
      constraints: [],
      non_goals: [],
      assumptions: [],
      open_questions: [],
      sources: []
    },
    evaluation: {
      summary: "render fixture",
      results: [],
      overreach: [],
      acai_coverage: {}
    },
    architecture: {
      summary: "render fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "render fixture",
      missing_logs: false,
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
      summary: "render fixture",
      items: [],
      test_gaps: [],
      review_focus: [],
      test_evidence: [
        {
          id: "TEST-DIRECT-SECRET",
          kind: "direct",
          summary: "Command transcript captured API_KEY=abc123456 pnpm run test.",
          evidence: [{ kind: "command", command: "pnpm run test", confidence: "high" }]
        },
        ...Array.from({ length: 6 }, (_value, index) => ({
          id: `TEST-CLAIM-${index + 1}`,
          kind: "claimed" as const,
          summary: `Feedback records a passing validation command: pnpm run lint:${index + 1}`,
          evidence: [{ kind: "feedback" as const, path: ".review-surfaces/feedback/manual.yaml", confidence: "medium" as const }]
        })),
        {
          id: "TEST-FAILED-SECRET",
          kind: "missing",
          summary: "Feedback records a failing validation command: SECRET_TOKEN=abc123456 pnpm run build",
          evidence: [{ kind: "feedback", path: ".review-surfaces/feedback/manual.yaml", confidence: "medium" }]
        }
      ]
    },
    dogfood: {
      milestone: "M5",
      summary: "dogfood fixture",
      findings: []
    },
    enrichment: {
      provider: "mock",
      status: "skipped"
    },
    commands: []
  } as unknown as PacketInputs);

  assert.ok(packet.agent_handoff?.validation_evidence?.some((item) => item.includes("API_KEY=[REDACTED:secret]")));
  assert.ok(packet.agent_handoff?.failed_validation?.[0].includes("TEST-FAILED-SECRET"));
  assert.ok(packet.agent_handoff?.failed_validation?.some((item) => item.includes("SECRET_TOKEN=[REDACTED:secret]")));
  assert.ok(!packet.agent_handoff?.validation_evidence?.some((item) => item.includes("abc123456")));
  assert.ok(!packet.agent_handoff?.failed_validation?.some((item) => item.includes("abc123456")));
});
