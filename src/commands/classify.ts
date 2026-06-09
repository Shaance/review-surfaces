const FOCUSED_TEST_TARGET_PATTERN = /(?:^|\s)(?:(?:dist\/)?tests|test|src|lib|app|packages)\/\S+|(?:^|\s)\S+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s|$)/;
const TEST_NAME_FILTER_PATTERN = /(?:^|\s)(?:--test-name-pattern|--testNamePattern|--grep|-t)(?:=|\s)/;
const TEST_PROJECT_FILTER_PATTERN = /(?:^|\s)(?:--project|--selectProjects)(?:=|\s)/;
const TEST_SCRIPT_ALIAS_PATTERN = /^(?:run\s+)?test:([\w.:-]+)(?:\s|$)/;

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function commandLooksLikeTestCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return packageManagerBodyLooksLikeTest(parsedPackageManagerCommand(normalized)?.body ?? "")
    || nodeTestArgs(normalized) !== undefined
    || /^(?:vitest|jest|tap|uvu)(?:\s|$)/.test(normalized);
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
  const execNodeTestCommand = packageManagerExecNodeTestCommand(packageCommandBody);
  if (execNodeTestCommand !== undefined) {
    return hasPackageFocusFilter || (nodeTestFocusClassification(execNodeTestCommand) ?? false);
  }
  return (hasPackageFocusFilter && commandLooksLikeTestCommand(normalized))
    || (testScriptAlias !== undefined && !looksLikeBroadTestScriptAlias(testScriptAlias))
    || (hasChangedOnlyTestFilter(normalized) && commandLooksLikeTestCommand(normalized))
    || (hasProjectOnlyTestFilter(normalized) && commandLooksLikeTestCommand(normalized))
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
    const consumesNext = packageManagerOptionConsumesNext(manager, token);
    const optionValue = packageManagerOptionValue(manager, token, consumesNext ? tokens[index + 1] : undefined);
    if (packageManagerOptionIsFocusFilter(manager, token, optionValue)) {
      hasFocusFilter = true;
    }
    index += consumesNext ? 2 : 1;
  }

  return { manager, body: tokens.slice(index).join(" "), hasFocusFilter };
}

function packageManagerBodyLooksLikeTest(body: string): boolean {
  return /^(?:(?:run\s+)?test(?::[\w.:-]+)?|(?:vitest|jest|tap|uvu)|exec\s+(?:--\s+)?(?:vitest|jest|tap|uvu))(?:\s|$)/.test(body)
    || yarnWorkspacesBodyLooksLikeTest(body)
    || packageManagerExecNodeTestCommand(body) !== undefined;
}

function yarnWorkspacesBodyLooksLikeTest(body: string): boolean {
  const tokens = body.split(" ").filter(Boolean);
  if (tokens[0] !== "workspaces") {
    return false;
  }
  if (tokens[1] === "run") {
    return testScriptTokenLooksLikeTest(tokens[2]);
  }
  if (tokens[1] === "foreach") {
    const runIndex = tokens.indexOf("run", 2);
    return runIndex >= 0 && testScriptTokenLooksLikeTest(tokens[runIndex + 1]);
  }
  return false;
}

function testScriptTokenLooksLikeTest(token: string | undefined): boolean {
  return token !== undefined && /^test(?::[\w.:-]+)?$/.test(token);
}

function packageCommandBodyHasFocusFilter(parsed: ParsedPackageManagerCommand | undefined): boolean {
  if (!parsed || parsed.manager !== "npm" || !/^(?:run\s+)?test(?::[\w.:-]+)?(?:\s|$)/.test(parsed.body)) {
    return false;
  }
  const tokens = parsed.body.split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      break;
    }
    const consumesNext = packageManagerOptionConsumesNext(parsed.manager, token);
    const optionValue = packageManagerOptionValue(parsed.manager, token, consumesNext ? tokens[index + 1] : undefined);
    if (packageManagerOptionIsFocusFilter(parsed.manager, token, optionValue)) {
      return true;
    }
    if (consumesNext) {
      index += 1;
    }
  }
  return false;
}

function packageManagerExecNodeTestCommand(body: string): string | undefined {
  const match = body.match(/^exec\s+(?:--\s+)?(node\s+.*)$/);
  if (!match) {
    return undefined;
  }
  return nodeTestArgs(match[1]) !== undefined ? match[1] : undefined;
}

function packageManagerOptionIsFocusFilter(manager: string, option: string, value?: string): boolean {
  if (packageManagerOptionIsRootCwdOverride(manager, option, value)) {
    return false;
  }
  return /^(?:--filter(?:=|$)|-F(?:\S|$)|--workspace(?:=|$)|--scope(?:=|$)|--dir(?:=|$)|--cwd(?:=|$)|-C(?:\S|$))/.test(option)
    || (manager === "npm" && /^(?:-w|-w=|-w\S|--prefix(?:=|$))/.test(option));
}

function packageManagerOptionValue(manager: string, option: string, nextToken: string | undefined): string | undefined {
  if (option.includes("=")) {
    return option.slice(option.indexOf("=") + 1);
  }
  if (/^-C\S+/.test(option)) {
    return option.slice(2);
  }
  if (/^-F\S+/.test(option)) {
    return option.slice(2);
  }
  if (manager === "npm" && /^-w\S+/.test(option) && option !== "-w") {
    return option.slice(2);
  }
  return nextToken;
}

