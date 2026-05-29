import fs from "node:fs";
import path from "node:path";
import { formatReports, hasRequiredFailure, runBootstrap, runInit } from "../bootstrap/init";
import { recordCommandTranscript } from "../commands/runner";
import { commandTranscriptInputDir } from "../commands/transcripts";
import { collectInputs, CollectionResult } from "../collector/collect";
import { loadConfig, ReviewSurfacesConfig } from "../config/config";
import { CliError, ExitCodes } from "../core/exit-codes";
import { fileExists } from "../core/files";
import { gateDecision, GateOptions } from "../core/gate";
import { ArchitectureModel, buildArchitecture, buildArchitectureModel } from "../diagrams/diagrams";
import { buildDogfood, DogfoodComparisonInput, DogfoodModel } from "../dogfood/dogfood";
import { comparePackets, loadPreviousPacket, resolvePreviousPacketPath } from "../dogfood/compare";
import { EvaluationModel, evaluateIntent, verifyRequirementsWithTests } from "../evaluation/evaluate";
import { buildIntent, IntentModel } from "../intent/intent";
import { effectiveModelId, enrichPacket, EnrichmentResult, parseProviderName, providerFor, ProviderName } from "../llm/provider";
import { ReasoningOptions, runEvaluationReasoning, runIntentReasoning, runNarrativeReasoning } from "../llm/reasoning";
import { buildMethodology, MethodologyModel } from "../methodology/methodology";
import { buildReviewAreas, ReviewArea } from "../review-areas/areas";
import { analyzeRisks, RisksModel } from "../risks/risks";
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
import { loadDogfood, loadEvaluation, loadIntent, loadMethodology, loadRisks } from "../render/load";
import { renderCommentFromPacketFile, resolvePacketPath } from "../render/comment";
import { renderSarifFromPacketFile } from "../render/sarif";
import { postStickyComment } from "../render/post-comment";
import { writeText } from "../core/files";
import { validateJsonFile, validateJsonSchema } from "../schema/json-schema";

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
  "packet",
  "all",
  "validate",
  "run",
  "comment"
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
    case "init":
      return runInitCommand(parsed);
    case "bootstrap":
      return runBootstrapCommand(parsed);
    case "comment":
      return runComment(parsed);
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

async function collect(parsed: ParsedArgs): Promise<{ collection: CollectionResult; config: ReviewSurfacesConfig }> {
  const cwd = process.cwd();
  // The exact config path loadConfig reads. Fold its content into the signature
  // (via collectInputs) so a config edit is a cache miss; loadConfig falls back
  // to defaults when the file is absent, and the "missing" sentinel covers that.
  const configPath = stringFlag(parsed, "config") ?? "review-surfaces.config.yaml";
  const config = await loadConfig(cwd, configPath);
  const specFlag = stringFlag(parsed, "spec");
  const runConfig = specFlag ? { ...config, specs: [specFlag] } : config;
  const provider = providerFlag(parsed, runConfig);
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
    provider,
    model: signatureModel(parsed, runConfig, provider),
    conversationPath: stringFlag(parsed, "conversation"),
    agentInputPath: stringFlag(parsed, "agent-input"),
    configPath,
    previousPacketPath: resolvePreviousPacketInput(cwd, parsed)
  });
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
  packetPath: string;
  packetValid: boolean;
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

// Resolve the output location the comment/SARIF renderers should read, applying
// the SAME precedence as collectInputs (--out -> config.output_dir ->
// .review-surfaces). An explicit --out (which may be a directory OR a .json path)
// is preserved verbatim via path.resolve; otherwise the config's output_dir is
// used so a repo that configured output_dir gets its packet found without --out.
// The returned value is fed straight to resolvePacketPath, which appends
// review_packet.json for a directory and uses a .json path as-is.
async function resolveCommentOutDir(cwd: string, parsed: ParsedArgs): Promise<string> {
  return resolveOutputDir(cwd, parsed);
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
  if (fileExists(manifestPath)) {
    try {
      manifestRaw = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(manifestRaw);
      if (parsed && typeof parsed.signature === "string") {
        priorSignature = parsed.signature;
      }
    } catch {
      manifestRaw = "";
      priorSignature = undefined;
    }
  }
  let packetValid = false;
  if (fileExists(packetPath)) {
    packetValid = await isSchemaValidPacket(cwd, parsed, packetPath);
  }
  return { manifestPath, manifestRaw, priorSignature, packetPath, packetValid };
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
async function isSchemaValidPacket(cwd: string, parsed: ParsedArgs, packetPath: string): Promise<boolean> {
  let packetData: unknown;
  try {
    packetData = JSON.parse(fs.readFileSync(packetPath, "utf8"));
  } catch {
    return false; // unparseable => cache miss
  }
  const schemaPath = path.resolve(cwd, stringFlag(parsed, "schema") ?? "schemas/review_packet.schema.json");
  let schema: unknown;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    // Schema unavailable: keep the prior parseable-only behavior so caching still
    // works on repos without a checked-in schema.
    return true;
  }
  return validateJsonSchema(schema, packetData).valid;
}

