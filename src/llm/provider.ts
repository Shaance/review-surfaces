import path from "node:path";
import { fileExists, readText, writeJson, writeText } from "../core/files";
import { parseYaml } from "../core/simple-yaml";
import { redactSecrets } from "../privacy/secrets";
import { ReviewPacket } from "../render/packet";

export type ProviderName = "mock" | "ai-sdk" | "agent-file";

export interface EnrichmentOptions {
  cwd: string;
  provider: ProviderName;
  model?: string;
  agentInput?: string;
  outputDir: string;
  redactSecrets?: boolean;
  remotePrivacyBlocked?: boolean;
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

export async function enrichPacket(packet: ReviewPacket, options: EnrichmentOptions): Promise<EnrichmentResult> {
  await writePrompts(options.outputDir);

  if (options.provider === "mock") {
    return {
      provider: "mock",
      status: "not_requested",
      summary: "Mock provider selected; deterministic packet was not LLM-enriched."
    };
  }

  if (options.provider === "agent-file") {
    return enrichFromAgentFile(packet, options);
  }

  return enrichFromAiSdk(packet, options);
}

async function enrichFromAgentFile(packet: ReviewPacket, options: EnrichmentOptions): Promise<EnrichmentResult> {
  if (!options.agentInput) {
    return {
      provider: "agent-file",
      status: "skipped",
      summary: "Agent-file provider skipped because --agent-input was not provided.",
      skipped_reason: "missing_agent_input"
    };
  }

  const inputPath = path.resolve(options.cwd, options.agentInput);
  if (!fileExists(inputPath)) {
    return {
      provider: "agent-file",
      status: "skipped",
      summary: `Agent-file provider skipped because ${options.agentInput} does not exist.`,
      skipped_reason: "agent_input_not_found"
    };
  }

  const parsed = await readStructuredFile(inputPath);
  const enrichment = isRecord(parsed) ? (parsed as AgentFileEnrichment) : {};
  mergeEnrichment(packet, enrichment);
  return {
    provider: "agent-file",
    status: "applied",
    summary: `Applied bounded agent-file enrichment from ${options.agentInput}.`
  };
}

async function enrichFromAiSdk(packet: ReviewPacket, options: EnrichmentOptions): Promise<EnrichmentResult> {
  if (options.remotePrivacyBlocked) {
    return {
      provider: "ai-sdk",
      model: options.model,
      status: "skipped",
      summary: "AI SDK provider skipped because collected inputs contained high-risk secret material.",
      skipped_reason: "privacy_block"
    };
  }

  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    return {
      provider: "ai-sdk",
      model: options.model,
      status: "skipped",
      summary: "AI SDK provider skipped because GOOGLE_GENERATIVE_AI_API_KEY is not set.",
      skipped_reason: "missing_google_api_key"
    };
  }

  const rawPrompt = enrichmentPrompt(packet);
  const safePrompt = options.redactSecrets === false
    ? { text: rawPrompt, redactions: [], blocked: false }
    : redactSecrets(rawPrompt);
  if (safePrompt.blocked) {
    return {
      provider: "ai-sdk",
      model: options.model,
      status: "skipped",
      summary: "AI SDK provider skipped because the remote prompt contained high-risk secret material.",
      skipped_reason: "privacy_block"
    };
  }

  try {
    const dynamicImport = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;
    const ai = await dynamicImport("ai");
    const googleModule = await dynamicImport("@ai-sdk/google");
    const createGoogle = googleModule.createGoogleGenerativeAI ?? googleModule.google;
    if (!createGoogle) {
      return {
        provider: "ai-sdk",
        model: options.model,
        status: "failed",
        summary: "AI SDK Google provider did not expose createGoogleGenerativeAI/google.",
        skipped_reason: "provider_api_unavailable"
      };
    }

    const provider = typeof createGoogle === "function" && googleModule.createGoogleGenerativeAI
      ? createGoogle({ apiKey })
      : createGoogle;
    const modelId = normalizeModel(options.model);
    const result = await ai.generateText({
      model: provider(modelId),
      prompt: safePrompt.text
    });
    const parsed = safeJson(result.text);
    if (isRecord(parsed)) {
      mergeEnrichment(packet, parsed as AgentFileEnrichment);
    }

    return {
      provider: "ai-sdk",
      model: modelId,
      status: isRecord(parsed) ? "applied" : "failed",
      summary: isRecord(parsed)
        ? `Applied AI SDK enrichment using ${modelId}${safePrompt.redactions.length ? " after deterministic prompt redaction" : ""}.`
        : "AI SDK returned non-JSON enrichment; deterministic packet was preserved.",
      skipped_reason: isRecord(parsed) ? undefined : "invalid_ai_output"
    };
  } catch (error) {
    return {
      provider: "ai-sdk",
      model: options.model,
      status: "failed",
      summary: `AI SDK enrichment failed: ${error instanceof Error ? error.message : String(error)}`,
      skipped_reason: "ai_sdk_error"
    };
  }
}

function mergeEnrichment(packet: ReviewPacket, enrichment: AgentFileEnrichment): void {
  if (Array.isArray(enrichment.review_focus) && isRecord(packet.risks)) {
    packet.risks.review_focus = uniqueStrings([...(asStringArray(packet.risks.review_focus)), ...enrichment.review_focus]).slice(0, 10);
  }
  if (Array.isArray(enrichment.assumptions) && isRecord(packet.intent)) {
    packet.intent.assumptions = uniqueStrings([...(asStringArray(packet.intent.assumptions)), ...enrichment.assumptions]).slice(0, 12);
  }
  if (Array.isArray(enrichment.methodology_decisions) && isRecord(packet.methodology)) {
    packet.methodology.decisions = uniqueStrings([...(asStringArray(packet.methodology.decisions)), ...enrichment.methodology_decisions]).slice(0, 12);
  }
  if (Array.isArray(enrichment.risk_summaries) && isRecord(packet.risks)) {
    const existing = Array.isArray(packet.risks.items) ? packet.risks.items : [];
    const appended = enrichment.risk_summaries.slice(0, 3).map((summary, index) => ({
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
          note: "Optional enrichment hypothesis."
        }
      ],
      suggested_checks: ["Validate this hypothesis against deterministic evidence before acting."],
      manual_review: true
    }));
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
  await writeJson(path.join(outputDir, "prompts", "agent-enrichment.schema.json"), {
    type: "object",
    additionalProperties: false,
    properties: {
      review_focus: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
      methodology_decisions: { type: "array", items: { type: "string" } },
      risk_summaries: { type: "array", items: { type: "string" } }
    }
  });
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

function normalizeModel(model: string | undefined): string {
  if (!model) {
    return process.env.REVIEW_SURFACES_AI_MODEL ?? "gemini-2.5-flash";
  }
  return model.startsWith("google:") ? model.slice("google:".length) : model;
}

async function readStructuredFile(filePath: string): Promise<unknown> {
  const text = await readText(filePath);
  if (filePath.endsWith(".json")) {
    return JSON.parse(text);
  }
  return parseYaml(text);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : undefined;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
