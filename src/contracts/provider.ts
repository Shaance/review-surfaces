export type ProviderName = "mock" | "ai-sdk" | "agent-file";

/**
 * Structured reasoning result. A non-ok result means "no LLM contribution":
 * reasoning stages keep the deterministic result unchanged.
 */
export type StructuredResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: string };

export interface GenerateStructuredOptions {
  /** When false, skip deterministic prompt redaction before a real call. */
  redactSecrets?: boolean;
  /** Hard privacy block: never send the prompt to a remote provider. */
  remotePrivacyBlocked?: boolean;
}

/**
 * Schema-bound reasoning provider. Implementations MUST return a non-ok result
 * (never throw) when they cannot contribute, so callers can fall back to the
 * deterministic result. `schema` is the JSON Schema object that bounds output.
 */
export interface ReasoningProvider {
  name: ProviderName;
  generateStructured(
    stage: string,
    prompt: string,
    schema: object,
    opts?: GenerateStructuredOptions
  ): Promise<StructuredResult>;
}
