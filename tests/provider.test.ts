import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aiMaxOutputTokens,
  aiSdkProvider,
  agentFileProvider,
  enrichPacket,
  modelOutputCeiling,
  mockProvider,
  providerFor,
  ReasoningProvider,
  resolveModel,
  StructuredResult
} from "../src/llm/provider";
import { isHypothesisOnly } from "../src/evidence/evidence";

function packet(): any {
  return {
    intent: { summary: "intent", assumptions: [] },
    evaluation: { summary: "eval" },
    methodology: { summary: "method", decisions: [] },
    risks: { summary: "risks", review_focus: [], items: [] }
  };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { review_focus: { type: "array", items: { type: "string" } } }
};

async function withEnv(key: string, value: string | undefined, callback: () => Promise<void>): Promise<void> {
  const old = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    await callback();
  } finally {
    if (old === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = old;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider abstraction
// ---------------------------------------------------------------------------

test("review-surfaces.EVIDENCE.5 mock provider is deterministic and contributes nothing by default", async () => {
  const a = await mockProvider.generateStructured("enrichment", "prompt", SCHEMA);
  const b = await mockProvider.generateStructured("reasoning", "another prompt", SCHEMA);
  assert.deepEqual(a, { ok: false, reason: "mock_no_enrichment" });
  assert.deepEqual(b, { ok: false, reason: "mock_no_enrichment" });
});

test("providerFor returns the deterministic mock by default", () => {
  assert.equal(providerFor("mock").name, "mock");
  assert.equal(providerFor("ai-sdk").name, "ai-sdk");
  assert.equal(providerFor("agent-file").name, "agent-file");
});

test("resolveModel defaults to google (Gemini first-class) and preserves provider prefixes", () => {
  assert.deepEqual(resolveModel(undefined), { provider: "google", modelId: "gemini-2.5-flash" });
  // An unprefixed model id resolves to google (the first-class default provider).
  assert.deepEqual(resolveModel("gemini-2.0-flash"), { provider: "google", modelId: "gemini-2.0-flash" });
  assert.deepEqual(resolveModel("google:gemini-2.5-flash"), { provider: "google", modelId: "gemini-2.5-flash" });
  assert.deepEqual(resolveModel("openai:gpt-4o-mini"), { provider: "openai", modelId: "gpt-4o-mini" });
  assert.deepEqual(resolveModel("anthropic:claude-3-5-haiku-latest"), {
    provider: "anthropic",
    modelId: "claude-3-5-haiku-latest"
  });
});

test("ai-sdk output-token budget is configurable and clamped for lower-ceiling models", async () => {
  await withEnv("REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS", undefined, async () => {
    assert.equal(aiMaxOutputTokens(), 8192);
  });
  await withEnv("REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS", "12000", async () => {
    assert.equal(aiMaxOutputTokens(), 12000);
  });
  await withEnv("REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS", "8192.5", async () => {
    assert.equal(aiMaxOutputTokens(), 8192);
  });
  assert.equal(modelOutputCeiling({ provider: "anthropic", modelId: "claude-3-haiku-20240307" }), 4096);
  assert.equal(modelOutputCeiling({ provider: "google", modelId: "gemini-2.5-flash" }), Number.POSITIVE_INFINITY);
});

test("review-surfaces.PRIVACY.5 ai-sdk provider honors remotePrivacyBlocked without a network call", async () => {
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
    const provider = aiSdkProvider({ remotePrivacyBlocked: true });
    const result = await provider.generateStructured("enrichment", "prompt", SCHEMA);
    assert.deepEqual(result, { ok: false, reason: "privacy_block" });
  });
});

test("ai-sdk provider skips cleanly when the selected provider key is missing", async () => {
  // Default provider is now google (Gemini first-class), so the default skip
  // reason is the missing google key.
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", undefined, async () => {
    const provider = aiSdkProvider({});
    const result = await provider.generateStructured("enrichment", "prompt", SCHEMA);
    assert.deepEqual(result, { ok: false, reason: "missing_google_api_key" });
  });
});

