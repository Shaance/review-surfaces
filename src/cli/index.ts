import path from "node:path";
import { collectInputs, CollectionResult } from "../collector/collect";
import { loadConfig, ReviewSurfacesConfig } from "../config/config";
import { CliError, ExitCodes } from "../core/exit-codes";
import { fileExists } from "../core/files";
import { buildArchitecture } from "../diagrams/diagrams";
import { buildDogfood } from "../dogfood/dogfood";
import { evaluateIntent } from "../evaluation/evaluate";
import { buildIntent } from "../intent/intent";
import { enrichPacket, EnrichmentResult, parseProviderName, ProviderName } from "../llm/provider";
import { buildMethodology } from "../methodology/methodology";
import { analyzeRisks } from "../risks/risks";
import { createReviewPacket, writeReviewPacket } from "../render/packet";
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
      await runCollect(parsed);
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

async function runCollect(parsed: ParsedArgs): Promise<void> {
  const { collection } = await collect(parsed);
  console.log(`Wrote review-surfaces artifacts to ${path.relative(process.cwd(), collection.outputDir) || "."}`);
}

async function collect(parsed: ParsedArgs): Promise<{ collection: CollectionResult; config: ReviewSurfacesConfig }> {
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
  return { collection, config: runConfig };
}

async function runAll(parsed: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const { collection, config } = await collect(parsed);
  const commands = [`review-surfaces ${parsed.command} ${process.argv.slice(3).join(" ")}`.trim()];
  const provider = providerFlag(parsed, config);
  const requestedModel = stringFlag(parsed, "model") ?? config.llm.model ?? undefined;
  const intent = await buildIntent(cwd, collection);
  const evaluation = await evaluateIntent(cwd, collection, intent);
  const methodology = await buildMethodology(cwd, collection, stringFlag(parsed, "conversation"), commands);
  const risks = analyzeRisks(collection, evaluation, commands);
  const architecture = await buildArchitecture(collection, evaluation);
  const preEnrichment: EnrichmentResult = {
    provider,
    model: requestedModel,
    status: "not_requested",
    summary: "Enrichment has not run yet."
  };
  const packet = createReviewPacket({
    collection,
    intent,
    evaluation,
    methodology,
    risks,
    architecture,
    enrichment: preEnrichment,
    commands
  });
  const enrichment = await enrichPacket(packet, {
    cwd,
    provider,
    model: requestedModel,
    agentInput: stringFlag(parsed, "agent-input"),
    outputDir: collection.outputDir,
    redactSecrets: config.privacy.redact_secrets,
    remotePrivacyBlocked: collection.privacy.remote_provider_blocked
  });
  const dogfood = isDogfoodRun(parsed) ? buildDogfood(collection, evaluation, risks, methodology, `${enrichment.provider}/${enrichment.status}`, commands) : undefined;
  await writeReviewPacket({
    collection,
    intent: packet.intent,
    evaluation: packet.evaluation,
    methodology: packet.methodology,
    risks: packet.risks,
    architecture: packet.architecture,
    dogfood,
    enrichment,
    commands
  });
  if (enrichment.status === "skipped" || enrichment.status === "failed") {
    console.warn(enrichment.summary);
  }
  console.log(`Wrote review-surfaces artifacts to ${path.relative(cwd, collection.outputDir) || "."}`);
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

function providerFlag(parsed: ParsedArgs, config: ReviewSurfacesConfig): ProviderName {
  const provider = stringFlag(parsed, "provider") ?? config.llm.provider;
  try {
    return parseProviderName(provider);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), ExitCodes.usageError);
  }
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
  --conversation <path>
                   Optional text/Markdown/JSONL/YAML conversation log for methodology
  --provider <name> Optional enrichment provider: mock, ai-sdk, agent-file. Default mock
  --model <model>   Optional AI SDK model, e.g. google:gemini-2.5-flash
  --agent-input <path>
                   Structured JSON/YAML enrichment produced by a coding agent
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
