import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommandTranscript, CommandTranscriptStatus } from "../contracts/command-transcript";
import { relativePath } from "../core/files";
import { isRecord, stripUndefined } from "../core/guards";
import { redactForArtifact } from "../privacy/redact";
import { containsBlockingSecretMaterial, redactSecrets } from "../privacy/secrets";

export type { CommandTranscript, CommandTranscriptStatus } from "../contracts/command-transcript";

export const COMMAND_TRANSCRIPT_OUTPUT_PATH = ".review-surfaces/inputs/commands.json";
export const COMMAND_TRANSCRIPT_INPUT_FILENAME = "commands.json";
export const COMMAND_TRANSCRIPT_SCHEMA_VERSION = "review-surfaces.command_transcripts.v1";
export const COMMAND_TRANSCRIPT_DIRNAME = "commands";
export const DEFAULT_COMMAND_TRANSCRIPT_DIR = ".review-surfaces/commands";

export const COMMAND_TRANSCRIPT_EXCERPT_LIMIT = 1200;
const MAX_TRANSCRIPT_FILE_BYTES = 1_000_000;
const MAX_RAW_OUTPUT_CHARS = 20_000;

export interface CommandTranscriptSourceHash {
  path: string;
  algorithm: "sha256";
  hash: string;
  kind: "command_transcript";
}

export interface CommandTranscriptIndex {
  transcripts: CommandTranscript[];
  sourceHashes: CommandTranscriptSourceHash[];
}

interface TranscriptIndexOptions {
  includeSourceHashes?: boolean;
}

export function commandTranscriptOutputPath(cwd: string, outputDir: string): string {
  return relativePath(cwd, path.join(outputDir, "inputs", COMMAND_TRANSCRIPT_INPUT_FILENAME));
}

export function commandTranscriptInputDir(cwd: string, outputDir: string): string {
  return relativePath(cwd, path.join(outputDir, COMMAND_TRANSCRIPT_DIRNAME));
}

export async function indexCommandTranscripts(cwd: string, transcriptPaths: string[]): Promise<CommandTranscript[]> {
  return (await indexCommandTranscriptFiles(cwd, transcriptPaths, { includeSourceHashes: false })).transcripts;
}

export async function indexCommandTranscriptFiles(
  cwd: string,
  transcriptPaths: string[],
  options: TranscriptIndexOptions = { includeSourceHashes: true }
): Promise<CommandTranscriptIndex> {
  const transcripts: CommandTranscript[] = [];
  const sourceHashes: CommandTranscriptSourceHash[] = [];
  let index = 1;
  for (const transcriptPath of transcriptPaths.sort()) {
    const transcriptFile = await readTranscriptFile(cwd, transcriptPath, options.includeSourceHashes !== false);
    if (transcriptFile.hash) {
      sourceHashes.push({
        path: transcriptPath,
        algorithm: "sha256",
        hash: transcriptFile.hash,
        kind: "command_transcript"
      });
    }
    for (const value of transcriptFile.values) {
      transcripts.push(normalizeTranscript(transcriptPath, value, index));
      index += 1;
    }
  }
  return { transcripts, sourceHashes };
}

async function readTranscriptFile(cwd: string, transcriptPath: string, includeSourceHash: boolean): Promise<{ values: unknown[]; hash?: string }> {
  const absolutePath = path.resolve(cwd, transcriptPath);
  const size = fs.statSync(absolutePath).size;
  if (size > MAX_TRANSCRIPT_FILE_BYTES) {
    return {
      hash: includeSourceHash ? await hashFileStream(absolutePath) : undefined,
      values: [
        {
          id: path.basename(transcriptPath, ".json"),
          command: "unknown",
          status: "unknown",
          stdout_excerpt: `Command transcript file exceeded ${MAX_TRANSCRIPT_FILE_BYTES} bytes and was not parsed. Provide bounded excerpts plus hashes instead.`
        }
      ]
    };
  }

  const data = await fs.promises.readFile(absolutePath);
  const hash = includeSourceHash ? crypto.createHash("sha256").update(data).digest("hex") : undefined;
  const parsed = JSON.parse(data.toString("utf8"));
  if (Array.isArray(parsed)) {
    return { values: parsed, hash };
  }
  if (isRecord(parsed)) {
    if (Array.isArray(parsed.commands)) {
      return { values: parsed.commands, hash };
    }
    if (Array.isArray(parsed.transcripts)) {
      return { values: parsed.transcripts, hash };
    }
    return { values: [parsed], hash };
  }
  return { values: [], hash };
}

