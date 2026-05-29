import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectInputs } from "../src/collector/collect";
import { defaultConfig } from "../src/config/config";

test("collects specs and writes first local artifacts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-test-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "feedback"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "commands"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "tests", "fixtures", "minimal-repo", "features", "example.feature.yaml"),
    path.join(tmp, "features", "example.feature.yaml")
  );
  fs.writeFileSync(path.join(tmp, "README.md"), "# Fixture\n");
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "feedback", "manual.yaml"),
    `schema_version: review-surfaces.feedback.v1
author: codex
findings:
  - id: FB-001
    category: review_value
    severity: medium
    finding: review-surfaces.DOGFOOD.6 should preserve feedback.
validation:
  passed:
    - pnpm run test
`
  );
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "commands", "local.json"),
    JSON.stringify({
      commands: [{ id: "CMD-001", command: "pnpm run test", exit_code: 0 }]
    })
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const result = await collectInputs({
    cwd: tmp,
    config: {
      ...defaultConfig,
      specs: ["features/**/*.feature.yaml"],
      docs: ["README.md"],
      tests: [],
      output_dir: ".review-surfaces"
    },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  assert.equal(result.specIndex.specs.length, 1);
  assert.equal(result.specIndex.specs[0].requirements.length, 3);
  assert.equal(result.feedback.length, 1);
  assert.equal(result.feedback[0].findings[0].id, "FB-001");
  assert.equal(result.commandTranscripts.length, 1);
  assert.equal(result.commandTranscripts[0].id, "CMD-001");
  assert.ok(result.manifest.input_hashes.some((input) => input.path === ".review-surfaces/feedback/manual.yaml" && input.kind === "feedback"));
  assert.ok(result.manifest.input_hashes.some((input) => input.path === ".review-surfaces/commands/local.json" && input.kind === "command_transcript"));
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "manifest.json")));
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "inputs", "specs.index.json")));
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "inputs", "feedback.index.json")));
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "inputs", "commands.json")));
});

test("collector expands untracked directories into file evidence", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-untracked-dir-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "diagrams"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  ARCH:
    requirements:
      1: Generate diagrams.
`
  );
  fs.writeFileSync(path.join(tmp, "src", "diagrams", "diagrams.ts"), "export const diagram = true;\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const result = await collectInputs({
    cwd: tmp,
    config: {
      ...defaultConfig,
      specs: ["features/**/*.feature.yaml"],
      docs: [],
      tests: [],
      output_dir: ".review-surfaces"
    },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  assert.ok(result.changedFiles.some((file) => file.path === "src/diagrams/diagrams.ts"));
});

test("review-surfaces.CLI.7 collection defaults command transcripts to the output directory", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-output-commands-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "custom-surfaces", "commands"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "tests", "fixtures", "minimal-repo", "features", "example.feature.yaml"),
    path.join(tmp, "features", "example.feature.yaml")
  );
  fs.writeFileSync(
    path.join(tmp, "custom-surfaces", "commands", "local.json"),
    JSON.stringify({ commands: [{ id: "CMD-CUSTOM-OUT", command: "pnpm run test", exit_code: 0 }] })
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const result = await collectInputs({
    cwd: tmp,
    config: {
      schema_version: "review-surfaces.config.v1",
      output_dir: "custom-surfaces",
      specs: ["features/**/*.feature.yaml"],
      docs: [],
      tests: [],
      privacy: { ignore_file: ".review-surfacesignore", redact_secrets: true },
      llm: { provider: "mock", model: null, require_json_schema: true },
      diagrams: { format: "mermaid" },
      render: { mode: "compact", include_evidence_appendix: true },
      dogfood: { enabled: true, milestone: "M1" },
      quality_gate: { max_missing: 0 }
    },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  assert.equal(result.commandTranscriptOutputPath, "custom-surfaces/inputs/commands.json");
  assert.equal(result.commandTranscripts[0].id, "CMD-CUSTOM-OUT");
});
