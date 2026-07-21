import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { collectInputs } from "../src/collector/collect";
import { collectChangedFiles } from "../src/collector/git";
import { recordCommandTranscript } from "../src/commands/runner";
import { indexCommandTranscripts } from "../src/commands/transcripts";
import { defaultConfig } from "../src/config/config";
import { buildMethodology } from "../src/methodology/methodology";
import { openAiProjectKeyFixture } from "./helpers/secret-fixtures";

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
      contract_surfaces: { paths: [] },
      output_dir: ".review-surfaces"
    },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  assert.ok(result.changedFiles.some((file) => file.path === "src/diagrams/diagrams.ts"));
});

test("collector records staged and committed renames by their new path", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-rename-"));
  try {
    const oldPath = "src/old name.ts";
    const newPath = "src/new -> name.ts";
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, oldPath), "export const value = 1;\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

    execFileSync("git", ["mv", oldPath, newPath], { cwd: tmp, stdio: "ignore" });
    const staged = collectChangedFiles(tmp, "HEAD", "HEAD").files;
    assert.ok(staged.some((file) => file.path === newPath && file.status.startsWith("R")), "staged rename must use the new path");
    assert.ok(!staged.some((file) => file.path === `${oldPath} -> ${newPath}`), "staged rename must not keep porcelain's old -> new display path");
    assert.ok(!staged.some((file) => file.path.includes("\"")), "staged rename paths must be unquoted");
    assert.equal(staged.find((file) => file.path === newPath)?.old_path, oldPath, "a staged (working-tree) rename captures its old_path (#103)");

    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "rename"], { cwd: tmp, stdio: "ignore" });
    const committed = collectChangedFiles(tmp, base, "HEAD").files;
    assert.deepEqual(
      committed.filter((file) => file.path === newPath).map((file) => file.source),
      ["diff"],
      "committed rename diff must use the new path"
    );
    assert.ok(!committed.some((file) => file.path === oldPath), "committed rename must not report the old path as changed");
    assert.equal(committed.find((file) => file.path === newPath)?.old_path, oldPath, "a committed rename captures its old_path (#103)");

    fs.writeFileSync(path.join(tmp, newPath), "export const renamed = 3;\n");
    const dirty = collectChangedFiles(tmp, base, "HEAD").files;
    assert.deepEqual(
      dirty.filter((file) => file.path === newPath).map((file) => ({ status: file.status, source: file.source })),
      [{ status: "R100", source: "working_tree" }],
      "dirty edits to a committed rename must preserve the committed rename status"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("manifest signature distinguishes two same-content renames to the same destination (#103, Codex P2)", async () => {
  // Two working-tree renames with an IDENTICAL committed head, identical
  // destination bytes, identical status — differing ONLY in the rename SOURCE.
  // The rename source drives api_no_compat, so the cache key must change with it;
  // otherwise --cache reuses a stale methodology result. Same head_sha here means
  // base/head sha, input hashes, and the dest content hash are all equal, so any
  // signature difference is attributable solely to old_path.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-rename-sig-"));
  try {
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "features", "example.feature.yaml"),
      `feature:
  name: example
components:
  ALPHA:
    requirements:
      1: The first behavior.
`
    );
    // a.ts and b.ts share byte-identical content so the renamed destination hashes
    // the same regardless of which source it came from.
    fs.writeFileSync(path.join(tmp, "src", "a.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(tmp, "src", "b.ts"), "export const value = 1;\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });

    const config = {
      ...defaultConfig,
      specs: ["features/**/*.feature.yaml"],
      docs: [],
      tests: [],
      output_dir: ".review-surfaces"
    };
    const collect = () => collectInputs({ cwd: tmp, config, baseRef: "HEAD", headRef: "HEAD", dogfood: false });

    // Run 1: a.ts -> src/dest.ts. Only a.ts is deleted, so git pairs the rename
    // with a.ts unambiguously.
    execFileSync("git", ["mv", "src/a.ts", "src/dest.ts"], { cwd: tmp, stdio: "ignore" });
    const first = await collect();
    assert.equal(first.changedFiles.find((file) => file.path === "src/dest.ts")?.old_path, "src/a.ts", "run 1 renames from a.ts");
    const sig1 = first.manifest.signature ?? "";
    assert.ok(sig1.length > 0, "run 1 records a signature");

    // Run 2: restore a.ts, then b.ts -> src/dest.ts. Same head, same dest bytes,
    // same status — only the source differs.
    execFileSync("git", ["mv", "src/dest.ts", "src/a.ts"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["mv", "src/b.ts", "src/dest.ts"], { cwd: tmp, stdio: "ignore" });
    const second = await collect();
    assert.equal(second.changedFiles.find((file) => file.path === "src/dest.ts")?.old_path, "src/b.ts", "run 2 renames from b.ts");
    const sig2 = second.manifest.signature ?? "";

    assert.notEqual(sig2, sig1, "a different rename source must change the manifest signature so --cache does not reuse a stale methodology result");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("manifest signature changes with ai-sdk max output token budget", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-ai-budget-sig-"));
  const previous = process.env.REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS;
  try {
    fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "features", "example.feature.yaml"),
      `feature:
  name: example
components:
  CORE:
    requirements:
      1: Build core.
`
    );
    fs.writeFileSync(path.join(tmp, "src", "core.ts"), "export const core = true;\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });

    const config = { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [] };
    process.env.REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS = "4096";
    const first = await collectInputs({ cwd: tmp, config, baseRef: "HEAD", headRef: "HEAD", dogfood: false, provider: "ai-sdk" });
    process.env.REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS = "12000";
    const second = await collectInputs({ cwd: tmp, config, baseRef: "HEAD", headRef: "HEAD", dogfood: false, provider: "ai-sdk" });
    process.env.REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS = "4096";
    const third = await collectInputs({ cwd: tmp, config, baseRef: "HEAD", headRef: "HEAD", dogfood: false, provider: "mock" });
    process.env.REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS = "12000";
    const fourth = await collectInputs({ cwd: tmp, config, baseRef: "HEAD", headRef: "HEAD", dogfood: false, provider: "mock" });
    process.env.REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS = "4096";
    const prScopeFirst = await collectInputs({ cwd: tmp, config, baseRef: "HEAD", headRef: "HEAD", dogfood: false, provider: "mock", gateProvider: "ai-sdk" });
    process.env.REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS = "12000";
    const prScopeSecond = await collectInputs({ cwd: tmp, config, baseRef: "HEAD", headRef: "HEAD", dogfood: false, provider: "mock", gateProvider: "ai-sdk" });

    assert.notEqual(second.manifest.signature, first.manifest.signature, "ai-sdk token budget changes the cache signature");
    assert.equal(fourth.manifest.signature, third.manifest.signature, "mock signatures ignore ai-sdk-only token budget");
    assert.notEqual(
      prScopeSecond.manifest.signature,
      prScopeFirst.manifest.signature,
      "PR-scope ai-sdk gate token budget changes the cache signature"
    );
  } finally {
    if (previous === undefined) {
      delete process.env.REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS;
    } else {
      process.env.REVIEW_SURFACES_AI_MAX_OUTPUT_TOKENS = previous;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collector marks a diff file as working_tree when it is dirty after HEAD", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-dirty-diff-"));
  try {
    const filePath = "src/feature.ts";
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, filePath), "export const value = 1;\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

    fs.writeFileSync(path.join(tmp, filePath), "export const value = 2;\n");
    execFileSync("git", ["add", filePath], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "subject"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, filePath), "export const value = 3;\n");

    const files = collectChangedFiles(tmp, base, "HEAD").files;
    assert.deepEqual(
      files.filter((file) => file.path === filePath).map((file) => file.source),
      ["working_tree"],
      "a path already in the base...head diff must still be marked dirty when porcelain reports local edits"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collector preserves added diff status when an added file is dirty after HEAD", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-dirty-add-"));
  try {
    const filePath = "src/feature.ts";
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "README.md"), "# base\n");
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, filePath), "export const value = 1;\n");
    execFileSync("git", ["add", filePath], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "add feature"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, filePath), "export const value = 2;\n");

    const files = collectChangedFiles(tmp, base, "HEAD").files;
    assert.deepEqual(
      files.filter((file) => file.path === filePath).map((file) => ({ status: file.status, source: file.source })),
      [{ status: "A", source: "working_tree" }],
      "dirty edits to a range-added file must preserve the range-added status"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collector marks a deleted diff file as working_tree when it is dirty after HEAD", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-deleted-diff-"));
  try {
    const filePath = "src/feature.ts";
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, filePath), "export const value = 1;\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

    fs.writeFileSync(path.join(tmp, filePath), "export const value = 2;\n");
    execFileSync("git", ["add", filePath], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "subject"], { cwd: tmp, stdio: "ignore" });
    fs.rmSync(path.join(tmp, filePath));

    const files = collectChangedFiles(tmp, base, "HEAD").files;
    assert.deepEqual(
      files.filter((file) => file.path === filePath).map((file) => ({ status: file.status, source: file.source })),
      [{ status: "D", source: "working_tree" }],
      "a path already in the base...head diff must still be marked dirty when porcelain reports a local deletion"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collector preserves deleted diff status when a working-tree replacement exists", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-recreated-delete-"));
  try {
    const filePath = "src/feature.ts";
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, filePath), "export const value = 1;\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

    fs.rmSync(path.join(tmp, filePath));
    execFileSync("git", ["add", filePath], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "delete"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, filePath), "export const replacement = true;\n");

    const files = collectChangedFiles(tmp, base, "HEAD").files;
    assert.deepEqual(
      files.filter((file) => file.path === filePath).map((file) => ({ status: file.status, source: file.source })),
      [{ status: "D", source: "working_tree" }],
      "a local replacement for a deleted range path must not hide the range deletion status"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
      contract_surfaces: { paths: [] },
      privacy: { ignore_file: ".review-surfacesignore", redact_secrets: true },
      llm: { provider: "mock", model: null, require_json_schema: true },
      diagrams: { format: "mermaid" },
      render: { mode: "compact", include_evidence_appendix: true },
      dogfood: { enabled: true, milestone: "M1" },
      quality_gate: { max_missing: 0, allow_missing: [], fail_on: null },
      human_review: defaultConfig.human_review,
      command_rules: []
    },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  assert.equal(result.commandTranscriptOutputPath, "custom-surfaces/inputs/commands.json");
  assert.equal(result.commandTranscripts[0].id, "CMD-CUSTOM-OUT");
});

