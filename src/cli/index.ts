import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { formatReports, hasRequiredFailure, runBootstrap, runInit } from "../bootstrap/init";
import { recordCommandTranscript } from "../commands/runner";
import { commandTranscriptInputDir } from "../commands/transcripts";
import { collectInputs, CollectionResult } from "../collector/collect";
import { parseStructuredDiff } from "../collector/diff-hunks";
import { blobExistsAtRef, isGitRepo, isCurrentStateHeadRequest, readFileAtRef, resolveBaseRef, resolveGitRefSha, resolveMergeBaseSha } from "../collector/git";
import { computeSemanticChangeFacts, emptySemanticChangeFacts, SemanticChangeFacts } from "../risks/semantic-diff";
import { computeRankingEvidence, emptyRankingEvidence, RankingEvidence } from "../risks/ranking-evidence";
import { isTestPath } from "../scope/pr-scope";
import { intersectCoverageWithDiff } from "../tests-evidence/lcov";
import { parseBudgetDuration } from "../human/budget";
import { computeDependencyFacts } from "../risks/dependency-facts";
import { loadReviewPolicy, POLICY_FILE, ReviewPolicy } from "../feedback/policy";
import { computeConfigFacts } from "../risks/config-facts";
import { buildImportGraph, findSymbolImporters } from "../collector/import-graph";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { loadPrivacyIgnoreSync } from "../privacy/ignore";
import { inspectAndRedactSecrets } from "../privacy/secrets";
import { errorMessage, stripUndefined } from "../core/guards";
import type { CoverageEvidence } from "../human/contract";
import { PROVENANCE_ARTIFACTS } from "../collector/artifact-provenance";
import { loadConfig, ReviewSurfacesConfig } from "../config/config";
import { CliError, ExitCodes } from "../core/exit-codes";
import { VERSION } from "../core/version";
import { fileExists, readJson } from "../core/files";
import { isRecord } from "../core/guards";
import { FailOnSeverity, gateDecision, GateOptions } from "../core/gate";
import { buildArchitecture } from "../diagrams/diagrams";
import { buildDogfood, DogfoodComparisonInput } from "../dogfood/dogfood";
import { comparePackets, loadPreviousPacket, resolvePreviousPacketPath } from "../dogfood/compare";
import { EvaluationModel } from "../evaluation/evaluate";
import { buildIntent, IntentModel } from "../intent/intent";
import {
  effectiveModelId,
  enrichPacket,
  parseProviderName,
  providerFor,
  type ProviderName,
  type ReasoningProvider
} from "../llm/provider";
import { CONVERSATION_FORMATS, ConversationFormat } from "../conversation/events";
import {
  buildConversationReview,
  type ConversationReviewResult
} from "../conversation/review";
import { conversationReviewRisksFromPacket } from "./conversation-review-risks";
import { buildMethodology } from "../methodology/methodology";
import { buildReviewAreas } from "../review-areas/areas";
import { RisksModel } from "../risks/risks";
import { normalizeFeedbackRecord, type FeedbackFile } from "../feedback/feedback";
import { splitTestOutputPaths } from "../tests-evidence/junit";
import {
  createReviewPacket,
  writeArchitectureArtifact,
  writeEvaluationArtifact,
  writeHandoffArtifact,
  writeIntentArtifact,
  writeMethodologyArtifact,
  writeReviewPacket,
  writeRisksArtifact
} from "../render/packet";
import { loadEvaluation } from "../render/load";
import { renderCommentFromPacketFile, resolvePacketPath } from "../render/comment";
import { renderHumanPrComment, renderPrComment } from "../render/pr-comment";
import { renderStickySummary } from "../render/sticky-summary";
import { renderHumanReviewHtml } from "../human/render-html";
import { assemblePrReviewSurface } from "../pipeline/pr-surface";
import { evaluateBaseline } from "../evaluation/baseline";
import { PrReviewSurfaceModel, ReviewScope, StructuredDiff } from "../pr/contract";
import { renderSarifFromPacketFile } from "../render/sarif";
import { GateContext, projectRunSummary, readQueueIds, renderRunSummaryFromPacketFile, serializeRunSummary } from "../render/summary-json";
import { buildDraftReview } from "../render/draft-review";
import { postStickyComment } from "../render/post-comment";
import { writeJson, writeText } from "../core/files";
import { compareStrings } from "../core/compare";
import { PACKET_SCHEMA_VERSION, PACKET_SEVERITIES } from "../schema/review-packet-contract";
import { validateJsonFile, validateJsonSchema } from "../schema/json-schema";
import { packagedSchemaPath } from "../schema/packaged-schemas";
import { buildHumanReview, humanReviewConfigSignature } from "../human/human-review";
import { ChangedImportEdge, ChangeGraphAreaInsight, ChangeGraphEdgeInsight, computeChangedImportEdges } from "../human/change-graph";
import { buildChangeMapInsights, ChangeMapInsights } from "../human/change-map-insights";
import { ArchDriftResult, computeArchDriftFacts, moduleOf } from "../risks/arch-drift";
import { clusterOfPath, detectImplementationRoots, DEFAULT_IMPLEMENTATION_ROOTS } from "../core/source-roots";
import { EvalScoreboardSummary, HUMAN_REVIEW_DECISIONS, RoundsLedgerEntry } from "../human/contract";
import { buildChangeNarrative } from "../human/narrative";
import { ChangeNarrative, HumanReviewModel, ReviewQueueItem } from "../human/contract";
import { runWalkthrough, WalkthroughIO, WalkthroughOptions } from "../review/walkthrough";
import { stringifyYaml } from "../core/simple-yaml";
import {
  HUMAN_STANDALONE_ARTIFACTS,
  HumanRenderContext,
  humanStandaloneArtifactForCommand,
  writeHumanReviewArtifacts,
  writeHumanStandaloneArtifact
} from "../human/render";
import { ReviewPacket } from "../render/packet";
import {
  assembleEnrichedPacket,
  buildEnrichedModels,
  buildPipelineStageContext,
  computeArchitecture,
  computeArchitectureModel,
  computeEvaluation,
  computeEnrichedIntent,
  loadOrComputeEvaluation,
  loadOrComputeIntent,
  loadOrComputeMethodology,
  loadOrComputeRisks,
  notRequestedEnrichment,
  EnrichedModels,
  PipelineStageContext,
  runReasoningWithVerification
} from "../pipeline/stages";
import {
  artifactSignaturesFromManifest,
  createPipelineArtifactStore,
  createPipelineArtifactStoreForCollection
} from "../pipeline/artifact-store";

// review-surfaces.CLI.10: the canonical dispatch table. Exported so the CLI.10
// help-honesty test can assert every command here also appears in `--help`, and
// so the CLI.9 unknown-command path can suggest the nearest valid name.
export const COMMANDS = [
  "init",
  "bootstrap",
  "collect",
  "intent",
  "evaluate",
  "diagrams",
  "methodology",
  "risks",
  "dogfood",
  "handoff",
  "human",
  ...HUMAN_STANDALONE_ARTIFACTS.map((artifact) => artifact.command),
  "packet",
  "all",
  "validate",
  "scoreboard",
  "run",
  "comment",
  "review"
];

// review-surfaces.CLI.9: a cheap Levenshtein distance used to suggest the
// nearest valid command/flag for an unknown one. Bounded inputs (short command
// and flag names), so the naive O(m*n) table is plenty.
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) {
    dist[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    dist[0][j] = j;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
    }
  }
  return dist[a.length][b.length];
}

// review-surfaces.CLI.9: the nearest candidate by edit distance, or undefined
// when nothing is close enough (distance > half the longer string's length) so
// a wholly unrelated token does not get a misleading "did you mean".
function nearestMatch(value: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshtein(value, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  const threshold = Math.max(2, Math.floor(Math.max(value.length, best.length) / 2));
  return bestDistance <= threshold ? best : undefined;
}

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.help || parsed.command === "help") {
    printHelp();
    return ExitCodes.success;
  }

  // DISTRIBUTION.9: `--version` is the canonical first command after install;
  // it prints exactly the help header line (the shared VERSION constant the
  // version-sync tests pin to package.json) and exits 0.
  if (parsed.flags.version || parsed.command === "version") {
    console.log(`review-surfaces ${VERSION}`);
    return ExitCodes.success;
  }

  if (!COMMANDS.includes(parsed.command)) {
    // review-surfaces.CLI.9: an unknown command is a usage error that suggests
    // the nearest valid name and points at the full command list, rather than
    // failing with a bare "Unknown command".
    const suggestion = nearestMatch(parsed.command, COMMANDS);
    const hint = suggestion ? ` (did you mean '${suggestion}'?)` : "";
    throw new CliError(
      `Unknown command: ${parsed.command}${hint}. Run 'review-surfaces --help' for the full command list.`,
      ExitCodes.usageError
    );
  }

  if (humanStandaloneArtifactForCommand(parsed.command)) {
    await runHumanSubartifactStage(parsed);
    return ExitCodes.success;
  }

  switch (parsed.command) {
    case "collect":
      await runCollect(parsed);
      return ExitCodes.success;
    case "all":
      return runAll(parsed);
    case "validate":
      return runValidate(parsed);
    case "scoreboard":
      return runScoreboard(parsed);
    case "run":
      return runRecordedCommand(parsed);
    case "dogfood":
      return runAll(parsed);
    case "intent":
      await runIntentStage(parsed);
      return ExitCodes.success;
    case "evaluate":
      return runEvaluateStage(parsed);
    case "methodology":
      await runMethodologyStage(parsed);
      return ExitCodes.success;
    case "risks":
      await runRisksStage(parsed);
      return ExitCodes.success;
    case "diagrams":
      await runDiagramsStage(parsed);
      return ExitCodes.success;
    case "packet":
      return runPacketStage(parsed);
    case "handoff":
      await runHandoffStage(parsed);
      return ExitCodes.success;
    case "human":
      await runHumanStage(parsed);
      return ExitCodes.success;
    case "init":
      return runInitCommand(parsed);
    case "bootstrap":
      return runBootstrapCommand(parsed);
    case "comment":
      return runComment(parsed);
    case "review":
      return runReviewWalkthrough(parsed);
    default:
      throw new CliError(`Unhandled command: ${parsed.command}`, ExitCodes.runtimeError);
  }
}

async function runRecordedCommand(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  if (parsed.positionals.length === 0) {
    throw new CliError("Usage: review-surfaces run [--id <id>] [--command-transcripts <dir>] -- <command> [args...]", ExitCodes.usageError);
  }
  const result = await recordCommandTranscript({
    cwd,
    args: parsed.positionals,
    id: stringFlag(parsed, "id"),
    transcriptDir: stringFlag(parsed, "command-transcripts") ?? transcriptDirFromOut(parsed)
  });
  console.error(`Recorded command transcript to ${result.transcriptPath}`);
  return result.exitCode;
}

async function runInitCommand(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const { reports } = await runInit({ cwd, force: booleanFlag(parsed, "force") });
  console.log("review-surfaces init");
  console.log(formatReports(reports));
  return ExitCodes.success;
}

async function runBootstrapCommand(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const { reports } = await runBootstrap({ cwd });
  console.log("review-surfaces bootstrap");
  console.log(formatReports(reports));
  const strict = booleanFlag(parsed, "strict");
  if (strict && hasRequiredFailure(reports)) {
    console.error("Bootstrap quality gate failed: required scaffolding is missing or invalid. Run `review-surfaces init` first.");
    return ExitCodes.qualityGateFailed;
  }
  return ExitCodes.success;
}

async function runCollect(parsed: ParsedArgs): Promise<void> {
  const { collection } = await collect(parsed);
  console.log(`Wrote review-surfaces artifacts to ${displayPath(process.cwd(), collection.outputDir)}`);
}

// Resolve --previous-packet to the concrete review_packet.json path the dogfood
// comparison reads, expressed RELATIVE to cwd (mirroring resolveComparisonInput's
// recorded path and the other flag inputs, so the signature stays independent of
// the absolute cwd / --out location). Returned to collectInputs so its path AND
// content fold into the cache signature: changing which baseline a dogfood run
// compares against — or editing that baseline — is a cache miss instead of a
// stale hit that restores a packet with an out-of-date dogfood.comparison /
// agent_handoff.changes_since_last_packet. Absent => no --previous-packet flag.
function resolvePreviousPacketInput(cwd: string, parsed: ParsedArgs): string | undefined {
  const flagValue = stringFlag(parsed, "previous-packet");
  if (flagValue === undefined) {
    return undefined;
  }
  const resolved = resolvePreviousPacketPath(cwd, flagValue);
  return path.relative(cwd, resolved) || resolved;
}

// R6: surface silent git degradation on EVERY command. collection.diagnostics
// prints to stderr ALWAYS (an empty array — healthy git — prints nothing, so
// byte-stable runs are unchanged); --verbose adds resolved refs / diff_source /
// output dir. Called from the shared collect() so `collect`, `all`, `dogfood`,
// and every per-stage subcommand surface a degraded diff range uniformly.
function printCollectionDiagnostics(parsed: ParsedArgs, cwd: string, collection: CollectionResult): void {
  for (const note of collection.diagnostics) {
    process.stderr.write(`[review-surfaces] ${note}\n`);
  }
  debug(parsed, `base=${collection.manifest.base_ref} (${collection.manifest.base_sha ?? "unresolved"}) head=${collection.manifest.head_ref} (${collection.manifest.head_sha})`);
  debug(parsed, `diff_source=${collection.diff_source}`);
  debug(parsed, `output dir=${path.relative(cwd, collection.outputDir) || "."}`);
}

async function collect(parsed: ParsedArgs): Promise<{ collection: CollectionResult; config: ReviewSurfacesConfig }> {
  const cwd = process.cwd();
  // The exact config path loadConfig reads. Fold its content into the signature
  // (via collectInputs) so a config edit is a cache miss; loadConfig falls back
  // to defaults when the file is absent, and the "missing" sentinel covers that.
  const configPath = stringFlag(parsed, "config") ?? "review-surfaces.config.yaml";
  const config = await loadConfig(cwd, configPath);
  applyBudgetFlag(parsed, config);
  const specFlag = stringFlag(parsed, "spec");
  const runConfig = specFlag ? { ...config, specs: [specFlag] } : config;
  const provider = providerFlag(parsed, runConfig);
  // PR mode produces a DETERMINISTIC mock whole-repo packet (the live provider is
  // reserved for the diff-scoped narrative). Fold the EFFECTIVE packet provider —
  // mock in pr mode — into the cache signature, NOT the requested one. Otherwise
  // the mock side packet would be stamped under the requested provider's signature
  // and a later `all --review-scope repo --provider ai-sdk --cache` with the same
  // inputs would reuse the un-enriched mock packet instead of running the LLM.
  const signatureProvider = reviewScope(parsed) === "pr" ? "mock" : provider;
  const headRef = stringFlag(parsed, "head") ?? "HEAD";
  const collection = await collectInputs({
    cwd,
    config: runConfig,
    baseRef: resolveBaseRefForRun(cwd, stringFlag(parsed, "base"), headRef),
    headRef,
    outputDir: stringFlag(parsed, "out"),
    commandTranscriptDir: stringFlag(parsed, "command-transcripts"),
    testOutputPaths: splitTestOutputPaths(stringFlag(parsed, "test-output")),
    coverageOutputPath: stringFlag(parsed, "coverage"),
    dogfood: isDogfoodRun(parsed),
    now: nowFlag(parsed),
    provider: signatureProvider,
    // review-surfaces.QUALITY_GATE.2 (Codex round-4 finding 2): the REQUESTED
    // provider drives the gate's privacy decision (and the persisted
    // gate_remote_blocked boolean), NOT the mock-forced signature provider —
    // even in --review-scope pr, applyGate / the JSON summary gate over the
    // requested provider, so the packet must record the privacy condition for it.
    gateProvider: provider,
    model: signatureModel(parsed, runConfig, signatureProvider),
    redactSecrets: redactSecretsFlag(parsed, runConfig),
    conversationPath: stringFlag(parsed, "conversation"),
    conversationFormat: conversationFormatFlag(parsed),
    conversationDiscovery: !booleanFlag(parsed, "no-conversation-discovery"),
    agentInputPath: stringFlag(parsed, "agent-input"),
    configPath,
    previousPacketPath: resolvePreviousPacketInput(cwd, parsed)
  });
  printCollectionDiagnostics(parsed, cwd, collection);
  // COLD_START.7: a literal-HEAD review that absorbed working-tree files says so
  // once in the run summary (the same line every human surface carries).
  if (collection.manifest.uncommitted_files > 0) {
    console.log(`includes ${collection.manifest.uncommitted_files} uncommitted file(s) (working tree)`);
  }
  printArtifactIgnoreHint(cwd, collection.outputDir);
  return { collection, config: runConfig };
}

// DISTRIBUTION.13: one stderr hint when the artifact dir is inside the repo
// and neither git-ignored nor tracked — without it, a stranger's next
// `git add -A` commits a ~100 KB cockpit HTML. Stderr only: the stdout
// ordering contracts (HUMAN_REVIEW.15, pointer-last) must not move. Repos
// that ignore the dir, or deliberately track artifacts (like this one), stay
// hint-free.
function printArtifactIgnoreHint(cwd: string, outputDir: string): void {
  const rel = path.relative(cwd, outputDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !isGitRepo(cwd)) {
    return;
  }
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd, stdio: "ignore" });
    return; // ignored — nothing to suggest
  } catch {
    // not ignored; fall through to the tracked check
  }
  try {
    if (execFileSync("git", ["ls-files", "--", rel], { cwd, encoding: "utf8" }).trim() !== "") {
      return; // tracked on purpose — the user reviews artifacts as content
    }
  } catch {
    return;
  }
  process.stderr.write(
    `[review-surfaces] hint: add ${rel.split(path.sep).join("/")}/ to .gitignore — artifacts are local-first and need not be committed.\n`
  );
}

// COLD_START.6: resolve the review base BEFORE collection so a non-resolving
// base is a hard error with no artifacts written, never a silent working-tree
// fallback (quick-wins evidence item 1). The R6 degraded modes — not a git
// repo, or an unborn HEAD (init with no commits) — keep their graceful path:
// there is no claimable range there, the artifacts visibly carry empty/unknown
// sentinels, and gitInfoDiagnostics already warns on stderr.
function resolveBaseRefForRun(cwd: string, explicitBase: string | undefined, headRef: string): string {
  const headSha = resolveGitRefSha(cwd, "HEAD");
  if (!isGitRepo(cwd) || headSha === undefined) {
    return explicitBase ?? "origin/main";
  }
  const resolution = resolveBaseRef(cwd, explicitBase, headRef);
  if (!resolution.ok) {
    throw new CliError(resolution.message, ExitCodes.usageError);
  }
  // COLD_START.6 (PR #79 review): an explicitly pinned head that does not
  // resolve gets the same hard error as the base — without this, the summary
  // and manifest would silently substitute the checked-out HEAD while the
  // range diff comes back empty, a confidently wrong review of the requested
  // head. A literal HEAD request is already guaranteed resolvable above.
  const requestedHeadSha = resolveGitRefSha(cwd, headRef);
  if (requestedHeadSha === undefined) {
    throw new CliError(
      `head ref "${headRef}" does not resolve. If this is a shallow or partial clone, fetch it first ` +
        `(GitHub Actions: actions/checkout with fetch-depth: 0; locally: git fetch origin "${headRef}"). ` +
        `Otherwise pass --head <ref> naming an existing ref.`,
      ExitCodes.usageError
    );
  }
  // COLD_START.6 (PR #79 round 2, P1): both refs resolving is not enough — a
  // shallow fetch can hold both tips without their common history, and the
  // three-dot range diff then fails (previously falling back to the working
  // tree). No merge base is a hard error, not a silently empty review.
  if (resolveMergeBaseSha(cwd, resolution.base.ref, headRef) === undefined) {
    throw new CliError(
      `no merge base exists between "${resolution.base.ref}" and "${headRef}" in this checkout. ` +
        `Fetch more history first (GitHub Actions: actions/checkout with fetch-depth: 0; locally: ` +
        `git fetch --unshallow origin), or pass a --base that shares history with the head.`,
      ExitCodes.usageError
    );
  }
  // COLD_START.6 (PR #79 round 4): when the AUTO base lands on the same commit
  // as the head (single-branch checkouts can leave origin/HEAD on the feature
  // branch itself; a clean default-branch checkout is the legitimate shape),
  // say so on stderr — an empty review must never be a silent surprise.
  if (resolution.base.source === "auto" && resolution.base.sha === requestedHeadSha) {
    process.stderr.write(
      `[review-surfaces] auto-resolved base ${resolution.base.ref} is the same commit as the head; ` +
        `if you expected changes, fetch the default branch (fetch-depth: 0) or pass --base <ref>.\n`
    );
  }
  console.log(
    `Reviewing range: ${resolution.base.ref} (${resolution.base.sha.slice(0, 7)}) -> ${headRef} (${requestedHeadSha.slice(0, 7)})`
  );
  return resolution.base.ref;
}

// The model value folded into the cache signature. For ai-sdk we resolve the
// EFFECTIVE model with the SAME precedence the provider uses
// (--model -> config.llm.model -> REVIEW_SURFACES_AI_MODEL env -> provider
// default) so a model change made ONLY through the env var still busts the
// cache; without this the signature recorded `undefined` and a re-run with a
// DIFFERENT REVIEW_SURFACES_AI_MODEL hit the old cache and reused the prior
// model's reasoning/enrichment. mock NEVER calls a model and must stay
// deterministic, so it folds nothing extra (the explicit requested model, if
// any, is still recorded so an explicit --model swap remains a cache miss).
// agent-file is offline and does not consult the AI model env var, so it keeps
// the requested-model-only behavior unchanged.
function signatureModel(
  parsed: ParsedArgs,
  config: ReviewSurfacesConfig,
  provider: ProviderName
): string | undefined {
  const requested = stringFlag(parsed, "model") ?? config.llm.model ?? undefined;
  if (provider === "ai-sdk") {
    return effectiveModelId(requested);
  }
  return requested;
}

// Validate --now as a parseable ISO 8601 instant and normalize it to a single
// canonical string so two runs with the same --now value freeze the clock to a
// byte-identical timestamp. Absent => undefined (real wall clock, unchanged).
function nowFlag(parsed: ParsedArgs): string | undefined {
  const raw = stringFlag(parsed, "now");
  if (raw === undefined) {
    return undefined;
  }
  const millis = Date.parse(raw);
  if (Number.isNaN(millis)) {
    throw new CliError(`--now must be a parseable ISO 8601 timestamp, got: ${raw}`, ExitCodes.usageError);
  }
  return new Date(millis).toISOString();
}

interface CacheSnapshot {
  manifestPath: string;
  manifestRaw: string;
  priorSignature?: string;
  // FINDING B (round 8): the producing signature recorded for review_packet.json
  // in the PRIOR manifest's artifact_signatures map (snapshotted before collect
  // rewrites the manifest). The cache hit gates on THIS, not the top-level
  // manifest signature: an intervening collect/intent bumps the top-level
  // signature to the current inputs while leaving a STALE review_packet.json (and
  // its old producing signature) in place, so a top-level-signature hit would
  // reuse a packet whose coverage/risks predate the current inputs.
  packetProducingSignature?: string;
  packetPath: string;
  packet?: ReviewPacket;
}

interface PrSurfaceCacheReuse {
  reusable: boolean;
  surface?: PrReviewSurfaceModel;
}

interface CachedHumanReviewReuse {
  narrative?: ChangeNarrative;
  changeMapInsights?: ChangeMapInsights;
  conversationReview?: ConversationReviewResult;
}

interface HumanEnrichmentContext {
  provider: ReasoningProvider;
  providerName: ProviderName;
  model?: string;
  redactSecrets: boolean;
  remotePrivacyBlocked: boolean;
}

