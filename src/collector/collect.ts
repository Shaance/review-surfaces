import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AcaiSpecIndex, indexAcaiSpecs } from "../acai/acai";
import { CommandTranscript, commandTranscriptInputDir, commandTranscriptOutputPath, indexCommandTranscriptFiles } from "../commands/transcripts";
import { ReviewSurfacesConfig } from "../config/config";
import { filterPathsByPatterns, walkFiles } from "../core/glob";
import { ensureDir, fileExists, hashFile, isRegularFile, writeJson, writeText } from "../core/files";
import { FeedbackFile, indexFeedbackFiles } from "../feedback/feedback";
import { filterIgnoredDiff } from "../privacy/diff";
import { loadPrivacyIgnore } from "../privacy/ignore";
import { SecretRedaction, redactSecrets } from "../privacy/secrets";
import { buildRepoIndex, RepoIndex } from "../indexer/indexer";
import type { PacketRunMode } from "../schema/review-packet-contract";
import {
  emptyTestResults,
  ingestTestOutputs,
  TEST_RESULTS_OUTPUT_FILENAME,
  TEST_RESULTS_SCHEMA_VERSION,
  TestResults
} from "../tests-evidence/junit";
import { ChangedFile, collectChangedFiles, collectCommits, collectDiff, collectGitInfo, GitInfo } from "./git";

export const REPO_INDEX_SCHEMA_VERSION = "review-surfaces.repo.index.v1";

export const TOOL_VERSION = "0.1.0";

// A frozen-clock provider: a fixed ISO string or a function returning one. When
// the CLI passes a fixed string (from --now) two runs with the same inputs
// produce byte-identical artifacts; without it the default real wall clock is
// used and behavior is unchanged.
export type NowProvider = string | (() => string);

function resolveNow(now: NowProvider | undefined): string {
  if (typeof now === "function") {
    return now();
  }
  if (typeof now === "string") {
    return now;
  }
  return new Date().toISOString();
}

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
  run_mode: PacketRunMode;
  milestone?: string;
  input_hashes: ManifestInputHash[];
  // Deterministic cache key over the meaningful inputs (tool version, base/head
  // sha, provider, model, hashed input files, AND content hashes of every
  // changed file). Excludes created_at and the --out path so frozen-clock and
  // path changes never perturb it. Used by --cache to detect unchanged inputs.
  signature?: string;
  // Round 8 (FINDING B + FINDING C) — per-artifact provenance. Maps a stage
  // artifact file name (intent.yaml, evaluation.yaml, risks.yaml,
  // review_packet.json, ...) to the collection signature it was PRODUCED from.
  // collect carries the prior map FORWARD verbatim (so a stage that only rewrote
  // manifest.json leaves the old producing signature visible as the staleness
  // signal); each stage re-stamps the artifacts it actually (re)writes with the
  // current signature. Reuse (compose / --cache) is gated on an artifact's OWN
  // recorded signature matching the current signature, not on `signature` above.
  artifact_signatures?: Record<string, string>;
}

// A changed file plus a content hash of its current working-tree bytes. Folding
// these into the signature is what makes a source edit a cache miss: hashing
// only the spec/doc inputs (as input_hashes does) would leave the key STALE.
export interface ChangedFileHash {
  path: string;
  status: string;
  source: string;
  algorithm: "sha256";
  hash: string;
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
  testResults: TestResults;
  repositoryFiles: string[];
  repoIndex: RepoIndex;
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
  testOutputPaths?: string[];
  coverageOutputPath?: string;
  dogfood: boolean;
  // Frozen-clock provider for byte-reproducible artifacts. Absent => real wall
  // clock (unchanged default behavior).
  now?: NowProvider;
  // Resolved provider/model folded into the manifest signature so a
  // provider/model swap is a cache miss. Absent => omitted from the fingerprint.
  provider?: string;
  model?: string;
  // Resolved --conversation file path (text/markdown/jsonl/yaml log) consumed by
  // buildMethodology. Folded into the signature so a conversation edit is a cache
  // miss. Absent => no conversation flag was supplied.
  conversationPath?: string;
  // Resolved --agent-input file path consumed by the agent-file provider. Folded
  // into the signature so a changed hypothesis set is a cache miss. Absent => no
  // agent-input flag was supplied.
  agentInputPath?: string;
  // Resolved config file path actually loaded by loadConfig (review-surfaces.config.yaml
  // or a --config override). Its content drives review areas, globs, privacy, and
  // the quality gate, so it is folded into the signature. Absent (no file on disk)
  // => the built-in defaults were used and there is nothing to hash.
  configPath?: string;
  // Resolved --previous-packet path (the concrete review_packet.json the dogfood
  // comparison reads). Folded into the signature (path + content) so that changing
  // which baseline a dogfood run compares against — or editing that baseline's
  // bytes — is a cache miss. Without this, a --cache run could restore an old
  // packet whose dogfood.comparison / agent_handoff.changes_since_last_packet was
  // computed against a stale baseline. Absent => no --previous-packet flag.
  previousPacketPath?: string;
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
  // Phase 5a: ingest structured test output (JUnit XML + optional coverage).
  // When --test-output is absent this is the empty result and nothing changes.
  const testOutputPaths = options.testOutputPaths ?? [];
  const testResults =
    testOutputPaths.length > 0 || options.coverageOutputPath
      ? ingestTestOutputs(options.cwd, testOutputPaths, options.coverageOutputPath)
      : emptyTestResults();
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
  const repoIndex = buildRepoIndex({ cwd: options.cwd, changedFiles, repositoryFiles });
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

