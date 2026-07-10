import test from "node:test";
import assert from "node:assert/strict";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import type { CommandTranscript } from "../src/commands/transcripts";
import { buildConversationReview } from "../src/conversation/review";
import type { ConversationEvent } from "../src/conversation/events";
import type { ReasoningProvider, StructuredResult } from "../src/llm/provider";
import {
  EVENTS,
  analysisPayload,
  candidate,
  retryDeletionDiff,
  stageProvider
} from "./helpers/conversation-review";

function multiFileDiff(): ReturnType<typeof parseStructuredDiff> {
  return parseStructuredDiff(["a", "b", "c", "d", "e"].flatMap((name) => [
    `diff --git a/src/${name}.ts b/src/${name}.ts`,
    "index 1111111..2222222 100644",
    `--- a/src/${name}.ts`,
    `+++ b/src/${name}.ts`,
    "@@ -1,1 +1,1 @@",
    `-export const ${name} = \"old\";`,
    `+export const ${name} = \"new\";`
  ]).join("\n"));
}

test("review-surfaces.CONVERSATION_REVIEW.2 a missing conversation is explicitly not assessed and makes zero provider calls", async () => {
  let calls = 0;
  const provider: ReasoningProvider = {
    name: "ai-sdk",
    async generateStructured(): Promise<StructuredResult> {
      calls += 1;
      return { ok: false, reason: "must_not_be_called" };
    }
  };

  const result = await buildConversationReview({
    provider,
    providerName: "ai-sdk",
    events: [],
    diff: retryDeletionDiff()
  });

  assert.equal(calls, 0);
  assert.equal(result.analysis.status, "not_assessed");
  assert.ok(result.analysis.quality_flags.includes("conversation_log_missing"));
  assert.deepEqual(result.insights, []);
});

test("review-surfaces.CONVERSATION_REVIEW.3 final conversation intent plus an exact delete-line anchor yields a validated contradiction", async () => {
  const staged = stageProvider([
    candidate({
      diff_anchors: [{ path: "src/retry.ts", line_kind: "delete", line: 10, contains: "retryWithBackoff(send)" }]
    })
  ]);

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: retryDeletionDiff()
  });

  assert.deepEqual(staged.stages, ["conversation_analysis", "conversation_review_insights"]);
  const reconciliationPrompt = staged.prompts.get("conversation_review_insights") ?? "";
  assert.match(reconciliationPrompt, /later user message explicitly preserves retries/i);
  assert.match(reconciliationPrompt, /BEGIN UNTRUSTED VALIDATED CONVERSATION ANALYSIS JSON/);
  assert.match(reconciliationPrompt, /END UNTRUSTED VALIDATED CONVERSATION ANALYSIS JSON/);
  assert.equal(result.insights.length, 1);
  const insight = result.insights[0];
  assert.equal(insight.evidence_state, "contradicted");
  assert.equal(insight.basis, "validated_anchors");
  assert.deepEqual(insight.conversation_event_ids, ["user-final"]);
  assert.deepEqual(insight.paths, ["src/retry.ts"]);
  assert.ok(insight.evidence.some((ref) =>
    ref.kind === "conversation" && ref.event_id === "user-final" && ref.validation_status === "valid"
  ));
  assert.ok(insight.evidence.some((ref) =>
    ref.kind === "diff" && ref.path === "src/retry.ts" && ref.line_start === 10 &&
      ref.validation_status === "valid"
  ));
});

test("invalid event and path citations are rejected, demote a partly grounded item, and drop an ungrounded item", async () => {
  const staged = stageProvider([
    candidate({
      conversation_event_ids: ["user-final", "invented-event"],
      paths: ["src/retry.ts", "src/invented.ts"],
      diff_anchors: [{ path: "src/retry.ts", line_kind: "delete", line: 10, contains: "retryWithBackoff(send)" }]
    }),
    candidate({
      root_cause_key: "fabricated-only",
      title: "Fabricated insight",
      conversation_event_ids: ["ghost-event"],
      paths: ["src/ghost.ts"],
      diff_anchors: [{ path: "src/ghost.ts", line_kind: "delete", line: 1, contains: "ghostBehavior" }]
    })
  ]);

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: retryDeletionDiff()
  });

  assert.equal(result.insights.length, 1);
  assert.equal(result.insights[0].evidence_state, "unverified");
  assert.equal(result.insights[0].basis, "ai_reconciliation");
  assert.deepEqual(result.insights[0].conversation_event_ids, ["user-final"]);
  assert.deepEqual(result.insights[0].paths, ["src/retry.ts"]);
  assert.ok(result.analysis.quality_flags.includes("conversation_review_citations_rejected"));
  assert.ok(!JSON.stringify(result).includes("invented-event"));
  assert.ok(!JSON.stringify(result).includes("src/invented.ts"));
  assert.ok(!JSON.stringify(result).includes("ghost-event"));
});

