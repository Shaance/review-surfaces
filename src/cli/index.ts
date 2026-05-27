import path from "node:path";
import { collectInputs } from "../collector/collect";
import { loadConfig } from "../config/config";
import { CliError, ExitCodes } from "../core/exit-codes";
import { fileExists } from "../core/files";
import { renderSkeletonPacket } from "../render/packet";
import { validateJsonFile } from "../schema/json-schema";

const COMMANDS = [
  "init",
  "bootstrap",
  "collect",
  "intent",
  "evaluate",
  "diagrams",
  "methodology",
  "risks",
  "dogfood",
  "handoff",
  "packet",
  "all",
  "validate",
  "comment"
];

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.help || parsed.command === "help") {
    printHelp();
    return ExitCodes.success;
  }

  if (!COMMANDS.includes(parsed.command)) {
    throw new CliError(`Unknown command: ${parsed.command}`, ExitCodes.usageError);
  }

  switch (parsed.command) {
    case "collect":
      await runCollect(parsed, false);
      return ExitCodes.success;
    case "all":
      await runAll(parsed);
      return ExitCodes.success;
    case "validate":
      return runValidate(parsed);
    case "intent":
    case "evaluate":
    case "diagrams":
    case "methodology":
    case "risks":
    case "dogfood":
    case "handoff":
    case "packet":
      await runAll(parsed);
      return ExitCodes.success;
    case "init":
    case "bootstrap":
      console.log("Bootstrap files are already expected in this repository. Full bootstrap mutation is not implemented yet.");
      return ExitCodes.success;
    case "comment":
      console.log("Provider comments are intentionally deferred; local artifacts are the MVP surface.");
      return ExitCodes.success;
    default:
      throw new CliError(`Unhandled command: ${parsed.command}`, ExitCodes.runtimeError);
  }
}

async function runCollect(parsed: ParsedArgs, renderPacket: boolean): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd, stringFlag(parsed, "config") ?? "review-surfaces.config.yaml");
  const specFlag = stringFlag(parsed, "spec");
  const runConfig = specFlag ? { ...config, specs: [specFlag] } : config;
  const collection = await collectInputs({
    cwd,
    config: runConfig,
    baseRef: stringFlag(parsed, "base") ?? "origin/main",
    headRef: stringFlag(parsed, "head") ?? "HEAD",
    outputDir: stringFlag(parsed, "out"),
    dogfood: isDogfoodRun(parsed)
  });

  if (renderPacket) {
    await renderSkeletonPacket(collection, isDogfoodRun(parsed));
  }

  console.log(`Wrote review-surfaces artifacts to ${path.relative(cwd, collection.outputDir) || "."}`);
}

async function runAll(parsed: ParsedArgs): Promise<void> {
  await runCollect(parsed, true);
}

async function runValidate(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const target = parsed.positionals[0] ?? ".review-surfaces/review_packet.json";
  const targetPath = path.resolve(cwd, target);
  const packetPath = targetPath.endsWith(".json") ? targetPath : path.join(targetPath, "review_packet.json");
  if (!fileExists(packetPath)) {
    throw new CliError(`No review packet JSON found at ${path.relative(cwd, packetPath)}`, ExitCodes.schemaValidationFailed);
  }

  const schemaPath = path.resolve(cwd, stringFlag(parsed, "schema") ?? "schemas/review_packet.schema.json");
  const result = await validateJsonFile(schemaPath, packetPath);
  if (!result.valid) {
    for (const issue of result.issues) {
      console.error(`${issue.path}: ${issue.message}`);
    }
    return ExitCodes.schemaValidationFailed;
  }

  console.log(`Validated ${path.relative(cwd, packetPath)} against ${path.relative(cwd, schemaPath)}`);
  return ExitCodes.success;
}

function parseArgs(args: string[]): ParsedArgs {
  if (args[0] === "--") {
    args = args.slice(1);
  }

  const [command = "help", ...rest] = args;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }

    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }

  return { command, flags, positionals };
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  return typeof value === "string" ? value : undefined;
}

function booleanFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.flags[key] === true || parsed.flags[key] === "true";
}

function isDogfoodRun(parsed: ParsedArgs): boolean {
  return parsed.command === "dogfood" || booleanFlag(parsed, "dogfood");
}

function printHelp(): void {
  console.log(`review-surfaces 0.1.0

Local-first review packet compiler for agent-generated code changes.

Usage:
  review-surfaces <command> [options]

Commands:
  init          Create bootstrap files when missing (stub)
  bootstrap     Validate/bootstrap repository scaffolding (stub)
  collect       Write manifest and input indexes under .review-surfaces
  intent        Run the available local pipeline and write intent artifacts
  evaluate      Run the available local pipeline and write evaluation artifacts
  diagrams      Run the available local pipeline and write architecture artifacts
  methodology   Run the available local pipeline and write methodology artifacts
  risks         Run the available local pipeline and write risk artifacts
  dogfood       Run the available local pipeline in dogfood mode
  handoff       Run the available local pipeline and write agent handoff
  packet        Run the available local pipeline and write review packet
  all           Run the whole available local pipeline
  validate      Validate review_packet.json against schemas/review_packet.schema.json
  comment       Deferred provider renderer stub

Options:
  --base <ref>      Base ref for diff collection, default origin/main
  --head <ref>      Head ref for diff collection, default HEAD
  --spec <path>     Feature spec path, default from config
  --out <dir>       Output directory, default .review-surfaces
  --dogfood         Mark run as dogfood and include dogfood/handoff sections
  --config <path>   Config path, default review-surfaces.config.yaml
  --schema <path>   Schema path for validate, default schemas/review_packet.schema.json
  --help            Show this help
`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCodes.runtimeError;
  });
