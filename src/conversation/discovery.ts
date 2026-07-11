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
// first line), so the store can be filtered without full reads; only the rollouts recorded
// under this cwd are fully read and ranked. The probe walks the newest rollouts up to a
// generous ceiling and full-reads EVERY same-repo match (no match-count cap) — so neither a
// burst of unrelated newer sessions (Codex #113 r1) nor many newer same-repo sessions (r2)
// can crowd this repo's producing session out of the window; one beyond the ceiling needs
// --conversation.
// Cursor stores its chat in a per-workspace SQLite `state.vscdb` (no loose transcript
// file to read), so it has NO zero-config discovery — Cursor users pass an exported
// transcript with --conversation (the cursor adapter parses it). See
// docs/conversation-auditing.md.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../core/guards";
import { claudeCodeAdapter, claudeCodeProvenance } from "./adapters/claude-code";
import { codexAdapter, codexProvenance } from "./adapters/codex";
import { AdapterInput } from "./events";
import type { ConversationProvenance } from "./provenance";

export interface DiscoveredSession {
  kind: "session";
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
  // Compatibility summary across exact structured mutations plus weak reads/mentions.
  // Admission is based on the producer fields below, never this aggregate count.
  matchedChangedFiles: number;
  mutatedChangedFiles: number;
  weakMatchedFiles: number;
  confidence: "high" | "medium" | "low";
  ambiguous: boolean;
  reasonCodes: string[];
}

export interface RejectedDiscovery {
  kind: "rejected";
  path?: undefined;
  adapter?: undefined;
  content?: undefined;
  hash?: undefined;
  matchedChangedFiles: 0;
  mutatedChangedFiles: 0;
  weakMatchedFiles: 0;
  confidence: "low";
  ambiguous: false;
  reasonCodes: string[];
}

export type DiscoveryResult = DiscoveredSession | RejectedDiscovery;

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
  // tasks, so latest-timestamp alone can pick a newer unrelated audit session. These
  // paths are matched exactly against structured mutations, reads, and bounded mentions.
  changedFiles: string[];
  headSha?: string;
  rangeCommitShas?: string[];
  headCommittedAt?: string;
  workingTreeDirty?: boolean;
}

// The cwd probe is a cheap head read, so the cost bound is on the PROBE, not the match count:
// we probe up to CODEX_PROBE_LIMIT newest rollouts and FULL-read every one whose recorded cwd
// is this repo's. This means (a) other repos' newer sessions cannot crowd out this repo's
// rollout — a non-match costs only a head read (Codex #113 r1) — and (b) there is no match cap
// that could skip this repo's producing session when many newer SAME-repo sessions exist
// (Codex #113 r2): all this repo's matches within the window are ranked by changed-file
// producer provenance then recency. The producing session is virtually always within the newest few
// hundred global rollouts; one beyond the (generous) ceiling needs --conversation. Worst case
// — every probed rollout belongs to this repo — is CODEX_PROBE_LIMIT full reads, still bounded.
const CODEX_PROBE_LIMIT = 600;
const DISCOVERY_FILE_BYTE_LIMIT = 32 * 1024 * 1024;
const DISCOVERY_TOTAL_BYTE_LIMIT = 512 * 1024 * 1024;
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

function adapterInput(filePath: string, text: string): AdapterInput {
  return { path: filePath, text, firstLines: text.split("\n").slice(0, 5) };
}

interface Candidate {
  path: string;
  content: string;
  timestamp: string;
  adapter: string;
  provenance: ConversationProvenance;
  temporalRank: number;
}

interface CandidateScan {
  candidates: Candidate[];
  incomplete: boolean;
}

function retainBestCandidates(candidates: Candidate[], candidate: Candidate): void {
  candidates.push(candidate);
  candidates.sort((left, right) => isBetter(left, right) ? -1 : isBetter(right, left) ? 1 : 0);
  if (candidates.length > 2) candidates.length = 2;
}