test("review-surfaces.CONVERSATION_REVIEW.3 insights deduplicate by root cause, order deterministically, and cap the reviewer surface at three", async () => {
  const staged = stageProvider([
    candidate({
      root_cause_key: "root-a",
      title: "A: primary contradiction",
      paths: ["src/a.ts"],
      priority: "high",
      evidence_state: "contradicted",
      diff_anchors: [{ path: "src/a.ts", line_kind: "delete", line: 1, contains: "const a = \"old\"" }]
    }),
    candidate({
      root_cause_key: "root-a",
      title: "A: duplicate lower-priority wording",
      paths: ["src/a.ts"],
      priority: "medium",
      evidence_state: "contradicted",
      diff_anchors: [{ path: "src/a.ts", line_kind: "delete", line: 1, contains: "const a = \"old\"" }]
    }),
    candidate({
      root_cause_key: "root-d",
      title: "D: second contradiction",
      category: "scope_surprise",
      paths: ["src/d.ts"],
      priority: "low",
      evidence_state: "contradicted",
      diff_anchors: [{ path: "src/d.ts", line_kind: "delete", line: 1, contains: "const d = \"old\"" }]
    }),
    candidate({
      root_cause_key: "root-b",
      title: "B: unverified critical concern",
      category: "validation_gap",
      paths: ["src/b.ts"],
      priority: "critical",
      evidence_state: "unverified"
    }),
    candidate({
      root_cause_key: "root-c",
      title: "C: supported change",
      category: "intentional_change",
      paths: ["src/c.ts"],
      priority: "critical",
      evidence_state: "supported",
      diff_anchors: [{ path: "src/c.ts", line_kind: "add", line: 1, contains: "const c = \"new\"" }]
    })
  ]);

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: multiFileDiff()
  });

  assert.equal(result.insights.length, 3);
  assert.deepEqual(result.insights.map((item) => item.id), ["CONV-INSIGHT-001", "CONV-INSIGHT-002", "CONV-INSIGHT-003"]);
  assert.deepEqual(result.insights.map((item) => item.title), [
    "A: primary contradiction",
    "D: second contradiction",
    "B: unverified critical concern"
  ]);
  assert.equal(result.insights.filter((item) => item.title.startsWith("A:")).length, 1);
});

test("review-surfaces.CONVERSATION_REVIEW.3 insight title ordering is locale-independent", async () => {
  const staged = stageProvider([
    candidate({
      root_cause_key: "uppercase-title",
      category: "intent_mismatch",
      title: "Z uppercase title",
      paths: ["src/a.ts"],
      diff_anchors: [{ path: "src/a.ts", line_kind: "delete", line: 1, contains: "const a = \"old\"" }]
    }),
    candidate({
      root_cause_key: "lowercase-title",
      category: "scope_surprise",
      title: "a lowercase title",
      paths: ["src/b.ts"],
      diff_anchors: [{ path: "src/b.ts", line_kind: "delete", line: 1, contains: "const b = \"old\"" }]
    })
  ]);

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: multiFileDiff()
  });

  assert.deepEqual(result.insights.map((item) => item.title), ["Z uppercase title", "a lowercase title"]);
});

