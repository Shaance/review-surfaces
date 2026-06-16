// review-surfaces.PRIVACY.7(a): per-field redaction helpers shared by every raw
// adapter. Each extracted field is redacted at normalization time; a bounded
// excerpt (tool input / tool output / code-edit body) is redacted BEFORE it is
// bounded so a secret straddling the limit cannot leak an unredacted prefix.
import { redactForArtifact } from "../privacy/redact";
import { redactSecrets } from "../privacy/secrets";
import { MAX_TOOL_BODY_LENGTH } from "./events";

// Unbounded redacted text — used for plain message bodies so the legacy
// normalized keyword/claim extraction stays byte-identical to the pre-uplift
// behavior.
export function redactText(value: unknown): string {
  return redactSecrets(stringify(value)).text;
}

// Redact-before-bound a high-exposure body (tool_use input, tool_result output,
// Cursor code-edit body). Empty input collapses to "".
export function redactBoundedBody(value: unknown): string {
  return redactForArtifact(stringify(value), MAX_TOOL_BODY_LENGTH).excerpt ?? "";
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
