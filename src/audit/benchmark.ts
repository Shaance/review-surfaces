import type {
  AgreementAuditInput,
  AgreementKind,
  AgreementMateriality,
  AgreementState
} from "./contract";
import type { AgreementBenchmarkScore } from "./benchmark-score";
import { AGREEMENT_BENCHMARK_VERSION, sameSet } from "./benchmark-shared";
import { repositoryPath } from "./path";
export { AGREEMENT_BENCHMARK_VERSION } from "./benchmark-shared";
export {
  scoreAgreementBenchmarkRun,
  type AgreementAdjudication,
  type AgreementBenchmarkScore
} from "./benchmark-score";
import {
  AGREEMENT_KINDS,
  AGREEMENT_MATERIALITIES,
  AGREEMENT_STATES,
  DIFF_SIDES,
  agreementEvidenceFailures,
  auditDiffCoordinate,
  agreementKindAllowsActor
} from "./contract";

const PREFERENCE_OUTCOMES = ["product", "baseline", "tie"] as const;
type PreferenceOutcome = (typeof PREFERENCE_OUTCOMES)[number];

export interface AgreementBenchmarkManifest {
  version: typeof AGREEMENT_BENCHMARK_VERSION;
  cases: Array<{
    id: string;
    input: string;
    input_sha256: string;
    gold: string;
    gold_sha256: string;
  }>;
}

export interface GoldAgreement {
  id: string;
  kind: AgreementKind;
  materiality: AgreementMateriality;
  expected_state: AgreementState;
  governing_event_ids: string[];
  expected_diff_coordinates: Array<{
    path: string;
    side: AgreementAuditInput["diff"][number]["side"];
    line: number;
  }>;
  expected_command_ids: string[];
}

export interface AgreementBenchmarkGold {
  version: typeof AGREEMENT_BENCHMARK_VERSION;
  case_id: string;
  source: "sanitized_real" | "synthetic";
  clean: boolean;
  agreements: GoldAgreement[];
}

export interface AgreementBenchmarkComparison {
  baseline_macro_f1: number;
  product_macro_f1: number;
  macro_f1_delta: number;
  blinded_product_preferences: number;
  blinded_baseline_preferences: number;
  blinded_ties: number;
  passes: boolean;
  failures: string[];
}

