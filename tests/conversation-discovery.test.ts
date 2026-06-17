import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claudeCodeProjectSlug, discoverConversationSession } from "../src/conversation/discovery";
import { collectInputs, CollectOptions } from "../src/collector/collect";
import { defaultConfig } from "../src/config/config";

// A minimal but adapter-VALID Claude Code session line (nested message envelope with
// a Claude block type), carrying a top-level ISO-UTC timestamp for the D7 tie-break.
function line(timestamp: string, text: string): Record<string, unknown> {
  return {
    type: "user",
    timestamp,
    uuid: `u-${timestamp}`,
    message: { role: "user", content: [{ type: "text", text }] }
  };
}

function writeSession(storeRoot: string, slug: string, name: string, lines: Record<string, unknown>[]): string {
  const dir = path.join(storeRoot, ".claude", "projects", slug);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return full;
}

function freshStore(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-store-"));
}

// review-surfaces D4: the Claude Code project-slug must be EXACT — every '/' AND '.'
// becomes '-', and an absolute path's leading '/' yields the leading '-'. A wrong
// transform silently finds nothing.
test("review-surfaces.METHODOLOGY.4 claudeCodeProjectSlug replaces every slash and dot, with a leading dash", () => {
  assert.equal(
    claudeCodeProjectSlug("/Users/shaance/Documents/projects/review-surfaces"),
    "-Users-shaance-Documents-projects-review-surfaces"
  );
  // dots in a path segment are replaced too (e.g. a versioned dir).
  assert.equal(claudeCodeProjectSlug("/home/me/proj.v2"), "-home-me-proj-v2");
});

test("review-surfaces.METHODOLOGY.4 discovers the single Claude Code session for this repo's slug", () => {
  const store = freshStore();
  try {
    const full = writeSession(store, "-repo-app", "only.jsonl", [line("2026-06-17T10:00:00.000Z", "add a retry")]);
    const discovered = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: [] });
    assert.ok(discovered);
    assert.equal(discovered.path, full, "the discovered path is the absolute session file under the slug dir");
    assert.equal(discovered.adapter, "claude-code");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// review-surfaces D7: single-selection picks the session with the LATEST in-session
// event timestamp (the current working session), never stitches multiple.
test("review-surfaces.METHODOLOGY.4 tie-break picks the session with the latest in-session timestamp", () => {
  const store = freshStore();
  try {
    writeSession(store, "-repo-app", "older.jsonl", [line("2026-06-17T08:00:00.000Z", "old work")]);
    const newer = writeSession(store, "-repo-app", "newer.jsonl", [
      line("2026-06-17T09:00:00.000Z", "start"),
      line("2026-06-17T11:30:00.000Z", "latest turn")
    ]);
    const discovered = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: [] });
    assert.ok(discovered);
    assert.equal(discovered.path, newer, "the session whose latest event is most recent wins");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// Determinism (no Math.random / no fs-enumeration dependence): equal latest
// timestamps resolve to the lexicographically greatest path, reproducibly.
test("review-surfaces.METHODOLOGY.4 a timestamp tie resolves deterministically by path", () => {
  const store = freshStore();
  try {
    writeSession(store, "-repo-app", "a-session.jsonl", [line("2026-06-17T10:00:00.000Z", "a")]);
    const b = writeSession(store, "-repo-app", "b-session.jsonl", [line("2026-06-17T10:00:00.000Z", "b")]);
    const first = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: [] });
    const second = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: [] });
    assert.ok(first && second);
    assert.equal(first.path, b, "the greater path wins a timestamp tie");
    assert.equal(first.path, second.path, "selection is reproducible across runs");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// review-surfaces D7 (Codex P2): the same repo's slug holds sessions for every
// branch/task. A NEWER unrelated session must NOT win over an OLDER session that
// references the base..head changed files — the diff discriminator ties the pick to
// the review range.
test("review-surfaces.METHODOLOGY.4 a session referencing the changed files beats a newer unrelated one", () => {
  const store = freshStore();
  try {
    const onTopic = writeSession(store, "-repo-app", "on-topic.jsonl", [
      line("2026-06-17T08:00:00.000Z", "editing src/uploader.ts to add a retry")
    ]);
    // A more RECENT session that never touches the changed file (different task).
    writeSession(store, "-repo-app", "unrelated.jsonl", [line("2026-06-17T12:00:00.000Z", "writing docs/readme")]);
    const discovered = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: ["src/uploader.ts"] });
    assert.ok(discovered);
    assert.equal(discovered.path, onTopic, "the diff-referencing session wins despite being older");
    assert.equal(discovered.matchedChangedFiles, 1, "the match basis reflects the changed-file reference");
    assert.ok(discovered.hash.length === 64, "a sha256 content hash is returned for the cache signature");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// review-surfaces.METHODOLOGY.4: a FAILED auto-discovery (no session matching this
// repo's slug) returns undefined so the caller degrades non-fatally — never throws.
test("review-surfaces.METHODOLOGY.4 no matching session store returns undefined (non-fatal)", () => {
  const store = freshStore();
  try {
    // A session exists for a DIFFERENT repo's slug, none for this one.
    writeSession(store, "-other-repo", "x.jsonl", [line("2026-06-17T10:00:00.000Z", "elsewhere")]);
    assert.equal(discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: [] }), undefined);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.METHODOLOGY.4 non-jsonl and non-Claude files in the slug dir are ignored", () => {
  const store = freshStore();
  try {
    const dir = path.join(store, ".claude", "projects", "-repo-app");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a session");
    fs.writeFileSync(path.join(dir, "garbage.jsonl"), "this is not json\n{also not}\n");
    assert.equal(discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: [] }), undefined, "no valid session -> no match");
    // Adding one valid session makes it discoverable, ignoring the noise.
    const good = writeSession(store, "-repo-app", "good.jsonl", [line("2026-06-17T10:00:00.000Z", "real")]);
    assert.equal(discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: [] })?.path, good);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// --- collect() integration: the seam wires discovery, precedence, and path safety ---

function initRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-disc-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  fs.writeFileSync(path.join(tmp, "README.md"), "# Fixture\n");
  return tmp;
}

function collectOptions(tmp: string, store: string, overrides: Partial<CollectOptions> = {}): CollectOptions {
  return {
    cwd: tmp,
    config: { ...defaultConfig, specs: [], docs: ["README.md"], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    conversationStoreRoot: store,
    ...overrides
  };
}

test("review-surfaces.METHODOLOGY.4 collect() auto-discovers the session and anchors it repo-relative (no absolute path persisted)", async () => {
  const tmp = initRepo();
  const store = freshStore();
  try {
    const session = writeSession(store, claudeCodeProjectSlug(tmp), "live.jsonl", [
      line("2026-06-17T10:00:00.000Z", "implement the uploader")
    ]);
    const result = await collectInputs(collectOptions(tmp, store));
    assert.ok((result.conversationEvents ?? []).length > 0, "discovered events populate the collection");
    assert.equal(result.conversationSource, "claude-code");
    const anchor = result.conversationEvidencePath ?? "";
    assert.ok(anchor.endsWith("inputs/conversation.normalized.jsonl"), "the persisted anchor is the normalized log");
    assert.ok(!anchor.startsWith("/") && !anchor.includes(".claude"), "the anchor is repo-relative, never the absolute home-dir path");
    assert.ok(
      result.diagnostics.some((line) => line.includes(session)),
      "the absolute picked path is announced via diagnostics (stderr)"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.METHODOLOGY.4 an explicit --conversation wins over auto-discovery", async () => {
  const tmp = initRepo();
  const store = freshStore();
  try {
    writeSession(store, claudeCodeProjectSlug(tmp), "live.jsonl", [line("2026-06-17T10:00:00.000Z", "discovered work")]);
    fs.writeFileSync(path.join(tmp, "explicit.md"), "user: explicit log\nassistant: done\n");
    const result = await collectInputs(collectOptions(tmp, store, { conversationPath: "explicit.md" }));
    assert.ok((result.conversationEvents ?? []).length > 0);
    // The explicit path is used as-is (not the discovered session), so the safe
    // discovered-anchor override is NOT set.
    assert.equal(result.conversationEvidencePath, undefined, "an explicit path keeps its own evidence anchor");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.METHODOLOGY.4 --no-conversation-discovery suppresses discovery even when a session matches", async () => {
  const tmp = initRepo();
  const store = freshStore();
  try {
    writeSession(store, claudeCodeProjectSlug(tmp), "live.jsonl", [line("2026-06-17T10:00:00.000Z", "discovered work")]);
    const result = await collectInputs(collectOptions(tmp, store, { conversationDiscovery: false }));
    assert.equal(result.conversationEvents, undefined, "discovery is off: no events ingested");
    assert.equal(result.conversationEvidencePath, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.PRIVACY.1 a discovered session with an outside-repo --out uses a pathless evidence anchor", async () => {
  const tmp = initRepo();
  const store = freshStore();
  const externalOut = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-extout-"));
  try {
    writeSession(store, claudeCodeProjectSlug(tmp), "live.jsonl", [line("2026-06-17T10:00:00.000Z", "work")]);
    const result = await collectInputs(collectOptions(tmp, store, { outputDir: externalOut }));
    assert.ok((result.conversationEvents ?? []).length > 0, "discovery still ingests events");
    // The normalized log is written OUTSIDE the repo, so no repo-relative path
    // resolves to it -> pathless evidence (the ref validates on its event_id).
    assert.equal(result.conversationEvidencePath, undefined, "outside-repo output -> pathless conversation evidence");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
    fs.rmSync(externalOut, { recursive: true, force: true });
  }
});
