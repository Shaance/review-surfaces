import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CollectionResult } from "../src/collector/collect";
import { ConversationEvent } from "../src/conversation/events";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { IntentModel } from "../src/intent/intent";
import { MethodologyModel } from "../src/methodology/methodology";
import { ReasoningProvider, StructuredResult } from "../src/llm/provider";
import { runMethodologyReasoning } from "../src/llm/reasoning";
import { RisksModel } from "../src/risks/risks";
import { auditCacheDir, auditCacheKey, loadCachedAudit, storeCachedAudit } from "../src/llm/audit-cache";

const CACHE_ROOT = path.join(os.tmpdir(), "rs-audit-cache-test");

function freshCwd(name: string): string {
  const dir = path.join(CACHE_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// An ai-sdk-NAMED provider (so the cache is active) that counts its calls.
function countingAiSdk(data: unknown, ok = true): ReasoningProvider & { calls: number } {
  const provider = {
    name: "ai-sdk" as const,
    calls: 0,
    async generateStructured(stage: string): Promise<StructuredResult> {
      if (stage !== "methodology-audit") return { ok: false, reason: "n/a" };
      provider.calls += 1;
      return ok ? { ok: true, data } : { ok: false, reason: "privacy_block" };
    }
  };
  return provider;
}

function collection(cwd: string, events: ConversationEvent[], changed: string[] = ["src/uploader.ts"]): CollectionResult {
  return {
    cwd,
    outputDir: path.join(cwd, ".review-surfaces"),
    manifest: { tool_version: "0.1.0", repo: "fixture", base_ref: "HEAD", head_ref: "HEAD", head_sha: "abc", run_mode: "local", input_hashes: [] },
    specIndex: { schema_version: "review-surfaces.specs.index.v1", specs: [] },
    changedFiles: changed.map((p) => ({ path: p, status: "M", source: "working_tree" })),
    docs: [],
    tests: [],
    feedback: [],
    commandTranscripts: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    repositoryFiles: changed,
    repoIndex: { files: [], ecosystems: [], clusters: [] },
    privacy: { ignore_file: ".review-surfacesignore", ignore_patterns: [], ignored_changed_files: [], diff_redactions: [], remote_provider_blocked: false, secret_findings: [] },
    git: { repo: "fixture", base_ref: "HEAD", head_ref: "HEAD", head_sha: "abc" },
    conversationEvents: events
  } as unknown as CollectionResult;
}

function methodology(): MethodologyModel {
  return {
    summary: "m", missing_logs: false, considered: [], research: [], decisions: [], unchallenged_assumptions: [],
    skipped_checks: [], claims_without_evidence: [], verified_claims: [], quality_flags: ["methodology_analysis_degraded"], evidence: [], workflow_findings: []
  };
}
function intent(): IntentModel {
  return { summary: "i", spec_mode: "acai", requirements: [], constraints: [], non_goals: [], assumptions: [], open_questions: [], sources: [] };
}
function evaluation(): EvaluationModel {
  return { summary: "", results: [], overreach: [], acai_coverage: {} };
}
function risks(): RisksModel {
  return { summary: "", items: [], test_evidence: [], test_gaps: [], missing_automatic_tests: [], missing_manual_checks: [], review_focus: [] };
}

const EVENTS: ConversationEvent[] = [
  { id: "a1", actor: "assistant", kind: "message", summary: "considered backoff", raw_index: 0 },
  { id: "u1", actor: "user", kind: "message", summary: "add retry", raw_index: 1 }
];
const AUDIT = { considered: [{ text: "backoff vs fixed delay", anchors: { event_ids: ["a1"] } }] };

function run(cwd: string, provider: ReasoningProvider, m: MethodologyModel, model?: string): Promise<void> {
  return runMethodologyReasoning(provider, { collection: collection(cwd, EVENTS), intent: intent(), evaluation: evaluation(), methodology: m, risks: risks() }, { model });
}

test("issue #95: the cache module key is stable and store/load round-trips", () => {
  const cwd = freshCwd("unit");
  const dir = auditCacheDir(cwd);
  assert.equal(auditCacheKey(["ai-sdk", "m", "p"]), auditCacheKey(["ai-sdk", "m", "p"]));
  assert.notEqual(auditCacheKey(["ai-sdk", "m", "p"]), auditCacheKey(["ai-sdk", "m2", "p"]));
  assert.equal(loadCachedAudit(dir, "missing"), undefined);
  storeCachedAudit(dir, "k", { considered: ["x"] });
  assert.deepEqual(loadCachedAudit(dir, "k"), { ok: true, data: { considered: ["x"] } });
});

test("issue #95: a second ai-sdk run over the same conversation hits the cache (no new call, identical output)", async () => {
  const cwd = freshCwd("hit");
  const first = countingAiSdk(AUDIT);
  const m1 = methodology();
  await run(cwd, first, m1);
  assert.equal(first.calls, 1, "first run issues the audit call");
  assert.ok(m1.considered.some((c) => c.includes("backoff vs fixed delay")));

  const second = countingAiSdk(AUDIT);
  const m2 = methodology();
  await run(cwd, second, m2);
  assert.equal(second.calls, 0, "second run reuses the cached audit — no provider call");
  assert.deepEqual(m2.workflow_findings, m1.workflow_findings);
  assert.deepEqual(m2.considered, m1.considered);
});

test("issue #95: a model change busts the cache", async () => {
  const cwd = freshCwd("model");
  const a = countingAiSdk(AUDIT);
  await run(cwd, a, methodology(), "anthropic:claude-x");
  assert.equal(a.calls, 1);
  const b = countingAiSdk(AUDIT);
  await run(cwd, b, methodology(), "openai:gpt-x");
  assert.equal(b.calls, 1, "a different model is a cache miss and re-issues the call");
});

test("issue #95: a non-ok ai-sdk response is NOT cached", async () => {
  const cwd = freshCwd("notok");
  const blocked = countingAiSdk(AUDIT, false);
  await run(cwd, blocked, methodology());
  assert.equal(blocked.calls, 1);
  // No cache file written -> a later ok run still calls the provider.
  const ok = countingAiSdk(AUDIT, true);
  await run(cwd, ok, methodology());
  assert.equal(ok.calls, 1, "a privacy-blocked response must not be cached");
});

test("issue #95: the cache persists only the response, never transcript/prompt content (no secret leak)", async () => {
  const cwd = freshCwd("redact");
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const events: ConversationEvent[] = [
    { id: "s1", actor: "tool", kind: "tool_result", summary: `output ${secret}`, raw_index: 0 },
    { id: "u1", actor: "user", kind: "message", summary: "go", raw_index: 1 }
  ];
  const provider = countingAiSdk(AUDIT);
  await runMethodologyReasoning(provider, { collection: collection(cwd, events), intent: intent(), evaluation: evaluation(), methodology: methodology(), risks: risks() }, {});
  const dir = auditCacheDir(cwd);
  const files = fs.readdirSync(dir);
  assert.ok(files.length >= 1, "an ai-sdk run writes a cache entry");
  for (const file of files) {
    const body = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(!body.includes(secret), "the cached response must not contain transcript secret material");
    assert.ok(!file.includes(secret), "the cache key is a hash and never embeds transcript content");
  }
});

test("issue #95: agent-file (file-driven, not prompt-driven) does NOT use the audit cache", async () => {
  const cwd = freshCwd("agentfile");
  const provider: ReasoningProvider = {
    name: "agent-file",
    async generateStructured(): Promise<StructuredResult> {
      return { ok: true, data: AUDIT };
    }
  };
  await run(cwd, provider, methodology());
  assert.ok(!fs.existsSync(auditCacheDir(cwd)), "agent-file must not populate the ai-sdk audit cache");
});
