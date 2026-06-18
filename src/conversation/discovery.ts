// review-surfaces.METHODOLOGY.4 / D4 + D7 (Phase 5b): read-only auto-discovery of
// the SINGLE harness session that produced base..head, used when no --conversation
// path is supplied. `--conversation` ALWAYS wins (the caller skips discovery when a
// path is given). Discovery NEVER copies raw transcript text OR the absolute
// home-dir session path into a persisted artifact — it only returns the picked
// SNAPSHOT for the registry to parse; the caller announces the picked path on STDERR
// and persists only a repo-relative normalized-log anchor (PRIVACY.1). A missing
// store, an unreadable/invalid session, or no match degrades to `undefined` (the
// caller then reports conversation_log_missing, METHODOLOGY.4), never a throw.
//
// review-surfaces.METHODOLOGY.9: discovery spans BOTH the Claude Code store
// (<root>/.claude/projects/<repo-slug>/*.jsonl — grouped by repo) AND the Codex
// rollout store (<root>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — a SINGLE GLOBAL
// store holding every repo's sessions, not grouped by repo). The Codex store is global,
// so a path-substring match alone would draw FALSE cross-repo hits (a generic changed
// path like `README.md` appears in many repos' sessions); instead a Codex rollout is
// scoped to THIS repo by its recorded `session_meta.cwd` — the Codex analogue of the
// Claude project slug. cwd is read cheaply from the head of each file (the meta is the
// first line), so the whole store can be filtered without full reads; only the rollouts
// recorded under this cwd are fully read and ranked. The probe is bounded to the
// most-recent CODEX_SCAN_LIMIT rollouts (newest first) so a 1000-session store does not
// force a scan of every file; a session older than that window needs --conversation.
// Cursor stores its chat in a per-workspace SQLite `state.vscdb` (no loose transcript
// file to read), so it has NO zero-config discovery — Cursor users pass an exported
// transcript with --conversation (the cursor adapter parses it). See
// docs/conversation-auditing.md.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../core/guards";
import { claudeCodeAdapter } from "./adapters/claude-code";
import { codexAdapter } from "./adapters/codex";
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
  // discriminator (D7). 0 means it was picked by recency ALONE (the repo's session that
  // produced this diff could not be identified), which the caller surfaces as a HARD
  // warning so the user can correct an ambiguous/stale match with --conversation (Codex
  // P2). Applies to either store — a cwd-matched Codex pick can be recency-only too.
  matchedChangedFiles: number;
}

export interface DiscoveryOptions {
  // The home/root under which harness session stores live. Injected so tests point
  // at a fixture store instead of the real ~/.claude + ~/.codex. Production passes
  // os.homedir().
  storeRoot: string;
  // The repo's absolute working directory — the match key for BOTH stores: the Claude
  // project slug is derived from it, and a Codex rollout matches when its recorded
  // session_meta.cwd equals it (the Codex store is not directory-grouped by repo).
  cwd: string;
  // The base..head changed-file paths. Within a repo's sessions (the Claude slug dir, or
  // the cwd-scoped Codex rollouts) the same repo holds EVERY session across branches/
  // tasks, so latest-timestamp alone can pick a newer UNRELATED session; we prefer the
  // session that references the changed files (it produced the diff under review) and
  // fall back to recency only when none does.
  changedFiles: string[];
}

// The most-recent Codex rollouts whose `session_meta.cwd` is probed in the global store.
// The store holds every repo's sessions, so a full scan every run is wasteful; a review
// is normally run right after the work, so the producing session is among the newest.
// Bounded and documented; --conversation overrides when the session falls outside it.
const CODEX_SCAN_LIMIT = 80;
// Bytes read from the head of a rollout to extract `session_meta.cwd`. The meta is the
// first line and carries `cwd` near its start (before the large base_instructions blob),
// so a small head read is enough; the value is regex-extracted to tolerate a first line
// longer than the probe window (a full JSON.parse of a truncated line would fail).
const CODEX_META_PROBE_BYTES = 16384;

// review-surfaces D4: the Claude Code project-slug — the absolute repo cwd with
// EVERY '/' AND '.' replaced by '-'. For an absolute POSIX path the leading '/'
// yields the required leading '-' (e.g. /Users/x/review-surfaces ->
// -Users-x-review-surfaces; a session store lives at
// ~/.claude/projects/<slug>/<session-id>.jsonl). Getting this transform wrong
// silently finds nothing, so it MUST be exact.
export function claudeCodeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

// The LATEST in-session event timestamp in a session, as the raw ISO-8601 string.
// Compared LEXICOGRAPHICALLY: both Claude Code and Codex stamp zero-padded UTC ISO
// (`2026-06-17T10:47:01.123Z`) as a top-level `timestamp`, which sorts
// chronologically — so no Date parsing is needed and determinism is preserved (no
// `new Date()`/`Date.now()`). A session with no timestamps sorts lowest ("").
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
  adapter: string;
}

