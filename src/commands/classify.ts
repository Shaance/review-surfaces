const FOCUSED_TEST_TARGET_PATTERN = /(?:^|\s)(?:(?:dist\/)?tests|test|src|lib|app|packages)\/\S+|(?:^|\s)\S+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s|$)/;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const TEST_NAME_FILTER_PATTERN = /(?:^|\s)(?:--test-name-pattern|--testNamePattern|--grep|-t)(?:=|\s)/;
const TEST_PATH_FILTER_PATTERN = /(?:^|\s)--testPathPatterns?(?:=|\s)/;
const TEST_PROJECT_FILTER_PATTERN = /(?:^|\s)(?:--project|--selectProjects)(?:=|\s)/;
const TEST_SCRIPT_ALIAS_PATTERN = /^(?:run\s+)?test:([\w.:-]+)(?:\s|$)/;

// Non-JS test runners the package/node classifier above does not model (Go, Rust,
// Python, Ruby, PHP, JVM, .NET, Elixir, Swift, Dart). Recognizing them lets the
// cross-language "tests ran / tests weakened" signals fire on non-Node repos
// instead of silently missing a real post-change test run (review-surfaces.COLLECTOR.7).
//
// Classification is RUNNER-AWARE: each runner head is identified, commands that do
// NOT execute tests (list/compile/collect-only) or explicitly exclude/skip the test
// task are screened out, and focus detection applies the runner's own selector
// vocabulary. A broad passing run is what SUPPRESSES the per-area test-gap risk, so
// the rules err toward a real full-suite run being BROAD and a clearly narrowed run
// being FOCUSED.
type CrossRunner =
  | "go" | "cargo" | "pytest" | "unittest" | "ruby" | "php"
  | "maven" | "gradle" | "dotnet" | "ctest" | "mix" | "swift" | "dart" | "orchestrator";

const CROSS_ECOSYSTEM_LAUNCHER = /^(?:bundle\s+exec|poetry\s+run|pdm\s+run|pipenv\s+run|uv\s+run)\s+/;

// Runner head -> the regex that recognizes its test invocation AND the prefix to
// strip before reading positionals (so `cargo nextest run login` yields the
// positional `login`, not `nextest`/`run`).
const CROSS_ECOSYSTEM_RUNNERS: Array<{ runner: CrossRunner; head: RegExp; strip: RegExp }> = [
  { runner: "go", head: /^go\s+test\b/, strip: /^go\s+test\s*/ },
  { runner: "cargo", head: /^cargo\s+(?:test|nextest\s+run)\b/, strip: /^cargo\s+(?:nextest\s+run|test)\s*/ },
  { runner: "pytest", head: /^(?:py\.?test|python[0-9.]*\s+-m\s+(?:pytest|nose2?))\b/, strip: /^(?:py\.?test|python[0-9.]*\s+-m\s+(?:pytest|nose2?))\s*/ },
  { runner: "unittest", head: /^python[0-9.]*\s+-m\s+unittest\b/, strip: /^python[0-9.]*\s+-m\s+unittest\s*/ },
  { runner: "orchestrator", head: /^(?:tox|nox)\b/, strip: /^(?:tox|nox)\s*/ },
  { runner: "ruby", head: /^(?:rspec|rake\s+(?:test|spec))\b/, strip: /^(?:rspec|rake\s+(?:test|spec))\s*/ },
  { runner: "php", head: /^(?:(?:\.\/)?vendor\/bin\/)?(?:phpunit|pest)\b/, strip: /^(?:(?:\.\/)?vendor\/bin\/)?(?:phpunit|pest)\s*/ },
  { runner: "dotnet", head: /^dotnet\s+test\b/, strip: /^dotnet\s+test\s*/ },
  { runner: "ctest", head: /^ctest\b/, strip: /^ctest\s*/ },
  { runner: "mix", head: /^mix\s+test\b/, strip: /^mix\s+test\s*/ },
  { runner: "swift", head: /^swift\s+test\b/, strip: /^swift\s+test\s*/ },
  { runner: "dart", head: /^(?:dart|flutter)\s+test\b/, strip: /^(?:dart|flutter)\s+test\s*/ },
  // mvn/gradle (and the ./mvnw/./gradlew wrappers) carry the test goal among other
  // goals/flags; focus is flag-only so the strip is just the launcher.
  { runner: "maven", head: /^(?:mvn|mvnw|\.\/mvnw)\b.*\b(?:test|verify|integration-test)\b/, strip: /^(?:mvn|mvnw|\.\/mvnw)\s*/ },
  { runner: "gradle", head: /^(?:gradle|gradlew|\.\/gradlew)\b.*\b(?:test|check|integrationTest|connectedAndroidTest)\b/, strip: /^(?:gradle|gradlew|\.\/gradlew)\s*/ }
];

// Recognized as a runner but does NOT execute tests, so must not be credited as a
// passing test run: go -list, cargo --no-run, pytest --collect-only, ctest -N/
// --show-only, a Gradle `-x test`/`--exclude-task test`, or a Maven test skip (Codex P2).
const CROSS_ECOSYSTEM_NO_EXECUTION =
  /(?:^|\s)(?:-list|--no-run|--collect-only|-N|--show-only)(?:[=\s]|$)|(?:^|\s)(?:-x\s+test|--exclude-task[=\s]test)\b|(?:^|\s)-D(?:skipTests|maven\.test\.skip)\b/;