// Producer provenance is lexicographic: exact mutations first, then commit/timing
// corroboration, weak reads/mentions, recency, and path. This keeps any number of
// audit mentions below one real mutation while retaining a total deterministic order.
function isBetter(candidate: Candidate, best: Candidate): boolean {
  // A mutation after the reviewed commit cannot have produced that commit.
  // Exclude that temporal contradiction before path breadth is considered.
  if (candidate.temporalRank !== best.temporalRank &&
      (candidate.temporalRank === 0 || best.temporalRank === 0)) {
    return candidate.temporalRank > best.temporalRank;
  }
  // An uncommitted review range has no head timestamp to anchor against. Among
  // producer sessions, prefer the one that most recently mutated the range so a
  // stale broad session cannot beat the current narrower implementation merely
  // because it touched more of the same paths months ago.
  if (candidate.provenance.mutatedPaths.length > 0 && best.provenance.mutatedPaths.length > 0 &&
      candidate.temporalRank === 1 && best.temporalRank === 1 &&
      candidate.provenance.lastMutationTimestamp !== best.provenance.lastMutationTimestamp) {
    return (candidate.provenance.lastMutationTimestamp ?? "") > (best.provenance.lastMutationTimestamp ?? "");
  }
  if (candidate.provenance.mutatedPaths.length !== best.provenance.mutatedPaths.length) {
    return candidate.provenance.mutatedPaths.length > best.provenance.mutatedPaths.length;
  }
  const candidateCommit = candidate.provenance.mutatedPaths.length > 0 && candidate.provenance.observedCommitShas.length > 0;
  const bestCommit = best.provenance.mutatedPaths.length > 0 && best.provenance.observedCommitShas.length > 0;
  if (candidateCommit !== bestCommit) {
    return candidateCommit;
  }
  if (candidate.temporalRank !== best.temporalRank) {
    return candidate.temporalRank > best.temporalRank;
  }
  if (candidate.provenance.readPaths.length !== best.provenance.readPaths.length) {
    return candidate.provenance.readPaths.length > best.provenance.readPaths.length;
  }
  if (candidate.provenance.mentionedPaths.length !== best.provenance.mentionedPaths.length) {
    return candidate.provenance.mentionedPaths.length > best.provenance.mentionedPaths.length;
  }
  if (candidate.timestamp !== best.timestamp) {
    return candidate.timestamp > best.timestamp;
  }
  return candidate.path > best.path;
}

function temporalRank(provenance: ConversationProvenance, options: DiscoveryOptions): number {
  if (provenance.mutatedPaths.length === 0) return 0;
  if (options.workingTreeDirty || !options.headCommittedAt || !provenance.lastMutationTimestamp) return 1;
  const mutationTime = Date.parse(provenance.lastMutationTimestamp);
  const headTime = Date.parse(options.headCommittedAt);
  if (!Number.isFinite(mutationTime) || !Number.isFinite(headTime)) return 1;
  return mutationTime <= headTime ? 2 : 0;
}

function candidateReasonCodes(candidate: Candidate): string[] {
  const reasons: string[] = [];
  const mutated = new Set(candidate.provenance.mutatedPaths);
  if (candidate.provenance.mutatedPaths.length > 0) reasons.push("exact_changed_path_mutation");
  if (candidate.provenance.observedCommitShas.length > 0) reasons.push("reviewed_commit_observed");
  if (candidate.temporalRank === 2) reasons.push("mutation_not_after_head_commit");
  if (candidate.temporalRank === 0 && candidate.provenance.mutatedPaths.length > 0) reasons.push("mutation_after_head_commit");
  if (candidate.provenance.readPaths.some((file) => !mutated.has(file))) reasons.push("exact_changed_path_read");
  if (candidate.provenance.mentionedPaths.some((file) => !mutated.has(file))) reasons.push("exact_changed_path_mention");
  if (candidate.provenance.auditOnly) reasons.push("audit_or_read_only_session");
  if (reasons.length === 0) reasons.push("recency_only");
  return reasons;
}

