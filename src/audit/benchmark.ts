import type {
  AgreementAudit,
  AgreementAuditInput,
  AgreementKind,
  AgreementMateriality,
  AgreementState
} from "./contract";
import {
  AGREEMENT_KINDS,
  AGREEMENT_MATERIALITIES,
  AGREEMENT_STATES,
  agreementKindAllowsActor
} from "./contract";

export interface AgreementBenchmarkManifest {
  version: 1;
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
}

export interface AgreementBenchmarkGold {
  case_id: string;
  source: "sanitized_real" | "synthetic";
  clean: boolean;
  agreements: GoldAgreement[];
}

/**
 * Semantic matching stays outside the product under test. A blinded adjudicator
 * maps candidate-owned keys to hidden gold ids after generation.
 */
export interface AgreementAdjudication {
  matches: Array<{ candidate_key: string; gold_id: string }>;
  false_positive_candidate_keys: string[];
}

export interface AgreementBenchmarkScore {
  case_id: string;
  run_id: string;
  pair_id: string;
  model_id: string;
  model_config_hash: string;
  input_hash: string;
  output_hash: string;
  generation_ms: number;
  precision: number;
  recall: number;
  f1: number;
  material_precision: number;
  material_recall: number;
  material_f1: number;
  exact_citation_gate: boolean;
  clean_case_gate: boolean;
  failures: string[];
}

export function scoreAgreementBenchmarkRun(
  audit: AgreementAudit,
  gold: AgreementBenchmarkGold,
  adjudication: AgreementAdjudication,
  run: {
    run_id: string;
    pair_id: string;
    model_id: string;
    model_config_hash: string;
    input_hash: string;
    output_hash: string;
    generation_ms: number;
  }
): AgreementBenchmarkScore {
  const candidateByKey = new Map(audit.agreements.map((agreement) => [agreement.key, agreement]));
  const goldById = new Map(gold.agreements.map((agreement) => [agreement.id, agreement]));
  const distinctMatches = uniquePairs(adjudication.matches).filter((match) =>
    candidateByKey.has(match.candidate_key) && goldById.has(match.gold_id)
  );
  const correctMatches = distinctMatches.filter((match) => {
    const candidate = candidateByKey.get(match.candidate_key)!;
    const expected = goldById.get(match.gold_id)!;
    return candidate.kind === expected.kind &&
      candidate.state === expected.expected_state &&
      candidate.materiality === expected.materiality &&
      sameSet(new Set(candidate.conversation_event_ids), new Set(expected.governing_event_ids));
  });
  const matchedCandidates = new Set(correctMatches.map((match) => match.candidate_key));
  const matchedGold = new Set(correctMatches.map((match) => match.gold_id));
  const falsePositiveKeys = new Set([
    ...adjudication.false_positive_candidate_keys,
    ...audit.agreements.filter((agreement) => !matchedCandidates.has(agreement.key)).map((agreement) => agreement.key)
  ]);

  const precision = ratio(correctMatches.length, correctMatches.length + falsePositiveKeys.size);
  const recall = ratio(matchedGold.size, gold.agreements.length);
  const materialGold = gold.agreements.filter((agreement) => agreement.materiality === "material");
  const materialGoldIds = new Set(materialGold.map((agreement) => agreement.id));
  const materialMatches = correctMatches.filter((match) => materialGoldIds.has(match.gold_id));
  const materialCandidateKeys = new Set(materialMatches.map((match) => match.candidate_key));
  const materialFalsePositives = audit.agreements.filter((agreement) =>
    agreement.materiality === "material" && !materialCandidateKeys.has(agreement.key)
  ).length;
  const materialPrecision = ratio(materialMatches.length, materialMatches.length + materialFalsePositives);
  const materialRecall = ratio(new Set(materialMatches.map((match) => match.gold_id)).size, materialGold.length);
  const exactCitationGate = audit.rejections.length === 0 &&
    audit.agreements.every((agreement) =>
      agreement.conversation_event_ids.length > 0 &&
      agreement.diff_citations.every((citation) => citation.validated) &&
      agreement.commands.every((command) => command.exact_head)
    );
  const cleanCaseGate = !gold.clean || audit.agreements.every((agreement) => agreement.state === "fulfilled");
  const failures: string[] = [];
  if (!exactCitationGate) failures.push("one or more conclusions lack valid exact evidence");
  if (!cleanCaseGate) failures.push("the clean case contains a mismatch finding");
  if (!audit.candidate_complete) failures.push("candidate generation was incomplete");
  if (!gold.clean && audit.status === "cannot_audit") failures.push("a non-clean case produced no auditable decision");

  return {
    case_id: gold.case_id,
    ...run,
    precision,
    recall,
    f1: f1(precision, recall),
    material_precision: materialPrecision,
    material_recall: materialRecall,
    material_f1: f1(materialPrecision, materialRecall),
    exact_citation_gate: exactCitationGate,
    clean_case_gate: cleanCaseGate,
    failures
  };
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
    preferred: "product" | "baseline" | "tie";
  }>;
}): AgreementBenchmarkComparison {
  const baselineMacro = macroByCase(input.baseline);
  const productMacro = macroByCase(input.product);
  const delta = productMacro - baselineMacro;
  const failures: string[] = [];
  const requiredCaseIds = new Set(input.required_case_ids);
  const baselineCaseIds = new Set(input.baseline.map((score) => score.case_id));
  const productCaseIds = new Set(input.product.map((score) => score.case_id));
  if (!sameSet(requiredCaseIds, baselineCaseIds) || !sameSet(requiredCaseIds, productCaseIds)) {
    failures.push("benchmark arms must contain exactly the manifest case set");
  }
  if (new Set(input.baseline.map((score) => score.run_id)).size !== input.baseline.length ||
    new Set(input.product.map((score) => score.run_id)).size !== input.product.length) {
    failures.push("run ids must be unique within each benchmark arm");
  }
  const expectedPreferenceKeys = new Set<string>();
  const expectedPreferenceHashes = new Map<string, { baseline: string; product: string }>();
  for (const caseId of requiredCaseIds) {
    const baselineRuns = input.baseline.filter((score) => score.case_id === caseId);
    const productRuns = input.product.filter((score) => score.case_id === caseId);
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
  }
  const productPreferences = input.preferences.filter((preference) => preference.preferred === "product").length;
  const baselinePreferences = input.preferences.filter((preference) => preference.preferred === "baseline").length;
  const ties = input.preferences.filter((preference) => preference.preferred === "tie").length;
  if (input.baseline.some((score) => score.failures.length > 0)) failures.push("one or more baseline runs failed a case gate");
  if (input.product.some((score) => score.failures.length > 0)) failures.push("one or more product runs failed a case gate");
  if (input.product.some((score) => !score.exact_citation_gate)) failures.push("product failed the exact-citation gate");
  if (input.product.some((score) => !score.clean_case_gate)) failures.push("product produced a false mismatch on a clean case");
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
  if (manifest.version !== 1) throw new Error("benchmark manifest version must be 1");
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
  return { version: 1, cases };
}