test("review-surfaces.METHODOLOGY.6 collect.ts produces conversationEvents that buildMethodology reads without re-parsing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-conv-seam-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "tests", "fixtures", "minimal-repo", "features", "example.feature.yaml"),
    path.join(tmp, "features", "example.feature.yaml")
  );
  fs.copyFileSync(
    path.join(process.cwd(), "tests", "fixtures", "conversations", "claude-code.jsonl"),
    path.join(tmp, "session.jsonl")
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const result = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    conversationPath: "session.jsonl"
  });

  // The single producer ran inside collect.ts: the redacted stream + harness
  // label are on the CollectionResult, and the normalized log was persisted.
  assert.ok(result.conversationEvents && result.conversationEvents.length > 0);
  assert.equal(result.conversationSource, "claude-code");
  assert.equal(
    result.conversationSourceHash,
    crypto.createHash("sha256").update(fs.readFileSync(path.join(tmp, "session.jsonl"))).digest("hex")
  );
  assert.ok(result.diagnostics.some((line) => line.startsWith("Conversation adapter: claude-code")));
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "inputs", "conversation.normalized.jsonl")));
  // A redacted tool_result secret never reaches the in-memory stream verbatim.
  assert.ok(!result.conversationEvents.some((event) => event.summary.includes("ghp_")));

  // Both call sites READ collection.conversationEvents rather than re-parsing:
  // buildMethodology consumes the stream even though the path is never re-read.
  const methodology = await buildMethodology(tmp, result, "session.jsonl", []);
  assert.equal(methodology.missing_logs, false);
  assert.match(methodology.summary, new RegExp(`extracted ${result.conversationEvents.length} event`));
});

