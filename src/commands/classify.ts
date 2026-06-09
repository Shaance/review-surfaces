const FOCUSED_TEST_TARGET_PATTERN = /(?:^|\s)(?:(?:dist\/)?tests|test|src|lib|app|packages)\/\S+|(?:^|\s)\S+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s|$)/;
const TEST_NAME_FILTER_PATTERN = /(?:^|\s)(?:--test-name-pattern|--grep|-t)(?:=|\s)/;
const TEST_SCRIPT_ALIAS_PATTERN = /^(?:run\s+)?test:([\w.:-]+)(?:\s|$)/;

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
  const nodeTestFocused = nodeTestFocusClassification(normalized);
  if (nodeTestFocused !== undefined) {
    return nodeTestFocused;
  }
  const parsedPackageCommand = parsedPackageManagerCommand(normalized);
  const packageCommandBody = parsedPackageCommand?.body ?? "";
  const testScriptAlias = packageCommandBody.match(TEST_SCRIPT_ALIAS_PATTERN)?.[1];
  const hasPackageFocusFilter = parsedPackageCommand?.hasFocusFilter === true
    || packageCommandBodyHasFocusFilter(parsedPackageCommand);
  return (hasPackageFocusFilter && commandLooksLikeTestCommand(normalized))
    || (testScriptAlias !== undefined && !looksLikeBroadTestScriptAlias(testScriptAlias))
    || hasFocusedTestTarget(normalized)
    || hasTestNameFilter(normalized);
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
  manager: string;
  body: string;
  hasFocusFilter: boolean;
}

function parsedPackageManagerCommand(normalized: string): ParsedPackageManagerCommand | undefined {
  const tokens = normalized.split(" ").filter(Boolean);
  const manager = tokens[0];
  if (!["pnpm", "npm", "yarn", "bun"].includes(manager)) {
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
    if (packageManagerOptionIsFocusFilter(manager, token)) {
      hasFocusFilter = true;
    }
    index += packageManagerOptionConsumesNext(manager, token) ? 2 : 1;
  }

  return { manager, body: tokens.slice(index).join(" "), hasFocusFilter };
}

function packageManagerBodyLooksLikeTest(body: string): boolean {
  return /^(?:(?:run\s+)?test(?::[\w.:-]+)?|exec\s+(?:vitest|jest|tap|uvu))(?:\s|$)/.test(body);
}

function packageCommandBodyHasFocusFilter(parsed: ParsedPackageManagerCommand | undefined): boolean {
  if (!parsed) {
    return false;
  }
  for (const token of parsed.body.split(" ").filter(Boolean)) {
    if (token === "--") {
      break;
    }
    if (packageManagerOptionIsFocusFilter(parsed.manager, token)) {
      return true;
    }
  }
  return false;
}

function packageManagerOptionIsFocusFilter(manager: string, option: string): boolean {
  return /^(?:--filter(?:=|$)|-F(?:\S|$)|--workspace(?:=|$)|--scope(?:=|$))/.test(option)
    || (manager === "npm" && /^(?:-w|-w=|-w\S)/.test(option));
}

function packageManagerOptionConsumesNext(manager: string, option: string): boolean {
  if (option.includes("=") || /^-F\S+/.test(option) || (manager === "npm" && /^-w\S+/.test(option) && option !== "-w")) {
    return false;
  }
  return ["--filter", "-F", "--workspace", "--scope", "--cwd", "--prefix", "--dir", "-C", "--config", "--registry"].includes(option)
    || (manager === "npm" && option === "-w");
}

function nodeTestFocusClassification(normalized: string): boolean | undefined {
  const match = normalized.match(/^node\s+--test(?:\s+(.*))?$/);
  if (!match) {
    return undefined;
  }
  const args = match[1]?.trim() ?? "";
  if (!args) {
    return false;
  }
  if (hasTestNameFilter(args)) {
    return true;
  }
  const positionalArgs = nodeTestPositionalArgs(args);
  if (positionalArgs.length === 0) {
    return false;
  }
  if (positionalArgs.every((token) => token.includes("*"))) {
    return false;
  }
  return hasFocusedTestTarget(positionalArgs.join(" "));
}

function hasFocusedTestTarget(value: string): boolean {
  return FOCUSED_TEST_TARGET_PATTERN.test(value);
}

function hasTestNameFilter(value: string): boolean {
  return TEST_NAME_FILTER_PATTERN.test(value);
}

function nodeTestPositionalArgs(args: string): string[] {
  const tokens = args.split(" ").filter(Boolean);
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (token.startsWith("-")) {
      if (nodeTestOptionConsumesNext(token)) {
        index += 1;
      }
      continue;
    }
    positionals.push(token);
  }
  return positionals;
}

function nodeTestOptionConsumesNext(option: string): boolean {
  if (option.includes("=")) {
    return false;
  }
  return [
    "--test-reporter",
    "--test-reporter-destination",
    "--test-shard"
  ].includes(option);
}
