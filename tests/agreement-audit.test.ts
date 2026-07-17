import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { AgreementAuditInput, AgreementCandidate } from "../src/audit/contract";
import { groundAgreementAudit } from "../src/audit/grounding";
import { parseAgreementAuditCandidate, parseAgreementAuditInput } from "../src/audit/parse";
import { renderAgreementAuditMarkdown } from "../src/audit/render";
import {
  AGREEMENT_BENCH_ROOT as BENCH_ROOT,
  agreementCandidate as agreement,
  loadAgreementInput as loadInput,
  readJson
} from "./helpers/agreement-audit";

test("late correction becomes the primary reviewer decision with exact conversation and diff evidence", () => {
  const input = loadInput("late-correction");
  const candidate = parseAgreementAuditCandidate({
    final_goal: { text: "Remove Swift analysis while retaining Apple privacy defaults.", conversation_event_ids: ["u1", "u2"] },
    agreements: [
      agreement({
        key: "remove-swift",
        statement: "The requested Swift analysis implementation was removed.",
        conversation_event_ids: ["u1"],
        diff_citations: [{ path: "src/swift/project.ts", side: "delete", line: 1, contains: "inspectSwiftProject" }]
      }),
      agreement({
        key: "privacy-boundary",
        kind: "human_boundary",
        statement: "The diff removes privacy defaults the final user correction explicitly retained.",
        state: "diverged",
        conversation_event_ids: ["u2"],
        diff_citations: [{ path: "src/privacy/ignore.ts", side: "delete", line: 4, contains: "DerivedData" }],
        reviewer_action: "Restore the retained privacy defaults or obtain an explicit scope change."
      })
    ],
    complete: true,
    limitations: []
  });
  const audit = groundAgreementAudit(input, candidate);
  assert.equal(audit.status, "needs_human_decision");
  assert.ok(audit.limitations.some((limitation) => /may not be exhaustive/.test(limitation)));
  assert.equal(audit.rejections.length, 0);
  const markdown = renderAgreementAuditMarkdown(audit);
  assert.ok(markdown.indexOf("## Needs your decision") < markdown.indexOf("Final agreement and aligned work"));
  assert.match(markdown, /Restore the retained privacy defaults/);
  assert.match(markdown, /This list may not be exhaustive/);
  assert.match(markdown, /conversation `u2`/);
  assert.match(markdown, /`src\/privacy\/ignore\.ts:4`/);
  assert.doesNotMatch(markdown, /review queue|requirement coverage|change map/i);
});

test("a rejected evidence citation makes the whole audit inconclusive instead of silently clean", () => {
  const input = loadInput("clean-alignment");
  const candidate = parseAgreementAuditCandidate({
    final_goal: { text: "Remove the redundant change map.", conversation_event_ids: ["u1"] },
    agreements: [agreement({
      key: "fake-clean",
      statement: "The map was removed.",
      conversation_event_ids: ["u1"],
      diff_citations: [{ path: "src/render/change-map.ts", side: "delete", line: 999, contains: "renderChangeMap" }]
    })],
    complete: true,
    limitations: []
  });
  const audit = groundAgreementAudit(input, candidate);
  assert.equal(audit.status, "cannot_audit");
  assert.equal(audit.agreements.length, 0);
  assert.equal(audit.rejections.length, 1);
  assert.match(renderAgreementAuditMarkdown(audit), /No alignment conclusion is available/);
});

test("a supporting divergence still forces a human decision and cannot render a false-clean headline", () => {
  const input = loadInput("unauthorized-scope");
  const audit = groundAgreementAudit(input, parseAgreementAuditCandidate({
    final_goal: { text: "Fix only the local parser without a dependency.", conversation_event_ids: ["u1"] },
    agreements: [agreement({
      key: "dependency-boundary",
      kind: "human_boundary",
      statement: "The diff adds the dependency the human excluded.",
      state: "diverged",
      materiality: "supporting",
      conversation_event_ids: ["u1"],
      diff_citations: [{ path: "package.json", side: "add", line: 25, contains: "new-config-parser" }],
      reviewer_action: "Remove the dependency or obtain an explicit scope change."
    })],
    complete: true,
    limitations: []
  }));
  assert.equal(audit.status, "needs_human_decision");
  const markdown = renderAgreementAuditMarkdown(audit);
  assert.doesNotMatch(markdown, /No conversation-grounded mismatch was found/);
  assert.match(markdown, /Diverged from the agreement/);
});

