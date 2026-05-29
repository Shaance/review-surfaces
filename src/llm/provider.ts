import path from "node:path";
import { fileExists, readText, writeJson, writeText } from "../core/files";
import { parseYaml } from "../core/simple-yaml";
import { redactSecrets } from "../privacy/secrets";
import { ReviewPacket } from "../render/packet";

export type ProviderName = "mock" | "ai-sdk" | "agent-file";

/**
 * Structured reasoning result. A non-ok result means "no LLM contribution":
 * Phase 3-2 reasoning stages treat it as a skip and keep the deterministic
 * result, so the offline pipeline stays byte-stable.
 */
export type StructuredResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: string };

export interface GenerateStructuredOptions {
  /** When false, skip deterministic prompt redaction before a real call. */
  redactSecrets?: boolean;
  /** Hard privacy block: never send the prompt to a remote provider. */
  remotePrivacyBlocked?: boolean;
}

/**
 * Schema-bound reasoning provider. Implementations MUST return a non-ok result
 * (never throw) when they cannot contribute, so callers can fall back to the
 * deterministic packet. `schema` is a JSON Schema object the output is bound to.
 */
export interface ReasoningProvider {
  name: ProviderName;
  generateStructured(
    stage: string,
    prompt: string,
    schema: object,
    opts?: GenerateStructuredOptions
  ): Promise<StructuredResult>;
}

export interface ProviderFactoryOptions {
  model?: string;
  cwd?: string;
  remotePrivacyBlocked?: boolean;
  agentInput?: string;
}

/** Optional injection seam used by the reasoning entry points and tests. */
export type ProviderFactory = (name: ProviderName, options: ProviderFactoryOptions) => ReasoningProvider;

const ANTHROPIC_DEFAULT_MODEL = "claude-3-5-haiku-latest";
const GOOGLE_DEFAULT_MODEL = "gemini-2.5-flash";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

interface ResolvedModel {
  provider: "anthropic" | "google" | "openai";
  modelId: string;
}

/**
 * The deterministic default. Mock NEVER fabricates reasoning or evidence, so
 * the offline pipeline stays byte-stable and the deterministic packet is
 * unchanged.
 */
export const mockProvider: ReasoningProvider = {
  name: "mock",
  async generateStructured(): Promise<StructuredResult> {
    return { ok: false, reason: "mock_no_enrichment" };
  }
};

/**
 * Reads bounded structured hypotheses from a local JSON/YAML file produced by a
 * coding agent. No network access. Phase 3-2 stages can use the returned data
 * but must still validate it against deterministic evidence before trusting it.
 */
export function agentFileProvider(options: ProviderFactoryOptions): ReasoningProvider {
  const cwd = options.cwd ?? process.cwd();
  return {
    name: "agent-file",
    async generateStructured(): Promise<StructuredResult> {
      if (!options.agentInput) {
        return { ok: false, reason: "missing_agent_input" };
      }
      const inputPath = path.resolve(cwd, options.agentInput);
      if (!fileExists(inputPath)) {
        return { ok: false, reason: "agent_input_not_found" };
      }
      try {
        const parsed = await readStructuredFile(inputPath);
        if (!isRecord(parsed)) {
          return { ok: false, reason: "agent_input_not_object" };
        }
        return { ok: true, data: parsed };
      } catch (error) {
        return { ok: false, reason: `agent_input_parse_error: ${errorMessage(error)}` };
      }
    }
  };
}

/**
 * Real, schema-bound provider generalized beyond Google. Resolves provider+model
 * from a "provider:model" string and binds output to the supplied JSON Schema via
 * ai's generateObject + jsonSchema. Returns a non-ok result (never throws) when
 * the provider package or API key is missing, when privacy blocks the call, or
 * when generation fails.
 */
export function aiSdkProvider(options: ProviderFactoryOptions): ReasoningProvider {
  return {
    name: "ai-sdk",
    async generateStructured(
      _stage: string,
      prompt: string,
      schema: object,
      opts?: GenerateStructuredOptions
    ): Promise<StructuredResult> {
      const privacyBlocked = opts?.remotePrivacyBlocked ?? options.remotePrivacyBlocked;
      if (privacyBlocked) {
        return { ok: false, reason: "privacy_block" };
      }

      const resolved = resolveModel(options.model);
      const apiKey = apiKeyFor(resolved.provider);
      if (!apiKey) {
        return { ok: false, reason: `missing_${resolved.provider}_api_key` };
      }

      // ALWAYS redact (unless explicitly disabled) before any real call.
      const safe = opts?.redactSecrets === false
        ? { text: prompt, redactions: [], blocked: false }
        : redactSecrets(prompt);
      if (safe.blocked) {
        return { ok: false, reason: "privacy_block" };
      }

      try {
        const dynamicImport = new Function("moduleName", "return import(moduleName)") as (
          moduleName: string
        ) => Promise<any>;
        const ai = await dynamicImport("ai");
        if (typeof ai.generateObject !== "function" || typeof ai.jsonSchema !== "function") {
          return { ok: false, reason: "ai_sdk_api_unavailable" };
        }

        const model = await resolveLanguageModel(dynamicImport, resolved, apiKey);
        if (!model.ok) {
          return { ok: false, reason: model.reason };
        }

        const result = await ai.generateObject({
          model: model.model,
          schema: ai.jsonSchema(schema),
          prompt: safe.text
        });
        return { ok: true, data: result.object };
      } catch (error) {
        return { ok: false, reason: `ai_sdk_error: ${errorMessage(error)}` };
      }
    }
  };
}