test("ai-sdk provider resolves the right key per provider prefix", async () => {
  await withEnv("ANTHROPIC_API_KEY", undefined, async () => {
    await withEnv("OPENAI_API_KEY", undefined, async () => {
      const result = await aiSdkProvider({ model: "openai:gpt-4o-mini" }).generateStructured("s", "p", SCHEMA);
      assert.deepEqual(result, { ok: false, reason: "missing_openai_api_key" });
    });
    await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", undefined, async () => {
      const result = await aiSdkProvider({ model: "google:gemini-2.5-flash" }).generateStructured("s", "p", SCHEMA);
      assert.deepEqual(result, { ok: false, reason: "missing_google_api_key" });
    });
  });
});

test("review-surfaces.PRIVACY.5 ai-sdk provider blocks on secret material in the prompt before any call", async () => {
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
    const pemLabel = "PRIVATE KEY";
    const prompt = `-----BEGIN ${pemLabel}-----\nabc\n-----END ${pemLabel}-----`;
    const result = await aiSdkProvider({}).generateStructured("enrichment", prompt, SCHEMA);
    assert.deepEqual(result, { ok: false, reason: "privacy_block" });
  });
});

test("review-surfaces.PRIVACY.5 disabling substitution never disables the hard prompt-secret block", async () => {
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
    let loaderCalled = false;
    const provider = aiSdkProvider({
      aiModuleLoader: async () => {
        loaderCalled = true;
        throw new Error("must not load the remote SDK");
      }
    });
    const pemLabel = "PRIVATE KEY";
    const prompt = `-----BEGIN ${pemLabel}-----\nabc\n-----END ${pemLabel}-----`;
    const result = await provider.generateStructured("enrichment", prompt, SCHEMA, {
      redactSecrets: false
    });

    assert.deepEqual(result, { ok: false, reason: "privacy_block" });
    assert.equal(loaderCalled, false);
  });
});

test("review-surfaces.PRIVACY.5 persisted blocked markers stop before the remote SDK boundary", async () => {
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
    let loaderCalled = false;
    const provider = aiSdkProvider({
      aiModuleLoader: async () => {
        loaderCalled = true;
        throw new Error("must not load the remote SDK");
      }
    });
    const markerKind = ["github", "token"].join("_");
    const prompt = `Previously sanitized input: [REDACTED:${markerKind}]`;

    const result = await provider.generateStructured("enrichment", prompt, SCHEMA, {
      redactSecrets: false
    });

    assert.deepEqual(result, { ok: false, reason: "privacy_block" });
    assert.equal(loaderCalled, false);
  });
});

test("agent-file provider returns structured data from a local file", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-agentfile-"));
  fs.writeFileSync(path.join(tmp, "agent.json"), JSON.stringify({ review_focus: ["Check evaluator"] }));
  const provider = agentFileProvider({ cwd: tmp, agentInput: "agent.json" });
  const result = await provider.generateStructured("enrichment", "prompt", SCHEMA);
  assert.equal(result.ok, true);
  assert.deepEqual((result as { ok: true; data: any }).data, { review_focus: ["Check evaluator"] });
});

test("agent-file provider supports stage-specific envelopes while preserving the flat-file fallback", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-agentfile-stages-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, "agent.json"), JSON.stringify({
    stages: {
      conversation_analysis: { summary: "analysis" },
      conversation_review_insights: { insights: [] }
    },
    review_focus: ["legacy fallback"]
  }));
  const provider = agentFileProvider({ cwd: tmp, agentInput: "agent.json" });

  const analysis = await provider.generateStructured("conversation_analysis", "prompt", SCHEMA);
  const insights = await provider.generateStructured("conversation_review_insights", "prompt", SCHEMA);
  const legacy = await provider.generateStructured("enrichment", "prompt", SCHEMA);

  assert.deepEqual(analysis, { ok: true, data: { summary: "analysis" } });
  assert.deepEqual(insights, { ok: true, data: { insights: [] } });
  assert.equal(legacy.ok, true);
  assert.deepEqual((legacy as { ok: true; data: any }).data.review_focus, ["legacy fallback"]);
});

