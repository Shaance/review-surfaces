import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readAgreementAuditLedgers } from "./ledgers";
import { groundAgreementAudit } from "./grounding";
import { buildAuditPrompt, buildCompletenessPrompt, type AuditPromptMode } from "./prompt";
import {
  parseAgreementAuditCandidate,
  parseAgreementAuditInput,
  parseComparableAgreementAudit
} from "./parse";
import { compareAgreementAuditDecisions } from "./comparison";
import { publishAgreementAuditArtifacts } from "./artifacts";
import { compareRecordedAgreementBenchmark, parseAgreementBenchmarkManifest } from "./benchmark";

export async function runAgreementAuditCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "prompt") {
    const flags = parseFlags(rest, ["input", "mode"]);
    const input = parseAgreementAuditInput(readJson(requiredFlag(flags, "input")));
    const mode = flags.get("mode") ?? "review-surfaces";
    if (mode !== "plain-agent" && mode !== "review-surfaces") {
      throw new Error("--mode must be plain-agent or review-surfaces");
    }
    process.stdout.write(`${buildAuditPrompt(input, mode as AuditPromptMode)}\n`);
    return 0;
  }
  if (command === "finalize") {
    const flags = parseFlags(rest, ["input", "candidate", "completeness", "previous-audit", "confirm-extraction", "out"]);
    const input = parseAgreementAuditInput(readJson(requiredFlag(flags, "input")));
    const candidateFile = path.resolve(requiredFlag(flags, "candidate"));
    const completenessFile = flags.get("completeness") ? path.resolve(flags.get("completeness")!) : undefined;
    const ledgers = completenessFile
      ? readAgreementAuditLedgers(candidateFile, completenessFile)
      : undefined;
    const candidate = ledgers?.candidate ?? parseAgreementAuditCandidate(readJson(candidateFile));
    const completeness = ledgers?.completeness;
    const out = path.resolve(flags.get("out") ?? ".agreement-audit");
    const audit = groundAgreementAudit(input, {
      ...candidate,
      limitations: [
        ...candidate.limitations,
        "Evidence was supplied as JSON; trusted collection from Git and transcript bytes was not performed."
      ]
    }, completeness, flags.get("confirm-extraction"), ledgers?.bytes);
    if (flags.get("previous-audit")) {
      audit.comparison = compareAgreementAuditDecisions(
        audit,
        parseComparableAgreementAudit(readJson(flags.get("previous-audit")!))
      );
    }
    const markdownPath = publishAgreementAuditArtifacts(out, audit);
    process.stdout.write(`${markdownPath}\n`);
    return audit.status === "cannot_audit" ? 4 : 0;
  }
  if (command === "completeness-prompt") {
    const flags = parseFlags(rest, ["input", "candidate"]);
    const input = parseAgreementAuditInput(readJson(requiredFlag(flags, "input")));
    const candidate = parseAgreementAuditCandidate(readJson(requiredFlag(flags, "candidate")));
    process.stdout.write(`${buildCompletenessPrompt(input, candidate)}\n`);
    return 0;
  }
  if (command === "benchmark-check") {
    const flags = parseFlags(rest, ["manifest", "comparison"]);
    const manifestFile = path.resolve(requiredFlag(flags, "manifest"));
    const manifest = parseAgreementBenchmarkManifest(readJson(manifestFile));
    const manifestRoot = path.dirname(manifestFile);
    for (const entry of manifest.cases) {
      if (fileSha256(path.join(manifestRoot, entry.input)) !== entry.input_sha256 ||
        fileSha256(path.join(manifestRoot, entry.gold)) !== entry.gold_sha256) {
        throw new Error(`benchmark fixture bytes do not match the frozen manifest for ${entry.id}`);
      }
    }
    const comparison = readJson(requiredFlag(flags, "comparison"));
    const result = compareRecordedAgreementBenchmark(comparison, manifest);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.recorded_requirements_met ? 0 : 10;
  }
  process.stderr.write("Usage: agreement-audit prompt --input <json> [--mode plain-agent|review-surfaces]\n");
  process.stderr.write("       agreement-audit completeness-prompt --input <json> --candidate <json>\n");
  process.stderr.write("       agreement-audit finalize --input <json> --candidate <json> [--completeness <json>] [--confirm-extraction <token>] [--previous-audit <json>] [--out <dir>]\n");
  process.stderr.write("       agreement-audit benchmark-check --manifest <holdout-manifest.json> --comparison <results.json>\n");
  return 2;
}

function readJson(file: string): unknown {
  return JSON.parse(readText(file)) as unknown;
}

function readText(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

function fileSha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function parseFlags(args: string[], allowed: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  const allowedNames = new Set(allowed);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--")) throw new Error(`Unexpected argument ${flag ?? "(missing)"}`);
    const name = flag.slice(2);
    if (!allowedNames.has(name)) throw new Error(`Unknown flag --${name}`);
    if (flags.has(name)) throw new Error(`Duplicate flag --${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    flags.set(name, value);
  }
  return flags;
}

if (require.main === module) {
  runAgreementAuditCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