/** Resolve a ReasoningProvider for the requested name. */
export function providerFor(name: ProviderName, options: ProviderFactoryOptions = {}): ReasoningProvider {
  switch (name) {
    case "mock":
      return mockProvider;
    case "agent-file":
      return agentFileProvider(options);
    case "ai-sdk":
      return aiSdkProvider(options);
    default:
      return mockProvider;
  }
}

/**
 * Parse a "--model <provider>:<model>" string. Unknown/absent provider prefixes
 * default to anthropic with a sensible default model. google:/openai: prefixes
 * are preserved (including the historical google: handling).
 */
export function resolveModel(model: string | undefined): ResolvedModel {
  const envModel = process.env.REVIEW_SURFACES_AI_MODEL;
  const raw = (model ?? envModel ?? "").trim();
  if (!raw) {
    return { provider: "anthropic", modelId: ANTHROPIC_DEFAULT_MODEL };
  }

  const separator = raw.indexOf(":");
  if (separator === -1) {
    return { provider: "anthropic", modelId: raw };
  }

  const prefix = raw.slice(0, separator).toLowerCase();
  const rest = raw.slice(separator + 1).trim();
  switch (prefix) {
    case "google":
      return { provider: "google", modelId: rest || GOOGLE_DEFAULT_MODEL };
    case "openai":
      return { provider: "openai", modelId: rest || OPENAI_DEFAULT_MODEL };
    case "anthropic":
      return { provider: "anthropic", modelId: rest || ANTHROPIC_DEFAULT_MODEL };
    default:
      // No recognized provider prefix (e.g. a bare model id that happens to
      // contain a colon): default to anthropic, keep the full id.
      return { provider: "anthropic", modelId: raw };
  }
}

function apiKeyFor(provider: ResolvedModel["provider"]): string | undefined {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "google":
      return process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    default:
      return undefined;
  }
}

type ModelResolution = { ok: true; model: unknown } | { ok: false; reason: string };

async function resolveLanguageModel(
  dynamicImport: (moduleName: string) => Promise<any>,
  resolved: ResolvedModel,
  apiKey: string
): Promise<ModelResolution> {
  try {
    switch (resolved.provider) {
      case "anthropic": {
        const mod = await dynamicImport("@ai-sdk/anthropic");
        const create = mod.createAnthropic;
        if (typeof create !== "function") {
          return { ok: false, reason: "anthropic_provider_unavailable" };
        }
        return { ok: true, model: create({ apiKey })(resolved.modelId) };
      }
      case "google": {
        const mod = await dynamicImport("@ai-sdk/google");
        const create = mod.createGoogleGenerativeAI;
        if (typeof create !== "function") {
          return { ok: false, reason: "google_provider_unavailable" };
        }
        return { ok: true, model: create({ apiKey })(resolved.modelId) };
      }
      case "openai": {
        const mod = await dynamicImport("@ai-sdk/openai");
        const create = mod.createOpenAI;
        if (typeof create !== "function") {
          return { ok: false, reason: "openai_provider_unavailable" };
        }
        return { ok: true, model: create({ apiKey })(resolved.modelId) };
      }
      default:
        return { ok: false, reason: "unknown_provider" };
    }
  } catch (error) {
    return { ok: false, reason: `provider_package_missing: ${errorMessage(error)}` };
  }
}

// ---------------------------------------------------------------------------
// Existing packet enrichment path (kept working; the abstraction above is the
// headline). enrichPacket now delegates the real call through the provider
// interface so there is a single schema-bound code path.
// ---------------------------------------------------------------------------

export interface EnrichmentOptions {
  cwd: string;
  provider: ProviderName;
  model?: string;
  agentInput?: string;
  outputDir: string;
  redactSecrets?: boolean;
  remotePrivacyBlocked?: boolean;
  /** Injection seam: override how providers are constructed (tests, 3-2). */
  providerFactory?: ProviderFactory;
}

