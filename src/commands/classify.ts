export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function commandLooksLikeTestCommand(command: string): boolean {
  return /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test(?::[\w.-]+)?|node\s+--test|(?:pnpm|npm|yarn|bun)\s+exec\s+(?:vitest|jest|tap|uvu)|(?:vitest|jest|tap|uvu))(?:\s|$)/.test(normalizeCommand(command));
}

export function commandLooksLikeFocusedTestCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return /(?:^|\s)(?:dist\/)?tests\/\S+|(?:^|\s)\S+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s|$)|(?:--test-name-pattern|--grep|-t)(?:=|\s)/.test(normalized);
}

export function commandLooksLikeBroadTestCommand(command: string): boolean {
  return commandLooksLikeTestCommand(command) && !commandLooksLikeFocusedTestCommand(command);
}

export function commandLooksLikeLocalValidationCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return (
    commandLooksLikeTestCommand(normalized) ||
    /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:lint|typecheck|build)|tsc(?:\s|$))/.test(normalized)
  );
}
