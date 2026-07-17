import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseAgreementBenchmarkGold,
  parseAgreementBenchmarkManifest,
  scoreAgreementBenchmarkRun,
  type AgreementAdjudication,
  type AgreementBenchmarkGold,
  type AgreementBenchmarkScore
} from "./benchmark";
import type { AgreementAudit } from "./contract";
import { groundAgreementAudit } from "./grounding";
import { parseAgreementAuditCandidate, parseAgreementAuditInput } from "./parse";
import { buildAuditPrompt, type AuditPromptMode } from "./prompt";
import { renderAgreementAuditMarkdown } from "./render";

export interface AgreementBenchmarkGenerationRequest {
  case_id: string;
  pair_id: string;
  run_number: number;
  mode: AuditPromptMode;
  prompt: string;
}

export interface AgreementBenchmarkArmOptions {
  root: string;
  mode: AuditPromptMode;
  model_id: string;
  model_config_hash: string;
  /** Concurrent cases; generations and adjudications within a case remain sequential. */
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

/**
 * Runs one benchmark arm. Candidate generation receives the prompt only; the
 * hidden gold file is loaded afterwards and is visible only to adjudication.
 */
export async function runAgreementBenchmarkArm(
  options: AgreementBenchmarkArmOptions
): Promise<AgreementBenchmarkArmResult> {
  const manifestPath = path.join(options.root, "manifest.json");
  const manifest = parseAgreementBenchmarkManifest(readJson(manifestPath));
  const concurrency = options.case_concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("case_concurrency must be a positive integer");
  }
  const results = await mapWithConcurrency(manifest.cases, concurrency, async (entry) => {
    const inputPath = path.join(options.root, entry.input);
    const inputBytes = fs.readFileSync(inputPath);
    assertDigest(inputBytes, entry.input_sha256, entry.input);
    const input = parseAgreementAuditInput(JSON.parse(inputBytes.toString("utf8")) as unknown);
    const inputHash = digest(inputBytes);
    const prompt = buildAuditPrompt(input, options.mode);
    const generated = [];
    for (const runNumber of [1, 2, 3]) {
      const pairId = `pair-${runNumber}`;
      const started = Date.now();
      const candidateValue = await options.generate({
        case_id: entry.id,
        pair_id: pairId,
        run_number: runNumber,
        mode: options.mode,
        prompt
      });
      const candidate = parseAgreementAuditCandidate(candidateValue);
      const audit = groundAgreementAudit(input, candidate);
      const markdown = renderAgreementAuditMarkdown(audit);
      const outputHash = digest(markdown);
      generated.push({ runNumber, pairId, audit, markdown, outputHash, generationMs: Date.now() - started });
    }

    // Gold is intentionally loaded only after every candidate for the case was generated.
    const goldBytes = fs.readFileSync(path.join(options.root, entry.gold));
    assertDigest(goldBytes, entry.gold_sha256, entry.gold);
    const gold = parseAgreementBenchmarkGold(JSON.parse(goldBytes.toString("utf8")) as unknown, input);
    if (gold.case_id !== entry.id) throw new Error(`benchmark gold case ${gold.case_id} does not match manifest ${entry.id}`);
    const adjudications: AgreementAdjudication[] = [];
    for (const run of generated) {
      adjudications.push(await options.adjudicate({ case_id: entry.id, pair_id: run.pairId, audit: run.audit, gold }));
    }
    const scores: AgreementBenchmarkScore[] = [];
    const artifacts: AgreementBenchmarkArmResult["artifacts"] = [];
    for (const [index, run] of generated.entries()) {
      const adjudication = adjudications[index];
      scores.push(scoreAgreementBenchmarkRun(run.audit, gold, adjudication, {
        run_id: `${options.mode}:${entry.id}:${run.runNumber}`,
        pair_id: run.pairId,
        model_id: options.model_id,
        model_config_hash: options.model_config_hash,
        input_hash: inputHash,
        output_hash: run.outputHash,
        generation_ms: run.generationMs
      }));
      artifacts.push({ case_id: entry.id, pair_id: run.pairId, output_hash: run.outputHash, markdown: run.markdown, audit: run.audit });
    }
    return { scores, artifacts };
  });
  return {
    case_ids: manifest.cases.map((entry) => entry.id),
    scores: results.flatMap((result) => result.scores),
    artifacts: results.flatMap((result) => result.artifacts)
  };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function digest(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertDigest(bytes: Buffer, expected: string, file: string): void {
  const actual = digest(bytes);
  if (actual !== expected) {
    throw new Error(`benchmark file ${file} does not match its frozen SHA-256 digest`);
  }
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  run: (value: Input) => Promise<Output>
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await run(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