export interface EnrichmentResult {
  provider: ProviderName;
  model?: string;
  status: "not_requested" | "applied" | "skipped" | "failed";
  summary: string;
  skipped_reason?: string;
}

export function parseProviderName(provider: string | undefined): ProviderName {
  if (provider === "mock" || provider === "ai-sdk" || provider === "agent-file") {
    return provider;
  }
  throw new Error(`Unsupported provider: ${provider ?? "undefined"}`);
}

interface AgentFileEnrichment {
  review_focus?: string[];
  assumptions?: string[];
  methodology_decisions?: string[];
  risk_summaries?: string[];
}

const ENRICHMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    review_focus: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    methodology_decisions: { type: "array", items: { type: "string" } },
    risk_summaries: { type: "array", items: { type: "string" } }
  }
} as const;

export async function enrichPacket(packet: ReviewPacket, options: EnrichmentOptions): Promise<EnrichmentResult> {
  await writePrompts(options.outputDir);

  const factory = options.providerFactory ?? providerFor;
  const provider = factory(options.provider, {
    model: options.model,
    cwd: options.cwd,
    remotePrivacyBlocked: options.remotePrivacyBlocked,
    agentInput: options.agentInput
  });

  if (provider.name === "mock") {
    return {
      provider: "mock",
      status: "not_requested",
      summary: "Mock provider selected; deterministic packet was not LLM-enriched."
    };
  }

  if (provider.name === "agent-file") {
    return enrichFromAgentFile(packet, options, provider);
  }

  return enrichFromAiSdk(packet, options, provider);
}

async function enrichFromAgentFile(
  packet: ReviewPacket,
  options: EnrichmentOptions,
  provider: ReasoningProvider
): Promise<EnrichmentResult> {
  const result = await provider.generateStructured("enrichment", enrichmentPrompt(packet), ENRICHMENT_SCHEMA);
  if (!result.ok) {
    return {
      provider: "agent-file",
      status: "skipped",
      summary: agentFileSkipSummary(result.reason, options.agentInput),
      skipped_reason: result.reason
    };
  }

  const enrichment = isRecord(result.data) ? (result.data as AgentFileEnrichment) : {};
  mergeEnrichment(packet, enrichment);
  return {
    provider: "agent-file",
    status: "applied",
    summary: `Applied bounded agent-file enrichment from ${options.agentInput}.`
  };
}

function agentFileSkipSummary(reason: string, agentInput: string | undefined): string {
  switch (reason) {
    case "missing_agent_input":
      return "Agent-file provider skipped because --agent-input was not provided.";
    case "agent_input_not_found":
      return `Agent-file provider skipped because ${agentInput} does not exist.`;
    default:
      return `Agent-file provider skipped: ${reason}.`;
  }
}

async function enrichFromAiSdk(
  packet: ReviewPacket,
  options: EnrichmentOptions,
  provider: ReasoningProvider
): Promise<EnrichmentResult> {
  const rawPrompt = enrichmentPrompt(packet);
  const result = await provider.generateStructured("enrichment", rawPrompt, ENRICHMENT_SCHEMA, {
    redactSecrets: options.redactSecrets,
    remotePrivacyBlocked: options.remotePrivacyBlocked
  });

  if (!result.ok) {
    return aiSdkNonOkResult(result.reason, options.model);
  }

  if (isRecord(result.data)) {
    mergeEnrichment(packet, result.data as AgentFileEnrichment);
    return {
      provider: "ai-sdk",
      model: options.model,
      status: "applied",
      summary: `Applied AI SDK enrichment using ${options.model ?? "default model"}.`
    };
  }

  return {
    provider: "ai-sdk",
    model: options.model,
    status: "failed",
    summary: "AI SDK returned non-object enrichment; deterministic packet was preserved.",
    skipped_reason: "invalid_ai_output"
  };
}

function aiSdkNonOkResult(reason: string, model: string | undefined): EnrichmentResult {
  // Privacy blocks and missing credentials are intentional skips; anything else
  // is a failure but the deterministic packet is always preserved.
  const skipReasons = new Set([
    "privacy_block",
    "missing_anthropic_api_key",
    "missing_google_api_key",
    "missing_openai_api_key"
  ]);
  const status = skipReasons.has(reason) ? "skipped" : "failed";
  return {
    provider: "ai-sdk",
    model,
    status,
    summary: aiSdkSkipSummary(reason),
    skipped_reason: reason
  };
}

