import { auditDiffCoordinate, type AgreementAudit } from "./contract";
import type { AgreementBenchmarkGold, GoldAgreement } from "./benchmark";
import { sameSet } from "./benchmark-shared";

/** Blinded semantic mapping produced only after candidate generation. */
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
  const matchedPairs = uniquePairs(adjudication.matches).flatMap((match) => {
    const candidate = candidateByKey.get(match.candidate_key);
    const expected = goldById.get(match.gold_id);
    return candidate && expected
      ? [{ ...match, candidate, expected, evidenceMatches: benchmarkEvidenceMatches(candidate, expected) }]
      : [];
  });
  const correctMatches = matchedPairs.filter(({ candidate, expected, evidenceMatches }) => {
    return candidate.kind === expected.kind &&
      candidate.state === expected.expected_state &&
      candidate.materiality === expected.materiality &&
      sameSet(new Set(candidate.conversation_event_ids), new Set(expected.governing_event_ids)) &&
      evidenceMatches;
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
    matchedPairs.every((match) => match.evidenceMatches) &&
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

function benchmarkEvidenceMatches(
  candidate: AgreementAudit["agreements"][number],
  expected: GoldAgreement
): boolean {
  return sameSet(
    new Set(candidate.diff_citations.map(auditDiffCoordinate)),
    new Set(expected.expected_diff_coordinates.map(auditDiffCoordinate))
  ) && sameSet(
    new Set(candidate.commands.map((command) => command.id)),
    new Set(expected.expected_command_ids)
  );
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
