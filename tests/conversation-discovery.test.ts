import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claudeCodeProjectSlug, discoverConversationSession } from "../src/conversation/discovery";
import { collectInputs, CollectOptions } from "../src/collector/collect";
import { defaultConfig } from "../src/config/config";
import { buildMethodology } from "../src/methodology/methodology";
import { buildAdapterInput, normalizeConversation } from "../src/conversation/registry";
import { codexProvenance } from "../src/conversation/adapters/codex";

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

function claudeToolLine(timestamp: string, name: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp,
    uuid: `tool-${timestamp}-${name}`,
    message: { role: "assistant", content: [{ type: "tool_use", name, input }] }
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

// The Codex `session_meta` first line, carrying the recorded repo `cwd` (the global
// store's repo-match key) — mirrors the real on-disk shape.
function codexMeta(cwd: string, timestamp: string): Record<string, unknown> {
  return { timestamp, type: "session_meta", payload: { id: "s", timestamp, cwd, originator: "test" } };
}

// A minimal but adapter-VALID Codex rollout response line: a payload-wrapped response
// item with a Codex item type and a top-level ISO-UTC timestamp.
function codexLine(timestamp: string, text: string): Record<string, unknown> {
  return { timestamp, type: "response_item", payload: { type: "output_text", text } };
}

function codexToolLine(timestamp: string, name: string, input: unknown): Record<string, unknown> {
  return {
    timestamp,
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: `call-${timestamp}`, name, input }
  };
}

