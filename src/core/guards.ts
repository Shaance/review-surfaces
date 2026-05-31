// Shared runtime guards hoisted from per-module copies. Every export below was
// verified byte-identical across its former call sites before consolidation, so
// importing these does NOT change runtime behavior (byte-stability preserved).
//
// DELIBERATELY EXCLUDED (NOT byte-identical — left as local copies):
//   - escapeRegExp: glob.ts uses /[|\\{}()[\]^$+?.]/g while evidence-rules.ts
//     uses /[.*+?^${}()|[\]\\]/g. Different character classes => different
//     escaping behavior. Hoisting either over the other changes regex matching.
//   - asStringArray: three divergent bodies (provider keeps all strings;
//     reasoning trims and drops empties; load.ts maps via asArray). Hoisting
//     would change filtering behavior.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Plain de-dupe preserving first-seen order; NO Boolean filter (matches the
// ignore.ts / packet.ts / evidence-rules.ts flavor). Do NOT use for the
// reasoning/intent/provider flavor, which drops falsy values.
export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// De-dupe AND drop falsy values (matches reasoning.ts unique / intent.ts
// unique / provider.ts uniqueStrings). Distinct semantics from `unique`.
export function uniqueTruthy<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

export function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Drop undefined-valued keys by round-tripping through JSON. Used to omit
// undefined fields before byte-stable serialization.
export function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
