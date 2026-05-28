import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readText, relativePath } from "../core/files";
import { redactSecrets } from "../privacy/secrets";

export const COMMAND_TRANSCRIPT_OUTPUT_PATH = ".review-surfaces/inputs/commands.json";
export const COMMAND_TRANSCRIPT_INPUT_FILENAME = "commands.json";

export type CommandTranscriptStatus = "passed" | "failed" | "unknown";

export interface CommandTranscript {
  id: string;
  command: string;
  status: CommandTranscriptStatus;
  exit_code?: number;
  duration_ms?: number;
  started_at?: string;
  completed_at?: string;
  stdout_excerpt?: string;
  stderr_excerpt?: string;
  stdout_hash?: string;
  stderr_hash?: string;
  truncated: boolean;
  source_path: string;
}

const EXCERPT_LIMIT = 1200;
const MAX_TRANSCRIPT_FILE_BYTES = 1_000_000;
const MAX_RAW_OUTPUT_CHARS = 20_000;

export function commandTranscriptOutputPath(cwd: string, outputDir: string): string {
  return relativePath(cwd, path.join(outputDir, "inputs", COMMAND_TRANSCRIPT_INPUT_FILENAME));
}

export async function indexCommandTranscripts(cwd: string, transcriptPaths: string[]): Promise<CommandTranscript[]> {
  const transcripts: CommandTranscript[] = [];
  let index = 1;
  for (const transcriptPath of transcriptPaths.sort()) {
    for (const value of await readTranscriptFile(cwd, transcriptPath)) {
      transcripts.push(normalizeTranscript(transcriptPath, value, index));
      index += 1;
    }
  }
  return transcripts;
}

async function readTranscriptFile(cwd: string, transcriptPath: string): Promise<unknown[]> {
  const absolutePath = path.resolve(cwd, transcriptPath);
  const size = fs.statSync(absolutePath).size;
  if (size > MAX_TRANSCRIPT_FILE_BYTES) {
    return [
      {
        id: path.basename(transcriptPath, ".json"),
        command: "unknown",
        status: "unknown",
        stdout_excerpt: `Command transcript file exceeded ${MAX_TRANSCRIPT_FILE_BYTES} bytes and was not parsed. Provide bounded excerpts plus hashes instead.`
      }
    ];
  }

  const parsed = JSON.parse(await readText(absolutePath));
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isRecord(parsed)) {
    if (Array.isArray(parsed.commands)) {
      return parsed.commands;
    }
    if (Array.isArray(parsed.transcripts)) {
      return parsed.transcripts;
    }
    return [parsed];
  }
  return [];
}

function normalizeTranscript(sourcePath: string, value: unknown, index: number): CommandTranscript {
  const record = isRecord(value) ? value : {};
  const command = redactRequiredText(stringValue(record.command, "unknown"));
  const exitCode = numberValue(record.exit_code ?? record.exitCode);
  const stdoutRaw = optionalString(record.stdout);
  const stderrRaw = optionalString(record.stderr);
  const stdoutSource = safeOutputText(stdoutRaw, optionalString(record.stdout_excerpt), "stdout");
  const stderrSource = safeOutputText(stderrRaw, optionalString(record.stderr_excerpt), "stderr");
  const stdout = boundedText(stdoutSource);
  const stderr = boundedText(stderrSource);

  return stripUndefined({
    id: stringValue(record.id, `CMD-${String(index).padStart(3, "0")}`),
    command,
    status: normalizeStatus(record.status, exitCode),
    exit_code: exitCode,
    duration_ms: numberValue(record.duration_ms ?? record.durationMs),
    started_at: optionalString(record.started_at ?? record.startedAt),
    completed_at: optionalString(record.completed_at ?? record.completedAt),
    stdout_excerpt: redactText(stdout.excerpt),
    stderr_excerpt: redactText(stderr.excerpt),
    stdout_hash: hashFromRecord(record.stdout_hash, stdoutRaw ?? stdoutSource),
    stderr_hash: hashFromRecord(record.stderr_hash, stderrRaw ?? stderrSource),
    truncated: booleanValue(record.truncated) || stdout.truncated || stderr.truncated || outputTooLarge(stdoutRaw) || outputTooLarge(stderrRaw),
    source_path: sourcePath
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

function boundedText(value: string | undefined): { excerpt?: string; truncated: boolean } {
  if (value === undefined) {
    return { truncated: false };
  }
  if (value.length <= EXCERPT_LIMIT) {
    return { excerpt: value, truncated: false };
  }
  return { excerpt: value.slice(0, EXCERPT_LIMIT), truncated: true };
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

function redactText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactSecrets(value).text;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