function isCacheHit(snapshot: CacheSnapshot, currentSignature: string | undefined): boolean {
  return (
    snapshot.packetValid &&
    snapshot.manifestRaw !== "" &&
    typeof currentSignature === "string" &&
    snapshot.priorSignature === currentSignature
  );
}

async function runAll(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  // --cache is opt-in. Snapshot the prior manifest BEFORE collect recomputes
  // (and overwrites) it, so a signature match can be detected and the on-disk
  // manifest/packet left byte-identical. Without --cache nothing is read here.
  const cacheSnapshot = booleanFlag(parsed, "cache") ? await readCacheSnapshot(cwd, parsed) : undefined;
  const { collection, config } = await collect(parsed);
  if (cacheSnapshot && isCacheHit(cacheSnapshot, collection.manifest.signature)) {
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
      console.log(`inputs unchanged (signature match); reusing existing packet at ${path.relative(cwd, cacheSnapshot.packetPath) || "."}`);
      const provider = providerFlag(parsed, config);
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
        return applyGate(parsed, evaluation, collection, provider, config);
      }
      return ExitCodes.success;
    }
    console.warn("Cached output is incomplete (evaluation.yaml missing/unreadable); regenerating to apply the --strict gate.");
  }
  const commands = [`review-surfaces ${parsed.command} ${process.argv.slice(3).join(" ")}`.trim()];
  const provider = providerFlag(parsed, config);
  const requestedModel = stringFlag(parsed, "model") ?? config.llm.model ?? undefined;
  const reviewAreas = buildReviewAreas({ config, repoIndex: collection.repoIndex });
  const areasOption = reviewAreas.mode === "config" ? { areas: reviewAreas.areas } : {};
  const intent = await buildIntent(cwd, collection);
  const methodology = await buildMethodology(cwd, collection, stringFlag(parsed, "conversation"), commands);

  // Phase 3-2: schema-bound, evidence-gated reasoning stages run with the
  // resolved provider. The default mock provider returns not-ok, so every stage
  // is a no-op and the deterministic packet below stays byte-stable.
  const reasoningProvider = providerFor(provider, {
    model: requestedModel,
    cwd,
    remotePrivacyBlocked: collection.privacy.remote_provider_blocked,
    agentInput: stringFlag(parsed, "agent-input")
  });
  const reasoningOptions = {
    redactSecrets: config.privacy.redact_secrets,
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
  const preEnrichment: EnrichmentResult = {
    provider,
    model: requestedModel,
    status: "not_requested",
    summary: "Enrichment has not run yet."
  };
  const packet = createReviewPacket({
    collection,
    intent,
    evaluation,
    methodology,
    risks,
    architecture,
    enrichment: preEnrichment,
    commands
  });
  const enrichment = await enrichPacket(packet, {
    cwd,
    provider,
    model: requestedModel,
    agentInput: stringFlag(parsed, "agent-input"),
    outputDir: collection.outputDir,
    redactSecrets: config.privacy.redact_secrets,
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
  await writeReviewPacket({
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
  if (enrichment.status === "skipped" || enrichment.status === "failed") {
    console.warn(enrichment.summary);
  }
  console.log(`Wrote review-surfaces artifacts to ${path.relative(cwd, collection.outputDir) || "."}`);
  return applyGate(parsed, evaluation, collection, provider, config);
}

// ---------------------------------------------------------------------------
// Phase 4a: composable per-stage subcommands.
//
// Each subcommand runs ONLY its stage. Dependencies are loaded from prior-stage
// artifacts under --out when present (LOAD), and computed only when the artifact
// is missing (ELSE-COMPUTE). Each subcommand writes ONLY its own artifact(s).
// `all` keeps orchestrating the full pipeline (runAll above) unchanged.
//
// The shared StageContext mirrors runAll's provider/areas/config/commands wiring
// so a stage produces the same models whether run standalone or inside `all`.
// ---------------------------------------------------------------------------

interface StageContext {
  cwd: string;
  parsed: ParsedArgs;
  collection: CollectionResult;
  config: ReviewSurfacesConfig;
  commands: string[];
  provider: ProviderName;
  requestedModel?: string;
  areasOption: { areas?: ReviewArea[] };
  // FINDING E: the deterministic signature recorded in the PRIOR manifest.json
  // (read BEFORE collect() overwrote it with the current run's signature). When it
  // does not match the current collection signature, any prior-stage artifacts
  // under --out (intent/evaluation/risks.yaml) were produced from DIFFERENT inputs
  // and must NOT be loaded as-is -- they would publish a packet whose
  // coverage/risks are stale relative to the current manifest/architecture.
  // Undefined when there was no prior manifest (first run) -- nothing to load
  // anyway, so the stages compute normally.
  priorSignature?: string;
}

// FINDING E: read the signature stamped in the prior manifest.json (if any) so a
// composable stage can tell whether prior-stage artifacts under --out were
// produced from the SAME inputs. Must be called BEFORE collect() rewrites the
// manifest. Any read/parse failure (no prior run, corrupt manifest) yields
// undefined, which forces a recompute (never a stale load).
async function readPriorManifestSignature(cwd: string, parsed: ParsedArgs): Promise<string | undefined> {
  const outputDir = await resolveOutputDir(cwd, parsed);
  const manifestPath = path.join(outputDir, "manifest.json");
  if (!fileExists(manifestPath)) {
    return undefined;
  }
  try {
    const parsedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return parsedManifest && typeof parsedManifest.signature === "string" ? parsedManifest.signature : undefined;
  } catch {
    return undefined;
  }
}

async function buildStageContext(parsed: ParsedArgs): Promise<StageContext> {
  const cwd = process.cwd();
  // FINDING E: snapshot the prior manifest signature BEFORE collect() overwrites
  // manifest.json with the current run's signature, so stale prior-stage artifacts
  // can be detected and recomputed rather than loaded.
  const priorSignature = await readPriorManifestSignature(cwd, parsed);
  const { collection, config } = await collect(parsed);
  const commands = [`review-surfaces ${parsed.command} ${process.argv.slice(3).join(" ")}`.trim()];
  const provider = providerFlag(parsed, config);
  const requestedModel = stringFlag(parsed, "model") ?? config.llm.model ?? undefined;
  const reviewAreas = buildReviewAreas({ config, repoIndex: collection.repoIndex });
  const areasOption = reviewAreas.mode === "config" ? { areas: reviewAreas.areas } : {};
  return { cwd, parsed, collection, config, commands, provider, requestedModel, areasOption, priorSignature };
}

// FINDING E: prior-stage artifacts under --out are only safe to LOAD when they
// were produced from the SAME inputs as this run. The current signature lives in
// the freshly-written manifest; the prior signature was snapshotted before
// collect() overwrote it. They match => prior artifacts are current and may be
// reused (compose). They differ (inputs changed) OR there is no current signature
// => recompute every stage so a reused --out never publishes stale coverage/risks.
function priorArtifactsAreCurrent(context: StageContext): boolean {
  const currentSignature = context.collection.manifest.signature;
  return typeof currentSignature === "string" && context.priorSignature === currentSignature;
}

// FINDING E: signature-gated artifact loaders. Each returns the prior-stage
// artifact ONLY when its producing manifest signature matches the current run
// (priorArtifactsAreCurrent); otherwise null, so the caller recomputes the stage
// from current inputs instead of composing a stale artifact. When inputs are
// unchanged these are exactly the underlying loaders, so compose==monolith and
// the byte-stable offline path are preserved.
function loadCurrentIntent(context: StageContext): IntentModel | null {
  return priorArtifactsAreCurrent(context) ? loadIntent(context.collection.outputDir) : null;
}

function loadCurrentEvaluation(context: StageContext): EvaluationModel | null {
  return priorArtifactsAreCurrent(context) ? loadEvaluation(context.collection.outputDir) : null;
}

function loadCurrentMethodology(context: StageContext): MethodologyModel | null {
  return priorArtifactsAreCurrent(context) ? loadMethodology(context.collection.outputDir) : null;
}

function loadCurrentRisks(context: StageContext): RisksModel | null {
  return priorArtifactsAreCurrent(context) ? loadRisks(context.collection.outputDir) : null;
}

function loadCurrentDogfood(context: StageContext): DogfoodModel | null {
  return priorArtifactsAreCurrent(context) ? loadDogfood(context.collection.outputDir) : null;
}

function reasoningProviderFor(context: StageContext) {
  return providerFor(context.provider, {
    model: context.requestedModel,
    cwd: context.cwd,
    remotePrivacyBlocked: context.collection.privacy.remote_provider_blocked,
    agentInput: stringFlag(context.parsed, "agent-input")
  });
}

function logComputed(label: string): void {
  console.log(`Computed missing ${label} dependency.`);
}

// Compute intent + run the resolved reasoning intent stage in place. Used by the
// intent subcommand and as the ELSE-COMPUTE for downstream stages. Only stage 1
// (intent synthesis) touches intent, so we run exactly that slice; placeholders
// for the cross-cutting models are never consulted, and mock is a no-op.
async function computeEnrichedIntent(context: StageContext): Promise<IntentModel> {
  const intent = await buildIntent(context.cwd, context.collection);
  await runIntentReasoning(
    reasoningProviderFor(context),
    {
      collection: context.collection,
      intent,
      evaluation: emptyEvaluation(),
      methodology: emptyMethodology(),
      risks: emptyRisks()
    },
    reasoningOptionsFor(context)
  );
  return intent;
}

function reasoningOptionsFor(context: StageContext) {
  return {
    redactSecrets: context.config.privacy.redact_secrets,
    remotePrivacyBlocked: context.collection.privacy.remote_provider_blocked,
    // FINDING C: thread the SAME config-derived review areas evaluateIntent uses
    // (config mode only) so the composed candidate-evidence stage maps cited paths
    // by config area, matching `all`. Undefined in fallback mode preserves the
    // prior repo-index-cluster behavior.
    reviewAreas: context.areasOption.areas
  };
}

async function loadOrComputeIntent(context: StageContext, label = "intent"): Promise<IntentModel> {
  // FINDING E: only compose a prior intent.yaml when it was produced from the same
  // inputs; otherwise recompute so a reused --out never reuses a stale artifact.
  const loaded = loadCurrentIntent(context);
  if (loaded) {
    return loaded;
  }
  logComputed(label);
  return computeEnrichedIntent(context);
}

// FINDING C: the load-or-compute fallback for a MISSING evaluation.yaml (used by
// the composable diagrams/handoff stages). It must produce the SAME evaluation
// the `evaluate`/`all` path produces -- i.e. with the candidate-evidence
// reasoning stage AND the partial -> satisfied verification loop applied -- so a
// standalone diagrams/handoff run builds from POST-promotion statuses rather than
// pre-promotion ones. The intent passed in is already intent-reasoned (its
// caller runs computeEnrichedIntent), so only the evaluation-owned reasoning +
// verification are slotted here. Under mock / without --test-output both are
// no-ops, so the byte-stable offline path is preserved.
async function computeEvaluation(context: StageContext, intent: IntentModel): Promise<EvaluationModel> {
  const evaluation = await evaluateIntent(context.cwd, context.collection, intent, context.areasOption);
  // Stage 2 (candidate evidence) attaches LLM-pinpointed test refs the verification
  // loop may rely on, and may upgrade missing -> partial. Its risks.review_focus
  // side effect lands on a throwaway here (diagrams/handoff do not own risks.yaml).
  await runEvaluationReasoning(
    reasoningProviderFor(context),
    {
      collection: context.collection,
      intent,
      evaluation,
      methodology: emptyMethodology(),
      risks: emptyRisks()
    },
    reasoningOptionsFor(context)
  );
  // VERIFICATION LOOP (#2): apply the partial -> satisfied promotion, matching
  // `evaluate`/`all`. No-op without --test-output.
  verifyRequirementsWithTests(context.collection, intent, evaluation, context.areasOption);
  return evaluation;
}

async function loadOrComputeEvaluation(
  context: StageContext,
  intentForCompute: () => Promise<IntentModel>
): Promise<EvaluationModel> {
  // FINDING E: only compose a prior evaluation.yaml when its producing signature
  // matches; a stale coverage artifact must be recomputed, not reused.
  const loaded = loadCurrentEvaluation(context);
  if (loaded) {
    return loaded;
  }
  logComputed("evaluation");
  return computeEvaluation(context, await intentForCompute());
}

async function computeMethodology(context: StageContext): Promise<MethodologyModel> {
  return buildMethodology(context.cwd, context.collection, stringFlag(context.parsed, "conversation"), context.commands);
}

async function loadOrComputeMethodology(context: StageContext): Promise<MethodologyModel> {
  // FINDING E: recompute when the prior methodology.yaml is stale (signature
  // mismatch) instead of composing it.
  const loaded = loadCurrentMethodology(context);
  if (loaded) {
    return loaded;
  }
  logComputed("methodology");
  return computeMethodology(context);
}

function computeRisks(context: StageContext, evaluation: EvaluationModel, methodology: MethodologyModel): RisksModel {
  return analyzeRisks(context.collection, evaluation, context.commands, methodology);
}

async function loadOrComputeRisks(
  context: StageContext,
  evaluationForCompute: () => Promise<EvaluationModel>,
  methodologyForCompute: () => Promise<MethodologyModel>
): Promise<RisksModel> {
  // FINDING E: recompute when the prior risks.yaml is stale (signature mismatch)
  // instead of composing it.
  const loaded = loadCurrentRisks(context);
  if (loaded) {
    return loaded;
  }
  logComputed("risks");
  return computeRisks(context, await evaluationForCompute(), await methodologyForCompute());
}

async function computeArchitecture(context: StageContext, evaluation: EvaluationModel): Promise<ArchitectureModel> {
  return buildArchitecture(context.collection, evaluation, context.areasOption);
}

// Per-stage isolation: build the architecture MODEL without the diagrams/*.mmd
// disk side effect, for stages that need the model but do NOT own the diagrams
// artifact (the `risks` enrichment-parity packet, the `handoff` packet inputs).
// The model is byte-identical to computeArchitecture's; only the disk write is
// dropped, so a standalone `risks`/`handoff` run no longer leaks diagrams/.
function computeArchitectureModel(context: StageContext, evaluation: EvaluationModel): ArchitectureModel {
  return buildArchitectureModel(context.collection, evaluation, context.areasOption);
}

interface EnrichedModels {
  intent: IntentModel;
  evaluation: EvaluationModel;
  methodology: MethodologyModel;
  risks: RisksModel;
}

// Reproduce the EXACT models the monolith `all` run holds after reasoning, by
// building the same deterministic models in the same order and running the same
// full reasoning sequence. A composed subcommand then persists only its own
// artifact from these, so compose==monolith holds for every artifact even under
// non-mock providers (e.g. offline agent-file). With mock, runReasoningStages is
// a no-op and these collapse to the deterministic models, byte-stable as before.
//
// NOTE: intent/evaluation/methodology/risks are built fresh and deterministically
// here (never loaded from possibly-already-enriched artifacts) so reasoning is
// applied exactly once, matching `all` and staying idempotent across composed
// invocations.
async function buildEnrichedModels(context: StageContext): Promise<EnrichedModels> {
  const intent = await buildIntent(context.cwd, context.collection);
  const methodology = await computeMethodology(context);
  // Mirror `all`: run the reasoning sequence with intent synthesis FIRST (FINDING
  // A: any LLM candidate_requirements get an evaluation.results entry) and the
  // partial -> satisfied verification interleaved at the correct point so the
  // risks model composed subcommands persist (packet/risks/methodology) reflects
  // the promotion. No-op without --test-output / under mock, so the byte-stable
  // offline path holds.
  const { evaluation, risks } = await runReasoningWithVerification(reasoningProviderFor(context), reasoningOptionsFor(context), {
    cwd: context.cwd,
    collection: context.collection,
    intent,
    methodology,
    commands: context.commands,
    areasOption: context.areasOption
  });
  return { intent, evaluation, methodology, risks };
}

interface VerificationStageInputs {
  cwd: string;
  collection: CollectionResult;
  intent: IntentModel;
  methodology: MethodologyModel;
  commands: string[];
  areasOption: { areas?: ReviewArea[] };
}

interface ReasonedEvaluation {
  evaluation: EvaluationModel;
  risks: RisksModel;
}

// Run the schema-bound reasoning sequence with the VERIFICATION LOOP (#2)
// promotion interleaved so every evaluation-derived surface (risks here, and
// architecture at the call site) sees the POST-promotion evaluation. The full
// reasoning order is preserved exactly as runReasoningStages would run it
// (intent synthesis -> candidate evidence -> narrative); evaluation, verify and
// analyzeRisks are slotted at the deterministically-correct points:
//
//   intent synthesis       (FINDING A: may append LLM candidate_requirements to
//                            intent; runs BEFORE evaluateIntent)
//   -> evaluateIntent      (evaluates the FULL, post-intent-reasoning intent so
//                            EVERY requirement -- including LLM candidate
//                            requirements -- has a matching evaluation.results
//                            entry, preserving the one-result-per-requirement
//                            contract)
//   -> candidate evidence  (attaches LLM-pinpointed test refs to evaluation;
//                            appends to risks.review_focus)
//   -> verify              (partial -> satisfied using those refs + deterministic
//                            mappings; mutates evaluation in place)
//   -> analyzeRisks        (POST-promotion: a promoted requirement is no longer a
//                            partial test gap nor counted in the weak-test risk)
//   -> narrative           (appends LLM risk items to risks.items)
//
// Intent synthesis MUST run before evaluateIntent (FINDING A): the deterministic
// evaluator only produces a result for an intent requirement that exists when it
// runs, so building evaluation before intent reasoning left any LLM-appended
// candidate_requirements with no evaluation.results entry (and no risks/architecture).
// The candidate-evidence stage's risks.review_focus additions are captured as a
// delta and re-applied to the freshly analyzed (post-promotion) risks so that
// side effect is preserved. Under mock every reasoning stage is a no-op, intent
// is unchanged, the delta is empty, and this collapses to evaluate -> verify ->
// analyzeRisks, keeping the deterministic baseline byte-stable. The same helper
// backs `all` and buildEnrichedModels so compose == monolith.
async function runReasoningWithVerification(
  reasoningProvider: ReturnType<typeof providerFor>,
  // FINDING C: ReasoningOptions carries the config-derived reviewAreas through to
  // the candidate-evidence stage; a narrower local type would silently strip it.
  reasoningOptions: ReasoningOptions,
  inputs: VerificationStageInputs
): Promise<ReasonedEvaluation> {
  const { cwd, collection, intent, methodology, commands, areasOption } = inputs;

  // FINDING A: intent synthesis runs FIRST so any LLM candidate_requirements are
  // present in intent BEFORE the deterministic evaluator runs. Pass a placeholder
  // evaluation/risks: the intent stage only reads/mutates intent.
  await runIntentReasoning(
    reasoningProvider,
    { collection, intent, evaluation: emptyEvaluation(), methodology, risks: emptyRisks() },
    reasoningOptions
  );

  // Evaluate the FULL (post-intent-reasoning) intent so every requirement has a
  // matching evaluation.results entry (the one-result-per-requirement contract).
  const evaluation = await evaluateIntent(cwd, collection, intent, areasOption);

  // Seed a risks object for the candidate-evidence stage to append review_focus
  // to. Its gap/partial sections are recomputed post-promotion below, so the
  // pre-promotion seed is only a scratch surface for the review_focus delta.
  const seededRisks = analyzeRisks(collection, evaluation, commands, methodology);
  const baseReviewFocusLength = seededRisks.review_focus.length;
  const reasoningInputs = { collection, intent, evaluation, methodology, risks: seededRisks };

  await runEvaluationReasoning(reasoningProvider, reasoningInputs, reasoningOptions);
  // The candidate-evidence stage only ever APPENDS to review_focus, so the delta
  // is everything past the deterministic base.
  const evalReviewFocusDelta = seededRisks.review_focus.slice(baseReviewFocusLength);

  verifyRequirementsWithTests(collection, intent, evaluation, areasOption);

  // Recompute risks against the POST-promotion evaluation, then re-apply the
  // candidate-evidence review_focus delta so that enrichment is not lost.
  const risks = analyzeRisks(collection, evaluation, commands, methodology);
  risks.review_focus.push(...evalReviewFocusDelta);
  reasoningInputs.risks = risks;
  await runNarrativeReasoning(reasoningProvider, reasoningInputs, reasoningOptions);
  return { evaluation, risks };
}

// emptyEvaluation / emptyMethodology / emptyRisks are placeholders for stages
// that only read a subset of the reasoning inputs. Mock is a no-op, so they are
// never consulted in the default offline path.
function emptyEvaluation(): EvaluationModel {
  return { summary: "", results: [], overreach: [], acai_coverage: {} };
}

function emptyMethodology(): MethodologyModel {
  return {
    summary: "",
    missing_logs: true,
    considered: [],
    research: [],
    decisions: [],
    unchallenged_assumptions: [],
    skipped_checks: [],
    claims_without_evidence: [],
    verified_claims: [],
    quality_flags: [],
    evidence: []
  };
}

function emptyRisks(): RisksModel {
  return { summary: "", items: [], test_evidence: [], test_gaps: [], review_focus: [] };
}

function logWrote(context: StageContext): void {
  console.log(`Wrote review-surfaces artifacts to ${path.relative(context.cwd, context.collection.outputDir) || "."}`);
}

async function runIntentStage(parsed: ParsedArgs): Promise<void> {
  const context = await buildStageContext(parsed);
  const intent = await computeEnrichedIntent(context);
  await writeIntentArtifact(context.collection.outputDir, intent);
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
  const evaluation = await evaluateIntent(context.cwd, context.collection, intent, context.areasOption);
  // Stage 2 (candidate evidence) is the only reasoning stage that touches
  // evaluation.results. Its risks.review_focus side effect lands on a throwaway
  // here; the risks subcommand reproduces it against fresh deterministic models.
  await runEvaluationReasoning(
    reasoningProviderFor(context),
    {
      collection: context.collection,
      intent,
      evaluation,
      methodology: emptyMethodology(),
      risks: emptyRisks()
    },
    reasoningOptionsFor(context)
  );
  // VERIFICATION LOOP (#2): the evaluation stage owns evaluation.yaml, so apply
  // the partial -> satisfied verification here too, matching `all`. No-op without
  // --test-output.
  verifyRequirementsWithTests(context.collection, intent, evaluation, context.areasOption);
  await writeEvaluationArtifact(context.collection.outputDir, evaluation);
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
  const preEnrichment: EnrichmentResult = {
    provider: context.provider,
    model: context.requestedModel,
    status: "not_requested",
    summary: "Enrichment has not run yet."
  };
  const packet = createReviewPacket({
    collection: context.collection,
    intent,
    evaluation,
    methodology,
    risks,
    architecture,
    enrichment: preEnrichment,
    commands: context.commands
  });
  await enrichPacket(packet, {
    cwd: context.cwd,
    provider: context.provider,
    model: context.requestedModel,
    agentInput: stringFlag(parsed, "agent-input"),
    outputDir: context.collection.outputDir,
    redactSecrets: context.config.privacy.redact_secrets,
    remotePrivacyBlocked: context.collection.privacy.remote_provider_blocked
  });
  await writeMethodologyArtifact(context.collection.outputDir, packet.methodology);
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
  const preEnrichment: EnrichmentResult = {
    provider: context.provider,
    model: context.requestedModel,
    status: "not_requested",
    summary: "Enrichment has not run yet."
  };
  const packet = createReviewPacket({
    collection: context.collection,
    intent,
    evaluation,
    methodology,
    risks,
    architecture,
    enrichment: preEnrichment,
    commands: context.commands
  });
  await enrichPacket(packet, {
    cwd: context.cwd,
    provider: context.provider,
    model: context.requestedModel,
    agentInput: stringFlag(parsed, "agent-input"),
    outputDir: context.collection.outputDir,
    redactSecrets: context.config.privacy.redact_secrets,
    remotePrivacyBlocked: context.collection.privacy.remote_provider_blocked
  });
  await writeRisksArtifact(context.collection.outputDir, packet.risks);
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
      logComputed("packet inputs");
      enrichedCache = await buildEnrichedModels(context);
    }
    return enrichedCache;
  };
  const intent = loadCurrentIntent(context) ?? (await enriched()).intent;
  const evaluation = loadCurrentEvaluation(context) ?? (await enriched()).evaluation;
  const methodology = loadCurrentMethodology(context) ?? (await enriched()).methodology;
  const risks = loadCurrentRisks(context) ?? (await enriched()).risks;
  const architecture = await computeArchitecture(context, evaluation);

  const preEnrichment: EnrichmentResult = {
    provider: context.provider,
    model: context.requestedModel,
    status: "not_requested",
    summary: "Enrichment has not run yet."
  };
  const packet = createReviewPacket({
    collection: context.collection,
    intent,
    evaluation,
    methodology,
    risks,
    architecture,
    enrichment: preEnrichment,
    commands: context.commands
  });
  const enrichment = await enrichPacket(packet, {
    cwd: context.cwd,
    provider: context.provider,
    model: context.requestedModel,
    agentInput: stringFlag(parsed, "agent-input"),
    outputDir: context.collection.outputDir,
    redactSecrets: context.config.privacy.redact_secrets,
    remotePrivacyBlocked: context.collection.privacy.remote_provider_blocked
  });
  // run_mode is "dogfood" whenever --dogfood is set (collect stamps the
  // manifest), and the schema REQUIRES both `dogfood` and `agent_handoff` then.
  // Prefer a loaded dogfood.yaml so a prior `dogfood` stage composes; otherwise
  // BUILD the dogfood model from the post-enrichment packet (mirroring `all`) so
  // a standalone `packet --dogfood` always emits a schema-valid packet rather
  // than one missing the required dogfood/agent_handoff sections.
  const dogfood = isDogfoodRun(parsed)
    ? // FINDING E: only compose a prior dogfood.yaml when it is current; a stale one
      // (inputs changed) is rebuilt from the post-enrichment packet.
      loadCurrentDogfood(context) ??
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
  if (enrichment.status === "skipped" || enrichment.status === "failed") {
    console.warn(enrichment.summary);
  }
  logWrote(context);
  return applyGate(parsed, evaluation, context.collection, context.provider, context.config);
}

async function runHandoffStage(parsed: ParsedArgs): Promise<void> {
  const context = await buildStageContext(parsed);
  // Load packet inputs needed for the handoff; compute any that are missing.
  const evaluation = await loadOrComputeEvaluation(context, () => loadOrComputeIntent(context));
  const methodology = await loadOrComputeMethodology(context);
  const risks = await loadOrComputeRisks(
    context,
    async () => evaluation,
    async () => methodology
  );
  // FINDING E: compose a prior dogfood.yaml / intent.yaml only when it is current.
  const dogfood = loadCurrentDogfood(context) ?? undefined;
  const enrichment: EnrichmentResult = {
    provider: context.provider,
    model: context.requestedModel,
    status: "not_requested",
    summary: "Handoff generated from local artifacts."
  };
  await writeHandoffArtifact(context.collection.outputDir, {
    collection: context.collection,
    intent: loadCurrentIntent(context) ?? (await buildIntent(context.cwd, context.collection)),
    evaluation,
    // PER-STAGE ISOLATION: the `handoff` stage writes ONLY agent_handoff.md.
    // buildHandoff never reads architecture, so build the model without the
    // diagrams/*.mmd disk side effect rather than leaking a diagrams/ directory.
    architecture: computeArchitectureModel(context, evaluation),
    methodology,
    risks,
    dogfood,
    enrichment,
    commands: context.commands
  });
  logWrote(context);
}

async function runValidate(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const target = parsed.positionals[0] ?? ".review-surfaces/review_packet.json";
  const targetPath = path.resolve(cwd, target);
  const packetPath = targetPath.endsWith(".json") ? targetPath : path.join(targetPath, "review_packet.json");
  if (!fileExists(packetPath)) {
    throw new CliError(`No review packet JSON found at ${path.relative(cwd, packetPath)}`, ExitCodes.schemaValidationFailed);
  }

  const schemaPath = path.resolve(cwd, stringFlag(parsed, "schema") ?? "schemas/review_packet.schema.json");
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
  if (format === "sarif") {
    return runCommentSarif(parsed);
  }
  if (format !== "github") {
    throw new CliError(`Unknown --format: ${format}. Use github or sarif.`, ExitCodes.usageError);
  }
  return runCommentGithub(parsed);
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
  const outDir = await resolveCommentOutDir(cwd, parsed);
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

// Phase 6b (PROVIDERS.2; M6): write a SARIF 2.1.0 log from the local packet.
// Default output is <dir>/review.sarif under --out; --sarif-out overrides the
// exact file. Like the github path, an absent packet is a clean usage error and
// nothing is written. No network is ever touched.
async function runCommentSarif(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  // Same effective output-dir resolution as the github path: honor a config-set
  // output_dir so SARIF reads the packet `all` wrote, not a hardcoded default.
  const outDir = await resolveCommentOutDir(cwd, parsed);
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
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }

  return { command, flags, positionals };
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  return typeof value === "string" ? value : undefined;
}

function booleanFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.flags[key] === true || parsed.flags[key] === "true";
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
    maxMissing: numberFlag(parsed, "max-missing") ?? config.quality_gate.max_missing
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
  console.log(`review-surfaces 0.1.0

Local-first review packet compiler for agent-generated code changes.

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
  packet        Run the available local pipeline and write review packet
  all           Run the whole available local pipeline
  validate      Validate review_packet.json against schemas/review_packet.schema.json
  run           Execute a local command and write a bounded command transcript
  comment       Render a review surface from the local review_packet.json. With
                --format github (default) writes .review-surfaces/comment.md (a compact
                GitHub sticky comment); with --format sarif writes
                .review-surfaces/review.sarif (a SARIF 2.1.0 log). Reads local artifacts
                only and never recomputes the pipeline.

Options:
  --base <ref>      Base ref for diff collection, default origin/main
  --head <ref>      Head ref for diff collection, default HEAD
  --spec <path>     Feature spec path, default from config
  --out <dir>       Output directory, default .review-surfaces
  --format <fmt>    comment: output format, github (default) or sarif. github writes
                   .review-surfaces/comment.md; sarif writes .review-surfaces/review.sarif
                   (SARIF 2.1.0). Both honor --out and read the local packet only.
  --sarif-out <path>
                   comment --format sarif: write the SARIF log to this exact file instead
                   of <out>/review.sarif
  --dogfood         Mark run as dogfood and include dogfood/handoff sections
  --config <path>   Config path, default review-surfaces.config.yaml
  --schema <path>   Schema path for validate, default schemas/review_packet.schema.json
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
  --model <model>   Optional AI SDK model as <provider>:<model>, e.g. anthropic:claude-3-5-haiku-latest,
                   google:gemini-2.5-flash, or openai:gpt-4o-mini. No prefix defaults to anthropic.
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
    process.exitCode = ExitCodes.runtimeError;
  });
