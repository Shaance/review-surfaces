// Provider-backed explanations for change-map edges. This is optional
// enrichment: the deterministic change graph still owns the edge set, and
// provider output may only attach bounded prose to those exact edges.
import { isRecord } from "../core/guards";
import { ProviderName, ReasoningProvider } from "../llm/provider";
import { StructuredDiff, StructuredDiffFile } from "../pr/contract";
import { redactSecrets } from "../privacy/secrets";
import { ChangedImportEdge, ChangeGraphAreaInsight, ChangeGraphEdgeInsight } from "./change-graph";

const MAX_PROMPT_EDGES = 40;
const MAX_PROVIDER_OUTPUT_EDGES = 80;
const MAX_PROMPT_AREAS = 20;
const MAX_AREA_TOPICS = 12;
const MAX_TOPIC_PATHS = 40;
const MAX_SUMMARY_CHARS = 110;
const MAX_DETAIL_CHARS = 280;
const MAX_SNIPPET_LINES = 8;
const MAX_SNIPPET_LINE_CHARS = 160;
const MAX_SNIPPET_TOTAL_CHARS = 900;

export const CHANGE_MAP_INSIGHTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    edges: {
      type: "array",
      maxItems: MAX_PROVIDER_OUTPUT_EDGES,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          summary: { type: "string" },
          detail: { type: "string" }
        },
        required: ["from", "to", "summary"]
      }
    },
    areas: {
      type: "array",
      maxItems: MAX_PROMPT_AREAS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          summary: { type: "string" },
          detail: { type: "string" },
          topics: {
            type: "array",
            maxItems: MAX_AREA_TOPICS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string" },
                summary: { type: "string" },
                paths: { type: "array", maxItems: MAX_TOPIC_PATHS, items: { type: "string" } }
              },
              required: ["label", "summary", "paths"]
            }
          }
        },
        required: ["name", "summary"]
      }
    }
  },
  required: ["edges"]
} as const;

export interface BuildChangeMapInsightsInput {
  provider: ReasoningProvider;
  providerName: ProviderName;
  edges: ChangedImportEdge[];
  areas?: Array<{ name: string; paths: string[] }>;
  diff?: StructuredDiff;
  redactSecrets: boolean;
  remotePrivacyBlocked: boolean;
}

export interface ChangeMapInsights {
  edgeInsights: ChangeGraphEdgeInsight[];
  areaInsights: ChangeGraphAreaInsight[];
}

export async function buildChangeMapInsights(input: BuildChangeMapInsightsInput): Promise<ChangeMapInsights> {
  const edges = dedupeEdges(input.edges);
  const areas = dedupeAreas(input.areas ?? []);
  if ((edges.length === 0 && areas.length === 0) || input.providerName === "mock") {
    return { edgeInsights: [], areaInsights: [] };
  }
  const promptEdges = edges.slice(0, MAX_PROMPT_EDGES);
  const promptAreas = areas.slice(0, MAX_PROMPT_AREAS);
  const result = await input.provider.generateStructured(
    "change_map_insights",
    changeMapInsightsPrompt(promptEdges, promptAreas, input.diff),
    CHANGE_MAP_INSIGHTS_SCHEMA,
    { redactSecrets: input.redactSecrets, remotePrivacyBlocked: input.remotePrivacyBlocked }
  );
  if (!result.ok || !isRecord(result.data)) {
    return { edgeInsights: [], areaInsights: [] };
  }
  const allowedEdges = input.providerName === "agent-file" ? edges : promptEdges;
  const allowedAreas = input.providerName === "agent-file" ? areas : promptAreas;
  return {
    edgeInsights: validateEdgeInsights(result.data.edges, allowedEdges),
    areaInsights: validateAreaInsights(result.data.areas, allowedAreas)
  };
}

function validateEdgeInsights(value: unknown, allowedEdges: ChangedImportEdge[]): ChangeGraphEdgeInsight[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowed = new Set(allowedEdges.map((edge) => edgeKey(edge.importer, edge.imported)));
  const seen = new Set<string>();
  const insights: ChangeGraphEdgeInsight[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.from !== "string" || typeof raw.to !== "string" || typeof raw.summary !== "string") {
      continue;
    }
    const key = edgeKey(raw.from, raw.to);
    if (!allowed.has(key) || seen.has(key)) {
      continue;
    }
    const summary = bounded(raw.summary, MAX_SUMMARY_CHARS);
    if (!summary) {
      continue;
    }
    const detail = typeof raw.detail === "string" ? bounded(raw.detail, MAX_DETAIL_CHARS) : undefined;
    insights.push({
      from: raw.from,
      to: raw.to,
      summary,
      ...(detail ? { detail } : {}),
      source: "provider"
    });
    seen.add(key);
  }
  return insights;
}

