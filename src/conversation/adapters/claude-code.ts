// review-surfaces.METHODOLOGY.6 / D8: the Claude Code adapter — the
// reference/dogfood-validated adapter. Reads a session JSONL where each line is
// a message envelope: a `role` (user/assistant) plus a `content` array of typed
// blocks (text, tool_use, tool_result), with a uuid/session id. Both the real
// shape ({ type, message:{ role, content:[...] }, uuid, ... }) and the simplified
// shape ({ role, content:[...] }) are accepted. Unknown block types degrade to a
// `message` summary, never throwing.
import { isRecord } from "../../core/guards";
import { AdapterInput, ConversationAdapter, ConversationEvent } from "../events";
import { redactBoundedBody, redactText, stringify } from "../field";

interface Envelope {
  role: string;
  content: unknown;
  uuid?: string;
  sessionId?: string;
}

function readEnvelope(record: Record<string, unknown>): Envelope | undefined {
  const message = isRecord(record.message) ? record.message : record;
  const role = typeof message.role === "string" ? message.role : typeof record.type === "string" ? record.type : undefined;
  if (role === undefined) {
    return undefined;
  }
  const content = message.content;
  const hasContent = Array.isArray(content) || typeof content === "string";
  // Meta lines (e.g. { type: "summary" }) have no content array/string — only
  // claim them when they carry a usable text/summary field.
  if (!hasContent && typeof record.summary !== "string" && typeof record.text !== "string") {
    return undefined;
  }
  return {
    role,
    content: hasContent ? content : (record.summary ?? record.text ?? ""),
    uuid: typeof record.uuid === "string" ? record.uuid : undefined,
    sessionId:
      typeof record.sessionId === "string"
        ? record.sessionId
        : typeof record.session_id === "string"
          ? record.session_id
          : undefined
  };
}

const CLAUDE_BLOCK_TYPES = new Set(["text", "tool_use", "tool_result", "thinking"]);

// Distinguish a Claude Code envelope from a Codex `message` item (which also
// carries top-level role+content but whose blocks are input_text/output_text).
// The REAL Claude shape nests `message` (Codex never does); the simplified shape
// is top-level role+content whose blocks use Claude block types. Registry order
// puts Claude Code before Codex, so this MUST decline Codex shapes or it would
// mis-normalize them.
function looksLikeEnvelope(record: Record<string, unknown>): boolean {
  if (isRecord(record.message) && typeof record.message.role === "string") {
    return Array.isArray(record.message.content) || typeof record.message.content === "string";
  }
  if (typeof record.role === "string" && Array.isArray(record.content)) {
    return record.content.some((block) => isRecord(block) && typeof block.type === "string" && CLAUDE_BLOCK_TYPES.has(block.type));
  }
  return false;
}

function filePathOf(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  for (const key of ["file_path", "path", "filePath", "notebook_path"]) {
    if (typeof input[key] === "string") {
      return input[key] as string;
    }
  }
  return undefined;
}

function commandOf(input: unknown): string {
  if (isRecord(input) && typeof input.command === "string") {
    return redactBoundedBody(input.command);
  }
  return redactBoundedBody(input);
}

export const claudeCodeAdapter: ConversationAdapter = {
  name: "claude-code",
  detect(input: AdapterInput): boolean {
    for (const line of input.text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed) && looksLikeEnvelope(parsed)) {
          return true;
        }
      } catch {
        // A non-JSON line is not a Claude Code session; keep scanning in case the
        // first lines are blank/garbage, but a parse failure on real content
        // simply yields no match.
      }
    }
    return false;
  },
  normalize(input: AdapterInput): ConversationEvent[] {
    const events: ConversationEvent[] = [];
    let rawIndex = 0;
    const lines = input.text.split("\n").filter((line) => line.trim() !== "");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      let record: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(lines[lineIndex]);
        record = isRecord(parsed) ? parsed : undefined;
      } catch {
        record = undefined;
      }
      const envelope = record ? readEnvelope(record) : undefined;
      if (!envelope) {
        continue;
      }
      const baseId = envelope.uuid ?? `${envelope.sessionId ?? "session"}-${lineIndex}`;
      const blocks = Array.isArray(envelope.content)
        ? envelope.content
        : [{ type: "text", text: envelope.content }];
      blocks.forEach((block, blockIndex) => {
        const id = blocks.length > 1 ? `${baseId}-${blockIndex}` : baseId;
        events.push(blockToEvent(block, envelope.role, id, rawIndex));
        rawIndex += 1;
      });
    }
    return events;
  }
};

function blockToEvent(block: unknown, role: string, id: string, rawIndex: number): ConversationEvent {
  if (!isRecord(block)) {
    return { id, actor: role, kind: "message", summary: redactText(block), raw_index: rawIndex };
  }
  const type = typeof block.type === "string" ? block.type : "text";
  if (type === "tool_use") {
    const tool = typeof block.name === "string" ? block.name : "tool";
    const command = commandOf(block.input);
    return {
      id,
      actor: role,
      kind: "tool_call",
      summary: `${tool}(${command})`,
      tool,
      command,
      file: filePathOf(block.input),
      raw_index: rawIndex
    };
  }
  if (type === "tool_result") {
    const body = "content" in block ? block.content : block.output;
    return {
      id,
      actor: "tool",
      kind: "tool_result",
      summary: redactBoundedBody(body),
      file: filePathOf(block),
      raw_index: rawIndex
    };
  }
  if (type === "text") {
    return { id, actor: role, kind: "message", summary: redactText(block.text ?? ""), raw_index: rawIndex };
  }
  // Unknown block type — degrade to a message summary, never throw.
  return { id, actor: role, kind: "message", summary: redactText(stringify(block)), raw_index: rawIndex };
}
