import { redactSecrets } from "../privacy/secrets";
import { escapeMarkdownLiteral, markdownInlineCode } from "../render/markdown-literal";

export function redactAuditText(value: string): { text: string; redacted: boolean } {
  const result = redactSecrets(value);
  return { text: result.text, redacted: result.redactions.length > 0 };
}

export function safeMarkdownProse(value: string): string {
  const redacted = redactSecrets(value).text.replace(/\s+/gu, " ").trim();
  return escapeMarkdownLiteral(redacted);
}

export function safeMarkdownCode(value: string): string {
  const redacted = redactSecrets(value).text.replace(/\s+/gu, " ").trim();
  return markdownInlineCode(redacted);
}
