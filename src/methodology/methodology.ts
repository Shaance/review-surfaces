import fs from "node:fs";
import path from "node:path";
import { CollectionResult } from "../collector/collect";
import { ensureDir, readText, writeText } from "../core/files";
import { parseYaml } from "../core/simple-yaml";
import { commandEvidence, EvidenceRef, missingEvidence } from "../evidence/evidence";

export interface MethodologyModel {
  summary: string;
  missing_logs: boolean;
  considered: string[];
  research: string[];
  decisions: string[];
  unchallenged_assumptions: string[];
  skipped_checks: string[];
  claims_without_evidence: string[];
  evidence: EvidenceRef[];
}

interface ConversationEvent {
  id: string;
  actor: string;
  kind: string;
  summary: string;
}

export async function buildMethodology(
  cwd: string,
  collection: CollectionResult,
  conversationPath: string | undefined,
  commands: string[]
): Promise<MethodologyModel> {
  if (!conversationPath) {
    return {
      summary: "Conversation log not_provided; methodology is derived only from local files and command context.",
      missing_logs: true,
      considered: [],
      research: [],
      decisions: ["Use local deterministic evidence first; optional enrichment cannot prove behavior."],
      unchallenged_assumptions: ["No conversation log was supplied, so options considered outside files are unknown."],
      skipped_checks: ["Conversation methodology audit skipped: --conversation not provided."],
      claims_without_evidence: [],
      evidence: [missingEvidence("No conversation log was provided.")]
    };
  }

  const absolutePath = path.resolve(cwd, conversationPath);
  const events = await parseConversationFile(absolutePath);
  await writeNormalizedConversation(collection.outputDir, events);

  return {
    summary: `Methodology extracted ${events.length} event(s) from ${conversationPath}.`,
    missing_logs: false,
    considered: pick(events, ["option", "considered", "alternative"]),
    research: pick(events, ["research", "inspect", "read", "context", "reference"]),
    decisions: pick(events, ["decide", "decision", "chose", "choose"]),
    unchallenged_assumptions: pick(events, ["assume", "assumption"]),
    skipped_checks: [
      ...pick(events, ["skip", "skipped", "not run", "could not"]),
      ...commands.filter((command) => command.includes("ai-sdk skipped"))
    ],
    claims_without_evidence: pick(events, ["passed", "green", "tested"]).filter((claim) => !claim.includes("command")),
    evidence: [
      {
        kind: "conversation",
        path: conversationPath,
        confidence: "medium",
        validation_status: "valid",
        note: "Conversation was normalized into inputs/conversation.normalized.jsonl."
      },
      ...commands.map((command) => commandEvidence(command, "Command associated with this review run.", "medium"))
    ]
  };
}

async function parseConversationFile(filePath: string): Promise<ConversationEvent[]> {
  const text = await readText(filePath);
  if (filePath.endsWith(".jsonl")) {
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line, index) => {
        const parsed = JSON.parse(line);
        return {
          id: String(parsed.id ?? `evt_${String(index + 1).padStart(4, "0")}`),
          actor: String(parsed.actor ?? "unknown"),
          kind: String(parsed.kind ?? "message"),
          summary: String(parsed.summary ?? parsed.text ?? "")
        };
      });
  }

  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    const parsed = parseYaml(text);
    if (isRecord(parsed) && Array.isArray(parsed.events)) {
      return parsed.events.map((event, index) => ({
        id: String(isRecord(event) ? event.id ?? `evt_${String(index + 1).padStart(4, "0")}` : `evt_${String(index + 1).padStart(4, "0")}`),
        actor: String(isRecord(event) ? event.actor ?? "unknown" : "unknown"),
        kind: String(isRecord(event) ? event.kind ?? "message" : "message"),
        summary: String(isRecord(event) ? event.summary ?? event.text ?? "" : event)
      }));
    }
  }

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, index) => ({
      id: `evt_${String(index + 1).padStart(4, "0")}`,
      actor: line.startsWith("user:") ? "user" : line.startsWith("assistant:") ? "assistant" : "unknown",
      kind: line.startsWith("#") ? "heading" : "message",
      summary: line.replace(/^(user|assistant):\s*/i, "")
    }));
}

async function writeNormalizedConversation(outputDir: string, events: ConversationEvent[]): Promise<void> {
  const inputsDir = path.join(outputDir, "inputs");
  await ensureDir(inputsDir);
  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  await writeText(path.join(inputsDir, "conversation.normalized.jsonl"), `${lines}\n`);
}

function pick(events: ConversationEvent[], keywords: string[]): string[] {
  const result: string[] = [];
  for (const event of events) {
    if (result.length >= 12) {
      break;
    }
    const lower = event.summary.toLowerCase();
    if (keywords.some((keyword) => lower.includes(keyword))) {
      result.push(`${event.id}: ${event.summary}`);
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