// Codex rollouts live in a SINGLE GLOBAL store: <root>/.codex/sessions/YYYY/MM/DD/
// rollout-<ts>.jsonl — not grouped by repo (the recorded cwd is the repo key).
// `dateDirs` is the YYYY/MM/DD path.
function writeCodexSession(storeRoot: string, dateDirs: string, name: string, lines: Record<string, unknown>[]): string {
  const dir = path.join(storeRoot, ".codex", "sessions", ...dateDirs.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return full;
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

test("review-surfaces.CONVERSATION_REVIEW.7 exact mutation provenance beats a newer audit that quotes the range", () => {
  const store = freshStore();
  try {
    const producer = writeSession(store, "-repo-app", "producer.jsonl", [
      claudeToolLine("2026-06-17T08:00:00.000Z", "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "a", new_string: "b" })
    ]);
    writeSession(store, "-repo-app", "audit.jsonl", [
      line("2026-06-17T12:00:00.000Z", "@codex review: src/uploader.ts at reviewed commit abcdef1")
    ]);
    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts"],
      headSha: "abcdef1234567890"
    });
    assert.ok(discovered);
    assert.equal(discovered.path, producer);
    assert.equal(discovered.mutatedChangedFiles, 1);
    assert.equal(discovered.confidence, "medium");
    assert.deepEqual(discovered.reasonCodes, ["exact_changed_path_mutation"]);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 an explicitly failed Claude edit is not producer provenance", () => {
  const store = freshStore();
  try {
    writeSession(store, "-repo-app", "failed-edit.jsonl", [{
      type: "assistant",
      timestamp: "2026-06-17T09:00:00.000Z",
      uuid: "call-envelope",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "edit-call",
          name: "Edit",
          input: { file_path: "/repo/app/src/uploader.ts", old_string: "a", new_string: "b" }
        }]
      }
    }, {
      type: "user",
      timestamp: "2026-06-17T09:00:01.000Z",
      uuid: "result-envelope",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "edit-call", is_error: true, content: "Edit failed." }]
      }
    }]);
    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts"]
    });
    assert.equal(discovered?.mutatedChangedFiles, 0);
    assert.equal(discovered?.confidence, "low");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 path substrings and backup names are weak non-matches", () => {
  const store = freshStore();
  try {
    writeSession(store, "-repo-app", "audit.jsonl", [
      line("2026-06-17T12:00:00.000Z", "reviewed src/uploader.ts.bak and mysrc/uploader.ts")
    ]);
    const discovered = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: ["src/uploader.ts"] });
    assert.ok(discovered);
    assert.equal(discovered.matchedChangedFiles, 0);
    assert.equal(discovered.confidence, "low");
    assert.deepEqual(discovered.reasonCodes, ["recency_only"]);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 reviewed-SHA text without mutation is not producer proof", () => {
  const store = freshStore();
  try {
    writeSession(store, "-repo-app", "review.jsonl", [
      line("2026-06-17T12:00:00.000Z", "@codex review src/uploader.ts: reviewed commit abcdef1; all good")
    ]);
    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts"],
      headSha: "abcdef1234567890"
    });
    assert.ok(discovered);
    assert.equal(discovered.confidence, "low");
    assert.equal(discovered.mutatedChangedFiles, 0);
    assert.ok(discovered.reasonCodes.includes("reviewed_commit_observed"));
    assert.ok(discovered.reasonCodes.includes("exact_changed_path_mention"));
    assert.ok(discovered.reasonCodes.includes("audit_or_read_only_session"));
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 Codex apply_patch headers are exact mutation provenance", () => {
  const store = freshStore();
  try {
    const producer = writeCodexSession(store, "2026/06/17", "rollout-2026-06-17T09-00-00-producing.jsonl", [
      codexMeta("/repo/app", "2026-06-17T09:00:00.000Z"),
      codexToolLine("2026-06-17T09:00:01.000Z", "apply_patch", "*** Begin Patch\n*** Update File: src/uploader.ts\n@@\n-old\n+new\n*** End Patch")
    ]);
    const discovered = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: ["src/uploader.ts"] });
    assert.ok(discovered);
    assert.equal(discovered.path, producer);
    assert.equal(discovered.mutatedChangedFiles, 1);
    assert.equal(discovered.confidence, "medium");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 a correlated failed Codex mutation is not producer provenance", () => {
  const store = freshStore();
  try {
    writeCodexSession(store, "2026/06/17", "rollout-2026-06-17T09-00-00-failed-call.jsonl", [
      codexMeta("/repo/app", "2026-06-17T09:00:00.000Z"),
      {
        timestamp: "2026-06-17T09:00:01.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "failed-mutation",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: src/uploader.ts\n@@\n-old\n+new\n*** End Patch"
        }
      },
      {
        timestamp: "2026-06-17T09:00:02.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "failed-mutation",
          output: JSON.stringify({ exit_code: 1, output: "Patch rejected." })
        }
      }
    ]);
    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts"]
    });
    assert.equal(discovered?.mutatedChangedFiles, 0);
    assert.equal(discovered?.confidence, "low");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 Codex patch_apply_end status and mutation provenance agree", () => {
  const store = freshStore();
  try {
    const success = writeCodexSession(store, "2026/06/17", "rollout-2026-06-17T09-00-00-success.jsonl", [
      codexMeta("/repo/app", "2026-06-17T09:00:00.000Z"),
      codexLine("2026-06-17T09:00:00.500Z", "Applying the uploader patch."),
      {
        timestamp: "2026-06-17T09:00:01.000Z",
        type: "event_msg",
        payload: { id: "patch-success", type: "patch_apply_end", success: true, changes: { "src/uploader.ts": { kind: "update" } } }
      }
    ]);
    const failed = writeCodexSession(store, "2026/06/17", "rollout-2026-06-17T10-00-00-failed.jsonl", [
      codexMeta("/repo/app", "2026-06-17T10:00:00.000Z"),
      codexLine("2026-06-17T10:00:00.500Z", "A later patch attempt failed."),
      {
        timestamp: "2026-06-17T10:00:01.000Z",
        type: "event_msg",
        payload: { id: "patch-failed", type: "patch_apply_end", status: "failed", changes: { "src/uploader.ts": { kind: "update" } } }
      }
    ]);
    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts"]
    });
    const normalizedSuccess = normalizeConversation(buildAdapterInput(success, fs.readFileSync(success, "utf8")));
    const normalizedFailure = normalizeConversation(buildAdapterInput(failed, fs.readFileSync(failed, "utf8")));

    assert.equal(discovered?.path, success, "a failed patch result is not mutation provenance");
    assert.equal(discovered?.mutatedChangedFiles, 1);
    assert.equal(normalizedSuccess?.events.find((event) => event.id === "patch-success")?.result_status, "passed");
    assert.equal(normalizedFailure?.events.find((event) => event.id === "patch-failed")?.result_status, "failed");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 explicit patch failure overrides completed status", () => {
  const text = [
    codexMeta("/repo/app", "2026-06-17T09:00:00.000Z"),
    {
      timestamp: "2026-06-17T09:00:01.000Z",
      type: "event_msg",
      payload: {
        id: "contradictory-patch",
        type: "patch_apply_end",
        success: false,
        status: "completed",
        changes: { "src/uploader.ts": { kind: "update" } }
      }
    }
  ].map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n");

  const provenance = codexProvenance(buildAdapterInput("desktop.jsonl", text), {
    cwd: "/repo/app",
    changedFiles: ["src/uploader.ts"]
  });
  const normalized = normalizeConversation(buildAdapterInput("desktop.jsonl", text));

  assert.deepEqual(provenance.mutatedPaths, []);
  assert.equal(normalized?.events.find((event) => event.id === "contradictory-patch")?.result_status, "failed");
});