test("agent-file provider supplies explicit repeated-stage payloads in invocation order and fails on exhaustion", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-agentfile-sequences-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, "agent.json"), JSON.stringify({
    stage_sequences: {
      conversation_analysis_chunk: [
        { summary: "window one" },
        { summary: "window two" },
        { summary: "window three" }
      ]
    },
    stages: {
      conversation_analysis: { summary: "reduced analysis" }
    },
    review_focus: ["legacy fallback"]
  }));
  const provider = agentFileProvider({ cwd: tmp, agentInput: "agent.json" });

  const chunks = await Promise.all([1, 2, 3].map(() =>
    provider.generateStructured("conversation_analysis_chunk", "prompt", SCHEMA)
  ));

  assert.deepEqual(chunks, [
    { ok: true, data: { summary: "window one" } },
    { ok: true, data: { summary: "window two" } },
    { ok: true, data: { summary: "window three" } }
  ]);
  assert.deepEqual(
    await provider.generateStructured("conversation_analysis_chunk", "prompt", SCHEMA),
    { ok: false, reason: "agent_input_stage_sequence_exhausted:conversation_analysis_chunk" }
  );
  assert.deepEqual(await provider.generateStructured("conversation_analysis", "prompt", SCHEMA), {
    ok: true,
    data: { summary: "reduced analysis" }
  });
  const legacy = await provider.generateStructured("enrichment", "prompt", SCHEMA);
  assert.equal(legacy.ok, true);
  assert.deepEqual((legacy as { ok: true; data: any }).data.review_focus, ["legacy fallback"]);
});

test("agent-file provider rejects a malformed repeated-stage sequence explicitly", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-agentfile-bad-sequence-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, "agent.json"), JSON.stringify({
    stage_sequences: { conversation_analysis_chunk: { summary: "not an array" } }
  }));

  const result = await agentFileProvider({ cwd: tmp, agentInput: "agent.json" })
    .generateStructured("conversation_analysis_chunk", "prompt", SCHEMA);

  assert.deepEqual(result, {
    ok: false,
    reason: "agent_input_stage_sequence_not_array:conversation_analysis_chunk"
  });
});

test("agent-file provider parses its immutable stage envelope once", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-agentfile-cache-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const inputPath = path.join(tmp, "agent.json");
  fs.writeFileSync(inputPath, JSON.stringify({ stages: { first: { value: 1 }, second: { value: 2 } } }));
  const provider = agentFileProvider({ cwd: tmp, agentInput: "agent.json" });

  assert.deepEqual(await provider.generateStructured("first", "prompt", SCHEMA), {
    ok: true,
    data: { value: 1 }
  });
  fs.writeFileSync(inputPath, "{ malformed after the provider run started");
  assert.deepEqual(await provider.generateStructured("second", "prompt", SCHEMA), {
    ok: true,
    data: { value: 2 }
  });
});

test("agent-file provider skips when input is missing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-agentfile-"));
  const noInput = await agentFileProvider({ cwd: tmp }).generateStructured("s", "p", SCHEMA);
  assert.deepEqual(noInput, { ok: false, reason: "missing_agent_input" });
  const notFound = await agentFileProvider({ cwd: tmp, agentInput: "nope.json" }).generateStructured("s", "p", SCHEMA);
  assert.deepEqual(notFound, { ok: false, reason: "agent_input_not_found" });
});

// ---------------------------------------------------------------------------
// enrichPacket wiring + injection seam
// ---------------------------------------------------------------------------

test("mock provider writes prompts without enrichment", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-"));
  const result = await enrichPacket(packet(), { cwd: tmp, outputDir: path.join(tmp, ".review-surfaces"), provider: "mock" });

  assert.equal(result.status, "not_requested");
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "prompts", "agent-enrichment.md")));
});

