import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseAgreementBenchmarkGold,
  parseAgreementBenchmarkManifest,
  scoreAgreementBenchmarkRun,
  type AgreementAdjudication,
  type AgreementBenchmarkGold,
  type AgreementBenchmarkManifest,
  type AgreementBenchmarkScore
} from "./benchmark";
import type { AgreementAudit, AgreementAuditInput } from "./contract";
import { groundAgreementAudit } from "./grounding";
import { parseAgreementAuditCandidate, parseAgreementAuditInput } from "./parse";
import { buildAuditPrompt, type AuditPromptMode } from "./prompt";
import { renderAgreementAuditMarkdown } from "./render";

export interface AgreementBenchmarkGenerationRequest {
  pair_id: string;
  run_number: number;
  mode: AuditPromptMode;
  prompt: string;
}

export interface AgreementBenchmarkPairOptions {
  root: string;
  model_id: string;
  model_config_hash: string;
  /** Concurrent cases across both arms; runs within one case remain sequential. */
  case_concurrency?: number;
  generate: (request: AgreementBenchmarkGenerationRequest) => Promise<unknown>;
  adjudicate: (input: {
    case_id: string;
    pair_id: string;
    audit: AgreementAudit;
    gold: AgreementBenchmarkGold;
  }) => Promise<AgreementAdjudication>;
}

export interface AgreementBenchmarkArmResult {
  case_ids: string[];
  scores: AgreementBenchmarkScore[];
  artifacts: Array<{ case_id: string; pair_id: string; output_hash: string; markdown: string; audit: AgreementAudit }>;
}

export interface AgreementBenchmarkPairResult {
  baseline: AgreementBenchmarkArmResult;
  product: AgreementBenchmarkArmResult;
}

interface PreparedCase {
  entry: AgreementBenchmarkManifest["cases"][number];
  input: AgreementAuditInput;
}

interface GeneratedCase extends PreparedCase {
  mode: AuditPromptMode;
  generated: Array<{
    runNumber: number;
    pairId: string;
    audit: AgreementAudit;
    markdown: string;
    outputHash: string;
    generationMs: number;
  }>;
}

/**
 * Runs both benchmark arms as one hidden-gold boundary. Every input fixture is
 * frozen before any provider call, and no gold is loaded until all candidate
 * generation for both arms has completed.
 */
export async function runAgreementBenchmarkPair(
  options: AgreementBenchmarkPairOptions
): Promise<AgreementBenchmarkPairResult> {
  const manifest = parseAgreementBenchmarkManifest(readJson(path.join(options.root, "manifest.json")));
  const concurrency = options.case_concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("case_concurrency must be a positive integer");
  }

  // Synchronous preflight ensures a later invalid fixture cannot race a live call.
  const preparedCases = manifest.cases.map((entry): PreparedCase => {
    const inputBytes = fs.readFileSync(path.join(options.root, entry.input));
    assertDigest(inputBytes, entry.input_sha256, entry.input);
    return {
      entry,
      input: parseAgreementAuditInput(JSON.parse(inputBytes.toString("utf8")) as unknown)
    };
  });

  const generationTasks = (["plain-agent", "review-surfaces"] as const).flatMap((mode) =>
    preparedCases.map((prepared) => ({ mode, prepared }))
  );
  const generatedCases = await mapWithConcurrency(generationTasks, concurrency, async ({ mode, prepared }, control) => {
    const prompt = buildAuditPrompt(prepared.input, mode);
    const generated: GeneratedCase["generated"] = [];
    for (const runNumber of [1, 2, 3]) {
      if (control.aborted) throw new Error("benchmark generation aborted after another case failed");
      const pairId = `pair-${runNumber}`;
      const started = Date.now();
      const candidateValue = await options.generate({ pair_id: pairId, run_number: runNumber, mode, prompt });
      const candidate = parseAgreementAuditCandidate(candidateValue);
      const audit = groundAgreementAudit(prepared.input, candidate);
      const markdown = renderAgreementAuditMarkdown(audit);
      generated.push({
        runNumber,
        pairId,
        audit,
        markdown,
        outputHash: digest(markdown),
        generationMs: Date.now() - started
      });
    }
    return { ...prepared, mode, generated };
  });

  // Load and validate every hidden ledger only after both arms finish generation.
  const goldByCase = new Map(preparedCases.map((prepared) => {
    const { entry, input } = prepared;
    const goldBytes = fs.readFileSync(path.join(options.root, entry.gold));
    assertDigest(goldBytes, entry.gold_sha256, entry.gold);
    const gold = parseAgreementBenchmarkGold(JSON.parse(goldBytes.toString("utf8")) as unknown, input);
    if (gold.case_id !== entry.id) throw new Error(`benchmark gold case ${gold.case_id} does not match manifest ${entry.id}`);
    return [entry.id, gold] as const;
  }));

  const completed = await mapWithConcurrency(generatedCases, concurrency, async (generatedCase, control) => {
    const { entry, generated, mode } = generatedCase;
    const gold = goldByCase.get(entry.id)!;
    const scores: AgreementBenchmarkScore[] = [];
    for (const run of generated) {
      if (control.aborted) throw new Error("benchmark adjudication aborted after another case failed");
      const adjudication = await options.adjudicate({ case_id: entry.id, pair_id: run.pairId, audit: run.audit, gold });
      scores.push(scoreAgreementBenchmarkRun(run.audit, gold, adjudication, {
        run_id: `${mode}:${entry.id}:${run.runNumber}`,
        pair_id: run.pairId,
        model_id: options.model_id,
        model_config_hash: options.model_config_hash,
        input_hash: entry.input_sha256,
        output_hash: run.outputHash,
        generation_ms: run.generationMs
      }));
    }
    const artifacts = generated.map((run) => ({
      case_id: entry.id,
      pair_id: run.pairId,
      output_hash: run.outputHash,
      markdown: run.markdown,
      audit: run.audit
    }));
    return { mode, scores, artifacts };
  });

  const arm = (mode: AuditPromptMode): AgreementBenchmarkArmResult => ({
    case_ids: manifest.cases.map((entry) => entry.id),
    scores: completed.filter((result) => result.mode === mode).flatMap((result) => result.scores),
    artifacts: completed.filter((result) => result.mode === mode).flatMap((result) => result.artifacts)
  });
  return { baseline: arm("plain-agent"), product: arm("review-surfaces") };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function digest(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertDigest(bytes: Buffer, expected: string, file: string): void {
  if (digest(bytes) !== expected) {
    throw new Error(`benchmark file ${file} does not match its frozen SHA-256 digest`);
  }
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  run: (value: Input, control: Readonly<{ aborted: boolean }>) => Promise<Output>
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  const control = { aborted: false };
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (!control.aborted && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await run(values[index], control);
      } catch (error) {
        control.aborted = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