test("review-surfaces.CONVERSATION_REVIEW.7 patch_apply_end alone selects the Codex adapter", () => {
  const text = [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/app" } }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "patch_apply_end", success: true, changes: { "src/uploader.ts": { kind: "update" } } }
    })
  ].join("\n");
  const normalized = normalizeConversation(buildAdapterInput("desktop.jsonl", text));
  const patchResult = normalized?.events.find((event) => event.result_status === "passed");

  assert.equal(normalized?.adapter, "codex");
  assert.equal(patchResult?.tool, "apply_patch");
  assert.equal(patchResult?.result_status, "passed");
});

test("review-surfaces.CONVERSATION_REVIEW.7 an incomplete work-budget scan rejects its retained winner", () => {
  const store = freshStore();
  try {
    const producer = writeSession(store, "-repo-app", "producer.jsonl", [
      claudeToolLine("2026-06-17T09:00:00.000Z", "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "a", new_string: "b" })
    ]);
    const oversized = writeSession(store, "-repo-app", "oversized.jsonl", [
      line("2026-06-17T10:00:00.000Z", "newer session")
    ]);
    fs.truncateSync(oversized, (32 * 1024 * 1024) + 1);

    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts"]
    });

    assert.equal(discovered?.path, producer);
    assert.equal(discovered?.confidence, "low");
    assert.equal(discovered?.ambiguous, true);
    assert.ok(discovered?.reasonCodes.includes("discovery_work_budget_exhausted"));
    assert.ok(discovered?.reasonCodes.includes("ambiguous_producer_candidates"));
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 reports work-budget exhaustion when every candidate is skipped", () => {
  const store = freshStore();
  try {
    const oversized = writeSession(store, "-repo-app", "oversized.jsonl", [
      line("2026-06-17T10:00:00.000Z", "oversized producing session")
    ]);
    fs.truncateSync(oversized, (32 * 1024 * 1024) + 1);

    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts"]
    });

    assert.equal(discovered?.confidence, "low");
    assert.equal(discovered?.ambiguous, false);
    assert.ok(discovered?.reasonCodes.includes("discovery_work_budget_exhausted"));
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 equally supported producers are ambiguous", () => {
  const store = freshStore();
  try {
    for (const [name, timestamp] of [["first.jsonl", "2026-06-17T09:00:00.000Z"], ["second.jsonl", "2026-06-17T10:00:00.000Z"]] as const) {
      writeSession(store, "-repo-app", name, [
        claudeToolLine(timestamp, "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "a", new_string: "b" })
      ]);
    }
    const discovered = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: ["src/uploader.ts"] });
    assert.ok(discovered);
    assert.equal(discovered.ambiguous, true);
    assert.equal(discovered.confidence, "low");
    assert.ok(discovered.reasonCodes.includes("ambiguous_producer_candidates"));
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 mutation timing breaks a producer tie before recency", () => {
  const store = freshStore();
  try {
    const beforeHead = writeSession(store, "-repo-app", "before-head.jsonl", [
      claudeToolLine("2026-06-17T09:00:00.000Z", "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "a", new_string: "b" })
    ]);
    writeSession(store, "-repo-app", "after-head.jsonl", [
      claudeToolLine("2026-06-17T12:00:00.000Z", "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "b", new_string: "c" })
    ]);
    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts"],
      headCommittedAt: "2026-06-17T10:00:00.000Z",
      workingTreeDirty: false
    });
    assert.ok(discovered);
    assert.equal(discovered.path, beforeHead);
    assert.equal(discovered.ambiguous, false);
    assert.ok(discovered.reasonCodes.includes("mutation_not_after_head_commit"));
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 a newer narrow dirty-worktree producer beats an older broad producer", () => {
  const store = freshStore();
  try {
    writeSession(store, "-repo-app", "older-broad.jsonl", [
      claudeToolLine("2026-06-17T08:00:00.000Z", "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "a", new_string: "b" }),
      claudeToolLine("2026-06-17T08:01:00.000Z", "Edit", { file_path: "/repo/app/src/retry.ts", old_string: "a", new_string: "b" })
    ]);
    const current = writeSession(store, "-repo-app", "current-narrow.jsonl", [
      claudeToolLine("2026-06-17T12:00:00.000Z", "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "b", new_string: "c" })
    ]);
    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts", "src/retry.ts"],
      workingTreeDirty: true
    });

    assert.ok(discovered);
    assert.equal(discovered.path, current);
    assert.equal(discovered.mutatedChangedFiles, 1);
    assert.equal(discovered.ambiguous, false);
    assert.equal(discovered.confidence, "medium");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 an after-head broad session cannot beat the real narrower producer", () => {
  const store = freshStore();
  try {
    const beforeHead = writeSession(store, "-repo-app", "before-head-narrow.jsonl", [
      claudeToolLine("2026-06-17T09:00:00.000Z", "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "a", new_string: "b" })
    ]);
    writeSession(store, "-repo-app", "after-head-broad.jsonl", [
      claudeToolLine("2026-06-17T12:00:00.000Z", "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "b", new_string: "c" }),
      claudeToolLine("2026-06-17T12:01:00.000Z", "Edit", { file_path: "/repo/app/src/retry.ts", old_string: "a", new_string: "b" })
    ]);
    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts", "src/retry.ts"],
      headCommittedAt: "2026-06-17T10:00:00.000Z",
      workingTreeDirty: false
    });

    assert.equal(discovered?.path, beforeHead);
    assert.ok(discovered?.reasonCodes.includes("mutation_not_after_head_commit"));
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 a lone after-head producer is rejected", () => {
  const store = freshStore();
  try {
    writeSession(store, "-repo-app", "after-head-only.jsonl", [
      claudeToolLine("2026-06-17T12:00:00.000Z", "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "a", new_string: "b" })
    ]);
    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts"],
      headCommittedAt: "2026-06-17T10:00:00.000Z",
      workingTreeDirty: false
    });

    assert.equal(discovered?.confidence, "low");
    assert.ok(discovered?.reasonCodes.includes("mutation_after_head_commit"));
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 dirty-worktree recency breaks equal-path producer ties", () => {
  const store = freshStore();
  try {
    writeSession(store, "-repo-app", "older-equal.jsonl", [
      claudeToolLine("2026-06-17T08:00:00.000Z", "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "a", new_string: "b" })
    ]);
    const current = writeSession(store, "-repo-app", "current-equal.jsonl", [
      claudeToolLine("2026-06-17T12:00:00.000Z", "Edit", { file_path: "/repo/app/src/uploader.ts", old_string: "b", new_string: "c" })
    ]);
    const discovered = discoverConversationSession({
      storeRoot: store,
      cwd: "/repo/app",
      changedFiles: ["src/uploader.ts"],
      workingTreeDirty: true
    });

    assert.equal(discovered?.path, current);
    assert.equal(discovered?.ambiguous, false);
    assert.equal(discovered?.confidence, "medium");
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

// --- METHODOLOGY.9: Codex rollout-store discovery (global store, cwd-scoped) ---

// A Codex rollout recorded under THIS repo's cwd that references a changed file is
// discovered, even though the Codex store is one global directory across all repos.
test("review-surfaces.METHODOLOGY.9 discovers a cwd-matched Codex rollout that references the changed files", () => {
  const store = freshStore();
  try {
    const codex = writeCodexSession(store, "2026/06/17", "rollout-2026-06-17T10-00-00-abc.jsonl", [
      codexMeta("/repo/app", "2026-06-17T10:00:00.000Z"),
      codexLine("2026-06-17T10:00:00.000Z", "editing src/uploader.ts to add a retry")
    ]);
    const discovered = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: ["src/uploader.ts"] });
    assert.ok(discovered);
    assert.equal(discovered.path, codex, "the cwd-matched, diff-referencing Codex rollout is discovered");
    assert.equal(discovered.adapter, "codex");
    assert.equal(discovered.matchedChangedFiles, 1);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// The Codex store is GLOBAL, so a path-substring hit is NOT enough: a session recorded
// under a DIFFERENT repo's cwd must never be picked even when it mentions a changed-file
// path (a generic name like README.md collides across repos). cwd is the repo key.
test("review-surfaces.METHODOLOGY.9 a Codex session recorded under a different cwd is never picked", () => {
  const store = freshStore();
  try {
    writeCodexSession(store, "2026/06/17", "rollout-2026-06-17T12-00-00-xyz.jsonl", [
      codexMeta("/some/other/repo", "2026-06-17T12:00:00.000Z"),
      codexLine("2026-06-17T12:00:00.000Z", "also edited src/uploader.ts in a different project")
    ]);
    assert.equal(
      discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: ["src/uploader.ts"] }),
      undefined,
      "a different-cwd Codex session is not this repo's session despite the path mention"
    );
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// The repo key comes ONLY from the session_meta first line — a `"cwd"` in a later response
// item (e.g. a function_call recording a shell command's working directory) must never be
// read as the repo key over the global store (Codex #113 r4).
test("review-surfaces.METHODOLOGY.9 a tool-call cwd in a later line is not used as the repo key", () => {
  const store = freshStore();
  try {
    writeCodexSession(store, "2026/06/17", "rollout-2026-06-17T10-00-00-nometa.jsonl", [
      // session_meta WITHOUT a cwd field...
      { timestamp: "2026-06-17T10:00:00.000Z", type: "session_meta", payload: { id: "s", timestamp: "2026-06-17T10:00:00.000Z", originator: "test" } },
      // ...and a later function_call whose arguments mention /repo/app as a command cwd.
      { timestamp: "2026-06-17T10:00:01.000Z", type: "response_item", payload: { type: "function_call", call_id: "c1", arguments: JSON.stringify({ cwd: "/repo/app", command: "ls" }) } }
    ]);
    assert.equal(
      discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: ["src/uploader.ts"] }),
      undefined,
      "a function_call cwd is not the session's recorded repo key"
    );
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// A burst of NEWER sessions recorded under other repos' cwds must not crowd this repo's
// rollout out of the probe window — the cwd probe walks past non-matches to collect this
// repo's sessions (Codex #113), it does not slice the newest-N first and then filter.
test("review-surfaces.METHODOLOGY.9 other repos' newer sessions do not crowd out this repo's Codex rollout", () => {
  const store = freshStore();
  try {
    // Four NEWER sessions under unrelated cwds (later timestamps sort first in the scan).
    for (const ts of ["20-00-00", "21-00-00", "22-00-00", "23-00-00"]) {
      writeCodexSession(store, "2026/06/17", `rollout-2026-06-17T${ts}-other.jsonl`, [
        codexMeta(`/some/other/repo-${ts}`, `2026-06-17T${ts.replace(/-/g, ":")}.000Z`),
        codexLine(`2026-06-17T${ts.replace(/-/g, ":")}.000Z`, "unrelated work")
      ]);
    }
    // This repo's session is OLDER (sorts last), so a slice-newest-then-filter would miss it.
    const mine = writeCodexSession(store, "2026/06/17", "rollout-2026-06-17T10-00-00-mine.jsonl", [
      codexMeta("/repo/app", "2026-06-17T10:00:00.000Z"),
      codexLine("2026-06-17T10:00:00.000Z", "editing src/uploader.ts")
    ]);
    const discovered = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: ["src/uploader.ts"] });
    assert.ok(discovered);
    assert.equal(discovered.path, mine, "this repo's rollout is found despite newer unrelated sessions");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// Many newer SAME-repo sessions must not skip this repo's range-referencing producing
// session — there is no match-count cap, so the diff-referencing rollout is read and wins
// even when it is older than a dozen unrelated same-repo sessions (Codex #113 r2).
test("review-surfaces.METHODOLOGY.9 a match-count cap does not skip the range-referencing same-repo rollout", () => {
  const store = freshStore();
  try {
    // 15 NEWER same-repo sessions that do NOT reference the changed file.
    for (let i = 10; i < 25; i += 1) {
      writeCodexSession(store, "2026/06/17", `rollout-2026-06-17T${i}-30-00-newer.jsonl`, [
        codexMeta("/repo/app", `2026-06-17T${i}:30:00.000Z`),
        codexLine(`2026-06-17T${i}:30:00.000Z`, "later unrelated same-repo work")
      ]);
    }
    // An OLDER same-repo session that DOES reference the changed file (the producing one).
    const producing = writeCodexSession(store, "2026/06/17", "rollout-2026-06-17T09-00-00-producing.jsonl", [
      codexMeta("/repo/app", "2026-06-17T09:00:00.000Z"),
      codexLine("2026-06-17T09:00:00.000Z", "implementing src/uploader.ts retry")
    ]);
    const discovered = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: ["src/uploader.ts"] });
    assert.ok(discovered);
    assert.equal(discovered.path, producing, "the range-referencing rollout wins on score despite 15 newer same-repo sessions");
    assert.equal(discovered.matchedChangedFiles, 1);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// Cross-store selection is ONE total order: a cwd-matched Codex session that references
// the changed range beats a same-repo Claude session that references none (recency-only).
test("review-surfaces.METHODOLOGY.9 a range-referencing Codex session beats a recency-only same-repo Claude session", () => {
  const store = freshStore();
  try {
    // Same-repo Claude session, but it does not reference the changed file (recency-only).
    writeSession(store, claudeCodeProjectSlug("/repo/app"), "claude.jsonl", [line("2026-06-17T11:00:00.000Z", "unrelated notes")]);
    // Codex session under the same cwd that DOES reference the changed file.
    const codex = writeCodexSession(store, "2026/06/17", "rollout-2026-06-17T09-00-00-abc.jsonl", [
      codexMeta("/repo/app", "2026-06-17T09:00:00.000Z"),
      codexLine("2026-06-17T09:00:00.000Z", "fixing src/uploader.ts retry path")
    ]);
    const discovered = discoverConversationSession({ storeRoot: store, cwd: "/repo/app", changedFiles: ["src/uploader.ts"] });
    assert.ok(discovered);
    assert.equal(discovered.path, codex, "the range-referencing Codex session wins over a recency-only Claude session");
    assert.equal(discovered.adapter, "codex");
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
      claudeToolLine("2026-06-17T10:00:00.000Z", "Edit", { file_path: path.join(tmp, "README.md"), old_string: "Fixture", new_string: "Updated" })
    ]);
    const result = await collectInputs(collectOptions(tmp, store));
    assert.ok((result.conversationEvents ?? []).length > 0, "discovered events populate the collection");
    assert.equal(result.conversationSource, "claude-code");
    assert.deepEqual(result.conversationDiscovery, {
      status: "admitted",
      confidence: "medium",
      ambiguous: false,
      mutated_changed_files: 1,
      weak_matched_files: 0,
      reason_codes: ["exact_changed_path_mutation"]
    });
    const methodology = await buildMethodology(tmp, result, undefined, []);
    assert.deepEqual(methodology.conversation_discovery, result.conversationDiscovery, "safe selection provenance persists into the packet methodology surface");
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

test("review-surfaces.CONVERSATION_REVIEW.7 ignored dirty files do not relax committed-head timing", async () => {
  const tmp = initRepo();
  const store = freshStore();
  try {
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp });
    execFileSync("git", ["add", "README.md"], { cwd: tmp });
    execFileSync("git", ["commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "README.md"), "# Reviewed change\n");
    execFileSync("git", ["add", "README.md"], { cwd: tmp });
    execFileSync("git", ["commit", "-m", "head"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, ".env"), "IGNORED=dirty\n");
    writeSession(store, claudeCodeProjectSlug(tmp), "after-head.jsonl", [
      claudeToolLine("2030-01-01T00:00:00.000Z", "Edit", {
        file_path: path.join(tmp, "README.md"),
        old_string: "Fixture",
        new_string: "Reviewed change"
      })
    ]);

    const result = await collectInputs(collectOptions(tmp, store, { baseRef: "HEAD^" }));

    assert.equal(result.conversationDiscovery?.status, "rejected");
    assert.ok(result.conversationDiscovery?.reason_codes.includes("mutation_after_head_commit"));
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
    assert.equal(result.conversationDiscovery, undefined);
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
    writeSession(store, claudeCodeProjectSlug(tmp), "live.jsonl", [
      claudeToolLine("2026-06-17T10:00:00.000Z", "Edit", { file_path: path.join(tmp, "README.md"), old_string: "Fixture", new_string: "Updated" })
    ]);
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

test("review-surfaces.CONVERSATION_REVIEW.7 a recency-only discovery is rejected before ingestion", async () => {
  const tmp = initRepo();
  const store = freshStore();
  try {
    writeSession(store, claudeCodeProjectSlug(tmp), "live.jsonl", [line("2026-06-17T10:00:00.000Z", "some work")]);
    const result = await collectInputs(collectOptions(tmp, store));
    assert.equal(result.conversationEvents, undefined, "a low-confidence session never reaches normalization");
    assert.equal(result.conversationSource, undefined);
    assert.equal(result.conversationDiscovery?.status, "rejected");
    assert.equal(result.conversationDiscovery?.confidence, "low");
    assert.equal(result.conversationDiscovery?.ambiguous, false);
    assert.ok(result.conversationDiscovery?.reason_codes.includes("recency_only"));
    assert.equal(result.conversationEvidencePath, undefined);
    const warning = result.diagnostics.find((entry) => /WARNING/.test(entry) && /rejected auto-discovered/.test(entry));
    assert.ok(warning, "a hard warning explains that the candidate was rejected before ingestion");
    assert.match(warning, /No transcript was normalized, cached, or audited/);
    assert.match(warning, /--conversation/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 rejected discovery provenance invalidates the collection cache signature", async () => {
  const tmp = initRepo();
  const store = freshStore();
  try {
    const absent = await collectInputs(collectOptions(tmp, store));
    writeSession(store, claudeCodeProjectSlug(tmp), "rejected.jsonl", [
      line("2026-06-17T10:00:00.000Z", "some unrelated work")
    ]);
    const rejected = await collectInputs(collectOptions(tmp, store));

    assert.equal(absent.conversationDiscovery, undefined);
    assert.equal(rejected.conversationDiscovery?.status, "rejected");
    assert.notEqual(rejected.manifest.signature, absent.manifest.signature);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.7 ambiguous producers are rejected before ingestion", async () => {
  const tmp = initRepo();
  const store = freshStore();
  try {
    execFileSync("git", ["add", "README.md"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "fixture"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "README.md"), "# Updated fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "update fixture"], { cwd: tmp, stdio: "ignore" });
    for (const [name, timestamp] of [["first.jsonl", "2026-06-17T09:00:00.000Z"], ["second.jsonl", "2026-06-17T10:00:00.000Z"]] as const) {
      writeSession(store, claudeCodeProjectSlug(tmp), name, [
        claudeToolLine(timestamp, "Edit", { file_path: path.join(tmp, "README.md"), old_string: "Fixture", new_string: "Updated" })
      ]);
    }
    const result = await collectInputs(collectOptions(tmp, store, { baseRef: "HEAD~1" }));
    assert.equal(result.conversationEvents, undefined);
    assert.equal(result.conversationSource, undefined);
    assert.equal(result.conversationDiscovery?.status, "rejected");
    assert.equal(result.conversationDiscovery?.ambiguous, true);
    assert.ok(result.diagnostics.some((entry) =>
      /rejected auto-discovered/.test(entry) && /ambiguous_producer_candidates/.test(entry)
    ));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});