function sameProducerRank(left: Candidate, right: Candidate, options: DiscoveryOptions): boolean {
  const leftCommit = left.provenance.mutatedPaths.length > 0 && left.provenance.observedCommitShas.length > 0;
  const rightCommit = right.provenance.mutatedPaths.length > 0 && right.provenance.observedCommitShas.length > 0;
  if (options.workingTreeDirty &&
      left.provenance.lastMutationTimestamp !== right.provenance.lastMutationTimestamp) {
    return false;
  }
  return left.provenance.mutatedPaths.length > 0 &&
    left.provenance.mutatedPaths.length === right.provenance.mutatedPaths.length &&
    leftCommit === rightCommit &&
    left.temporalRank === right.temporalRank;
}

// Claude Code candidates: every readable, adapter-valid `*.jsonl` under the repo's
// project-slug dir. The slug name establishes repo eligibility; producer-confidence
// admission happens after all candidates are ranked.
function claudeCandidates(options: DiscoveryOptions): CandidateScan {
  const slug = claudeCodeProjectSlug(options.cwd);
  const dir = path.join(options.storeRoot, ".claude", "projects", slug);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return { candidates: [], incomplete: false }; // No slug directory for this repo -> non-fatal.
  }
  const candidates: Candidate[] = [];
  let remainingBytes = DISCOVERY_TOTAL_BYTE_LIMIT;
  let incomplete = false;
  const orderedNames = names.map((name) => {
    try {
      return { name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs };
    } catch {
      return { name, mtimeMs: 0 };
    }
  }).sort((left, right) => right.mtimeMs - left.mtimeMs || (left.name < right.name ? 1 : -1));
  for (const { name } of orderedNames) {
    const full = path.join(dir, name);
    let size: number;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    if (size > DISCOVERY_FILE_BYTE_LIMIT || size > remainingBytes) {
      incomplete = true;
      continue;
    }
    remainingBytes -= size;
    let text: string;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!claudeCodeAdapter.detect(adapterInput(full, text))) {
      continue;
    }
    const input = adapterInput(full, text);
    const provenance = claudeCodeProvenance(input, options);
    retainBestCandidates(candidates, {
      path: full,
      content: text,
      timestamp: latestTimestamp(text),
      adapter: claudeCodeAdapter.name,
      provenance,
      temporalRank: temporalRank(provenance, options)
    });
  }
  return { candidates, incomplete };
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
// `payload.cwd`. ONLY the FIRST line is inspected and only when it is the `session_meta`
// record — so a later line's `"cwd"` (e.g. a function_call recording a shell command's
// working directory) can never be mistaken for the repo key over the global store (Codex
// #113 r4). The first line is read from the head (regex-extracted, since the meta's large
// base_instructions blob can push the line past the probe window, while `cwd` sits near
// the line start). Returns undefined when absent/unreadable/not a session_meta line.
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
  // Scope to the FIRST line only (the session_meta), so a `"cwd"` in a later response item
  // is never read; if the first line overflows the probe window there is no newline and the
  // whole head IS the (truncated) first line, whose cwd still sits before the overflow.
  const newline = head.indexOf("\n");
  const firstLine = newline === -1 ? head : head.slice(0, newline);
  if (!/"type"\s*:\s*"session_meta"/.test(firstLine)) {
    return undefined; // not a session_meta first line -> do not guess a repo key.
  }
  const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(firstLine);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string; // unescape any JSON string escapes
  } catch {
    return undefined;
  }
}

// Codex candidates: probe the newest CODEX_PROBE_LIMIT rollouts (cheap head reads) and
// full-read every one recorded under THIS repo's cwd (the Codex analogue of the Claude
// project slug). No match-count cap — a burst of unrelated newer sessions from other repos
// only costs head reads (Codex #113 r1), and this repo's producing session is not skipped
// even when many newer same-repo sessions exist (Codex #113 r2). cwd-scoping — not a bare
// path-substring match — is what ties a global-store session to this repo. Producer
// provenance then ranks exact mutations above weak reads/mentions across both stores.
function codexCandidates(options: DiscoveryOptions): CandidateScan {
  const candidates: Candidate[] = [];
  let remainingBytes = DISCOVERY_TOTAL_BYTE_LIMIT;
  let incomplete = false;
  for (const full of codexRolloutPaths(options.storeRoot, CODEX_PROBE_LIMIT)) {
    if (codexSessionCwd(full) !== options.cwd) {
      continue; // a different repo's session (the Codex store is global) — not a match.
    }
    let size: number;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    if (size > DISCOVERY_FILE_BYTE_LIMIT || size > remainingBytes) {
      incomplete = true;
      continue;
    }
    remainingBytes -= size;
    let text: string;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!codexAdapter.detect(adapterInput(full, text))) {
      continue;
    }
    const input = adapterInput(full, text);
    const provenance = codexProvenance(input, options);
    retainBestCandidates(candidates, {
      path: full,
      content: text,
      timestamp: latestTimestamp(text),
      adapter: codexAdapter.name,
      provenance,
      temporalRank: temporalRank(provenance, options)
    });
  }
  return { candidates, incomplete };
}