  // Content-hash every changed file's CURRENT working-tree bytes so a source
  // edit perturbs the signature (a cache key that ignored changed source would
  // be stale). Missing/unreadable files hash to a sentinel so deletions still
  // register as a change.
  const changedFileHashes = await hashChangedFiles(options.cwd, changedFiles);

  // Content-hash every flag-supplied input file that materially shapes the
  // packet but is NOT discovered through the repo walk (so it never lands in
  // input_hashes or changed_files): the --conversation log, --test-output
  // report(s), --coverage summary, --agent-input payload, and the resolved
  // config file. These are typically gitignored or live outside the diff, so
  // omitting them left a stale-cache hole: editing one yielded the same key.
  // Missing files hash to a sentinel so toggling a flag on/off still moves the
  // key. Kind is part of the fingerprint so two flags pointing at the same path
  // never collide.
  const flagInputHashes = await hashFlagInputs(options.cwd, [
    { kind: "conversation", path: options.conversationPath },
    { kind: "coverage", path: options.coverageOutputPath },
    { kind: "agent-input", path: options.agentInputPath },
    { kind: "config", path: options.configPath },
    { kind: "previous-packet", path: options.previousPacketPath },
    ...testOutputPaths.map((testPath) => ({ kind: "test-output", path: testPath }))
  ]);

  // Resolve run_mode/milestone ONCE so the same values feed both the signature
  // and the manifest. They are part of the fingerprint so a dogfood --cache run
  // can never match a non-dogfood cached signature: a restored local-mode packet
  // would be missing the schema-required dogfood + agent_handoff sections.
  const runMode: RunManifest["run_mode"] = options.dogfood ? "dogfood" : "local";
  const milestone = options.dogfood ? options.config.dogfood.milestone : undefined;

  const signature = computeSignature({
    toolVersion: TOOL_VERSION,
    baseSha: git.base_sha,
    headSha: git.head_sha,
    provider: options.provider,
    model: options.model,
    runMode,
    milestone,
    inputHashes,
    changedFileHashes,
    flagInputHashes
  });

  const manifest: RunManifest = {
    tool_version: TOOL_VERSION,
    created_at: resolveNow(options.now),
    repo: git.repo,
    base_ref: options.baseRef,
    head_ref: options.headRef,
    base_sha: git.base_sha,
    head_sha: git.head_sha,
    run_mode: runMode,
    milestone,
    input_hashes: inputHashes,
    signature
  };

  // FINDING B + FINDING C: carry the PRIOR per-artifact provenance map forward so
  // a stale artifact (one whose owning stage did not rerun this collection) keeps
  // its old producing signature visible. collect itself produces NO stage artifact
  // (intent/evaluation/risks/packet), so it never advances any entry to the new
  // signature here; each stage re-stamps the artifacts it actually rewrites. When
  // the inputs changed, the carried-over entries no longer match the new signature
  // and downstream reuse correctly recomputes. Read BEFORE overwriting the manifest.
  //
  // artifact_signatures lives ONLY in the on-disk manifest.json (which already
  // varies by created_at). It is intentionally NOT added to the returned in-memory
  // manifest: that object is embedded verbatim into review_packet.json, and folding
  // a carried-forward map into it would break byte-stability across two identical
  // frozen-clock runs (run 2 would carry forward run 1's map). The provenance
  // readers (cache snapshot, per-artifact loaders, artifact stamping) all go
  // through the pipeline artifact store, which reads the on-disk manifest.json
  // directly, so they see the map regardless.
  const priorArtifactSignatures = readPriorArtifactSignatures(path.join(outputDir, "manifest.json"));
  await writeJson(path.join(outputDir, "manifest.json"), {
    ...manifest,
    ...(priorArtifactSignatures ? { artifact_signatures: priorArtifactSignatures } : {})
  });
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
  await writeJson(path.join(inputsDir, "repo.index.json"), {
    schema_version: REPO_INDEX_SCHEMA_VERSION,
    files: repoIndex.files,
    ecosystems: repoIndex.ecosystems,
    clusters: repoIndex.clusters
  });
  await writeJson(path.join(inputsDir, "feedback.index.json"), {
    schema_version: "review-surfaces.feedback.index.v1",
    feedback
  });
  await writeJson(path.resolve(options.cwd, commandsOutputPath), {
    schema_version: "review-surfaces.commands.v1",
    transcripts: commandTranscripts
  });
  // Only materialize tests.results.json when structured test output was actually
  // supplied, so the default pipeline (no --test-output) stays byte-stable.
  if (testOutputPaths.length > 0 || options.coverageOutputPath) {
    await writeJson(path.join(inputsDir, TEST_RESULTS_OUTPUT_FILENAME), {
      schema_version: TEST_RESULTS_SCHEMA_VERSION,
      suites: testResults.suites,
      cases: testResults.cases,
      totals: testResults.totals,
      coverage: testResults.coverage,
      source_paths: testResults.source_paths
    });
  }
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
    testResults,
    repositoryFiles,
    repoIndex,
    privacy,
    git
  };
}

