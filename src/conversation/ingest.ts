// review-surfaces.METHODOLOGY.6 / PRIVACY.7(a): load a raw or normalized
// conversation file into the shared ConversationEvent stream, and persist a
// redact-before-BOUND + hash-on-blocked normalized log. Reading is non-fatal: a
// missing/unreadable file or an unmatched shape returns undefined so the caller
// degrades to `conversation_log_missing` rather than throwing.
import crypto from "node:crypto";
import path from "node:path";
import { ensureDir, isRegularFile, readText, writeText } from "../core/files";
import { containsBlockedRedaction, redactSecrets } from "../privacy/secrets";
import { ConversationEvent, ConversationFormat } from "./events";
import { buildAdapterInput, normalizeConversation, NormalizeResult } from "./registry";

// Persisted-surface per-field bound. Larger than the in-memory tool-body bound so
// a normalized message is not double-truncated, but still bounded so a custom
// --output-dir cannot accrete an unbounded body.
const PERSIST_FIELD_LIMIT = 2000;

export async function loadConversationEvents(
  cwd: string,
  conversationPath: string,
  format?: ConversationFormat
): Promise<NormalizeResult | undefined> {
  const absolutePath = path.resolve(cwd, conversationPath);
  if (!isRegularFile(absolutePath)) {
    return undefined;
  }
  let text: string;
  try {
    text = await readText(absolutePath);
  } catch {
    return undefined;
  }
  return normalizeConversation(buildAdapterInput(absolutePath, text), format);
}

interface PersistedEvent {
  id: string;
  actor: string;
  kind: string;
  summary: string;
  tool?: string;
  command?: string;
  file?: string;
  raw_index: number;
  // Hash of the bounded redacted text for any field that HELD blocked material,
  // so a downstream consumer of this gitignored log / the content-hash cache can
  // tell it touched a blocked secret without the field retaining its context.
  blocked_field_hashes?: Record<string, string>;
  blocked_redactions?: number;
}

// review-surfaces.PRIVACY.7(a): route every persisted field through
// redact-before-BOUND; for any field where containsBlockedRedaction fires, store
// the field hash-only (the bounded redacted text is replaced by a marker and its
// content hash is recorded) so the gitignored-but-local log cannot retain
// blocked-secret context or hide that it held blocked material.
export async function writeNormalizedConversation(outputDir: string, events: ConversationEvent[]): Promise<void> {
  const inputsDir = path.join(outputDir, "inputs");
  await ensureDir(inputsDir);
  const lines = events.map((event) => JSON.stringify(toPersisted(event))).join("\n");
  await writeText(path.join(inputsDir, "conversation.normalized.jsonl"), `${lines}\n`);
}

function toPersisted(event: ConversationEvent): PersistedEvent {
  const blockedHashes: Record<string, string> = {};
  const persistField = (name: string, value: string | undefined): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    // Redact the FULL value and check IT for blocked markers — a blocked secret
    // beyond PERSIST_FIELD_LIMIT must still hash-and-mark the field, not slip
    // through because its [REDACTED:<kind>] marker fell after the bound (Codex P2).
    const fullRedacted = redactSecrets(value).text;
    if (containsBlockedRedaction(fullRedacted)) {
      blockedHashes[name] = sha256(fullRedacted);
      return "[redacted-blocked]";
    }
    return fullRedacted.length <= PERSIST_FIELD_LIMIT ? fullRedacted : fullRedacted.slice(0, PERSIST_FIELD_LIMIT);
  };

  const persisted: PersistedEvent = {
    id: event.id,
    actor: event.actor,
    kind: event.kind,
    summary: persistField("summary", event.summary) ?? "",
    raw_index: event.raw_index
  };
  if (event.tool !== undefined) {
    persisted.tool = persistField("tool", event.tool);
  }
  if (event.command !== undefined) {
    persisted.command = persistField("command", event.command);
  }
  if (event.file !== undefined) {
    persisted.file = persistField("file", event.file);
  }
  const blockedCount = Object.keys(blockedHashes).length;
  if (blockedCount > 0) {
    persisted.blocked_field_hashes = blockedHashes;
    persisted.blocked_redactions = blockedCount;
  }
  return persisted;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
