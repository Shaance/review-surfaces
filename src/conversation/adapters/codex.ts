// review-surfaces.METHODOLOGY.6 / D8: the Codex CLI adapter (best-effort — the
// on-disk rollout shape is version-variable and externally undocumented). Reads
// response items of type input_text / output_text / function_call /
// function_call_output (top-level, or wrapped under `payload`, or as content
// blocks inside a `message`). A function_call_output secret is treated exactly
// like a Claude Code tool_result secret (it feeds the PRIVACY.7 fold). Unknown
// item types degrade to a `message` summary, never throwing; a rotted/unmatched
// shape simply yields no detect() match rather than a wrong-adapter
// mis-normalization.
import { isRecord } from "../../core/guards";
import { AdapterInput, ConversationAdapter, ConversationEvent } from "../events";
import { redactBoundedBody, redactText, stringify } from "../field";

const CODEX_ITEM_TYPES = new Set(["input_text", "output_text", "function_call", "function_call_output"]);

function itemOf(record: Record<string, unknown>): Record<string, unknown> {
  return isRecord(record.payload) ? record.payload : record;
}

function isCodexItem(record: Record<string, unknown>): boolean {
  const item = itemOf(record);
  if (typeof item.type === "string" && CODEX_ITEM_TYPES.has(item.type)) {
    return true;
  }
  if (typeof item.call_id === "string") {
    return true;
  }
  if (item.type === "message" && Array.isArray(item.content)) {
    return item.content.some((block) => isRecord(block) && typeof block.type === "string" && CODEX_ITEM_TYPES.has(block.type));
  }
  return false;
}

function filePathOf(args: unknown): string | undefined {
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  for (const key of ["file_path", "path", "filePath"]) {
    if (typeof parsed[key] === "string") {
      return parsed[key] as string;
    }
  }
  return undefined;
}

export const codexAdapter: ConversationAdapter = {
  name: "codex",
  detect(input: AdapterInput): boolean {
    for (const line of input.text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed) && isCodexItem(parsed)) {
          return true;
        }
      } catch {
        // non-JSON line: not a Codex rollout
      }
    }
    return false;
  },
  normalize(input: AdapterInput): ConversationEvent[] {
    const events: ConversationEvent[] = [];
    let rawIndex = 0;
    const lines = input.text.split("\n").filter((line) => line.trim() !== "");
    lines.forEach((line, lineIndex) => {
      let record: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(line);
        record = isRecord(parsed) ? parsed : undefined;
      } catch {
        record = undefined;
      }
      if (!record) {
        return;
      }
      const item = itemOf(record);
      const id = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : `codex-${lineIndex}`;
      const type = typeof item.type === "string" ? item.type : "message";

      if (type === "function_call") {
        const tool = typeof item.name === "string" ? item.name : "function";
        const command = redactBoundedBody(item.arguments);
        events.push({
          id,
          actor: "assistant",
          kind: "tool_call",
          summary: `${tool}(${command})`,
          tool,
          command,
          file: filePathOf(item.arguments),
          raw_index: rawIndex
        });
        rawIndex += 1;
        return;
      }
      if (type === "function_call_output") {
        events.push({
          id,
          actor: "tool",
          kind: "tool_result",
          summary: redactBoundedBody("output" in item ? item.output : item.content),
          raw_index: rawIndex
        });
        rawIndex += 1;
        return;
      }
      if (type === "input_text" || type === "output_text") {
        events.push({
          id,
          actor: type === "input_text" ? "user" : "assistant",
          kind: "message",
          summary: redactText(item.text ?? ""),
          raw_index: rawIndex
        });
        rawIndex += 1;
        return;
      }
      if (type === "message" && Array.isArray(item.content)) {
        const role = typeof item.role === "string" ? item.role : "assistant";
        item.content.forEach((block, blockIndex) => {
          const text = isRecord(block) ? block.text ?? stringify(block) : block;
          events.push({
            id: item.content && (item.content as unknown[]).length > 1 ? `${id}-${blockIndex}` : id,
            actor: role,
            kind: "message",
            summary: redactText(text),
            raw_index: rawIndex
          });
          rawIndex += 1;
        });
        return;
      }
      // Unknown item type — degrade to a message summary.
      events.push({ id, actor: "assistant", kind: "message", summary: redactText(item.text ?? stringify(item)), raw_index: rawIndex });
      rawIndex += 1;
    });
    return events;
  }
};
