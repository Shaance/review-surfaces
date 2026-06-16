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

function evtId(index: number): string {
  return `evt_${String(index + 1).padStart(4, "0")}`;
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

// A normalized jsonl line carries the { actor | summary | kind } markers and is
// NOT a Claude Code envelope (role + content array) nor a Codex response item.
function looksNormalizedJsonl(record: Record<string, unknown>): boolean {
  if (Array.isArray(record.content) || isRecord(record.message)) {
    return false;
  }
  if (typeof record.type === "string" && /^(input_text|output_text|function_call|function_call_output)$/.test(record.type)) {
    return false;
  }
  return "actor" in record || "summary" in record || "kind" in record;
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
      return looksNormalizedJsonl(firstRecord);
    }
    // Plain text: a non-JSON first line. A leading `{`/`[` means a JSON document
    // a raw adapter should claim, so this branch declines it.
    const firstLine = input.firstLines.find((line) => line.trim() !== "")?.trim() ?? "";
    return firstLine !== "" && !firstLine.startsWith("{") && !firstLine.startsWith("[");
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