function packageManagerOptionIsRootCwdOverride(manager: string, option: string, value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const optionIsCwdOverride = /^(?:--dir(?:=|$)|--cwd(?:=|$)|-C(?:\S|$))/.test(option)
    || (manager === "npm" && /^(?:--prefix(?:=|$))/.test(option));
  if (!optionIsCwdOverride) {
    return false;
  }
  const normalizedValue = cleanCommandToken(value).replace(/\/+$/, "");
  return normalizedValue === ".";
}

function packageManagerOptionConsumesNext(manager: string, option: string): boolean {
  if (option.includes("=") || /^-F\S+/.test(option) || (manager === "npm" && /^-w\S+/.test(option) && option !== "-w")) {
    return false;
  }
  return ["--filter", "-F", "--workspace", "--scope", "--cwd", "--prefix", "--dir", "-C", "--config", "--registry"].includes(option)
    || (manager === "npm" && option === "-w");
}

function nodeTestFocusClassification(normalized: string): boolean | undefined {
  const testArgs = nodeTestArgs(normalized);
  if (testArgs === undefined) {
    return undefined;
  }
  if (hasTestNameFilter(normalized)) {
    return true;
  }
  if (hasNodePartialTestFilter(normalized)) {
    return true;
  }
  if (testArgs.length === 0) {
    return false;
  }
  const positionalArgs = nodeTestPositionalArgs(testArgs);
  if (positionalArgs.length === 0) {
    return false;
  }
  if (positionalArgs.every((token) => token.includes("*"))) {
    return !positionalArgs.every(nodeTestGlobLooksBroad);
  }
  return hasFocusedTestTarget(positionalArgs.join(" "));
}

function hasFocusedTestTarget(value: string): boolean {
  return focusedTestTargetTokens(value).some((token) => !nodeTestGlobLooksBroad(token) && FOCUSED_TEST_TARGET_PATTERN.test(` ${token} `));
}

function hasTestNameFilter(value: string): boolean {
  return TEST_NAME_FILTER_PATTERN.test(value);
}

function hasChangedOnlyTestFilter(value: string): boolean {
  return /(?:^|\s)--changed(?:=|\s|$)/.test(value);
}

function hasProjectOnlyTestFilter(value: string): boolean {
  return TEST_PROJECT_FILTER_PATTERN.test(value);
}

function nodeTestArgs(normalized: string): string[] | undefined {
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens[0] !== "node") {
    return undefined;
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      return undefined;
    }
    if (token === "--test") {
      return tokens.slice(index + 1);
    }
    if (token.startsWith("-")) {
      if (nodeOptionConsumesNext(token)) {
        index += 1;
      }
      continue;
    }
    return undefined;
  }
  return undefined;
}

function nodeTestPositionalArgs(tokens: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1).map(cleanCommandToken));
      break;
    }
    if (token.startsWith("-")) {
      if (nodeOptionConsumesNext(token)) {
        index += 1;
      }
      continue;
    }
    positionals.push(cleanCommandToken(token));
  }
  return positionals;
}

function hasNodePartialTestFilter(value: string): boolean {
  const tokens = value.split(" ").filter(Boolean);
  for (const token of tokens) {
    if (token === "--") {
      break;
    }
    if (
      token === "--test-only"
      || token === "--test-shard"
      || token === "--test-skip-pattern"
      || token.startsWith("--test-shard=")
      || token.startsWith("--test-skip-pattern=")
    ) {
      return true;
    }
  }
  return false;
}

function nodeOptionConsumesNext(option: string): boolean {
  if (option.includes("=")) {
    return false;
  }
  return [
    "-r",
    "--conditions",
    "--env-file",
    "--env-file-if-exists",
    "--experimental-loader",
    "--icu-data-dir",
    "--import",
    "--inspect-port",
    "--loader",
    "--openssl-config",
    "--require",
    "--test-concurrency",
    "--test-coverage-exclude",
    "--test-coverage-include",
    "--test-global-setup",
    "--test-name-pattern",
    "--test-reporter",
    "--test-reporter-destination",
    "--test-skip-pattern",
    "--test-shard"
  ].includes(option);
}

function cleanCommandToken(token: string): string {
  return token.replace(/^(['"])(.*)\1$/, "$2");
}

function nodeTestGlobLooksBroad(token: string): boolean {
  const normalized = cleanCommandToken(token).replace(/^\.\//, "");
  return /^(?:(?:dist\/)?tests\/(?:\*\*\/)?|test\/\*\*\/|(?:\*\*\/)?)\*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized);
}

function focusedTestTargetTokens(value: string): string[] {
  const tokens = value.split(" ").filter(Boolean);
  const targets: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      continue;
    }
    if (token.startsWith("-")) {
      if (runnerOptionConsumesNext(token)) {
        index += 1;
      }
      continue;
    }
    targets.push(cleanCommandToken(token));
  }
  return targets;
}

function runnerOptionConsumesNext(option: string): boolean {
  if (option.includes("=")) {
    return false;
  }
  return [
    "-c",
    "--cacheDirectory",
    "--config",
    "--coverageDirectory",
    "--environment",
    "--outputFile",
    "--reporter",
    "--root",
    "--setupFilesAfterEnv",
    "--testEnvironment",
    "--workspace"
  ].includes(option);
}
