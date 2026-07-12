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
import { CODEX_ITEM_TYPES, isCodexRecord } from "./codex-shapes";
import {
  emptyConversationProvenance,
  exactMentionedPaths,
  finishConversationProvenance,
  looksLikeMutationTool,
  looksLikeReadTool,
  looksLikeReviewCommand,
  patchMutationPaths,
  recordCommitReferences,
  recordMutationTimestamp,
  recordTimestamp,
  reviewedPath,
  structuredText,
  type ConversationProvenance,
  type ConversationProvenanceContext
} from "../provenance";

function itemOf(record: Record<string, unknown>): Record<string, unknown> {
  return isRecord(record.payload) ? record.payload : record;
}

function isCodexItem(record: Record<string, unknown>): boolean {
  return isCodexRecord(record);
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

function patchApplySucceeded(item: Record<string, unknown>): boolean {
  if (item.success === false || item.status === "failed") return false;
  return item.success === true || item.status === "completed";
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

export function codexProvenance(
  input: AdapterInput,
  context: ConversationProvenanceContext
): ConversationProvenance {
  const result = emptyConversationProvenance();
  const pendingMutations = new Map<string, { paths: string[]; timestamp: unknown }>();
  for (const rawLine of input.text.split("\n")) {
    let record: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(rawLine);
      record = isRecord(parsed) ? parsed : undefined;
    } catch {
      record = undefined;
    }
    if (!record) continue;
    const timestamp = record.timestamp;
    recordTimestamp(result, timestamp);
    recordCommitReferences(result, rawLine, context);
    if (looksLikeReviewCommand(rawLine)) result.sawReviewCommand = true;
    for (const file of exactMentionedPaths(rawLine, context)) result.mentionedPaths.add(file);
    const item = itemOf(record);
    const patchSucceeded = patchApplySucceeded(item);
    if (item.type === "patch_apply_end" && patchSucceeded && isRecord(item.changes)) {
      let recordedMutation = false;
      for (const changedPath of Object.keys(item.changes)) {
        const reviewed = reviewedPath(changedPath, context);
        if (!reviewed) continue;
        result.mutatedPaths.add(reviewed);
        recordedMutation = true;
      }
      if (recordedMutation) recordMutationTimestamp(result, timestamp);
    }
    const possibleTools = [item, ...(Array.isArray(item.content) ? item.content.filter(isRecord) : [])];
    for (const toolItem of possibleTools) {
      if (toolItem.type === "function_call_output" || toolItem.type === "custom_tool_call_output") {
        const callId = typeof toolItem.call_id === "string" ? toolItem.call_id : undefined;
        const pending = callId ? pendingMutations.get(callId) : undefined;
        if (!pending) continue;
        const output = "output" in toolItem ? toolItem.output : toolItem.content;
        const status = structuredToolOutcome(output, toolItem).result_status;
        if (status === "failed") {
          pendingMutations.delete(callId as string);
        } else if (status === "passed") {
          for (const file of pending.paths) result.mutatedPaths.add(file);
          recordMutationTimestamp(result, timestamp);
          pendingMutations.delete(callId as string);
        }
        continue;
      }
      if (toolItem.type !== "function_call" && toolItem.type !== "custom_tool_call") continue;
      const name = typeof toolItem.name === "string" ? toolItem.name : "";
      const rawInput = "arguments" in toolItem ? toolItem.arguments : toolItem.input;
      const parsedInput = recordOfToolInput(rawInput);
      const directPath = reviewedPath(filePathOf(parsedInput), context);
      const mutationTool = looksLikeMutationTool(name);
      const patchPaths = mutationTool ? patchMutationPaths(structuredText(rawInput), context) : [];
      const mutationPaths = directPath ? [directPath, ...patchPaths] : patchPaths;
      if (mutationTool) {
        const paths = [...new Set(mutationPaths)];
        const callId = typeof toolItem.call_id === "string" ? toolItem.call_id : undefined;
        if (paths.length > 0 && callId) pendingMutations.set(callId, { paths, timestamp });
        else {
          for (const file of paths) result.mutatedPaths.add(file);
          if (paths.length > 0) recordMutationTimestamp(result, timestamp);
        }
      } else if (directPath && looksLikeReadTool(name)) {
        result.readPaths.add(directPath);
        result.sawReadTool = true;
      }
      if (looksLikeReviewCommand(commandOf(parsedInput) ?? rawInput)) result.sawReviewCommand = true;
    }
  }
  // Older/partial rollouts may retain the mutation invocation but omit its
  // result. Keep that exact structured mutation as medium-strength producer
  // evidence; an explicit correlated failure above always removes it.
  for (const pending of pendingMutations.values()) {
    for (const file of pending.paths) result.mutatedPaths.add(file);
    recordMutationTimestamp(result, pending.timestamp);
  }
  return finishConversationProvenance(result);
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
      const callId = typeof item.call_id === "string" ? item.call_id : id;
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
        events.push(functionCallEvent(item, id, rawIndex, callId));
        rawIndex += 1;
        return;
      }
      if (type === "function_call_output" || type === "custom_tool_call_output") {
        events.push(functionOutputEvent(item, id, rawIndex, callId));
        rawIndex += 1;
        return;
      }
      if (type === "patch_apply_end") {
        const succeeded = patchApplySucceeded(item);
        events.push({
          id,
          actor: "tool",
          kind: "tool_result",
          summary: redactBoundedBody(item.stdout ?? item.stderr ?? "Patch application completed."),
          tool: "apply_patch",
          result_status: succeeded ? "passed" : "failed",
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
        const multi = item.content.length > 1;
        item.content.forEach((block, blockIndex) => {
          const blockId = multi ? `${id}-${blockIndex}` : id;
          // Codex versions that NEST tool calls under message.content must still
          // produce tool_call/tool_result events, not stringified messages.
          if (isRecord(block) && (block.type === "function_call" || block.type === "custom_tool_call")) {
            events.push(functionCallEvent(block, blockId, rawIndex,
              typeof block.call_id === "string" ? block.call_id : blockId));
          } else if (isRecord(block) && (block.type === "function_call_output" || block.type === "custom_tool_call_output")) {
            events.push(functionOutputEvent(block, blockId, rawIndex,
              typeof block.call_id === "string" ? block.call_id : blockId));
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
    return linkToolResults(dedupeAdjacentMessageEvents(events));
  }
};

function linkToolResults(events: ConversationEvent[]): ConversationEvent[] {
  const calls = new Map<string, ConversationEvent>();
  for (const event of events) {
    if (event.kind === "tool_call") calls.set(event.call_id ?? event.id, event);
  }
  return events.map((event) => {
    if (event.kind !== "tool_result" || event.tool) return event;
    const call = calls.get(event.call_id ?? event.id.replace(/-output$/, ""));
    if (!call) return event;
    return {
      ...event,
      ...(call.tool ? { tool: call.tool } : {}),
      ...(call.command ? { command: call.command } : {}),
      ...(call.file ? { file: call.file } : {})
    };
  });
}

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

function functionCallEvent(item: Record<string, unknown>, id: string, rawIndex: number, callId = id): ConversationEvent {
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
    call_id: callId,
    raw_index: rawIndex
  };
}

function functionOutputEvent(item: Record<string, unknown>, id: string, rawIndex: number, callId = id): ConversationEvent {
  // A function_call and its function_call_output normally share one call_id, so
  // suffix the output id to keep the tool invocation and its result distinct
  // events that an anchor can point at unambiguously (Codex P2).
  const output = "output" in item ? item.output : item.content;
  const outcome = structuredToolOutcome(output, item);
  return {
    id: `${id}-output`,
    actor: "tool",
    kind: "tool_result",
    summary: redactBoundedBody(output),
    call_id: callId,
    ...outcome,
    raw_index: rawIndex
  };
}

function structuredToolOutcome(
  value: unknown,
  item?: Record<string, unknown>
): Pick<ConversationEvent, "result_status" | "exit_code"> {
  const explicitStatus = typeof item?.status === "string" ? item.status.toLowerCase() : undefined;
  if (item?.success === false || explicitStatus === "failed" || explicitStatus === "error" ||
    explicitStatus === "cancelled" || explicitStatus === "canceled") {
    return { result_status: "failed" };
  }
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }
  if (!isRecord(parsed)) return {};
  const exitCode = parsed.exit_code ?? parsed.exitCode;
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) {
    return { exit_code: exitCode, result_status: exitCode === 0 ? "passed" : "failed" };
  }
  return {};
}