interface BuiltHumanReviewContext {
  outputDir: string;
  model: HumanReviewModel;
  diff?: StructuredDiff;
}

interface HumanReviewArtifactInputs {
  packet?: ReviewPacket;
  prSurface?: PrReviewSurfaceModel;
  feedback?: FeedbackFile[];
  // A provider-built narrative to carry through a cache-hit rebuild so it is not
  // overwritten by the deterministic fallback (review-surfaces.NARRATIVE.1).
  narrative?: ChangeNarrative;
  changeMapInsights?: ChangeMapInsights;
  conversationReview?: ConversationReviewResult;
}

// Resolve the EFFECTIVE output dir with the SAME precedence collectInputs uses
// so the cache reads/writes the exact manifest.json the run will produce:
//   --out flag  ->  config.output_dir  ->  .review-surfaces
// A repo that sets output_dir in config (without --out) would otherwise have its
// cache snapshot read the wrong (.review-surfaces) directory, yielding wrong
// cache hits or silently-disabled caching. config is loaded here from the same
// --config path collect() uses; an absent config falls back to defaults.
async function resolveOutputDir(cwd: string, parsed: ParsedArgs): Promise<string> {
  const outFlag = stringFlag(parsed, "out");
  if (outFlag !== undefined) {
    return path.resolve(cwd, outFlag);
  }
  const configPath = stringFlag(parsed, "config") ?? "review-surfaces.config.yaml";
  const config = await loadConfig(cwd, configPath);
  return path.resolve(cwd, config.output_dir);
}

// Snapshot the prior manifest.json (raw bytes + parsed signature) and check that
// a parseable review_packet.json exists. Any read/parse failure yields an empty
// snapshot (priorSignature undefined / packet invalid) so the run is a clean
// cache MISS and regenerates normally.
async function readCacheSnapshot(cwd: string, parsed: ParsedArgs): Promise<CacheSnapshot> {
  const outputDir = await resolveOutputDir(cwd, parsed);
  const manifestPath = path.join(outputDir, "manifest.json");
  const packetPath = path.join(outputDir, "review_packet.json");
  let manifestRaw = "";
  let priorSignature: string | undefined;
  let packetProducingSignature: string | undefined;
  if (fileExists(manifestPath)) {
    try {
      manifestRaw = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(manifestRaw);
      if (parsed && typeof parsed.signature === "string") {
        priorSignature = parsed.signature;
      }
      // FINDING B: read review_packet.json's OWN producing signature from the
      // prior manifest's artifact_signatures map (snapshotted before collect
      // overwrites the manifest), so a stale packet left by an intervening
      // collect/intent is not reused on a top-level-signature match.
      packetProducingSignature = createPipelineArtifactStore({
        outputDir,
        artifactSignatures: artifactSignaturesFromManifest(parsed)
      }).producingSignature(PROVENANCE_ARTIFACTS.packet);
    } catch {
      manifestRaw = "";
      priorSignature = undefined;
      packetProducingSignature = undefined;
    }
  }
  let packet: ReviewPacket | undefined;
  if (fileExists(packetPath)) {
    packet = await readSchemaValidPacket(cwd, parsed, packetPath);
  }
  return { manifestPath, manifestRaw, priorSignature, packetProducingSignature, packetPath, packet };
}

// FINDING E (cache schema validity): a --cache signature hit must reuse a packet
// only when review_packet.json is a SCHEMA-VALID review packet, not merely
// parseable JSON. A truncated `{}` or other parseable non-packet JSON that
// happens to share a signature would otherwise be reused and break later
// comment/SARIF/validate. We validate the on-disk packet against the same
// review_packet schema `validate` uses (reusing the shared ajv validator);
// schema-invalid is treated exactly like a cache miss (the caller regenerates).
//
// If the schema itself cannot be read (a repo without schemas/), we conservatively
// fall back to the parseable-only check so caching is not silently disabled for
// repos that lack the schema file; `all` still writes a schema-valid packet there.
async function readSchemaValidPacket(cwd: string, parsed: ParsedArgs, packetPath: string): Promise<ReviewPacket | undefined> {
  let packetData: unknown;
  try {
    packetData = JSON.parse(fs.readFileSync(packetPath, "utf8"));
  } catch {
    return undefined; // unparseable => cache miss
  }
  const customSchemaFlag = stringFlag(parsed, "schema");
  const schemaPath = customSchemaFlag !== undefined ? path.resolve(cwd, customSchemaFlag) : packagedSchemaPath("review_packet.schema.json");
  let schema: unknown;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    // Schema unavailable: keep the prior parseable-only behavior so caching still
    // works on repos without a checked-in schema.
    return packetData as ReviewPacket;
  }
  return validateJsonSchema(schema, packetData).valid ? packetData as ReviewPacket : undefined;
}

function isCacheHit(snapshot: CacheSnapshot, currentSignature: string | undefined): boolean {
  return (
    snapshot.packet !== undefined &&
    snapshot.manifestRaw !== "" &&
    typeof currentSignature === "string" &&
    snapshot.priorSignature === currentSignature &&
    // FINDING B: only a HIT when review_packet.json was PRODUCED from the current
    // signature (its stamped producing signature matches), not merely when the
    // manifest's top-level signature matches. An intervening collect/intent bumps
    // the manifest signature while leaving a stale packet (with an old producing
    // signature) -> treat as a miss and regenerate. A clean `all --cache` re-run
    // stamped review_packet.json with this same signature, so it still hits.
    snapshot.packetProducingSignature === currentSignature
  );
}

async function runAll(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  // R6: per-run timing for the verbose (debug) summary line at the end.
  const startedAt = Date.now();
  // --cache is opt-in. Snapshot the prior manifest BEFORE collect recomputes
  // (and overwrites) it, so a signature match can be detected and the on-disk
  // manifest/packet left byte-identical. Without --cache nothing is read here.
  const cacheSnapshot = booleanFlag(parsed, "cache") ? await readCacheSnapshot(cwd, parsed) : undefined;
  const { collection, config } = await collect(parsed);
  const artifactStore = createPipelineArtifactStoreForCollection(collection);
  // The cache signature folds the whole-repo packet inputs, NOT --review-scope. In
  // pr mode the PR surface is a separate artifact written further below; a plain
  // signature hit would return before that block and leave pr_review_surface.json
  // missing or stale-for-another-head. So in pr mode only honor the cache shortcut
  // when a surface for the CURRENT head already exists; otherwise fall through to a
  // full regenerate so the PR block runs and (re)writes it.
  const cacheHit = cacheSnapshot ? isCacheHit(cacheSnapshot, collection.manifest.signature) : false;
  // Narrative, graph enrichment, and repo conversation review all come from the
  // same cached human artifact. Parse and validate it once before deciding
  // whether the cache is complete enough to reuse.
  const cachedHumanReuse = cacheHit && config.human_review.enabled
    ? readCachedHumanReviewReuse(
        cwd,
        collection.outputDir,
        String(collection.manifest.head_sha ?? ""),
        String(collection.manifest.signature ?? "")
      )
    : undefined;
  const prSurfaceReuse = cacheHit
    ? prSurfaceCacheReuse(parsed, collection, config, cachedHumanReuse?.conversationReview)
    : undefined;
  if (cacheSnapshot && cacheHit && prSurfaceReuse?.reusable) {
    const strict = booleanFlag(parsed, "strict");
    const evaluation = loadEvaluation(collection.outputDir);
    // Under --strict the gate MUST run. If the cached output dir is incomplete
    // (evaluation.yaml missing/unreadable) we cannot reuse it: fall through to a
    // full regenerate (cache MISS) so the gate is recomputed and applied, rather
    // than silently exiting 0. A clean hit (valid evaluation, or no --strict)
    // still reuses the packet untouched below.
    if (!(strict && !evaluation)) {
      // Inputs unchanged: restore the prior manifest bytes (collect just rewrote
      // it; only created_at could differ) and reuse the existing packet untouched.
      await writeText(cacheSnapshot.manifestPath, cacheSnapshot.manifestRaw);
      const provider = providerFlag(parsed, config);
      // review-surfaces.NARRATIVE.1: on a cache hit the inputs (and the
      // provider/agent-input, which are part of the cache signature) are
      // unchanged, so REUSE the narrative already in human_review.json rather than
      // re-invoking the provider. This keeps cache reuse lossless and avoids a
      // fresh ai-sdk call (which could now fail and clobber good cached prose with
      // the fallback). When no prior narrative exists, buildHumanReview renders
      // the deterministic fallback.
      const cachedNarrative = cachedHumanReuse?.narrative;
      const cachedChangeMapInsights = cachedHumanReuse?.changeMapInsights;
      const cachedConversationReview = config.human_review.enabled
        ? conversationReviewFromFields(
            prSurfaceReuse.surface?.conversation_analysis,
            prSurfaceReuse.surface?.review_insights ?? []
          ) ?? cachedHumanReuse?.conversationReview
        : undefined;
      const cachedHumanInputs: HumanReviewArtifactInputs = {
        packet: cacheSnapshot.packet,
        prSurface: prSurfaceReuse.surface,
        feedback: collection.feedback,
        narrative: cachedNarrative,
        changeMapInsights: cachedChangeMapInsights,
        conversationReview: cachedConversationReview
      };
      // Round 6: a cache hit must match a normal run's gate behavior. Run
      // applyGate on the cached evaluation so a cached packet with a
      // gate-tripping condition is NOT silently passed: without --strict
      // applyGate prints the fail-gently WARNING and returns success; with
      // --strict it returns the gate exit code. Previously the no-strict cache
      // path returned success before applyGate, skipping that warning. When
      // evaluation is unavailable here (only reachable without --strict, since
      // strict-without-evaluation falls through to regenerate below) we keep the
      // prior reuse-and-succeed behavior rather than forcing a regenerate.
      if (evaluation) {
        await writeAndMaybeSummarizeHumanReviewFromArtifacts(cwd, collection.outputDir, reviewScope(parsed), config, cachedHumanInputs);
        console.log(`inputs unchanged (signature match); reusing existing packet at ${displayPath(cwd, cacheSnapshot.packetPath)}`);
        const cachedGateExit = applyGate(parsed, evaluation, collection, provider, config, cacheSnapshot.packet?.risks);
        // review-surfaces.QUALITY_GATE.3: the cache hit is the FASTEST reuse path,
        // and it accepts --json too, so it must emit the SAME structured run
        // summary the non-cache path does (after the gate, before the cockpit
        // pointer) — otherwise `all --cache --json` prints no structured line.
        if (cacheSnapshot.packet) {
          maybePrintRunSummaryJson(parsed, config, cacheSnapshot.packet, collection.outputDir, { collection, provider });
        }
        // review-surfaces.DISTRIBUTION.7: the cache-hit run also ends on the
        // cockpit pointer, after any gate message.
        if (config.human_review.enabled && config.human_review.default_entrypoint) {
          printCockpitPointer(cwd, collection.outputDir);
        }
        return cachedGateExit;
      }
      await writeAndMaybeSummarizeHumanReviewFromArtifacts(cwd, collection.outputDir, reviewScope(parsed), config, cachedHumanInputs);
      console.log(`inputs unchanged (signature match); reusing existing packet at ${displayPath(cwd, cacheSnapshot.packetPath)}`);
      // review-surfaces.QUALITY_GATE.3: emit the --json summary on this reuse path
      // too (no --strict, no evaluation gate ran, but --json is still honored).
      if (cacheSnapshot.packet) {
        maybePrintRunSummaryJson(parsed, config, cacheSnapshot.packet, collection.outputDir, { collection, provider });
      }
      if (config.human_review.enabled && config.human_review.default_entrypoint) {
        printCockpitPointer(cwd, collection.outputDir);
      }
      return ExitCodes.success;
    }
    console.warn("Cached output is incomplete (evaluation.yaml missing/unreadable); regenerating to apply the --strict gate.");
  }
  const commands = [`review-surfaces ${parsed.command} ${process.argv.slice(3).join(" ")}`.trim()];
  const provider = providerFlag(parsed, config);
  const requestedModel = stringFlag(parsed, "model") ?? config.llm.model ?? undefined;
  const isPrScope = reviewScope(parsed) === "pr";
  // PR-mode contract: scope/coverage/risks are DETERMINISTIC and the live provider
  // contributes only diff-scoped narrative plus advisory conversation review. So
  // in pr mode the whole-repo packet (a side
  // artifact here) is built with `mock`: the live provider is NOT spent on
  // whole-repo reasoning/enrichment (no wasted remote calls, no whole-repo context
  // leak) and the intent/evaluation the PR surface is derived from stay byte-stable
  // regardless of model output. The live provider is reserved for PR-scoped calls
  // below. In repo mode this is exactly the requested provider (unchanged).
  const wholeRepoProvider: ProviderName = isPrScope ? "mock" : provider;
  debug(parsed, `provider=${provider} wholeRepo=${wholeRepoProvider} model=${requestedModel ?? "(default)"}`);
  const reviewAreas = buildReviewAreas({ config, repoIndex: collection.repoIndex });
  const areasOption = reviewAreas.mode === "config" ? { areas: reviewAreas.areas } : {};
  const intent = await buildIntent(cwd, collection);
  const methodology = await buildMethodology(
    cwd,
    collection,
    stringFlag(parsed, "conversation"),
    commands,
    conversationFormatFlag(parsed)
  );

  // Phase 3-2: schema-bound, evidence-gated reasoning stages run with the
  // resolved provider. The default mock provider returns not-ok, so every stage
  // is a no-op and the deterministic packet below stays byte-stable.
  const reasoningProvider = providerFor(wholeRepoProvider, {
    model: requestedModel,
    cwd,
    remotePrivacyBlocked: collection.privacy.remote_provider_blocked,
    agentInput: stringFlag(parsed, "agent-input")
  });
  const redactSecrets = redactSecretsFlag(parsed, config);
  const humanEnrichment = resolveHumanEnrichmentContext(
    cwd,
    parsed,
    config,
    collection,
    redactSecrets
  );
  const reasoningOptions = {
    redactSecrets,
    remotePrivacyBlocked: collection.privacy.remote_provider_blocked,
    // FINDING C: thread the SAME config-derived review areas evaluateIntent uses
    // (present only in config mode) into the candidate-evidence group mapping, so
    // a config-area-mapped citation upgrades missing -> partial like the
    // deterministic evaluator's mapping would. Undefined in fallback mode keeps
    // the prior repo-index-cluster behavior.
    reviewAreas: areasOption.areas,
    // issue #95: thread the requested model (same one the provider resolves) so the
    // methodology-audit cache key reflects the model actually used by `all`.
    model: requestedModel
  };
  // FINDING A: intent synthesis (which may append LLM candidate_requirements) runs
  // BEFORE evaluateIntent inside this helper, so the returned evaluation has a
  // result for EVERY intent requirement, including the LLM candidates.
  const { evaluation, risks } = await runReasoningWithVerification(reasoningProvider, reasoningOptions, {
    cwd,
    collection,
    intent,
    methodology,
    commands,
    areasOption
  });

  const architecture = await buildArchitecture(collection, evaluation, areasOption);
  // R2: route the single "not_requested" preEnrichment literal through the shared
  // notRequestedEnrichment factory so the divergence-prone duplicate is gone from
  // every call site. runAll has no PipelineStageContext, so it keeps its inline
  // enrichPacket wiring (the per-stage commands use the full assembleEnrichedPacket
  // helper). Byte-stable under mock.
  const packet = createReviewPacket({
    collection,
    intent,
    evaluation,
    methodology,
    risks,
    architecture,
    enrichment: notRequestedEnrichment(wholeRepoProvider, requestedModel),
    commands
  });
  const enrichment = await enrichPacket(packet, {
    cwd,
    provider: wholeRepoProvider,
    model: requestedModel,
    agentInput: stringFlag(parsed, "agent-input"),
    outputDir: collection.outputDir,
    redactSecrets,
    remotePrivacyBlocked: collection.privacy.remote_provider_blocked
  });
  const dogfood = isDogfoodRun(parsed)
    ? buildDogfood(
        collection,
        evaluation,
        risks,
        methodology,
        `${enrichment.provider}/${enrichment.status}`,
        commands,
        resolveComparisonInput(parsed, cwd, packet.evaluation, packet.risks)
      )
    : undefined;
  const writtenPacket = await writeReviewPacket({
    collection,
    intent: packet.intent,
    evaluation: packet.evaluation,
    methodology: packet.methodology,
    risks: packet.risks,
    architecture: packet.architecture,
    dogfood,
    enrichment,
    commands
  });
  // FINDING B + FINDING C: stamp every artifact `all` just wrote with the current
  // collection signature so a later --cache hit / composable load can tell they
  // were produced from THESE inputs. writeReviewPacket writes the full set
  // (intent/evaluation/methodology/risks/review_packet, plus dogfood when present).
  await artifactStore.stampPacketArtifacts({ includeDogfood: dogfood !== undefined });
  // PR review surface (--review-scope pr): a SEPARATE diff-scoped, LLM-narrated
  // artifact (pr_review_surface.json) that the PR comment renders from. Requires
  // an LLM provider; a blocked surface is written (never a whole-repo fallback).
  let persistedSurface: PrReviewSurfaceModel | undefined;
  // Parse the collected patch once. Every downstream human-enrichment and render
  // stage receives this same immutable model, including the honest undefined
  // result when the collected patch has no changed files.
  const humanReviewDiff = isPrScope || config.human_review.enabled
    ? readHumanReviewDiff(collection.outputDir)
    : undefined;
  if (isPrScope) {
    // Evaluate the base ref in a throwaway worktree for the coverage delta
    // (best-effort: degrades to current-status when the base can't be evaluated).
    const baseEvaluation = await evaluateBaseline({
      cwd,
      // COLD_START.6: reuse the base the run already resolved (auto chain or
      // explicit flag) so the baseline evaluates the same range the packet did.
      baseRef: collection.manifest.base_ref,
      config,
      specFlag: stringFlag(parsed, "spec")
    });
    // The PR sidecar and later human enrichments share one provider instance.
    // assemblePrReviewSurface still invokes its postability-critical narrative
    // before optional conversation enrichment.
    const surface = await assemblePrReviewSurface({
      collection,
      intent: packet.intent,
      evaluation: packet.evaluation,
      baseEvaluation,
      reviewAreas: reviewAreas.areas,
      provider: humanEnrichment.provider,
      providerName: humanEnrichment.providerName,
      model: humanEnrichment.model,
      redactSecrets: humanEnrichment.redactSecrets,
      diff: humanReviewDiff
    });
    persistedSurface = jsonSerializable(surface);
    assertValidPrSurface(cwd, persistedSurface);
    await writeJson(path.join(collection.outputDir, "pr_review_surface.json"), persistedSurface);
    // Materialize the diagram artifact the surface advertises (surface.diagram.path),
    // so a consumer following the advertised path finds the .mmd it points at.
    if (persistedSurface.diagram) {
      const diagramPath = path.join(collection.outputDir, persistedSurface.diagram.path);
      fs.mkdirSync(path.dirname(diagramPath), { recursive: true });
      await writeText(diagramPath, persistedSurface.diagram.body);
    }
    if (persistedSurface.status === "blocked") {
      console.warn(`PR review surface blocked (${persistedSurface.blocked_reason}); see pr_review_surface.json`);
    }
  }
  let narrative: ChangeNarrative | undefined;
  let changeMapInsights: ChangeMapInsights | undefined;
  let conversationReview: ConversationReviewResult | undefined;
  if (config.human_review.enabled) {
    if (isPrScope) {
      // Preserve PR ordering: the sidecar's required narrative and conversation
      // work completed above before these secondary cockpit enrichments.
      narrative = await buildHumanNarrativeForAll(
        config, writtenPacket, persistedSurface, humanReviewDiff, collection, humanEnrichment
      );
      changeMapInsights = await buildChangeMapInsightsForAll(
        cwd, writtenPacket, humanReviewDiff, humanEnrichment
      );
      conversationReview = conversationReviewFromFields(
        persistedSurface?.conversation_analysis,
        persistedSurface?.review_insights ?? []
      ) ?? await buildConversationReviewForAll(
            writtenPacket, humanReviewDiff, collection, humanEnrichment
          );
    } else {
      // Repo enrichments are independent read-only projections over the same
      // packet/diff/provider input, so their latency need not be additive.
      [narrative, changeMapInsights, conversationReview] = await Promise.all([
        buildHumanNarrativeForAll(
          config, writtenPacket, undefined, humanReviewDiff, collection, humanEnrichment
        ),
        buildChangeMapInsightsForAll(
          cwd, writtenPacket, humanReviewDiff, humanEnrichment
        ),
        buildConversationReviewForAll(
          writtenPacket, humanReviewDiff, collection, humanEnrichment
        )
      ]);
    }
  }
  const humanReview = config.human_review.enabled
    ? await writeHumanReviewForPacket(cwd, collection.outputDir, writtenPacket, persistedSurface, humanReviewDiff, collection.feedback, config, narrative, changeMapInsights, conversationReview)
    : undefined;
  if (!config.human_review.enabled) {
    removeHumanReviewArtifacts(collection.outputDir);
  }
  // review-surfaces.DISTRIBUTION.7: `all` writes the cockpit DIRECTLY from the
  // exact model it just built (provider narrative, scope, budget, and config
  // intact), so the final pointer never asks the user to re-run a command that
  // could rebuild a different cockpit.
  if (humanReview) {
    await writeText(
      path.join(collection.outputDir, "human_review.html"),
      renderHumanReviewHtml(humanReview, { diff: humanReviewDiff })
    );
  }
  if (enrichment.status === "skipped" || enrichment.status === "failed") {
    console.warn(enrichment.summary);
  }
  // review-surfaces.HUMAN_REVIEW.15: the human-review summary leads over the
  // secondary artifact-status line.
  if (humanReview && config.human_review.default_entrypoint) {
    printHumanReviewTerminalSummary(cwd, collection.outputDir, humanReview);
  }
  console.log(`Wrote review-surfaces artifacts to ${displayPath(cwd, collection.outputDir)}`);
  debug(parsed, `completed in ${Date.now() - startedAt}ms`);
  // Gate on the REQUESTED provider, not wholeRepoProvider: in pr mode the narrative
  // IS a remote call with the live provider, so a privacy-blocked diff must still
  // trip the strict privacy gate (exit 5). The mock whole-repo evaluation has no
  // invalid_evidence, so the evidence gate cannot false-positive from this.
  const gateExit = applyGate(parsed, evaluation, collection, provider, config, packet.risks);
  // review-surfaces.QUALITY_GATE.3: opt-in structured run summary to stdout. Emitted
  // from the in-memory packet (writtenPacket carries the on-disk shape) so a CI step
  // reads one structured line. No-op without --json -> default output byte-stable.
  // Gate over the SAME context applyGate just used (this collection + the REQUESTED
  // provider) so a privacy-blocked remote run prints gate_code 5, matching gateExit.
  maybePrintRunSummaryJson(parsed, config, writtenPacket, collection.outputDir, { collection, provider });
  // review-surfaces.DISTRIBUTION.7: printed AFTER any gate message so the run
  // genuinely ends on the cockpit pointer.
  if (humanReview && config.human_review.default_entrypoint) {
    printCockpitPointer(cwd, collection.outputDir);
  }
  return gateExit;
}