export function compareAgreementBenchmarkRuns(input: {
  required_case_ids: string[];
  baseline: AgreementBenchmarkScore[];
  product: AgreementBenchmarkScore[];
  preferences: Array<{
    case_id: string;
    pair_id: string;
    baseline_output_hash: string;
    product_output_hash: string;
    decision_time_ms: number;
    preferred: PreferenceOutcome;
  }>;
}): AgreementBenchmarkComparison {
  const failures: string[] = [];
  const baseline = validBenchmarkScores(input.baseline, "baseline", failures);
  const product = validBenchmarkScores(input.product, "product", failures);
  const baselineMacro = macroByCase(baseline);
  const productMacro = macroByCase(product);
  const delta = productMacro - baselineMacro;
  const requiredCaseIds = new Set(input.required_case_ids);
  const baselineCaseIds = new Set(baseline.map((score) => score.case_id));
  const productCaseIds = new Set(product.map((score) => score.case_id));
  if (!sameSet(requiredCaseIds, baselineCaseIds) || !sameSet(requiredCaseIds, productCaseIds)) {
    failures.push("benchmark arms must contain exactly the manifest case set");
  }
  if (new Set(baseline.map((score) => score.run_id)).size !== baseline.length ||
    new Set(product.map((score) => score.run_id)).size !== product.length) {
    failures.push("run ids must be unique within each benchmark arm");
  }
  const allScores = [...baseline, ...product];
  if (new Set(allScores.map((score) => score.model_id)).size > 1 ||
    new Set(allScores.map((score) => score.model_config_hash)).size > 1) {
    failures.push("benchmark comparison must use one model and config across all runs");
  }
  const expectedPreferenceKeys = new Set<string>();
  const expectedPreferenceHashes = new Map<string, { baseline: string; product: string }>();
  for (const caseId of requiredCaseIds) {
    const baselineRuns = baseline.filter((score) => score.case_id === caseId);
    const productRuns = product.filter((score) => score.case_id === caseId);
    if (baselineRuns.length !== 3 || productRuns.length !== 3) {
      failures.push(`${caseId} needs exactly three runs in both benchmark arms`);
    }
    const baselineByPair = new Map(baselineRuns.map((run) => [run.pair_id, run]));
    const productByPair = new Map(productRuns.map((run) => [run.pair_id, run]));
    if (baselineByPair.size !== 3 || productByPair.size !== 3) {
      failures.push(`${caseId} needs three unique pair ids in both benchmark arms`);
    }
    if (!sameSet(new Set(baselineByPair.keys()), new Set(productByPair.keys()))) {
      failures.push(`${caseId} has unpaired benchmark runs`);
    }
    if (new Set([...baselineRuns, ...productRuns].map((run) => run.input_hash)).size > 1) {
      failures.push(`${caseId} must use one frozen input across all runs`);
    }
    if (new Set([...baselineRuns, ...productRuns].map((run) => run.gold_sha256)).size > 1) {
      failures.push(`${caseId} must use one frozen gold ledger across all runs`);
    }
    for (const [pairId, baseline] of baselineByPair) {
      const product = productByPair.get(pairId);
      expectedPreferenceKeys.add(`${caseId}\0${pairId}`);
      if (!product) continue;
      expectedPreferenceHashes.set(`${caseId}\0${pairId}`, {
        baseline: baseline.output_hash,
        product: product.output_hash
      });
      if (baseline.model_id !== product.model_id ||
        baseline.model_config_hash !== product.model_config_hash ||
        baseline.input_hash !== product.input_hash) {
        failures.push(`${caseId}/${pairId} does not use matched model, config, and input`);
      }
    }
    if (caseId === "large-agreement-set" &&
      mean(productRuns.map((score) => score.material_f1)) < mean(baselineRuns.map((score) => score.material_f1))) {
      failures.push("product loses the large-agreement case");
    }
  }
  const preferenceKeys = input.preferences.map((preference) => `${preference.case_id}\0${preference.pair_id}`);
  if (new Set(preferenceKeys).size !== preferenceKeys.length ||
    !sameSet(expectedPreferenceKeys, new Set(preferenceKeys))) {
    failures.push("every paired run needs exactly one blinded preference judgment");
  }
  for (const preference of input.preferences) {
    const expected = expectedPreferenceHashes.get(`${preference.case_id}\0${preference.pair_id}`);
    if (!expected || preference.baseline_output_hash !== expected.baseline ||
      preference.product_output_hash !== expected.product) {
      failures.push(`${preference.case_id}/${preference.pair_id} preference is not bound to the scored outputs`);
    }
    if (!Number.isFinite(preference.decision_time_ms) || preference.decision_time_ms <= 0) {
      failures.push(`${preference.case_id}/${preference.pair_id} preference needs a positive decision time`);
    }
    if (!PREFERENCE_OUTCOMES.includes(preference.preferred)) {
      failures.push(`${preference.case_id}/${preference.pair_id} preference outcome is invalid`);
    }
  }
  const productPreferences = input.preferences.filter((preference) => preference.preferred === "product").length;
  const baselinePreferences = input.preferences.filter((preference) => preference.preferred === "baseline").length;
  const ties = input.preferences.filter((preference) => preference.preferred === "tie").length;
  if (baseline.some((score) => score.failures.length > 0)) failures.push("one or more baseline runs failed a case gate");
  if (product.some((score) => score.failures.length > 0)) failures.push("one or more product runs failed a case gate");
  if (product.some((score) => !score.exact_citation_gate)) failures.push("product failed the exact-citation gate");
  if (product.some((score) => !score.clean_case_gate)) failures.push("product produced a false mismatch on a clean case");
  if (delta < 0.15) failures.push(`product macro-F1 uplift ${delta.toFixed(3)} is below 0.150`);
  if (productPreferences < Math.max(2, baselinePreferences * 2)) {
    failures.push("blinded reviewer preference is below 2:1");
  }
  if (expectedPreferenceKeys.size > 0 && productPreferences / expectedPreferenceKeys.size < 2 / 3) {
    failures.push("fewer than two thirds of paired judgments prefer the product");
  }
  return {
    baseline_macro_f1: baselineMacro,
    product_macro_f1: productMacro,
    macro_f1_delta: delta,
    blinded_product_preferences: productPreferences,
    blinded_baseline_preferences: baselinePreferences,
    blinded_ties: ties,
    passes: failures.length === 0,
    failures
  };
}

