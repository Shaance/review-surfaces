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

test("PR surface existing-test guidance honors configured and recognized tests outside tests directory", async () => {
  const configured = await surface({ tests: [{ path: "spec/foo.test.ts" }], repositoryFiles: [] } as unknown as Partial<CollectionResult>);
  const configuredRisk = configured.risks.candidates.find((candidate) => candidate.rule === "untested_changed_impl");
  assert.ok(configuredRisk);
  assert.match(configuredRisk.summary, /test is mapped to FOO/);
  assert.ok(configuredRisk.suggested_checks.some((check) => /Run the existing test/.test(check)));

  const recognized = await surface({ repositoryFiles: ["test_foo.py"] } as unknown as Partial<CollectionResult>);
  const recognizedRisk = recognized.risks.candidates.find((candidate) => candidate.rule === "untested_changed_impl");
  assert.ok(recognizedRisk);
  assert.match(recognizedRisk.summary, /test is mapped to FOO/);
});