function sha256(value: unknown, label: string): string {
  const hash = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return hash;
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
  const caseId = requiredString(gold.case_id, "benchmark gold.case_id");
  if (gold.source !== "sanitized_real" && gold.source !== "synthetic") throw new Error("benchmark gold.source is invalid");
  if (typeof gold.clean !== "boolean") throw new Error("benchmark gold.clean must be boolean");
  if (!Array.isArray(gold.agreements) || gold.agreements.length === 0) throw new Error("benchmark gold.agreements must be a non-empty array");
  const events = new Map(input.conversation.events.map((event) => [event.id, event]));
  const agreements = gold.agreements.map((value, index) => {
    const agreement = asRecord(value, `benchmark gold agreement ${index}`);
    const kind = enumString(agreement.kind, AGREEMENT_KINDS, `benchmark gold agreement ${index}.kind`);
    const governingEventIds = stringList(agreement.governing_event_ids, `benchmark gold agreement ${index}.governing_event_ids`);
    if (governingEventIds.length === 0) throw new Error(`benchmark gold agreement ${index} needs a governing event`);
    for (const eventId of governingEventIds) {
      const event = events.get(eventId);
      if (!event) throw new Error(`benchmark gold agreement ${index} cites unknown event ${eventId}`);
      if (!agreementKindAllowsActor(kind, event.actor)) {
        throw new Error(`benchmark gold agreement ${index} cites a governing event owned by ${event.actor}`);
      }
    }
    return {
      id: requiredString(agreement.id, `benchmark gold agreement ${index}.id`),
      kind,
      materiality: enumString(agreement.materiality, AGREEMENT_MATERIALITIES, `benchmark gold agreement ${index}.materiality`),
      expected_state: enumString(agreement.expected_state, AGREEMENT_STATES, `benchmark gold agreement ${index}.expected_state`),
      governing_event_ids: governingEventIds
    };
  });
  assertUnique(agreements.map((agreement) => agreement.id), "benchmark gold agreement id");
  if (gold.clean && agreements.some((agreement) => agreement.expected_state !== "fulfilled")) {
    throw new Error("a clean benchmark case cannot contain non-fulfilled agreements");
  }
  return { case_id: caseId, source: gold.source, clean: gold.clean, agreements };
}

function uniquePairs(matches: AgreementAdjudication["matches"]): AgreementAdjudication["matches"] {
  const seenCandidates = new Set<string>();
  const seenGold = new Set<string>();
  return matches.filter((match) => {
    if (seenCandidates.has(match.candidate_key) || seenGold.has(match.gold_id)) return false;
    seenCandidates.add(match.candidate_key);
    seenGold.add(match.gold_id);
    return true;
  });
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
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

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
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

function enumString<const Values extends readonly string[]>(value: unknown, values: Values, label: string): Values[number] {
  const parsed = requiredString(value, label);
  if (!values.includes(parsed)) throw new Error(`${label} must be one of ${values.join(", ")}`);
  return parsed as Values[number];
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} values must be unique`);
}
