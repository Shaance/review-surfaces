// review-surfaces.PRIVACY.7(a): per-field redaction helpers shared by every raw
// adapter. Each extracted field is redacted at normalization time; a bounded
// excerpt (tool input / tool output / code-edit body) is redacted BEFORE it is
// bounded so a secret straddling the limit cannot leak an unredacted prefix.
import { BLOCKED_REDACTION_KINDS, containsBlockedRedaction, redactSecrets } from "../privacy/secrets";
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
// Cursor code-edit body). Empty input collapses to "".
//
// When the body held a BLOCKED-kind secret, collapse to the block markers ALONE,
// discarding the surrounding transcript context. Otherwise the redacted-but-
// contextual body (e.g. "All tests pass. TOKEN=[REDACTED:...]") would flow into
// the methodology prompt and into claims_without_evidence/verified_claims, so
// methodology.yaml + the packet would retain transcript text around a blocked
// secret even though the normalized log is hash-only (Codex P2). The markers keep
// the block signal so collectConversationBlockedKinds still detects it.
export function redactBoundedBody(value: unknown): string {
  const fullRedacted = redactSecrets(stringify(value)).text;
  if (containsBlockedRedaction(fullRedacted)) {
    return BLOCKED_REDACTION_KINDS.filter((kind) => fullRedacted.includes(`[REDACTED:${kind}]`))
      .map((kind) => `[REDACTED:${kind}]`)
      .join(" ");
  }
  return fullRedacted.length <= MAX_TOOL_BODY_LENGTH ? fullRedacted : fullRedacted.slice(0, MAX_TOOL_BODY_LENGTH);
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