// Explicit focus selectors shared across runners: go -run, pytest -k, dotnet/gradle
// --filter/--tests, cargo --test, ctest -R, mix --only, dart/flutter --name, maven
// -Dtest=, rake TEST=. NOTE: `-e` is NOT here — it collides with Maven's --errors;
// it counts as a focus flag only for Ruby/rspec (handled per-runner).
const CROSS_ECOSYSTEM_FOCUS_FLAG =
  /(?:^|\s)(?:-run|-k|--filter|--tests?|--name|--plain-name|--example|-R|--only)(?:[=\s]|$)|(?:^|\s)(?:-Dtest|TEST)=/;

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
    || /^(?:vitest|jest|tap|uvu)(?:\s|$)/.test(normalized)
    || crossEcosystemTestKind(normalized) !== undefined;
}

export function commandLooksLikeFocusedTestCommand(command: string): boolean {
  const normalized = normalizeCommandForClassification(command);
  const crossEcosystemKind = crossEcosystemTestKind(normalized);
  if (crossEcosystemKind !== undefined) {
    return crossEcosystemKind === "focused";
  }
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
    || (hasTestPathFilter(normalized) && looksLikeTest)
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
    packageRunScriptLooksLikeLocalValidation(packageCommandBody) ||
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

// undefined when `normalized` is not a recognized non-JS test RUN; otherwise "broad"
// (whole suite) or "focused" (narrowed to a flag/target). A command that recognizes
// as a runner but does not execute tests (list/compile/collect-only, or an excluded/
// skipped test task) returns undefined — it is not a passing test run (Codex P2).
function crossEcosystemTestKind(normalized: string): "broad" | "focused" | undefined {
  const command = normalized.replace(CROSS_ECOSYSTEM_LAUNCHER, "");
  const match = CROSS_ECOSYSTEM_RUNNERS.find((entry) => entry.head.test(command));
  if (match === undefined) {
    return undefined;
  }
  if (CROSS_ECOSYSTEM_NO_EXECUTION.test(command)) {
    return undefined;
  }
  return crossEcosystemTestIsFocused(match.runner, match.strip, command) ? "focused" : "broad";
}

function crossEcosystemTestIsFocused(runner: CrossRunner, strip: RegExp, command: string): boolean {
  if (CROSS_ECOSYSTEM_FOCUS_FLAG.test(command)) {
    return true;
  }
  if (runner === "ruby" && /(?:^|\s)-e(?:[=\s]|$)/.test(command)) {
    return true; // rspec -e "description" (Ruby-only; -e is Maven's --errors elsewhere)
  }
  // unittest `discover` is a whole-suite run; its -p PATTERN is discovery, not a focus.
  if (runner === "unittest" && /(?:^|\s)discover(?:\s|$)/.test(command)) {
    return false;
  }
  const positionals = command
    .replace(strip, "")
    .split(/\s+/)
    .map(cleanCommandToken)
    .filter((token) => token !== "" && !token.startsWith("-"));
  if (runner === "go") {
    // An explicit package argument narrows the run; `./...`, `...`, `pkg/...`, `.`
    // are the whole-module globs that stay broad.
    return positionals.some((token) => !isBroadGoPackageTarget(token));
  }
  if (runner === "cargo") {
    // `cargo test <name>` filters by substring — any bare positional narrows it.
    return positionals.length > 0;
  }
  // pytest / ruby / php / mix / unittest: a specific test FILE or test id, never a
  // bare directory or a glob.
  return positionals.some(isSpecificTestTargetToken);
}

function isBroadGoPackageTarget(token: string): boolean {
  return token === "." || token === "./" || token === "..." || /(?:^|\/)\.\.\.$/.test(token);
}

function isSpecificTestTargetToken(token: string): boolean {
  const value = cleanCommandToken(token);
  if (value === "" || value.startsWith("-")) {
    return false;
  }
  // A glob/discovery pattern (`*_test.py`, `**/foo`) targets a SET, not one test.
  if (value.includes("*")) {
    return false;
  }
  if (value.includes("::")) {
    return true; // pytest/rust node id (file.py::test, module::tests)
  }
  if (/:[0-9]+$/.test(value)) {
    return true; // rspec/file:line target
  }
  // A specific test FILE passed positionally (pytest/rspec/phpunit/mix). Bare
  // directory or package positionals deliberately do NOT match — they stay broad.
  return /\.(?:py|rb|php|exs)$/i.test(value.split("::")[0]);
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

function packageRunScriptLooksLikeLocalValidation(body: string): boolean {
  return /^(?:lint|typecheck|build)(?::[\w.:-]+)?$/.test(packageRunScriptToken(body) ?? "");
}

function packageTestScriptAlias(body: string): string | undefined {
  return packageRunScriptToken(body)?.match(TEST_SCRIPT_ALIAS_PATTERN)?.[1];
}

function packageRunScriptToken(body: string): string | undefined {
  const tokens = body.split(" ").filter(Boolean);
  if (tokens[0] !== "run" && tokens[0] !== "run-script") {
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
  return /(?:^|\s)(?:--changed|--onlyChanged|--changedSince)(?:=|\s|$)|(?:^|\s)-o(?:\s|$)/.test(value);
}

function hasTestPathFilter(value: string): boolean {
  return TEST_PATH_FILTER_PATTERN.test(value);
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
