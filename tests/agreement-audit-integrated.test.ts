import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireAgreementAuditRunLock } from "../src/audit/artifacts";
import { integratedAgreementAuditExitCode, runIntegratedAgreementAudit } from "../src/audit/integrated-run";
import { ExitCodes } from "../src/core/exit-codes";
import type { CollectionResult } from "../src/collector/collect";
import type { ReasoningProvider } from "../src/contracts/provider";

test("review-surfaces audit collects, verifies, and renders a clean result in one command", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agreement-audit-integrated-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  try {
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "audit@example.com"]);
    git(repo, ["config", "user.name", "Audit Test"]);
    git(repo, ["remote", "add", "origin", "https://github.com/example/sample.git"]);
    fs.writeFileSync(path.join(repo, "greeting.ts"), "export const greeting = 'hello';\n");
    fs.writeFileSync(path.join(repo, "old-name.ts"), "export const legacy = true;\nexport const retained = true;\n");
    git(repo, ["add", "greeting.ts", "old-name.ts"]);
    git(repo, ["commit", "-m", "base"]);
    fs.writeFileSync(path.join(repo, "greeting.ts"), "export const greeting = 'hello world';\n");
    git(repo, ["mv", "old-name.ts", "new-name.ts"]);
    fs.writeFileSync(path.join(repo, "new-name.ts"), "export const legacy = false;\nexport const retained = true;\n");
    git(repo, ["add", "greeting.ts", "new-name.ts"]);
    git(repo, ["commit", "-m", "update greeting"]);

    const conversationPath = path.join(root, "conversation.jsonl");
    fs.writeFileSync(conversationPath, [
      JSON.stringify({ id: "u1", actor: "user", kind: "message", summary: "Change the greeting to hello world." }),
      JSON.stringify({ id: "t1", actor: "tool", kind: "tool_result", summary: "" }),
      JSON.stringify({ id: "a1", actor: "assistant", kind: "message", summary: "I will change the greeting to hello world." })
    ].join("\n") + "\n");
    const additionalConversationPath = path.join(root, "later-conversation.jsonl");
    fs.writeFileSync(additionalConversationPath, [
      JSON.stringify({ id: "u2", actor: "user", kind: "message", summary: "Rename old-name.ts and disable the legacy flag." }),
      JSON.stringify({ id: "a2", actor: "assistant", kind: "message", summary: "I will rename the file and disable its legacy flag." })
    ].join("\n") + "\n");
    const agentPath = path.join(root, "agent.json");
    fs.writeFileSync(agentPath, JSON.stringify({
      stages: {
        "agreement-audit": {
          final_goal: {
            text: "Change the greeting, then rename the legacy file and disable its flag.",
            conversation_event_ids: ["u1", "conversation-2:u2"]
          },
          agreements: [
            {
              key: "change-greeting", kind: "human_instruction", statement: "Change the greeting to hello world.",
              state: "fulfilled", materiality: "material", conversation_event_ids: ["u1"],
              diff_citations: [{ path: "greeting.ts", side: "add", line: 1, contains: "hello world" }], command_ids: []
            },
            {
              key: "change-greeting-commitment", kind: "agent_commitment", statement: "The agent committed to changing the greeting.",
              state: "fulfilled", materiality: "material", conversation_event_ids: ["a1"],
              diff_citations: [{ path: "greeting.ts", side: "add", line: 1, contains: "hello world" }], command_ids: []
            },
            {
              key: "rename-legacy", kind: "human_instruction", statement: "Rename the file and disable its legacy flag.",
              state: "fulfilled", materiality: "material", conversation_event_ids: ["conversation-2:u2"],
              diff_citations: [
                { path: "old-name.ts", side: "delete", line: 1, contains: "legacy = true" },
                { path: "new-name.ts", side: "add", line: 1, contains: "legacy = false" }
              ], command_ids: []
            },
            {
              key: "rename-legacy-commitment", kind: "agent_commitment", statement: "The agent committed to renaming the file and disabling its legacy flag.",
              state: "fulfilled", materiality: "material", conversation_event_ids: ["conversation-2:a2"],
              diff_citations: [
                { path: "old-name.ts", side: "delete", line: 1, contains: "legacy = true" },
                { path: "new-name.ts", side: "add", line: 1, contains: "legacy = false" }
              ], command_ids: []
            }
          ],
          complete: true,
          limitations: []
        },
        "agreement-completeness": {
          complete: true,
          dispositions: [
            { event_id: "u1", disposition: "represented", agreement_keys: ["change-greeting"] },
            { event_id: "a1", disposition: "represented", agreement_keys: ["change-greeting-commitment"] },
            { event_id: "conversation-2:u2", disposition: "represented", agreement_keys: ["rename-legacy"] },
            { event_id: "conversation-2:a2", disposition: "represented", agreement_keys: ["rename-legacy-commitment"] }
          ],
          missing_agreements: [],
          limitations: []
        }
      }
    }));

    const cli = path.join(process.cwd(), "bin", "review-surfaces.js");
    const completeOut = path.join(root, "audit-complete");
    const partialOut = path.join(root, "audit-partial");
    const preflightOut = path.join(root, "audit-preflight");
    const conversationPreflightOut = path.join(root, "audit-conversation-preflight");
    const missingConversationOut = path.join(root, "audit-missing-conversation");
    const emptyConversationOut = path.join(root, "audit-empty-conversation");
    const privacyBlockedOut = path.join(root, "audit-privacy-blocked");
    const secretMissingConversationOut = path.join(root, "audit-secret-missing-conversation");
    const auditArgs = [
      cli, "audit", "--base", "HEAD~1", "--head", "HEAD",
      "--provider", "agent-file", "--agent-input", agentPath,
      "--conversation", conversationPath, "--conversation-format", "normalized",
      "--additional-conversations", additionalConversationPath
    ];
    const symlinkTarget = path.join(root, "symlink-target");
    const symlinkOut = path.join(root, "symlink-out");
    fs.mkdirSync(symlinkTarget);
    fs.symlinkSync(symlinkTarget, symlinkOut, "dir");
    const symlinkResult = spawnSync(process.execPath, [
      ...auditArgs, "--conversation-scope", "complete", "--out", symlinkOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(symlinkResult.status, 1);
    assert.match(symlinkResult.stderr, /--out must name a real directory/);
    assert.deepEqual(fs.readdirSync(symlinkTarget), []);

    const releaseAuditLock = acquireAgreementAuditRunLock(completeOut);
    const lockedResult = spawnSync(process.execPath, [
      ...auditArgs, "--conversation-scope", "complete", "--out", completeOut
    ], { cwd: repo, encoding: "utf8" });
    releaseAuditLock();
    assert.equal(lockedResult.status, 1);
    assert.match(lockedResult.stderr, /already writing this output directory/);
    assert.equal(fs.existsSync(path.join(completeOut, "agreement-audit-input.json")), false);

    const malformedPrevious = path.join(root, "malformed-previous.json");
    fs.writeFileSync(malformedPrevious, JSON.stringify({ head_sha: "a".repeat(40), agreements: [] }));
    const previousPreflight = spawnSync(process.execPath, [
      ...auditArgs,
      "--conversation-scope", "complete",
      "--previous-audit", malformedPrevious,
      "--out", preflightOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(previousPreflight.status, 1);
    assert.equal(fs.existsSync(preflightOut), false);

    const conversationPreflight = spawnSync(process.execPath, [
      cli, "audit", "--base", "HEAD~1", "--head", "HEAD",
      "--provider", "agent-file", "--agent-input", agentPath,
      "--conversation", path.join(root, "missing-conversation.jsonl"),
      "--conversation-format", "normalized",
      "--out", conversationPreflightOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(conversationPreflight.status, 1);
    assert.match(conversationPreflight.stderr, /conversation was unreadable or unmatched/);
    assert.equal(fs.existsSync(conversationPreflightOut), false);

    const missingConversation = spawnSync(process.execPath, [
      cli, "audit", "--base", "HEAD~1", "--head", "HEAD",
      "--provider", "agent-file", "--agent-input", agentPath,
      "--no-conversation-discovery", "--out", missingConversationOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(missingConversation.status, 4, missingConversation.stderr);
    const missingAudit = JSON.parse(
      fs.readFileSync(path.join(missingConversationOut, "audit.json"), "utf8")
    ) as { status: string; conversation: { status: string }; limitations: string[] };
    assert.equal(missingAudit.status, "cannot_audit");
    assert.equal(missingAudit.conversation.status, "missing");
    assert.ok(missingAudit.limitations.some((limitation) => /No auditable conversation was collected/.test(limitation)));
    assert.match(fs.readFileSync(path.join(missingConversationOut, "audit.md"), "utf8"), /## Audit incomplete/);

    const emptyConversationPath = path.join(root, "empty-conversation.yaml");
    fs.writeFileSync(emptyConversationPath, "events: []\n");
    const emptyConversation = spawnSync(process.execPath, [
      cli, "audit", "--base", "HEAD~1", "--head", "HEAD",
      "--provider", "agent-file", "--agent-input", agentPath,
      "--conversation", emptyConversationPath, "--conversation-format", "normalized",
      "--out", emptyConversationOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(emptyConversation.status, 4, emptyConversation.stderr);
    const emptyAudit = JSON.parse(
      fs.readFileSync(path.join(emptyConversationOut, "audit.json"), "utf8")
    ) as { status: string; limitations: string[] };
    assert.equal(emptyAudit.status, "cannot_audit");
    assert.ok(emptyAudit.limitations.some((limitation) => /No auditable conversation was collected/.test(limitation)));
    assert.match(fs.readFileSync(path.join(emptyConversationOut, "audit.md"), "utf8"), /## Audit incomplete/);

    const initialResult = spawnSync(process.execPath, [
      ...auditArgs, "--conversation-scope", "complete", "--out", completeOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(initialResult.status, 4, initialResult.stderr);
    const initialAudit = JSON.parse(fs.readFileSync(path.join(completeOut, "audit.json"), "utf8")) as {
      status: string;
      completeness: { structurally_verified: boolean; operator_confirmed: boolean; confirmation_token?: string };
    };
    assert.equal(initialAudit.status, "cannot_audit");
    assert.equal(initialAudit.completeness.structurally_verified, true);
    assert.equal(initialAudit.completeness.operator_confirmed, false);
    assert.ok(initialAudit.completeness.confirmation_token);

    const originalAgentText = fs.readFileSync(agentPath, "utf8");
    fs.writeFileSync(agentPath, JSON.stringify({ stages: {} }));
    fs.appendFileSync(path.join(completeOut, "agreement-audit-candidate.json"), " ");
    const tamperedConfirmation = spawnSync(process.execPath, [
      ...auditArgs,
      "--conversation-scope", "complete",
      "--confirm-extraction", initialAudit.completeness.confirmation_token!,
      "--out", completeOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(tamperedConfirmation.status, 4, tamperedConfirmation.stderr);
    const tamperedAudit = JSON.parse(fs.readFileSync(path.join(completeOut, "audit.json"), "utf8")) as {
      completeness: { operator_confirmed: boolean; confirmation_token?: string };
    };
    assert.equal(tamperedAudit.completeness.operator_confirmed, false);
    assert.ok(tamperedAudit.completeness.confirmation_token);
    assert.notEqual(tamperedAudit.completeness.confirmation_token, initialAudit.completeness.confirmation_token);
    assert.match(
      fs.readFileSync(path.join(completeOut, "agreement-audit-candidate.json"), "utf8"),
      / $/
    );

    const result = spawnSync(process.execPath, [
      ...auditArgs,
      "--conversation-scope", "complete",
      "--confirm-extraction", tamperedAudit.completeness.confirmation_token!,
      "--out", completeOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Agreement audit:/);
    fs.writeFileSync(agentPath, originalAgentText);
    const audit = JSON.parse(fs.readFileSync(path.join(completeOut, "audit.json"), "utf8")) as {
      status: string; completeness: { verified: boolean; structurally_verified: boolean; operator_confirmed: boolean }; base_sha: string; head_sha: string;
      conversation: { caveat?: string; sources: unknown[] };
      agreements: Array<{
        key: string;
        conversation_evidence: Array<{ context: Array<{ id: string; source_id: string }> }>;
      }>;
    };
    assert.equal(audit.status, "no_mismatch_found");
    assert.equal(audit.completeness.verified, true);
    assert.equal(audit.completeness.structurally_verified, true);
    assert.equal(audit.completeness.operator_confirmed, true);
    assert.equal(audit.base_sha.length, 40);
    assert.equal(audit.head_sha.length, 40);
    assert.equal(audit.conversation.sources.length, 2);
    const laterEvidence = audit.agreements.find((agreement) => agreement.key === "rename-legacy")!
      .conversation_evidence[0];
    assert.deepEqual(laterEvidence.context.map((context) => context.id), ["conversation-2:a2"]);
    assert.ok(laterEvidence.context.every((context) => context.source_id === "conversation-2"));
    assert.match(audit.conversation.caveat ?? "", /operator asserted/i);
    const markdown = fs.readFileSync(path.join(completeOut, "audit.md"), "utf8");
    assert.match(markdown, /No agreement mismatch found/);
    assert.match(markdown, /github\.com\/example\/sample\/blob\/[a-f0-9]{40}\/greeting\.ts#L1/);
    assert.match(markdown, new RegExp(`github\\.com/example/sample/blob/${audit.base_sha}/old-name\\.ts#L1`));
    assert.match(markdown, new RegExp(`github\\.com/example/sample/blob/${audit.head_sha}/new-name\\.ts#L1`));
    assert.ok(fs.existsSync(path.join(completeOut, "agreement-audit-input.json")));
    assert.ok(fs.existsSync(path.join(completeOut, "agreement-audit-candidate.json")));
    assert.ok(fs.existsSync(path.join(completeOut, "agreement-audit-completeness.json")));

    const priorPublishedJson = fs.readFileSync(path.join(completeOut, "audit.json"), "utf8");
    const priorPublishedMarkdown = fs.readFileSync(path.join(completeOut, "audit.md"), "utf8");
    fs.rmSync(path.join(completeOut, "audit.md"));
    fs.mkdirSync(path.join(completeOut, "audit.md"));
    const failedPublish = spawnSync(process.execPath, [
      ...auditArgs, "--conversation-scope", "complete", "--out", completeOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(failedPublish.status, 1);
    assert.match(failedPublish.stderr, /refusing to replace non-file artifact audit\.md/);
    assert.equal(fs.readFileSync(path.join(completeOut, "audit.json"), "utf8"), priorPublishedJson);
    fs.rmSync(path.join(completeOut, "audit.md"), { recursive: true });
    fs.writeFileSync(path.join(completeOut, "audit.md"), priorPublishedMarkdown);

    const confirmedCompleteness = fs.readFileSync(
      path.join(completeOut, "agreement-audit-completeness.json"),
      "utf8"
    );
    fs.writeFileSync(path.join(completeOut, "agreement-audit-completeness.json"), "{not-json\n");
    const corruptConfirmation = spawnSync(process.execPath, [
      ...auditArgs,
      "--conversation-scope", "complete",
      "--confirm-extraction", initialAudit.completeness.confirmation_token!,
      "--out", completeOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(corruptConfirmation.status, 1);
    assert.equal(fs.existsSync(path.join(completeOut, "audit.json")), false);
    assert.equal(fs.existsSync(path.join(completeOut, "audit.md")), false);
    fs.writeFileSync(path.join(completeOut, "agreement-audit-completeness.json"), confirmedCompleteness);
    const restoredConfirmation = spawnSync(process.execPath, [
      ...auditArgs,
      "--conversation-scope", "complete",
      "--confirm-extraction", initialAudit.completeness.confirmation_token!,
      "--out", completeOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(restoredConfirmation.status, 0, restoredConfirmation.stderr);

    const partialResult = spawnSync(process.execPath, [
      ...auditArgs, "--out", partialOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(partialResult.status, 4, partialResult.stderr);
    const partialAudit = JSON.parse(
      fs.readFileSync(path.join(partialOut, "audit.json"), "utf8")
    ) as { status: string; conversation: { caveat?: string } };
    assert.equal(partialAudit.status, "cannot_audit");
    assert.match(partialAudit.conversation.caveat ?? "", /not asserted complete/i);

    const malformedAgent = JSON.parse(fs.readFileSync(agentPath, "utf8")) as {
      stages: Record<string, unknown>;
    };
    malformedAgent.stages["agreement-completeness"] = { complete: true };
    fs.writeFileSync(agentPath, JSON.stringify(malformedAgent));
    const malformedResult = spawnSync(process.execPath, [
      ...auditArgs, "--conversation-scope", "complete", "--out", completeOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(malformedResult.status, 4, malformedResult.stderr);
    const malformedAudit = JSON.parse(
      fs.readFileSync(path.join(completeOut, "audit.json"), "utf8")
    ) as { status: string; limitations: string[] };
    assert.equal(malformedAudit.status, "cannot_audit");
    assert.ok(malformedAudit.limitations.some((limitation) => /completeness pass returned invalid output/i.test(limitation)));
    assert.equal(fs.existsSync(path.join(completeOut, "agreement-audit-completeness.json")), false);

    malformedAgent.stages["agreement-audit"] = { complete: true };
    fs.writeFileSync(agentPath, JSON.stringify(malformedAgent));
    const failedExtraction = spawnSync(process.execPath, [
      ...auditArgs, "--conversation-scope", "complete", "--out", completeOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(failedExtraction.status, 1);
    assert.ok(fs.existsSync(path.join(completeOut, "agreement-audit-input.json")));
    assert.equal(fs.existsSync(path.join(completeOut, "agreement-audit-candidate.json")), false);
    assert.equal(fs.existsSync(path.join(completeOut, "audit.json")), false);

    fs.writeFileSync(
      path.join(repo, "greeting.ts"),
      `export const token = "ghp_${"a".repeat(36)}";\n`
    );
    git(repo, ["add", "greeting.ts"]);
    git(repo, ["commit", "-m", "add blocked fixture"]);
    const privacyBlocked = spawnSync(process.execPath, [
      cli, "audit", "--base", "HEAD~1", "--head", "HEAD",
      "--provider", "ai-sdk",
      "--conversation", conversationPath, "--conversation-format", "normalized",
      "--conversation-scope", "complete", "--out", privacyBlockedOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(privacyBlocked.status, 5, privacyBlocked.stderr);
    const privacyAudit = JSON.parse(
      fs.readFileSync(path.join(privacyBlockedOut, "audit.json"), "utf8")
    ) as { status: string; limitations: string[] };
    assert.equal(privacyAudit.status, "cannot_audit");
    assert.ok(privacyAudit.limitations.some((limitation) => /blocked.*high-risk secret material/i.test(limitation)));
    assert.match(fs.readFileSync(path.join(privacyBlockedOut, "audit.md"), "utf8"), /## Audit incomplete/);

    const secretMissingConversation = spawnSync(process.execPath, [
      cli, "audit", "--base", "HEAD~1", "--head", "HEAD",
      "--provider", "ai-sdk", "--no-conversation-discovery",
      "--out", secretMissingConversationOut
    ], { cwd: repo, encoding: "utf8" });
    assert.equal(secretMissingConversation.status, 4, secretMissingConversation.stderr);
    const secretMissingAudit = JSON.parse(
      fs.readFileSync(path.join(secretMissingConversationOut, "audit.json"), "utf8")
    ) as { status: string; limitations: string[] };
    assert.equal(secretMissingAudit.status, "cannot_audit");
    assert.ok(secretMissingAudit.limitations.some((limitation) => /No auditable conversation was collected/.test(limitation)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("integrated agreement audit respects provider privacy boundaries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agreement-audit-provider-privacy-"));
  try {
    for (const scenario of ["offline", "prompt", "provider"] as const) {
      const outputDir = path.join(root, scenario);
      fs.mkdirSync(outputDir);
      const secret = `ghp_${"a".repeat(36)}`;
      const secretStatement = `Implement the change without exposing ${secret}.`;
      const statement = scenario === "provider" ? "Implement the reviewed change." : secretStatement;
      const prompts: string[] = [];
      const provider: ReasoningProvider = {
        name: scenario === "offline" ? "agent-file" : "ai-sdk",
        async generateStructured(stage, prompt) {
          prompts.push(prompt);
          if (stage === "agreement-audit") {
            return {
              ok: true,
              data: {
                final_goal: { text: statement, conversation_event_ids: ["u1"] },
                agreements: [{
                  key: "change",
                  kind: "human_instruction",
                  statement,
                  state: scenario === "provider" ? "diverged" : "fulfilled",
                  materiality: "material",
                  conversation_event_ids: ["u1"],
                  diff_citations: [{ path: "file.ts", side: "add", line: 1, contains: "new" }],
                  command_ids: [],
                  ...(scenario === "provider" ? { reviewer_action: "Decide whether to accept the divergence." } : {})
                }],
                complete: true,
                limitations: []
              }
            };
          }
          if (scenario === "offline") {
            return {
              ok: true,
              data: {
                complete: true,
                dispositions: [{
                  event_id: "u1",
                  disposition: "represented",
                  agreement_keys: ["change"]
                }],
                missing_agreements: [],
                limitations: []
              }
            };
          }
          return { ok: false, reason: "privacy_block" };
        }
      };
      const collection = minimalAuditCollection(outputDir);
      if (scenario === "offline") {
        collection.conversationSources![0].events[0].summary = secretStatement;
      }
      const result = await runIntegratedAgreementAudit({
        collection,
        provider,
        explicitConversationScope: "complete"
      });
      if (scenario === "offline") {
        assert.deepEqual(prompts, ["", ""]);
        assert.equal(result.privacyBlocked, false);
        assert.equal(result.audit.completeness.structurally_verified, true);
        assert.ok(result.audit.completeness.confirmation_token);
        assert.ok(result.audit.limitations.every((limitation) => !/blocked.*secret material/i.test(limitation)));
        continue;
      }
      assert.equal(result.audit.status, scenario === "provider" ? "needs_human_decision" : "cannot_audit");
      assert.equal(result.privacyBlocked, true);
      assert.equal(integratedAgreementAuditExitCode(result), ExitCodes.privacyBlocked);
      assert.ok(result.audit.limitations.some((limitation) => /completeness pass was blocked/i.test(limitation)));
      assert.equal(prompts.length, scenario === "prompt" ? 1 : 2);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function minimalAuditCollection(outputDir: string): CollectionResult {
  return {
    cwd: process.cwd(),
    outputDir,
    diff_source: "range",
    mergeBaseSha: "b".repeat(40),
    reviewedDiff: [
      "diff --git a/file.ts b/file.ts",
      "index 1111111..2222222 100644",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      ""
    ].join("\n"),
    git: { repo: "example/repo" },
    manifest: { head_sha: "a".repeat(40), uncommitted_files: 0 },
    privacy: { remote_provider_blocked: false },
    commandTranscripts: [],
    conversationSources: [{
      id: "conversation-1",
      sha256: "c".repeat(64),
      selection: "explicit",
      adapter: "normalized",
      events: [{ id: "u1", actor: "user", kind: "message", summary: "Implement the reviewed change." }]
    }]
  } as unknown as CollectionResult;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
