// review-surfaces.METHODOLOGY.4 / D4 + D7 (Phase 5b): read-only auto-discovery of
// the SINGLE harness session that produced base..head, used when no --conversation
// path is supplied. `--conversation` ALWAYS wins (the caller skips discovery when a
// path is given). Discovery NEVER copies raw transcript text OR the absolute
// home-dir session path into a persisted artifact — it only returns the picked
// SNAPSHOT for the registry to parse; the caller announces the picked path on STDERR
// and persists only a repo-relative normalized-log anchor (PRIVACY.1). A missing
// store, an unreadable/invalid session, or no match degrades to `undefined` (the
// caller then reports conversation_log_missing, METHODOLOGY.4), never a throw.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../core/guards";
import { claudeCodeAdapter } from "./adapters/claude-code";
import { AdapterInput } from "./events";

export interface DiscoveredSession {
  // Absolute path to the picked session file. Announced on stderr ONLY; never
  // persisted into a public artifact (it is a username-bearing home-dir path).
  path: string;
  // The resolved adapter label (also used as the conversation_source).
  adapter: string;
  // The SNAPSHOT bytes read once at discovery time. The caller parses AND hashes
  // THIS exact content (never a re-read of the path) so a live session that grows
  // mid-run cannot have its audit normalized from old bytes but stamped with the
  // hash of newer bytes (a cache-coherence bug — Codex P2).
  content: string;
  // sha256 of `content`, folded into the cache signature (matches core/files
  // hashFile of the same bytes).
  hash: string;
  // How many base..head changed files this session references — the diff
  // discriminator (D7). 0 means it was picked by recency ALONE (no session could be
  // tied to the review range), which the caller surfaces so the user can correct an
  // ambiguous same-repo match with --conversation (Codex P2).
  matchedChangedFiles: number;
}

export interface DiscoveryOptions {
  // The home/root under which harness session stores live. Injected so tests point
  // at a fixture store instead of the real ~/.claude. Production passes os.homedir().
  storeRoot: string;
  // The repo's absolute working directory — the match key (its project slug).
  cwd: string;
  // The base..head changed-file paths. The same repo's slug holds EVERY session for
  // this repo (across branches/tasks), so latest-timestamp alone can pick a newer
  // UNRELATED session; we prefer the session that references the changed files (it
  // produced the diff under review) and fall back to recency only when none does.
  changedFiles: string[];
}

// review-surfaces D4: the Claude Code project-slug — the absolute repo cwd with
// EVERY '/' AND '.' replaced by '-'. For an absolute POSIX path the leading '/'
// yields the required leading '-' (e.g. /Users/x/review-surfaces ->
// -Users-x-review-surfaces; a session store lives at
// ~/.claude/projects/<slug>/<session-id>.jsonl). Getting this transform wrong
// silently finds nothing, so it MUST be exact.
export function claudeCodeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

// The LATEST in-session event timestamp in a Claude Code session, as the raw ISO-8601
// string. Compared LEXICOGRAPHICALLY: Claude Code stamps zero-padded UTC ISO
// (`2026-06-17T10:47:01.123Z`), which sorts chronologically — so no Date parsing is
// needed and determinism is preserved (no `new Date()`/`Date.now()`). A session with
// no timestamps sorts lowest ("").
function latestTimestamp(text: string): string {
  let max = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(record) && typeof record.timestamp === "string" && record.timestamp > max) {
      max = record.timestamp;
    }
  }
  return max;
}

// How many of the base..head changed files this session references — its tie to the
// current review range. A session that produced the diff edits/mentions the changed
// files (their repo-relative paths appear in tool inputs and text).
function changedFileReferenceScore(content: string, changedFiles: string[]): number {
  let score = 0;
  for (const file of changedFiles) {
    if (file !== "" && content.includes(file)) {
      score += 1;
    }
  }
  return score;
}

function adapterInput(filePath: string, text: string): AdapterInput {
  return { path: filePath, text, firstLines: text.split("\n").slice(0, 5) };
}

interface Candidate {
  path: string;
  content: string;
  timestamp: string;
  score: number;
}

// A candidate is preferred when it references MORE changed files (diff-tied), then
// when its latest in-session event is more recent, then by greatest path — a total,
// deterministic order independent of filesystem enumeration.
function isBetter(candidate: Candidate, best: Candidate): boolean {
  if (candidate.score !== best.score) {
    return candidate.score > best.score;
  }
  if (candidate.timestamp !== best.timestamp) {
    return candidate.timestamp > best.timestamp;
  }
  return candidate.path > best.path;
}

// review-surfaces D4 + D7: discover the SINGLE Claude Code session for this repo. The
// project-slug DIRECTORY under <storeRoot>/.claude/projects IS the repo match — its
// name encodes this cwd — so every readable, adapter-valid `*.jsonl` in it is a
// candidate. Single-select (D7 — never stitch sessions) by the diff-reference score
// (ties to the current review range), then the LATEST in-session event timestamp,
// then the greatest path. The winner's bytes are snapshotted ONCE here so parsing
// and the cache-signature hash see identical content. No store / no candidate ->
// undefined (caller degrades non-fatally, METHODOLOGY.4).
export function discoverConversationSession(options: DiscoveryOptions): DiscoveredSession | undefined {
  const slug = claudeCodeProjectSlug(options.cwd);
  const dir = path.join(options.storeRoot, ".claude", "projects", slug);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return undefined; // No slug directory for this repo -> no match (non-fatal).
  }
  let best: Candidate | undefined;
  for (const name of [...names].sort()) {
    const full = path.join(dir, name);
    let text: string;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!claudeCodeAdapter.detect(adapterInput(full, text))) {
      continue;
    }
    const candidate: Candidate = {
      path: full,
      content: text,
      timestamp: latestTimestamp(text),
      score: changedFileReferenceScore(text, options.changedFiles)
    };
    if (best === undefined || isBetter(candidate, best)) {
      best = candidate;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  return {
    path: best.path,
    adapter: claudeCodeAdapter.name,
    content: best.content,
    hash: crypto.createHash("sha256").update(best.content).digest("hex"),
    matchedChangedFiles: best.score
  };
}
