import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseAgreementBenchmarkGold,
  parseAgreementBenchmarkManifest,
  scoreAgreementBenchmarkRun,
  type AgreementBenchmarkGold,
  type AgreementBenchmarkManifest,
  type AgreementBenchmarkScore
} from "./benchmark";
import type { AgreementAudit, AgreementAuditInput } from "./contract";
import { agreementBenchmarkOutputHash } from "./benchmark-shared";
import { groundAgreementAudit } from "./grounding";
import { parseAgreementAuditCandidate, parseAgreementAuditInput } from "./parse";
import { buildAuditPrompt, type AuditPromptMode } from "./prompt";
import { renderAgreementAuditMarkdown } from "./render";

export interface AgreementBenchmarkGenerationRequest {
  pair_id: string;
  run_number: number;
  prompt: string;
}

export interface AgreementBenchmarkPairOptions {
  root: string;
  model_id: string;
  model_config_hash: string;
  /** Concurrent cases across both arms; runs within one case remain sequential. */
  case_concurrency?: number;
  generate: (request: AgreementBenchmarkGenerationRequest) => Promise<unknown>;
  /** Receives per-call snapshots; mutations cannot affect scoring, later runs, or returned artifacts. */
  adjudicate: (input: {
    case_id: string;
    pair_id: string;
    audit: AgreementAudit;
    gold: AgreementBenchmarkGold;
  }) => Promise<unknown>;
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
  prompts: Record<AuditPromptMode, string>;
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

interface AdjudicationTask {
  generatedCase: GeneratedCase;
  run: GeneratedCase["generated"][number];
}

/**
 * Runs both benchmark arms as one hidden-gold boundary. Input and gold bytes
 * are integrity-preflighted before any provider call; gold is parsed and
 * exposed only after candidate generation for both arms has completed.
 */
export async function runAgreementBenchmarkPair(
  options: AgreementBenchmarkPairOptions
): Promise<AgreementBenchmarkPairResult> {
  const manifest = parseAgreementBenchmarkManifest(readJson(path.join(options.root, "manifest.json")));
  const concurrency = options.case_concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("case_concurrency must be a positive integer");
  }

  const goldBytesByCase = new Map<string, Buffer>();
  // Integrity-preflight all bytes synchronously before live provider calls.
  const preparedCases = manifest.cases.map((entry): PreparedCase => {
    const inputBytes = fs.readFileSync(path.join(options.root, entry.input));
    assertDigest(inputBytes, entry.input_sha256, entry.input);
    const goldBytes = fs.readFileSync(path.join(options.root, entry.gold));
    assertDigest(goldBytes, entry.gold_sha256, entry.gold);
    goldBytesByCase.set(entry.id, goldBytes);
    const input = parseAgreementAuditInput(JSON.parse(inputBytes.toString("utf8")) as unknown);
    return {
      entry,
      input,
      prompts: {
        "plain-agent": buildAuditPrompt(input, "plain-agent"),
        "review-surfaces": buildAuditPrompt(input, "review-surfaces")
      }
    };
  });

  const generationTasks = (["plain-agent", "review-surfaces"] as const).flatMap((mode) =>
    preparedCases.map((prepared) => ({ mode, prepared }))
  );
  const generatedCases = await mapWithConcurrency(generationTasks, concurrency, async ({ mode, prepared }, control) => {
    const prompt = prepared.prompts[mode];
    const generated: GeneratedCase["generated"] = [];
    for (const runNumber of [1, 2, 3]) {
      if (control.aborted) throw new Error("benchmark generation aborted after another case failed");
      const pairId = `pair-${runNumber}`;
      const started = Date.now();
      const candidateValue = await options.generate({ pair_id: pairId, run_number: runNumber, prompt });
      const candidate = parseAgreementAuditCandidate(candidateValue);
      const audit = groundAgreementAudit(prepared.input, candidate);
      const markdown = renderAgreementAuditMarkdown(audit);
      generated.push({
        runNumber,
        pairId,
        audit,
        markdown,
        outputHash: agreementBenchmarkOutputHash(audit, markdown),
        generationMs: Date.now() - started
      });
    }
    return { ...prepared, mode, generated };
  });

