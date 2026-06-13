export interface SecretRedaction {
  kind:
    | "private_key"
    | "aws_access_key_id"
    | "github_token"
    | "slack_token"
    | "openai_key"
    | "stripe_key"
    | "google_oauth_token"
    | "jwt"
    | "aws_secret"
    | "google_api_key"
    | "token_assignment";
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

  // High-confidence, provider-specific token shapes run FIRST so a real token is
  // redacted by its precise kind before the generic token_assignment catch-all
  // can claim it. private_key stays first (multi-line block). All provider-token
  // patterns are blocked:true: a match SKIPS a remote call / substitutes an
  // artifact token — it never corrupts deterministic evidence, so the boundary
  // is intentionally conservative (false-block > leak).
  apply(
    "private_key",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED:private_key]",
    true
  );
  apply("aws_access_key_id", /\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws_access_key_id]", true);
  apply(
    "aws_secret",
    /\b(AWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/g,
    (_m, prefix) => `${prefix}[REDACTED:aws_secret]`,
    true
  );
  apply(
    "github_token",
    /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    "[REDACTED:github_token]",
    true
  );
  apply("slack_token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:slack_token]", true);
  apply("openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:openai_key]", true);
  apply("stripe_key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, "[REDACTED:stripe_key]", true);
  apply("google_oauth_token", /\bya29\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:google_oauth_token]", true);
  apply("jwt", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED:jwt]", true);
  // review-surfaces.PRIVACY.6: a live Google API key (the default provider's own
  // key shape) must hard-block a remote call like every other provider token, so
  // it sets blocked:true — previously the lone blocked:false provider pattern,
  // contradicting the invariant above and the remote-block signal in collect.ts.
  apply("google_api_key", /AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED:google_api_key]", true);
  // The `(?!\[REDACTED:)` lookahead stops this generic catch-all from re-claiming
  // a placeholder a provider-specific pass already inserted (e.g.
  // `KEY=[REDACTED:aws_secret]`): without it the value group `[^\s"',;]{8,}`
  // matches `[REDACTED:aws_secret]`, rewriting the precise kind to the generic
  // `[REDACTED:secret]` AND double-counting one secret across two redactions[]
  // entries. With it, the specific kind wins (text + inventory), as documented.
  apply(
    "token_assignment",
    /\b([A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*[:=]\s*["']?)(?!\[REDACTED:)([^\s"',;]{8,})/gi,
    (_match, prefix) => `${prefix}[REDACTED:secret]`,
    false
  );

  return {
    text,
    redactions,
    blocked: redactions.some((redaction) => redaction.blocked)
  };
}

/**
 * The canonical ordered list of secret-pattern regex `.source` strings. Exported
 * so the bin/review-surfaces.js parity test can mechanically assert the
 * duplicated CJS redact() copy (which cannot require dist) stays in sync: a
 * pattern added here but forgotten in bin fails that test loudly.
 */
export const SECRET_PATTERN_SOURCES: string[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g.source,
  /\bAKIA[0-9A-Z]{16}\b/g.source,
  /\b(AWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/g.source,
  /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g.source,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g.source,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g.source,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g.source,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/g.source,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g.source,
  /AIza[0-9A-Za-z_-]{20,}/g.source,
  /\b([A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*[:=]\s*["']?)(?!\[REDACTED:)([^\s"',;]{8,})/gi.source
];

// review-surfaces.PRIVACY.6: the high-confidence (blocked:true) redaction kinds —
// every provider/credential pattern. The only non-blocked kind is the generic
// token_assignment catch-all ([REDACTED:secret]). Used to detect that a persisted
// surface held BLOCKED material from its [REDACTED:<kind>] markers alone, even
// when redaction happened via esc() with no explicit block signal.
export const BLOCKED_REDACTION_KINDS: SecretRedaction["kind"][] = [
  "private_key",
  "aws_access_key_id",
  "aws_secret",
  "github_token",
  "slack_token",
  "openai_key",
  "stripe_key",
  "google_oauth_token",
  "jwt",
  "google_api_key"
];

// True when `text` contains a [REDACTED:<kind>] marker for any high-confidence
// (blocked) secret kind.
export function containsBlockedRedaction(text: string): boolean {
  return BLOCKED_REDACTION_KINDS.some((kind) => text.includes(`[REDACTED:${kind}]`));
}