test("additional-only conversation format and bytes are part of the collection signature", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-additional-conv-"));
  fs.writeFileSync(path.join(tmp, "later.jsonl"), `${JSON.stringify({
    id: "u1",
    actor: "user",
    kind: "message",
    summary: "Keep the final boundary."
  })}\n`);
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const result = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: [], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    conversationDiscovery: false,
    additionalConversationPaths: ["later.jsonl"],
    conversationFormat: "normalized"
  });

  assert.equal(result.conversationSources?.[0].id, "conversation-2");
  assert.equal(result.conversationSources?.[0].adapter, "normalized");
  assert.ok(result.manifest.signature);

  const forcedCodex = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: [], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    conversationDiscovery: false,
    additionalConversationPaths: ["later.jsonl"],
    conversationFormat: "codex"
  });
  assert.equal(forcedCodex.conversationSources?.[0].adapter, "codex");
  assert.notEqual(forcedCodex.manifest.signature, result.manifest.signature);
});

test("an unreadable additional conversation fails before collection writes artifacts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-additional-preflight-"));
  await assert.rejects(() => collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: [], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    conversationDiscovery: false,
    additionalConversationPaths: ["missing.jsonl"]
  }), /additional conversation 1 was unreadable or unmatched/);
  assert.equal(fs.existsSync(path.join(tmp, ".review-surfaces")), false);
});