function validateAreaInsights(value: unknown, allowedAreas: Array<{ name: string; paths: string[] }>): ChangeGraphAreaInsight[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowedByName = new Map(allowedAreas.map((area) => [area.name, new Set(area.paths)]));
  const seen = new Set<string>();
  const insights: ChangeGraphAreaInsight[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.summary !== "string") {
      continue;
    }
    const allowedPaths = allowedByName.get(raw.name);
    if (!allowedPaths || seen.has(raw.name)) {
      continue;
    }
    const summary = bounded(raw.summary, MAX_SUMMARY_CHARS);
    if (!summary) {
      continue;
    }
    const detail = typeof raw.detail === "string" ? bounded(raw.detail, MAX_DETAIL_CHARS) : undefined;
    const topics = validateTopics(raw.topics, allowedPaths);
    insights.push({
      name: raw.name,
      summary,
      ...(detail ? { detail } : {}),
      ...(topics.length > 0 ? { topics } : {}),
      source: "provider"
    });
    seen.add(raw.name);
  }
  return insights;
}

function validateTopics(value: unknown, allowedPaths: Set<string>): NonNullable<ChangeGraphAreaInsight["topics"]> {
  if (!Array.isArray(value)) {
    return [];
  }
  const usedPaths = new Set<string>();
  const seenLabels = new Set<string>();
  const topics: NonNullable<ChangeGraphAreaInsight["topics"]> = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.label !== "string" || typeof raw.summary !== "string" || !Array.isArray(raw.paths)) {
      continue;
    }
    const label = bounded(raw.label, 48);
    const summary = bounded(raw.summary, MAX_SUMMARY_CHARS);
    if (!label || !summary || seenLabels.has(label)) {
      continue;
    }
    const paths = [...new Set(raw.paths.filter((filePath): filePath is string => typeof filePath === "string" && allowedPaths.has(filePath) && !usedPaths.has(filePath)))]
      .sort();
    if (paths.length === 0) {
      continue;
    }
    paths.forEach((filePath) => usedPaths.add(filePath));
    topics.push({ label, summary, paths, source: "provider" });
    seenLabels.add(label);
  }
  return topics;
}

function changeMapInsightsPrompt(edges: ChangedImportEdge[], areas: Array<{ name: string; paths: string[] }>, diff: StructuredDiff | undefined): string {
  const filesByPath = new Map((diff?.files ?? []).map((file) => [file.path, file]));
  const lines = [
    "Explain code-review relationships for a change map.",
    "Return JSON only. Do not invent edges, areas, topics, or paths.",
    "For each edge, explain what the importer appears to use from the imported file and why a reviewer should read them together.",
    "For each area, write one reviewer-facing sentence that explains what changed there. Group area paths into topics that make sense to review together.",
    "Avoid generic phrases like 'imports' or 'changed files' unless no stronger relationship is visible. Keep summaries short.",
    "",
    "Edges:"
  ];
  for (const edge of edges) {
    lines.push(`- from=${edge.importer} to=${edge.imported}`);
    lines.push(`  importer diff: ${snippet(filesByPath.get(edge.importer))}`);
    lines.push(`  imported diff: ${snippet(filesByPath.get(edge.imported))}`);
  }
  lines.push("", "Areas:");
  for (const area of areas) {
    lines.push(`- name=${area.name}`);
    for (const filePath of area.paths.slice(0, MAX_TOPIC_PATHS)) {
      lines.push(`  file=${filePath} diff: ${snippet(filesByPath.get(filePath))}`);
    }
  }
  return lines.join("\n");
}

function snippet(file: StructuredDiffFile | undefined): string {
  if (!file) {
    return "(no diff snippet)";
  }
  const changed = file.hunks.flatMap((hunk) =>
    hunk.lines
      .filter((line) => line.kind !== "context")
      .map((line) => `${line.kind === "add" ? "+" : "-"} ${bounded(line.text, MAX_SNIPPET_LINE_CHARS)}`)
  );
  const excerpt = changed.slice(0, MAX_SNIPPET_LINES).join(" | ");
  return excerpt ? bounded(excerpt, MAX_SNIPPET_TOTAL_CHARS) : "(metadata-only change)";
}

function bounded(value: string, maxChars: number): string {
  const text = redactSecrets(value).text.replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function dedupeEdges(edges: ChangedImportEdge[]): ChangedImportEdge[] {
  const seen = new Set<string>();
  const result: ChangedImportEdge[] = [];
  for (const edge of edges) {
    const key = edgeKey(edge.importer, edge.imported);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(edge);
  }
  return result;
}

function dedupeAreas(areas: Array<{ name: string; paths: string[] }>): Array<{ name: string; paths: string[] }> {
  const seen = new Set<string>();
  const result: Array<{ name: string; paths: string[] }> = [];
  for (const area of areas) {
    if (seen.has(area.name)) {
      continue;
    }
    seen.add(area.name);
    result.push({ name: area.name, paths: [...new Set(area.paths)].sort() });
  }
  return result;
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}
