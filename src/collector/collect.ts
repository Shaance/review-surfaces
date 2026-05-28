import path from "node:path";
import { AcaiSpecIndex, indexAcaiSpecs } from "../acai/acai";
import { CommandTranscript, commandTranscriptInputDir, commandTranscriptOutputPath, indexCommandTranscriptFiles } from "../commands/transcripts";
import { ReviewSurfacesConfig } from "../config/config";
import { filterPathsByPatterns, walkFiles } from "../core/glob";
import { ensureDir, hashFile, writeJson, writeText } from "../core/files";
import { FeedbackFile, indexFeedbackFiles } from "../feedback/feedback";
import { filterIgnoredDiff } from "../privacy/diff";
import { loadPrivacyIgnore } from "../privacy/ignore";
import { SecretRedaction, redactSecrets } from "../privacy/secrets";
import { ChangedFile, collectChangedFiles, collectCommits, collectDiff, collectGitInfo, GitInfo } from "./git";

export interface ManifestInputHash {
  path: string;
  algorithm: "sha256";
  hash: string;
  kind: string;
}

export interface RunManifest {
  tool_version: string;
  created_at: string;
  repo: string;
  base_ref: string;
  head_ref: string;
  base_sha?: string;
  head_sha: string;
  run_mode: "local" | "dogfood" | "ci" | "provider" | "unknown";
  milestone?: string;
  input_hashes: ManifestInputHash[];
}

export interface CollectionResult {
  cwd: string;
  outputDir: string;
  manifest: RunManifest;
  specIndex: AcaiSpecIndex;
  changedFiles: ChangedFile[];
  docs: Array<{ path: string; kind: string }>;
  tests: Array<{ path: string; kind: string }>;
  feedback: FeedbackFile[];
  commandTranscripts: CommandTranscript[];
  commandTranscriptOutputPath: string;
  repositoryFiles: string[];
  privacy: {
    ignore_file: string;
    ignore_patterns: string[];
    ignored_changed_files: string[];
    diff_redactions: SecretRedaction[];
    remote_provider_blocked: boolean;
  };
  git: GitInfo;
}

export interface CollectOptions {
  cwd: string;
  config: ReviewSurfacesConfig;
  baseRef: string;
  headRef: string;
  outputDir?: string;
  commandTranscriptDir?: string;
  dogfood: boolean;
}

