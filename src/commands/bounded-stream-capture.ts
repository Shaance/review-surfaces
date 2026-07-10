import { COMMAND_TRANSCRIPT_EXCERPT_LIMIT } from "./transcripts";

export const COMMAND_RAW_EXCERPT_CAP = COMMAND_TRANSCRIPT_EXCERPT_LIMIT * 4;

export interface BoundedStreamCapture {
  truncated: boolean;
  write(chunk: Buffer): void;
  redactedExcerpt(limit: number): string | undefined;
  finishAndCheckBlockedSecret(): boolean;
  hash(): string | undefined;
}

interface CaptureRuntime {
  BoundedStreamCapture: new (rawExcerptCap: number) => BoundedStreamCapture;
}

// `allowJs` copies the shared runtime to dist/bin so the compiled runner and
// no-dist fallback execute the same capture implementation.
const runtime = require("../../bin/bounded-stream-capture.js") as CaptureRuntime;

export const BoundedStreamCapture = runtime.BoundedStreamCapture;