// --review-scope pr|repo. PR mode emits/reads the diff-scoped pr_review_surface;
// repo mode (default, back-compatible) uses the whole-repo packet + comment. An
// unknown value is a usage error, not a silent fallback to repo: the flag fully
// selects the review surface (and whether `comment --post` publishes the PR or the
// whole-repo sticky comment), so a typo like `--review-scope rp` must fail fast.
function reviewScope(parsed: ParsedArgs): ReviewScope {
  const rawReviewScope = stringFlag(parsed, "review-scope");
  const rawMode = stringFlag(parsed, "mode");
  const rawSurfaceMode = stringFlag(parsed, "surface-mode");
  const supplied = [
    ["--review-scope", rawReviewScope],
    ["--mode", rawMode],
    ["--surface-mode", rawSurfaceMode]
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const uniqueValues = new Set(supplied.map(([, value]) => value));
  if (uniqueValues.size > 1) {
    throw new CliError(
      `Conflicting review surface mode flags: ${supplied.map(([flag, value]) => `${flag} ${value}`).join(", ")}.`,
      ExitCodes.usageError
    );
  }
  const raw = supplied[0]?.[1];
  if (raw === undefined || raw === "repo") {
    return "repo";
  }
  if (raw === "pr") {
    return "pr";
  }
  if (raw === "auto") {
    return isPrEnvironment() ? "pr" : "repo";
  }
  throw new CliError(`Unknown review surface mode: ${raw}. Use pr, repo, or auto.`, ExitCodes.usageError);
}

function isPrEnvironment(): boolean {
  return process.env.GITHUB_EVENT_NAME === "pull_request" || process.env.GITHUB_EVENT_NAME === "pull_request_target" || process.env.GITHUB_BASE_REF !== undefined;
}

// Whether a --cache signature hit may be honored as-is. Always true in repo mode
// (the cache governs the whole-repo packet it was built for). In pr mode the PR
// surface is a separate artifact NOT covered by the signature, so the shortcut is
// only safe when a READY pr_review_surface.json already exists for the CURRENT head
// sha; otherwise we must regenerate so the surface is (re)written and matches HEAD.
// A BLOCKED/failed surface (e.g. a prior run missing the LLM key or that timed out)
// is never reusable: API-key availability and transient provider success are not in
// the packet signature, so reusing it would never re-attempt the narrative even
// after the key is added. Force regeneration for any non-ready surface.
// The model the PR narrative actually resolves to: --model, else config.llm.model,
// else the REVIEW_SURFACES_AI_MODEL env (the same precedence resolveModel uses).
// Recording/comparing THIS, not the raw CLI/config value, lets surface reuse detect
// an env-only model swap (where --model and config are both absent).
function effectiveNarrativeModel(parsed: ParsedArgs, config: ReviewSurfacesConfig): string | undefined {
  return stringFlag(parsed, "model") ?? config.llm.model ?? process.env.REVIEW_SURFACES_AI_MODEL ?? undefined;
}

function resolveHumanEnrichmentContext(
  cwd: string,
  parsed: ParsedArgs,
  config: ReviewSurfacesConfig,
  collection: CollectionResult,
  redactSecrets: boolean
): HumanEnrichmentContext {
  const providerName = providerFlag(parsed, config);
  const model = effectiveNarrativeModel(parsed, config);
  const remotePrivacyBlocked = collection.privacy.remote_provider_blocked;
  return {
    providerName,
    model,
    redactSecrets,
    remotePrivacyBlocked,
    provider: providerFor(providerName, {
      model,
      cwd,
      remotePrivacyBlocked,
      agentInput: stringFlag(parsed, "agent-input")
    })
  };
}

// review-surfaces.NARRATIVE.1: build the human-surface change narrative through
// the requested provider (mock/agent-file are offline; ai-sdk only with a key
// and after privacy filtering). The result is anchor-validated inside
// buildChangeNarrative and returned read-only.
async function buildHumanNarrativeForAll(
  config: ReviewSurfacesConfig,
  packet: ReviewPacket,
  prSurface: PrReviewSurfaceModel | undefined,
  diff: StructuredDiff | undefined,
  collection: CollectionResult,
  enrichment: HumanEnrichmentContext
): Promise<ChangeNarrative> {
  return buildChangeNarrative({
    provider: enrichment.provider,
    providerName: enrichment.providerName,
    packet,
    prSurface,
    diff,
    headSha: String(collection.manifest.head_sha ?? ""),
    maxClaims: config.human_review.narrative_max_claims,
    redactSecrets: enrichment.redactSecrets,
    remotePrivacyBlocked: enrichment.remotePrivacyBlocked
  });
}

async function buildChangeMapInsightsForAll(
  cwd: string,
  packet: ReviewPacket,
  diff: StructuredDiff | undefined,
  enrichment: HumanEnrichmentContext
): Promise<ChangeMapInsights> {
  const readers = buildFactReaders(cwd, packet, diff);
  const edges = computeChangedImportEdgesForPacket(cwd, diff, readers);
  const implementationRoots = readers ? detectRootsForPacket(cwd, readers) : DEFAULT_IMPLEMENTATION_ROOTS;
  const areas = changeMapAreasForInsights(diff, implementationRoots);
  return buildChangeMapInsights({
    provider: enrichment.provider,
    providerName: enrichment.providerName,
    edges,
    areas,
    diff,
    redactSecrets: enrichment.redactSecrets,
    remotePrivacyBlocked: enrichment.remotePrivacyBlocked
  });
}

async function buildConversationReviewForAll(
  packet: ReviewPacket,
  diff: StructuredDiff | undefined,
  collection: CollectionResult,
  enrichment: HumanEnrichmentContext
): Promise<ConversationReviewResult> {
  const requirementIds = packet.evaluation.results.flatMap((result) => [
    result.requirement_id,
    ...(result.acai_id ? [result.acai_id] : [])
  ]);
  return buildConversationReview({
    provider: enrichment.provider,
    providerName: enrichment.providerName,
    events: collection.conversationEvents,
    diff,
    risks: conversationReviewRisksFromPacket(packet.risks),
    commandTranscripts: collection.commandTranscripts,
    commandRules: collection.commandRules,
    requirementIds,
    headSha: String(collection.manifest.head_sha ?? ""),
    redactSecrets: enrichment.redactSecrets,
    remotePrivacyBlocked: enrichment.remotePrivacyBlocked
  });
}

function changeMapAreasForInsights(diff: StructuredDiff | undefined, roots: readonly string[]): Array<{ name: string; paths: string[] }> {
  if (!diff) {
    return [];
  }
  const byArea = new Map<string, string[]>();
  for (const file of diff.files) {
    const group = clusterOfPath(file.path, roots).split("/")[0];
    const paths = byArea.get(group) ?? [];
    paths.push(file.path);
    byArea.set(group, paths);
  }
  return [...byArea.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([name, paths]) => ({ name, paths: [...new Set(paths)].sort() }));
}

function prSurfaceCacheReuse(
  parsed: ParsedArgs,
  collection: CollectionResult,
  config: ReviewSurfacesConfig,
  repoConversationReview?: ConversationReviewResult
): PrSurfaceCacheReuse {
  if (reviewScope(parsed) !== "pr") {
    return {
      reusable: !config.human_review.enabled || conversationReviewIsReusable(repoConversationReview)
    };
  }
  const surfacePath = path.join(collection.outputDir, "pr_review_surface.json");
  try {
    const surface = readPrSurfaceArtifact(collection.cwd, surfacePath);
    const requestedModel = effectiveNarrativeModel(parsed, config);
    // The surface depends on head AND base (coverage delta) AND the narrative
    // provider/model, none of which are in the whole-repo packet signature in pr
    // mode. Reuse only a READY surface that matches all of them; otherwise (stale
    // base, blocked surface, swapped provider/model) force a regenerate.
    const reusable = (
      surface?.status === "ready" &&
      surface.scope?.head_sha === collection.git.head_sha &&
      surface.scope?.base_sha === collection.git.base_sha &&
      surface.scope?.base_ref === collection.git.base_ref &&
      surface.llm?.provider === providerFlag(parsed, config) &&
      (surface.llm?.model ?? undefined) === requestedModel &&
      conversationReviewIsReusable(conversationReviewFromFields(
        surface.conversation_analysis,
        surface.review_insights
      ))
    );
    return { reusable, surface: reusable ? surface : undefined };
  } catch {
    return { reusable: false };
  }
}

// ---------------------------------------------------------------------------
// Phase 4a: composable per-stage subcommands.
//
// Each subcommand runs ONLY its stage. Dependencies are loaded from prior-stage
// artifacts under --out when present (LOAD), and computed only when the artifact
// is missing (ELSE-COMPUTE). Each subcommand writes ONLY its own artifact(s).
// `all` keeps orchestrating the full pipeline (runAll above) unchanged.
//
// PipelineStageContext mirrors runAll's provider/areas/config/commands wiring
// so a stage produces the same models whether run standalone or inside `all`.
// ---------------------------------------------------------------------------

async function buildStageContext(parsed: ParsedArgs): Promise<PipelineStageContext> {
  const cwd = process.cwd();
  // FINDING B + FINDING C: collect() carries the prior per-artifact provenance map
  // (manifest.artifact_signatures) FORWARD verbatim into the freshly-written
  // manifest, so the per-artifact loaders below read each artifact's OWN producing
  // signature from the now-current manifest. No separate prior-signature snapshot
  // is needed: an artifact whose owning stage did not rerun this collection keeps
  // its old producing signature in the carried-forward map.
  const { collection, config } = await collect(parsed);
  const provider = providerFlag(parsed, config);
  const requestedModel = stringFlag(parsed, "model") ?? config.llm.model ?? undefined;
  return buildPipelineStageContext({
    cwd,
    commandName: parsed.command,
    commandArgs: process.argv.slice(3),
    collection,
    config,
    provider,
    requestedModel,
    agentInput: stringFlag(parsed, "agent-input"),
    conversationPath: stringFlag(parsed, "conversation"),
    conversationFormat: conversationFormatFlag(parsed)
  });
}

function logWrote(context: PipelineStageContext): void {
  console.log(`Wrote review-surfaces artifacts to ${displayPath(context.cwd, context.collection.outputDir)}`);
}

async function runIntentStage(parsed: ParsedArgs): Promise<void> {
  const context = await buildStageContext(parsed);
  const intent = await computeEnrichedIntent(context);
  await writeIntentArtifact(context.collection.outputDir, intent);
  // FINDING B + FINDING C: stamp intent.yaml's producing signature so a later
  // stage composes it ONLY when the inputs are still the same.
  await context.artifacts.stamp([PROVENANCE_ARTIFACTS.intent]);
  logWrote(context);
}

async function runEvaluateStage(parsed: ParsedArgs): Promise<number> {
  const context = await buildStageContext(parsed);
  // Reuse a successfully-loaded intent.yaml (so `intent` then `evaluate` as
  // separate invocations compose); compute intent only when its artifact is
  // absent. When computing, run the SAME enriched-intent path as `all`/`intent`
  // (deterministic synthesis + the resolved provider's intent-reasoning stage),
  // not deterministic-only synthesis. In sparse/foreign repos with no Acai
  // requirements the intent-reasoning stage is the only path that contributes
  // validated candidate_requirements, so skipping it let `evaluate --provider
  // agent-file` write an incomplete evaluation.yaml while `all` (or `intent` then
  // `evaluate`) included them.
  const intent: IntentModel = await loadOrComputeIntent(context);
  const evaluation = await computeEvaluation(context, intent);
  await writeEvaluationArtifact(context.collection.outputDir, evaluation);
  // FINDING B + FINDING C: stamp evaluation.yaml's producing signature so a later
  // packet/handoff composes this coverage ONLY while the inputs are unchanged.
  await context.artifacts.stamp([PROVENANCE_ARTIFACTS.evaluation]);
  logWrote(context);
  return applyGate(parsed, evaluation, context.collection, context.provider, context.config);
}

async function runMethodologyStage(parsed: ParsedArgs): Promise<void> {
  const context = await buildStageContext(parsed);
  // methodology.yaml reflects the narrative-stage enrichment that `all` lands on
  // methodology (considered/decisions). Reproduce the monolith models and persist
  // only methodology so the artifact matches `all`. Under mock this is the
  // deterministic methodology, byte-stable.
  const { intent, evaluation, methodology, risks } = await buildEnrichedModels(context);
  // Round 7 (FINDING B, enrichment parity): `all`/`packet` run the packet-level
  // enrichPacket BEFORE writing methodology.yaml, which appends agent-file
  // methodology_decisions to packet.methodology.decisions. The standalone
  // methodology stage previously wrote buildEnrichedModels output directly and
  // silently dropped those agent decisions for
  // `methodology --provider agent-file --agent-input ...`, breaking composed-stage
  // parity with all/packet (the same class as the round-4 risks-stage fix). Run the
  // same bounded packet-level enrichment here so methodology.yaml matches `all`.
  // Under mock enrichPacket is a no-op (not_requested), so the byte-stable offline
  // path holds; createReviewPacket/enrichPacket mutate packet.methodology in place.
  //
  // PER-STAGE ISOLATION: the `methodology` stage does NOT own diagrams. enrichPacket
  // never reads packet.architecture (it only mutates packet.methodology/risks/intent),
  // so build the architecture MODEL without the diagrams/*.mmd disk side effect;
  // writing them here would leak a diagrams/ directory a `methodology` run must not own.
  const architecture = computeArchitectureModel(context, evaluation);
  const { packet } = await assembleEnrichedPacket(context, { intent, evaluation, methodology, risks, architecture });
  await writeMethodologyArtifact(context.collection.outputDir, packet.methodology);
  // FINDING B + FINDING C: stamp methodology.yaml's producing signature.
  await context.artifacts.stamp([PROVENANCE_ARTIFACTS.methodology]);
  logWrote(context);
}

async function runRisksStage(parsed: ParsedArgs): Promise<void> {
  const context = await buildStageContext(parsed);
  // risks.yaml reflects BOTH reasoning side effects `all` lands on risks: stage 2
  // (candidate evidence) appends to risks.review_focus and stage 3 (narrative)
  // appends to risks.items. Reproduce the monolith models and persist only risks.
  const { intent, evaluation, methodology, risks } = await buildEnrichedModels(context);
  // FINDING B (enrichment parity): `all`/`packet` run the packet-level enrichPacket
  // (which appends agent-file risk_summaries as AI-RISK items and review_focus
  // additions) BEFORE writing risks.yaml. The standalone risks stage previously
  // wrote buildEnrichedModels output directly and silently dropped those risk
  // hypotheses for `risks --provider agent-file --agent-input ...`. Run the same
  // bounded packet-level enrichment here so risks.yaml matches `all`. The AI-RISK
  // items stay marked llm_proposed (hypothesis-quarantined) by mergeEnrichment.
  // Under mock enrichPacket is a no-op (not_requested), so the byte-stable offline
  // path holds; createReviewPacket/enrichPacket mutate packet.risks in place.
  //
  // PER-STAGE ISOLATION: the `risks` stage does NOT own diagrams. enrichPacket
  // never reads packet.architecture (it only mutates packet.risks/evaluation),
  // so build the architecture MODEL without the diagrams/*.mmd disk side effect;
  // writing them here would leak a diagrams/ directory a `risks` run must not own.
  const architecture = computeArchitectureModel(context, evaluation);
  const { packet } = await assembleEnrichedPacket(context, { intent, evaluation, methodology, risks, architecture });
  await writeRisksArtifact(context.collection.outputDir, packet.risks);
  // FINDING B + FINDING C: stamp risks.yaml's producing signature so packet/handoff
  // compose this risk register ONLY while the inputs are unchanged.
  await context.artifacts.stamp([PROVENANCE_ARTIFACTS.risks]);
  logWrote(context);
}

async function runDiagramsStage(parsed: ParsedArgs): Promise<void> {
  const context = await buildStageContext(parsed);
  const evaluation = await loadOrComputeEvaluation(context, () => loadOrComputeIntent(context));
  const architecture = await computeArchitecture(context, evaluation);
  // buildArchitecture writes diagrams/*.mmd as a side effect; write the
  // architecture.md surface for this stage too.
  await writeArchitectureArtifact(context.collection.outputDir, architecture);
  logWrote(context);
}

async function runPacketStage(parsed: ParsedArgs): Promise<number> {
  const context = await buildStageContext(parsed);
  // Load every stage artifact when present (each was enriched by its owning
  // stage, so loading composes). For any MISSING artifact, fall back to the
  // monolith-equivalent enriched models (built at most once) instead of a
  // deterministic-only compute, so a standalone `packet` under a non-mock
  // provider still equals `all`. Under mock the enriched models collapse to the
  // deterministic ones, keeping the byte-stable offline path.
  //
  // FINDING E: each load is signature-gated (loadCurrent*) so a reused --out whose
  // inputs changed (different diff range/spec/provider input/source files, i.e. a
  // signature mismatch) RECOMPUTES coverage/risks from current inputs instead of
  // publishing a packet whose manifest/architecture are current but whose loaded
  // requirement coverage/risks are stale. With unchanged inputs they are the plain
  // loaders, so the composable evaluate->packet flow still composes.
  let enrichedCache: EnrichedModels | undefined;
  const enriched = async (): Promise<EnrichedModels> => {
    if (!enrichedCache) {
      console.log("Computed missing packet inputs dependency.");
      enrichedCache = await buildEnrichedModels(context);
    }
    return enrichedCache;
  };
  const intent = context.artifacts.loadCurrentIntent() ?? (await enriched()).intent;
  const evaluation = context.artifacts.loadCurrentEvaluation() ?? (await enriched()).evaluation;
  const methodology = context.artifacts.loadCurrentMethodology() ?? (await enriched()).methodology;
  const risks = context.artifacts.loadCurrentRisks() ?? (await enriched()).risks;
  const architecture = await computeArchitecture(context, evaluation);

  const { packet, enrichment } = await assembleEnrichedPacket(context, { intent, evaluation, methodology, risks, architecture });
  // run_mode is "dogfood" whenever --dogfood is set (collect stamps the
  // manifest), and the schema REQUIRES both `dogfood` and `agent_handoff` then.
  // Prefer a loaded dogfood.yaml so a prior `dogfood` stage composes; otherwise
  // BUILD the dogfood model from the post-enrichment packet (mirroring `all`) so
  // a standalone `packet --dogfood` always emits a schema-valid packet rather
  // than one missing the required dogfood/agent_handoff sections.
  const dogfood = isDogfoodRun(parsed)
    ? // FINDING E: only compose a prior dogfood.yaml when it is current; a stale one
      // (inputs changed) is rebuilt from the post-enrichment packet.
      context.artifacts.loadCurrentDogfood() ??
      buildDogfood(
        context.collection,
        packet.evaluation,
        packet.risks,
        packet.methodology,
        `${enrichment.provider}/${enrichment.status}`,
        context.commands,
        resolveComparisonInput(parsed, context.cwd, packet.evaluation, packet.risks)
      )
    : undefined;
  await writeReviewPacket({
    collection: context.collection,
    intent: packet.intent,
    evaluation: packet.evaluation,
    methodology: packet.methodology,
    risks: packet.risks,
    architecture: packet.architecture,
    dogfood,
    enrichment,
    commands: context.commands
  });
  // FINDING B + FINDING C: packet rewrites the full artifact set (writeReviewPacket
  // writes intent/evaluation/methodology/risks/review_packet, plus dogfood when
  // present), so stamp all of them with the current signature. This is what makes a
  // later `all --cache` reuse the packet (review_packet.json now carries the
  // current producing signature) AND keeps the composable stages current.
  await context.artifacts.stampPacketArtifacts({ includeDogfood: dogfood !== undefined });
  if (enrichment.status === "skipped" || enrichment.status === "failed") {
    console.warn(enrichment.summary);
  }
  logWrote(context);
  // review-surfaces.QUALITY_GATE.3: opt-in structured run summary to stdout, gated
  // over the SAME collection + provider applyGate uses below, so the printed
  // gate_code matches this command's real gate outcome (incl. a privacy block).
  maybePrintRunSummaryJson(parsed, context.config, packet, context.collection.outputDir, {
    collection: context.collection,
    provider: context.provider
  });
  return applyGate(parsed, evaluation, context.collection, context.provider, context.config, packet.risks);
}

async function runHandoffStage(parsed: ParsedArgs): Promise<void> {
  const context = await buildStageContext(parsed);
  // Load packet inputs needed for the handoff; compute any that are missing.
  const intent = context.artifacts.loadCurrentIntent() ?? (await buildIntent(context.cwd, context.collection));
  const evaluation = await loadOrComputeEvaluation(context, () => loadOrComputeIntent(context));
  const methodology = await loadOrComputeMethodology(context);
  const risks = await loadOrComputeRisks(
    context,
    async () => evaluation,
    async () => methodology
  );
  // FINDING E: compose a prior dogfood.yaml / intent.yaml only when it is current.
  const dogfood = context.artifacts.loadCurrentDogfood() ?? undefined;
  // PER-STAGE ISOLATION: the `handoff` stage writes ONLY agent_handoff.md.
  // buildHandoff never reads architecture, so build the model without the
  // diagrams/*.mmd disk side effect rather than leaking a diagrams/ directory.
  const architecture = computeArchitectureModel(context, evaluation);
  // Round 9 (FINDING B, enrichment parity): the monolithic `all`/`packet` run
  // calls enrichPacket BEFORE writing the handoff, so agent-file enrichment
  // (risk_summaries -> AI-RISK items in risks.items, review_focus -> risks.review_focus,
  // methodology_decisions -> methodology.decisions, assumptions -> intent.assumptions)
  // surfaces in agent_handoff.md. The standalone handoff stage previously computed
  // PLAIN methodology/risks and never enriched, so with `handoff --provider agent-file
  // --agent-input ...` in a fresh output dir those agent fields were ABSENT from
  // agent_handoff.md (same parity class as the round-4 standalone-risks fix and the
  // round-7 standalone-methodology fix). Assemble the SAME in-memory packet model
  // packet uses and run the IDENTICAL enrichPacket call BEFORE writeHandoffArtifact.
  // Under mock enrichPacket is a strict no-op (not_requested), so a mock handoff
  // stays byte-identical.
  //
  // PER-STAGE ISOLATION HOLDS: enrichPacket mutates only the in-memory
  // packet.intent/methodology/risks models (it never writes intent/evaluation/
  // methodology/risks/review_packet to disk), and writeHandoffArtifact still emits
  // ONLY agent_handoff.md. computeArchitectureModel built the architecture without
  // the diagrams/*.mmd side effect, so no diagrams/ directory is leaked.
  const { packet, enrichment } = await assembleEnrichedPacket(context, { intent, evaluation, methodology, risks, architecture, dogfood });
  await writeHandoffArtifact(context.collection.outputDir, {
    collection: context.collection,
    intent: packet.intent,
    evaluation: packet.evaluation,
    architecture: packet.architecture,
    methodology: packet.methodology,
    risks: packet.risks,
    dogfood: packet.dogfood,
    enrichment,
    commands: context.commands
  });
  logWrote(context);
}

async function runHumanStage(parsed: ParsedArgs): Promise<void> {
  // (config budget override applied below once the config is loaded)
  const cwd = process.cwd();
  const outDir = await resolveOutputDir(cwd, parsed);
  const config = await loadConfig(cwd, stringFlag(parsed, "config") ?? "review-surfaces.config.yaml");
  applyBudgetFlag(parsed, config);
  if (!config.human_review.enabled) {
    removeHumanReviewArtifacts(outDir);
    console.log(`Human review disabled by config; removed generated human review artifacts from ${displayPath(cwd, outDir)}`);
    return;
  }
  const context = await writeHumanReviewFromArtifacts(cwd, outDir, reviewScope(parsed), config);
  // review-surfaces.RENDER.9: `human --format html` ALSO writes the single-file
  // offline cockpit, rendered from the same freshly-built model (a strict
  // sibling of the markdown renderer, with the same diff context for excerpts).
  const humanFormat = stringFlag(parsed, "format") ?? "markdown";
  if (humanFormat === "html") {
    const html = renderHumanReviewHtml(context.model, { diff: context.diff });
    const htmlPath = path.join(context.outputDir, "human_review.html");
    await writeText(htmlPath, html);
    console.log(`Human review (HTML): ${displayPath(cwd, htmlPath)}`);
  } else if (humanFormat !== "markdown") {
    throw new CliError(`Unknown --format: ${humanFormat}. Use markdown (default) or html.`, ExitCodes.usageError);
  }
  console.log(`Human review: ${artifactPathForLog(cwd, outDir, "human_review.md")}`);
}

// review-surfaces.REVIEW_LOOP.1-4: the interactive review walkthrough. Loads the
// human review (building it if absent), steps the reviewer through the ranked
// queue, writes captured decisions to a local feedback file (so later runs
// downgrade/promote matching findings), merges comment drafts into the
// suggested-comments artifact, and degrades gracefully in a non-TTY environment.
async function runReviewWalkthrough(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const outDir = await resolveOutputDir(cwd, parsed);
  const config = await loadConfig(cwd, stringFlag(parsed, "config") ?? "review-surfaces.config.yaml");
  applyBudgetFlag(parsed, config);
  if (!config.human_review.enabled) {
    throw new CliError("Human review is disabled by config; enable it to run the review walkthrough.", ExitCodes.usageError);
  }
  const scope = reviewScope(parsed);
  const { outputDir, model } = await loadOrBuildHumanReviewJson(cwd, outDir, scope, "review", config);
  // Fail fast rather than silently walking a repo queue under a PR-scope request.
  // A PR-scope review needs a CURRENT pr_review_surface.json matching the review
  // (full identity, not just head) — both so the queue is the PR queue AND so the
  // rule resolver has PR risk rules to scope false-positive downgrades to.
  if (scope === "pr") {
    const gateError = prScopeReviewGateError(cwd, outputDir, model, "review");
    if (gateError) {
      throw gateError;
    }
  }
  const diff = readHumanReviewDiff(outputDir);
  // REVIEW_LOOP.4: interactive only when BOTH stdin and stdout are a TTY (so a
  // piped `review | cat` degrades to printing the next item), unless explicitly
  // forced with `--interactive` (used by tests driving the loop over piped stdin).
  const interactive = booleanFlag(parsed, "interactive") || (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const { io, close } = createWalkthroughIO(interactive);
  const options: WalkthroughOptions = {
    author: stringFlag(parsed, "author") ?? "reviewer",
    createdAt: nowFlag(parsed),
    headSha: model.generated_from.head_sha,
    packetPath: model.generated_from.packet_path,
    rulesForItem: reviewRiskRuleResolver(outputDir)
  };
  try {
    const result = await runWalkthrough(model, diff, io, options);
    if (result.feedback) {
      const feedbackDir = path.join(outputDir, "feedback");
      fs.mkdirSync(feedbackDir, { recursive: true });
      const sessionId = model.generated_from.head_sha?.slice(0, 12) || "session";
      // A fresh, non-colliding name per session on the same head, so re-running the
      // walkthrough never overwrites a prior session's captured decisions.
      const feedbackPath = nextAvailablePath(feedbackDir, `walkthrough-${sessionId}`, ".yaml");
      await writeText(feedbackPath, stringifyYaml(result.feedback));
      io.write(`Wrote reviewer feedback: ${displayPath(cwd, feedbackPath)}`);
    }
    if (result.commentDrafts.length > 0) {
      // Merge the drafts into the model and re-render only the suggested-comments
      // artifact (and the JSON model) — the other standalone artifacts are unchanged.
      const merged: HumanReviewModel = { ...model, suggested_comments: [...model.suggested_comments, ...result.commentDrafts] };
      const commentsArtifact = humanStandaloneArtifactForCommand("comments");
      await writeJson(path.join(outputDir, "human_review.json"), merged);
      if (commentsArtifact) {
        await writeHumanStandaloneArtifact(outputDir, merged, commentsArtifact, humanRenderContext(outputDir, diff));
      }
      io.write(`Captured ${result.commentDrafts.length} comment draft(s) into ${artifactPathForLog(cwd, outputDir, "suggested_comments.md")}`);
    }
    return ExitCodes.success;
  } finally {
    close();
  }
}

// Resolve a queue item's originating PR-risk rule(s) from pr_review_surface.json
// (when present), so a false-positive can be scoped to that rule. Returns an empty
// list in repo scope or when the surface is absent — the walkthrough then writes a
// path-only downgrade policy.
function reviewRiskRuleResolver(outputDir: string): (item: ReviewQueueItem) => string[] {
  const ruleByRiskId = new Map<string, string>();
  try {
    const surface = JSON.parse(fs.readFileSync(path.join(outputDir, "pr_review_surface.json"), "utf8")) as PrReviewSurfaceModel;
    for (const candidate of surface.risks?.candidates ?? []) {
      if (typeof candidate.id === "string" && typeof candidate.rule === "string") {
        ruleByRiskId.set(candidate.id, candidate.rule);
      }
    }
  } catch {
    // No PR surface (repo scope) — every item resolves to no rule.
  }
  return (item) => [...new Set(item.risk_ids.map((id) => ruleByRiskId.get(id)).filter((rule): rule is string => Boolean(rule)))];
}

// A PR-scope review/export needs a CURRENT pr_review_surface.json whose full
// identity (mode, base ref/sha, head ref/sha, sidecar path) matches the model —
// not just the head sha, so a base-ref change with an unchanged head is still
// caught. Returns the usage error to throw, or undefined when the gate passes.
function prScopeReviewGateError(cwd: string, outputDir: string, model: HumanReviewModel, command: string): CliError | undefined {
  const surfacePath = path.join(outputDir, "pr_review_surface.json");
  let surface: PrReviewSurfaceModel | undefined;
  if (fileExists(surfacePath)) {
    try {
      surface = readPrSurfaceArtifact(cwd, surfacePath);
    } catch {
      surface = undefined;
    }
  }
  if (surface && humanReviewMatchesPrSurface(cwd, outputDir, model, surface)) {
    return undefined;
  }
  return new CliError(
    `PR-scope ${command} requires a current pr_review_surface.json matching the review. Run \`review-surfaces all --review-scope pr\` first.`,
    ExitCodes.usageError
  );
}

// The first of `<dir>/<base><ext>`, `<dir>/<base>-2<ext>`, … that does not exist,
// so repeated writes never clobber an earlier file.
function nextAvailablePath(dir: string, base: string, ext: string): string {
  let candidate = path.join(dir, `${base}${ext}`);
  for (let index = 2; fileExists(candidate); index += 1) {
    candidate = path.join(dir, `${base}-${index}${ext}`);
  }
  return candidate;
}

// A readline-backed walkthrough IO, or a no-op prompt IO when non-interactive.
// Lines are buffered from `line` events and handed out by `prompt` (rather than
// `rl.question`, which races `close` on piped input). `prompt` resolves to
// undefined once stdin closes, so a piped run that runs out of input ends the
// loop cleanly instead of hanging or throwing. `terminal: false` keeps the OS
// tty's own cooked-mode echo on a real terminal and avoids readline managing it.
function createWalkthroughIO(interactive: boolean): { io: WalkthroughIO; close: () => void } {
  const write = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };
  if (!interactive) {
    return { io: { interactive: false, write, prompt: async () => undefined }, close: () => undefined };
  }
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const pending: string[] = [];
  const waiters: Array<(value: string | undefined) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(line);
    } else {
      pending.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()?.(undefined);
    }
  });
  const io: WalkthroughIO = {
    interactive: true,
    write,
    prompt: (question) =>
      new Promise((resolve) => {
        process.stdout.write(question);
        if (pending.length > 0) {
          resolve(pending.shift());
        } else if (closed) {
          resolve(undefined);
        } else {
          waiters.push(resolve);
        }
      })
  };
  return { io, close: () => rl.close() };
}

