import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationEvent } from "../src/conversation/events";
import { redactBoundedBody } from "../src/conversation/field";
import { writeNormalizedConversation } from "../src/conversation/ingest";
import { buildAdapterInput, normalizeConversation, selectAdapter } from "../src/conversation/registry";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "conversations");

function fixtureInput(name: string) {
  const filePath = path.join(FIXTURES, name);
  return buildAdapterInput(filePath, fs.readFileSync(filePath, "utf8"));
}

function textInput(name: string, text: string) {
  return buildAdapterInput(name, text);
}

function hasToolCallReferencing(events: ConversationEvent[], needle: string): boolean {
  return events.some(
    (event) => event.kind === "tool_call" && (event.summary.includes(needle) || (event.command ?? "").includes(needle))
  );
}

function eachEventWellFormed(events: ConversationEvent[]): boolean {
  return events.every(
    (event, index) =>
      typeof event.id === "string" &&
      typeof event.actor === "string" &&
      typeof event.kind === "string" &&
      typeof event.summary === "string" &&
      event.raw_index === index
  );
}

test("review-surfaces.METHODOLOGY.6 each adapter normalizes its harness shape and converges on one event stream", () => {
  const claude = normalizeConversation(fixtureInput("claude-code.jsonl"));
  const codex = normalizeConversation(fixtureInput("codex.jsonl"));
  const cursor = normalizeConversation(fixtureInput("cursor.json"));

  assert.equal(claude?.adapter, "claude-code");
  assert.equal(codex?.adapter, "codex");
  assert.equal(cursor?.adapter, "cursor");

  for (const result of [claude, codex, cursor]) {
    assert.ok(result);
    assert.ok(result.events.length > 0);
    // Convergence: every adapter emits the SAME shape with sequential raw_index.
    assert.ok(eachEventWellFormed(result.events));
    assert.ok(result.events.some((event) => event.actor === "user" && event.kind === "message"));
  }

  // Tool calls (D8) are captured from each harness's own tool channel.
  assert.ok(hasToolCallReferencing(claude!.events, "pnpm run test"));
  assert.ok(hasToolCallReferencing(codex!.events, "pnpm run test"));
  assert.ok(cursor!.events.some((event) => event.kind === "tool_call" && event.file === "src/uploader.ts"));
  // A tool_result / function_call_output is captured as a tool event.
  assert.ok(claude!.events.some((event) => event.kind === "tool_result"));
  assert.ok(codex!.events.some((event) => event.kind === "tool_result"));
});

test("review-surfaces.METHODOLOGY.6 auto-detects by content shape and honors a --conversation-format override", () => {
  // Auto-detect by shape (not extension): all three could be .jsonl/.json.
  assert.equal(normalizeConversation(fixtureInput("claude-code.jsonl"))?.adapter, "claude-code");
  assert.equal(normalizeConversation(fixtureInput("codex.jsonl"))?.adapter, "codex");

  // A forced format bypasses detection.
  assert.equal(selectAdapter(fixtureInput("cursor.json"), "normalized")?.name, "normalized");
  assert.equal(normalizeConversation(fixtureInput("claude-code.jsonl"), "codex")?.adapter, "codex");
});

test("review-surfaces.METHODOLOGY.6 the normalized adapter still reads all three pre-normalized forms", () => {
  const jsonl = normalizeConversation(
    textInput("conv.jsonl", '{"id":"e1","actor":"assistant","kind":"decision","summary":"chose backoff"}')
  );
  assert.equal(jsonl?.adapter, "normalized");
  assert.equal(jsonl?.events[0].summary, "chose backoff");
  assert.equal(jsonl?.events[0].actor, "assistant");

  const yaml = normalizeConversation(textInput("conv.yaml", "events:\n  - actor: user\n    summary: hello there\n"));
  assert.equal(yaml?.adapter, "normalized");
  assert.equal(yaml?.events[0].actor, "user");
  assert.match(yaml!.events[0].summary, /hello there/);

  const plain = normalizeConversation(textInput("conv.md", "user: hi\nassistant: yo"));
  assert.equal(plain?.adapter, "normalized");
  assert.equal(plain?.events.length, 2);
  assert.equal(plain?.events[0].actor, "user");
  assert.equal(plain?.events[1].actor, "assistant");
});

test("review-surfaces.METHODOLOGY.6 tolerates malformed lines and unknown blocks without throwing", () => {
  const text = [
    '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"weird_block","data":1},{"type":"text","text":"ok"}]}}',
    "this line is not json at all",
    '{"broken": '
  ].join("\n");
  const result = normalizeConversation(textInput("rotted.jsonl", text), "claude-code");
  assert.ok(result);
  // Unknown block degrades to a message summary; nothing throws.
  assert.ok(result.events.some((event) => event.kind === "message"));
});

