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
import { redactBoundedBody, redactPath, redactText, stringify } from "../field";

const CODEX_ITEM_TYPES = new Set([
  "input_text",
  "output_text",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "agent_message",
  "user_message"
]);

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

function recordOfToolInput(args: unknown): Record<string, unknown> | undefined {
  let parsed = args;
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
  return parsed;
}

function filePathOf(parsed: Record<string, unknown> | undefined): string | undefined {
  if (!parsed) {
    return undefined;
  }
  for (const key of ["file_path", "path", "filePath"]) {
    if (typeof parsed[key] === "string") {
      return parsed[key] as string;
    }
  }
  return undefined;
}

// Codex stores raw `function_call.arguments` (a JSON string like
// `{"command":"pnpm run test"}` or `{"command":["bash","-lc","pnpm test"]}`).
// Extract the inner shell command so downstream classifiers see `pnpm test`, not a
// string starting with `{`; falls back to undefined so the raw bounded body is kept
// for non-shell tools (Codex P2).
function commandOf(parsed: Record<string, unknown> | undefined): string | undefined {
  if (!parsed) {
    return undefined;
  }
  const command = parsed.command ?? parsed.cmd ?? parsed.script;
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command)) {
    const strings = command.filter((token): token is string => typeof token === "string");
    const flagIndex = strings.findIndex((token) => token === "-lc" || token === "-c");
    if (flagIndex >= 0 && strings[flagIndex + 1] !== undefined) {
      return strings[flagIndex + 1];
    }
    return strings.join(" ");
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

      if (type === "agent_message" || type === "user_message") {
        events.push({
          id,
          actor: type === "user_message" ? "user" : "assistant",
          kind: "message",
          summary: redactText(item.message ?? item.text ?? ""),
          raw_index: rawIndex
        });
        rawIndex += 1;
        return;
      }

      if (type === "function_call" || type === "custom_tool_call") {
        events.push(functionCallEvent(item, id, rawIndex));
        rawIndex += 1;
        return;
      }
      if (type === "function_call_output" || type === "custom_tool_call_output") {
        events.push(functionOutputEvent(item, id, rawIndex));
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
        const multi = item.content.length > 1;
        item.content.forEach((block, blockIndex) => {
          const blockId = multi ? `${id}-${blockIndex}` : id;
          // Codex versions that NEST tool calls under message.content must still
          // produce tool_call/tool_result events, not stringified messages.
          if (isRecord(block) && (block.type === "function_call" || block.type === "custom_tool_call")) {
            events.push(functionCallEvent(block, blockId, rawIndex));
          } else if (isRecord(block) && (block.type === "function_call_output" || block.type === "custom_tool_call_output")) {
            events.push(functionOutputEvent(block, blockId, rawIndex));
          } else {
            const text = isRecord(block) ? block.text ?? stringify(block) : block;
            events.push({ id: blockId, actor: role, kind: "message", summary: redactText(text), raw_index: rawIndex });
          }
          rawIndex += 1;
        });
        return;
      }
      // Unknown Codex envelopes are session/runtime metadata, not assistant
      // speech. Preserve a bounded diagnostic event without letting token
      // counters, task-complete payloads, world state, or future event types
      // become methodology claims by default.
      events.push({
        id,
        actor: record.type === "turn_context" ? "developer" : "system",
        kind: "metadata",
        summary: redactBoundedBody(item.text ?? stringify(item)),
        raw_index: rawIndex
      });
      rawIndex += 1;
    });
    return dedupeAdjacentMessageEvents(events);
  }
};

function dedupeAdjacentMessageEvents(events: ConversationEvent[]): ConversationEvent[] {
  const result: ConversationEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    if (event.kind === "message" && previous?.kind === "message" &&
      event.actor === previous.actor && event.summary === previous.summary) {
      continue;
    }
    result.push({ ...event, raw_index: result.length });
  }
  return result;
}

function functionCallEvent(item: Record<string, unknown>, id: string, rawIndex: number): ConversationEvent {
  // Redact the tool/function name before it enters `tool` and the summary — a
  // token-shaped name must not reach the prompt/persisted fields raw (Codex P2).
  const tool = redactText(typeof item.name === "string" ? item.name : "function");
  // Current Codex rollouts use `input` for custom_tool_call and `arguments` for
  // function_call. Both are the same privacy/bounding boundary downstream.
  const rawInput = "arguments" in item ? item.arguments : item.input;
  const parsedInput = recordOfToolInput(rawInput);
  const extractedCommand = commandOf(parsedInput);
  const command = redactBoundedBody(extractedCommand !== undefined ? extractedCommand : rawInput);
  return {
    id,
    actor: "assistant",
    kind: "tool_call",
    summary: `${tool}(${command})`,
    tool,
    command,
    file: redactPath(filePathOf(parsedInput)),
    raw_index: rawIndex
  };
}

function functionOutputEvent(item: Record<string, unknown>, id: string, rawIndex: number): ConversationEvent {
  // A function_call and its function_call_output normally share one call_id, so
  // suffix the output id to keep the tool invocation and its result distinct
  // events that an anchor can point at unambiguously (Codex P2).
  return {
    id: `${id}-output`,
    actor: "tool",
    kind: "tool_result",
    summary: redactBoundedBody("output" in item ? item.output : item.content),
    raw_index: rawIndex
  };
}
