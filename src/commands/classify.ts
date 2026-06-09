const FOCUSED_TEST_TARGET_PATTERN = /(?:^|\s)(?:(?:dist\/)?tests|test|src|lib|app|packages)\/\S+|(?:^|\s)\S+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s|$)/;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const TEST_NAME_FILTER_PATTERN = /(?:^|\s)(?:--test-name-pattern|--testNamePattern|--grep|-t)(?:=|\s)/;
const TEST_PROJECT_FILTER_PATTERN = /(?:^|\s)(?:--project|--selectProjects)(?:=|\s)/;
const TEST_SCRIPT_ALIAS_PATTERN = /^(?:run\s+)?test:([\w.:-]+)(?:\s|$)/;

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function commandLooksLikeTestCommand(command: string): boolean {
  const normalized = normalizeCommandForClassification(command);
  return commandLooksLikeTestCommandFromNormalized(normalized);
}

function commandLooksLikeTestCommandFromNormalized(normalized: string, parsedPackageCommand = parsedPackageManagerCommand(normalized)): boolean {
  return packageManagerBodyLooksLikeTest(parsedPackageCommand?.body ?? "")
    || nodeTestArgs(normalized) !== undefined
    || /^(?:vitest|jest|tap|uvu)(?:\s|$)/.test(normalized);
}

export function commandLooksLikeFocusedTestCommand(command: string): boolean {
  const normalized = normalizeCommandForClassification(command);
  const nodeTestFocused = nodeTestFocusClassification(normalized);
  if (nodeTestFocused !== undefined) {
    return nodeTestFocused;
  }
  const parsedPackageCommand = parsedPackageManagerCommand(normalized);
  const packageCommandBody = parsedPackageCommand?.body ?? "";
  const yarnWorkspacesBody = parseYarnWorkspacesBody(packageCommandBody);
  const looksLikeTest = commandLooksLikeTestCommandFromNormalized(normalized, parsedPackageCommand);
  const testScriptAlias = packageTestScriptAlias(packageCommandBody);
  const hasPackageFocusFilter = parsedPackageCommand?.hasFocusFilter === true
    || packageCommandBodyHasFocusFilter(parsedPackageCommand);
  const execNodeTestCommand = packageManagerExecNodeTestCommand(packageCommandBody);
  if (execNodeTestCommand !== undefined) {
    return hasPackageFocusFilter || (nodeTestFocusClassification(execNodeTestCommand) ?? false);
  }
  return (hasPackageFocusFilter && looksLikeTest)
    || (testScriptAlias !== undefined && !looksLikeBroadTestScriptAlias(testScriptAlias))
    || ((yarnWorkspacesBody?.hasFocusFilter ?? false) && looksLikeTest)
    || (hasChangedOnlyTestFilter(normalized) && looksLikeTest)
    || (hasProjectOnlyTestFilter(normalized) && looksLikeTest)
    || hasFocusedTestTarget(normalized)
    || hasTestNameFilter(normalized);
}

export function commandLooksLikeBroadTestCommand(command: string): boolean {
  return commandLooksLikeTestCommand(command) && !commandLooksLikeFocusedTestCommand(command);
}

export function commandLooksLikeLocalValidationCommand(command: string): boolean {
  const normalized = normalizeCommandForClassification(command);
  const parsedPackageCommand = parsedPackageManagerCommand(normalized);
  const packageCommandBody = parsedPackageCommand?.body ?? "";
  return (
    commandLooksLikeTestCommandFromNormalized(normalized, parsedPackageCommand) ||
    /^(?:(?:run\s+)?(?:lint|typecheck|build)(?:\s|$))/.test(packageCommandBody) ||
    /^tsc(?:\s|$)/.test(normalized)
  );
}

function normalizeCommandForClassification(command: string): string {
  const normalized = normalizeCommand(command);
  const firstWordEnd = shellWordEnd(normalized, 0);
  if (!ENV_ASSIGNMENT_PATTERN.test(normalized.slice(0, firstWordEnd))) {
    return normalized;
  }

  let index = 0;
  while (index < normalized.length) {
    const wordEnd = shellWordEnd(normalized, index);
    if (!ENV_ASSIGNMENT_PATTERN.test(normalized.slice(index, wordEnd))) {
      break;
    }
    index = wordEnd;
    while (normalized[index] === " ") {
      index += 1;
    }
  }
  return normalized.slice(index);
}