test("a candidate with no grounded agreements can never manufacture a clean audit", () => {
  const input = loadInput("clean-alignment");
  const audit = groundAgreementAudit(input, parseAgreementAuditCandidate({
    final_goal: { text: "Remove the map and stale screenshot while keeping the written example.", conversation_event_ids: ["u1", "u2"] },
    agreements: [],
    complete: true,
    limitations: []
  }));
  assert.equal(audit.status, "cannot_audit");
});

test("final-goal citations cannot replace an agreement for a human turn", () => {
  const input = loadInput("clean-alignment");
  const audit = groundAgreementAudit(input, parseAgreementAuditCandidate({
    final_goal: { text: "Remove the change map while preserving the written example.", conversation_event_ids: ["u1", "u2"] },
    agreements: [agreement({
      key: "remove-map",
      statement: "The change map was removed.",
      conversation_event_ids: ["u1"],
      diff_citations: [{ path: "src/render/change-map.ts", side: "delete", line: 1, contains: "renderChangeMap" }]
    })],
    complete: true,
    limitations: []
  }));
  assert.equal(audit.status, "cannot_audit");
  assert.ok(audit.limitations.some((limitation) => /user turn.*u2/.test(limitation)));
});

test("rejected agreements cannot satisfy human-turn coverage", () => {
  const input = loadInput("clean-alignment");
  const audit = groundAgreementAudit(input, parseAgreementAuditCandidate({
    final_goal: { text: "Remove the change map while preserving the written example.", conversation_event_ids: ["u1", "u2"] },
    agreements: [
      agreement({
        key: "remove-map",
        statement: "The change map was removed.",
        conversation_event_ids: ["u1"],
        diff_citations: [{ path: "src/render/change-map.ts", side: "delete", line: 1, contains: "renderChangeMap" }]
      }),
      agreement({
        key: "preserve-example",
        kind: "human_boundary",
        statement: "The written example was preserved.",
        conversation_event_ids: ["u2"],
        diff_citations: [{ path: "README.md", side: "context", line: 24, contains: "not present" }]
      })
    ],
    complete: true,
    limitations: []
  }));
  assert.equal(audit.rejections.length, 1);
  assert.ok(audit.limitations.some((limitation) => /user turn.*u2/.test(limitation)));
});

test("one broad agreement cannot manufacture a clean result by citing every user turn", () => {
  const input = loadInput("clean-alignment");
  const audit = groundAgreementAudit(input, parseAgreementAuditCandidate({
    final_goal: { text: "Remove the change map and related stale material.", conversation_event_ids: ["u1", "u2"] },
    agreements: [agreement({
      key: "broad-removal",
      statement: "The requested cleanup appears complete.",
      conversation_event_ids: ["u1", "u2"],
      diff_citations: [{ path: "src/render/change-map.ts", side: "delete", line: 1, contains: "renderChangeMap" }]
    })],
    complete: true,
    limitations: []
  }));
  assert.equal(audit.status, "cannot_audit");
  assert.ok(audit.limitations.some((limitation) => /completeness was not independently verified/.test(limitation)));
});

test("an unchanged context line cannot prove a divergence", () => {
  const input = loadInput("clean-alignment");
  const audit = groundAgreementAudit(input, parseAgreementAuditCandidate({
    final_goal: { text: "Remove the map and stale screenshot while keeping the written example.", conversation_event_ids: ["u1", "u2"] },
    agreements: [agreement({
      key: "forged-divergence",
      kind: "human_boundary",
      statement: "The written example was removed.",
      state: "diverged",
      conversation_event_ids: ["u2"],
      diff_citations: [{ path: "README.md", side: "context", line: 24, contains: "reviewer brief" }],
      reviewer_action: "Restore it."
    })],
    complete: true,
    limitations: []
  }));
  assert.equal(audit.status, "cannot_audit");
  assert.match(audit.rejections[0].reasons.join(" "), /divergence needs an exact diff citation/);
});

test("partial multi-session scope can never produce an alignment claim", () => {
  const input = loadInput("validation-contradiction");
  input.conversation.status = "partial";
  input.conversation.caveat = "A later implementation session may be missing.";
  const candidate = parseAgreementAuditCandidate({
    final_goal: { text: "Fix the retry race.", conversation_event_ids: ["u1"] },
    agreements: [agreement({
      key: "retry-fix",
      statement: "The retry change appears in the diff.",
      conversation_event_ids: ["u1"],
      diff_citations: [{ path: "src/retry.ts", side: "add", line: 42, contains: "retryQueue.flush" }]
    })],
    complete: true,
    limitations: []
  });
  const audit = groundAgreementAudit(input, candidate);
  assert.equal(audit.status, "cannot_audit");
  assert.ok(audit.limitations.includes("A later implementation session may be missing."));
});

