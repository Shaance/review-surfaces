import { redactSecrets } from "./secrets";

/** Redact secrets from a string; thin stable wrapper over redactSecrets(value).text. */
export function redactText(value: string): string {
  return redactSecrets(value).text;
}

/**
 * Redact FIRST, then bound to `limit` characters. Returns the bounded excerpt and
 * whether truncation occurred. Order matters: redacting before slicing prevents a
 * secret that straddles the limit from leaking an unredacted prefix (the
 * truncate-then-redact bug this chokepoint exists to eliminate).
 */
export function redactForArtifact(
  value: string | undefined,
  limit: number
): { excerpt?: string; truncated: boolean } {
  if (value === undefined) {
    return { truncated: false };
  }
  const redacted = redactSecrets(value).text;
  if (redacted.length <= limit) {
    return { excerpt: redacted, truncated: false };
  }
  return { excerpt: redacted.slice(0, limit), truncated: true };
}