test("supported and contradicted claims without an exact deterministic anchor are demoted to unverified", async () => {
  const staged = stageProvider([
    candidate({
      root_cause_key: "unsupported-supported",
      category: "intentional_change",
      title: "Provider called this supported",
      evidence_state: "supported"
    }),
    candidate({
      root_cause_key: "unsupported-contradiction",
      category: "validation_gap",
      title: "Provider called this contradicted",
      evidence_state: "contradicted"
    })
  ]);

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: retryDeletionDiff()
  });

  assert.equal(result.insights.length, 2);
  assert.deepEqual(result.insights.map((item) => item.evidence_state), ["unverified", "unverified"]);
  assert.ok(result.insights.every((item) => item.basis === "ai_reconciliation"));
});

test("review-surfaces.CONVERSATION_REVIEW.3 a passing current-head transcript is retained as evidence but cannot alone prove removed behavior", async () => {
  const transcript: CommandTranscript = {
    id: "cmd-tests",
    command: "pnpm test",
    status: "passed",
    exit_code: 0,
    head_sha: "head-123",
    truncated: false,
    source_path: ".review-surfaces/commands/tests.json"
  };
  const staged = stageProvider([
    candidate({
      root_cause_key: "removed-retry-unproved",
      category: "test_weakening",
      title: "Removed retry behavior is no longer asserted",
      evidence_state: "contradicted",
      command_ids: ["cmd-tests"]
    })
  ]);

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events: EVENTS,
    diff: retryDeletionDiff(),
    commandTranscripts: [transcript],
    headSha: "head-123"
  });

  assert.equal(result.insights.length, 1);
  assert.equal(result.insights[0].evidence_state, "unverified");
  assert.equal(result.insights[0].basis, "ai_reconciliation");
  const commandEvidence = result.insights[0].evidence.find((ref) =>
    ref.kind === "command" && ref.event_id === "cmd-tests"
  );
  assert.ok(commandEvidence);
  assert.equal(commandEvidence.validation_status, "valid");
  assert.match(commandEvidence.note ?? "", /at reviewed head/);
});