async function runHumanSubartifactStage(parsed: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const outDir = await resolveOutputDir(cwd, parsed);
  const artifact = humanStandaloneArtifactForCommand(parsed.command);
  if (!artifact) {
    throw new CliError(`Unknown human artifact command: ${parsed.command}`, ExitCodes.usageError);
  }
  const configPath = stringFlag(parsed, "config");
  const config = await loadConfig(cwd, configPath ?? "review-surfaces.config.yaml");
  if (!config.human_review.enabled) {
    removeHumanReviewArtifacts(outDir);
    console.log(`${artifact.label}: disabled by human_review.enabled=false`);
    return;
  }
  const context = await loadOrBuildHumanReviewJson(cwd, outDir, reviewScope(parsed), artifact.command, config, configPath !== undefined);
  await writeHumanStandaloneArtifact(context.outputDir, context.model, artifact, humanRenderContext(context.outputDir));
  console.log(`${artifact.label}: ${artifactPathForLog(cwd, context.outputDir, artifact.artifact)}`);
}

async function writeAndMaybeSummarizeHumanReviewFromArtifacts(
  cwd: string,
  outDir: string,
  scope: ReviewScope,
  config: ReviewSurfacesConfig,
  inputs?: HumanReviewArtifactInputs
): Promise<void> {
  if (!config.human_review.enabled) {
    removeHumanReviewArtifacts(outDir);
    return;
  }
  const context = await writeHumanReviewFromArtifacts(cwd, outDir, scope, config, inputs);
  // review-surfaces.DISTRIBUTION.7: the cache-hit path writes the cockpit from
  // the same freshly-rebuilt model, like the main `all` path.
  const outputDir = outDir.endsWith(".json") ? path.dirname(outDir) : outDir;
  await writeText(
    path.join(outputDir, "human_review.html"),
    renderHumanReviewHtml(context.model, { diff: context.diff })
  );
  if (config.human_review.default_entrypoint) {
    printHumanReviewTerminalSummary(cwd, outDir, context.model);
  }
}

function removeHumanReviewArtifacts(outDir: string): void {
  const outputDir = outDir.endsWith(".json") ? path.dirname(outDir) : outDir;
  const artifacts = ["human_review.json", "human_review.md", "human_review.html", ...HUMAN_STANDALONE_ARTIFACTS.map((artifact) => artifact.artifact)];
  for (const artifact of artifacts) {
    fs.rmSync(path.join(outputDir, artifact), { force: true });
  }
}

async function writeHumanReviewFromArtifacts(
  cwd: string,
  outDir: string,
  scope: ReviewScope,
  config?: ReviewSurfacesConfig,
  inputs?: HumanReviewArtifactInputs
): Promise<BuiltHumanReviewContext> {
  const context = await buildHumanReviewFromArtifacts(cwd, outDir, scope, config, inputs);
  await writeHumanReviewArtifacts(context.outputDir, context.model, { diff: context.diff });
  return context;
}

function printHumanReviewTerminalSummary(cwd: string, outDir: string, humanReview: HumanReviewModel): void {
  console.log(`Human review: ${artifactPathForLog(cwd, outDir, "human_review.md")}`);
  console.log(`Verdict: ${humanReview.verdict.decision}`);
  console.log(`Review first: ${humanReview.review_queue.length} item(s)`);
  console.log(`Blockers: ${humanReview.blockers.length}`);
  console.log(`Suggested comments: ${humanReview.suggested_comments.length}`);
  console.log(`Missing evidence: ${humanReview.trust_audit.missing_evidence.length}`);
}

// review-surfaces.DISTRIBUTION.7: the flagship surface must be discoverable
// from a stranger's first run — the all command ENDS on this pointer (after
// any gate message). `all` writes human_review.html itself, so the pointer
// only says where to look: there is no follow-up command whose flags could
// drift from the run that produced the cockpit (provider narrative, scope,
// budget, config, and out dir all stay exactly as generated).
function printCockpitPointer(cwd: string, outDir: string): void {
  console.log(`HTML cockpit: open ${artifactPathForLog(cwd, outDir, "human_review.html")} in a browser`);
}

async function loadOrBuildHumanReviewJson(
  cwd: string,
  outDir: string,
  scope: ReviewScope,
  command?: string,
  config?: ReviewSurfacesConfig,
  forceRebuild = false
): Promise<{ outputDir: string; model: HumanReviewModel }> {
  const outputDir = outDir.endsWith(".json") ? path.dirname(outDir) : outDir;
  const humanReviewPath = path.join(outputDir, "human_review.json");
  if (!forceRebuild && fileExists(humanReviewPath)) {
    const model = await readJson(humanReviewPath) as HumanReviewModel;
    // review-surfaces.SCHEMA.3: a schema-invalid (e.g. stale prior-version,
    // partial) artifact is treated as stale and rebuilt from current artifacts
    // rather than hard-failing; the rebuilt model is always schema-valid. The
    // rebuild also fires on a config-signature change or when the model does not
    // satisfy the requested standalone command.
    const isStale =
      humanReviewIssues(cwd, model).length > 0 ||
      !humanReviewJsonMatchesConfig(model, config) ||
      !humanReviewJsonSatisfiesStandaloneCommand(model, command) ||
      // A cached review built for a different scope must not satisfy this request
      // (e.g. `review --review-scope pr` reusing a repo-scoped model), so the
      // walkthrough walks the PR queue and captures PR-risk rule/ids.
      model.mode !== scope;
    if (isStale) {
      const context = await buildHumanReviewFromArtifacts(cwd, outDir, scope, config);
      await writeJson(path.join(context.outputDir, "human_review.json"), context.model);
      return context;
    }
    return { outputDir, model };
  }

  const context = await buildHumanReviewFromArtifacts(cwd, outDir, scope, config);
  await writeJson(path.join(context.outputDir, "human_review.json"), context.model);
  return context;
}

function humanReviewJsonMatchesConfig(model: HumanReviewModel, config?: ReviewSurfacesConfig): boolean {
  return model.generated_from.human_review_config_signature === humanReviewConfigSignature(config?.human_review);
}

function humanReviewJsonSatisfiesStandaloneCommand(model: HumanReviewModel, command: string | undefined): boolean {
  const artifact = command ? humanStandaloneArtifactForCommand(command) : undefined;
  return artifact && "isSatisfied" in artifact ? artifact.isSatisfied(model) : true;
}

function humanReviewJsonSatisfiesPrComment(model: HumanReviewModel): boolean {
  return ["routes", "evidence-cards", "intent-mismatch"].every((command) =>
    humanReviewJsonSatisfiesStandaloneCommand(model, command)
  );
}

async function buildHumanReviewFromArtifacts(
  cwd: string,
  outDir: string,
  scope: ReviewScope,
  config?: ReviewSurfacesConfig,
  inputs?: HumanReviewArtifactInputs
): Promise<BuiltHumanReviewContext> {
  const outputDir = outDir.endsWith(".json") ? path.dirname(outDir) : outDir;
  const diff = readHumanReviewDiff(outputDir);
  const packetPath = path.join(outputDir, "review_packet.json");
  if (inputs?.packet === undefined && !fileExists(packetPath)) {
    throw missingPacketError(cwd, outDir);
  }
  const packet = inputs?.packet ?? (await readJson(packetPath) as ReviewPacket);
  const surfacePath = path.join(path.dirname(packetPath), "pr_review_surface.json");
  const surface = scope !== "pr"
    ? undefined
    : inputs?.prSurface ?? (fileExists(surfacePath)
      ? readPrSurfaceArtifact(cwd, surfacePath)
      : undefined);
  const repoConversationReview = scope === "repo" && inputs?.conversationReview === undefined
    ? readCachedHumanReviewReuse(
        cwd,
        outputDir,
        String((packet.manifest as { head_sha?: unknown }).head_sha ?? ""),
        String((packet.manifest as { signature?: unknown }).signature ?? "")
      )?.conversationReview
    : undefined;
  const conversationReview = inputs?.conversationReview ?? repoConversationReview;
  if (surface) {
    if (!prSurfaceMatchesPacketManifest(packet, surface)) {
      console.warn(
        `Ignoring stale pr_review_surface.json; run review-surfaces all --review-scope pr to regenerate it for the current packet.`
      );
      return {
        outputDir,
        diff,
        model: buildHumanReviewForPacket(
          cwd,
          outputDir,
          packet,
          undefined,
          diff,
          inputs?.feedback ?? readHumanReviewFeedback(outputDir),
          config,
          inputs?.narrative,
          inputs?.changeMapInsights,
          conversationReview
        )
      };
    }
  }
  return {
    outputDir,
    diff,
    model: buildHumanReviewForPacket(
      cwd,
      outputDir,
      packet,
      surface,
      diff,
      inputs?.feedback ?? readHumanReviewFeedback(outputDir),
      config,
      inputs?.narrative,
      inputs?.changeMapInsights,
      conversationReview
    )
  };
}

function buildHumanReviewForPacket(
  cwd: string,
  outDir: string,
  packet: ReviewPacket,
  prSurface?: PrReviewSurfaceModel,
  diff?: StructuredDiff,
  feedback?: FeedbackFile[],
  config?: ReviewSurfacesConfig,
  narrative?: ChangeNarrative,
  changeMapInsights?: ChangeMapInsights,
  conversationReview?: ConversationReviewResult
): HumanReviewModel {
  const resolvedDiff = diff;
  const factReaders = buildFactReaders(cwd, packet, resolvedDiff);
  // review-surfaces.POLICY.1: a malformed committed policy fails LOUDLY.
  let policy: ReviewPolicy | undefined;
  try {
    policy = loadReviewPolicy(cwd);
  } catch (error) {
    throw new CliError(errorMessage(error), ExitCodes.schemaValidationFailed);
  }
  // Policy-required manual checks merge ahead of config (committed policy >
  // local config/feedback), and the policy content hash joins the config
  // signature so a policy edit regenerates cached human artifacts.
  const policySignature = policy ? crypto.createHash("sha256").update(JSON.stringify(policy)).digest("hex") : "";
  const effectiveConfig = config
    ? {
        ...config,
        human_review: {
          ...config.human_review,
          policy_signature: policySignature,
          required_manual_checks: policy?.required_manual_checks?.length
            ? [...policy.required_manual_checks, ...config.human_review.required_manual_checks]
            : config.human_review.required_manual_checks
        }
      }
    : config;
  // review-surfaces.COLD_START.2: detect the repo's implementation roots ONCE
  // from committed signals; the change map, tour, and drift facts all consume
  // the same value so they cannot disagree on what counts as implementation.
  const implementationRoots = detectRootsForPacket(cwd, factReaders);
  const humanReview = buildHumanReview({
    packet,
    prSurface,
    diff: resolvedDiff,
    feedback,
    config: effectiveConfig?.human_review,
    narrative,
    conversationAnalysis: conversationReview?.analysis,
    reviewInsights: conversationReview?.insights,
    policy,
    policyNowIso: typeof (packet.manifest as { created_at?: unknown }).created_at === "string" ? (packet.manifest as { created_at: string }).created_at : "",
    // review-surfaces.SEMANTIC_DIFF.1-4: computed here (sync git access) so the
    // facts are present uniformly on every build path — main, cache, standalone.
    semanticFacts: withBlastRadius(cwd, computeSemanticFactsForPacket(resolvedDiff, factReaders), factReaders),
    // review-surfaces.RANKING.1: per-changed-impl-path evidence (changed test ->
    // impl import map) computed here so it is uniform on every build path.
    rankingEvidence: computeRankingEvidenceForPacket(cwd, packet, resolvedDiff),
    // review-surfaces.COVERAGE.3/.4: intersect the collected lcov model (if any)
    // with the diff; absent report -> the honest "no_report" negative.
    coverageEvidence: computeCoverageEvidenceForPacket(outDir, resolvedDiff),
    // review-surfaces.DEP_FACTS / CONFIG_FACTS: deterministic, offline detectors
    // computed here so every build path carries them uniformly.
    dependencyFacts: factReaders ? computeDependencyFacts({ changedFiles: factReaders.changedFiles, readBase: factReaders.readBase, readHead: factReaders.readHead }) : [],
    configFacts: factReaders && resolvedDiff ? computeConfigFacts({ diff: resolvedDiff, readBase: factReaders.readBase, readHead: factReaders.readHead }) : [],
    // review-surfaces.CHANGE_MAP.1: import edges among changed files, from the
    // shared import-graph parser over head content — computed here (file access)
    // so the section is uniform on every build path.
    changedImportEdges: computeChangedImportEdgesForPacket(cwd, resolvedDiff, factReaders),
    changeGraphEdgeInsights: changeMapInsights?.edgeInsights,
    changeGraphAreaInsights: changeMapInsights?.areaInsights,
    implementationRoots,
    // review-surfaces.ARCH_DRIFT.1-3: base-vs-head resolved import diffs at
    // module altitude, computed here (base/head file access).
    archDrift: computeArchDriftForPacket(cwd, resolvedDiff, factReaders, implementationRoots),
    // review-surfaces.TREND.1: carry the prior rounds ledger forward from the
    // previous packet's sibling human_review.json (any transport).
    previousRounds: readPreviousRounds(cwd, packet),
    // review-surfaces.EVAL_HARNESS.6: surface the eval scoreboard on the
    // cockpit footer when the output directory carries one.
    evalScoreboard: readEvalScoreboard(outDir),
    // COLD_START.8: model-embedded artifact pointers are sibling file names
    // (everything lives in the same output dir), never cwd-relative paths that
    // can escape the repo when --out points elsewhere. Console logs still use
    // artifactPathForLog — the terminal is ephemeral, the model is not.
    packetPath: "review_packet.json",
    prSurfacePath: prSurface ? "pr_review_surface.json" : undefined
  });
  assertValidHumanReview(cwd, humanReview);
  return humanReview;
}

// review-surfaces.SEMANTIC_DIFF.1-4: compute the semantic change facts from the
// collected diff plus the shared base/head readers (merge-base for the OLD side,
// worktree-or-committed-blob for the NEW side — see buildFactReaders).
function computeSemanticFactsForPacket(diff: StructuredDiff | undefined, readers: FactReaders | undefined): SemanticChangeFacts {
  if (!diff || diff.files.length === 0 || !readers) {
    return emptySemanticChangeFacts();
  }
  return computeSemanticChangeFacts({
    diff,
    readBase: readers.readBase,
    readHead: readers.readHead
  });
}


// review-surfaces.BUDGET.1: --budget <duration> overrides the config default
// (off). An unparseable duration is a usage error, not a silent off.
function applyBudgetFlag(parsed: ParsedArgs, config: ReviewSurfacesConfig): void {
  const raw = parsed.flags["budget"];
  if (raw === undefined) {
    return;
  }
  // A bare `--budget` (no value / followed by another flag) parses as boolean
  // true; that must be a loud usage error, not a silent "budget off".
  const minutes = typeof raw === "string" ? parseBudgetDuration(raw) : undefined;
  if (minutes === undefined) {
    throw new CliError(`Invalid --budget: ${raw === true ? "(no value)" : String(raw)}. Use forms like 15m, 1h, or 1h30m.`, ExitCodes.usageError);
  }
  config.human_review.review_budget_minutes = minutes;
}

// Shared base/head readers for the semantic + Phase 4 fact detectors, resolved
// with the same merge-base / worktree rules: the OLD side reads the merge-base
// of base and head (the three-dot diff's old side); the NEW side reads the
// working tree when head is checked out, else the committed blob.
interface FactReaders {
  changedFiles: Array<{ path: string; old_path?: string }>;
  readBase: (filePath: string) => string | undefined;
  readHead: (filePath: string) => string | undefined;
  headIsWorktree: boolean;
  headSha: string;
  // The resolved merge-base ref the base side reads at (empty when unknown).
  baseReadRef: string;
}

