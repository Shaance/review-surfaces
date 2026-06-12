import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildArchitecture, buildArchitectureModel, validateMermaidDiagramArtifact } from "../src/diagrams/diagrams";
import { CollectionResult } from "../src/collector/collect";
import { buildRepoIndex } from "../src/indexer/indexer";
import { EvaluationModel } from "../src/evaluation/evaluate";

test("review-surfaces.ARCH.6 validates generated Mermaid artifacts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-diagrams-"));
  const outputDir = path.join(tmp, ".review-surfaces");
  const architecture = await buildArchitecture(collectionFixture(tmp, outputDir), evaluationFixture());
  const pipelineValidation = architecture.diagram_validation.find((result) => result.path === "diagrams/pipeline.mmd");

  assert.equal(architecture.diagram_validation.length, 3);
  assert.ok(architecture.diagram_validation.every((result) => result.status === "valid"));
  assert.ok(fs.existsSync(path.join(outputDir, "diagrams", "pipeline.mmd")));
  assert.equal(pipelineValidation?.evidence[0]?.path, "diagrams/pipeline.mmd");
  assert.ok(fs.existsSync(path.join(outputDir, pipelineValidation?.evidence[0]?.path ?? "")));
  assert.equal(
    architecture.diagram_validation.find((result) => result.path === "diagrams/dogfood-flow.mmd")?.diagram_type,
    "sequenceDiagram"
  );
  assert.deepEqual(architecture.open_questions, []);
});

test("review-surfaces.ARCH.6 buildArchitectureModel returns the same model WITHOUT writing diagrams/", async () => {
  const tmpWrite = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-arch-write-"));
  const tmpModel = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-arch-model-"));
  try {
    const writeDir = path.join(tmpWrite, ".review-surfaces");
    const modelDir = path.join(tmpModel, ".review-surfaces");
    const written = await buildArchitecture(collectionFixture(tmpWrite, writeDir), evaluationFixture());
    const modelOnly = buildArchitectureModel(collectionFixture(tmpModel, modelDir), evaluationFixture());

    // The model (diagram paths + validation + subsystem cards) is byte-identical.
    assert.deepEqual(modelOnly, written, "the non-writing model must equal the writing builder's model");
    // The writing builder persisted diagrams/*.mmd; the non-writing variant did not.
    assert.ok(fs.existsSync(path.join(writeDir, "diagrams", "pipeline.mmd")), "buildArchitecture must write diagrams");
    assert.equal(
      fs.existsSync(path.join(modelDir, "diagrams")),
      false,
      "buildArchitectureModel must NOT write a diagrams/ directory"
    );
  } finally {
    fs.rmSync(tmpWrite, { recursive: true, force: true });
    fs.rmSync(tmpModel, { recursive: true, force: true });
  }
});

test("review-surfaces.ARCH.6 source layout counts each area by its own prefixes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-duplicate-area-"));
  const outputDir = path.join(tmp, ".review-surfaces");
  try {
    await buildArchitecture(collectionFixture(tmp, outputDir), evaluationFixture(), {
      areas: [
        {
          id: "DUPLICATE",
          name: "CLI",
          groupKey: "CLI",
          prefixes: ["src/cli/"],
          purpose: "CLI command handling.",
          pattern: "dispatcher",
          testKeywords: ["cli"]
        },
        {
          id: "DUPLICATE",
          name: "Architecture",
          groupKey: "ARCH",
          prefixes: ["src/diagrams/"],
          purpose: "Architecture diagrams.",
          pattern: "renderer",
          testKeywords: ["diagrams"]
        }
      ]
    });

    const sourceLayout = fs.readFileSync(path.join(outputDir, "diagrams", "source-layout.mmd"), "utf8");
    assert.match(sourceLayout, /CLI \(0 changed\)/);
    assert.match(sourceLayout, /Architecture \(1 changed\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.ARCH.6 rejects invalid Mermaid artifacts", () => {
  const result = validateMermaidDiagramArtifact({
    path: "../bad.mmd",
    body: "notMermaid\n  A --> B\n"
  });

  assert.equal(result.status, "invalid");
  assert.equal(result.diagram_type, "unknown");
  assert.ok(result.errors.some((error) => error.includes("relative diagrams/*.mmd")));
  assert.ok(result.errors.some((error) => error.includes("supported Mermaid declaration")));
});

test("review-surfaces.ARCH.6 rejects incomplete Mermaid flowchart and sequence syntax", () => {
  const flowchart = validateMermaidDiagramArtifact({
    path: "diagrams/bad-flow.mmd",
    body: "flowchart LR\n  A -->\n"
  });
  const sequence = validateMermaidDiagramArtifact({
    path: "diagrams/bad-sequence.mmd",
    body: "sequenceDiagram\n  Dev->>CLI\n"
  });

  assert.equal(flowchart.status, "invalid");
  assert.ok(flowchart.errors.some((error) => error.includes("Flowchart edge is incomplete")));
  assert.equal(sequence.status, "invalid");
  assert.ok(sequence.errors.some((error) => error.includes("Sequence message is incomplete")));
});

test("review-surfaces.ARCH.6 accepts single-letter Mermaid sequence participants", () => {
  const result = validateMermaidDiagramArtifact({
    path: "diagrams/single-letter-sequence.mmd",
    body: "sequenceDiagram\n  A->>B: ok\n"
  });

  assert.equal(result.status, "valid");
});

function collectionFixture(cwd: string, outputDir: string): CollectionResult {
  const changedFiles = [{ path: "src/diagrams/diagrams.ts", status: "M", source: "working_tree" as const }];
  return {
    cwd,
    outputDir,
    manifest: {
      tool_version: "0.1.0",
      created_at: "2026-05-28T00:00:00.000Z",
      repo: "review-surfaces",
      base_ref: "origin/main",
      uncommitted_files: 0,
      head_ref: "HEAD",
      head_sha: "HEAD",
      run_mode: "dogfood",
      milestone: "M4",
      input_hashes: []
    },
    specIndex: { schema_version: "review-surfaces.specs.index.v1", specs: [] },
    changedFiles,
    docs: [],
    tests: [{ path: "tests/diagrams.test.ts", kind: "test" }],
    feedback: [],
    commandTranscripts: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    testResults: { suites: [], cases: [], totals: { suites: 0, cases: 0, passed: 0, failed: 0, skipped: 0 }, source_paths: [] },
    repositoryFiles: [],
    repoIndex: buildRepoIndex({ cwd, changedFiles, repositoryFiles: [] }),
    privacy: {
      ignore_file: ".review-surfacesignore",
      ignore_patterns: [],
      ignored_changed_files: [],
      diff_redactions: [],
      remote_provider_blocked: false,
    secret_findings: []
    },
    git: {
      repo: "review-surfaces",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "HEAD"
    },
    diagnostics: [],
    diff_source: "range"
  };
}

function evaluationFixture(): EvaluationModel {
  return {
    summary: "diagram fixture",
    results: [
      {
        requirement_id: "REQ-ARCH-006",
        acai_id: "review-surfaces.ARCH.6",
        status: "partial",
        summary: "Diagram validation fixture.",
        evidence: [],
        missing_evidence: [],
        review_focus: "Verify Mermaid validation.",
        confidence: "medium"
      }
    ],
    overreach: [],
    acai_coverage: {
      "review-surfaces.ARCH.6": "partial"
    }
  };
}
