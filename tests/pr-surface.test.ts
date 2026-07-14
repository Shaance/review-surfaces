import test from "node:test";
import assert from "node:assert/strict";
import { CollectionResult } from "../src/collector/collect";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { IntentModel } from "../src/intent/intent";
import { assemblePrReviewSurface, normalizePrChangeContext } from "../src/pipeline/pr-surface";
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

test("PR change-context normalization is stable for long and redacted same-head inputs", () => {
  const secret = `ghp_${"a".repeat(36)}`;
  const input = {
    title: `Purpose ${secret} ${"x".repeat(500)}`,
    description: `Details ${secret} ${"y".repeat(7_000)}`,
    source: "github" as const,
    redaction_blocked: false
  };
  const first = normalizePrChangeContext(input);
  const second = normalizePrChangeContext({ ...input });
  assert.deepEqual(first, second);
  assert.ok((first?.title.length ?? 0) <= 300);
  assert.ok((first?.description?.length ?? 0) <= 6_000);
  assert.doesNotMatch(`${first?.title} ${first?.description}`, /ghp_a{36}/);
});

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

test("PR surface existing-test guidance ignores implementation directories named spec or test-support", async () => {
  for (const repositoryFile of ["src/spec/foo.ts", "src/test-support/foo.ts"]) {
    const model = await surface({ repositoryFiles: [repositoryFile] } as unknown as Partial<CollectionResult>);
    const risk = model.risks.candidates.find((candidate) => candidate.rule === "untested_changed_impl");

    assert.ok(risk);
    assert.match(risk.summary, /no test mapped to FOO/, repositoryFile);
    assert.equal(risk.suggested_checks.some((check) => /Run the existing test/.test(check)), false, repositoryFile);
  }
});

test("product reset M1 persists bounded, redacted author context independently of provider narrative", async () => {
  const token = "ghp_" + "x".repeat(36);
  const model = await assemblePrReviewSurface({
    collection: collection({}),
    intent: INTENT,
    evaluation: EVALUATION,
    reviewAreas: AREAS,
    diff: DIFF,
    changeContext: {
      title: "Make approval decisions legible",
      description: `## Summary\n\nExplain the change before diagnostics. ${token}`,
      source: "github",
      redaction_blocked: false
    }
  });

  assert.equal(model.change_context?.title, "Make approval decisions legible");
  assert.match(model.change_context?.description ?? "", /Explain the change before diagnostics/);
  assert.match(model.change_context?.description ?? "", /\[REDACTED:github_token\]/);
  assert.doesNotMatch(model.change_context?.description ?? "", /ghp_x{36}/);
  assert.equal(model.change_context?.redaction_blocked, true);
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

test("PR assembly stays deterministic and leaves optional enrichment to the human artifact", async () => {
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
    diff
  });

  assert.equal(model.status, "ready");
});

test("review-surfaces.CONVERSATION_REVIEW.2 a no-diff PR stays explicitly not assessed", async () => {
  const model = await assemblePrReviewSurface({
    collection: collection({
      changedFiles: [],
      conversationEvents: [{ id: "u1", actor: "user", kind: "message", summary: "Review this.", raw_index: 0 }]
    }),
    intent: INTENT,
    evaluation: EVALUATION,
    reviewAreas: AREAS,
    diff: { files: [] }
  });

  assert.equal(model.status, "blocked");
});