// review-surfaces D4 + D7 / METHODOLOGY.9: discover the SINGLE best session for this
// review across the Claude Code store (repo-slug-matched) AND the Codex rollout store
// (global, range-referenced only). Single-select (D7 — never stitch sessions) by the
// exact mutation provenance, commit/timing corroboration, weak references, then the
// latest in-session timestamp and greatest path — one total order over both stores. The
// winner's bytes are snapshotted ONCE here so parsing and the cache-signature hash
// see identical content. No store / no candidate -> undefined (caller degrades
// non-fatally, METHODOLOGY.4).
export function discoverConversationSession(options: DiscoveryOptions): DiscoveryResult | undefined {
  const claude = claudeCandidates(options);
  const codex = codexCandidates(options);
  const candidates = [...claude.candidates, ...codex.candidates];
  const scanIncomplete = claude.incomplete || codex.incomplete;
  let best: Candidate | undefined;
  for (const candidate of candidates) {
    if (best === undefined || isBetter(candidate, best)) {
      best = candidate;
    }
  }
  if (best === undefined) {
    if (scanIncomplete) {
      // A bounded scan that skipped every candidate is materially different from
      // an absent store. Return a rejection-only sentinel so the caller persists
      // the safe reason code and directs the user to --conversation. Its bytes are
      // never normalized because low-confidence discoveries are rejected first.
      return {
        kind: "rejected",
        matchedChangedFiles: 0,
        mutatedChangedFiles: 0,
        weakMatchedFiles: 0,
        confidence: "low",
        ambiguous: false,
        reasonCodes: ["discovery_work_budget_exhausted"]
      };
    }
    return undefined;
  }
  const runnerUp = candidates.filter((candidate) => candidate !== best).sort((left, right) =>
    isBetter(left, right) ? -1 : isBetter(right, left) ? 1 : 0
  )[0];
  // A skipped candidate was never ranked and could be the true producer. Never
  // ingest a stale retained winner from a known-incomplete scan; explicit path
  // selection is the honest escape hatch for oversized/older transcripts.
  const ambiguous = scanIncomplete || (runnerUp !== undefined && sameProducerRank(best, runnerUp, options));
  const mutationCount = best.provenance.mutatedPaths.length;
  const confidence = ambiguous || mutationCount === 0 || best.temporalRank === 0
    ? "low"
    : mutationCount >= 2 || best.provenance.observedCommitShas.length > 0
      ? "high"
      : "medium";
  const matched = new Set([
    ...best.provenance.mutatedPaths,
    ...best.provenance.readPaths,
    ...best.provenance.mentionedPaths
  ]);
  const weak = new Set([...best.provenance.readPaths, ...best.provenance.mentionedPaths].filter((file) =>
    !best.provenance.mutatedPaths.includes(file)
  ));
  return {
    kind: "session",
    path: best.path,
    adapter: best.adapter,
    content: best.content,
    hash: crypto.createHash("sha256").update(best.content).digest("hex"),
    matchedChangedFiles: matched.size,
    mutatedChangedFiles: mutationCount,
    weakMatchedFiles: weak.size,
    confidence,
    ambiguous,
    reasonCodes: [
      ...candidateReasonCodes(best),
      ...(scanIncomplete ? ["discovery_work_budget_exhausted"] : []),
      ...(ambiguous ? ["ambiguous_producer_candidates"] : [])
    ]
  };
}