test("ai-sdk provider skips without credentials", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-"));
  // Default provider is google (Gemini first-class) -> missing google key.
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", undefined, async () => {
    const result = await enrichPacket(packet(), { cwd: tmp, outputDir: path.join(tmp, ".review-surfaces"), provider: "ai-sdk" });
    assert.equal(result.status, "skipped");
    assert.equal(result.skipped_reason, "missing_google_api_key");
  });
});

test("review-surfaces.PRIVACY.2 blocks ai-sdk enrichment when prompt contains private key material", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-privacy-"));
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
    const target = packet();
    const pemLabel = "PRIVATE KEY";
    target.intent.summary = `-----BEGIN ${pemLabel}-----\nabc\n-----END ${pemLabel}-----`;
    const result = await enrichPacket(target, { cwd: tmp, outputDir: path.join(tmp, ".review-surfaces"), provider: "ai-sdk" });
    assert.equal(result.status, "skipped");
    assert.equal(result.skipped_reason, "privacy_block");
  });
});

test("review-surfaces.PRIVACY.2 blocks ai-sdk enrichment when collected inputs were privacy-blocked", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-input-privacy-"));
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
    const result = await enrichPacket(packet(), {
      cwd: tmp,
      outputDir: path.join(tmp, ".review-surfaces"),
      provider: "ai-sdk",
      remotePrivacyBlocked: true
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.skipped_reason, "privacy_block");
  });
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

// FINDING D: an agent-file risk_summary becomes an AI-RISK item that is
// hypothesis-only. Its sole evidence ref MUST be marked llm_proposed:true so that
// isHypothesisOnly() returns true and the comment/SARIF renderers quarantine it
// into the hypotheses section instead of emitting it as a deterministic top risk.
test("review-surfaces.EVIDENCE.6 agent-file risk_summaries become hypothesis-quarantined AI-RISK items", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-airisk-"));
  fs.writeFileSync(
    path.join(tmp, "agent.json"),
    JSON.stringify({ risk_summaries: ["A possible race condition"] })
  );
  const target = packet();
  const result = await enrichPacket(target, {
    cwd: tmp,
    outputDir: path.join(tmp, ".review-surfaces"),
    provider: "agent-file",
    agentInput: "agent.json"
  });

  assert.equal(result.status, "applied");
  assert.equal(target.risks.items.length, 1, "the risk_summary produced exactly one AI-RISK item");
  const aiRisk = target.risks.items[0];
  assert.match(aiRisk.id, /^AI-RISK-/, "the appended risk uses the AI-RISK id prefix");
  assert.equal(aiRisk.evidence.length, 1, "the AI-RISK carries a single hypothesis evidence ref");
  assert.equal(
    aiRisk.evidence[0].llm_proposed,
    true,
    "the AI-RISK evidence ref must be marked llm_proposed so it is treated as a hypothesis"
  );
  assert.equal(
    isHypothesisOnly(aiRisk.evidence),
    true,
    "isHypothesisOnly() must quarantine the AI-RISK away from deterministic findings"
  );
});