export function parseAgreementBenchmarkManifest(value: unknown): AgreementBenchmarkManifest {
  const manifest = asRecord(value, "benchmark manifest");
  if (manifest.version !== AGREEMENT_BENCHMARK_VERSION) {
    throw new Error(`benchmark manifest version must be ${AGREEMENT_BENCHMARK_VERSION}`);
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) throw new Error("benchmark manifest cases must be a non-empty array");
  const cases = manifest.cases.map((value, index) => {
    const entry = asRecord(value, `benchmark manifest case ${index}`);
    return {
      id: requiredString(entry.id, `benchmark manifest case ${index}.id`),
      input: relativeManifestPath(entry.input, `benchmark manifest case ${index}.input`),
      input_sha256: sha256(entry.input_sha256, `benchmark manifest case ${index}.input_sha256`),
      gold: relativeManifestPath(entry.gold, `benchmark manifest case ${index}.gold`),
      gold_sha256: sha256(entry.gold_sha256, `benchmark manifest case ${index}.gold_sha256`)
    };
  });
  assertUnique(cases.map((entry) => entry.id), "benchmark case id");
  return { version: AGREEMENT_BENCHMARK_VERSION, cases };
}

function sha256(value: unknown, label: string): string {
  const hash = requiredString(value, label);
  if (!isSha256(hash)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return hash;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function relativeManifestPath(value: unknown, label: string): string {
  const file = requiredString(value, label);
  if (file.startsWith("/") || file.includes("\\") || /^[A-Za-z]:/u.test(file) ||
    /[\0\r\n]/u.test(file) || file.split("/").includes("..")) {
    throw new Error(`${label} must stay within the benchmark root`);
  }
  return file;
}

export function parseAgreementBenchmarkGold(value: unknown, input: AgreementAuditInput): AgreementBenchmarkGold {
  const gold = asRecord(value, "benchmark gold");
  if (gold.version !== AGREEMENT_BENCHMARK_VERSION) {
    throw new Error(`benchmark gold version must be ${AGREEMENT_BENCHMARK_VERSION}`);
  }
  const caseId = requiredString(gold.case_id, "benchmark gold.case_id");
  if (gold.source !== "sanitized_real" && gold.source !== "synthetic") throw new Error("benchmark gold.source is invalid");
  if (typeof gold.clean !== "boolean") throw new Error("benchmark gold.clean must be boolean");
  if (!Array.isArray(gold.agreements) || gold.agreements.length === 0) throw new Error("benchmark gold.agreements must be a non-empty array");
  const events = new Map(input.conversation.events.map((event) => [event.id, event]));
  const diffByCoordinate = new Map(input.diff.map((line) => [auditDiffCoordinate(line), line]));
  const commands = new Map(input.commands.map((command) => [command.id, command]));
  const agreements = gold.agreements.map((value, index) => {
    const agreement = asRecord(value, `benchmark gold agreement ${index}`);
    const kind = enumString(agreement.kind, AGREEMENT_KINDS, `benchmark gold agreement ${index}.kind`);
    const materiality = enumString(agreement.materiality, AGREEMENT_MATERIALITIES, `benchmark gold agreement ${index}.materiality`);
    const expectedState = enumString(agreement.expected_state, AGREEMENT_STATES, `benchmark gold agreement ${index}.expected_state`);
    const governingEventIds = stringList(agreement.governing_event_ids, `benchmark gold agreement ${index}.governing_event_ids`);
    if (governingEventIds.length === 0) throw new Error(`benchmark gold agreement ${index} needs a governing event`);
    for (const eventId of governingEventIds) {
      const event = events.get(eventId);
      if (!event) throw new Error(`benchmark gold agreement ${index} cites unknown event ${eventId}`);
      if (!agreementKindAllowsActor(kind, event.actor)) {
        throw new Error(`benchmark gold agreement ${index} cites a governing event owned by ${event.actor}`);
      }
    }
    const expectedDiffCoordinates = diffCoordinateList(
      agreement.expected_diff_coordinates,
      `benchmark gold agreement ${index}.expected_diff_coordinates`
    );
    for (const coordinate of expectedDiffCoordinates) {
      const diffLine = diffByCoordinate.get(auditDiffCoordinate(coordinate));
      if (!diffLine) {
        throw new Error(`benchmark gold agreement ${index} cites an unknown diff coordinate`);
      }
      if (diffLine.text.length === 0) {
        throw new Error(`benchmark gold agreement ${index} cites an empty diff line that candidates cannot anchor`);
      }
    }
    const expectedCommandIds = stringList(
      agreement.expected_command_ids,
      `benchmark gold agreement ${index}.expected_command_ids`
    );
    const citedCommands: AgreementAuditInput["commands"] = [];
    for (const commandId of expectedCommandIds) {
      const command = commands.get(commandId);
      if (!command) {
        throw new Error(`benchmark gold agreement ${index} cites unknown command ${commandId}`);
      }
      if (command.head_sha !== input.head_sha) {
        throw new Error(`benchmark gold agreement ${index} cites command ${commandId} not bound to the benchmark head`);
      }
      citedCommands.push(command);
    }
    const evidenceFailures = agreementEvidenceFailures({
      kind,
      state: expectedState,
      diff_sides: expectedDiffCoordinates.map((coordinate) => coordinate.side),
      commands: citedCommands.map((command) => ({ status: command.status, exact_head: true }))
    });
    if (evidenceFailures.length > 0) {
      throw new Error(`benchmark gold agreement ${index} cannot be grounded: ${evidenceFailures.join("; ")}`);
    }
    return {
      id: requiredString(agreement.id, `benchmark gold agreement ${index}.id`),
      kind,
      materiality,
      expected_state: expectedState,
      governing_event_ids: governingEventIds,
      expected_diff_coordinates: expectedDiffCoordinates,
      expected_command_ids: expectedCommandIds
    };
  });
  assertUnique(agreements.map((agreement) => agreement.id), "benchmark gold agreement id");
  if (gold.clean && agreements.some((agreement) => agreement.expected_state !== "fulfilled")) {
    throw new Error("a clean benchmark case cannot contain non-fulfilled agreements");
  }
  return { version: AGREEMENT_BENCHMARK_VERSION, case_id: caseId, source: gold.source, clean: gold.clean, agreements };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function macroByCase(scores: AgreementBenchmarkScore[]): number {
  const grouped = new Map<string, number[]>();
  for (const score of scores) {
    const values = grouped.get(score.case_id) ?? [];
    values.push(score.material_f1);
    grouped.set(score.case_id, values);
  }
  return mean([...grouped.values()].map(mean));
}

function validBenchmarkScores(
  scores: AgreementBenchmarkScore[],
  arm: "baseline" | "product",
  failures: string[]
): AgreementBenchmarkScore[] {
  const textFields = ["case_id", "run_id", "pair_id", "model_id", "model_config_hash", "input_hash", "output_hash"] as const;
  const metricFields = ["precision", "recall", "f1", "material_precision", "material_recall", "material_f1"] as const;
  return scores.filter((score, index) => {
    if (!score || typeof score !== "object" || Array.isArray(score)) {
      failures.push(`${arm} benchmark score ${index + 1} has invalid recorded fields`);
      return false;
    }
    const record = score as unknown as Record<string, unknown>;
    const validText = textFields.every((field) =>
      typeof record[field] === "string" && (record[field] as string).trim().length > 0
    );
    const validMetrics = metricFields.every((field) =>
      typeof record[field] === "number" && Number.isFinite(record[field]) && (record[field] as number) >= 0 && (record[field] as number) <= 1
    );
    const valid = validText && isSha256(record.gold_sha256) && validMetrics &&
      typeof record.generation_ms === "number" && Number.isFinite(record.generation_ms) && record.generation_ms >= 0 &&
      typeof record.exact_citation_gate === "boolean" && typeof record.clean_case_gate === "boolean" &&
      Array.isArray(record.failures) && record.failures.every((failure) => typeof failure === "string");
    if (!valid) failures.push(`${arm} benchmark score ${index + 1} has invalid recorded fields`);
    return valid;
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const values = value.map((item, index) => requiredString(item, `${label}[${index}]`));
  assertUnique(values, label);
  return values;
}

function diffCoordinateList(value: unknown, label: string): GoldAgreement["expected_diff_coordinates"] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const coordinates = value.map((item, index) => {
    const coordinate = asRecord(item, `${label}[${index}]`);
    const line = coordinate.line;
    if (!Number.isSafeInteger(line) || (line as number) <= 0) {
      throw new Error(`${label}[${index}].line must be a positive integer`);
    }
    return {
      path: repositoryPath(coordinate.path, `${label}[${index}].path`),
      side: enumString(coordinate.side, DIFF_SIDES, `${label}[${index}].side`),
      line: line as number
    };
  });
  assertUnique(coordinates.map(auditDiffCoordinate), label);
  return coordinates;
}

function enumString<const Values extends readonly string[]>(value: unknown, values: Values, label: string): Values[number] {
  const parsed = requiredString(value, label);
  if (!values.includes(parsed)) throw new Error(`${label} must be one of ${values.join(", ")}`);
  return parsed as Values[number];
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} values must be unique`);
}