// FINDING B + FINDING C: read the prior manifest's artifact_signatures map (if
// any) so collect can carry it forward verbatim. Returns undefined when there is
// no prior map (first run / corrupt manifest), keeping the manifest byte-identical
// to before this addition when no provenance has been recorded yet.
function readPriorArtifactSignatures(manifestPath: string): Record<string, string> | undefined {
  if (!fileExists(manifestPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const map = parsed && typeof parsed === "object" ? parsed.artifact_signatures : undefined;
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      return undefined;
    }
    const result: Record<string, string> = {};
    for (const key of Object.keys(map as Record<string, unknown>).sort()) {
      const value = (map as Record<string, unknown>)[key];
      if (typeof value === "string") {
        result[key] = value;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

async function hashChangedFiles(cwd: string, changedFiles: ChangedFile[]): Promise<ChangedFileHash[]> {
  const hashes: ChangedFileHash[] = [];
  for (const file of changedFiles) {
    let hash = "missing";
    const absolute = path.resolve(cwd, file.path);
    if (isRegularFile(absolute)) {
      try {
        hash = await hashFile(absolute);
      } catch {
        hash = "unreadable";
      }
    }
    hashes.push({ path: file.path, status: file.status, source: file.source, algorithm: "sha256", hash });
  }
  return hashes;
}

// A flag-supplied input file plus a content hash of its current bytes. Kind +
// resolved path + hash fold into the signature so editing the file (or toggling
// the flag, via the "missing" sentinel) is a cache miss.
export interface FlagInputHash {
  kind: string;
  path: string;
  algorithm: "sha256";
  hash: string;
}

// Hash each present flag-input file (entries with no path are skipped: the flag
// was not supplied, and an absent flag means there is nothing in the fingerprint
// to change). A supplied-but-missing/unreadable file hashes to a sentinel so a
// later create/repair still moves the key.
async function hashFlagInputs(
  cwd: string,
  entries: Array<{ kind: string; path: string | undefined }>
): Promise<FlagInputHash[]> {
  const hashes: FlagInputHash[] = [];
  for (const entry of entries) {
    if (entry.path === undefined) {
      continue;
    }
    let hash = "missing";
    const absolute = path.resolve(cwd, entry.path);
    if (isRegularFile(absolute)) {
      try {
        hash = await hashFile(absolute);
      } catch {
        hash = "unreadable";
      }
    }
    hashes.push({ kind: entry.kind, path: entry.path, algorithm: "sha256", hash });
  }
  return hashes;
}

interface SignatureInput {
  toolVersion: string;
  baseSha?: string;
  headSha: string;
  provider?: string;
  model?: string;
  // run_mode (local|dogfood|...) and the dogfood milestone fold into the
  // fingerprint so a dogfood run never collides with a non-dogfood cached
  // signature (which would restore a packet missing dogfood/agent_handoff).
  runMode: RunManifest["run_mode"];
  milestone?: string;
  inputHashes: ManifestInputHash[];
  changedFileHashes: ChangedFileHash[];
  flagInputHashes: FlagInputHash[];
}

// Deterministic sha256 over a SORTED, canonical fingerprint of the meaningful
// inputs. Sorting both hash lists by path makes the key independent of input
// ordering; created_at and the --out path are intentionally excluded so the
// frozen clock and output location never change the signature.
function computeSignature(input: SignatureInput): string {
  const fingerprint = {
    tool_version: input.toolVersion,
    base_sha: input.baseSha ?? null,
    head_sha: input.headSha,
    provider: input.provider ?? null,
    model: input.model ?? null,
    // run_mode + milestone are part of the key so a dogfood --cache run NEVER
    // matches a non-dogfood cached signature: the cached local-mode packet would
    // be missing the schema-required dogfood + agent_handoff sections.
    run_mode: input.runMode,
    milestone: input.milestone ?? null,
    input_hashes: [...input.inputHashes]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => ({ path: entry.path, kind: entry.kind, hash: entry.hash })),
    changed_files: [...input.changedFileHashes]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => ({ path: entry.path, status: entry.status, hash: entry.hash })),
    // Sorted by kind then path so the key is independent of the order flags were
    // supplied. Empty when no flag-input files were given, leaving the default
    // (no-flag) signature byte-identical to before this addition.
    flag_inputs: [...input.flagInputHashes]
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path))
      .map((entry) => ({ kind: entry.kind, path: entry.path, hash: entry.hash }))
  };
  return crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
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