test("review-surfaces.PRIVACY.2 agent-file enrichment redacts secrets before merging into packet fields", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-redact-"));
  // A local agent file that accidentally carries credentials in every merged
  // field category. None of the raw secret material may reach the packet.
  fs.writeFileSync(
    path.join(tmp, "agent.json"),
    JSON.stringify({
      review_focus: ["Audit auth path; API_KEY=sk-supersecretvalue123 was hardcoded"],
      assumptions: ["Shared key AIzaSyA1234567890abcdefghijklmnopqrstuv is committed"],
      methodology_decisions: ["password=hunter2hunter2 stored in env"],
      risk_summaries: ["SECRET=topsecretvalue9999 leaks in logs"]
    })
  );
  const target = packet();
  const result = await enrichPacket(target, {
    cwd: tmp,
    outputDir: path.join(tmp, ".review-surfaces"),
    provider: "agent-file",
    agentInput: "agent.json"
  });

  assert.equal(result.status, "applied");

  const serialized = JSON.stringify(target);
  // The raw secret values must NOT survive into the packet.
  assert.ok(!serialized.includes("sk-supersecretvalue123"), "API key value redacted");
  assert.ok(!serialized.includes("AIzaSyA1234567890abcdefghijklmnopqrstuv"), "google key redacted");
  assert.ok(!serialized.includes("hunter2hunter2"), "password value redacted");
  assert.ok(!serialized.includes("topsecretvalue9999"), "risk secret value redacted");
  // The redaction markers prove the boundary ran on each field category.
  assert.match(target.risks.review_focus[0], /\[REDACTED:secret\]/);
  assert.match(target.intent.assumptions[0], /\[REDACTED:google_api_key\]/);
  assert.match(target.methodology.decisions[0], /\[REDACTED:secret\]/);
  assert.match(target.risks.items[0].summary, /\[REDACTED:secret\]/);
});

test("enrichPacket accepts an injected provider factory (test seam) with no network", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-seam-"));
  let receivedSchema: object | undefined;
  const fakeProvider: ReasoningProvider = {
    name: "ai-sdk",
    async generateStructured(_stage, _prompt, schema): Promise<StructuredResult> {
      receivedSchema = schema;
      return { ok: true, data: { review_focus: ["Injected focus"] } };
    }
  };
  const target = packet();
  const result = await enrichPacket(target, {
    cwd: tmp,
    outputDir: path.join(tmp, ".review-surfaces"),
    provider: "ai-sdk",
    providerFactory: () => fakeProvider
  });

  assert.equal(result.status, "applied");
  assert.deepEqual(target.risks.review_focus, ["Injected focus"]);
  assert.ok(receivedSchema && typeof receivedSchema === "object", "schema is passed to the provider");
});

test("enrichPacket surfaces an injected non-ok ai-sdk result as a failure", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-seam-"));
  const fakeProvider: ReasoningProvider = {
    name: "ai-sdk",
    async generateStructured(): Promise<StructuredResult> {
      return { ok: false, reason: "ai_sdk_error: boom" };
    }
  };
  const result = await enrichPacket(packet(), {
    cwd: tmp,
    outputDir: path.join(tmp, ".review-surfaces"),
    provider: "ai-sdk",
    providerFactory: () => fakeProvider
  });

  assert.equal(result.status, "failed");
  assert.equal(result.skipped_reason, "ai_sdk_error: boom");
});

// ---------------------------------------------------------------------------
// R3.3: live ai-sdk branch via the injected aiModuleLoader seam. These exercise
// the REAL aiSdkProvider code path (redaction, key check, generateObject call,
// abort timeout) with NO network and NO real ai/@ai-sdk packages installed.
// ---------------------------------------------------------------------------

// A fake ai-sdk module map for aiModuleLoader. `ai` carries generateObject +
// jsonSchema; `@ai-sdk/google` carries createGoogleGenerativeAI returning a model
// factory (google/Gemini is the first-class default provider). The loader is
// keyed by module name exactly as the real import is.
function fakeAiLoader(generateObject: (args: any) => Promise<any>): (moduleName: string) => Promise<any> {
  return async (moduleName: string) => {
    if (moduleName === "ai") {
      return { generateObject, jsonSchema: (schema: object) => schema };
    }
    if (moduleName === "@ai-sdk/google") {
      return { createGoogleGenerativeAI: () => () => ({}) };
    }
    throw new Error(`unexpected module ${moduleName}`);
  };
}