test("review-surfaces.CONVERSATION_REVIEW.3 golden PR130-like cleanup separates one retained-boundary contradiction from intentional removal noise", async () => {
  const events: ConversationEvent[] = [
    { id: "p130-u1", actor: "user", kind: "message", summary: "Remove the Swift/iOS analysis feature, its docs, and its dedicated implementation and tests.", raw_index: 0 },
    { id: "p130-a1", actor: "assistant", kind: "message", summary: "That could also include Apple cache and privacy-ignore defaults.", raw_index: 1 },
    { id: "p130-u2", actor: "user", kind: "decision", summary: "No. Keep DerivedData, .build, .swiftpm, xcuserdata, and *.xcuserstate ignored, with their regression tests.", raw_index: 2 },
    { id: "p130-a2", actor: "assistant", kind: "decision", summary: "Privacy defaults and privacy tests are explicitly out of scope.", raw_index: 3 }
  ];
  const diff = parseStructuredDiff([
    "diff --git a/src/swift/project.ts b/src/swift/project.ts",
    "deleted file mode 100644",
    "--- a/src/swift/project.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export function inspectSwiftProject() {}",
    "diff --git a/tests/swift/project.test.ts b/tests/swift/project.test.ts",
    "deleted file mode 100644",
    "--- a/tests/swift/project.test.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-test('inspects Swift projects', () => {});",
    "diff --git a/docs/swift-support.md b/docs/swift-support.md",
    "deleted file mode 100644",
    "--- a/docs/swift-support.md",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-# Swift support",
    "diff --git a/src/privacy/ignore.ts b/src/privacy/ignore.ts",
    "index 1111111..2222222 100644",
    "--- a/src/privacy/ignore.ts",
    "+++ b/src/privacy/ignore.ts",
    "@@ -4,5 +4,0 @@",
    "-\"**/DerivedData/**\",",
    "-\"**/.build/**\",",
    "-\"**/.swiftpm/**\",",
    "-\"**/xcuserdata/**\",",
    "-\"**/*.xcuserstate\"",
    "diff --git a/tests/privacy.test.ts b/tests/privacy.test.ts",
    "index 1111111..2222222 100644",
    "--- a/tests/privacy.test.ts",
    "+++ b/tests/privacy.test.ts",
    "@@ -10,2 +10,0 @@",
    "-assert.equal(isIgnored('App/DerivedData/cache'), true);",
    "-assert.equal(isIgnored('App.xcodeproj/xcuserdata/me.xcuserstate'), true);"
  ].join("\n"));
  const staged = stageProvider([
    candidate({
      root_cause_key: "retained-apple-privacy-boundary",
      category: "intent_mismatch",
      title: "Swift cleanup also removes privacy protections explicitly retained by the user",
      summary: "The diff deletes the retained ignore defaults and their regression assertions; the broad passing suite is non-probative because those assertions disappeared.",
      reviewer_action: "Restore the defaults and assertions, or obtain an explicit scope change.",
      priority: "high",
      evidence_state: "contradicted",
      conversation_event_ids: ["p130-u2", "p130-a2"],
      paths: ["src/privacy/ignore.ts", "tests/privacy.test.ts"],
      requirement_ids: ["fixture.PRIVACY.1"],
      command_ids: ["CMD-NPM-TEST"],
      diff_anchors: [
        { path: "src/privacy/ignore.ts", line_kind: "delete", line: 4, contains: "**/DerivedData/**" },
        { path: "tests/privacy.test.ts", line_kind: "delete", line: 10, contains: "DerivedData/cache" }
      ]
    }),
    candidate({
      root_cause_key: "intentional-swift-removal",
      category: "intentional_change",
      title: "Swift subsystem removal matches the requested scope",
      summary: "The Swift implementation, dedicated test, and documentation deletions match the original removal request.",
      reviewer_action: "Treat the clustered Swift deletion as intentional while reviewing the retained privacy boundary separately.",
      priority: "low",
      evidence_state: "supported",
      conversation_event_ids: ["p130-u1"],
      paths: ["src/swift/project.ts", "tests/swift/project.test.ts", "docs/swift-support.md"],
      diff_anchors: [{ path: "src/swift/project.ts", line_kind: "delete", line: 1, contains: "inspectSwiftProject" }]
    })
  ], analysisPayload({
    summary: "Remove Swift support while retaining Apple privacy-ignore defaults and their tests.",
    intent: [{ text: "Remove the Swift subsystem and its dedicated docs/tests.", event_ids: ["p130-u1"] }],
    refinements: [{ text: "Retain Apple privacy ignores and their regression tests.", event_ids: ["p130-u2"] }],
    constraints: [{ text: "DerivedData, .build, .swiftpm, xcuserdata, and *.xcuserstate stay ignored.", event_ids: ["p130-u2"] }],
    decisions: [{ text: "Privacy defaults are out of scope.", event_ids: ["p130-a2"] }],
    rejected_alternatives: [{ text: "Expanding cleanup into privacy defaults was rejected.", event_ids: ["p130-a1", "p130-u2"] }]
  }));
  const transcript: CommandTranscript = {
    id: "CMD-NPM-TEST",
    command: "npm test",
    status: "passed",
    exit_code: 0,
    head_sha: "p130-head",
    truncated: false,
    source_path: ".review-surfaces/commands/npm-test.json"
  };

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events,
    diff,
    commandTranscripts: [transcript],
    requirementIds: ["fixture.PRIVACY.1"],
    headSha: "p130-head"
  });

  assert.equal(result.insights.length, 2);
  const [privacy, swift] = result.insights;
  assert.equal(privacy.evidence_state, "contradicted");
  assert.equal(privacy.priority, "high");
  assert.deepEqual(privacy.conversation_event_ids, ["p130-u2", "p130-a2"]);
  assert.deepEqual(privacy.paths, ["src/privacy/ignore.ts", "tests/privacy.test.ts"]);
  assert.deepEqual(privacy.requirement_ids, ["fixture.PRIVACY.1"]);
  assert.match(`${privacy.title} ${privacy.summary}`, /privacy|DerivedData|xcuserdata/i);
  assert.equal(swift.evidence_state, "supported");
  assert.equal(swift.priority, "low");
  assert.equal(result.insights.filter((item) => item.paths.some((file) => file.startsWith("tests/swift/"))).length, 1);
  assert.match(staged.prompts.get("conversation_review_insights") ?? "", /\*\*\/DerivedData|DerivedData\/\*\*/);
});