function aiSdkSkipSummary(reason: string): string {
  switch (reason) {
    case "privacy_block":
      return "AI SDK provider skipped because collected inputs contained high-risk secret material.";
    case "missing_anthropic_api_key":
      return "AI SDK provider skipped because ANTHROPIC_API_KEY is not set.";
    case "missing_google_api_key":
      return "AI SDK provider skipped because GOOGLE_GENERATIVE_AI_API_KEY is not set.";
    case "missing_openai_api_key":
      return "AI SDK provider skipped because OPENAI_API_KEY is not set.";
    default:
      return `AI SDK enrichment did not apply: ${reason}.`;
  }
}

// Agent-file enrichment is read from a LOCAL file the agent controls, so it can
// accidentally contain a token/API key. Every merged string must therefore pass
// through redactSecrets BEFORE it is written into packet fields, mirroring the
// redaction boundary already applied to diffs/conversations for remote calls.
// This keeps a raw secret out of review_packet.json / YAML.
function redact(value: string): string {
  return redactSecrets(value).text;
}

function redactAll(values: string[]): string[] {
  return values.map(redact);
}

function mergeEnrichment(packet: ReviewPacket, enrichment: AgentFileEnrichment): void {
  if (Array.isArray(enrichment.review_focus) && isRecord(packet.risks)) {
    packet.risks.review_focus = uniqueStrings([...(asStringArray(packet.risks.review_focus)), ...redactAll(enrichment.review_focus)]).slice(0, 10);
  }
  if (Array.isArray(enrichment.assumptions) && isRecord(packet.intent)) {
    packet.intent.assumptions = uniqueStrings([...(asStringArray(packet.intent.assumptions)), ...redactAll(enrichment.assumptions)]).slice(0, 12);
  }
  if (Array.isArray(enrichment.methodology_decisions) && isRecord(packet.methodology)) {
    packet.methodology.decisions = uniqueStrings([...(asStringArray(packet.methodology.decisions)), ...redactAll(enrichment.methodology_decisions)]).slice(0, 12);
  }
  if (Array.isArray(enrichment.risk_summaries) && isRecord(packet.risks)) {
    const existing = Array.isArray(packet.risks.items) ? packet.risks.items : [];
    const appended = enrichment.risk_summaries.slice(0, 3).map((rawSummary, index) => {
      const summary = redact(rawSummary);
      return {
        id: `AI-RISK-${String(index + 1).padStart(3, "0")}`,
        category: "unknown" as const,
        severity: "unknown" as const,
        likelihood: "unknown" as const,
        detectability: "unknown" as const,
        summary: `AI/agent hypothesis: ${summary}`,
        impact: "Hypothesis only; not proof of behavior.",
        evidence: [
          {
            kind: "unknown" as const,
            confidence: "low" as const,
            validation_status: "unknown" as const,
            // Mark the sole evidence ref llm_proposed so isHypothesisOnly() treats
            // this AI-RISK as hypothesis-only and the comment/SARIF renderers
            // quarantine it into the hypotheses appendix (review-surfaces.EVIDENCE.6)
            // instead of emitting it as a normal top risk / SARIF result.
            llm_proposed: true,
            note: "Optional enrichment hypothesis."
          }
        ],
        suggested_checks: ["Validate this hypothesis against deterministic evidence before acting."],
        manual_review: true
      };
    });
    packet.risks.items = [...existing, ...appended];
  }
}

async function writePrompts(outputDir: string): Promise<void> {
  const promptPath = path.join(outputDir, "prompts", "agent-enrichment.md");
  await writeText(
    promptPath,
    `# review-surfaces Agent Enrichment Prompt

Read the local repository and .review-surfaces artifacts. Return a compact JSON object only:

\`\`\`json
{
  "review_focus": ["..."],
  "assumptions": ["..."],
  "methodology_decisions": ["..."],
  "risk_summaries": ["..."]
}
\`\`\`

Do not invent file paths, commands, ACIDs, tests, or line numbers. Mark hypotheses as hypotheses. Deterministic evidence remains the only proof for requirement status.
`
  );
  await writeJson(path.join(outputDir, "prompts", "agent-enrichment.schema.json"), ENRICHMENT_SCHEMA);
}

function enrichmentPrompt(packet: ReviewPacket): string {
  return `Return compact JSON only with keys review_focus, assumptions, methodology_decisions, risk_summaries. Use hypotheses only. Do not invent paths/tests/commands/ACIDs.

Packet summary:
intent=${String(packet.intent.summary)}
evaluation=${String(packet.evaluation.summary)}
risks=${String(packet.risks.summary)}
methodology=${String(packet.methodology.summary)}
`;
}

async function readStructuredFile(filePath: string): Promise<unknown> {
  const text = await readText(filePath);
  if (filePath.endsWith(".json")) {
    return JSON.parse(text);
  }
  return parseYaml(text);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