export async function collectInputs(options: CollectOptions): Promise<CollectionResult> {
  const outputDir = path.resolve(options.cwd, options.outputDir ?? options.config.output_dir);
  const inputsDir = path.join(outputDir, "inputs");
  const commandsOutputPath = commandTranscriptOutputPath(options.cwd, outputDir);
  await ensureDir(inputsDir);

  const ignore = await loadPrivacyIgnore(options.cwd, options.config.privacy.ignore_file);
  const walkOptions = { isIgnored: ignore.isIgnored };
  const repositoryFiles = await walkFiles(options.cwd, walkOptions);
  const specPaths = filterPathsByPatterns(repositoryFiles, options.config.specs);
  const docPaths = filterPathsByPatterns(repositoryFiles, options.config.docs);
  const testPaths = filterPathsByPatterns(repositoryFiles, options.config.tests);
  const feedbackPaths = filterPathsByPatterns(repositoryFiles, [".review-surfaces/feedback/*.yaml"]);
  const commandTranscriptDir = normalizeRelativeDir(options.commandTranscriptDir ?? commandTranscriptInputDir(options.cwd, outputDir));
  const commandTranscriptPaths = filterPathsByPatterns(repositoryFiles, [`${commandTranscriptDir}/*.json`]);
  const specIndex = await indexAcaiSpecs(options.cwd, specPaths);
  const feedback = await indexFeedbackFiles(options.cwd, feedbackPaths);
  const commandTranscriptIndex = await indexCommandTranscriptFiles(options.cwd, commandTranscriptPaths);
  const commandTranscripts = commandTranscriptIndex.transcripts;
  const git = collectGitInfo(options.cwd, options.baseRef, options.headRef);
  const allChangedFiles = collectChangedFiles(options.cwd, options.baseRef, options.headRef);
  const changedFiles = allChangedFiles.filter((file) => !ignore.isIgnored(file.path));
  const ignoredChangedFiles = allChangedFiles.filter((file) => ignore.isIgnored(file.path)).map((file) => file.path);
  const rawDiff = collectDiff(options.cwd, options.baseRef, options.headRef);
  const filteredDiff = filterIgnoredDiff(rawDiff, ignore.isIgnored);
  const redactedDiff = options.config.privacy.redact_secrets
    ? redactSecrets(filteredDiff)
    : { text: filteredDiff, redactions: [], blocked: false };
  const commits = collectCommits(options.cwd, options.baseRef, options.headRef);
  const docs = docPaths.map((docPath) => ({ path: docPath, kind: classifyDoc(docPath) }));
  const tests = testPaths.map((testPath) => ({ path: testPath, kind: "test" }));
  const privacy = {
    ignore_file: ignore.ignoreFile,
    ignore_patterns: ignore.patterns,
    ignored_changed_files: ignoredChangedFiles,
    diff_redactions: redactedDiff.redactions,
    remote_provider_blocked: redactedDiff.blocked
  };

  const inputHashes: ManifestInputHash[] = [];
  for (const specPath of specPaths) {
    inputHashes.push({
      path: specPath,
      algorithm: "sha256",
      hash: await hashFile(path.resolve(options.cwd, specPath)),
      kind: "spec"
    });
  }
  for (const docPath of docPaths) {
    inputHashes.push({
      path: docPath,
      algorithm: "sha256",
      hash: await hashFile(path.resolve(options.cwd, docPath)),
      kind: "doc"
    });
  }
  for (const feedbackPath of feedbackPaths) {
    inputHashes.push({
      path: feedbackPath,
      algorithm: "sha256",
      hash: await hashFile(path.resolve(options.cwd, feedbackPath)),
      kind: "feedback"
    });
  }
  inputHashes.push(...commandTranscriptIndex.sourceHashes);

  const manifest: RunManifest = {
    tool_version: "0.1.0",
    created_at: new Date().toISOString(),
    repo: git.repo,
    base_ref: options.baseRef,
    head_ref: options.headRef,
    base_sha: git.base_sha,
    head_sha: git.head_sha,
    run_mode: options.dogfood ? "dogfood" : "local",
    milestone: options.dogfood ? options.config.dogfood.milestone : undefined,
    input_hashes: inputHashes
  };

  await writeJson(path.join(outputDir, "manifest.json"), manifest);
  await writeJson(path.join(inputsDir, "specs.index.json"), specIndex);
  await writeJson(path.join(inputsDir, "changed_files.json"), {
    schema_version: "review-surfaces.changed_files.v1",
    base_ref: options.baseRef,
    head_ref: options.headRef,
    files: changedFiles
  });
  await writeJson(path.join(inputsDir, "commits.json"), {
    schema_version: "review-surfaces.commits.v1",
    commits
  });
  await writeJson(path.join(inputsDir, "docs.index.json"), {
    schema_version: "review-surfaces.docs.index.v1",
    docs
  });
  await writeJson(path.join(inputsDir, "tests.index.json"), {
    schema_version: "review-surfaces.tests.index.v1",
    tests
  });
  await writeJson(path.join(inputsDir, "feedback.index.json"), {
    schema_version: "review-surfaces.feedback.index.v1",
    feedback
  });
  await writeJson(path.resolve(options.cwd, commandsOutputPath), {
    schema_version: "review-surfaces.commands.v1",
    transcripts: commandTranscripts
  });
  await writeJson(path.join(inputsDir, "privacy.json"), {
    schema_version: "review-surfaces.privacy.v1",
    ...privacy
  });
  await writeText(path.join(inputsDir, "diff.patch"), redactedDiff.text);

  return {
    cwd: options.cwd,
    outputDir,
    manifest,
    specIndex,
    changedFiles,
    docs,
    tests,
    feedback,
    commandTranscripts,
    commandTranscriptOutputPath: commandsOutputPath,
    repositoryFiles,
    privacy,
    git
  };
}

function classifyDoc(filePath: string): string {
  if (filePath === "AGENTS.md" || filePath === "CLAUDE.md") {
    return "agent_instruction";
  }
  if (filePath.endsWith("/SKILL.md")) {
    return "agent_skill";
  }
  return "doc";
}

function normalizeRelativeDir(dirPath: string): string {
  return dirPath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}