test("an incomplete audit still renders grounded reviewer decisions as non-exhaustive", () => {
  const input = loadInput("late-correction");
  input.conversation.status = "partial";
  input.conversation.caveat = "A later session may be missing.";
  const audit = groundAgreementAudit(input, parseAgreementAuditCandidate({
    final_goal: { text: "Remove Swift analysis while retaining privacy defaults.", conversation_event_ids: ["u1", "u2"] },
    agreements: [agreement({
      key: "privacy-boundary",
      kind: "human_boundary",
      statement: "The privacy boundary was crossed.",
      state: "diverged",
      conversation_event_ids: ["u2"],
      diff_citations: [{ path: "src/privacy/ignore.ts", side: "delete", line: 4, contains: "DerivedData" }],
      reviewer_action: "Restore the default."
    })],
    complete: true,
    limitations: []
  }));
  const markdown = renderAgreementAuditMarkdown(audit);
  assert.equal(audit.status, "cannot_audit");
  assert.match(markdown, /Audit incomplete/);
  assert.match(markdown, /Needs your decision/);
  assert.match(markdown, /Restore the default/);
  assert.match(markdown, /may not be exhaustive/);
});

test("failed exact-head evidence can contradict an agent validation claim", () => {
  const input = loadInput("validation-contradiction");
  const candidate = parseAgreementAuditCandidate({
    final_goal: { text: "Fix the retry race, keep the queue contract, document terminal failure, and validate it.", conversation_event_ids: ["u1", "u2", "u3"] },
    agreements: [
      agreement({ key: "retry-race", statement: "The retry-race request needs review.", state: "unresolved", conversation_event_ids: ["u1"], reviewer_action: "Confirm the race is fixed." }),
      agreement({ key: "queue-boundary", kind: "human_boundary", statement: "The queue contract must remain unchanged.", state: "unresolved", conversation_event_ids: ["u2"], reviewer_action: "Confirm the queue contract is preserved." }),
      agreement({ key: "terminal-failure-docs", statement: "Terminal retry failure must be documented.", state: "unresolved", conversation_event_ids: ["u3"], reviewer_action: "Confirm the operator documentation is present." }),
      agreement({
        key: "tests-pass",
        kind: "validation_claim",
        statement: "The agent said the focused tests passed, but the exact-head command failed.",
        state: "diverged",
        conversation_event_ids: ["a1"],
        command_ids: ["retry-tests"],
        reviewer_action: "Fix the focused test failure before accepting the claim."
      })
    ],
    complete: true,
    limitations: []
  });
  const audit = groundAgreementAudit(input, candidate);
  assert.equal(audit.status, "needs_human_decision");
  const validation = audit.agreements.find((agreement) => agreement.key === "tests-pass");
  assert.equal(validation?.commands[0].exact_head, true);
  assert.ok(validation && !("command_ids" in validation));
});

test("failed or unknown commands cannot prove a fulfilled validation claim", () => {
  for (const status of ["failed", "unknown"] as const) {
    const input = loadInput("validation-contradiction");
    input.commands[0].status = status;
    const audit = groundAgreementAudit(input, parseAgreementAuditCandidate({
      final_goal: { text: "Fix the retry race, keep the queue contract, document terminal failure, and validate it.", conversation_event_ids: ["u1", "u2", "u3"] },
      agreements: [agreement({
        key: `tests-${status}`,
        kind: "validation_claim",
        statement: "The focused tests passed.",
        state: "fulfilled",
        conversation_event_ids: ["a1"],
        command_ids: ["retry-tests"]
      })],
      complete: true,
      limitations: []
    }));
    assert.equal(audit.status, "cannot_audit");
    assert.match(audit.rejections[0].reasons.join(" "), /cannot cite failed or unknown|needs a passed exact-head command/);
  }
});

