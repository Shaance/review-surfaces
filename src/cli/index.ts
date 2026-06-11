import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { formatReports, hasRequiredFailure, runBootstrap, runInit } from "../bootstrap/init";
import { recordCommandTranscript } from "../commands/runner";
import { commandTranscriptInputDir } from "../commands/transcripts";
import { collectInputs, CollectionResult } from "../collector/collect";
import { parseStructuredDiff } from "../collector/diff-hunks";
import { blobExistsAtRef, readFileAtRef, resolveGitRefSha, resolveMergeBaseSha } from "../collector/git";
import { computeSemanticChangeFacts, emptySemanticChangeFacts, SemanticChangeFacts } from "../risks/semantic-diff";
import { computeRankingEvidence, emptyRankingEvidence, RankingEvidence } from "../risks/ranking-evidence";
import { isTestPath } from "../scope/pr-scope";
import { intersectCoverageWithDiff } from "../tests-evidence/lcov";
import { parseBudgetDuration } from "../human/budget";
import { computeDependencyFacts } from "../risks/dependency-facts";
import { loadReviewPolicy, POLICY_FILE, POLICY_SCHEMA_PATH, ReviewPolicy } from "../feedback/policy";
import { computeConfigFacts } from "../risks/config-facts";
import { buildImportGraph, findSymbolImporters } from "../collector/import-graph";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { loadPrivacyIgnoreSync } from "../privacy/ignore";
import { stripUndefined } from "../core/guards";
import type { CoverageEvidence } from "../human/contract";
import { PROVENANCE_ARTIFACTS } from "../collector/artifact-provenance";
import { loadConfig, ReviewSurfacesConfig } from "../config/config";
import { CliError, ExitCodes } from "../core/exit-codes";
import { VERSION } from "../core/version";
import { fileExists, readJson } from "../core/files";
import { isRecord } from "../core/guards";
import { gateDecision, GateOptions } from "../core/gate";
import { buildArchitecture } from "../diagrams/diagrams";
import { buildDogfood, DogfoodComparisonInput } from "../dogfood/dogfood";
import { comparePackets, loadPreviousPacket, resolvePreviousPacketPath } from "../dogfood/compare";
import { EvaluationModel } from "../evaluation/evaluate";
import { buildIntent, IntentModel } from "../intent/intent";
import { effectiveModelId, enrichPacket, parseProviderName, providerFor, ProviderName } from "../llm/provider";
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
import { buildDraftReview } from "../render/draft-review";
import { postStickyComment } from "../render/post-comment";
import { writeJson, writeText } from "../core/files";
import { PACKET_SCHEMA_VERSION } from "../schema/review-packet-contract";
import { validateJsonFile, validateJsonSchema } from "../schema/json-schema";
import { buildHumanReview, humanReviewConfigSignature } from "../human/human-review";
import { ChangedImportEdge, computeChangedImportEdges } from "../human/change-graph";
import { ArchDriftResult, computeArchDriftFacts } from "../risks/arch-drift";
import { RoundsLedgerEntry } from "../human/contract";
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

