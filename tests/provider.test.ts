import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enrichPacket } from "../src/llm/provider";

function packet(): any {
  return {
    intent: { summary: "intent", assumptions: [] },
    evaluation: { summary: "eval" },
    methodology: { summary: "method", decisions: [] },
    risks: { summary: "risks", review_focus: [], items: [] }
  };
}

test("mock provider writes prompts without enrichment", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-"));
  const result = await enrichPacket(packet(), { cwd: tmp, outputDir: path.join(tmp, ".review-surfaces"), provider: "mock" });

  assert.equal(result.status, "not_requested");
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "prompts", "agent-enrichment.md")));
});

test("ai-sdk provider skips without credentials", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-"));
  const oldKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  try {
    const result = await enrichPacket(packet(), { cwd: tmp, outputDir: path.join(tmp, ".review-surfaces"), provider: "ai-sdk" });
    assert.equal(result.status, "skipped");
    assert.equal(result.skipped_reason, "missing_google_api_key");
  } finally {
    if (oldKey !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = oldKey;
  }
});

test("review-surfaces.PRIVACY.2 blocks ai-sdk enrichment when prompt contains private key material", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-privacy-"));
  const oldKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
  try {
    const target = packet();
    const pemLabel = "PRIVATE KEY";
    target.intent.summary = `-----BEGIN ${pemLabel}-----\nabc\n-----END ${pemLabel}-----`;
    const result = await enrichPacket(target, { cwd: tmp, outputDir: path.join(tmp, ".review-surfaces"), provider: "ai-sdk" });
    assert.equal(result.status, "skipped");
    assert.equal(result.skipped_reason, "privacy_block");
  } finally {
    if (oldKey === undefined) {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    } else {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = oldKey;
    }
  }
});

test("review-surfaces.PRIVACY.2 blocks ai-sdk enrichment when collected inputs were privacy-blocked", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-input-privacy-"));
  const oldKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
  try {
    const result = await enrichPacket(packet(), {
      cwd: tmp,
      outputDir: path.join(tmp, ".review-surfaces"),
      provider: "ai-sdk",
      remotePrivacyBlocked: true
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.skipped_reason, "privacy_block");
  } finally {
    if (oldKey === undefined) {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    } else {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = oldKey;
    }
  }
});

test("agent-file provider applies bounded structured enrichment", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-"));
  fs.writeFileSync(
    path.join(tmp, "agent.json"),
    JSON.stringify({ review_focus: ["Check evaluator"], assumptions: ["Agent hypothesis only"], risk_summaries: ["Possible weak evidence"] })
  );
  const target = packet();
  const result = await enrichPacket(target, {
    cwd: tmp,
    outputDir: path.join(tmp, ".review-surfaces"),
    provider: "agent-file",
    agentInput: "agent.json"
  });

  assert.equal(result.status, "applied");
  assert.deepEqual(target.risks.review_focus, ["Check evaluator"]);
  assert.deepEqual(target.intent.assumptions, ["Agent hypothesis only"]);
  assert.equal(target.risks.items.length, 1);
});