test("strict evidence collection rejects a worktree mutation during collection", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-snapshot-race-"));
  fs.writeFileSync(path.join(tmp, "tracked.ts"), "export const value = 1;\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "snapshot@example.com"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Snapshot Test"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "tracked.ts"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });

  await assert.rejects(() => collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: [], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    conversationDiscovery: false,
    strictEvidenceSnapshot: true,
    beforeEvidenceSnapshotValidation: () => {
      fs.writeFileSync(path.join(tmp, "tracked.ts"), "export const value = 2;\n");
    }
  }), /repository changed while agreement-audit evidence was being collected/);
});

test("strict evidence collection rejects an initially dirty worktree before snapshot validation", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-dirty-snapshot-"));
  fs.writeFileSync(path.join(tmp, "tracked.ts"), "export const value = 1;\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "snapshot@example.com"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Snapshot Test"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "tracked.ts"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
  fs.writeFileSync(path.join(tmp, "tracked.ts"), "export const value = 2;\n");
  let validated = false;

  await assert.rejects(() => collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: [], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    conversationDiscovery: false,
    strictEvidenceSnapshot: true,
    beforeEvidenceSnapshotValidation: () => { validated = true; }
  }), /requires a clean working tree/);
  assert.equal(validated, false);
});

test("strict evidence collection fails closed when Git cannot report worktree status", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-status-failure-"));
  fs.writeFileSync(path.join(tmp, "tracked.ts"), "export const value = 1;\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "snapshot@example.com"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Snapshot Test"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "tracked.ts"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
  fs.writeFileSync(path.join(tmp, ".git", "index"), "not a git index");

  await assert.rejects(() => collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: [], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    conversationDiscovery: false,
    strictEvidenceSnapshot: true
  }), /could not verify working-tree status/);
});

test("review-surfaces.PRIVACY.7 a conversation tool_result secret folds into remote_provider_blocked AND secret_findings", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-conv-priv-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "tests", "fixtures", "minimal-repo", "features", "example.feature.yaml"),
    path.join(tmp, "features", "example.feature.yaml")
  );
  // claude-code.jsonl carries a github_token inside a tool_result.
  fs.copyFileSync(
    path.join(process.cwd(), "tests", "fixtures", "conversations", "claude-code.jsonl"),
    path.join(tmp, "session.jsonl")
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const result = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    conversationPath: "session.jsonl"
  });

  // The gate signal is folded BEFORE privacy is assembled, so an ai-sdk run would
  // privacy-block at the gate, not just the per-call short-circuit.
  assert.equal(result.privacy.remote_provider_blocked, true);
  // The persisted surface ALSO exposes the block (not a clean secret_findings next
  // to a blocked run), with a repo-relative locus, never the conversation text.
  const conversationFinding = (result.privacy.conversation_secret_findings ?? []).find((finding) => finding.path.includes("conversation.normalized"));
  assert.ok(conversationFinding, "secret_findings exposes the conversation block");
  assert.ok(conversationFinding.kinds.includes("github_token"));
  assert.ok(!conversationFinding.path.startsWith("/"));

  // The locus must stay repo-relative and NON-ESCAPING even when --out points
  // OUTSIDE the repo (else path.relative yields a ../../.. that leaks the absolute
  // home dir). Caught by live-testing; pinned here.
  const outsideOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rs-out-")), "out");
  const escaped = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    outputDir: outsideOut,
    conversationPath: "session.jsonl"
  });
  const escapedFinding = (escaped.privacy.conversation_secret_findings ?? []).find((finding) => finding.path.includes("conversation.normalized"));
  assert.ok(escapedFinding);
  assert.ok(!escapedFinding.path.startsWith("/") && !escapedFinding.path.includes(".."), `locus must not escape: ${escapedFinding.path}`);
});

