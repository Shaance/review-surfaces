export interface SecretRedaction {
  kind: "google_api_key" | "token_assignment" | "private_key";
  count: number;
  blocked: boolean;
}

export interface SecretRedactionResult {
  text: string;
  redactions: SecretRedaction[];
  blocked: boolean;
}

export function redactSecrets(input: string): SecretRedactionResult {
  let text = input;
  const redactions: SecretRedaction[] = [];

  const apply = (
    kind: SecretRedaction["kind"],
    regex: RegExp,
    replacement: string | ((match: string, ...captures: string[]) => string),
    blocked: boolean
  ): void => {
    let count = 0;
    text = text.replace(regex, (...args: unknown[]) => {
      count += 1;
      const captures = args.slice(1, -2).map((value) => String(value));
      return typeof replacement === "string" ? replacement : replacement(String(args[0]), ...captures);
    });
    if (count > 0) {
      redactions.push({ kind, count, blocked });
    }
  };

  apply(
    "private_key",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED:private_key]",
    true
  );
  apply("google_api_key", /AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED:google_api_key]", false);
  apply(
    "token_assignment",
    /\b([A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
    (_match, prefix) => `${prefix}[REDACTED:secret]`,
    false
  );

  return {
    text,
    redactions,
    blocked: redactions.some((redaction) => redaction.blocked)
  };
}
