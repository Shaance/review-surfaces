import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { ensureDir, relativePath, writeJson } from "../core/files";
import { stripUndefined } from "../core/guards";
import { redactForArtifact } from "../privacy/redact";
import { redactSecrets } from "../privacy/secrets";
import {
  COMMAND_TRANSCRIPT_EXCERPT_LIMIT,
  COMMAND_TRANSCRIPT_SCHEMA_VERSION,
  DEFAULT_COMMAND_TRANSCRIPT_DIR
} from "./transcripts";

export interface RecordedCommandTranscript {
  id: string;
  command: string;
  status: "passed" | "failed";
  exit_code?: number;
  duration_ms: number;
  started_at: string;
  completed_at: string;
  stdout_excerpt?: string;
  stderr_excerpt?: string;
  stdout_hash?: string;
  stderr_hash?: string;
  truncated: boolean;
}

export interface RecordCommandOptions {
  cwd: string;
  args: string[];
  transcriptDir?: string;
  id?: string;
  streamOutput?: boolean;
  stdout?: { write(chunk: unknown): unknown; once?(event: string, callback: () => void): unknown };
  stderr?: { write(chunk: unknown): unknown; once?(event: string, callback: () => void): unknown };
  now?: () => Date;
}

export interface RecordCommandResult {
  transcript: RecordedCommandTranscript;
  transcriptPath: string;
  exitCode: number;
}

export async function recordCommandTranscript(options: RecordCommandOptions): Promise<RecordCommandResult> {
  if (options.args.length === 0) {
    throw new Error("No command was provided to record.");
  }

  const now = options.now ?? (() => new Date());
  const started = now();
  const stdout = new BoundedStreamCapture();
  const stderr = new BoundedStreamCapture();
  const command = shellCommandString(options.args);
  const childResult = await runChildCommand(options, stdout, stderr);
  const completed = now();
  const id = options.id ?? defaultTranscriptId(options.args);
  // boundExcerpt() redacts-then-bounds AND marks the capture truncated as a side
  // effect, so compute both excerpts BEFORE reading `.truncated` rather than
  // relying on object-literal property evaluation order.
  const stdoutExcerpt = boundExcerpt(stdout);
  const stderrExcerpt = boundExcerpt(stderr);
  const transcript: RecordedCommandTranscript = stripUndefined({
    id,
    command: redact(command) ?? "",
    status: childResult.exitCode === 0 ? "passed" : "failed",
    exit_code: childResult.exitCode,
    duration_ms: Math.max(0, completed.getTime() - started.getTime()),
    started_at: started.toISOString(),
    completed_at: completed.toISOString(),
    stdout_excerpt: stdoutExcerpt,
    stderr_excerpt: stderrExcerpt,
    stdout_hash: stdout.hash(),
    stderr_hash: stderr.hash(),
    truncated: stdout.truncated || stderr.truncated
  });

  const transcriptPath = await writeTranscriptFile(options.cwd, options.transcriptDir, id, transcript);
  return { transcript, transcriptPath, exitCode: childResult.exitCode };
}

function runChildCommand(
  options: RecordCommandOptions,
  stdoutCapture: BoundedStreamCapture,
  stderrCapture: BoundedStreamCapture
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(options.args[0], options.args.slice(1), {
      cwd: options.cwd,
      env: process.env,
      shell: false
    });
    let settled = false;

    child.stdout?.on("data", (chunk: any) => teeChunk(chunk, stdoutCapture, options.stdout ?? process.stdout, child.stdout, options.streamOutput !== false));
    child.stderr?.on("data", (chunk: any) => teeChunk(chunk, stderrCapture, options.stderr ?? process.stderr, child.stderr, options.streamOutput !== false));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      const message = Buffer.from(`${error.message}\n`);
      stderrCapture.write(message);
      if (options.streamOutput !== false) {
        (options.stderr ?? process.stderr).write(message);
      }
      resolve({ exitCode: errorHasCode(error, "ENOENT") ? 127 : 1 });
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal) {
        const message = Buffer.from(`Command terminated by signal ${signal}\n`);
        stderrCapture.write(message);
      }
      resolve({ exitCode: typeof code === "number" ? code : 1 });
    });
  });
}

