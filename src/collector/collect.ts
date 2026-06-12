import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AcaiSpecIndex, indexAcaiSpecs } from "../acai/acai";
import { CommandTranscript, commandTranscriptInputDir, commandTranscriptOutputPath, indexCommandTranscriptFiles } from "../commands/transcripts";
import { ReviewSurfacesConfig } from "../config/config";
import { filterPathsByPatterns, walkFiles } from "../core/glob";
import { ensureDir, fileExists, hashFile, isRegularFile, writeJson, writeText } from "../core/files";
import { VERSION } from "../core/version";
import { compareStrings } from "../core/compare";
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
import { ChangedFile, collectChangedFiles, collectCommits, collectDiff, collectGitInfo, commitTimeAtRef, gitInfoDiagnostics, GitInfo, isCurrentStateHeadRequest, readFileBytesAtRef } from "./git";
import { LcovCoverage, looksLikeLcov, parseLcov } from "../tests-evidence/lcov";
import { parseStructuredDiff } from "./diff-hunks";

export const REPO_INDEX_SCHEMA_VERSION = "review-surfaces.repo.index.v1";

export const TOOL_VERSION = VERSION;

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

export interface CoverageProvenance {
  source_path: string;
  algorithm: "sha256";
  hash: string;
  head_committed_at?: string;
  report_modified_at?: string;
  // False when the report predates the head commit: a stale report must be
  // marked stale, never trusted (review-surfaces.COVERAGE.2).
  postdates_head: boolean;
}

export interface RunManifest {
  tool_version: string;
  created_at: string;
  repo: string;
  base_ref: string;
  head_ref: string;
  base_sha?: string;
  head_sha: string;
  // COLD_START.7: how many files in the changed set came from the working tree
  // (uncommitted edits / untracked files) rather than the base...head range.
  // Always present (0 on a clean or pinned-head run) so renderers can announce
  // a dirty literal-HEAD review on every human surface.
  uncommitted_files: number;
  run_mode: PacketRunMode;
  milestone?: string;
  input_hashes: ManifestInputHash[];
  // review-surfaces.COVERAGE.2: provenance of an ingested lcov coverage report
  // (path, content hash, whether it postdates the head commit). Present only
  // when a report was found, so no-coverage runs stay byte-stable.
  coverage?: CoverageProvenance;
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
    // Per-file blocked-secret findings computed from the RAW diff's ADDED lines
    // (path + line + pattern kinds, never the secret text). The provenance the
    // secret_in_diff risk consumes — a literal [REDACTED:...] placeholder in the
    // raw text matches no secret pattern, so it can never appear here.
    secret_findings: SecretFinding[];
  };
  git: GitInfo;
  // R6: human-readable collection warnings (unresolved base ref, working-tree
  // diff fallback, not-a-git-repo). Surfaced to stderr by the CLI; NOT written
  // into any byte-stable on-disk artifact (the manifest write below lists its
  // fields explicitly and nothing spreads the whole collection into a packet).
  diagnostics: string[];
  // R6: whether the diff/changed-file set came from the base...head range or
  // fell back to a bare working-tree diff (e.g. base ref did not resolve).
  diff_source: "range" | "working_tree_fallback";
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

