import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReviewPacket, rewriteReviewPacket } from "../src/render/packet";

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