function normalizeTranscript(sourcePath: string, value: unknown, index: number): CommandTranscript {
  const record = isRecord(value) ? value : {};
  const commandSource = stringValue(record.command, "unknown");
  const command = redactRequiredText(commandSource);
  const exitCode = numberValue(record.exit_code ?? record.exitCode);
  const stdoutRaw = optionalString(record.stdout);
  const stderrRaw = optionalString(record.stderr);
  const stdoutSource = safeOutputText(stdoutRaw, optionalString(record.stdout_excerpt), "stdout");
  const stderrSource = safeOutputText(stderrRaw, optionalString(record.stderr_excerpt), "stderr");
  // Redact BEFORE bounding so a secret straddling the excerpt limit cannot leak
  // an unredacted prefix (the truncate-then-redact bug this chokepoint fixes).
  const stdout = redactForArtifact(stdoutSource, COMMAND_TRANSCRIPT_EXCERPT_LIMIT);
  const stderr = redactForArtifact(stderrSource, COMMAND_TRANSCRIPT_EXCERPT_LIMIT);
  const secretBlocked = record.secret_blocked === true ||
    [commandSource, stdoutRaw ?? stdoutSource, stderrRaw ?? stderrSource].some((text) =>
      typeof text === "string" && containsBlockingSecretMaterial(text)
    );

  return stripUndefined({
    id: stringValue(record.id, `CMD-${String(index).padStart(3, "0")}`),
    command,
    status: normalizeStatus(record.status, exitCode),
    exit_code: exitCode,
    head_sha: optionalString(record.head_sha ?? record.headSha),
    duration_ms: numberValue(record.duration_ms ?? record.durationMs),
    started_at: optionalString(record.started_at ?? record.startedAt),
    completed_at: optionalString(record.completed_at ?? record.completedAt),
    stdout_excerpt: stdout.excerpt,
    stderr_excerpt: stderr.excerpt,
    stdout_hash: hashFromRecord(record.stdout_hash, stdoutRaw ?? stdoutSource),
    stderr_hash: hashFromRecord(record.stderr_hash, stderrRaw ?? stderrSource),
    truncated: booleanValue(record.truncated) || stdout.truncated || stderr.truncated || outputTooLarge(stdoutRaw) || outputTooLarge(stderrRaw),
    source_path: sourcePath,
    secret_blocked: secretBlocked || undefined
  });
}

function normalizeStatus(value: unknown, exitCode: number | undefined): CommandTranscriptStatus {
  if (value === "passed" || value === "failed" || value === "unknown") {
    return value;
  }
  if (exitCode === 0) {
    return "passed";
  }
  if (typeof exitCode === "number") {
    return "failed";
  }
  return "unknown";
}

function hashFromRecord(value: unknown, fallbackText: string | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (fallbackText !== undefined && fallbackText.length > MAX_RAW_OUTPUT_CHARS) {
    return undefined;
  }
  return fallbackText === undefined ? undefined : crypto.createHash("sha256").update(fallbackText).digest("hex");
}

function safeOutputText(value: string | undefined, excerpt: string | undefined, stream: "stdout" | "stderr"): string | undefined {
  if (value === undefined) {
    return excerpt;
  }
  if (!outputTooLarge(value)) {
    return value;
  }
  if (excerpt !== undefined) {
    return excerpt;
  }
  return `[omitted:${stream} exceeded ${MAX_RAW_OUTPUT_CHARS} chars; provide ${stream}_excerpt and ${stream}_hash]`;
}

function outputTooLarge(value: string | undefined): boolean {
  return value !== undefined && value.length > MAX_RAW_OUTPUT_CHARS;
}

function hashFileStream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function redactRequiredText(value: string): string {
  return redactSecrets(value).text;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}