test("review-surfaces.PRIVACY.7 every secret-shaped normalized event field folds into conversation privacy findings", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-call-id-priv-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "tests", "fixtures", "minimal-repo", "features", "example.feature.yaml"),
    path.join(tmp, "features", "example.feature.yaml")
  );
  const secret = openAiProjectKeyFixture();
  fs.writeFileSync(path.join(tmp, "session.jsonl"), [
    { id: "safe-call-id", actor: "assistant", kind: "tool_call", summary: "Run validation", call_id: secret, raw_index: 0 },
    { id: "safe-actor", actor: secret, kind: "message", summary: "Actor field", raw_index: 1 },
    { id: "safe-kind", actor: "assistant", kind: secret, summary: "Kind field", raw_index: 2 }
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const result = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    conversationPath: "session.jsonl",
    conversationFormat: "normalized"
  });

  assert.equal(result.privacy.remote_provider_blocked, true);
  assert.ok(result.privacy.conversation_secret_findings?.some((finding) => finding.kinds.includes("openai_key")));
  assert.ok(!JSON.stringify(result.conversationEvents).includes(secret));
});

test("review-surfaces.PRIVACY.7 raw adapter call_ids are redacted before the collection privacy fold", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-raw-call-id-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "tests", "fixtures", "minimal-repo", "features", "example.feature.yaml"),
    path.join(tmp, "features", "example.feature.yaml")
  );
  const secret = openAiProjectKeyFixture();
  fs.writeFileSync(path.join(tmp, "session.jsonl"), [
    {
      type: "assistant",
      uuid: "safe-call-event",
      message: { role: "assistant", content: [{ type: "tool_use", id: secret, name: "Bash", input: { command: "pnpm test" } }] }
    },
    {
      type: "user",
      uuid: "safe-result-event",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: secret, content: "done" }] }
    }
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const result = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false,
    conversationPath: "session.jsonl",
    conversationFormat: "claude-code"
  });

  assert.equal(result.privacy.remote_provider_blocked, true);
  assert.ok(result.privacy.conversation_secret_findings?.some((finding) => finding.kinds.includes("openai_key")));
  assert.ok(!JSON.stringify(result.conversationEvents).includes(secret));
  assert.ok(result.conversationEvents?.some((event) => event.call_id?.includes("[REDACTED:openai_key]")));
});

