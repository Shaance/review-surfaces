// review-surfaces.PRIVACY.7(a): per-field redaction helpers shared by every raw
// adapter. Each extracted field is redacted at normalization time; a bounded
// excerpt (tool input / tool output / code-edit body) is redacted BEFORE it is
// bounded so a secret straddling the limit cannot leak an unredacted prefix.
import { BLOCKED_REDACTION_KINDS, redactSecrets } from "../privacy/secrets";
import { MAX_TOOL_BODY_LENGTH } from "./events";

// Unbounded redacted text — used for plain message bodies so the legacy
// normalized keyword/claim extraction stays byte-identical to the pre-uplift
// behavior.
export function redactText(value: unknown): string {
  return redactSecrets(stringify(value)).text;
}

// Redact a path-shaped field (file/uri). A normal path is returned unchanged; a
// path that embeds a token-shaped secret (e.g. a Cursor edit `uri`) is redacted
// so it never reaches the event summary, the persisted file field, or the remote
// methodology prompt unredacted (Codex P1). Preserves undefined.
export function redactPath(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactSecrets(value).text;
}

// Redact-before-bound a high-exposure body (tool_use input, tool_result output,
// Cursor code-edit body). Empty input collapses to "". A blocked-secret marker
// that the redaction produced BEYOND the bound is re-appended to the excerpt so
// the downstream block scan (collectConversationBlockedKinds) still sees that the
// field held blocked material even when the marker fell after the limit (Codex P2).
export function redactBoundedBody(value: unknown): string {
  const fullRedacted = redactSecrets(stringify(value)).text;
  if (fullRedacted.length <= MAX_TOOL_BODY_LENGTH) {
    return fullRedacted;
  }
  let excerpt = fullRedacted.slice(0, MAX_TOOL_BODY_LENGTH);
  const droppedBlockMarkers = BLOCKED_REDACTION_KINDS.filter(
    (kind) => fullRedacted.includes(`[REDACTED:${kind}]`) && !excerpt.includes(`[REDACTED:${kind}]`)
  );
  if (droppedBlockMarkers.length > 0) {
    excerpt += ` ${droppedBlockMarkers.map((kind) => `[REDACTED:${kind}]`).join(" ")}`;
  }
  return excerpt;
}

// Tolerant stringify: objects/arrays serialize to compact JSON, primitives to
// String(). Adapters must never throw on an unexpected field shape, so a
// circular/unserializable value degrades to String() rather than rejecting.
export function stringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
