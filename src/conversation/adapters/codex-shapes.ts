export const CODEX_ITEM_TYPES = new Set([
  "input_text",
  "output_text",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "agent_message",
  "user_message"
]);

export function isCodexItemType(value: unknown): value is string {
  return typeof value === "string" && CODEX_ITEM_TYPES.has(value);
}

export function isCodexRecord(record: Record<string, unknown>): boolean {
  const item = isRecord(record.payload) ? record.payload : record;
  if (isCodexItemType(item.type) || typeof item.call_id === "string") {
    return true;
  }
  return item.type === "message" && Array.isArray(item.content) &&
    item.content.some((block) => isRecord(block) && isCodexItemType(block.type));
}
import { isRecord } from "../../core/guards";
