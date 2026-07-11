// review-surfaces.METHODOLOGY.6: the `normalized` adapter wraps the three
// PRE-normalized conversation forms the tool already accepted so existing
// fixtures and behavior are preserved verbatim:
//   1. `.jsonl` lines already shaped { id, actor, kind, summary }
//   2. `.yaml`/`.yml` with { events: [...] }
//   3. plain `user:`/`assistant:` text
// Its id/actor/kind/summary derivation is byte-identical to the pre-uplift
// parseConversationFile so the methodology keyword/claim extraction does not
// move. It is tried FIRST in the registry, so its detect() is deliberately
// strict: it must NOT claim a raw Claude Code / Codex / Cursor transcript
// (those carry role+content / response-item / messages-array shapes it rejects).
import { isRecord } from "../../core/guards";
import { parseYaml } from "../../core/simple-yaml";
import { AdapterInput, ConversationAdapter, ConversationEvent } from "../events";
import { redactText } from "../field";
import { isCodexItemType, isCodexRecord } from "./codex-shapes";

function evtId(index: number): string {
  return `evt_${String(index + 1).padStart(4, "0")}`;
}

// Carry the optional tool/command/file fields through when an already-normalized
// record supplies them (redacted as defense-in-depth).
function toolFields(record: Record<string, unknown>): { tool?: string; command?: string; file?: string } {
  const fields: { tool?: string; command?: string; file?: string } = {};
  if (typeof record.tool === "string") {
    fields.tool = redactText(record.tool);
  }
  if (typeof record.command === "string") {
    fields.command = redactText(record.command);
  }
  if (typeof record.file === "string") {
    fields.file = redactText(record.file);
  }
  return fields;
}

function firstJsonObject(text: string): Record<string, unknown> | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// True when SOME line parses as a raw harness transcript record (a Claude Code
// envelope or a Codex response item). Used so the plain-text branch declines a
// raw JSONL that carries a leading banner/non-JSON header line — letting the
// claude/codex adapters (which scan past the header) claim it, instead of losing
// its tool structure to plain-text parsing (Codex P2). An incidental JSON line in
// a genuine prose log does NOT match (it carries none of these markers).
function hasRawTranscriptLine(text: string): boolean {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) {
      continue;
    }
    let record: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      record = isRecord(parsed) ? parsed : undefined;
    } catch {
      continue;
    }
    if (!record) {
      continue;
    }
    const message = isRecord(record.message) ? record.message : record;
    const isClaudeEnvelope = typeof message.role === "string" && (Array.isArray(message.content) || typeof message.content === "string");
    if (isClaudeEnvelope || isCodexRecord(record)) {
      return true;
    }
  }
  return false;
}

// A normalized jsonl line carries the { actor | summary | kind } markers and is
// NOT a Claude Code envelope (role + content array) nor a Codex response item.
function looksNormalizedJsonl(record: Record<string, unknown>): boolean {
  if (Array.isArray(record.content) || isRecord(record.message)) {
    return false;
  }
  if (isCodexItemType(record.type)) {
    return false;
  }
  return "actor" in record || "summary" in record || "kind" in record;
}

function isDefinitiveNormalizedJsonl(record: Record<string, unknown>): boolean {
  return looksNormalizedJsonl(record) && ("actor" in record || "kind" in record);
}

export const normalizedAdapter: ConversationAdapter = {
  name: "normalized",
  detect(input: AdapterInput): boolean {
    if (/\.ya?ml$/i.test(input.path)) {
      const parsed = parseYaml(input.text);
      if (isRecord(parsed) && Array.isArray(parsed.events)) {
        return true;
      }
    }
    const firstRecord = firstJsonObject(input.text);
    if (firstRecord) {
      // Even when the first JSON record looks normalized (e.g. a Claude
      // `{type:"summary", summary:...}` meta line has a `summary` field), decline
      // if a real Claude/Codex envelope appears later — let that adapter, which
      // handles meta lines, claim the file instead of losing its tool structure.
      return looksNormalizedJsonl(firstRecord) &&
        (isDefinitiveNormalizedJsonl(firstRecord) || !hasRawTranscriptLine(input.text));
    }
    // Plain text: a non-JSON first line. A leading `{`/`[`, or a raw harness
    // transcript line hiding behind a banner/header, means a raw adapter should
    // claim it, so this branch declines those.
    const firstLine = input.firstLines.find((line) => line.trim() !== "")?.trim() ?? "";
    if (firstLine === "" || firstLine.startsWith("{") || firstLine.startsWith("[") || hasRawTranscriptLine(input.text)) {
      return false;
    }
    return true;
  },
  normalize(input: AdapterInput): ConversationEvent[] {
    if (/\.ya?ml$/i.test(input.path)) {
      const parsed = parseYaml(input.text);
      if (isRecord(parsed) && Array.isArray(parsed.events)) {
        return parsed.events.map((event, index) => ({
          id: String(isRecord(event) ? event.id ?? evtId(index) : evtId(index)),
          actor: String(isRecord(event) ? event.actor ?? "unknown" : "unknown"),
          kind: String(isRecord(event) ? event.kind ?? "message" : "message"),
          summary: redactText(isRecord(event) ? event.summary ?? event.text ?? "" : event),
          ...(isRecord(event) ? toolFields(event) : {}),
          raw_index: index
        }));
      }
    }

    if (firstJsonObject(input.text) && looksNormalizedJsonl(firstJsonObject(input.text) ?? {})) {
      return input.text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line, index) => {
          let parsed: Record<string, unknown> = {};
          try {
            const value: unknown = JSON.parse(line);
            if (isRecord(value)) {
              parsed = value;
            }
          } catch {
            parsed = {};
          }
          return {
            id: String(parsed.id ?? evtId(index)),
            actor: String(parsed.actor ?? "unknown"),
            kind: String(parsed.kind ?? "message"),
            summary: redactText(parsed.summary ?? parsed.text ?? ""),
            // Preserve tool/command/file so an already-normalized log (including
            // the conversation.normalized.jsonl this tool writes) round-trips its
            // tool_call/tool_result evidence instead of flattening to a message.
            ...toolFields(parsed),
            raw_index: index
          };
        });
    }

    return input.text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line, index) => ({
        id: evtId(index),
        actor: line.startsWith("user:") ? "user" : line.startsWith("assistant:") ? "assistant" : "unknown",
        kind: line.startsWith("#") ? "heading" : "message",
        summary: redactText(line.replace(/^(user|assistant):\s*/i, "")),
        raw_index: index
      }));
  }
};