async function writeTranscriptFile(
  cwd: string,
  transcriptDir: string | undefined,
  id: string,
  transcript: RecordedCommandTranscript
): Promise<string> {
  const dir = path.resolve(cwd, transcriptDir ?? DEFAULT_COMMAND_TRANSCRIPT_DIR);
  await ensureDir(dir);
  const absolutePath = path.join(dir, `${safeFilename(id)}.json`);
  await writeJson(absolutePath, {
    schema_version: COMMAND_TRANSCRIPT_SCHEMA_VERSION,
    commands: [transcript]
  });
  return relativePath(cwd, absolutePath);
}

// Raw capture cap: bound memory while giving redaction enough context to catch a
// secret that straddles the final excerpt limit. Redaction + the final bound to
// COMMAND_TRANSCRIPT_EXCERPT_LIMIT happen at read time in boundExcerpt(), NOT on
// each write, so a secret split across two chunks (or across the limit) is still
// removed before slicing. The sha256 digest keeps hashing the FULL raw stream.
const RAW_EXCERPT_CAP = COMMAND_TRANSCRIPT_EXCERPT_LIMIT * 4;

class BoundedStreamCapture {
  private readonly digest = crypto.createHash("sha256");
  private readonly chunks: string[] = [];
  private rawLength = 0;
  private sawContent = false;
  truncated = false;

  write(chunk: any): void {
    this.sawContent = true;
    this.digest.update(chunk);
    if (this.rawLength >= RAW_EXCERPT_CAP) {
      this.truncated = true;
      return;
    }

    const text = chunk.toString("utf8");
    const available = RAW_EXCERPT_CAP - this.rawLength;
    const captured = text.slice(0, available);
    this.chunks.push(captured);
    this.rawLength += captured.length;
    if (text.length > available) {
      this.truncated = true;
    }
  }

  rawExcerpt(): string | undefined {
    return this.sawContent ? this.chunks.join("") : undefined;
  }

  markTruncated(): void {
    this.truncated = true;
  }

  hash(): string | undefined {
    return this.sawContent ? this.digest.copy().digest("hex") : undefined;
  }
}

// Redact the captured raw stream, THEN bound to the excerpt limit. Setting
// truncated here keeps the flag reflecting BOTH a raw-cap overflow and the
// post-redaction bound (the redacted text can be longer or shorter than raw).
function boundExcerpt(capture: BoundedStreamCapture): string | undefined {
  const raw = capture.rawExcerpt();
  if (raw === undefined) {
    return undefined;
  }
  const { excerpt, truncated } = redactForArtifact(raw, COMMAND_TRANSCRIPT_EXCERPT_LIMIT);
  if (truncated) {
    capture.markTruncated();
  }
  return excerpt;
}

function defaultTranscriptId(args: string[]): string {
  const hash = crypto.createHash("sha1").update(args.join("\0")).digest("hex").slice(0, 12).toUpperCase();
  return `CMD-${hash}`;
}

function shellCommandString(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "command";
}

function teeChunk(
  chunk: any,
  capture: BoundedStreamCapture,
  destination: { write(chunk: unknown): unknown; once?(event: string, callback: () => void): unknown },
  source: { pause?(): unknown; resume?(): unknown } | undefined,
  streamOutput: boolean
): void {
  capture.write(chunk);
  if (!streamOutput) {
    return;
  }
  const canContinue = destination.write(chunk);
  if (canContinue === false && source?.pause && destination.once && source.resume) {
    source.pause();
    destination.once("drain", () => {
      source.resume?.();
    });
  }
}

function redact(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactSecrets(value).text;
}

function errorHasCode(error: Error, code: string): boolean {
  return typeof (error as { code?: unknown }).code === "string" && (error as { code?: string }).code === code;
}
