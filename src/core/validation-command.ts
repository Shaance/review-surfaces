const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;

export function normalizeValidationCommand(command: string): string {
  let normalized = command.trim().replace(/\s+/g, " ");
  if (normalized.startsWith("rtk ")) normalized = normalized.slice("rtk ".length);
  if (/^(?:\/usr\/bin\/env|env)(?:\s|$)/.test(normalized)) {
    normalized = normalized.replace(/^(?:\/usr\/bin\/env|env)\s*/, "");
  }
  let index = 0;
  while (index < normalized.length) {
    const wordEnd = shellWordEnd(normalized, index);
    if (!ENV_ASSIGNMENT_PATTERN.test(normalized.slice(index, wordEnd))) break;
    index = wordEnd;
    while (normalized[index] === " ") index += 1;
  }
  normalized = normalized.slice(index);
  return normalized.replace(
    /^\S*\/(bun|cargo|go|node|npm|pnpm|pytest|py\.test|tsc|yarn)(?=\s|$)/,
    "$1"
  );
}

// Structured pass/fail status is still required by the caller. This leaf-level
// predicate only admits commands that execute the established validation forms.
export function commandLooksLikeStandaloneValidation(command: string): boolean {
  return normalizedCommandLooksLikeStandaloneValidation(normalizeValidationCommand(command));
}

export function normalizedCommandLooksLikeStandaloneValidation(normalized: string): boolean {
  if (/(?:^|\s)(?:-h|--help|-V|--version)(?:\s|$)/.test(normalized)) return false;
  return /^tsc(?:\s|$)/.test(normalized) ||
    /^cargo\s+(?:check|clippy)(?:\s|$)/.test(normalized);
}

function shellWordEnd(value: string, start: number): number {
  let quote: string | undefined;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === "\"") quote = char;
    else if (char === " ") return index;
  }
  return value.length;
}
