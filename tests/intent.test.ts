import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CollectionResult } from "../src/collector/collect";
import { buildIntent } from "../src/intent/intent";

function collection(overrides: Partial<CollectionResult> = {}): CollectionResult {
  return {
    cwd: process.cwd(),
    outputDir: ".review-surfaces",
    manifest: {
      tool_version: "0.1.0",
      created_at: "2026-05-28T00:00:00.000Z",
      repo: "fixture",
      base_ref: "HEAD",
      head_ref: "HEAD",
      head_sha: "abc",
      run_mode: "local",
      input_hashes: []
    },
    specIndex: { schema_version: "review-surfaces.specs.index.v1", specs: [] },
    changedFiles: [],
    docs: [],
    tests: [],
    feedback: [],
    commandTranscripts: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    repositoryFiles: [],
    privacy: {
      ignore_file: ".review-surfacesignore",
      ignore_patterns: [],
      ignored_changed_files: [],
      diff_redactions: [],
      remote_provider_blocked: false,
    secret_findings: []
    },
    git: {
      repo: "fixture",
      base_ref: "HEAD",
      head_ref: "HEAD",
      head_sha: "abc"
    },
    ...overrides
  } as CollectionResult;
}

test("review-surfaces.INTENT.4 records sparse source questions instead of inventing goals", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-intent-sparse-"));

  const intent = await buildIntent(tmp, collection());

  assert.ok(intent.open_questions.some((question) => question.includes("No Acai requirements were indexed")));
  assert.ok(intent.open_questions.some((question) => question.includes("No docs or agent instruction inputs were indexed")));
  assert.equal(intent.requirements.length, 0);
});

test("review-surfaces.INTENT.4 turns source-marked contradictions into open questions", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-intent-conflict-"));
  fs.mkdirSync(path.join(tmp, "docs"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "docs", "conflict.md"), "Conflict: should hosted PR comments come before local artifacts?\n");

  const intent = await buildIntent(
    tmp,
    collection({
      docs: [{ path: "docs/conflict.md", kind: "doc" }]
    })
  );

  assert.ok(intent.open_questions.some((question) => question.includes("docs/conflict.md: Possible conflicting source")));
});

test("review-surfaces.INTENT.4 ignores incidental conflict prose", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-intent-incidental-"));
  fs.mkdirSync(path.join(tmp, "docs"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "docs", "plan.md"), "Fixture tests should cover conflicting docs without inventing goals.\n");

  const intent = await buildIntent(
    tmp,
    collection({
      docs: [{ path: "docs/plan.md", kind: "doc" }]
    })
  );

  assert.ok(!intent.open_questions.some((question) => question.includes("Possible conflicting source")));
});