// COLD_START.7: canonical artifact names for the ROOT-output-dir exclusion
// ("--out ." / output_dir "."), where artifacts sit next to repository files
// and prefix matching cannot tell them apart. Everything `all`, `human`, and
// `comment` write at the output-dir top level belongs here (feedback/ stays
// reviewable on purpose). Pinned by the COLD_START.7 double-run test in
// tests/range-truth.test.ts.
const ROOT_ARTIFACT_DIR_PREFIXES = ["inputs/", "diagrams/", "commands/", "prompts/"];
const ROOT_ARTIFACT_FILES = new Set([
  "manifest.json",
  "review_packet.json",
  "review_packet.md",
  "intent.yaml",
  "evaluation.yaml",
  "methodology.yaml",
  "risks.yaml",
  "architecture.md",
  "dogfood.yaml",
  "agent_handoff.md",
  "human_review.json",
  "human_review.md",
  "human_review.html",
  "review_queue.md",
  "suggested_comments.md",
  "trust_audit.md",
  "risk_lenses.md",
  "intent_mismatch.md",
  "review_routes.md",
  "evidence_cards.md",
  "since_last_review.md",
  "test_plan.md",
  "comment.md",
  "review.sarif",
  "pending_review.json",
  "pr_review_surface.json",
  "eval_scoreboard.json"
]);

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
  // Feedback lives under the (possibly custom) output dir, so the `review`
  // walkthrough writing to `<out>/feedback/*.yaml` is ingested on the next run
  // regardless of --out. `repositoryFiles` are repo-relative, so relativize the
  // (possibly absolute) resolved output dir before globbing — via realpath on
  // both, so a symlinked temp/cwd prefix (e.g. macOS /var vs /private/var) does
  // not produce a `../…` mismatch. Defaults to `.review-surfaces/feedback/*.yaml`.
  //
  // Deliberate boundary: an output dir OUTSIDE the checkout is not ingested. This
  // tool is local-first — artifacts (and their feedback) belong with the repo —
  // and an absolute out-of-repo path in feedback evidence would inject
  // machine-specific paths into otherwise byte-stable artifacts, breaking the
  // determinism / locale-invariance gates. Keep the output dir within the repo.
  const outputDirRelative = normalizeRelativeDir(path.relative(realpathOrSelf(options.cwd), realpathOrSelf(outputDir)));
  // An output dir AT the repo root (`--out .`) relativizes to "", so glob the
  // bare `feedback/*.yaml` rather than a leading-slash `/feedback/*.yaml`.
  const feedbackGlob = outputDirRelative ? `${outputDirRelative}/feedback/*.yaml` : "feedback/*.yaml";
  // COLD_START.7: the tool's own artifacts are never part of the reviewed
  // change set. Both the CURRENT effective out dir and the CONFIGURED
  // output_dir count as artifact locations (a run with --out elsewhere still
  // sees a prior default-located run's artifacts in the working tree). A ROOT
  // output dir ("--out ." / output_dir ".") relativizes to "", where prefix
  // matching cannot tell artifacts from repository files, so the canonical
  // artifact names are excluded there instead — pinned by the COLD_START.7
  // double-run test. Applied only to pure working-tree entries (see
  // collectChangedFiles): a COMMITTED change to a tracked artifact such as
  // this repo's .review-surfaces/agent_handoff.md stays reviewable.
  const configOutputDirRelative = normalizeRelativeDir(
    path.relative(realpathOrSelf(options.cwd), realpathOrSelf(path.resolve(options.cwd, options.config.output_dir)))
  );
  const artifactDirs = [...new Set([outputDirRelative, configOutputDirRelative])];
  const artifactDirPrefixes = artifactDirs
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => `${dir}/`);
  const rootOutputDir = artifactDirs.some((dir) => dir === "");
  const isArtifactPath = (filePath: string): boolean =>
    artifactDirPrefixes.some((prefix) => filePath.startsWith(prefix)) ||
    (rootOutputDir &&
      (ROOT_ARTIFACT_DIR_PREFIXES.some((prefix) => filePath.startsWith(prefix)) ||
        ROOT_ARTIFACT_FILES.has(filePath)));
  const feedbackPaths = filterPathsByPatterns(repositoryFiles, [feedbackGlob]);
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
  // R6: collect human-readable degradation warnings from the git layer
  // (unresolved base ref, working-tree diff fallback, not-a-git-repo) and the
  // resolved diff source. These are surfaced to stderr by the CLI; they are NOT
  // serialized into any byte-stable artifact.
  const diagnostics: string[] = [];
  const git = collectGitInfo(options.cwd, options.baseRef, options.headRef);
  diagnostics.push(...gitInfoDiagnostics(options.cwd, options.baseRef));
  // COLD_START.7: working-tree/untracked files merge into the changed set only
  // for a literal-HEAD review; an explicitly pinned head gets the pure range.
  const includeWorkingTree = isCurrentStateHeadRequest(options.cwd, options.headRef);
  const changedFilesResult = collectChangedFiles(options.cwd, options.baseRef, options.headRef, includeWorkingTree, isArtifactPath);
  diagnostics.push(...changedFilesResult.diagnostics);
  const allChangedFiles = changedFilesResult.files;
  const changedFiles = allChangedFiles.filter((file) => !ignore.isIgnored(file.path));
  const ignoredChangedFiles = allChangedFiles.filter((file) => ignore.isIgnored(file.path)).map((file) => file.path);
  const diffResult = collectDiff(options.cwd, options.baseRef, options.headRef, includeWorkingTree);
  diagnostics.push(...diffResult.diagnostics);
  // COLD_START.7: keep diff.patch consistent with the changed-file set — drop
  // hunks for artifact paths that are not reviewed changes (pure working-tree
  // artifact churn; range hunks for such paths cannot exist, so range content
  // is untouched). Without this, structured-diff consumers parsed artifact
  // churn the changed-file set had already excluded.
  const reviewedPaths = new Set(allChangedFiles.map((file) => file.path));
  const rawDiff = filterIgnoredDiff(
    diffResult.text,
    (filePath) => isArtifactPath(filePath) && !reviewedPaths.has(filePath)
  );
  const diffSource = diffResult.diffSource;
  const filteredDiff = filterIgnoredDiff(rawDiff, ignore.isIgnored);
  // R4.6 (mirror of provider.ts split): ALWAYS compute the secret-block signal
  // so a PEM/provider-token in the diff sets remote_provider_blocked regardless
  // of redact_secrets. Only substitute the redacted text onto disk when
  // redact_secrets is true; when false, keep the raw filtered diff on disk but
  // still honor the computed block.
  const secretScan = redactSecrets(filteredDiff);
  const redactedDiff = options.config.privacy.redact_secrets
    ? secretScan
    : { text: filteredDiff, redactions: [], blocked: secretScan.blocked };
  const commits = collectCommits(options.cwd, options.baseRef, options.headRef);
  const docs = docPaths.map((docPath) => ({ path: docPath, kind: classifyDoc(docPath) }));
  const tests = testPaths.map((testPath) => ({ path: testPath, kind: "test" }));
  const repoIndex = buildRepoIndex({ cwd: options.cwd, changedFiles, repositoryFiles });
  const privacy = {
    ignore_file: ignore.ignoreFile,
    ignore_patterns: ignore.patterns,
    ignored_changed_files: ignoredChangedFiles,
    diff_redactions: redactedDiff.redactions,
    remote_provider_blocked: redactedDiff.blocked,
    secret_findings: collectSecretFindings(filteredDiff)
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
  // COLD_START.7: a pinned-head review hashes the COMMITTED blobs at the head,
  // not the working tree — otherwise a dirty checkout perturbs the cache
  // signature (and the manifest embedded in review_packet.json) while
  // changed_files.json and diff.patch stay pure.
  const changedFileHashes = await hashChangedFiles(options.cwd, changedFiles, {
    useWorktree: includeWorkingTree,
    headSha: git.head_sha
  });

  // Content-hash every flag-supplied input file that materially shapes the
  // packet but is NOT discovered through the repo walk (so it never lands in
  // input_hashes or changed_files): the --conversation log, --test-output
  // report(s), --coverage summary, --agent-input payload, and the resolved
  // config file. These are typically gitignored or live outside the diff, so
  // omitting them left a stale-cache hole: editing one yielded the same key.
  // Missing files hash to a sentinel so toggling a flag on/off still moves the
  // key. Kind is part of the fingerprint so two flags pointing at the same path
  // never collide.
  // review-surfaces.COVERAGE.1: resolve the lcov report — the explicit
  // --coverage path when its content is lcov, else auto-detected
  // coverage/lcov.info. The istanbul coverage-summary path keeps flowing to
  // ingestTestOutputs unchanged.
  const lcovSource = resolveLcovSource(options.cwd, options.coverageOutputPath);

  const flagInputHashes = await hashFlagInputs(options.cwd, [
    { kind: "conversation", path: options.conversationPath },
    { kind: "coverage", path: options.coverageOutputPath },
    { kind: "coverage-lcov", path: lcovSource?.sourcePath },
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
    uncommitted_files: changedFiles.filter((file) => file.source === "working_tree").length,
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
  const coverageRecord = lcovSource
    ? buildCoverageRecord(options.cwd, git.head_sha, lcovSource, changedFiles.map((file) => file.path))
    : undefined;
  if (coverageRecord) {
    manifest.coverage = coverageRecord.provenance;
    await writeJson(path.join(inputsDir, "coverage.json"), {
      schema_version: "review-surfaces.coverage.v1",
      ...coverageRecord.provenance,
      files: coverageRecord.coverage.files
    });
  } else {
    // A reused --out dir must not leak a PRIOR run's report into this run: no
    // current report means "no coverage evidence" (COVERAGE.4), so remove any
    // stale inputs/coverage.json.
    fs.rmSync(path.join(inputsDir, "coverage.json"), { force: true });
  }

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
    git,
    // Insertion-ordered + deduped so the CLI's stderr output is stable and free
    // of duplicate warnings (the same base-ref failure can surface from both the
    // git-info step and the changed-files/diff fallbacks).
    diagnostics: [...new Set(diagnostics)],
    diff_source: diffSource
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

async function hashChangedFiles(
  cwd: string,
  changedFiles: ChangedFile[],
  // COLD_START.7: current-state reviews hash working-tree bytes (the content
  // under review); pinned-head reviews hash the committed blobs at the head so
  // a dirty checkout cannot perturb the signature. A path with no blob at the
  // head (a range deletion) hashes to the "missing" sentinel either way.
  head: { useWorktree: boolean; headSha: string }
): Promise<ChangedFileHash[]> {
  const hashes: ChangedFileHash[] = [];
  for (const file of changedFiles) {
    let hash = "missing";
    if (head.useWorktree) {
      const absolute = path.resolve(cwd, file.path);
      if (isRegularFile(absolute)) {
        try {
          hash = await hashFile(absolute);
        } catch {
          hash = "unreadable";
        }
      }
    } else {
      const blob = readFileBytesAtRef(cwd, head.headSha, file.path);
      if (blob !== undefined) {
        hash = crypto.createHash("sha256").update(blob).digest("hex");
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
export interface SecretFinding {
  path: string;
  line?: number;
  kinds: string[];
}

// Scan the RAW (pre-redaction) diff's ADDED lines for blocked secret patterns,
// recording path + line + kind only. Per-line scanning anchors single-line
// tokens exactly; a per-HUNK joined pass catches multi-line secrets (private
// keys) without synthesizing a "key" from BEGIN/END markers that live in
// different hunks (e.g. documentation examples). One finding per (file, kind),
// each anchored to its own matching line.
function collectSecretFindings(rawDiff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of parseStructuredDiff(rawDiff).files) {
    const lineByKind = new Map<string, number | undefined>();
    for (const hunk of file.hunks) {
      const added = hunk.lines.filter((line) => line.kind === "add");
      for (const line of added) {
        const redaction = redactSecrets(line.text);
        if (!redaction.blocked) {
          continue;
        }
        for (const entry of redaction.redactions.filter((r) => r.blocked)) {
          if (!lineByKind.has(entry.kind)) {
            lineByKind.set(entry.kind, line.new_line);
          }
        }
      }
      if (added.length > 1) {
        // Multi-line secrets (BEGIN/END private keys) never match per line; the
        // join stays WITHIN one hunk so non-contiguous markers cannot combine.
        const joined = redactSecrets(added.map((line) => line.text).join("\n"));
        if (joined.blocked) {
          for (const entry of joined.redactions.filter((r) => r.blocked)) {
            if (!lineByKind.has(entry.kind)) {
              lineByKind.set(
                entry.kind,
                added.find((line) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line.text))?.new_line ?? added[0]?.new_line
              );
            }
          }
        }
      }
    }
    for (const [kind, line] of lineByKind) {
      const finding: SecretFinding = { path: file.path, kinds: [kind] };
      if (line !== undefined) {
        finding.line = line;
      }
      findings.push(finding);
    }
  }
  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.kinds[0] < b.kinds[0] ? -1 : 1));
  return findings;
}

interface LcovSource {
  sourcePath: string;
  text: string;
}

function resolveLcovSource(cwd: string, coverageOutputPath: string | undefined): LcovSource | undefined {
  // An explicit --coverage pointing at the istanbul SUMMARY must not disable the
  // documented auto channel: try the explicit path first, then coverage/lcov.info.
  const candidates = coverageOutputPath ? [coverageOutputPath, "coverage/lcov.info"] : ["coverage/lcov.info"];
  for (const candidate of candidates) {
    const absolute = path.resolve(cwd, candidate);
    if (!isRegularFile(absolute)) {
      continue;
    }
    try {
      const text = fs.readFileSync(absolute, "utf8");
      if (looksLikeLcov(text)) {
        return { sourcePath: candidate, text };
      }
    } catch {
      // Unreadable report -> no coverage evidence, never a guess.
    }
  }
  return undefined;
}

function buildCoverageRecord(
  cwd: string,
  headSha: string,
  source: LcovSource,
  changedPaths: string[]
): { provenance: CoverageProvenance; coverage: LcovCoverage } | undefined {
  const coverage = parseLcov(source.text, cwd);
  if (!coverage) {
    return undefined;
  }
  const hash = crypto.createHash("sha256").update(source.text).digest("hex");
  const headCommittedAt = headSha !== "unknown" ? commitTimeAtRef(cwd, headSha) : undefined;
  let reportModifiedAt: string | undefined;
  try {
    reportModifiedAt = fs.statSync(path.resolve(cwd, source.sourcePath)).mtime.toISOString();
  } catch {
    reportModifiedAt = undefined;
  }
  // Unknown timestamps degrade conservatively: without both times we cannot
  // prove the report postdates the reviewed code, so it is marked stale. The
  // reviewed code includes WORKING-TREE edits (collectDiff appends staged +
  // unstaged changes), so a changed file edited on disk after the report also
  // marks it stale — the report never measured that code.
  const reportTime = reportModifiedAt ? Date.parse(reportModifiedAt) : Number.NaN;
  let newestChangedMtime = 0;
  for (const changedPath of changedPaths) {
    try {
      newestChangedMtime = Math.max(newestChangedMtime, fs.statSync(path.resolve(cwd, changedPath)).mtime.getTime());
    } catch {
      // Deleted changed files have no on-disk mtime; the head-commit check covers them.
    }
  }
  const postdatesHead = Boolean(
    headCommittedAt &&
      reportModifiedAt &&
      reportTime >= Date.parse(headCommittedAt) &&
      reportTime >= newestChangedMtime
  );
  return {
    provenance: {
      source_path: source.sourcePath,
      algorithm: "sha256",
      hash,
      head_committed_at: headCommittedAt,
      report_modified_at: reportModifiedAt,
      postdates_head: postdatesHead
    },
    coverage
  };
}

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
      .sort((left, right) => compareStrings(left.path, right.path))
      .map((entry) => ({ path: entry.path, kind: entry.kind, hash: entry.hash })),
    changed_files: [...input.changedFileHashes]
      .sort((left, right) => compareStrings(left.path, right.path))
      .map((entry) => ({ path: entry.path, status: entry.status, hash: entry.hash })),
    // Sorted by kind then path so the key is independent of the order flags were
    // supplied. Empty when no flag-input files were given, leaving the default
    // (no-flag) signature byte-identical to before this addition.
    flag_inputs: [...input.flagInputHashes]
      .sort((left, right) => compareStrings(left.kind, right.kind) || compareStrings(left.path, right.path))
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

// Canonicalize a path, falling back to the input when it does not resolve, so a
// symlinked cwd/output prefix does not skew a path.relative() between them.
function realpathOrSelf(dirPath: string): string {
  try {
    return fs.realpathSync(dirPath);
  } catch {
    return dirPath;
  }
}
