// review-surfaces.RENDER.10: the one redact-then-escape boundary for every
// HTML cockpit interpolation. Redact first so multi-line secrets are matched
// before any slicing, then HTML-escape the safe text.
import { redactSecrets } from "../privacy/secrets";

export function esc(value: string | number | undefined | null): string {
  const text = value === undefined || value === null ? "" : String(value);
  return redactSecrets(text).text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
