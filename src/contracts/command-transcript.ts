export type CommandTranscriptStatus = "passed" | "failed" | "unknown";

export interface CommandTranscript {
  id: string;
  command: string;
  status: CommandTranscriptStatus;
  exit_code?: number;
  head_sha?: string;
  duration_ms?: number;
  started_at?: string;
  completed_at?: string;
  stdout_excerpt?: string;
  stderr_excerpt?: string;
  stdout_hash?: string;
  stderr_hash?: string;
  truncated: boolean;
  source_path: string;
  /** True when a blocked secret existed before the persisted fields were redacted. */
  secret_blocked?: boolean;
}
