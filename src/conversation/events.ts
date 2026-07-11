// review-surfaces.METHODOLOGY.6: the shared, harness-agnostic conversation event.
//
// Lifted out of src/methodology/methodology.ts and extended with optional tool
// fields (D8) and a positional raw_index so every adapter (Claude Code, Codex,
// Cursor, and the legacy normalized forms) converges on ONE shape the downstream
// item-4/5 analysis reads. `actor`/`kind` stay loose strings rather than a strict
// union: adapters are tolerant of unknown CLI-version fields and degrade an
// unknown block to a `message` summary, never throwing, so the legacy normalized
// shape (which emits `actor:"unknown"`) stays representable verbatim.
export interface ConversationEvent {
  /** Deterministic, stable across reruns (per-adapter id rules). */
  id: string;
  /** "user" | "assistant" | "tool" | "unknown" — kept loose for tolerance. */
  actor: string;
  /** "message" | "tool_call" | "tool_result" | "decision" | "heading" — loose. */
  kind: string;
  /** Already redacted (redactSecrets per field; bounded bodies via redactForArtifact). */
  summary: string;
  /** Tool/function name for a tool_call/tool_result (D8). */
  tool?: string;
  /** Command string / bounded tool input for a tool_call (D8). */
  command?: string;
  /** Touched file path for a tool_call/tool_result (D8). */
  file?: string;
  /** Positional ordering key / deterministic fallback id source. */
  raw_index: number;
}

const TOOL_CALL_EVENT_KINDS = new Set(["tool_call", "custom_tool_call"]);
const TOOL_OUTPUT_EVENT_KINDS = new Set(["tool_result", "custom_tool_call_output"]);
const NON_HUMAN_EVENT_ACTORS = new Set(["system", "developer", "tool"]);

function normalizedEventField(value: string): string {
  return value.trim().toLowerCase();
}

export function isConversationToolCall(event: ConversationEvent): boolean {
  return TOOL_CALL_EVENT_KINDS.has(normalizedEventField(event.kind));
}

export function isConversationToolOutput(event: ConversationEvent): boolean {
  return TOOL_OUTPUT_EVENT_KINDS.has(normalizedEventField(event.kind));
}

export function isConversationToolEvent(event: ConversationEvent): boolean {
  return isConversationToolCall(event) || isConversationToolOutput(event);
}

export function hasNonHumanConversationActor(event: ConversationEvent): boolean {
  return NON_HUMAN_EVENT_ACTORS.has(normalizedEventField(event.actor));
}

// In-memory bound for a raw tool_use input / tool_result output / Cursor
// code-edit body. These are the high-exposure, potentially huge fields (D8); we
// redact-before-bound them so the in-memory event stream stays manageable and a
// straddling secret can never leak an unredacted prefix. Plain message text is
// left unbounded (redacted only) so the legacy normalized keyword/claim
// extraction stays byte-identical.
export const MAX_TOOL_BODY_LENGTH = 1200;

// The forced adapter selector (--conversation-format). Auto-detect by content
// shape when absent.
export type ConversationFormat = "claude-code" | "codex" | "cursor" | "normalized";

export const CONVERSATION_FORMATS: ConversationFormat[] = ["claude-code", "codex", "cursor", "normalized"];

// What every adapter's detect()/normalize() receives. `firstLines` is a cheap
// prefix the registry pre-splits so a detect() can shape-sniff without re-reading
// the whole file.
export interface AdapterInput {
  path: string;
  text: string;
  firstLines: string[];
}

// review-surfaces.METHODOLOGY.6: the pluggable adapter contract. detect() matches
// by content SHAPE (not file extension); normalize() is tolerant/best-effort and
// MUST NOT throw on an unknown block/field.
export interface ConversationAdapter {
  name: ConversationFormat;
  detect(input: AdapterInput): boolean;
  normalize(input: AdapterInput): ConversationEvent[];
}