test("ai-sdk live branch applies prompt substitution only when requested", async () => {
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
    const assignmentName = ["SERVICE", "TOKEN"].join("_");
    const assignmentValue = ["local", "fixture", "credential", "12345"].join("-");
    const rawPrompt = `Review this configuration: ${assignmentName}=${assignmentValue}`;
    const observedPrompts: string[] = [];
    const provider = aiSdkProvider({
      aiModuleLoader: fakeAiLoader(async (args) => {
        observedPrompts.push(args.prompt);
        return { object: { review_focus: ["X"] } };
      })
    });

    const redacted = await provider.generateStructured("enrichment", rawPrompt, SCHEMA, {
      redactSecrets: true
    });
    const unredacted = await provider.generateStructured("enrichment", rawPrompt, SCHEMA, {
      redactSecrets: false
    });

    assert.deepEqual(redacted, { ok: true, data: { review_focus: ["X"] } });
    assert.deepEqual(unredacted, { ok: true, data: { review_focus: ["X"] } });
    assert.deepEqual(observedPrompts, [
      `Review this configuration: ${assignmentName}=[REDACTED:secret]`,
      rawPrompt
    ]);
    assert.doesNotMatch(observedPrompts[0], new RegExp(assignmentValue));
    assert.match(observedPrompts[1], new RegExp(assignmentValue));
  });
});

test("ai-sdk live branch applies enrichment when generateObject resolves an object", async () => {
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
    const provider = aiSdkProvider({
      aiModuleLoader: fakeAiLoader(async () => ({ object: { review_focus: ["X"] } }))
    });
    const result = await provider.generateStructured("enrichment", "prompt", SCHEMA);
    assert.deepEqual(result, { ok: true, data: { review_focus: ["X"] } });
  });
});

test("ai-sdk live branch maps a thrown SDK error to ai_sdk_error", async () => {
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
    const provider = aiSdkProvider({
      aiModuleLoader: fakeAiLoader(async () => {
        throw new Error("boom");
      })
    });
    const result = await provider.generateStructured("enrichment", "prompt", SCHEMA);
    assert.equal(result.ok, false);
    const reason = (result as { ok: false; reason: string }).reason;
    assert.ok(reason.startsWith("ai_sdk_error:"), reason);
    assert.match(reason, /boom/);
  });
});

test("ai-sdk live branch returns a non-object verbatim; enrich layer classifies it invalid", async () => {
  // The provider itself only forwards generateObject's .object — invalid-output
  // classification is the enrich layer's job. First the provider level:
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
    const provider = aiSdkProvider({
      aiModuleLoader: fakeAiLoader(async () => ({ object: 42 }))
    });
    const result = await provider.generateStructured("enrichment", "prompt", SCHEMA);
    assert.deepEqual(result, { ok: true, data: 42 });
  });

  // Then the enrich layer: a non-object payload becomes failed/invalid_ai_output,
  // reusing the existing providerFactory seam so no network/packages are needed.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-provider-invalid-"));
  const fakeProvider: ReasoningProvider = {
    name: "ai-sdk",
    async generateStructured(): Promise<StructuredResult> {
      return { ok: true, data: 42 };
    }
  };
  const result = await enrichPacket(packet(), {
    cwd: tmp,
    outputDir: path.join(tmp, ".review-surfaces"),
    provider: "ai-sdk",
    providerFactory: () => fakeProvider
  });
  assert.equal(result.status, "failed");
  assert.equal(result.skipped_reason, "invalid_ai_output");
});

test("ai-sdk live branch aborts on the timeout and maps it to ai_sdk_error", async () => {
  await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
    await withEnv("REVIEW_SURFACES_AI_TIMEOUT_MS", "10", async () => {
      const provider = aiSdkProvider({
        aiModuleLoader: fakeAiLoader(
          ({ abortSignal }: { abortSignal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              abortSignal.addEventListener("abort", () => reject(new Error("aborted")));
            })
        )
      });
      const result = await provider.generateStructured("enrichment", "prompt", SCHEMA);
      assert.equal(result.ok, false);
      assert.ok((result as { ok: false; reason: string }).reason.startsWith("ai_sdk_error:"));
    });
  });
});