test("review-surfaces.METHODOLOGY.6 a rotted or unrecognized shape degrades to no-match, never a wrong adapter", () => {
  assert.equal(normalizeConversation(textInput("x.jsonl", '{"foo":"bar"}')), undefined);
  assert.equal(normalizeConversation(textInput("x.json", '{"random":1,"nested":{"a":2}}')), undefined);
});

test("review-surfaces.PRIVACY.7 redacts a Codex function_call_output and a Cursor code-edit secret at normalization", () => {
  const codex = normalizeConversation(fixtureInput("codex.jsonl"));
  const codexResult = codex?.events.find((event) => event.kind === "tool_result");
  assert.ok(codexResult);
  assert.match(codexResult.summary, /\[REDACTED:aws_secret\]/);
  assert.ok(!codexResult.summary.includes("0123456789ABCD"));

  const cursor = normalizeConversation(fixtureInput("cursor-secret-edit.json"));
  const edit = cursor?.events.find((event) => event.kind === "tool_call");
  assert.ok(edit);
  assert.match(edit.summary, /\[REDACTED:stripe_key\]/);
  assert.ok(!edit.summary.includes("sk_live_abcdefghijklmnopqrstuvwx"));
});

test("review-surfaces.PRIVACY.7 the persisted normalized log stores a blocked field as a hash, never its secret context", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-conv-"));
  const result = normalizeConversation(fixtureInput("claude-code.jsonl"));
  assert.ok(result);
  await writeNormalizedConversation(tmp, result.events);
  const persisted = fs.readFileSync(path.join(tmp, "inputs", "conversation.normalized.jsonl"), "utf8");

  // No raw secret, and no surrounding CONTEXT of the blocked field (the field is
  // replaced by a marker, not kept as masked-but-contextual text).
  assert.ok(!persisted.includes("ghp_"));
  assert.ok(!persisted.includes("All tests pass"));
  assert.ok(persisted.includes("[redacted-blocked]"));
  assert.ok(persisted.includes("blocked_redactions"));
  assert.match(persisted, /"blocked_field_hashes":\{"summary":"[0-9a-f]{64}"\}/);
  // Non-blocked fields are still readable (bounded redacted text, not hashed).
  assert.ok(persisted.includes("Add a retry to the uploader"));
});