test("renderer preserves all ten independent agreements without a semantic output cap", () => {
  const input = loadInput("large-agreement-set");
  const candidates: AgreementCandidate[] = [
    fulfilled("rename", "Rename the command.", "u1", input.diff[0]),
    agreement({ key: "preserve-data", kind: "human_boundary", statement: "Confirm old data remains untouched.", state: "unresolved", conversation_event_ids: ["u2"], reviewer_action: "Inspect storage behavior before approval." }),
    fulfilled("cancel", "Add cancellation.", "u3", input.diff[1]),
    fulfilled("partial", "Preserve partial progress.", "u4", input.diff[2]),
    fulfilled("scope", "Show the current scope.", "u5", input.diff[3]),
    fulfilled("retry", "Add retry.", "u6", input.diff[4]),
    agreement({ key: "no-settings", kind: "human_boundary", statement: "The diff adds settings despite the explicit boundary.", state: "diverged", conversation_event_ids: ["u7"], diff_citations: [citation(input.diff[5])], reviewer_action: "Remove the settings surface or obtain a scope change." }),
    fulfilled("operator-note", "Update the operator note.", "u8", input.diff[6], "supporting"),
    fulfilled("keyboard", "Keep keyboard access.", "u9", input.diff[7], "material", "human_boundary"),
    agreement({ key: "focused-test", statement: "The focused test run is not evidenced.", state: "unresolved", conversation_event_ids: ["u10"], reviewer_action: "Run and attach the focused test at this head." })
  ];
  const audit = groundAgreementAudit(input, {
    final_goal: { text: "Complete the ten-part job workflow change.", conversation_event_ids: ["u1", "u10"] },
    agreements: candidates,
    complete: true,
    limitations: []
  });
  assert.equal(audit.agreements.length, 10);
  const markdown = renderAgreementAuditMarkdown(audit);
  for (const candidate of candidates) assert.ok(markdown.includes(candidate.statement));
});

test("runtime parsing rejects malformed source hashes", () => {
  const input = readJson<Record<string, unknown>>(path.join(BENCH_ROOT, "cases", "clean-alignment.input.json"));
  const conversation = input.conversation as Record<string, unknown>;
  const sources = conversation.sources as Array<Record<string, unknown>>;
  sources[0].sha256 = "short";
  assert.throws(() => parseAgreementAuditInput(input), /full SHA-256/);
});

test("runtime parsing establishes one non-negative total conversation order", () => {
  const raw = readJson<Record<string, unknown>>(path.join(BENCH_ROOT, "cases", "clean-alignment.input.json"));
  const conversation = raw.conversation as Record<string, unknown>;
  const events = conversation.events as Array<Record<string, unknown>>;
  conversation.events = [...events].reverse();
  const parsed = parseAgreementAuditInput(raw);
  assert.deepEqual(parsed.conversation.events.map((event) => event.order), [0, 1, 2, 3, 4, 5]);

  const duplicate = readJson<Record<string, unknown>>(path.join(BENCH_ROOT, "cases", "clean-alignment.input.json"));
  const duplicateEvents = (duplicate.conversation as Record<string, unknown>).events as Array<Record<string, unknown>>;
  duplicateEvents[1].order = duplicateEvents[0].order;
  assert.throws(() => parseAgreementAuditInput(duplicate), /order values must be unique/);
});

test("a validation claim cannot cite a command from a stale head", () => {
  const input = loadInput("validation-contradiction");
  input.commands[0].head_sha = "cccccccccccccccccccccccccccccccccccccccc";
  const audit = groundAgreementAudit(input, parseAgreementAuditCandidate({
    final_goal: { text: "Fix and validate retry behavior without changing the queue, and document failure.", conversation_event_ids: ["u1", "u2", "u3"] },
    agreements: [agreement({
      key: "stale-test",
      kind: "validation_claim",
      statement: "The focused test claim is contradicted.",
      state: "diverged",
      conversation_event_ids: ["a1"],
      command_ids: ["retry-tests"],
      reviewer_action: "Run the test at the reviewed head."
    })],
    complete: true,
    limitations: []
  }));
  assert.equal(audit.status, "cannot_audit");
  assert.match(audit.rejections[0].reasons.join(" "), /not bound to the reviewed head/);
});

function fulfilled(
  key: string,
  statement: string,
  eventId: string,
  line: AgreementAuditInput["diff"][number],
  materiality: AgreementCandidate["materiality"] = "material",
  kind: AgreementCandidate["kind"] = "human_instruction"
): AgreementCandidate {
  return agreement({
    key,
    kind,
    statement,
    materiality,
    conversation_event_ids: [eventId],
    diff_citations: [citation(line)]
  });
}

function citation(line: AgreementAuditInput["diff"][number]): AgreementCandidate["diff_citations"][number] {
  return { path: line.path, side: line.side, line: line.line, contains: line.text };
}
