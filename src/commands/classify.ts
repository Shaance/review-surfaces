export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function commandLooksLikeTestCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return packageManagerBodyLooksLikeTest(parsedPackageManagerCommand(normalized)?.body ?? "")
    || /^(?:node\s+--test|(?:vitest|jest|tap|uvu))(?:\s|$)/.test(normalized);
}

export function commandLooksLikeFocusedTestCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  const parsedPackageCommand = parsedPackageManagerCommand(normalized);
  const packageCommandBody = parsedPackageCommand?.body ?? "";
  const testScriptAlias = packageCommandBody.match(/^(?:run\s+)?test:([\w.-]+)(?:\s|$)/)?.[1];
  return (parsedPackageCommand?.hasFocusFilter === true && commandLooksLikeTestCommand(normalized))
    || (testScriptAlias !== undefined && !looksLikeBroadTestScriptAlias(testScriptAlias))
    || /(?:^|\s)(?:(?:dist\/)?tests|test|src|lib|app|packages)\/\S+|(?:^|\s)\S+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s|$)|(?:--test-name-pattern|--grep|-t)(?:=|\s)/.test(normalized);
}

export function commandLooksLikeBroadTestCommand(command: string): boolean {
  return commandLooksLikeTestCommand(command) && !commandLooksLikeFocusedTestCommand(command);
}

export function commandLooksLikeLocalValidationCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  const packageCommandBody = parsedPackageManagerCommand(normalized)?.body ?? "";
  return (
    commandLooksLikeTestCommand(normalized) ||
    /^(?:(?:run\s+)?(?:lint|typecheck|build)(?:\s|$))/.test(packageCommandBody) ||
    /^tsc(?:\s|$)/.test(normalized)
  );
}

function looksLikeBroadTestScriptAlias(alias: string): boolean {
  return /^(?:all|ci|cov|coverage|fast|full)(?:[.:_-]|$)/.test(alias);
}

interface ParsedPackageManagerCommand {
  body: string;
  hasFocusFilter: boolean;
}

function parsedPackageManagerCommand(normalized: string): ParsedPackageManagerCommand | undefined {
  const tokens = normalized.split(" ").filter(Boolean);
  if (!["pnpm", "npm", "yarn", "bun"].includes(tokens[0])) {
    return undefined;
  }

  let index = 1;
  let hasFocusFilter = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "workspace" && tokens[index + 1] !== undefined) {
      hasFocusFilter = true;
      index += 2;
      continue;
    }
    if (!token.startsWith("-")) {
      break;
    }
    if (packageManagerOptionIsFocusFilter(token)) {
      hasFocusFilter = true;
    }
    index += packageManagerOptionConsumesNext(token) ? 2 : 1;
  }

  return { body: tokens.slice(index).join(" "), hasFocusFilter };
}

function packageManagerBodyLooksLikeTest(body: string): boolean {
  return /^(?:(?:run\s+)?test(?::[\w.-]+)?|exec\s+(?:vitest|jest|tap|uvu))(?:\s|$)/.test(body);
}

function packageManagerOptionIsFocusFilter(option: string): boolean {
  return /^(?:--filter(?:=|$)|-F(?:\S|$)|--workspace(?:=|$)|--scope(?:=|$))/.test(option);
}

function packageManagerOptionConsumesNext(option: string): boolean {
  if (option.includes("=") || /^-F\S+/.test(option)) {
    return false;
  }
  return ["--filter", "-F", "--workspace", "--scope", "--cwd", "--prefix", "--dir", "-C", "--config", "--registry"].includes(option);
}