test("review-surfaces.PRIVACY.7 a secret-bearing Cursor edit path is redacted in the summary and file field", () => {
  const text = JSON.stringify({
    messages: [
      { id: "m1", role: "assistant", text: "applying edit", edits: [{ file: "deploy/ghp_abcdefghijklmnopqrstuvwxyz0123456789.ts", text: "const x = 1;" }] }
    ]
  });
  const result = normalizeConversation(buildAdapterInput("c.json", text));
  const edit = result?.events.find((event) => event.kind === "tool_call");
  assert.ok(edit);
  assert.ok(!edit.summary.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!(edit.file ?? "").includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert.match(edit.file ?? "", /\[REDACTED:github_token\]/);
});

test("review-surfaces.PRIVACY.7 a blocked marker beyond the body bound is preserved so the block scan still sees it", () => {
  // The secret sits AFTER the 1200-char in-memory bound; redactBoundedBody must
  // still surface its [REDACTED:<kind>] marker so collectConversationBlockedKinds
  // detects the block.
  const body = `${"a".repeat(1300)} GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789`;
  const bounded = redactBoundedBody(body);
  assert.ok(!bounded.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert.match(bounded, /\[REDACTED:github_token\]/);
});

test("review-surfaces.METHODOLOGY.6 nested Codex tool blocks under message.content become tool events", () => {
  const text = [
    JSON.stringify({ type: "message", role: "assistant", content: [{ type: "function_call", name: "shell", arguments: "{\"command\":\"pnpm run test\"}" }] }),
    JSON.stringify({ type: "message", role: "tool", content: [{ type: "function_call_output", output: "all tests pass" }] })
  ].join("\n");
  const result = normalizeConversation(buildAdapterInput("codex.jsonl", text));
  assert.equal(result?.adapter, "codex");
  assert.ok(result.events.some((event) => event.kind === "tool_call" && (event.command ?? "").includes("pnpm run test")));
  assert.ok(result.events.some((event) => event.kind === "tool_result"));
});

test("review-surfaces.METHODOLOGY.6 a Codex function_call and its output get distinct event ids", () => {
  const text = [
    JSON.stringify({ type: "function_call", name: "shell", arguments: "{}", call_id: "call_1" }),
    JSON.stringify({ type: "function_call_output", call_id: "call_1", output: "done" })
  ].join("\n");
  const result = normalizeConversation(buildAdapterInput("codex.jsonl", text));
  const ids = result?.events.map((event) => event.id) ?? [];
  assert.equal(new Set(ids).size, ids.length, `ids must be unique: ${ids.join(", ")}`);
});

test("review-surfaces.METHODOLOGY.6 a raw JSONL transcript with a leading banner still routes to its harness adapter", () => {
  const text = [
    "=== Claude Code session 2026-06-16 (banner) ===",
    '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"pnpm run test"}}]}}'
  ].join("\n");
  const result = normalizeConversation(buildAdapterInput("session.jsonl", text));
  assert.equal(result?.adapter, "claude-code");
  assert.ok(result.events.some((event) => event.kind === "tool_call" && (event.command ?? "").includes("pnpm run test")));
});

test("review-surfaces.METHODOLOGY.6 the normalized adapter round-trips tool/command/file fields", () => {
  const text = '{"id":"e1","actor":"tool","kind":"tool_call","summary":"Bash(pnpm run test)","tool":"Bash","command":"pnpm run test","file":"src/x.ts"}';
  const result = normalizeConversation(buildAdapterInput("conv.jsonl", text));
  assert.equal(result?.adapter, "normalized");
  assert.equal(result.events[0].tool, "Bash");
  assert.equal(result.events[0].command, "pnpm run test");
  assert.equal(result.events[0].file, "src/x.ts");
});

test("review-surfaces.PRIVACY.7 a blocked secret beyond the persisted-field bound is still hash-marked", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-persist-"));
  const events: ConversationEvent[] = [
    { id: "e1", actor: "tool", kind: "tool_result", summary: `${"x".repeat(2100)} GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789`, raw_index: 0 }
  ];
  await writeNormalizedConversation(tmp, events);
  const persisted = fs.readFileSync(path.join(tmp, "inputs", "conversation.normalized.jsonl"), "utf8");
  assert.ok(!persisted.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert.ok(persisted.includes("[redacted-blocked]"));
  assert.match(persisted, /"blocked_field_hashes":\{"summary":"[0-9a-f]{64}"\}/);
});

test("review-surfaces.PRIVACY.7 a secret-shaped event id is redacted centrally", () => {
  const text = '{"id":"ghp_abcdefghijklmnopqrstuvwxyz0123456789","actor":"assistant","kind":"message","summary":"hi"}';
  const result = normalizeConversation(buildAdapterInput("conv.jsonl", text));
  assert.ok(result);
  assert.ok(!result.events[0].id.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert.match(result.events[0].id, /\[REDACTED:github_token\]/);
});

test("review-surfaces.METHODOLOGY.6 a Claude JSONL led by a summary/meta line still routes to the claude adapter", () => {
  const text = [
    '{"type":"summary","summary":"prior session recap","leafUuid":"x"}',
    '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"pnpm run test"}}]}}'
  ].join("\n");
  const result = normalizeConversation(buildAdapterInput("session.jsonl", text));
  assert.equal(result?.adapter, "claude-code");
  assert.ok(result.events.some((event) => event.kind === "tool_call" && (event.command ?? "").includes("pnpm run test")));
});

test("review-surfaces.PRIVACY.7 a secret-shaped tool/function name is redacted in tool and summary", () => {
  const text = '{"type":"function_call","name":"ghp_abcdefghijklmnopqrstuvwxyz0123456789","arguments":"{}","call_id":"c1"}';
  const result = normalizeConversation(buildAdapterInput("codex.jsonl", text));
  const call = result?.events.find((event) => event.kind === "tool_call");
  assert.ok(call);
  assert.ok(!(call.tool ?? "").includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!call.summary.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert.match(call.tool ?? "", /\[REDACTED:github_token\]/);
});

test("review-surfaces.PRIVACY.7 secret-shaped normalized actor/kind are redacted", () => {
  const text = '{"id":"e1","actor":"ghp_abcdefghijklmnopqrstuvwxyz0123456789","kind":"message","summary":"hi"}';
  const result = normalizeConversation(buildAdapterInput("conv.jsonl", text));
  assert.ok(result);
  assert.ok(!result.events[0].actor.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert.match(result.events[0].actor, /\[REDACTED:github_token\]/);
});
