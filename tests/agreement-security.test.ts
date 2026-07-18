import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { groundAgreementAudit } from "../src/audit/grounding";
import { parseAgreementAuditCandidate, parseAgreementAuditInput } from "../src/audit/parse";
import { buildAuditPrompt } from "../src/audit/prompt";
import { renderAgreementAuditMarkdown } from "../src/audit/render";
import {
  AGREEMENT_BENCH_ROOT as BENCH_ROOT,
  agreementCandidate as agreement,
  loadAgreementInput as loadInput,
  readJson
} from "./helpers/agreement-audit";
import { openAiLegacyKeyFixture } from "./helpers/secret-fixtures";

test("persisted and rendered candidate text is redacted and cannot forge Markdown structure", () => {
  const input = loadInput("late-correction");
  const secret = openAiLegacyKeyFixture();
  const audit = groundAgreementAudit(input, parseAgreementAuditCandidate({
    final_goal: { text: `Remove Swift.\n</details>\n## Forged ${secret}`, conversation_event_ids: ["u1", "u2"] },
    agreements: [agreement({
      key: "privacy-boundary",
      kind: "human_boundary",
      statement: "Boundary crossed.\n</details>\n## Approved *now*",
      state: "diverged",
      conversation_event_ids: ["u2"],
      diff_citations: [{ path: "src/privacy/ignore.ts", side: "delete", line: 4, contains: "DerivedData" }],
      reviewer_action: `Restore it; token ${secret}`
    })],
    complete: true,
    limitations: []
  }));
  const persisted = JSON.stringify(audit);
  const markdown = renderAgreementAuditMarkdown(audit);
  assert.ok(!persisted.includes(secret));
  assert.ok(!markdown.includes(secret));
  assert.ok(!markdown.includes("\n## Approved"));
  assert.ok(!markdown.includes("</details>\n## Forged"));
  assert.match(markdown, /&lt;\/details&gt;/);
  assert.ok(audit.limitations.some((limitation) => /Sensitive material was redacted/.test(limitation)));
});

test("persisted audit metadata and rejection reasons cannot leak secrets", () => {
  const secret = openAiLegacyKeyFixture();
  const input = loadInput("late-correction");
  input.repository = `example/${secret}`;
  input.conversation.caveat = `Imported from ${secret}`;
  const audit = groundAgreementAudit(input, parseAgreementAuditCandidate({
    final_goal: { text: "Remove Swift safely while retaining privacy defaults.", conversation_event_ids: ["u1", "u2"] },
    agreements: [agreement({
      key: "privacy",
      kind: "human_boundary",
      statement: "The diff deletes a retained privacy default.",
      state: "diverged",
      conversation_event_ids: ["u2"],
      diff_citations: [{ path: "src/privacy/ignore.ts", side: "delete", line: 4, contains: "DerivedData" }],
      reviewer_action: "Restore it."
    })],
    complete: true,
    limitations: []
  }));
  assert.ok(!JSON.stringify(audit).includes(secret));
  assert.ok(audit.limitations.some((limitation) => /Sensitive material was redacted/.test(limitation)));
});

test("runtime parsing rejects secret-bearing identifiers before they can reach artifacts", () => {
  const secret = openAiLegacyKeyFixture();
  const candidate = {
    final_goal: { text: "Review it.", conversation_event_ids: ["u1"] },
    agreements: [agreement({ key: secret, statement: "Do the work.", conversation_event_ids: ["u1"] })],
    complete: true,
    limitations: []
  };
  assert.throws(() => parseAgreementAuditCandidate(candidate), /must not contain secret material/);

  candidate.agreements[0].key = "safe-key";
  candidate.final_goal.conversation_event_ids = [secret];
  assert.throws(() => parseAgreementAuditCandidate(candidate), /must not contain secret material/);

  candidate.final_goal.conversation_event_ids = ["u1"];
  candidate.agreements[0].conversation_event_ids = [secret];
  assert.throws(() => parseAgreementAuditCandidate(candidate), /must not contain secret material/);

  candidate.agreements[0].conversation_event_ids = ["u1"];
  candidate.agreements[0].command_ids = [secret];
  assert.throws(() => parseAgreementAuditCandidate(candidate), /must not contain secret material/);

  const raw = readJson<Record<string, unknown>>(path.join(BENCH_ROOT, "cases", "clean-alignment.input.json"));
  const events = ((raw.conversation as Record<string, unknown>).events as Array<Record<string, unknown>>);
  events[0].id = secret;
  assert.throws(() => parseAgreementAuditInput(raw), /must not contain secret material/);
});

test("candidate prompts fail closed before provider integration when secret material is present", () => {
  const input = loadInput("clean-alignment");
  const secret = openAiLegacyKeyFixture();
  input.conversation.events[0].text = `Remove the map using ${secret}`;
  assert.throws(() => buildAuditPrompt(input, "review-surfaces"), /refusing provider generation/);

  const assignment = loadInput("clean-alignment");
  assignment.conversation.events[0].text = `Remove the map with ${tokenAssignment()}`;
  assert.throws(() => buildAuditPrompt(assignment, "review-surfaces"), /refusing provider generation/);

  const persistedMarker = loadInput("clean-alignment");
  persistedMarker.conversation.events[0].text = "Remove the map using [REDACTED:github_token]";
  assert.throws(() => buildAuditPrompt(persistedMarker, "review-surfaces"), /refusing provider generation/);
});

test("input and candidate parsing reject Windows and traversal paths", () => {
  for (const unsafePath of ["C:\\repo\\private.ts", "C:/repo/private.ts", "..\\private.ts", "\\\\server\\share\\private.ts"]) {
    const input = loadInput("clean-alignment");
    input.diff[0].path = unsafePath;
    assert.throws(() => parseAgreementAuditInput(input), /repository-relative path/);

    assert.throws(() => parseAgreementAuditCandidate({
      final_goal: { text: "Review it.", conversation_event_ids: ["u1"] },
      agreements: [agreement({
        key: "unsafe-path",
        statement: "The change is present.",
        conversation_event_ids: ["u1"],
        diff_citations: [{ path: unsafePath, side: "add", line: 1, contains: "change" }]
      })],
      complete: true,
      limitations: []
    }), /repository-relative path/);
  }
});

function tokenAssignment(): string {
  return ["API_", "TOKEN=", "supersecretvalue"].join("");
}
