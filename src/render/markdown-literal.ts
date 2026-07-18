// Render untrusted/user-authored values as literal Markdown content. Secret
// redaction and length bounding belong to the caller because those policies
// differ by surface.
export function escapeMarkdownLiteral(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`*_[\]])/gu, "\\$1")
    .replace(/^([#+-])/u, "\\$1")
    .replace(/^(\d+)\./u, "$1\\.");
}

export function markdownInlineCode(value: string): string {
  const sanitized = value
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
  const longestFence = Math.max(0, ...[...sanitized.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  const padding = sanitized.startsWith("`") || sanitized.endsWith("`") ? " " : "";
  return `${fence}${padding}${sanitized}${padding}${fence}`;
}

export function markdownLinkDestination(value: string): string {
  return value
    .replace(/\\/gu, "%5C")
    .replace(/\s/gu, "%20")
    .replace(/\(/gu, "%28")
    .replace(/\)/gu, "%29")
    .replace(/</gu, "%3C")
    .replace(/>/gu, "%3E");
}