function shellWordEnd(value: string, start: number): number {
  let quote: string | undefined;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === " ") {
      return index;
    }
  }
  return value.length;
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
  return packageRunScriptLooksLikeTest(body)
    || /^(?:(?:vitest|jest|tap|uvu)|exec\s+(?:--\s+)?(?:vitest|jest|tap|uvu))(?:\s|$)/.test(body)
    || (parseYarnWorkspacesBody(body)?.looksLikeTest ?? false)
    || packageManagerExecNodeTestCommand(body) !== undefined;
}

function packageRunScriptLooksLikeTest(body: string): boolean {
  return testScriptTokenLooksLikeTest(packageRunScriptToken(body));
}

function packageTestScriptAlias(body: string): string | undefined {
  return packageRunScriptToken(body)?.match(TEST_SCRIPT_ALIAS_PATTERN)?.[1];
}

function packageRunScriptToken(body: string): string | undefined {
  const tokens = body.split(" ").filter(Boolean);
  if (tokens[0] !== "run") {
    return tokens[0];
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      return undefined;
    }
    if (!token.startsWith("-")) {
      return token;
    }
    if (packageRunOptionConsumesNext(token)) {
      index += 1;
    }
  }
  return undefined;
}

function packageRunOptionConsumesNext(option: string): boolean {
  if (option.includes("=")) {
    return false;
  }
  return ["--filter", "-F", "--workspace", "-w", "--prefix", "--jobs"].includes(option);
}

interface YarnWorkspacesBody {
  looksLikeTest: boolean;
  hasFocusFilter: boolean;
}

function parseYarnWorkspacesBody(body: string): YarnWorkspacesBody | undefined {
  const tokens = body.split(" ").filter(Boolean);
  if (tokens[0] !== "workspaces") {
    return undefined;
  }
  if (tokens[1] === "run") {
    return {
      looksLikeTest: testScriptTokenLooksLikeTest(tokens[2]),
      hasFocusFilter: false
    };
  }
  if (tokens[1] === "foreach") {
    const runIndex = tokens.indexOf("run", 2);
    return {
      looksLikeTest: runIndex >= 0 && testScriptTokenLooksLikeTest(tokens[runIndex + 1]),
      hasFocusFilter: tokens.slice(2, runIndex >= 0 ? runIndex : undefined).some(yarnForeachOptionIsFocusFilter)
    };
  }
  return {
    looksLikeTest: false,
    hasFocusFilter: false
  };
}

function yarnForeachOptionIsFocusFilter(token: string): boolean {
  return token === "--include"
    || token.startsWith("--include=")
    || token === "--from"
    || token.startsWith("--from=")
    || token === "--since"
    || token.startsWith("--since=");
}

function testScriptTokenLooksLikeTest(token: string | undefined): boolean {
  return token !== undefined && /^test(?::[\w.:-]+)?$/.test(token);
}

function packageCommandBodyHasFocusFilter(parsed: ParsedPackageManagerCommand | undefined): boolean {
  if (!parsed || parsed.manager !== "npm" || !packageRunScriptLooksLikeTest(parsed.body)) {
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
  return focusedTestTargetTokens(value).some((token) => {
    const normalized = normalizeTargetToken(token);
    return !nodeTestGlobLooksBroad(normalized) && FOCUSED_TEST_TARGET_PATTERN.test(` ${normalized} `);
  });
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

function normalizeTargetToken(token: string): string {
  return cleanCommandToken(token).replace(/^\.\//, "");
}

function nodeTestGlobLooksBroad(token: string): boolean {
  const normalized = normalizeTargetToken(token);
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
      const inlineTarget = runnerInlineFocusTarget(token);
      if (inlineTarget !== undefined) {
        targets.push(inlineTarget);
      }
      if (runnerOptionConsumesNext(token)) {
        index += 1;
      }
      continue;
    }
    targets.push(cleanCommandToken(token));
  }
  return targets;
}

function runnerInlineFocusTarget(option: string): string | undefined {
  const separatorIndex = option.indexOf("=");
  if (separatorIndex <= 0) {
    return undefined;
  }
  const name = option.slice(0, separatorIndex);
  if (name !== "--dir") {
    return undefined;
  }
  return cleanCommandToken(option.slice(separatorIndex + 1));
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
