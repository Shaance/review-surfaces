import test from "node:test";
import assert from "node:assert/strict";
import { CollectionResult } from "../src/collector/collect";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { IntentModel } from "../src/intent/intent";
import { ReasoningProvider, StructuredResult } from "../src/llm/provider";
import { assemblePrReviewSurface } from "../src/pipeline/pr-surface";
import { ReviewArea } from "../src/review-areas/areas";
import { StructuredDiff } from "../src/pr/contract";

const AREAS: ReviewArea[] = [
  {
    id: "SUB-FOO",
    name: "Foo",
    groupKey: "FOO",
    prefixes: ["src/foo/"],
    purpose: "Foo implementation.",
    pattern: "foo",
    testKeywords: ["foo"]
  }
];

const PROVIDER: ReasoningProvider = {
  name: "mock",
  async generateStructured(): Promise<StructuredResult> {
    return {
      ok: true,
      data: {
        summary: "src/foo/widget.ts changed.",
        what_changed: [{ text: "src/foo/widget.ts changed.", paths: ["src/foo/widget.ts"] }],
        why_it_matters: [{ text: "Review src/foo/widget.ts.", paths: ["src/foo/widget.ts"] }],
        review_first: [{ text: "Review src/foo/widget.ts first.", paths: ["src/foo/widget.ts"] }],
        risk_narratives: []
      }
    };
  }
};

function collection(overrides: Partial<CollectionResult> = {}): CollectionResult {
  return {
    cwd: process.cwd(),
    outputDir: ".review-surfaces",
    manifest: { tool_version: "0.1.0", repo: "fixture", base_ref: "main", head_ref: "feature", head_sha: "head", run_mode: "local", input_hashes: [] },
    specIndex: { schema_version: "review-surfaces.specs.index.v1", specs: [] },
    changedFiles: [{ path: "src/foo/widget.ts", status: "M", source: "diff" }],
    docs: [],
    tests: [],
    feedback: [],
    commandTranscripts: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    repositoryFiles: [],
    repoIndex: { files: [], ecosystems: [], clusters: [] },
    privacy: { ignore_file: ".review-surfacesignore", ignore_patterns: [], ignored_changed_files: [], diff_redactions: [], remote_provider_blocked: false, secret_findings: [] },
    git: { repo: "fixture", base_ref: "main", head_ref: "feature", head_sha: "head" },
    conversationEvents: [],
    ...overrides
  } as unknown as CollectionResult;
}

const INTENT: IntentModel = {
  summary: "fixture",
  spec_mode: "acai",
  requirements: [],
  constraints: [],
  non_goals: [],
  assumptions: [],
  open_questions: [],
  sources: []
};

const EVALUATION: EvaluationModel = { summary: "fixture", results: [], overreach: [], acai_coverage: {} };

const DIFF: StructuredDiff = {
  files: [
    {
      path: "src/foo/widget.ts",
      status: "M",
      hunks: [
        {
          old_start: 1,
          old_lines: 1,
          new_start: 1,
          new_lines: 1,
          lines: [{ kind: "add", text: "export const widget = true;", new_line: 1 }]
        }
      ]
    }
  ]
};

async function surface(input: Partial<CollectionResult>) {
  return assemblePrReviewSurface({
    collection: collection(input),
    intent: INTENT,
    evaluation: EVALUATION,
    reviewAreas: AREAS,
    provider: PROVIDER,
    providerName: "mock",
    redactSecrets: true,
    diff: DIFF
  });
}

test("PR surface existing-test guidance ignores non-executable test artifacts", async () => {
  const model = await surface({ repositoryFiles: ["tests/foo.snap"] } as unknown as Partial<CollectionResult>);
  const risk = model.risks.candidates.find((candidate) => candidate.rule === "untested_changed_impl");

  assert.ok(risk);
  assert.match(risk.summary, /no test mapped to FOO/);
  assert.ok(risk.suggested_checks.some((check) => /Add a test covering/.test(check)));
  assert.equal(risk.suggested_checks.some((check) => /Run the existing test/.test(check)), false);
});

test("PR surface existing-test guidance honors configured, named, and directory-based tests", async () => {
  const configured = await surface({ tests: [{ path: "spec/foo.test.ts" }], repositoryFiles: [] } as unknown as Partial<CollectionResult>);
  const configuredRisk = configured.risks.candidates.find((candidate) => candidate.rule === "untested_changed_impl");
  assert.ok(configuredRisk);
  assert.match(configuredRisk.summary, /test is mapped to FOO/);
  assert.ok(configuredRisk.suggested_checks.some((check) => /Run the existing test/.test(check)));

  const recognized = await surface({ repositoryFiles: ["test_foo.py"] } as unknown as Partial<CollectionResult>);
  const recognizedRisk = recognized.risks.candidates.find((candidate) => candidate.rule === "untested_changed_impl");
  assert.ok(recognizedRisk);
  assert.match(recognizedRisk.summary, /test is mapped to FOO/);

  const testsDirectory = await surface({ repositoryFiles: ["tests/foo.ts"] } as unknown as Partial<CollectionResult>);
  const testsDirectoryRisk = testsDirectory.risks.candidates.find((candidate) => candidate.rule === "untested_changed_impl");
  assert.ok(testsDirectoryRisk);
  assert.match(testsDirectoryRisk.summary, /test is mapped to FOO/);

  const testDirectory = await surface({ repositoryFiles: ["test/foo.js"] } as unknown as Partial<CollectionResult>);
  const testDirectoryRisk = testDirectory.risks.candidates.find((candidate) => candidate.rule === "untested_changed_impl");
  assert.ok(testDirectoryRisk);
  assert.match(testDirectoryRisk.summary, /test is mapped to FOO/);
});

