// Deterministic, locale-independent string ordering. Replaces String.localeCompare
// (whose default uses the host's ICU/locale and can reorder mixed-case,
// punctuation, or non-ASCII keys across machines/CI images) so artifact ordering —
// and the byte-stable output the whole product and its caching depend on — is
// identical on every platform. Pure UTF-16 code-unit comparison.
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