test("review-surfaces.PRIVACY.2 writer block signals survive indexing and close the collection remote-provider gate", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-command-priv-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const secret = openAiProjectKeyFixture();
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "tests", "fixtures", "minimal-repo", "features", "example.feature.yaml"),
    path.join(tmp, "features", "example.feature.yaml")
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const childScripts = {
    "CMD-LATE-STDOUT": "process.stdout.write('x'.repeat(7000) + ' ' + ['sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz123456'].join(''))",
    "CMD-LATE-STDERR": "process.stderr.write('x'.repeat(7000) + ' ' + ['sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz123456'].join(''))"
  } as const;
  const written = await Promise.all(Object.entries(childScripts).map(([id, script]) =>
    recordCommandTranscript({
      cwd: tmp,
      args: [process.execPath, "-e", script],
      id,
      streamOutput: false
    })
  ));

  for (const artifact of written) {
    const persisted = fs.readFileSync(path.join(tmp, artifact.transcriptPath), "utf8");
    const transcript = JSON.parse(persisted).commands[0];
    const excerpt = artifact.transcript.id === "CMD-LATE-STDOUT"
      ? transcript.stdout_excerpt
      : transcript.stderr_excerpt;
    assert.equal(transcript.secret_blocked, true);
    assert.ok(typeof excerpt === "string" && excerpt.length <= 1200);
    assert.doesNotMatch(excerpt, new RegExp(secret));
    assert.doesNotMatch(excerpt, /\[REDACTED:/);
    assert.doesNotMatch(persisted, new RegExp(secret));
    assert.doesNotMatch(persisted, /\[REDACTED:/);
  }

  const indexed = await indexCommandTranscripts(tmp, written.map((artifact) => artifact.transcriptPath));
  assert.deepEqual(indexed.map((transcript) => transcript.id).sort(), ["CMD-LATE-STDERR", "CMD-LATE-STDOUT"]);
  for (const transcript of indexed) {
    assert.equal(transcript.secret_blocked, true);
    assert.doesNotMatch(JSON.stringify(transcript), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(transcript), /\[REDACTED:/);
  }

  const result = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  assert.deepEqual(
    result.commandTranscripts.map((transcript) => transcript.id).sort(),
    ["CMD-LATE-STDERR", "CMD-LATE-STDOUT"]
  );
  assert.ok(result.commandTranscripts.every((transcript) => transcript.secret_blocked === true));
  assert.equal(result.privacy.remote_provider_blocked, true);
  const collectedArtifact = fs.readFileSync(path.join(tmp, ".review-surfaces", "inputs", "commands.json"), "utf8");
  assert.doesNotMatch(collectedArtifact, new RegExp(secret));
  assert.doesNotMatch(collectedArtifact, /\[REDACTED:/);
});

test("review-surfaces.PRIVACY.2 marker-only legacy command excerpts close the collection remote-provider gate", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-command-marker-compat-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const marker = "[REDACTED:github_token]";
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "commands"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "tests", "fixtures", "minimal-repo", "features", "example.feature.yaml"),
    path.join(tmp, "features", "example.feature.yaml")
  );
  const legacyCommands = [
    {
      id: "CMD-LEGACY-STDOUT-MARKER",
      command: "pnpm run test",
      exit_code: 0,
      stdout_excerpt: `legacy stdout retained only as ${marker}`
    },
    {
      id: "CMD-LEGACY-STDERR-MARKER",
      command: "pnpm run test",
      exit_code: 1,
      stderr_excerpt: `third-party stderr retained only as ${marker}`
    }
  ];
  const sourcePath = path.join(tmp, ".review-surfaces", "commands", "legacy.json");
  fs.writeFileSync(sourcePath, JSON.stringify({ commands: legacyCommands }));
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  for (const command of legacyCommands) {
    assert.equal("stdout" in command, false);
    assert.equal("stderr" in command, false);
    assert.equal("secret_blocked" in command, false);
  }

  const indexed = await indexCommandTranscripts(tmp, [".review-surfaces/commands/legacy.json"]);
  assert.deepEqual(
    indexed.map((transcript) => ({ id: transcript.id, secretBlocked: transcript.secret_blocked })),
    [
      { id: "CMD-LEGACY-STDOUT-MARKER", secretBlocked: true },
      { id: "CMD-LEGACY-STDERR-MARKER", secretBlocked: true }
    ]
  );

  const result = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  assert.equal(result.privacy.remote_provider_blocked, true);
  assert.ok(result.commandTranscripts.every((transcript) => transcript.secret_blocked === true));
  const collected = JSON.parse(
    fs.readFileSync(path.join(tmp, ".review-surfaces", "inputs", "commands.json"), "utf8")
  ) as { transcripts: Array<Record<string, unknown>> };
  assert.deepEqual(
    collected.transcripts.map((command) => ({
      id: command.id,
      stdoutExcerpt: command.stdout_excerpt,
      stderrExcerpt: command.stderr_excerpt,
      secretBlocked: command.secret_blocked,
      hasRawStdout: Object.prototype.hasOwnProperty.call(command, "stdout"),
      hasRawStderr: Object.prototype.hasOwnProperty.call(command, "stderr")
    })),
    [
      {
        id: "CMD-LEGACY-STDOUT-MARKER",
        stdoutExcerpt: `legacy stdout retained only as ${marker}`,
        stderrExcerpt: undefined,
        secretBlocked: true,
        hasRawStdout: false,
        hasRawStderr: false
      },
      {
        id: "CMD-LEGACY-STDERR-MARKER",
        stdoutExcerpt: undefined,
        stderrExcerpt: `third-party stderr retained only as ${marker}`,
        secretBlocked: true,
        hasRawStdout: false,
        hasRawStderr: false
      }
    ]
  );
});
