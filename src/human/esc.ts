// review-surfaces.RENDER.10/.11: the ONE redact-then-escape helper for every
// interpolation on the HTML cockpit surfaces (HTML renderer + SVG map). Redact
// first (multi-line secrets must be matched before any slicing), then
// HTML-escape — lifted out of render-html.ts so the SVG emitter shares it
// instead of growing a second copy.
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