test("review-surfaces.CONVERSATION_REVIEW.3 golden foreign JS change clusters a removed contract and regression assertion", async () => {
  const events: ConversationEvent[] = [
    { id: "todo-u1", actor: "user", kind: "message", summary: "Make addTodo smaller and easier to read.", raw_index: 0 },
    { id: "todo-a1", actor: "assistant", kind: "message", summary: "We could rely on UI validation and remove the backend blank-title guard and its test.", raw_index: 1 },
    { id: "todo-u2", actor: "user", kind: "decision", summary: "No. Blank titles must still be rejected and the exact regression test must remain.", raw_index: 2 },
    { id: "todo-a2", actor: "assistant", kind: "decision", summary: "Non-empty title validation and its regression assertion will remain unchanged.", raw_index: 3 }
  ];
  const diff = parseStructuredDiff([
    "diff --git a/src/api.js b/src/api.js",
    "index 1111111..2222222 100644",
    "--- a/src/api.js",
    "+++ b/src/api.js",
    "@@ -2,3 +2,0 @@ export function addTodo(store, title) {",
    "-  if (typeof title !== 'string' || title.trim() === '') {",
    "-    throw new Error('title must be a non-empty string');",
    "-  }",
    "diff --git a/test/api.test.js b/test/api.test.js",
    "index 1111111..2222222 100644",
    "--- a/test/api.test.js",
    "+++ b/test/api.test.js",
    "@@ -8,3 +8,0 @@",
    "-  assert.throws(() => addTodo(fakeStore(), '   '),",
    "-    /title must be a non-empty string/",
    "-  );"
  ].join("\n"));
  const staged = stageProvider([
    candidate({
      root_cause_key: "blank-title-contract-removal",
      category: "intent_mismatch",
      title: "Blank-title contract and its regression guard were removed together",
      summary: "The backend non-empty-title guard and its exact assert.throws regression test were both deleted despite the final user constraint.",
      reviewer_action: "Restore both validation and the assertion, or explicitly change the contract with author approval.",
      priority: "high",
      evidence_state: "contradicted",
      conversation_event_ids: ["todo-u2", "todo-a2"],
      paths: ["src/api.js", "test/api.test.js"],
      requirement_ids: ["todo.API.1"],
      diff_anchors: [
        { path: "src/api.js", line_kind: "delete", line: 3, contains: "title must be a non-empty string" },
        { path: "test/api.test.js", line_kind: "delete", line: 8, contains: "assert.throws" }
      ]
    })
  ], analysisPayload({
    summary: "Refactor addTodo while preserving backend blank-title rejection.",
    intent: [{ text: "Make addTodo easier to read without changing behavior.", event_ids: ["todo-u1", "todo-u2"] }],
    refinements: [{ text: "Blank titles must still be rejected and the regression test must remain.", event_ids: ["todo-u2"] }],
    constraints: [{ text: "Preserve non-empty title validation.", event_ids: ["todo-u2"] }],
    decisions: [{ text: "Keep validation and its assertion.", event_ids: ["todo-a2"] }],
    rejected_alternatives: [{ text: "Relying only on UI validation was rejected.", event_ids: ["todo-a1", "todo-u2"] }]
  }));

  const result = await buildConversationReview({
    provider: staged.provider,
    providerName: "ai-sdk",
    events,
    diff,
    requirementIds: ["todo.API.1"]
  });

  assert.equal(result.insights.length, 1);
  const insight = result.insights[0];
  assert.equal(insight.evidence_state, "contradicted");
  assert.equal(insight.priority, "high");
  assert.deepEqual(insight.conversation_event_ids, ["todo-u2", "todo-a2"]);
  assert.deepEqual(insight.paths, ["src/api.js", "test/api.test.js"]);
  assert.deepEqual(insight.requirement_ids, ["todo.API.1"]);
  assert.match(`${insight.title} ${insight.summary}`, /blank|non-empty title/i);
  assert.doesNotMatch([insight.title, insight.summary, insight.reviewer_action].join("\n"), /pnpm|review-surfaces|unmapped cluster|large diff/i);
  assert.match(staged.prompts.get("conversation_review_insights") ?? "", /assert\.throws/);
});
