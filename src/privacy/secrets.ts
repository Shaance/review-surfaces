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

export interface StreamingBlockingSecretDetector {
  write(text: string): boolean;
  blockedSecretSeen(): boolean;
}

interface SecretRuntime {
  SECRET_PATTERN_SOURCES: string[];
  BLOCKED_REDACTION_KINDS: SecretRedaction["kind"][];
  redactSecrets(input: string): SecretRedactionResult;
  containsBlockedRedaction(text: string): boolean;
  containsBlockingSecretMaterial(text: string): boolean;
  inspectAndRedactSecrets(input: string): SecretRedactionResult;
  StreamingBlockingSecretDetector: new () => StreamingBlockingSecretDetector;
}

// The standalone `run` fallback and compiled TypeScript use exactly one privacy
// runtime. `allowJs` copies this source to dist/bin during the build, preserving
// this relative require from dist/src/privacy without duplicating the grammar.
const runtime = require("../../bin/privacy-runtime.js") as SecretRuntime;

export const SECRET_PATTERN_SOURCES = runtime.SECRET_PATTERN_SOURCES;
export const BLOCKED_REDACTION_KINDS = runtime.BLOCKED_REDACTION_KINDS;
export const redactSecrets = runtime.redactSecrets;
export const containsBlockedRedaction = runtime.containsBlockedRedaction;
export const containsBlockingSecretMaterial = runtime.containsBlockingSecretMaterial;
export const inspectAndRedactSecrets = runtime.inspectAndRedactSecrets;
export const StreamingBlockingSecretDetector = runtime.StreamingBlockingSecretDetector;
