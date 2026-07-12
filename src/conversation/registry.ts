// review-surfaces.METHODOLOGY.6: the conversation adapter registry. Tries
// adapters in a FIXED order and selects the first whose detect() matches the
// content SHAPE (not the file extension — all three harnesses can serialize to
// .jsonl/.json). A `--conversation-format` value forces a specific adapter,
// bypassing detection. `normalized` is first so the legacy pre-normalized forms
// keep working; its detect() is strict enough to decline a raw transcript, which
// then falls through to its harness adapter. An unmatched/rotted shape returns
// undefined → the caller degrades to `conversation_log_missing` (non-fatal),
// never a wrong-adapter mis-normalization.
import crypto from "node:crypto";
import { claudeCodeAdapter } from "./adapters/claude-code";
import { codexAdapter } from "./adapters/codex";
import { cursorAdapter } from "./adapters/cursor";
import { normalizedAdapter } from "./adapters/normalized";
import { AdapterInput, ConversationAdapter, ConversationEvent, ConversationFormat } from "./events";
import { redactText } from "./field";

// Order is load-bearing: normalized first (legacy forms), then the three raw
// harnesses. Claude Code precedes Codex so a role+content envelope is claimed by
// Claude Code, and Codex's detect() keys on its own response-item markers.
export const ADAPTERS: ConversationAdapter[] = [normalizedAdapter, claudeCodeAdapter, codexAdapter, cursorAdapter];

export function buildAdapterInput(filePath: string, text: string): AdapterInput {
  return {
    path: filePath,
    text,
    firstLines: text.split("\n", 20)
  };
}

export function selectAdapter(input: AdapterInput, forced?: ConversationFormat): ConversationAdapter | undefined {
  if (forced) {
    return ADAPTERS.find((adapter) => adapter.name === forced);
  }
  return ADAPTERS.find((adapter) => safeDetect(adapter, input));
}

export interface NormalizeResult {
  events: ConversationEvent[];
  adapter: ConversationFormat;
}

// Returns undefined when no adapter matches (or a forced format is unknown), so
// the caller treats it as a missing/unparseable log rather than throwing.
export function normalizeConversation(input: AdapterInput, forced?: ConversationFormat): NormalizeResult | undefined {
  const adapter = selectAdapter(input, forced);
  if (!adapter) {
    return undefined;
  }
  let events: ConversationEvent[];
  try {
    events = adapter.normalize(input);
  } catch {
    // Adapters are contractually tolerant, but guard anyway: a normalize() that
    // somehow throws degrades to no-events rather than crashing the run.
    events = [];
  }
  // id/actor/kind are caller-controlled for normalized exports and reach the
  // persisted log, the prompt, and the anchor allowlist — so redact them centrally
  // (a normal value is unchanged; only a secret-shaped one is masked, consistently
  // everywhere). summary/command/file/tool are already redacted by the adapters.
  // Codex P2.
  return {
    events: events.map((event) => ({
      ...event,
      id: boundedEventId(redactText(event.id)),
      actor: redactText(event.actor),
      kind: redactText(event.kind),
      ...(event.call_id === undefined ? {} : { call_id: boundedEventId(redactText(event.call_id)) })
    })),
    adapter: adapter.name
  };
}

const EVENT_ID_LIMIT = 200;

function boundedEventId(id: string): string {
  if (id.length <= EVENT_ID_LIMIT) {
    return id;
  }
  const digest = crypto.createHash("sha256").update(id).digest("hex").slice(0, 16);
  return `${id.slice(0, EVENT_ID_LIMIT - digest.length - 1)}~${digest}`;
}

function safeDetect(adapter: ConversationAdapter, input: AdapterInput): boolean {
  try {
    return adapter.detect(input);
  } catch {
    return false;
  }
}