function buildFactReaders(cwd: string, packet: ReviewPacket, diff: StructuredDiff | undefined): FactReaders | undefined {
  if (!diff || diff.files.length === 0) {
    return undefined;
  }
  const manifest = packet.manifest as { base_sha?: unknown; base_ref?: unknown; head_sha?: unknown; head_ref?: unknown };
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const baseRef = str(manifest.base_sha) || str(manifest.base_ref);
  const headSha = str(manifest.head_sha);
  const baseReadRef = baseRef ? resolveMergeBaseSha(cwd, baseRef, headSha || str(manifest.head_ref) || "HEAD") ?? baseRef : "";
  const worktreeHead = resolveGitRefSha(cwd, "HEAD");
  // COLD_START.7 (PR #79 round 2): the NEW side reads the working tree only
  // for a literal-HEAD review. An explicitly pinned head reads the committed
  // blob even when it equals the checked-out commit — otherwise a dirty
  // checkout leaks worktree content into semantic facts for a pinned range.
  const headIsWorktree =
    isCurrentStateHeadRequest(cwd, str(manifest.head_ref) || "HEAD") && (!headSha || !worktreeHead || headSha === worktreeHead);
  const readWorktree = (filePath: string): string | undefined => {
    try {
      return fs.readFileSync(path.resolve(cwd, filePath), "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    changedFiles: diff.files.map((file) => stripUndefined({ path: file.path, old_path: file.old_path }) as { path: string; old_path?: string }),
    readBase: baseReadRef ? (filePath) => readFileAtRef(cwd, baseReadRef, filePath) : () => undefined,
    readHead: headIsWorktree ? readWorktree : (filePath) => readFileAtRef(cwd, headSha, filePath),
    headIsWorktree,
    headSha,
    baseReadRef
  };
}

// review-surfaces.COLD_START.2: list the committed head tree (ls-tree at the
// committed head; the git index for a worktree head) and detect implementation
// roots from the target repo's own signals. Failure degrades to the generic
// conventional roots, never to a guess.
function detectRootsForPacket(cwd: string, readers: FactReaders | undefined): string[] {
  if (!readers) {
    return [...DEFAULT_IMPLEMENTATION_ROOTS];
  }
  let files: string[];
  try {
    files = execFileSync(
      "git",
      readers.headIsWorktree ? ["ls-files", "--cached"] : ["ls-tree", "-r", "--name-only", readers.headSha],
      { cwd, encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return [...DEFAULT_IMPLEMENTATION_ROOTS];
  }
  return detectImplementationRoots({ files, read: readers.readHead });
}

// review-surfaces.CHANGE_MAP.1: importer->imported edges among the changed
// files, parsed from the reviewed head's content with the same resolution
// rules as the blast-radius graph. Deleted files carry no head content, so
// they have no outgoing edges (documented v1 bound, same altitude as the
// import graph's alias bound).
function computeChangedImportEdgesForPacket(cwd: string, diff: StructuredDiff | undefined, readers: FactReaders | undefined): ChangedImportEdge[] {
  if (!diff || diff.files.length === 0 || !readers) {
    return [];
  }
  const changedPaths = diff.files.map((file) => file.path);
  return computeChangedImportEdges({
    changedPaths,
    read: readers.readHead,
    // Blob-only check for committed refs: `git show <ref>:<dir>` succeeds for
    // directories, which would resolve `./foo` to the directory instead of
    // foo/index.ts and silently drop the edge.
    exists: readers.headIsWorktree
      ? (filePath) => {
          try {
            return fs.statSync(path.resolve(cwd, filePath)).isFile();
          } catch {
            return false;
          }
        }
      : (filePath) => blobExistsAtRef(cwd, readers.headSha, filePath)
  });
}

// review-surfaces.ARCH_DRIFT.1: diff base-vs-head resolved import sets for the
// changed files, with blob-only existence checks on committed refs (the same
// resolution rules as the blast-radius graph). The base side reads the
// merge-base; a worktree head reads the working tree.
function computeArchDriftForPacket(cwd: string, diff: StructuredDiff | undefined, readers: FactReaders | undefined, implementationRoots: readonly string[]): ArchDriftResult | undefined {
  // No reliable base side (unresolvable base ref) -> NO drift signal at all:
  // comparing head imports against an empty base would fabricate a "new edge"
  // fact for every pre-existing cross-module import in the changed files.
  if (!diff || diff.files.length === 0 || !readers || readers.baseReadRef === "") {
    return undefined;
  }
  const existsHead = readers.headIsWorktree
    ? (filePath: string): boolean => {
        try {
          return fs.statSync(path.resolve(cwd, filePath)).isFile();
        } catch {
          return false;
        }
      }
    : (filePath: string) => blobExistsAtRef(cwd, readers.headSha, filePath);
  // Full-tree module-edge sets: novelty must be judged against EVERY base
  // import (the same module edge often already exists via another file), so
  // both trees are parsed once with the shared bounded import graph.
  const existsBase = (filePath: string): boolean => readers.baseReadRef !== "" && blobExistsAtRef(cwd, readers.baseReadRef, filePath);
  const baseModuleEdgeKeys = treeModuleEdgeKeys(cwd, readers.baseReadRef || undefined, readers.readBase, existsBase, implementationRoots);
  const headModuleEdgeKeys = treeModuleEdgeKeys(cwd, readers.headIsWorktree ? "WORKTREE" : readers.headSha, readers.readHead, existsHead, implementationRoots);
  const result = computeArchDriftFacts({
    changedFiles: diff.files.map((file) => ({ path: file.path, ...(file.old_path ? { old_path: file.old_path } : {}), status: file.status })),
    readBase: readers.readBase,
    readHead: readers.readHead,
    existsBase,
    existsHead,
    ...(baseModuleEdgeKeys instanceof Set ? { baseModuleEdgeKeys } : {}),
    ...(headModuleEdgeKeys instanceof Set ? { headModuleEdgeKeys } : {}),
    implementationRoots
  });
  // A truncated tree graph makes module-edge novelty UNKNOWN: suppress the
  // facts ("no import existed at the base" cannot be asserted) but keep the
  // file-level edge deltas — they come from the changed files alone and stay
  // exact for the map renderers.
  if (baseModuleEdgeKeys === "truncated" || headModuleEdgeKeys === "truncated") {
    return { facts: [], file_edges: result.file_edges };
  }
  return result;
}

// Module-edge keys over a whole tree, honoring the privacy/generated ignore
// rules (the same enumeration as the blast-radius graph). Returns undefined
// when the tree cannot be listed (the detector then falls back to its weaker
// changed-files-only bound rather than guessing).
function treeModuleEdgeKeys(
  cwd: string,
  treeRef: string | undefined,
  read: (filePath: string) => string | undefined,
  exists: (filePath: string) => boolean,
  implementationRoots: readonly string[]
): Set<string> | "truncated" | undefined {
  if (!treeRef) {
    return undefined;
  }
  let tracked: string[];
  try {
    tracked = execFileSync(
      "git",
      treeRef === "WORKTREE" ? ["ls-files", "--cached", "--others", "--exclude-standard"] : ["ls-tree", "-r", "--name-only", treeRef],
      { cwd, encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return undefined;
  }
  const ignore = loadPrivacyIgnoreSync(cwd);
  tracked = tracked.filter((filePath) => !ignore.isIgnored(filePath));
  const graph = buildImportGraph({ files: tracked, read, exists });
  // A truncated graph is PARTIAL evidence: treating it as the whole tree would
  // report pre-existing edges beyond the cap as new — and the changed-files
  // fallback bound would be just as misleading. Signal "truncated" so the
  // caller suppresses module-edge facts entirely rather than guessing.
  if (graph.truncated) {
    return "truncated";
  }
  const keys = new Set<string>();
  for (const [imported, importers] of graph.importers.entries()) {
    const toModule = moduleOf(imported, implementationRoots);
    for (const importer of importers) {
      const fromModule = moduleOf(importer, implementationRoots);
      if (fromModule !== toModule) {
        keys.add(JSON.stringify([fromModule, toModule]));
      }
    }
  }
  return keys;
}

// review-surfaces.TREND.1: read the prior ledger from the previous packet's
// sibling human_review.json. Absent/unreadable/malformed -> first review.
function readPreviousRounds(cwd: string, packet: ReviewPacket): RoundsLedgerEntry[] | undefined {
  const dogfood = packet.dogfood as { previous_packet_path?: unknown; comparison?: unknown } | undefined;
  const previousPath = dogfood?.previous_packet_path;
  // No computed comparison means the prior packet was absent/unreadable: the
  // ledger must NOT be carried forward (a zero-count row would fake a valid
  // next round). Documented missing-prior-packet case = first review.
  if (typeof previousPath !== "string" || previousPath.length === 0 || !dogfood?.comparison) {
    return undefined;
  }
  const humanPath = path.join(path.dirname(path.resolve(cwd, previousPath)), "human_review.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(humanPath, "utf8")) as { rounds?: unknown };
    if (!Array.isArray(parsed.rounds)) {
      return undefined;
    }
    // Every row must be fully formed: carrying a partial row forward would
    // fail the new model's schema validation (or render undefined counts).
    // Any malformed row degrades the WHOLE ledger to the first-review case.
    const isValidRow = (entry: unknown): entry is RoundsLedgerEntry => {
      const row = entry as Partial<RoundsLedgerEntry>;
      return (
        typeof row.round === "number" &&
        Number.isInteger(row.round) &&
        typeof row.head_sha === "string" &&
        Number.isInteger(row.new_count) &&
        Number.isInteger(row.resolved_count) &&
        Number.isInteger(row.regressed_count) &&
        typeof row.verdict === "string" &&
        (HUMAN_REVIEW_DECISIONS as readonly string[]).includes(row.verdict)
      );
    };
    if (parsed.rounds.length === 0 || !parsed.rounds.every(isValidRow)) {
      return undefined;
    }
    return parsed.rounds;
  } catch {
    return undefined;
  }
}

// review-surfaces.EVAL_HARNESS.6: read .review-surfaces/eval_scoreboard.json
// (written by the eval harness inside pnpm run test) into the model summary.
// Absent/malformed -> undefined (the footer and README block simply skip).
function readEvalScoreboard(outDir: string): EvalScoreboardSummary | undefined {
  const outputDir = outDir.endsWith(".json") ? path.dirname(outDir) : outDir;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(outputDir, "eval_scoreboard.json"), "utf8")) as {
      top_n?: unknown;
      classes?: Record<string, { passed?: unknown; total?: unknown }>;
    };
    if (typeof parsed.top_n !== "number" || typeof parsed.classes !== "object" || parsed.classes === null) {
      return undefined;
    }
    // ANY malformed class invalidates the whole scoreboard: silently dropping
    // a class would let `scoreboard --check` pass while the README no longer
    // shows that regression class — exactly the diff the block exists to surface.
    const entries = Object.entries(parsed.classes);
    if (entries.length === 0 || !entries.every(([, entry]) => typeof entry?.passed === "number" && typeof entry?.total === "number")) {
      return undefined;
    }
    const classes = entries
      .map(([name, entry]) => ({ name, passed: entry.passed as number, total: entry.total as number }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return { top_n: parsed.top_n, classes };
  } catch {
    return undefined;
  }
}

const SCOREBOARD_MARKER_START = "<!-- review-surfaces:eval-scoreboard -->";
const SCOREBOARD_MARKER_END = "<!-- /review-surfaces:eval-scoreboard -->";

// review-surfaces.EVAL_HARNESS.6: the generated, marker-delimited README block
// citing cases passed / total per fact class. Idempotent regeneration (the
// sticky comment's marker-upsert stance): never hand-edit inside the markers.
function scoreboardReadmeBlock(scoreboard: EvalScoreboardSummary): string {
  const passed = scoreboard.classes.reduce((sum, entry) => sum + entry.passed, 0);
  const total = scoreboard.classes.reduce((sum, entry) => sum + entry.total, 0);
  const rows = scoreboard.classes.map((entry) => `| ${entry.name} | ${entry.passed}/${entry.total} |`);
  return [
    SCOREBOARD_MARKER_START,
    "### Eval scoreboard",
    "",
    `The seeded-regression eval harness (run inside \`pnpm run test\`) currently catches **${passed}/${total}** seeded case(s) across ${scoreboard.classes.length} fact class(es) in the top ${scoreboard.top_n} of the review queue:`,
    "",
    "| fact class | cases in top N |",
    "| --- | --- |",
    ...rows,
    "",
    "_Generated by \`review-surfaces scoreboard\` from \`.review-surfaces/eval_scoreboard.json\`; do not edit inside the markers._",
    SCOREBOARD_MARKER_END
  ].join("\n");
}

// review-surfaces.EVAL_HARNESS.6: `scoreboard` regenerates the README block;
// `--check` exits non-zero when the committed block is stale (the local gate
// asserts currency). No scoreboard file -> nothing to assert, exit 0.
async function runScoreboard(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const outDir = await resolveOutputDir(cwd, parsed);
  const scoreboard = readEvalScoreboard(outDir);
  const readmePath = path.resolve(cwd, stringFlag(parsed, "readme") ?? "README.md");
  if (!scoreboard) {
    if (booleanFlag(parsed, "check")) {
      // In the gate this runs right after pnpm run test: a missing/malformed
      // scoreboard means the harness stopped emitting its evidence — fail.
      console.error("No readable eval_scoreboard.json; the eval harness did not emit its scoreboard (run pnpm run test first).");
      return ExitCodes.qualityGateFailed;
    }
    console.error("No eval_scoreboard.json found; nothing to surface (run pnpm run test first).");
    return ExitCodes.success;
  }
  const block = scoreboardReadmeBlock(scoreboard);
  const readme = fs.readFileSync(readmePath, "utf8");
  const startIndex = readme.indexOf(SCOREBOARD_MARKER_START);
  const endIndex = readme.indexOf(SCOREBOARD_MARKER_END);
  const updated =
    startIndex >= 0 && endIndex > startIndex
      ? readme.slice(0, startIndex) + block + readme.slice(endIndex + SCOREBOARD_MARKER_END.length)
      : `${readme.trimEnd()}\n\n${block}\n`;
  if (booleanFlag(parsed, "check")) {
    if (updated !== readme) {
      console.error(`README eval-scoreboard block is stale; run \`node bin/review-surfaces.js scoreboard\` and commit the result.`);
      return ExitCodes.qualityGateFailed;
    }
    console.error("README eval-scoreboard block is current.");
    return ExitCodes.success;
  }
  if (updated !== readme) {
    fs.writeFileSync(readmePath, updated);
    console.error(`Updated eval-scoreboard block in ${path.relative(cwd, readmePath)}.`);
  } else {
    console.error("README eval-scoreboard block already current.");
  }
  return ExitCodes.success;
}

// review-surfaces.BLAST_RADIUS.1/.2/.3: enrich changed/removed exports with
// in-repo importer counts from a bounded reverse import graph over the
// git-tracked source files. A truncated graph carries the note rather than
// presenting "used by 0" as fact.
function withBlastRadius(cwd: string, facts: SemanticChangeFacts, readers: FactReaders | undefined): SemanticChangeFacts {
  const targets = facts.api_changes.filter((change) => change.exports_removed.length > 0 || change.signatures_changed.length > 0);
  if (!readers || targets.length === 0) {
    return facts;
  }
  // The graph must enumerate the REVIEWED head's tree: ls-files reads the
  // current index, which is stale when --head is a committed ref that is not
  // checked out.
  let tracked: string[];
  try {
    tracked = execFileSync(
      "git",
      readers.headIsWorktree ? ["ls-files"] : ["ls-tree", "-r", "--name-only", readers.headSha],
      { cwd, encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return facts;
  }
  // Honor the existing privacy/generated exclusions: an ignored tree must not
  // contribute importers to the blast radius.
  const ignore = loadPrivacyIgnoreSync(cwd);
  tracked = tracked.filter((filePath) => !ignore.isIgnored(filePath));
  const graph = buildImportGraph({
    files: tracked,
    read: readers.readHead,
    exists: readers.headIsWorktree
      ? (filePath) => {
          try {
            return fs.statSync(path.resolve(cwd, filePath)).isFile();
          } catch {
            return false;
          }
        }
      : (filePath) => blobExistsAtRef(cwd, readers.headSha, filePath)
  });
  for (const change of targets) {
    const symbols = [...change.exports_removed, ...change.signatures_changed.map((sig) => sig.name)];
    const importers = findSymbolImporters({ graph, modulePath: change.path, symbols, read: readers.readHead });
    change.used_by = {
      count: importers.length,
      top: importers.slice(0, 5),
      ...(graph.truncated ? { truncated: true } : {})
    };
  }
  return facts;
}

// review-surfaces.RANKING.1: build the changed-test -> changed-impl import map.
// Reads each changed test file's head content (worktree or committed blob, same
// resolution as the semantic facts) and resolves its relative imports against the
// on-disk repo. Pure of clocks; the on-disk file set is stable for a given tree.
function computeRankingEvidenceForPacket(cwd: string, packet: ReviewPacket, diff: StructuredDiff | undefined): RankingEvidence {
  if (!diff || diff.files.length === 0) {
    return emptyRankingEvidence();
  }
  const manifest = packet.manifest as { head_sha?: unknown; head_ref?: unknown };
  const headSha = typeof manifest.head_sha === "string" ? manifest.head_sha : "";
  const worktreeHead = resolveGitRefSha(cwd, "HEAD");
  const headIsWorktree = !headSha || !worktreeHead || headSha === worktreeHead;
  const readHead = headIsWorktree
    ? (filePath: string): string | undefined => {
        try {
          return fs.readFileSync(path.resolve(cwd, filePath), "utf8");
        } catch {
          return undefined;
        }
      }
    : (filePath: string) => readFileAtRef(cwd, headSha, filePath);
  // Resolve imports against the SAME tree the test content came from: the worktree
  // when head is checked out, otherwise the reviewed head blob — so ranking does
  // not depend on whatever branch happens to be checked out.
  const exists = headIsWorktree
    ? (repoRelativePath: string): boolean => {
        try {
          return fs.statSync(path.resolve(cwd, repoRelativePath)).isFile();
        } catch {
          return false;
        }
      }
    : (repoRelativePath: string): boolean => blobExistsAtRef(cwd, headSha, repoRelativePath);
  return computeRankingEvidence({ diff, isTestPath, readHead, exists });
}

// review-surfaces.COVERAGE.3/.4: read the collected lcov model written by
// collect (inputs/coverage.json) and intersect it with the changed lines per
// hunk. Missing/unreadable report or empty diff -> status "no_report".
function computeCoverageEvidenceForPacket(outDir: string, diff: StructuredDiff | undefined): CoverageEvidence {
  const noReport: CoverageEvidence = { status: "no_report", files: [] };
  const outputDir = outDir.endsWith(".json") ? path.dirname(outDir) : outDir;
  const coveragePath = path.join(outputDir, "inputs", "coverage.json");
  if (!diff || diff.files.length === 0 || !fileExists(coveragePath)) {
    return noReport;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(coveragePath, "utf8"));
  } catch {
    return noReport;
  }
  const record = parsed as {
    source_path?: string;
    postdates_head?: boolean;
    files?: Record<string, { instrumented: number[]; covered: number[] }>;
  };
  if (!record.files || typeof record.files !== "object") {
    return noReport;
  }
  return {
    status: "report",
    source_path: typeof record.source_path === "string" ? record.source_path : undefined,
    postdates_head: record.postdates_head === true,
    files: intersectCoverageWithDiff(diff, { files: record.files })
  };
}

function readHumanReviewDiff(outDir: string): StructuredDiff | undefined {
  const diffPath = path.join(outDir, "inputs", "diff.patch");
  try {
    const diff = parseStructuredDiff(fs.readFileSync(diffPath, "utf8"));
    return diff.files.length > 0 ? diff : undefined;
  } catch {
    return undefined;
  }
}

// Load the cached human artifact once, validate its v1 contract, and extract all
// provider-authored sections that a cache-hit rebuild can safely retain.
function readCachedHumanReviewReuse(
  cwd: string,
  outDir: string,
  headSha: string,
  packetSignature: string
): CachedHumanReviewReuse | undefined {
  const humanReviewPath = path.join(outDir.endsWith(".json") ? path.dirname(outDir) : outDir, "human_review.json");
  try {
    const loaded = JSON.parse(fs.readFileSync(humanReviewPath, "utf8")) as unknown;
    if (humanReviewIssues(cwd, loaded).length > 0) {
      return undefined;
    }
    const model = loaded as HumanReviewModel;
    const narrative = headSha && model.narrative.validated_at_head === headSha
      ? model.narrative
      : undefined;
    const changeMapInsights = cachedChangeMapInsights(model, headSha);
    const conversationReview = model.mode === "repo" &&
      headSha && model.generated_from.head_sha === headSha &&
      packetSignature && model.generated_from.packet_signature === packetSignature
      ? conversationReviewFromFields(model.conversation_analysis, model.review_insights)
      : undefined;
    return {
      narrative,
      changeMapInsights,
      conversationReview: conversationReviewIsReusable(conversationReview)
        ? conversationReview
        : undefined
    };
  } catch {
    return undefined;
  }
}

function cachedChangeMapInsights(model: HumanReviewModel, headSha: string): ChangeMapInsights | undefined {
  if (!headSha || model.generated_from.head_sha !== headSha) {
    return undefined;
  }
  const edgeInsights: ChangeGraphEdgeInsight[] = [];
  for (const edge of model.change_graph.edges) {
    if (edge.insight_source === "provider") {
      edgeInsights.push({
        from: edge.from,
        to: edge.to,
        summary: edge.summary,
        ...(edge.detail ? { detail: edge.detail } : {}),
        source: "provider"
      });
    }
  }
  const areaInsights: ChangeGraphAreaInsight[] = [];
  for (const group of model.change_graph.overview.groups) {
    if (group.insight_source !== "provider") {
      continue;
    }
    const topics: NonNullable<ChangeGraphAreaInsight["topics"]> = [];
    for (const topic of group.topics ?? []) {
      if (topic.insight_source === "provider" && topic.paths.length > 0) {
        topics.push({
          label: topic.label,
          summary: topic.summary,
          paths: topic.paths,
          source: "provider"
        });
      }
    }
    areaInsights.push({
      name: group.name,
      summary: group.summary,
      ...(group.detail ? { detail: group.detail } : {}),
      ...(topics.length > 0 ? { topics } : {}),
      source: "provider"
    });
  }
  return edgeInsights.length > 0 || areaInsights.length > 0 ? { edgeInsights, areaInsights } : undefined;
}

const NON_REUSABLE_CONVERSATION_FLAGS = new Set([
  "conversation_analysis_unavailable",
  "conversation_analysis_invalid_payload",
  "conversation_analysis_partial",
  "conversation_enrichment_unavailable",
  "conversation_review_unavailable",
  "conversation_review_invalid_payload"
]);

function conversationReviewFromFields(
  analysis: ConversationReviewResult["analysis"] | undefined,
  insights: ConversationReviewResult["insights"] | undefined
): ConversationReviewResult | undefined {
  return analysis && Array.isArray(insights) ? { analysis, insights } : undefined;
}

function conversationReviewIsReusable(
  review: ConversationReviewResult | undefined
): review is ConversationReviewResult {
  if (!review) {
    return false;
  }
  // Mock and agent-file outcomes are deterministic for a fixed cache signature:
  // retrying them cannot recover until their inputs change, which already forces
  // a signature miss. Only the remote provider can recover from an unchanged-input
  // timeout, missing runtime credential, or other transient provider failure.
  if (review.analysis.provider !== "ai-sdk") {
    return true;
  }
  if (review.analysis.quality_flags.includes("conversation_analysis_privacy_blocked")) {
    return true;
  }
  if (review.analysis.status !== "analyzed" && review.analysis.status !== "not_assessed") {
    return false;
  }
  return !review.analysis.quality_flags.some((flag) => NON_REUSABLE_CONVERSATION_FLAGS.has(flag));
}

// review-surfaces.HUMAN_REVIEW.20: the render context carries the collected diff
// so review-queue items can inline bounded hunk excerpts. It is sourced from the
// already-redacted inputs/diff.patch (falling back to an in-memory diff when the
// caller already parsed one), so it works for both `all` and standalone
// re-renders without recomputing the pipeline.
function humanRenderContext(outDir: string, diff?: StructuredDiff): HumanRenderContext {
  return { diff: diff ?? readHumanReviewDiff(outDir) };
}

function readHumanReviewFeedback(outDir: string): FeedbackFile[] | undefined {
  const feedbackIndexPath = path.join(outDir, "inputs", "feedback.index.json");
  if (!fs.existsSync(feedbackIndexPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(feedbackIndexPath, "utf8")) as { feedback?: unknown };
    if (Array.isArray(parsed.feedback)) {
      return sanitizeHumanReviewFeedbackIndex(parsed.feedback, feedbackIndexPath);
    }
    console.warn(`Warning: ignored malformed feedback memory index at ${feedbackIndexPath}; expected a feedback array.`);
    return undefined;
  } catch (error) {
    const message = errorMessage(error);
    console.warn(`Warning: ignored malformed feedback memory index at ${feedbackIndexPath}: ${message}`);
    return undefined;
  }
}

function sanitizeHumanReviewFeedbackIndex(entries: unknown[], feedbackIndexPath: string): FeedbackFile[] {
  const feedback: FeedbackFile[] = [];
  for (const [index, entry] of entries.entries()) {
    const feedbackFile = normalizeHumanReviewFeedbackEntry(entry);
    if (!feedbackFile) {
      console.warn(`Warning: ignored malformed feedback memory entry ${index + 1} in ${feedbackIndexPath}.`);
      continue;
    }
    feedback.push(feedbackFile);
  }
  return feedback;
}

function normalizeHumanReviewFeedbackEntry(value: unknown): FeedbackFile | undefined {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.schema_version !== "string" || typeof value.author !== "string") {
    return undefined;
  }
  if (!Array.isArray(value.findings) || !isRecord(value.validation)) {
    return undefined;
  }
  const validation = value.validation;
  if (!Array.isArray(validation.passed) || !Array.isArray(validation.failed) || !Array.isArray(validation.notes)) {
    return undefined;
  }
  if (
    !isOptionalFeedbackArray(value.false_positives) ||
    !isOptionalFeedbackArray(value.false_negatives) ||
    !isOptionalFeedbackArray(value.team_policy) ||
    !isOptionalFeedbackArray(value.reviewer_preferences)
  ) {
    return undefined;
  }
  return normalizeFeedbackRecord(value.path, value);
}

function isOptionalFeedbackArray(value: unknown): value is unknown[] | undefined {
  return value === undefined || Array.isArray(value);
}

async function writeHumanReviewForPacket(
  cwd: string,
  outDir: string,
  packet: ReviewPacket,
  prSurface?: PrReviewSurfaceModel,
  diff?: StructuredDiff,
  feedback?: FeedbackFile[],
  config?: ReviewSurfacesConfig,
  narrative?: ChangeNarrative,
  changeMapInsights?: ChangeMapInsights,
  conversationReview?: ConversationReviewResult
): Promise<HumanReviewModel> {
  const humanReview = buildHumanReviewForPacket(cwd, outDir, packet, prSurface, diff, feedback, config, narrative, changeMapInsights, conversationReview);
  await writeHumanReviewArtifacts(outDir, humanReview, { diff });
  return humanReview;
}

function assertValidHumanReview(cwd: string, humanReview: unknown): void {
  const issues = humanReviewIssues(cwd, humanReview);
  if (issues.length === 0) {
    return;
  }
  throw new CliError(`Human review surface failed schema validation: ${issues.join("; ")}`, ExitCodes.schemaValidationFailed);
}

function humanReviewIssues(cwd: string, humanReview: unknown): string[] {
  const schema = loadHumanReviewSchema(cwd);
  if (schema === undefined) {
    return [];
  }
  const result = validateJsonSchema(schema, humanReview);
  return result.valid ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

function loadHumanReviewSchema(cwd: string): unknown | undefined {
  // review-surfaces.COLD_START.1: package-root resolution only — a CWD fallback
  // would make validation depend on where the user happens to run the command.
  const candidates = [packagedSchemaPath("human_review.schema.json")];
  for (const candidate of candidates) {
    if (!fileExists(candidate)) {
      continue;
    }
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch (error) {
      const reason = errorMessage(error);
      throw new CliError(
        `Unable to read human review schema at ${path.relative(cwd, candidate)}: ${reason}`,
        ExitCodes.schemaValidationFailed
      );
    }
  }
  return undefined;
}

// review-surfaces.CLI.10: a clean, clickable artifact path for log lines. When
// the target resolves OUTSIDE cwd (the relative form would escape upward with a
// `../` chain), print the ABSOLUTE path instead of a long `../../../../tmp/...`
// parent-escape sequence; otherwise keep the compact relative form. An identical
// in/out path collapses to "." (the cwd itself), matching the prior `|| "."`.
function displayPath(cwd: string, target: string): string {
  const rel = path.relative(cwd, target);
  if (rel === "") {
    return ".";
  }
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) {
    return path.resolve(cwd, target);
  }
  return rel;
}

function artifactPathForLog(cwd: string, outDir: string, fileName: string): string {
  return displayPath(cwd, path.join(outDir, fileName));
}

function prSurfaceMatchesPacketManifest(packet: ReviewPacket, surface: PrReviewSurfaceModel): boolean {
  const manifest = packet.manifest as {
    base_ref?: unknown;
    head_ref?: unknown;
    base_sha?: unknown;
    head_sha?: unknown;
  };
  return (
    matchesManifestString(manifest.base_ref, surface.scope.base_ref) &&
    matchesManifestString(manifest.head_ref, surface.scope.head_ref) &&
    matchesManifestString(manifest.base_sha, surface.scope.base_sha) &&
    matchesManifestString(manifest.head_sha, surface.scope.head_sha)
  );
}

function matchesManifestString(packetValue: unknown, surfaceValue: string | undefined): boolean {
  return typeof packetValue !== "string" || packetValue.length === 0 || packetValue === surfaceValue;
}


// review-surfaces.CLI.8: validate covers the human review and PR sidecar
// surfaces in addition to the review packet. `--surface packet|human|pr|all|policy`
// selects which artifact(s) to validate; the default stays `packet` so the
// historical `validate [path]` behavior (and its exit codes) is unchanged.
const VALIDATE_SURFACES = ["packet", "human", "pr", "all", "policy"] as const;
type ValidateSurface = (typeof VALIDATE_SURFACES)[number];

function validateSurfaceFlag(parsed: ParsedArgs): ValidateSurface {
  const raw = stringFlag(parsed, "surface");
  if (raw === undefined) {
    return "packet";
  }
  if ((VALIDATE_SURFACES as readonly string[]).includes(raw)) {
    return raw as ValidateSurface;
  }
  throw new CliError(`--surface must be one of ${VALIDATE_SURFACES.join("|")}`, ExitCodes.usageError);
}

async function runValidate(parsed: ParsedArgs): Promise<number> {
  const surface = validateSurfaceFlag(parsed);
  // review-surfaces.POLICY.1: a present-but-malformed committed policy fails
  // every validate run loudly (it would silently shape review output otherwise).
  if (surface === "policy" || fileExists(path.resolve(process.cwd(), POLICY_FILE))) {
    let loaded: ReviewPolicy | undefined;
    try {
      loaded = loadReviewPolicy(process.cwd());
    } catch (error) {
      console.error(errorMessage(error));
      return ExitCodes.schemaValidationFailed;
    }
    if (surface === "policy") {
      if (!loaded) {
        console.error(`No ${POLICY_FILE} found to validate.`);
        return ExitCodes.usageError;
      }
      // The authority is the INLINE POLICY_SCHEMA bundled with the tool, not the
      // POLICY_SCHEMA_PATH file (which a consumer repo may not even have on
      // disk), so the message names the bundled schema rather than a path.
      console.log(`Validated ${POLICY_FILE} against the bundled review policy schema`);
      return ExitCodes.success;
    }
  }
  if (surface === "packet") {
    return runValidatePacket(parsed);
  }
  if (surface === "human") {
    return runValidateSidecar(parsed, "human");
  }
  if (surface === "pr") {
    return runValidateSidecar(parsed, "pr");
  }
  return runValidateAll(parsed);
}

// `--surface all`: validate every artifact present in the output dir. An absent
// human/PR sidecar is skipped (not every run produces one), but the packet is
// still required. The first failing surface determines the exit code.
async function runValidateAll(parsed: ParsedArgs): Promise<number> {
  const packetExit = await runValidatePacket(parsed);
  if (packetExit !== ExitCodes.success) {
    return packetExit;
  }
  for (const sidecar of ["human", "pr"] as const) {
    // resolveSidecarFromDir: under `--surface all` a `.json` positional is the
    // PACKET path, so each sidecar must resolve to its own artifact in the same
    // directory — not reuse the packet JSON path (which would validate
    // review_packet.json against the human/PR schema and spuriously fail).
    const exit = await runValidateSidecar(parsed, sidecar, { skipIfAbsent: true, resolveSidecarFromDir: true });
    if (exit !== ExitCodes.success) {
      return exit;
    }
  }
  return ExitCodes.success;
}

interface SidecarValidateOptions {
  skipIfAbsent?: boolean;
  resolveSidecarFromDir?: boolean;
}

const SIDECAR_VALIDATORS = {
  human: {
    artifact: "human_review.json",
    label: "human review surface",
    issues: humanReviewIssues
  },
  pr: {
    artifact: "pr_review_surface.json",
    label: "PR review surface",
    issues: prSurfaceIssues
  }
} as const;

async function runValidateSidecar(
  parsed: ParsedArgs,
  sidecar: "human" | "pr",
  options: SidecarValidateOptions = {}
): Promise<number> {
  const cwd = process.cwd();
  const { artifact, label, issues: issuesFor } = SIDECAR_VALIDATORS[sidecar];
  // Default to the effective output dir (--out / config output_dir) so a
  // custom-output run validates the sidecar it actually wrote.
  const target = parsed.positionals[0];
  const targetPath = target ? path.resolve(cwd, target) : path.join(await resolveOutputDir(cwd, parsed), artifact);
  // A `.json` positional is the exact sidecar file for an explicit `--surface
  // human|pr`, but under `--surface all` it is the packet path, so resolve the
  // sidecar artifact from its parent directory instead.
  const surfacePath = !targetPath.endsWith(".json")
    ? path.join(targetPath, artifact)
    : options.resolveSidecarFromDir
      ? path.join(path.dirname(targetPath), artifact)
      : targetPath;
  if (!fileExists(surfacePath)) {
    if (options.skipIfAbsent) {
      return ExitCodes.success;
    }
    throw new CliError(
      `No ${label} JSON found at ${path.relative(cwd, surfacePath)}. Run \`review-surfaces all\` first to generate it.`,
      ExitCodes.usageError
    );
  }
  let surface: unknown;
  try {
    surface = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
  } catch (error) {
    console.error(`${path.relative(cwd, surfacePath)}: ${errorMessage(error)}`);
    return ExitCodes.schemaValidationFailed;
  }
  const issues = issuesFor(cwd, surface);
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(issue);
    }
    return ExitCodes.schemaValidationFailed;
  }
  console.log(`Validated ${displayPath(cwd, surfacePath)} against the ${label} schema`);
  return ExitCodes.success;
}

async function runValidatePacket(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  // Default to the effective output dir (--out / config output_dir), so a
  // custom-output run validates the artifact it actually wrote.
  const target = parsed.positionals[0];
  const targetPath = target ? path.resolve(cwd, target) : path.join(await resolveOutputDir(cwd, parsed), "review_packet.json");
  const packetPath = targetPath.endsWith(".json") ? targetPath : path.join(targetPath, "review_packet.json");
  // R7 (a): an ABSENT packet is a USAGE error (exit 2), not a schema-validation
  // failure (exit 3). It points the user at `review-surfaces all` rather than
  // implying the bytes on disk were invalid; only a PRESENT-but-invalid packet
  // returns 3 (matching the help banner's "validate keeps returning 3 on
  // schema-validation failure" promise).
  if (!fileExists(packetPath)) {
    throw new CliError(
      `No review packet JSON found at ${path.relative(cwd, packetPath)}. Run \`review-surfaces all\` first to generate it.`,
      ExitCodes.usageError
    );
  }

  // R7 (b): detect a schema_version mismatch BEFORE running ajv, so a packet
  // produced by a different schema generation gets a clear regenerate message
  // instead of an opaque `$.schema_version: Expected constant ...` ajv const
  // failure. PACKET_SCHEMA_VERSION is the runtime contract constant; this still
  // returns exit 3 (a present-but-wrong-version packet IS a schema failure), it
  // just improves the MESSAGE. An unparseable packet falls through to ajv, which
  // reports the parse/shape issue.
  //
  // Only when validating against the BUNDLED schema (no --schema override): a
  // caller who supplies a custom --schema owns its own schema_version `const`, so
  // we let that schema's ajv validation be the authority instead of pre-rejecting
  // a packet that is valid against the supplied (possibly newer) schema.
  const customSchema = stringFlag(parsed, "schema");
  let packetVersion: unknown;
  try {
    packetVersion = (JSON.parse(fs.readFileSync(packetPath, "utf8")) as { schema_version?: unknown }).schema_version;
  } catch {
    packetVersion = undefined;
  }
  if (customSchema === undefined && typeof packetVersion === "string" && packetVersion !== PACKET_SCHEMA_VERSION) {
    console.error(`packet is ${packetVersion}, schema expects ${PACKET_SCHEMA_VERSION} — regenerate with \`review-surfaces all\`.`);
    return ExitCodes.schemaValidationFailed;
  }

  // review-surfaces.COLD_START.1: the bundled schema resolves from the package
  // root so `validate` works from any CWD; an explicit --schema stays caller-relative.
  const schemaPath = customSchema !== undefined ? path.resolve(cwd, customSchema) : packagedSchemaPath("review_packet.schema.json");
  const result = await validateJsonFile(schemaPath, packetPath);
  if (!result.valid) {
    for (const issue of result.issues) {
      console.error(`${issue.path}: ${issue.message}`);
    }
    return ExitCodes.schemaValidationFailed;
  }

  // The default schema is the bundled one (package root, COLD_START.1) — a
  // CWD-relative path to it is meaningless noise from a foreign repo.
  const schemaLabel = customSchema !== undefined ? displayPath(cwd, schemaPath) : "the bundled schemas/review_packet.schema.json";
  console.log(`Validated ${displayPath(cwd, packetPath)} against ${schemaLabel}`);
  return ExitCodes.success;
}

// Phase 6a/6b (PROVIDERS.1/PROVIDERS.2; M6): render a review surface from the
// LOCAL review_packet.json. These are renderers, not pipeline stages: they read
// the already-written artifact, never recompute the pipeline, and never redefine
// the artifact contract. Both paths are fully offline.
//
//   --format github (default): a compact GitHub sticky comment (6a).
//   --format sarif:            a SARIF 2.1.0 log written to review.sarif (6b).
//
// An absent packet is a clean usage error (exit 2) that points at
// `review-surfaces all` rather than silently recomputing, for either format.
async function runComment(parsed: ParsedArgs): Promise<number> {
  const format = stringFlag(parsed, "format") ?? "github";
  // SARIF is a whole-repo packet projection; in pr scope the only surface is the
  // diff-scoped GitHub comment (and pr mode never falls back to the whole-repo
  // packet), so reject sarif here rather than silently emitting repo-scoped SARIF.
  if (reviewScope(parsed) === "pr" && format === "sarif") {
    throw new CliError(
      "--format sarif is not supported with --review-scope pr (the PR surface renders only as a GitHub comment). Use --format github, or --review-scope repo for SARIF.",
      ExitCodes.usageError
    );
  }
  // Codex finding 3: the JSON run-summary is a WHOLE-REPO packet projection — it
  // reads review_packet.json and never the diff-scoped pr_review_surface.json. In
  // pr scope it would silently emit repo-wide counts/queue ids while the caller
  // believes they are PR-scoped, so reject it (mirrors the --format sarif fail-fast
  // above) rather than producing a silently-wrong PR summary. PR-sidecar JSON is
  // out of scope; --review-scope repo is the supported path for the JSON summary.
  if (reviewScope(parsed) === "pr" && format === "json") {
    throw new CliError(
      "--format json is not supported with --review-scope pr (the JSON run summary is a repo-scope packet projection, not the PR surface). Use --review-scope repo for the JSON summary.",
      ExitCodes.usageError
    );
  }
  if (format === "sarif") {
    return runCommentSarif(parsed);
  }
  // review-surfaces.QUALITY_GATE.2: a deterministic JSON run-summary projection
  // for CI consumers. Like sarif it READS the local packet and recomputes nothing.
  if (format === "json") {
    return runCommentJson(parsed);
  }
  if (format === "review") {
    return runCommentDraftReview(parsed);
  }
  if (format === "sticky") {
    return runCommentSticky(parsed);
  }
  if (format !== "github") {
    throw new CliError(`Unknown --format: ${format}. Use github, sticky, sarif, json, or review.`, ExitCodes.usageError);
  }
  return runCommentGithub(parsed);
}

// Load human_review.json for a render command (draft review, sticky comment),
// guarding a missing / unreadable / stale-or-invalid artifact with actionable
// guidance, and — in PR scope — enforcing that the model matches the current PR
// surface (whole-repo evidence lines are not PR-diff anchors). `label` names the
// surface for the PR-scope gate and the regeneration guidance.
async function loadHumanReviewForRender(
  cwd: string,
  outputDir: string,
  parsed: ParsedArgs,
  label: string
): Promise<HumanReviewModel> {
  const humanReviewPath = path.join(outputDir, "human_review.json");
  const rel = path.relative(cwd, humanReviewPath) || humanReviewPath;
  if (!fileExists(humanReviewPath)) {
    throw new CliError(
      `No human_review.json at ${rel}. Run \`review-surfaces all\` (or \`human\`) first.`,
      ExitCodes.usageError
    );
  }
  let loaded: unknown;
  try {
    loaded = await readJson(humanReviewPath);
  } catch {
    throw new CliError(
      `human_review.json at ${rel} is not valid JSON. Regenerate it with \`review-surfaces all\` (or \`human\`) before rendering the ${label}.`,
      ExitCodes.usageError
    );
  }
  const issues = humanReviewIssues(cwd, loaded);
  if (issues.length > 0) {
    throw new CliError(
      `human_review.json at ${rel} is stale or invalid (${issues[0]}). Regenerate it with \`review-surfaces all\` (or \`human\`) before rendering the ${label}.`,
      ExitCodes.usageError
    );
  }
  const model = loaded as HumanReviewModel;
  if (reviewScope(parsed) === "pr") {
    const gateError = prScopeReviewGateError(cwd, outputDir, model, label);
    if (gateError) {
      throw gateError;
    }
  }
  return model;
}

// review-surfaces.PROVIDERS.7: export the suggested comments as a GitHub PENDING
// (draft) review payload the reviewer edits and submits. Reads local artifacts
// only; the payload omits `event`, so it is never auto-submitted.
async function runCommentDraftReview(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const outDir = await resolveOutputDir(cwd, parsed);
  const outputDir = outDir.endsWith(".json") ? path.dirname(outDir) : outDir;
  const model = await loadHumanReviewForRender(cwd, outputDir, parsed, "draft review");
  // The reviewed diff is the authority for inline-anchoring and side. A PRESENT but
  // empty diff (zero changed files) is still authoritative — every path+line
  // comment then folds into the body, never an invalid inline comment. Only a
  // genuinely ABSENT diff artifact falls back to the comment's own side hint.
  const diffPath = path.join(outputDir, "inputs", "diff.patch");
  const diff = fileExists(diffPath) ? parseStructuredDiff(fs.readFileSync(diffPath, "utf8")) : undefined;
  const draft = buildDraftReview(model, diff);
  const reviewPath = path.join(outputDir, "pending_review.json");

  // review-surfaces.PR_SURFACE.4 (mirrors the sticky strict-postability gate):
  // a blocked draft (redaction flagged a high-confidence secret that survived
  // into a comment body or the summary) is NEVER written to pending_review.json
  // nor dumped to stdout — that payload is exactly what a reviewer would paste
  // to GitHub, so leaking it is the whole risk. The block is a non-zero
  // (privacy) exit when posting or strict postability was opted into, and an
  // exit-0 suppression otherwise (no flag was passed, so nothing was promised).
  const posting = booleanFlag(parsed, "post");
  const strictPostability = booleanFlag(parsed, "strict-postability");
  if (draft.blocked) {
    console.error(
      "Draft review blocked: redaction flagged a high-confidence secret; refusing to write or print pending_review.json."
    );
    // review-surfaces.PR_SURFACE.4: the blocked path writes NOTHING, but a STALE
    // pending_review.json from an earlier `comment --format review` run would
    // otherwise survive at the target path — a consumer reading the artifact after
    // this (default non-strict, exit 0) command would pick up the stale draft and
    // believe it was the current, non-blocked review. Delete any existing file
    // (best-effort) so a block leaves no secret-bearing draft on disk; `force`
    // makes an already-absent path a clean no-op.
    fs.rmSync(reviewPath, { force: true });
    return posting || strictPostability ? ExitCodes.privacyBlocked : ExitCodes.success;
  }

  await writeJson(reviewPath, draft.payload);
  process.stdout.write(`${JSON.stringify(draft.payload, null, 2)}\n`);
  console.error(
    `Wrote ${displayPath(cwd, reviewPath)} — ${draft.payload.comments.length} inline comment(s), ${draft.unanchored} general. ` +
    "This is a PENDING (draft) review with no event; create and submit it yourself on GitHub — nothing is auto-submitted."
  );
  return ExitCodes.success;
}

// review-surfaces.PR_SURFACE.2/.4/.5: render the compact sticky-summary comment
// from human_review.json. Unlike `--format github`, the sticky is the
// DETERMINISTIC human rollup (not provider narrative), so it is NOT gated on the
// PROVIDERS.5 remote-narrative requirement and is postable under --provider mock;
// its only posting gate is the hard secret-block check. It leads with the
// since-last-review delta when a prior packet was compared in.
async function runCommentSticky(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const outDir = await resolveOutputDir(cwd, parsed);
  const outputDir = outDir.endsWith(".json") ? path.dirname(outDir) : outDir;
  const model = await loadHumanReviewForRender(cwd, outputDir, parsed, "sticky comment");
  const diffPath = path.join(outputDir, "inputs", "diff.patch");
  const diff = fileExists(diffPath) ? parseStructuredDiff(fs.readFileSync(diffPath, "utf8")) : undefined;
  const sticky = renderStickySummary(model, {
    diff,
    topN: numberFlag(parsed, "comment-top-n"),
    artifactName: stringFlag(parsed, "artifact-name"),
    runId: stringFlag(parsed, "run-id") ?? process.env.GITHUB_RUN_ID
  });
  const commentPath = path.join(outputDir, "comment.md");
  await writeText(commentPath, sticky.markdown);
  process.stdout.write(sticky.markdown);
  console.error(`Wrote ${displayPath(cwd, commentPath)}`);

  // review-surfaces.PR_SURFACE.4: redaction and the strict postability gate run
  // before anything is posted. A blocked body (a high-confidence secret survived
  // into the render) is never posted; it is a non-zero exit only when posting was
  // actually requested or strict postability was opted into.
  const posting = booleanFlag(parsed, "post");
  const strictPostability = booleanFlag(parsed, "strict-postability");
  if (sticky.blocked) {
    console.error("Sticky comment blocked: redaction flagged a high-confidence secret; skipping post.");
    return posting || strictPostability ? ExitCodes.privacyBlocked : ExitCodes.success;
  }
  if (posting) {
    const result = postStickyComment(cwd, sticky.markdown);
    console.error(result.reason);
  }
  return ExitCodes.success;
}

// --post is OPTIONAL and best-effort: only when set AND `gh` is available AND a
// PR context is detectable will it upsert the sticky comment. It is never
// required and never runs without the flag (so tests, which never pass --post,
// never touch the network).
async function runCommentGithub(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  // Resolve the EFFECTIVE output dir with the same precedence collectInputs/`all`
  // use (--out -> config.output_dir -> .review-surfaces) so comment finds the
  // packet `all` actually wrote. Passing undefined would hardcode .review-surfaces
  // and miss a config-set output_dir.
  const outDir = await resolveOutputDir(cwd, parsed);
  const config = await loadConfig(cwd, stringFlag(parsed, "config") ?? "review-surfaces.config.yaml");
  applyBudgetFlag(parsed, config);

  // PR mode renders the diff-scoped surface and NEVER falls back to the
  // whole-repo comment when it is missing/blocked.
  if (reviewScope(parsed) === "pr") {
    return runPrCommentGithub(cwd, outDir, parsed, config);
  }

  const rendered = renderCommentFromPacketFile(cwd, outDir);
  if (!rendered) {
    throw missingPacketError(cwd, outDir);
  }

  const commentPath = path.join(path.dirname(rendered.packetPath), "comment.md");
  await writeText(commentPath, rendered.markdown);
  process.stdout.write(rendered.markdown);
  console.error(`Wrote ${displayPath(cwd, commentPath)}`);

  if (booleanFlag(parsed, "post")) {
    const result = postStickyComment(cwd, rendered.markdown);
    console.error(result.reason);
  }
  return ExitCodes.success;
}

// Render the PR-mode sticky comment from the diff-scoped pr_review_surface.json
// (written by `all --review-scope pr`). Absent surface is a clean usage error
// pointing at `all --review-scope pr`; never a whole-repo fallback.
async function runPrCommentGithub(cwd: string, outDir: string, parsed: ParsedArgs, config: ReviewSurfacesConfig): Promise<number> {
  const surfacePath = path.join(outDir.endsWith(".json") ? path.dirname(outDir) : outDir, "pr_review_surface.json");
  if (!fileExists(surfacePath)) {
    throw new CliError(
      `No PR review surface found at ${path.relative(cwd, surfacePath)}. Run \`review-surfaces all --review-scope pr --provider ai-sdk\` first.`,
      ExitCodes.usageError
    );
  }
  const surface = readPrSurfaceArtifact(cwd, surfacePath);
  // COLD_START.8: the comment's artifact pointers are sibling file names — the
  // comment and the artifacts it cites live in the same output dir, and a
  // cwd-relative path embeds `../` chains whenever --out points outside the
  // repo. The renderer defaults already use the sibling form.
  const humanCommentModel = await loadCurrentHumanReviewForPrComment(cwd, path.dirname(surfacePath), surface, config);
  const siblingSurfacePath = path.basename(surfacePath);
  const humanRendered = humanCommentModel
    ? renderHumanPrComment(humanCommentModel, { surfacePath: siblingSurfacePath })
    : undefined;
  const renderedMarkdown = humanRendered ? humanRendered.markdown : renderPrComment(surface, { surfacePath: siblingSurfacePath });
  const inspectedMarkdown = inspectAndRedactSecrets(renderedMarkdown);
  const markdown = inspectedMarkdown.text;
  // review-surfaces.CHANGE_MAP.4: a redaction BLOCK inside the embedded map or
  // tour snippet must trip the privacy gate — the rendered body only carries
  // the placeholder, so this flag is the surviving signal.
  const renderBlocked = (humanRendered?.blocked ?? false) || inspectedMarkdown.blocked;
  const commentPath = path.join(path.dirname(surfacePath), "comment.md");
  await writeText(commentPath, markdown);
  process.stdout.write(markdown);
  console.error(`Wrote ${displayPath(cwd, commentPath)}`);
  // review-surfaces.PROVIDERS.5: posted PR comments require a validated remote
  // LLM narrative. Local agent-file narratives are useful for dogfooding, but
  // must remain local artifacts and never satisfy the sticky-post gate.
  const hasRemoteNarrative =
    surface.status === "ready" &&
    surface.llm.status === "applied" &&
    surface.llm.provider === "ai-sdk" &&
    surface.narrative !== undefined;
  // review-surfaces.RENDER.8: a local render (no --post) succeeds once the
  // comment and diagnostics are written. Postability is a *posting* gate, so a
  // non-postable surface is only a non-zero exit when posting is actually
  // requested (--post) or the caller opts into strict postability checking
  // (--strict-postability). Without either, the local comment.md is the
  // deliverable and the command exits 0 after warning about postability.
  const posting = booleanFlag(parsed, "post");
  const strictPostability = booleanFlag(parsed, "strict-postability");
  if (renderBlocked) {
    console.error("PR comment render blocked a high-confidence secret; the comment must not be posted.");
    return posting || strictPostability ? ExitCodes.privacyBlocked : ExitCodes.success;
  }
  if (!hasRemoteNarrative) {
    const reason = surface.blocked_reason ?? `${surface.llm.status}/${surface.llm.provider}`;
    console.error(`PR review surface is not postable (${reason}); skipping sticky post.`);
    return posting || strictPostability ? ExitCodes.evidenceValidationFailed : ExitCodes.success;
  }
  if (posting) {
    const result = postStickyComment(cwd, markdown);
    console.error(result.reason);
  }
  return ExitCodes.success;
}

async function loadCurrentHumanReviewForPrComment(
  cwd: string,
  outputDir: string,
  surface: PrReviewSurfaceModel,
  config: ReviewSurfacesConfig
): Promise<HumanReviewModel | undefined> {
  if (!config.human_review.enabled) {
    removeHumanReviewArtifacts(outputDir);
    return undefined;
  }
  const humanReviewPath = path.join(outputDir, "human_review.json");
  if (!fileExists(humanReviewPath)) {
    return undefined;
  }
  let model: unknown;
  try {
    model = await readJson(humanReviewPath);
  } catch (error) {
    const reason = errorMessage(error);
    console.warn(
      `Ignoring unreadable human_review.json (${reason}); falling back to pr_review_surface.json for the PR comment.`
    );
    return undefined;
  }
  if (!humanReviewMatchesPrSurface(cwd, outputDir, model, surface)) {
    console.warn(
      `Ignoring stale or non-PR human_review.json; run review-surfaces human --review-scope pr to refresh it for the current PR surface.`
    );
    return undefined;
  }
  const issues = humanReviewIssues(cwd, model);
  if (issues.length > 0) {
    console.warn(
      `Ignoring schema-invalid human_review.json (${issues.join("; ")}); falling back to pr_review_surface.json for the PR comment.`
    );
    return undefined;
  }
  const humanReview = model as HumanReviewModel;
  if (!humanReviewJsonMatchesConfig(humanReview, config)) {
    console.warn(
      `Refreshing stale human_review.json for the current human_review config before rendering the PR comment.`
    );
    const context = await buildHumanReviewFromArtifacts(cwd, outputDir, "pr", config);
    await writeHumanReviewArtifacts(context.outputDir, context.model, { diff: context.diff });
    return context.model;
  }
  if (!humanReviewJsonSatisfiesPrComment(humanReview)) {
    console.warn(
      `Refreshing stale human_review.json for the current human review artifact set before rendering the PR comment.`
    );
    const context = await buildHumanReviewFromArtifacts(cwd, outputDir, "pr", config);
    await writeHumanReviewArtifacts(context.outputDir, context.model, { diff: context.diff });
    return context.model;
  }
  return humanReview;
}

function humanReviewMatchesPrSurface(
  cwd: string,
  outputDir: string,
  candidate: unknown,
  surface: PrReviewSurfaceModel
): boolean {
  if (!isRecord(candidate) || candidate.mode !== "pr" || !isRecord(candidate.generated_from)) {
    return false;
  }
  const generatedFrom = candidate.generated_from;
  const baseShaMatches = typeof surface.scope.base_sha === "string"
    ? generatedFrom.base_sha === surface.scope.base_sha
    : typeof generatedFrom.base_sha !== "string";
  return (
    generatedFrom.base_ref === surface.scope.base_ref &&
    baseShaMatches &&
    generatedFrom.head_ref === surface.scope.head_ref &&
    generatedFrom.head_sha === surface.scope.head_sha &&
    JSON.stringify(candidate.conversation_analysis) === JSON.stringify(surface.conversation_analysis) &&
    JSON.stringify(candidate.review_insights) === JSON.stringify(surface.review_insights ?? []) &&
    artifactPathMatches(cwd, outputDir, generatedFrom.pr_surface_path, "pr_review_surface.json")
  );
}

// COLD_START.8: generated_from pointers are sibling file names relative to the
// artifact dir; artifacts written before that change carried cwd-relative
// paths. Resolve each form against its anchor and accept either when it lands
// on the expected artifact in THIS output dir.
function artifactPathMatches(cwd: string, outputDir: string, actual: unknown, artifact: string): boolean {
  if (typeof actual !== "string") {
    return false;
  }
  const expected = path.resolve(cwd, outputDir, artifact);
  const siblingForm = path.resolve(cwd, outputDir, actual);
  const legacyCwdForm = path.resolve(cwd, actual);
  return siblingForm === expected || legacyCwdForm === expected;
}

function readPrSurfaceArtifact(cwd: string, surfacePath: string): PrReviewSurfaceModel {
  const surface = JSON.parse(fs.readFileSync(surfacePath, "utf8")) as PrReviewSurfaceModel;
  assertValidPrSurface(cwd, surface);
  return surface;
}

function assertValidPrSurface(cwd: string, surface: unknown): void {
  const issues = prSurfaceIssues(cwd, surface);
  if (issues.length === 0) {
    return;
  }
  throw new CliError(`PR review surface failed schema validation: ${issues.join("; ")}`, ExitCodes.schemaValidationFailed);
}

function prSurfaceIssues(cwd: string, surface: unknown): string[] {
  const schema = loadPrSurfaceSchema(cwd);
  if (schema === undefined) {
    return [];
  }
  const result = validateJsonSchema(schema, surface);
  return result.valid ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

function jsonSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadPrSurfaceSchema(cwd: string): unknown | undefined {
  // review-surfaces.COLD_START.1: package-root resolution only (see loadHumanReviewSchema).
  const candidates = [packagedSchemaPath("pr_review_surface.schema.json")];
  for (const candidate of candidates) {
    if (!fileExists(candidate)) {
      continue;
    }
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch (error) {
      const reason = errorMessage(error);
      throw new CliError(
        `Unable to read PR review surface schema at ${path.relative(cwd, candidate)}: ${reason}`,
        ExitCodes.schemaValidationFailed
      );
    }
  }
  return undefined;
}

// Phase 6b (PROVIDERS.2; M6): write a SARIF 2.1.0 log from the local packet.
// Default output is <dir>/review.sarif under --out; --sarif-out overrides the
// exact file. Like the github path, an absent packet is a clean usage error and
// nothing is written. No network is ever touched.
async function runCommentSarif(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  // Same effective output-dir resolution as the github path: honor a config-set
  // output_dir so SARIF reads the packet `all` wrote, not a hardcoded default.
  const outDir = await resolveOutputDir(cwd, parsed);
  const rendered = renderSarifFromPacketFile(cwd, outDir);
  if (!rendered) {
    throw missingPacketError(cwd, outDir);
  }

  const sarifPath = stringFlag(parsed, "sarif-out")
    ? path.resolve(cwd, stringFlag(parsed, "sarif-out") as string)
    : path.join(path.dirname(rendered.packetPath), "review.sarif");
  await writeText(sarifPath, rendered.json);
  process.stdout.write(rendered.json);
  console.error(`Wrote ${displayPath(cwd, sarifPath)}`);
  return ExitCodes.success;
}

// review-surfaces.QUALITY_GATE.2: render the deterministic JSON run summary from
// the local packet to stdout. Renderer-only, fully offline. An absent packet is
// the same clean usage error the github/sarif paths emit.
async function runCommentJson(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const outDir = await resolveOutputDir(cwd, parsed);
  const config = await loadConfig(cwd, stringFlag(parsed, "config") ?? "review-surfaces.config.yaml");
  // Project the gate_code over the SAME GateOptions the real gate uses: --fail-on /
  // quality_gate.fail_on (the risk threshold) AND quality_gate.max_missing /
  // quality_gate.allow_missing (the missing-requirement tolerances). Passing only
  // fail_on would gate at maxMissing 0 with no allowlist and report a spurious
  // failing gate for a repo that relies on those tolerances.
  const rendered = renderRunSummaryFromPacketFile(cwd, outDir, gateOptionsFor(parsed, config));
  if (!rendered) {
    throw missingPacketError(cwd, outDir);
  }
  process.stdout.write(rendered.json);
  return ExitCodes.success;
}

function missingPacketError(cwd: string, outDir: string | undefined): CliError {
  const packetPath = resolvePacketPath(cwd, outDir);
  return new CliError(
    `No review packet JSON found at ${path.relative(cwd, packetPath)}. Run \`review-surfaces all\` first to generate it; comment does not recompute the pipeline.`,
    ExitCodes.usageError
  );
}

function parseArgs(args: string[]): ParsedArgs {
  if (args[0] === "--") {
    args = args.slice(1);
  }

  // DISTRIBUTION.9: `--version` in command position resolves like `--help`.
  const command = args.length === 0 || args[0] === "--help" ? "help" : args[0] === "--version" ? "version" : args[0];
  const rest = command === "help" ? args : args.slice(1);
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--") {
      positionals.push(...rest.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }

    const next = rest[index + 1];
    // Known boolean flags never consume the following token as a value, so e.g.
    // `validate --verbose packet.json` keeps packet.json as a positional AND
    // enables --verbose, instead of swallowing the path into flags.verbose. Value
    // flags keep the permissive `--flag value` form.
    if (!BOOLEAN_FLAGS.has(rawKey) && next && !next.startsWith("--")) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }

  // review-surfaces.CLI.9: reject any flag the CURRENT command does not read,
  // with a usage error and a nearest-name suggestion, rather than silently
  // ignoring it. The allow-list is COMMAND-SPECIFIC (FLAGS_BY_COMMAND): a flag
  // that is valid for SOME OTHER command (e.g. `all --format review`, where
  // `format` belongs to comment/human but `runAll` never reads it) is rejected
  // here instead of running as a normal `all` with a silently-ignored no-op
  // flag. The nearest-match suggestion still draws from the GLOBAL union so a
  // typo of a real-but-wrong-command flag (`--surfce`) still suggests `surface`.
  // Only validate flags for a KNOWN command. parseArgs runs BEFORE main()'s
  // unknown-command check, so gating on COMMANDS.includes(command) (which is
  // false for an unknown/misspelled command AND for the bare help/version
  // pseudo-commands) lets `coment --format github` report the command typo
  // ("Unknown command: coment (did you mean 'comment'?)") rather than a
  // misleading "Unknown flag: --format" for a flag the intended command reads.
  if (COMMANDS.includes(command)) {
    const allowed = flagsForCommand(command);
    for (const key of Object.keys(flags)) {
      if (!allowed.has(key)) {
        // A flag that is real but not read by THIS command (e.g. `scoreboard
        // --provider`) shouldn't suggest itself; say it's not accepted here.
        // Only a true typo (not a flag of any command) gets a nearest-match
        // suggestion, preferring this command's own flags.
        const knownElsewhere = KNOWN_FLAGS.has(key);
        const suggestion = knownElsewhere
          ? undefined
          : nearestMatch(key, [...allowed]) ?? nearestMatch(key, [...KNOWN_FLAGS]);
        const hint = knownElsewhere
          ? ` (not a flag '${command}' accepts)`
          : suggestion
            ? ` (did you mean --${suggestion}?)`
            : "";
        throw new CliError(`Unknown flag: --${key}${hint}`, ExitCodes.usageError);
      }
    }
  }

  return { command, flags, positionals };
}

// Flags that are always boolean switches (no value argument). Listed so the
// permissive parser does not consume a following positional as their "value".
const BOOLEAN_FLAGS = new Set(["cache", "check", "dogfood", "force", "json", "no-conversation-discovery", "no-redact-secrets", "post", "strict", "strict-postability", "verbose", "help", "interactive", "version"]);

// review-surfaces.CLI.9: the TRULY-UNIVERSAL minimum — only the flags EVERY
// command honors on every code path. --verbose drives the shared isVerbose stderr
// diagnostics AND the top-level catch's stack-trace toggle (runCliEntrypoint reads
// it from argv for ANY command, including init/bootstrap), so every command honors
// it. --help/--version are intercepted before any handler. --out/--config are
// DELIBERATELY NOT universal: `init` (runInit) and `bootstrap` (runBootstrap)
// scaffold/validate in process.cwd() and never call resolveOutputDir()/loadConfig(),
// so `init --out X` or `bootstrap --config Y` would be silent no-ops; CLI.9 must
// REJECT those. --out/--config are granted per-command (OUTPUT_CONFIG_FLAGS /
// OUTPUT_FLAGS below) only to commands whose code path actually reads them. The
// COLLECTOR / pipeline / surface flags below are likewise NOT here: a command that
// does not run the collector (scoreboard, validate, init, bootstrap, run, the human
// sub-artifact renderers) never reads --base/--head/--provider/--cache/etc., so
// passing one is a no-op the CLI.9 allow-list must REJECT, not silently ignore.
const UNIVERSAL_FLAGS = [
  "verbose",
  "help",
  "version"
] as const;

// review-surfaces.CLI.9: --out and --config both flow through resolveOutputDir()
// (which reads --out, and falls back to loadConfig(--config) to resolve the output
// dir) and through collect()/loadConfig() in the pipeline commands. Granted to
// every command that resolves an output dir or loads config — i.e. all commands
// EXCEPT init/bootstrap (which scaffold in cwd, reading neither) and run (which
// reads --out for the transcript dir but never loads config — see OUTPUT_FLAGS).
const OUTPUT_CONFIG_FLAGS = ["out", "config"] as const;

// review-surfaces.CLI.9: --out alone. `run` (runRecordedCommand) reads --out via
// transcriptDirFromOut() to place the recorded transcript, but never calls
// loadConfig()/resolveOutputDir(), so it does NOT read --config.
const OUTPUT_FLAGS = ["out"] as const;

// review-surfaces.CLI.9: the input flags the COLLECTOR reads. collect()
// (and buildStageContext, which calls collect()) reads --base/--head/--spec to
// resolve the diff range, --provider/--model to pick the reasoning provider,
// --now to freeze the clock, --dogfood to switch on the dogfood artifact, and the
// redaction toggles (--redact-secrets/--no-redact-secrets) for enrichment/
// narrative redaction. Every command that runs the collector (the pipeline
// commands + all/dogfood) gets these; commands that only render local artifacts
// (scoreboard, validate, comment, human, review, the human sub-artifacts) do NOT,
// because they never invoke the collector and so never read them.
const COLLECTOR_FLAGS = [
  "base",
  "head",
  "spec",
  "provider",
  "model",
  "now",
  "dogfood",
  "redact-secrets",
  "no-redact-secrets"
] as const;

// review-surfaces.CLI.9: the flags the pipeline-generating commands read on top
// of the universal + collector sets. These are the commands that run
// collect()/buildStageContext (collect, intent, evaluate, diagrams, methodology,
// risks, dogfood, handoff, packet, all): collect() reads --out (its outputDir) and
// --config (loadConfig) directly, plus the input flags (--command-transcripts,
// --test-output, --coverage, --conversation, --agent-input, --previous-packet) and
// applies --budget; reviewScope() reads --review-scope/--mode/--surface-mode.
// The gate flags (--strict/--max-missing) are NOT here: only the gating stages
// (evaluate/packet/all/dogfood) call applyGate, so they get GATE_FLAGS below and
// a non-gating stage (e.g. `collect --strict`) rejects them as a no-op.
const PIPELINE_EXTRA_FLAGS = [
  ...OUTPUT_CONFIG_FLAGS,
  ...COLLECTOR_FLAGS,
  "command-transcripts",
  "test-output",
  "coverage",
  "conversation",
  "conversation-format",
  "no-conversation-discovery",
  "agent-input",
  "previous-packet",
  "budget",
  "review-scope",
  "mode",
  "surface-mode"
] as const;

// review-surfaces.CLI.9: --strict/--max-missing are the MISSING-requirement gate
// flags, read by every stage that calls applyGate (evaluate/packet/all/dogfood),
// so they are granted to all four.
const GATE_FLAGS = ["strict", "max-missing"] as const;

// review-surfaces.QUALITY_GATE.1: --fail-on is the RISK-severity gate, which only
// fires when applyGate is given a risks model. evaluate's applyGate is called
// WITHOUT a risks model (the evaluate stage computes no risks), so --fail-on can
// never trip there — it would be a silent no-op. Grant it ONLY to the stages whose
// applyGate threads packet.risks: packet, all, dogfood.
const FAIL_ON_FLAG = ["fail-on"] as const;

// The flags selecting the comment/human review surface (reviewScope reads all
// three; --mode/--surface-mode are aliases of --review-scope).
const SCOPE_FLAGS = ["review-scope", "mode", "surface-mode"] as const;

function flagSet(...groups: readonly (readonly string[])[]): Set<string> {
  const set = new Set<string>(UNIVERSAL_FLAGS);
  for (const group of groups) {
    for (const flag of group) {
      set.add(flag);
    }
  }
  return set;
}

// review-surfaces.CLI.9: the per-command allow-list. Each entry is the universal
// set PLUS the flags THAT command actually reads (audited from the
// stringFlag/booleanFlag/numberFlag reads inside its handler/runner and the
// shared helpers it calls). A flag valid for another command but absent here is
// rejected on this command, so e.g. `all --format review` (format is a
// comment/human flag) is a usage error rather than a silently-ignored no-op.
const FLAGS_BY_COMMAND: Record<string, Set<string>> = {
  // collect()/buildStageContext pipeline commands share PIPELINE_EXTRA_FLAGS.
  collect: flagSet(PIPELINE_EXTRA_FLAGS),
  intent: flagSet(PIPELINE_EXTRA_FLAGS),
  evaluate: flagSet(PIPELINE_EXTRA_FLAGS, GATE_FLAGS),
  diagrams: flagSet(PIPELINE_EXTRA_FLAGS),
  methodology: flagSet(PIPELINE_EXTRA_FLAGS),
  risks: flagSet(PIPELINE_EXTRA_FLAGS),
  handoff: flagSet(PIPELINE_EXTRA_FLAGS),
  // review-surfaces.QUALITY_GATE.3: `packet --json` prints the structured run
  // summary to stdout (opt-in; default prose output stays byte-stable).
  // QUALITY_GATE.1: packet's applyGate threads packet.risks, so --fail-on works here.
  packet: flagSet(PIPELINE_EXTRA_FLAGS, GATE_FLAGS, FAIL_ON_FLAG, ["json"]),
  // all/dogfood are the pipeline commands that read the --cache snapshot. The
  // --cache path (readCacheSnapshot -> readSchemaValidPacket) validates the
  // on-disk packet against a custom --schema before reuse, so --cache AND --schema
  // are read here even though the other pipeline stages do not read them.
  // review-surfaces.QUALITY_GATE.3: --json prints the structured run summary.
  // QUALITY_GATE.1: all/dogfood route through runAll, whose applyGate threads
  // packet.risks, so --fail-on works here (unlike evaluate).
  all: flagSet(PIPELINE_EXTRA_FLAGS, ["cache", "schema", "json"], GATE_FLAGS, FAIL_ON_FLAG),
  dogfood: flagSet(PIPELINE_EXTRA_FLAGS, ["cache", "schema"], GATE_FLAGS, FAIL_ON_FLAG),
  // init only reads --force (overwrite scaffolding). runInit scaffolds into
  // process.cwd() and never calls resolveOutputDir()/loadConfig(), so it reads
  // NEITHER --out NOR --config; passing them must be rejected as a no-op.
  init: flagSet(["force"]),
  // bootstrap only reads --strict (turn missing scaffolding into a gate exit).
  // runBootstrap validates scaffolding in process.cwd() and never calls
  // resolveOutputDir()/loadConfig(), so it reads NEITHER --out NOR --config.
  bootstrap: flagSet(["strict"]),
  // human: resolveOutputDir (--out/--config) + applyBudgetFlag + reviewScope, and
  // --format markdown|html (the HTML cockpit, runHumanStage). NOT a pipeline command.
  human: flagSet(OUTPUT_CONFIG_FLAGS, SCOPE_FLAGS, ["budget", "format"]),
  // validate reads --surface and --schema (and the output dir via resolveOutputDir,
  // which reads --out/--config).
  validate: flagSet(OUTPUT_CONFIG_FLAGS, ["surface", "schema"]),
  // scoreboard reads --readme and --check (and the output dir via resolveOutputDir,
  // which reads --out/--config).
  scoreboard: flagSet(OUTPUT_CONFIG_FLAGS, ["readme", "check"]),
  // run records a command transcript: --id and --command-transcripts. It reads --out
  // via transcriptDirFromOut() to place the transcript, but never loads config, so it
  // gets OUTPUT_FLAGS (--out) only — NOT --config.
  run: flagSet(OUTPUT_FLAGS, ["id", "command-transcripts"]),
  // comment dispatches across ALL --format renderers (github/sticky/sarif/review),
  // so it reads every flag any of them read: --out/--config (resolveOutputDir +
  // loadConfig), --format, the scope flags, --budget, --post/--strict-postability
  // (github/sticky/review), the sticky flags (--comment-top-n/--artifact-name/
  // --run-id), and --sarif-out (sarif).
  comment: flagSet(OUTPUT_CONFIG_FLAGS, SCOPE_FLAGS, [
    "format",
    "budget",
    "post",
    "strict-postability",
    "comment-top-n",
    "artifact-name",
    "run-id",
    "sarif-out",
    // review-surfaces.QUALITY_GATE.2: `comment --format json` projects gate_code
    // over the SAME GateOptions the real gate uses, read via gateOptionsFor — both
    // the risk threshold (--fail-on) AND the missing-requirement tolerance
    // (--max-missing). Both must be accepted here or `comment --format json
    // --max-missing N` is wrongly rejected as an unknown flag even though the
    // renderer honors it.
    "fail-on",
    "max-missing"
  ]),
  // review: resolveOutputDir (--out/--config) + loadConfig + applyBudgetFlag +
  // reviewScope + the walkthrough flags --interactive and --author, plus --now
  // (runWalkthrough's createdAt reads nowFlag). --now is NOT universal, so review
  // must list it explicitly.
  review: flagSet(OUTPUT_CONFIG_FLAGS, SCOPE_FLAGS, ["budget", "interactive", "author", "now"])
};

// The standalone human sub-artifact commands (HUMAN_STANDALONE_ARTIFACTS) all run
// runHumanSubartifactStage: resolveOutputDir (--out/--config) + loadConfig +
// reviewScope, no other extra flags.
for (const artifact of HUMAN_STANDALONE_ARTIFACTS) {
  FLAGS_BY_COMMAND[artifact.command] = flagSet(OUTPUT_CONFIG_FLAGS, SCOPE_FLAGS);
}

// review-surfaces.CLI.9: the GLOBAL union of every flag any command reads — the
// candidate pool for the nearest-name suggestion (so a typo of a real flag that
// belongs to a DIFFERENT command still suggests it) and the completeness backstop
// the union-acceptance test guards. The per-command sets above decide acceptance;
// this set only powers the "did you mean" hint.
const KNOWN_FLAGS = new Set<string>(
  Object.values(FLAGS_BY_COMMAND).flatMap((set) => [...set])
);

// review-surfaces.CLI.9: the allow-list for `command`. Every dispatchable command
// has an explicit entry; the fallback (defensive — every COMMANDS entry is mapped
// above) is the universal set, so a newly-added command without a mapping still
// accepts the shared flags rather than rejecting everything.
function flagsForCommand(command: string): Set<string> {
  return FLAGS_BY_COMMAND[command] ?? flagSet();
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  return typeof value === "string" ? value : undefined;
}

// review-surfaces.METHODOLOGY.6: parse --conversation-format. An unrecognized
// value is ignored (returns undefined → auto-detect) rather than throwing, so a
// typo never aborts the run; the chosen adapter is announced on stderr.
function conversationFormatFlag(parsed: ParsedArgs): ConversationFormat | undefined {
  const value = stringFlag(parsed, "conversation-format");
  return value !== undefined && (CONVERSATION_FORMATS as string[]).includes(value)
    ? (value as ConversationFormat)
    : undefined;
}

function booleanFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.flags[key] === true || parsed.flags[key] === "true";
}

function optionalBooleanFlag(parsed: ParsedArgs, key: string): boolean | undefined {
  const value = parsed.flags[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === true || value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new CliError(`--${key} must be true or false`, ExitCodes.usageError);
}

function redactSecretsFlag(parsed: ParsedArgs, config: ReviewSurfacesConfig): boolean {
  const override = optionalBooleanFlag(parsed, "redact-secrets");
  if (override !== undefined) {
    return override;
  }
  if (booleanFlag(parsed, "no-redact-secrets")) {
    return false;
  }
  return config.privacy.redact_secrets;
}

// R6: the verbosity predicate, shared by isVerbose() (the parsed-args path) and
// main()'s catch (which has no ParsedArgs in scope). REVIEW_SURFACES_DEBUG=1|true
// is the env opt-in. OFF by default => byte-identical output.
function verboseFromEnv(): boolean {
  const env = process.env.REVIEW_SURFACES_DEBUG;
  return env === "1" || env === "true";
}

// R6: --verbose (or REVIEW_SURFACES_DEBUG=1|true) turns on stderr diagnostics.
function isVerbose(parsed: ParsedArgs): boolean {
  return booleanFlag(parsed, "verbose") || verboseFromEnv();
}

// R6: a framework-free verbose-only stderr logger. Writes ONLY when verbose, so
// the default path is byte-identical and golden artifact files are untouched.
function debug(parsed: ParsedArgs, message: string): void {
  if (isVerbose(parsed)) {
    process.stderr.write(`[review-surfaces] ${message}\n`);
  }
}

function isDogfoodRun(parsed: ParsedArgs): boolean {
  return parsed.command === "dogfood" || booleanFlag(parsed, "dogfood");
}

// Phase 5b (CLI.6): when --previous-packet is supplied in dogfood mode, resolve
// it (dir -> review_packet.json), load the previous packet, and compute the
// deterministic comparison vs the current packet. An absent/unreadable previous
// packet is a clean no-op: we still record the resolved path but compute no
// comparison, and behavior is otherwise unchanged.
function resolveComparisonInput(
  parsed: ParsedArgs,
  cwd: string,
  evaluation: EvaluationModel,
  risks: RisksModel
): DogfoodComparisonInput | undefined {
  const flagValue = stringFlag(parsed, "previous-packet");
  if (flagValue === undefined) {
    return undefined;
  }
  const previousPacketPath = resolvePreviousPacketPath(cwd, flagValue);
  const relativePath = path.relative(cwd, previousPacketPath) || previousPacketPath;
  const previous = loadPreviousPacket(previousPacketPath);
  if (!previous) {
    return { previous_packet_path: relativePath };
  }
  return {
    previous_packet_path: relativePath,
    comparison: comparePackets(previous, { evaluation, risks })
  };
}

function numberFlag(parsed: ParsedArgs, key: string): number | undefined {
  const value = stringFlag(parsed, key);
  if (value === undefined) {
    return undefined;
  }
  const parsedNumber = Number(value);
  if (!Number.isInteger(parsedNumber) || parsedNumber < 0) {
    throw new CliError(`--${key} must be a non-negative integer`, ExitCodes.usageError);
  }
  return parsedNumber;
}

function gateOptionsFor(parsed: ParsedArgs, config: ReviewSurfacesConfig): GateOptions {
  return {
    maxMissing: numberFlag(parsed, "max-missing") ?? config.quality_gate.max_missing,
    allowMissing: config.quality_gate.allow_missing,
    // review-surfaces.QUALITY_GATE.1: --fail-on overrides the config default; an
    // absent flag falls back to quality_gate.fail_on (null => off). The value is
    // validated against the severity ladder here (config already validated its).
    failOnSeverity: failOnSeverityFlag(parsed) ?? failOnSeverityFromConfig(config)
  };
}

// review-surfaces.QUALITY_GATE.1: parse --fail-on <severity>. An unrecognized
// value is a usage error (a typo must fail fast, not silently disarm the gate),
// and so is a BARE/valueless --fail-on: it REQUIRES a severity, so `--fail-on`
// with no argument (parsed as boolean true) must be a usage error too rather than
// silently treated as absent (falling back to config), which would disarm the
// flag the operator clearly meant to arm.
function failOnSeverityFlag(parsed: ParsedArgs): FailOnSeverity | undefined {
  const value = parsed.flags["fail-on"];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(
      `--fail-on requires a severity value, one of ${PACKET_SEVERITIES.join(", ")}`,
      ExitCodes.usageError
    );
  }
  if (!(PACKET_SEVERITIES as readonly string[]).includes(value)) {
    throw new CliError(
      `--fail-on must be one of ${PACKET_SEVERITIES.join(", ")} (got "${value}")`,
      ExitCodes.usageError
    );
  }
  return value as FailOnSeverity;
}

function failOnSeverityFromConfig(config: ReviewSurfacesConfig): FailOnSeverity | undefined {
  const value = config.quality_gate.fail_on;
  return value === null ? undefined : (value as FailOnSeverity);
}

// Apply the privacy/evidence/quality gate. The pure decision is computed
// unconditionally so the same code path runs with and without --strict.
//
// DEFAULT (no --strict): "fail gently" — warn about any tripped gate and return
// ExitCodes.success (0). This preserves the prior normal/dogfood exit behavior.
// --strict: return the gate exit code (5/4/10) and print a clear reason.
function applyGate(
  parsed: ParsedArgs,
  evaluation: EvaluationModel,
  collection: CollectionResult,
  provider: ProviderName,
  config: ReviewSurfacesConfig,
  // review-surfaces.QUALITY_GATE.1: the risks model the --fail-on threshold
  // inspects. Optional so the evaluate stage (no risks computed) still gates on
  // missing/evidence/privacy exactly as before.
  risks?: RisksModel
): number {
  const decision = gateDecision(evaluation, collection, provider, gateOptionsFor(parsed, config), risks?.items);
  if (decision.code === ExitCodes.success) {
    return ExitCodes.success;
  }
  if (booleanFlag(parsed, "strict")) {
    console.error(`Strict gate tripped (exit ${decision.code}): ${decision.reason}`);
    return decision.code;
  }
  console.warn(`Gate warning (would exit ${decision.code} under --strict): ${decision.reason}`);
  return ExitCodes.success;
}

// review-surfaces.QUALITY_GATE.3: when --json is set, print the SAME structured
// run summary (the QUALITY_GATE.2 projection) to stdout from the in-memory packet,
// as a SINGLE compact JSON line (serializeRunSummary). A no-op when --json is
// absent, so the default prose output stays byte-stable. The gate_code is
// projected over the SAME GateOptions the run's gate uses (max_missing/
// allow_missing/fail_on) AND the SAME gate context (the run's collection +
// requested provider), so a privacy-blocked remote run prints the SAME gate_code
// (5) the strict gate exited — not a spurious 0 from a mock recompute. top_queue_ids
// come from the ranked human-review queue just written under outDir (sibling
// human_review.json), trusted only when it matches this packet's head_sha.
function maybePrintRunSummaryJson(
  parsed: ParsedArgs,
  config: ReviewSurfacesConfig,
  packet: ReviewPacket,
  outDir: string,
  gateContext: GateContext
): void {
  if (!booleanFlag(parsed, "json")) {
    return;
  }
  const cwd = process.cwd();
  const headSha = typeof packet.manifest.head_sha === "string" ? packet.manifest.head_sha : undefined;
  const summary = projectRunSummary(packet, gateOptionsFor(parsed, config), readQueueIds(cwd, outDir, headSha), gateContext);
  process.stdout.write(serializeRunSummary(summary));
}

function providerFlag(parsed: ParsedArgs, config: ReviewSurfacesConfig): ProviderName {
  const provider = stringFlag(parsed, "provider") ?? config.llm.provider;
  try {
    return parseProviderName(provider);
  } catch (error) {
    throw new CliError(errorMessage(error), ExitCodes.usageError);
  }
}

function transcriptDirFromOut(parsed: ParsedArgs): string | undefined {
  const outputDir = stringFlag(parsed, "out");
  return outputDir ? commandTranscriptInputDir(process.cwd(), path.resolve(process.cwd(), outputDir)) : undefined;
}

function printHelp(): void {
  console.log(`review-surfaces ${VERSION}

Local-first human review decision cockpit for agent-generated code changes.

Usage:
  review-surfaces <command> [options]

Commands:
  init          Scaffold config, schema, ignore, feature spec, usage skill, and AGENTS.md into this repo (create-or-validate; never clobbers without --force)
  bootstrap     Validate that the init scaffolding exists and parses (validate-only; exits 10 with --strict when a required target is missing/invalid)
  collect       Write manifest and input indexes under .review-surfaces
  intent        Run the available local pipeline and write intent artifacts
  evaluate      Run the available local pipeline and write evaluation artifacts
  diagrams      Run the available local pipeline and write architecture artifacts
  methodology   Run the available local pipeline and write methodology artifacts
  risks         Run the available local pipeline and write risk artifacts
  dogfood       Run the available local pipeline in dogfood mode
  handoff       Run the available local pipeline and write agent handoff
  human         Render human_review.json, human_review.md, and standalone human artifacts
${humanStandaloneCommandHelp()}
  packet        Run the available local pipeline and write review packet
  all           Run the whole available local pipeline
  validate      Validate generated artifacts against their schemas. Default validates
                review_packet.json; --surface packet|human|pr|all|policy extends this to the
                human_review.json and pr_review_surface.json sidecars.
  run           Execute a local command and write a bounded command transcript
  scoreboard    Regenerate the marker-delimited README eval-scoreboard block from
                .review-surfaces/eval_scoreboard.json (idempotent; --check exits
                non-zero when the committed block is stale)
  comment       Render a review surface from local artifacts. With
                --format github (default) writes .review-surfaces/comment.md (a compact
                GitHub sticky comment); with --format sarif writes
                .review-surfaces/review.sarif (a SARIF 2.1.0 log); with --format review
                writes .review-surfaces/pending_review.json (a GitHub PENDING draft
                review of the hunk-anchored suggested comments — you edit and submit it;
                nothing is auto-submitted). Reads local artifacts only and never
                recomputes the pipeline.
  review        Interactive walkthrough of the ranked review queue. Steps through each
                item (inline hunk excerpt, reason, evidence) and captures decisions —
                accept / flag / false positive / comment — into a local feedback file so
                later runs downgrade or promote matching findings; comment drafts land in
                suggested_comments.md. A non-TTY environment prints the next item and exits.
                --interactive forces the loop over piped stdin; --author <name> labels feedback.

Options:
  --base <ref>      Base ref for diff collection; default: auto (first of
                    origin/HEAD, origin/main, origin/master, main, master)
  --head <ref>      Head ref for diff collection, default HEAD
  --spec <path>     Feature spec path, default from config
  --out <dir>       Output directory, default .review-surfaces
  --mode <s>      comment: pr, repo, or auto. Alias for --review-scope on comments.
  --surface-mode <s>
                   all: pr, repo, or auto. Alias for --review-scope on packet generation.
  --review-scope <s> all/comment: pr, repo, or auto (default repo). pr emits/reads a SEPARATE
                   diff-scoped surface (pr_review_surface.json): changed files mapped to
                   affected requirements, base-vs-head coverage delta, PR-specific risk
                   candidates, a PR change-impact diagram, and an LLM-authored narrative
                   (What changed / Why it matters / Review first). pr REQUIRES a non-mock
                   provider for the narrative; under mock it renders a blocked comment with
                   the deterministic scope counts (never a whole-repo fallback). repo is the
                   legacy whole-repo evaluation/risks/architecture comment (unchanged).
  --format <fmt>    comment: output format, one of github (default) | sticky | sarif | json | review.
                   github writes .review-surfaces/comment.md (the provider-narrative comment);
                   sticky writes the deterministic human-rollup .review-surfaces/comment.md;
                   sarif writes .review-surfaces/review.sarif (SARIF 2.1.0); json prints a
                   compact, byte-stable run-summary object (gate code, per-status requirement
                   counts, risk-severity histogram, top-N queue/risk ids) to stdout for CI;
                   review writes .review-surfaces/pending_review.json (a GitHub PENDING draft
                   review). All honor --out and read the local packet/human_review.json only.
                   human: output format, markdown (default) | html. markdown writes
                   .review-surfaces/human_review.md; html ALSO writes
                   .review-surfaces/human_review.html (the single-file offline review cockpit).
  --sarif-out <path>
                   comment --format sarif: write the SARIF log to this exact file instead
                   of <out>/review.sarif
  --dogfood         Mark run as dogfood and include dogfood/handoff sections
  --config <path>   Config path, default review-surfaces.config.yaml
  --schema <path>   Schema path for validate, default schemas/review_packet.schema.json
  --surface <s>     validate: packet (default), human, pr, or all. Selects which
                   generated artifact(s) to validate against their schema.
  --strict-postability
                   comment --review-scope pr: treat a non-postable PR surface as a
                   non-zero (evidence-validation) exit even without --post. Default off:
                   a local render writes comment.md and exits 0 (review-surfaces.RENDER.8).
  --conversation <path>
                   Optional text/Markdown/JSONL/YAML conversation log for methodology.
                   When omitted, the Claude Code session for this repo is auto-discovered
                   (read-only; the picked file is announced on stderr). --conversation wins.
  --conversation-format <claude-code|codex|cursor|normalized>
                   Force a raw-transcript adapter; default auto-detects by content shape
  --no-conversation-discovery
                   Disable session auto-discovery (use only an explicit --conversation)
  --command-transcripts <dir>
                   Optional command transcript directory; default .review-surfaces/commands
  --test-output <path>
                   Optional JUnit XML test report(s) (comma-separated) parsed into
                   per-test names + pass/fail evidence. Writes .review-surfaces/inputs/tests.results.json
  --coverage <path>
                   Optional istanbul coverage-summary.json with per-file pct, ingested alongside
                   --test-output. When the path is an lcov report (or omitted), the collector also
                   auto-detects coverage/lcov.info and intersects it with the diff.
  --id <id>       Optional transcript ID for run
  --provider <name> Optional enrichment provider: mock, ai-sdk, agent-file. Default mock
  --model <model>   Optional AI SDK model as <provider>:<model>, e.g. google:gemini-2.5-flash,
                   anthropic:claude-3-5-haiku-latest, or openai:gpt-4o-mini. Google/Gemini is the
                   first-class default; no prefix (or no --model) defaults to google:gemini-2.5-flash.
  --redact-secrets <bool>
                   Override config privacy.redact_secrets for this run.
  --agent-input <path>
                   Structured JSON/YAML enrichment produced by a coding agent
  --previous-packet <path-or-dir>
                   Dogfood only: a prior review_packet.json (or its directory) to
                   compare against. Computes status_changes, new/resolved overreach
                   and risks, and count deltas. Absent/unreadable is a clean no-op.
  --post            comment: OPTIONAL best-effort upsert of the rendered sticky comment to
                   the current PR via the gh CLI. Only acts when gh is available AND a PR
                   context is detectable; otherwise it just emits the local artifact. Never
                   required: without --post, comment only writes .review-surfaces/comment.md.
  --force           init: overwrite generated targets even when they already exist
  --strict          Turn gate findings into exit codes for all/evaluate/packet (and
                   bootstrap). Without --strict the pipeline fails gently: it prints
                   warnings and still exits 0 (default normal/dogfood behavior).
  --max-missing <n> Quality-gate tolerance: allow up to N "missing" requirements
                   before tripping. Default from config quality_gate.max_missing (0).
  --fail-on <sev>   all/packet/dogfood: trip the quality gate (exit 10) when any
                   DETERMINISTIC risk item is at or above this severity
                   (critical|high|medium|low|unknown). LLM-only hypotheses are excluded.
                   Composes with --strict exactly like --max-missing. Requires a severity
                   value (a bare --fail-on is a usage error). Default from config
                   quality_gate.fail_on (off). comment --format json reads it for gate_code.
                   (Not on evaluate: that stage computes no risks model to gate against.)
  --json            all/packet: also print a compact, byte-stable run-summary object (gate
                   code, per-status requirement counts, risk-severity histogram, top-N queue
                   ids) to stdout. Opt-in; the default prose output is unchanged without it.
  --now <ISO8601>   Freeze the clock: write this fixed instant as manifest.created_at
                   (and any other wall-clock value) so two runs with the same --now and
                   inputs produce byte-identical artifacts. Must be a parseable ISO 8601
                   timestamp. Absent: real wall-clock time (unchanged default).
  --cache           all: opt-in. Skip regeneration when --out already holds a manifest
                   whose deterministic signature matches the current inputs AND a valid
                   review_packet.json exists; reuses the existing packet and still applies
                   the --strict gate. Any input/provider/model/tool change is a cache miss
                   and regenerates. Absent: always regenerate (unchanged default).
  --budget <dur>    Override the human-review time budget for this run (forms like 15m, 1h,
                   1h30m). A bare --budget with no value is a usage error, not a silent off.
  --no-redact-secrets
                   Disable secret redaction for this run (overrides config privacy.redact_secrets;
                   equivalent to --redact-secrets false). Off by default — redaction stays on.
  --readme <path>   scoreboard: README to update/check, default README.md
  --run-id <id>     comment --format sticky: CI run id stamped into the sticky comment;
                   defaults to $GITHUB_RUN_ID when unset.
  --artifact-name <name>
                   comment --format sticky: artifact name referenced by the sticky comment.
  --comment-top-n <n>
                   comment --format sticky: cap the sticky comment to the top N items.
  --author <name>   review: label captured reviewer feedback with this author name.
  --verbose         Print resolved refs / diff source / output dir (and stack traces on an
                   unexpected failure) to stderr. Off by default (byte-silent stderr).
  --check           scoreboard: exit non-zero when the committed README block is stale,
                   instead of rewriting it (CI-friendly verify mode).
  --version         Print the version and exit
  --help            Show this help

Gate semantics (only enforced as exit codes with --strict):
  5  privacy block   provider is not "mock" AND the redacted diff blocked remote enrichment
  4  evidence failed any requirement result/overreach has status "invalid_evidence"
  10 quality gate    missing requirements exceed --max-missing / quality_gate.max_missing,
                     OR (with --fail-on / quality_gate.fail_on) a deterministic risk item is
                     at or above the threshold severity
  The first applicable gate wins, in the order 5 -> 4 -> 10. validate is unaffected
  and keeps returning 3 on schema-validation failure.
`);
}

function humanStandaloneCommandHelp(): string {
  return HUMAN_STANDALONE_ARTIFACTS
    .map((artifact) => `  ${artifact.command.padEnd(13)} Render ${artifact.artifact} from human_review.json`)
    .join("\n");
}

// review-surfaces.CLI.10: run the CLI only when this module is the process
// entrypoint (the bin shim spawns this compiled file directly). Importing it as
// a module — e.g. a test asserting `--help` lists every exported COMMAND — must
// be side-effect free and never trigger a stray pipeline run.
function runCliEntrypoint(): void {
  main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(errorMessage(error));
    // R6: under --verbose / REVIEW_SURFACES_DEBUG, also print the stack for an
    // unexpected (non-CliError) failure so the cause is debuggable. This catch is
    // outside main() and has no ParsedArgs, so read verbosity from argv/env (same
    // predicate as isVerbose). Off by default => unchanged single-line message.
    const verbose = process.argv.includes("--verbose") || verboseFromEnv();
    if (verbose && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = ExitCodes.runtimeError;
  });
}

if (require.main === module) {
  runCliEntrypoint();
}