  // Parse and validate every hidden ledger only after both arms finish generation.
  const goldByCase = new Map(preparedCases.map((prepared) => {
    const { entry, input } = prepared;
    const goldBytes = goldBytesByCase.get(entry.id)!;
    const gold = parseAgreementBenchmarkGold(JSON.parse(goldBytes.toString("utf8")) as unknown, input);
    if (gold.case_id !== entry.id) throw new Error(`benchmark gold case ${gold.case_id} does not match manifest ${entry.id}`);
    return [entry.id, gold] as const;
  }));

  const adjudicationGroups = blindedAdjudicationOrder(generatedCases, manifest.cases.map((entry) => entry.id));
  const completedScoreGroups = await mapWithConcurrency(adjudicationGroups, concurrency, async (tasks, control) => {
    const scores = [];
    for (const { generatedCase, run } of tasks) {
      const { entry, mode } = generatedCase;
      const gold = goldByCase.get(entry.id)!;
      if (control.aborted) throw new Error("benchmark adjudication aborted after another case failed");
      const adjudication = await options.adjudicate({
        case_id: entry.id,
        pair_id: run.pairId,
        audit: structuredClone(run.audit),
        gold: structuredClone(gold)
      });
      const score = scoreAgreementBenchmarkRun(run.audit, gold, adjudication, {
        run_id: `${mode}:${entry.id}:${run.runNumber}`,
        pair_id: run.pairId,
        model_id: options.model_id,
        model_config_hash: options.model_config_hash,
        input_hash: entry.input_sha256,
        gold_sha256: entry.gold_sha256,
        output_hash: run.outputHash,
        generation_ms: run.generationMs
      });
      scores.push({ mode, caseId: entry.id, runNumber: run.runNumber, score });
    }
    return scores;
  });

  const caseIds = manifest.cases.map((entry) => entry.id);
  const completedScores = completedScoreGroups.flat();
  const scoreByRun = new Map(completedScores.map((result) => [
    `${result.mode}\0${result.caseId}\0${result.runNumber}`,
    result.score
  ]));
  const arm = (mode: AuditPromptMode): AgreementBenchmarkArmResult => {
    const cases = generatedCases.filter((generatedCase) => generatedCase.mode === mode);
    return {
      case_ids: caseIds,
      scores: cases.flatMap(({ entry, generated }) => generated.map(({ runNumber }) =>
        scoreByRun.get(`${mode}\0${entry.id}\0${runNumber}`)!
      )),
      artifacts: cases.flatMap(({ entry, generated }) => generated.map((run) => ({
        case_id: entry.id,
        pair_id: run.pairId,
        output_hash: run.outputHash,
        markdown: run.markdown,
        audit: run.audit
      })))
    };
  };
  return { baseline: arm("plain-agent"), product: arm("review-surfaces") };
}

function blindedAdjudicationOrder(generatedCases: GeneratedCase[], caseIds: string[]): AdjudicationTask[][] {
  const byCase = new Map<string, GeneratedCase[]>();
  for (const generatedCase of generatedCases) {
    const cases = byCase.get(generatedCase.entry.id) ?? [];
    cases.push(generatedCase);
    byCase.set(generatedCase.entry.id, cases);
  }
  return caseIds.map((caseId) => {
    const cases = byCase.get(caseId);
    if (cases?.length !== 2) throw new Error(`benchmark case ${caseId} is missing an arm`);
    const [first, second] = shuffled(cases.map((generatedCase) => ({
      generatedCase,
      runs: shuffled(generatedCase.generated)
    })));
    return first.runs.flatMap((run, index) => [
      { generatedCase: first.generatedCase, run },
      { generatedCase: second.generatedCase, run: second.runs[index] }
    ]);
  });
}

function shuffled<Value>(values: readonly Value[]): Value[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = crypto.randomInt(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
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
  let firstError: unknown;
  let failed = false;
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (!control.aborted && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await run(values[index], control);
      } catch (error) {
        control.aborted = true;
        if (!failed) firstError = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  if (failed) throw firstError;
  return results;
}