const COMMANDS = [
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
  "run",
  "comment",
  "review"
];

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

  if (!COMMANDS.includes(parsed.command)) {
    throw new CliError(`Unknown command: ${parsed.command}`, ExitCodes.usageError);
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
  console.log(`Wrote review-surfaces artifacts to ${path.relative(process.cwd(), collection.outputDir) || "."}`);
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
  const collection = await collectInputs({
    cwd,
    config: runConfig,
    baseRef: stringFlag(parsed, "base") ?? "origin/main",
    headRef: stringFlag(parsed, "head") ?? "HEAD",
    outputDir: stringFlag(parsed, "out"),
    commandTranscriptDir: stringFlag(parsed, "command-transcripts"),
    testOutputPaths: splitTestOutputPaths(stringFlag(parsed, "test-output")),
    coverageOutputPath: stringFlag(parsed, "coverage"),
    dogfood: isDogfoodRun(parsed),
    now: nowFlag(parsed),
    provider: signatureProvider,
    model: signatureModel(parsed, runConfig, signatureProvider),
    conversationPath: stringFlag(parsed, "conversation"),
    agentInputPath: stringFlag(parsed, "agent-input"),
    configPath,
    previousPacketPath: resolvePreviousPacketInput(cwd, parsed)
  });
  printCollectionDiagnostics(parsed, cwd, collection);
  return { collection, config: runConfig };
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

interface HumanReviewArtifactInputs {
  packet?: ReviewPacket;
  prSurface?: PrReviewSurfaceModel;
  feedback?: FeedbackFile[];
  // A provider-built narrative to carry through a cache-hit rebuild so it is not
  // overwritten by the deterministic fallback (review-surfaces.NARRATIVE.1).
  narrative?: ChangeNarrative;
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
  const schemaPath = path.resolve(cwd, stringFlag(parsed, "schema") ?? "schemas/review_packet.schema.json");
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
  const prSurfaceReuse = cacheHit ? prSurfaceCacheReuse(parsed, collection, config) : undefined;
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
      const cachedNarrative = config.human_review.enabled
        ? readCachedNarrative(collection.outputDir, String(collection.manifest.head_sha ?? ""))
        : undefined;
      const cachedHumanInputs: HumanReviewArtifactInputs = {
        packet: cacheSnapshot.packet,
        prSurface: prSurfaceReuse.surface,
        feedback: collection.feedback,
        narrative: cachedNarrative
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
        console.log(`inputs unchanged (signature match); reusing existing packet at ${path.relative(cwd, cacheSnapshot.packetPath) || "."}`);
        return applyGate(parsed, evaluation, collection, provider, config);
      }
      await writeAndMaybeSummarizeHumanReviewFromArtifacts(cwd, collection.outputDir, reviewScope(parsed), config, cachedHumanInputs);
      console.log(`inputs unchanged (signature match); reusing existing packet at ${path.relative(cwd, cacheSnapshot.packetPath) || "."}`);
      return ExitCodes.success;
    }
    console.warn("Cached output is incomplete (evaluation.yaml missing/unreadable); regenerating to apply the --strict gate.");
  }
  const commands = [`review-surfaces ${parsed.command} ${process.argv.slice(3).join(" ")}`.trim()];
  const provider = providerFlag(parsed, config);
  const requestedModel = stringFlag(parsed, "model") ?? config.llm.model ?? undefined;
  const isPrScope = reviewScope(parsed) === "pr";
  // PR-mode contract: scope/coverage/risks are DETERMINISTIC and the LLM authors
  // ONLY the diff-scoped narrative. So in pr mode the whole-repo packet (a side
  // artifact here) is built with `mock`: the live provider is NOT spent on
  // whole-repo reasoning/enrichment (no wasted remote calls, no whole-repo context
  // leak) and the intent/evaluation the PR surface is derived from stay byte-stable
  // regardless of model output. The live provider is reserved for the PR narrative
  // step below. In repo mode this is exactly the requested provider (unchanged).
  const wholeRepoProvider: ProviderName = isPrScope ? "mock" : provider;
  debug(parsed, `provider=${provider} wholeRepo=${wholeRepoProvider} model=${requestedModel ?? "(default)"}`);
  const reviewAreas = buildReviewAreas({ config, repoIndex: collection.repoIndex });
  const areasOption = reviewAreas.mode === "config" ? { areas: reviewAreas.areas } : {};
  const intent = await buildIntent(cwd, collection);
  const methodology = await buildMethodology(cwd, collection, stringFlag(parsed, "conversation"), commands);

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
  const reasoningOptions = {
    redactSecrets,
    remotePrivacyBlocked: collection.privacy.remote_provider_blocked,
    // FINDING C: thread the SAME config-derived review areas evaluateIntent uses
    // (present only in config mode) into the candidate-evidence group mapping, so
    // a config-area-mapped citation upgrades missing -> partial like the
    // deterministic evaluator's mapping would. Undefined in fallback mode keeps
    // the prior repo-index-cluster behavior.
    reviewAreas: areasOption.areas
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
  let humanReviewDiff: StructuredDiff | undefined;
  if (isPrScope) {
    humanReviewDiff = readHumanReviewDiff(collection.outputDir);
    // Evaluate the base ref in a throwaway worktree for the coverage delta
    // (best-effort: degrades to current-status when the base can't be evaluated).
    const baseEvaluation = await evaluateBaseline({
      cwd,
      baseRef: stringFlag(parsed, "base") ?? "origin/main",
      config,
      specFlag: stringFlag(parsed, "spec")
    });
    // The narrative is the ONLY LLM step in pr mode: build a fresh provider with
    // the REQUESTED (live) provider/model here, separate from the deterministic
    // whole-repo `reasoningProvider`. intent/evaluation come from the mock-built
    // packet above, so the diff-scoped facts are deterministic per the contract.
    // Record the EFFECTIVE model (incl. REVIEW_SURFACES_AI_MODEL env), not the raw
    // CLI/config value, so surface reuse can tell an env-only model swap apart.
    const narrativeModel = effectiveNarrativeModel(parsed, config);
    const narrativeProvider = providerFor(provider, {
      model: narrativeModel,
      cwd,
      remotePrivacyBlocked: collection.privacy.remote_provider_blocked,
      agentInput: stringFlag(parsed, "agent-input")
    });
    const surface = await assemblePrReviewSurface({
      collection,
      intent: packet.intent,
      evaluation: packet.evaluation,
      baseEvaluation,
      reviewAreas: reviewAreas.areas,
      provider: narrativeProvider,
      providerName: provider,
      model: narrativeModel,
      redactSecrets,
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
  // review-surfaces.NARRATIVE.1: build the grounded narrative through the
  // requested provider (offline for mock/agent-file). It is anchor-validated here
  // and passed read-only into the human review build, never affecting the verdict.
  const narrative = config.human_review.enabled
    ? await buildHumanNarrativeForAll(cwd, parsed, config, writtenPacket, persistedSurface, humanReviewDiff, collection)
    : undefined;
  const humanReview = config.human_review.enabled
    ? await writeHumanReviewForPacket(cwd, collection.outputDir, writtenPacket, persistedSurface, humanReviewDiff, collection.feedback, config, narrative)
    : undefined;
  if (!config.human_review.enabled) {
    removeHumanReviewArtifacts(collection.outputDir);
  }
  if (enrichment.status === "skipped" || enrichment.status === "failed") {
    console.warn(enrichment.summary);
  }
  if (humanReview && config.human_review.default_entrypoint) {
    printHumanReviewTerminalSummary(cwd, collection.outputDir, humanReview);
  }
  console.log(`Wrote review-surfaces artifacts to ${path.relative(cwd, collection.outputDir) || "."}`);
  debug(parsed, `completed in ${Date.now() - startedAt}ms`);
  // Gate on the REQUESTED provider, not wholeRepoProvider: in pr mode the narrative
  // IS a remote call with the live provider, so a privacy-blocked diff must still
  // trip the strict privacy gate (exit 5). The mock whole-repo evaluation has no
  // invalid_evidence, so the evidence gate cannot false-positive from this.
  return applyGate(parsed, evaluation, collection, provider, config);
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

// review-surfaces.NARRATIVE.1: build the human-surface change narrative through
// the requested provider (mock/agent-file are offline; ai-sdk only with a key
// and after privacy filtering). The result is anchor-validated inside
// buildChangeNarrative and returned read-only.
async function buildHumanNarrativeForAll(
  cwd: string,
  parsed: ParsedArgs,
  config: ReviewSurfacesConfig,
  packet: ReviewPacket,
  prSurface: PrReviewSurfaceModel | undefined,
  diff: StructuredDiff | undefined,
  collection: CollectionResult
): Promise<ChangeNarrative> {
  const providerName = providerFlag(parsed, config);
  const provider = providerFor(providerName, {
    model: effectiveNarrativeModel(parsed, config),
    cwd,
    remotePrivacyBlocked: collection.privacy.remote_provider_blocked,
    agentInput: stringFlag(parsed, "agent-input")
  });
  return buildChangeNarrative({
    provider,
    providerName,
    packet,
    prSurface,
    // In repo scope the caller's diff is undefined (it is only parsed eagerly for
    // PR scope), so read the collected, redacted diff from the output dir — the
    // same source the human-review queue uses — to populate the anchor allowlist.
    diff: diff ?? readHumanReviewDiff(collection.outputDir),
    headSha: String(collection.manifest.head_sha ?? ""),
    maxClaims: config.human_review.narrative_max_claims,
    redactSecrets: redactSecretsFlag(parsed, config),
    remotePrivacyBlocked: collection.privacy.remote_provider_blocked
  });
}

function prSurfaceCacheReuse(parsed: ParsedArgs, collection: CollectionResult, config: ReviewSurfacesConfig): PrSurfaceCacheReuse {
  if (reviewScope(parsed) !== "pr") {
    return { reusable: true };
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
      (surface.llm?.model ?? undefined) === requestedModel
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
    conversationPath: stringFlag(parsed, "conversation")
  });
}

function logWrote(context: PipelineStageContext): void {
  console.log(`Wrote review-surfaces artifacts to ${path.relative(context.cwd, context.collection.outputDir) || "."}`);
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
  return applyGate(parsed, evaluation, context.collection, context.provider, context.config);
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
    console.log(`Human review disabled by config; removed generated human review artifacts from ${path.relative(cwd, outDir) || "."}`);
    return;
  }
  await writeHumanReviewFromArtifacts(cwd, outDir, reviewScope(parsed), config);
  // review-surfaces.RENDER.9: `human --format html` ALSO writes the single-file
  // offline cockpit, rendered from the same freshly-built model (a strict
  // sibling of the markdown renderer, with the same diff context for excerpts).
  const humanFormat = stringFlag(parsed, "format") ?? "markdown";
  if (humanFormat === "html") {
    const outputDir = outDir.endsWith(".json") ? path.dirname(outDir) : outDir;
    const model = (await readJson(path.join(outputDir, "human_review.json"))) as HumanReviewModel;
    const html = renderHumanReviewHtml(model, { diff: readHumanReviewDiff(outputDir) });
    const htmlPath = path.join(outputDir, "human_review.html");
    await writeText(htmlPath, html);
    console.log(`Human review (HTML): ${path.relative(cwd, htmlPath) || htmlPath}`);
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
      io.write(`Wrote reviewer feedback: ${path.relative(cwd, feedbackPath) || feedbackPath}`);
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
  const humanReview = await writeHumanReviewFromArtifacts(cwd, outDir, scope, config, inputs);
  if (config.human_review.default_entrypoint) {
    printHumanReviewTerminalSummary(cwd, outDir, humanReview);
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
): Promise<HumanReviewModel> {
  const context = await buildHumanReviewFromArtifacts(cwd, outDir, scope, config, inputs);
  await writeHumanReviewArtifacts(context.outputDir, context.model, humanRenderContext(context.outputDir));
  return context.model;
}

function printHumanReviewTerminalSummary(cwd: string, outDir: string, humanReview: HumanReviewModel): void {
  console.log(`Human review: ${artifactPathForLog(cwd, outDir, "human_review.md")}`);
  console.log(`Verdict: ${humanReview.verdict.decision}`);
  console.log(`Review first: ${humanReview.review_queue.length} item(s)`);
  console.log(`Blockers: ${humanReview.blockers.length}`);
  console.log(`Suggested comments: ${humanReview.suggested_comments.length}`);
  console.log(`Missing evidence: ${humanReview.trust_audit.missing_evidence.length}`);
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
): Promise<{ outputDir: string; model: HumanReviewModel }> {
  const outputDir = outDir.endsWith(".json") ? path.dirname(outDir) : outDir;
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
  if (surface) {
    if (!prSurfaceMatchesPacketManifest(packet, surface)) {
      console.warn(
        `Ignoring stale pr_review_surface.json; run review-surfaces all --review-scope pr to regenerate it for the current packet.`
      );
      return {
        outputDir,
        model: buildHumanReviewForPacket(cwd, outputDir, packet, undefined, undefined, inputs?.feedback ?? readHumanReviewFeedback(outputDir), config, inputs?.narrative)
      };
    }
  }
  return {
    outputDir,
    model: buildHumanReviewForPacket(cwd, outputDir, packet, surface, undefined, inputs?.feedback ?? readHumanReviewFeedback(outputDir), config, inputs?.narrative)
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
  narrative?: ChangeNarrative
): HumanReviewModel {
  const resolvedDiff = diff ?? readHumanReviewDiff(outDir);
  const factReaders = buildFactReaders(cwd, packet, resolvedDiff);
  // review-surfaces.POLICY.1: a malformed committed policy fails LOUDLY.
  let policy: ReviewPolicy | undefined;
  try {
    policy = loadReviewPolicy(cwd);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), ExitCodes.schemaValidationFailed);
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
  const humanReview = buildHumanReview({
    packet,
    prSurface,
    diff: resolvedDiff,
    feedback,
    config: effectiveConfig?.human_review,
    narrative,
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
    // review-surfaces.ARCH_DRIFT.1-3: base-vs-head resolved import diffs at
    // module altitude, computed here (base/head file access).
    archDrift: computeArchDriftForPacket(cwd, resolvedDiff, factReaders),
    // review-surfaces.TREND.1: carry the prior rounds ledger forward from the
    // previous packet's sibling human_review.json (any transport).
    previousRounds: readPreviousRounds(cwd, packet),
    packetPath: artifactPathForLog(cwd, outDir, "review_packet.json"),
    prSurfacePath: prSurface ? artifactPathForLog(cwd, outDir, "pr_review_surface.json") : undefined
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
  const headIsWorktree = !headSha || !worktreeHead || headSha === worktreeHead;
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
function computeArchDriftForPacket(cwd: string, diff: StructuredDiff | undefined, readers: FactReaders | undefined): ArchDriftResult | undefined {
  if (!diff || diff.files.length === 0 || !readers) {
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
  return computeArchDriftFacts({
    changedFiles: diff.files.map((file) => ({ path: file.path, ...(file.old_path ? { old_path: file.old_path } : {}), status: file.status })),
    readBase: readers.readBase,
    readHead: readers.readHead,
    existsBase: (filePath) => readers.baseReadRef !== "" && blobExistsAtRef(cwd, readers.baseReadRef, filePath),
    existsHead
  });
}

// review-surfaces.TREND.1: read the prior ledger from the previous packet's
// sibling human_review.json. Absent/unreadable/malformed -> first review.
function readPreviousRounds(cwd: string, packet: ReviewPacket): RoundsLedgerEntry[] | undefined {
  const previousPath = (packet.dogfood as { previous_packet_path?: unknown } | undefined)?.previous_packet_path;
  if (typeof previousPath !== "string" || previousPath.length === 0) {
    return undefined;
  }
  const humanPath = path.join(path.dirname(path.resolve(cwd, previousPath)), "human_review.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(humanPath, "utf8")) as { rounds?: unknown };
    if (!Array.isArray(parsed.rounds)) {
      return undefined;
    }
    const rounds = parsed.rounds.filter(
      (entry): entry is RoundsLedgerEntry =>
        typeof (entry as { round?: unknown }).round === "number" && typeof (entry as { head_sha?: unknown }).head_sha === "string"
    );
    return rounds.length > 0 ? rounds : undefined;
  } catch {
    return undefined;
  }
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

// review-surfaces.NARRATIVE.1: read the narrative from a previously written
// human_review.json so a cache hit can reuse it without re-invoking the provider.
// Only reuse it when it was validated against the CURRENT head — a stale artifact
// (older than the packet, e.g. after a stage command rewrote review_packet.json,
// or an interrupted run) is not reused, so claims validated against another
// head/diff are never rendered as current verified prose. Returns undefined when
// the artifact is absent/unreadable, carries no narrative, or is stale (the
// caller then renders the deterministic fallback against the current packet).
function readCachedNarrative(outDir: string, headSha: string): ChangeNarrative | undefined {
  const humanReviewPath = path.join(outDir.endsWith(".json") ? path.dirname(outDir) : outDir, "human_review.json");
  try {
    const model = JSON.parse(fs.readFileSync(humanReviewPath, "utf8")) as { narrative?: ChangeNarrative };
    if (model.narrative && headSha && model.narrative.validated_at_head === headSha) {
      return model.narrative;
    }
    return undefined;
  } catch {
    return undefined;
  }
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
    const message = error instanceof Error ? error.message : String(error);
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
  narrative?: ChangeNarrative
): Promise<HumanReviewModel> {
  const humanReview = buildHumanReviewForPacket(cwd, outDir, packet, prSurface, diff, feedback, config, narrative);
  await writeHumanReviewArtifacts(outDir, humanReview, humanRenderContext(outDir, diff));
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
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "schemas", "human_review.schema.json"),
    path.resolve(__dirname, "..", "..", "schemas", "human_review.schema.json"),
    path.resolve(cwd, "schemas/human_review.schema.json")
  ];
  for (const candidate of candidates) {
    if (!fileExists(candidate)) {
      continue;
    }
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError(
        `Unable to read human review schema at ${path.relative(cwd, candidate)}: ${reason}`,
        ExitCodes.schemaValidationFailed
      );
    }
  }
  return undefined;
}

function artifactPathForLog(cwd: string, outDir: string, fileName: string): string {
  const rel = path.relative(cwd, path.join(outDir, fileName));
  return rel || path.join(outDir, fileName);
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
      console.error(error instanceof Error ? error.message : String(error));
      return ExitCodes.schemaValidationFailed;
    }
    if (surface === "policy") {
      if (!loaded) {
        console.error(`No ${POLICY_FILE} found to validate.`);
        return ExitCodes.usageError;
      }
      console.log(`Validated ${POLICY_FILE} against ${POLICY_SCHEMA_PATH}`);
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
    console.error(`${path.relative(cwd, surfacePath)}: ${error instanceof Error ? error.message : String(error)}`);
    return ExitCodes.schemaValidationFailed;
  }
  const issues = issuesFor(cwd, surface);
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(issue);
    }
    return ExitCodes.schemaValidationFailed;
  }
  console.log(`Validated ${path.relative(cwd, surfacePath)} against the ${label} schema`);
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

  const schemaPath = path.resolve(cwd, customSchema ?? "schemas/review_packet.schema.json");
  const result = await validateJsonFile(schemaPath, packetPath);
  if (!result.valid) {
    for (const issue of result.issues) {
      console.error(`${issue.path}: ${issue.message}`);
    }
    return ExitCodes.schemaValidationFailed;
  }

  console.log(`Validated ${path.relative(cwd, packetPath)} against ${path.relative(cwd, schemaPath)}`);
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
  if (format === "sarif") {
    return runCommentSarif(parsed);
  }
  if (format === "review") {
    return runCommentDraftReview(parsed);
  }
  if (format === "sticky") {
    return runCommentSticky(parsed);
  }
  if (format !== "github") {
    throw new CliError(`Unknown --format: ${format}. Use github, sticky, sarif, or review.`, ExitCodes.usageError);
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
  await writeJson(reviewPath, draft.payload);
  process.stdout.write(`${JSON.stringify(draft.payload, null, 2)}\n`);
  console.error(
    `Wrote ${path.relative(cwd, reviewPath) || reviewPath} — ${draft.payload.comments.length} inline comment(s), ${draft.unanchored} general. ` +
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
  console.error(`Wrote ${path.relative(cwd, commentPath) || commentPath}`);

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
  console.error(`Wrote ${path.relative(cwd, commentPath)}`);

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
  // Point the comment's "Full PR surface" pointer at the ACTUAL artifact path
  // (honoring --out / config output_dir), not a hardcoded .review-surfaces.
  const humanCommentModel = await loadCurrentHumanReviewForPrComment(cwd, path.dirname(surfacePath), surface, config);
  const relativeSurfacePath = path.relative(cwd, surfacePath) || surfacePath;
  const humanRendered = humanCommentModel
    ? renderHumanPrComment(humanCommentModel, {
        surfacePath: relativeSurfacePath,
        humanReviewPath: artifactPathForLog(cwd, path.dirname(surfacePath), "human_review.md"),
        humanReviewJsonPath: artifactPathForLog(cwd, path.dirname(surfacePath), "human_review.json")
      })
    : undefined;
  const markdown = humanRendered ? humanRendered.markdown : renderPrComment(surface, { surfacePath: relativeSurfacePath });
  // review-surfaces.CHANGE_MAP.4: a redaction BLOCK inside the embedded map or
  // tour snippet must trip the privacy gate — the rendered body only carries
  // the placeholder, so this flag is the surviving signal.
  const renderBlocked = humanRendered?.blocked ?? false;
  const commentPath = path.join(path.dirname(surfacePath), "comment.md");
  await writeText(commentPath, markdown);
  process.stdout.write(markdown);
  console.error(`Wrote ${path.relative(cwd, commentPath)}`);
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
    const reason = error instanceof Error ? error.message : String(error);
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
    await writeHumanReviewArtifacts(context.outputDir, context.model, humanRenderContext(context.outputDir));
    return context.model;
  }
  if (!humanReviewJsonSatisfiesPrComment(humanReview)) {
    console.warn(
      `Refreshing stale human_review.json for the current human review artifact set before rendering the PR comment.`
    );
    const context = await buildHumanReviewFromArtifacts(cwd, outputDir, "pr", config);
    await writeHumanReviewArtifacts(context.outputDir, context.model, humanRenderContext(context.outputDir));
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
    artifactPathMatches(cwd, generatedFrom.pr_surface_path, artifactPathForLog(cwd, outputDir, "pr_review_surface.json"))
  );
}

function artifactPathMatches(cwd: string, actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") {
    return false;
  }
  return normalizeArtifactPath(cwd, actual) === normalizeArtifactPath(cwd, expected);
}

function normalizeArtifactPath(cwd: string, value: string): string {
  return path.relative(cwd, path.resolve(cwd, value));
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
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "schemas", "pr_review_surface.schema.json"),
    path.resolve(__dirname, "..", "..", "schemas", "pr_review_surface.schema.json"),
    path.resolve(cwd, "schemas/pr_review_surface.schema.json")
  ];
  for (const candidate of candidates) {
    if (!fileExists(candidate)) {
      continue;
    }
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
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
  console.error(`Wrote ${path.relative(cwd, sarifPath)}`);
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

  const command = args.length === 0 || args[0] === "--help" ? "help" : args[0];
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

  return { command, flags, positionals };
}

// Flags that are always boolean switches (no value argument). Listed so the
// permissive parser does not consume a following positional as their "value".
const BOOLEAN_FLAGS = new Set(["cache", "dogfood", "force", "no-redact-secrets", "post", "strict", "strict-postability", "verbose", "help", "interactive"]);

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  return typeof value === "string" ? value : undefined;
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
    allowMissing: config.quality_gate.allow_missing
  };
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
  config: ReviewSurfacesConfig
): number {
  const decision = gateDecision(evaluation, collection, provider, gateOptionsFor(parsed, config));
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

function providerFlag(parsed: ParsedArgs, config: ReviewSurfacesConfig): ProviderName {
  const provider = stringFlag(parsed, "provider") ?? config.llm.provider;
  try {
    return parseProviderName(provider);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), ExitCodes.usageError);
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
  --base <ref>      Base ref for diff collection, default origin/main
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
  --format <fmt>    comment: output format, github (default) or sarif. github writes
                   .review-surfaces/comment.md; sarif writes .review-surfaces/review.sarif
                   (SARIF 2.1.0). Both honor --out and read the local packet only.
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
                   Optional text/Markdown/JSONL/YAML conversation log for methodology
  --command-transcripts <dir>
                   Optional command transcript directory; default .review-surfaces/commands
  --test-output <path>
                   Optional JUnit XML test report(s) (comma-separated) parsed into
                   per-test names + pass/fail evidence. Writes .review-surfaces/inputs/tests.results.json
  --coverage <path>
                   Optional istanbul coverage-summary.json with per-file pct, ingested alongside --test-output
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
  --now <ISO8601>   Freeze the clock: write this fixed instant as manifest.created_at
                   (and any other wall-clock value) so two runs with the same --now and
                   inputs produce byte-identical artifacts. Must be a parseable ISO 8601
                   timestamp. Absent: real wall-clock time (unchanged default).
  --cache           all: opt-in. Skip regeneration when --out already holds a manifest
                   whose deterministic signature matches the current inputs AND a valid
                   review_packet.json exists; reuses the existing packet and still applies
                   the --strict gate. Any input/provider/model/tool change is a cache miss
                   and regenerates. Absent: always regenerate (unchanged default).
  --help            Show this help

Gate semantics (only enforced as exit codes with --strict):
  5  privacy block   provider is not "mock" AND the redacted diff blocked remote enrichment
  4  evidence failed any requirement result/overreach has status "invalid_evidence"
  10 quality gate    missing requirements exceed --max-missing / quality_gate.max_missing
  The first applicable gate wins, in the order 5 -> 4 -> 10. validate is unaffected
  and keeps returning 3 on schema-validation failure.
`);
}

function humanStandaloneCommandHelp(): string {
  return HUMAN_STANDALONE_ARTIFACTS
    .map((artifact) => `  ${artifact.command.padEnd(13)} Render ${artifact.artifact} from human_review.json`)
    .join("\n");
}

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
    console.error(error instanceof Error ? error.message : String(error));
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
