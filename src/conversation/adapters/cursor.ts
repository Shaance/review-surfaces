// review-surfaces.METHODOLOGY.6 / D8 / PRIVACY.7: the Cursor adapter
// (best-effort). Reads an exported chat/composer JSON — an object with a
// `messages` (or `bubbles`) array of { role, text, ... } plus tool/code-edit
// entries. The CODE-EDIT BODY is the Cursor-specific high-exposure channel
// (pasted keys, .env diffs); it is redacted at normalization and routed through
// redact-before-bound exactly like a Claude Code tool_result body, and a blocked
// secret there feeds the PRIVACY.7 fold. Tolerates both UI-export and
// workspace-storage variants; unknown shapes degrade to a message summary.
import { isRecord } from "../../core/guards";
import { AdapterInput, ConversationAdapter, ConversationEvent } from "../events";
import { redactBoundedBody, redactPath, redactText } from "../field";

function parseRoot(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function messagesOf(root: Record<string, unknown>): unknown[] {
  if (Array.isArray(root.messages)) {
    return root.messages;
  }
  if (Array.isArray(root.bubbles)) {
    return root.bubbles;
  }
  return [];
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }
  return undefined;
}

function editEntries(message: Record<string, unknown>): unknown[] {
  for (const key of ["edits", "codeBlocks", "toolCalls", "code_edits"]) {
    if (Array.isArray(message[key])) {
      return message[key] as unknown[];
    }
  }
  return [];
}

export const cursorAdapter: ConversationAdapter = {
  name: "cursor",
  detect(input: AdapterInput): boolean {
    const root = parseRoot(input.text);
    if (!root) {
      return false;
    }
    return Array.isArray(root.messages) || Array.isArray(root.bubbles);
  },
  normalize(input: AdapterInput): ConversationEvent[] {
    const root = parseRoot(input.text);
    if (!root) {
      return [];
    }
    const events: ConversationEvent[] = [];
    let rawIndex = 0;
    messagesOf(root).forEach((raw, messageIndex) => {
      if (!isRecord(raw)) {
        events.push({ id: `cursor-${messageIndex}`, actor: "unknown", kind: "message", summary: redactText(raw), raw_index: rawIndex });
        rawIndex += 1;
        return;
      }
      const id = firstString(raw, ["id", "bubbleId", "messageId"]) ?? `cursor-${messageIndex}`;
      const role = firstString(raw, ["role", "type"]) ?? "unknown";
      const text = firstString(raw, ["text", "content", "message"]);
      if (typeof text === "string" && text.trim() !== "") {
        events.push({ id, actor: role, kind: "message", summary: redactText(text), raw_index: rawIndex });
        rawIndex += 1;
      }
      editEntries(raw).forEach((edit, editIndex) => {
        if (!isRecord(edit)) {
          return;
        }
        // Redact the edit path/uri before it touches the summary, the persisted
        // file field, or the remote prompt — a Cursor edit uri can embed a secret.
        const file = redactPath(firstString(edit, ["file", "path", "uri", "fsPath", "filePath"]));
        const body = firstString(edit, ["text", "content", "diff", "newText", "code"]);
        events.push({
          id: `${id}-edit-${editIndex}`,
          actor: "tool",
          kind: "tool_call",
          summary: file ? `edit ${file}: ${redactBoundedBody(body)}` : redactBoundedBody(body),
          tool: "edit",
          command: redactBoundedBody(body),
          file,
          raw_index: rawIndex
        });
        rawIndex += 1;
      });
    });
    return events;
  }
};
