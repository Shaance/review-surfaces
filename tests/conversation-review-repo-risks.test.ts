import test from "node:test";
import assert from "node:assert/strict";
import { conversationReviewRisksFromPacket } from "../src/cli/conversation-review-risks";
import type { RisksModel } from "../src/risks/risks";

test("repo conversation risk adapter keeps deterministic risks and quarantines hypothesis-only risks", () => {
  const risks: RisksModel = {
    summary: "Mixed deterministic and hypothesis-only risks.",
    items: [{
      id: "RISK-DET-001",
      category: "correctness",
      severity: "high",
      summary: "Retry behavior changed without equivalent coverage.",
      evidence: [{
        kind: "diff",
        path: "src/retry.ts",
        confidence: "high",
        validation_status: "valid"
      }]
    }, {
      id: "RISK-NO-EVIDENCE",
      category: "workflow",
      severity: "medium",
      summary: "A deterministic workflow finding has no attached evidence yet."
    }, {
      id: "AI-RISK-001",
      category: "correctness",
      severity: "medium",
      summary: "An agent proposed this risk without deterministic backing.",
      evidence: [{
        kind: "file",
        path: "src/retry.ts",
        note: "LLM-proposed: inspect this path.",
        confidence: "low",
        validation_status: "not_checked",
        llm_proposed: true
      }]
    }],
    test_evidence: [],
    test_gaps: [],
    review_focus: []
  };

  assert.deepEqual(conversationReviewRisksFromPacket(risks), {
    candidates: [{
      id: "RISK-DET-001",
      rule: "packet:correctness",
      severity: "high",
      summary: "Retry behavior changed without equivalent coverage.",
      evidence: [{
        kind: "diff",
        path: "src/retry.ts",
        confidence: "high",
        validation_status: "valid"
      }]
    }, {
      id: "RISK-NO-EVIDENCE",
      rule: "packet:workflow",
      severity: "medium",
      summary: "A deterministic workflow finding has no attached evidence yet.",
      evidence: []
    }]
  });
});