test("review-surfaces.CONVERSATION_REVIEW.4 PR assembly protects the postability-critical narrative call, then persists conversation review", async () => {
  const stages: string[] = [];
  const provider: ReasoningProvider = {
    name: "ai-sdk",
    async generateStructured(stage): Promise<StructuredResult> {
      stages.push(stage);
      if (stage === "conversation_analysis") {
        return {
          ok: true,
          data: {
            summary: "The user asked to retain the widget guard.",
            intent: [{ text: "Retain the widget guard.", event_ids: ["u-final"] }],
            refinements: [],
            decisions: [],
            constraints: [{ text: "The guard must remain.", event_ids: ["u-final"] }],
            non_goals: [],
            rejected_alternatives: [],
            claims: [],
            validation_claims: [],
            known_gaps: []
          }
        };
      }
      if (stage === "conversation_review_insights") {
        return {
          ok: true,
          data: {
            insights: [{
              root_cause_key: "widget-guard",
              category: "intent_mismatch",
              title: "Widget guard was removed",
              summary: "The diff removes the guard the user retained.",
              why_it_matters: "The widget may now be enabled unexpectedly.",
              reviewer_action: "Restore the guard or confirm the scope change.",
              priority: "high",
              evidence_state: "contradicted",
              conversation_event_ids: ["u-final"],
              paths: ["src/foo/widget.ts"],
              requirement_ids: [],
              risk_ids: [],
              command_ids: [],
              diff_anchors: [{ path: "src/foo/widget.ts", line_kind: "delete", line: 1, contains: "widgetGuard" }]
            }]
          }
        };
      }
      return {
        ok: true,
        data: {
          summary: "src/foo/widget.ts changed.",
          what_changed: [{ text: "src/foo/widget.ts changed.", paths: ["src/foo/widget.ts"] }],
          why_it_matters: [{ text: "Review src/foo/widget.ts.", paths: ["src/foo/widget.ts"] }],
          review_first: [{ text: "Review src/foo/widget.ts first.", paths: ["src/foo/widget.ts"] }],
          risk_narratives: []
        }
      };
    }
  };
  const diff: StructuredDiff = {
    files: [{
      path: "src/foo/widget.ts",
      status: "M",
      hunks: [{
        old_start: 1,
        old_lines: 1,
        new_start: 1,
        new_lines: 0,
        lines: [{ kind: "delete", text: "if (widgetGuard) return;", old_line: 1 }]
      }]
    }]
  };

  const model = await assemblePrReviewSurface({
    collection: collection({
      conversationEvents: [{ id: "u-final", actor: "user", kind: "decision", summary: "Keep the widget guard.", raw_index: 0 }]
    }),
    intent: INTENT,
    evaluation: EVALUATION,
    reviewAreas: AREAS,
    provider,
    providerName: "ai-sdk",
    redactSecrets: true,
    diff
  });

  assert.deepEqual(stages, ["pr_narrative", "conversation_analysis", "conversation_review_insights"]);
  assert.equal(model.conversation_analysis?.status, "analyzed");
  assert.equal(model.review_insights?.length, 1);
  assert.equal(model.review_insights?.[0].evidence_state, "contradicted");
  assert.equal(model.status, "ready");
});

test("review-surfaces.CONVERSATION_REVIEW.2 a no-diff PR skips every AI call and stays explicitly not assessed", async () => {
  let calls = 0;
  const provider: ReasoningProvider = {
    name: "ai-sdk",
    async generateStructured(): Promise<StructuredResult> {
      calls += 1;
      return { ok: false, reason: "must_not_run" };
    }
  };

  const model = await assemblePrReviewSurface({
    collection: collection({
      changedFiles: [],
      conversationEvents: [{ id: "u1", actor: "user", kind: "message", summary: "Review this.", raw_index: 0 }]
    }),
    intent: INTENT,
    evaluation: EVALUATION,
    reviewAreas: AREAS,
    provider,
    providerName: "ai-sdk",
    redactSecrets: true,
    diff: { files: [] }
  });

  assert.equal(calls, 0);
  assert.equal(model.status, "blocked");
  assert.equal(model.conversation_analysis?.status, "not_assessed");
  assert.ok(model.conversation_analysis?.quality_flags.includes("conversation_review_no_diff"));
  assert.deepEqual(model.review_insights, []);
});