// A candidate is preferred when it references MORE changed files (diff-tied), then
// when its latest in-session event is more recent, then by greatest path — a total,
// deterministic order independent of filesystem enumeration AND independent of which
// store (Claude vs Codex) a candidate came from.
function isBetter(candidate: Candidate, best: Candidate): boolean {
  if (candidate.score !== best.score) {
    return candidate.score > best.score;
  }
  if (candidate.timestamp !== best.timestamp) {
    return candidate.timestamp > best.timestamp;
  }
  return candidate.path > best.path;
}

// Claude Code candidates: every readable, adapter-valid `*.jsonl` under the repo's
// project-slug dir. The slug name IS the repo match, so a candidate is eligible
// regardless of score (recency is an acceptable fallback within a same-repo store).
function claudeCandidates(options: DiscoveryOptions): Candidate[] {
  const slug = claudeCodeProjectSlug(options.cwd);
  const dir = path.join(options.storeRoot, ".claude", "projects", slug);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return []; // No slug directory for this repo -> no Claude candidates (non-fatal).
  }
  const candidates: Candidate[] = [];
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
    candidates.push({
      path: full,
      content: text,
      timestamp: latestTimestamp(text),
      score: changedFileReferenceScore(text, options.changedFiles),
      adapter: claudeCodeAdapter.name
    });
  }
  return candidates;
}

// The most-recent Codex rollout `*.jsonl` paths under <root>/.codex/sessions, newest
// first. The rollout filename AND its YYYY/MM/DD parent dirs encode a zero-padded ISO
// timestamp, so a descending name sort at each level is chronological — descending
// DFS visits newest first and the shared `found` cap keeps exactly the newest
// `limit`. Enumeration only (no file reads), so walking a large store is cheap.
function codexRolloutPaths(storeRoot: string, limit: number): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= limit) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const ordered = entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const entry of ordered) {
      if (found.length >= limit) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".jsonl")) {
        found.push(full);
      }
    }
  };
  walk(path.join(storeRoot, ".codex", "sessions"));
  return found.slice(0, limit);
}

// The repo cwd a Codex rollout was recorded under, from its `session_meta` line's
// `payload.cwd`. Read from the head of the file (the meta is the first line) so the
// store can be filtered without full reads, and regex-extracted so a first line longer
// than the probe window (the meta carries a large base_instructions blob) still yields
// the cwd, which sits near the line start. Returns undefined when absent/unreadable.
function codexSessionCwd(filePath: string): string | undefined {
  let head: string;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(CODEX_META_PROBE_BYTES);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      head = buffer.toString("utf8", 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string; // unescape any JSON string escapes
  } catch {
    return undefined;
  }
}

// Codex candidates: among the newest CODEX_SCAN_LIMIT rollouts, those recorded under
// THIS repo's cwd (the Codex analogue of the Claude project slug) that are adapter-valid.
// cwd-scoping — not a bare path-substring match — is what ties a global-store session to
// this repo, so eligibility does NOT require a changed-file reference: a cwd-matched
// session ranks by reference then recency exactly like a same-repo Claude session.
function codexCandidates(options: DiscoveryOptions): Candidate[] {
  const candidates: Candidate[] = [];
  for (const full of codexRolloutPaths(options.storeRoot, CODEX_SCAN_LIMIT)) {
    if (codexSessionCwd(full) !== options.cwd) {
      continue; // a different repo's session (the Codex store is global) — not a match.
    }
    let text: string;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!codexAdapter.detect(adapterInput(full, text))) {
      continue;
    }
    candidates.push({
      path: full,
      content: text,
      timestamp: latestTimestamp(text),
      score: changedFileReferenceScore(text, options.changedFiles),
      adapter: codexAdapter.name
    });
  }
  return candidates;
}

// review-surfaces D4 + D7 / METHODOLOGY.9: discover the SINGLE best session for this
// review across the Claude Code store (repo-slug-matched) AND the Codex rollout store
// (global, range-referenced only). Single-select (D7 — never stitch sessions) by the
// diff-reference score (ties to the current review range), then the LATEST in-session
// event timestamp, then the greatest path — one total order over both stores. The
// winner's bytes are snapshotted ONCE here so parsing and the cache-signature hash
// see identical content. No store / no candidate -> undefined (caller degrades
// non-fatally, METHODOLOGY.4).
export function discoverConversationSession(options: DiscoveryOptions): DiscoveredSession | undefined {
  const candidates = [...claudeCandidates(options), ...codexCandidates(options)];
  let best: Candidate | undefined;
  for (const candidate of candidates) {
    if (best === undefined || isBetter(candidate, best)) {
      best = candidate;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  return {
    path: best.path,
    adapter: best.adapter,
    content: best.content,
    hash: crypto.createHash("sha256").update(best.content).digest("hex"),
    matchedChangedFiles: best.score
  };
}
