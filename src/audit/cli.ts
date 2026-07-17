import fs from "node:fs";
import path from "node:path";
import { groundAgreementAudit } from "./grounding";
import { buildAuditPrompt, type AuditPromptMode } from "./prompt";
import { renderAgreementAuditMarkdown } from "./render";
import { parseAgreementAuditCandidate, parseAgreementAuditInput } from "./parse";

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
    const flags = parseFlags(rest, ["input", "candidate", "out"]);
    const input = parseAgreementAuditInput(readJson(requiredFlag(flags, "input")));
    const candidate = parseAgreementAuditCandidate(readJson(requiredFlag(flags, "candidate")));
    const out = path.resolve(flags.get("out") ?? ".agreement-audit");
    const audit = groundAgreementAudit(input, {
      ...candidate,
      limitations: [
        ...candidate.limitations,
        "Evidence was supplied as JSON; trusted collection from Git and transcript bytes was not performed."
      ]
    });
    ensureOutputDirectory(out);
    const jsonPath = path.join(out, "audit.json");
    const markdownPath = path.join(out, "audit.md");
    assertWritableArtifactPath(jsonPath);
    assertWritableArtifactPath(markdownPath);
    writePrivateFile(jsonPath, `${JSON.stringify(audit, null, 2)}\n`);
    writePrivateFile(markdownPath, renderAgreementAuditMarkdown(audit));
    process.stdout.write(`${markdownPath}\n`);
    return audit.status === "cannot_audit" ? 4 : 0;
  }
  process.stderr.write("Usage: agreement-audit prompt --input <json> [--mode plain-agent|review-surfaces]\n");
  process.stderr.write("       agreement-audit finalize --input <json> --candidate <json> [--out <dir>]\n");
  return 2;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as unknown;
}

function ensureOutputDirectory(directory: string): void {
  if (fs.existsSync(directory)) {
    const metadata = fs.lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("--out must name a real directory, not a file or symbolic link");
    }
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writePrivateFile(file: string, content: string): void {
  assertWritableArtifactPath(file);
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function assertWritableArtifactPath(file: string): void {
  const metadata = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!metadata) return;
  if (metadata.isSymbolicLink()) throw new Error(`refusing to write through symbolic link ${path.basename(file)}`);
  if (!metadata.isFile()) throw new Error(`refusing to replace non-file artifact ${path.basename(file)}`);
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
