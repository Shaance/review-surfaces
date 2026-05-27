import path from "node:path";
import { AcaiSpecIndex, indexAcaiSpecs } from "../acai/acai";
import { ReviewSurfacesConfig } from "../config/config";
import { expandPatterns } from "../core/glob";
import { ensureDir, hashFile, writeJson, writeText } from "../core/files";
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
  outputDir: string;
  manifest: RunManifest;
  specIndex: AcaiSpecIndex;
  changedFiles: ChangedFile[];
  docs: Array<{ path: string; kind: string }>;
  tests: Array<{ path: string; kind: string }>;
  git: GitInfo;
}

export interface CollectOptions {
  cwd: string;
  config: ReviewSurfacesConfig;
  baseRef: string;
  headRef: string;
  outputDir?: string;
  dogfood: boolean;
}

export async function collectInputs(options: CollectOptions): Promise<CollectionResult> {
  const outputDir = path.resolve(options.cwd, options.outputDir ?? options.config.output_dir);
  const inputsDir = path.join(outputDir, "inputs");
  await ensureDir(inputsDir);

  const specPaths = await expandPatterns(options.cwd, options.config.specs);
  const docPaths = await expandPatterns(options.cwd, options.config.docs);
  const testPaths = await expandPatterns(options.cwd, options.config.tests);
  const specIndex = await indexAcaiSpecs(options.cwd, specPaths);
  const git = collectGitInfo(options.cwd, options.baseRef, options.headRef);
  const changedFiles = collectChangedFiles(options.cwd, options.baseRef, options.headRef);
  const diff = collectDiff(options.cwd, options.baseRef, options.headRef);
  const commits = collectCommits(options.cwd, options.baseRef, options.headRef);

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
    docs: docPaths.map((docPath) => ({ path: docPath, kind: classifyDoc(docPath) }))
  });
  await writeJson(path.join(inputsDir, "tests.index.json"), {
    schema_version: "review-surfaces.tests.index.v1",
    tests: testPaths.map((testPath) => ({ path: testPath, kind: "test" }))
  });
  await writeText(path.join(inputsDir, "diff.patch"), diff);

  return {
    outputDir,
    manifest,
    specIndex,
    changedFiles,
    docs: docPaths.map((docPath) => ({ path: docPath, kind: classifyDoc(docPath) })),
    tests: testPaths.map((testPath) => ({ path: testPath, kind: "test" })),
    git
  };
}

function classifyDoc(filePath: string): string {
  if (filePath === "AGENTS.md") {
    return "agent_instruction";
  }
  if (filePath.endsWith("/SKILL.md")) {
    return "agent_skill";
  }
  return "doc";
}
