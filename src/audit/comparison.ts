import { compareStrings } from "../core/compare";
import {
  agreementNeedsHumanDecision,
  type AgreementAuditComparison,
  type AgreementAudit,
  type ComparableAgreementAudit
} from "./contract";

export function compareAgreementAuditDecisions(
  current: AgreementAudit,
  previous: ComparableAgreementAudit
): AgreementAuditComparison {
  if (current.repository !== previous.repository) {
    throw new Error("--previous-audit must come from the same repository");
  }
  const currentDecisions = current.agreements.filter(agreementNeedsHumanDecision);
  const previousDecisions = previous.agreements.filter(agreementNeedsHumanDecision);
  const matchedCurrent = new Set<number>();
  const matchedPrevious = new Set<number>();
  const unchanged: string[] = [];
  const previousIndexesByKey = new Map<string, number[]>();
  previousDecisions.forEach((decision, index) => {
    const indexes = previousIndexesByKey.get(decision.key);
    if (indexes) indexes.push(index);
    else previousIndexesByKey.set(decision.key, [index]);
  });

  for (const [currentIndex, decision] of currentDecisions.entries()) {
    const sameKeyIndexes = previousIndexesByKey.get(decision.key);
    const previousIndex = sameKeyIndexes?.at(-1);
    if (previousIndex === undefined ||
      decisionIdentity(previousDecisions[previousIndex]) !== decisionIdentity(decision)) continue;
    sameKeyIndexes!.pop();
    matchedCurrent.add(currentIndex);
    matchedPrevious.add(previousIndex);
    unchanged.push(decision.key);
  }

  const currentByIdentity = unmatchedByIdentity(currentDecisions, matchedCurrent);
  const previousByIdentity = unmatchedByIdentity(previousDecisions, matchedPrevious);
  for (const [identity, currentIndexes] of currentByIdentity) {
    const previousIndexes = previousByIdentity.get(identity);
    if (currentIndexes.length !== 1 || previousIndexes?.length !== 1) continue;
    matchedCurrent.add(currentIndexes[0]);
    matchedPrevious.add(previousIndexes[0]);
    unchanged.push(currentDecisions[currentIndexes[0]].key);
  }

  const unmatchedPrevious = sorted(previousDecisions
    .filter((_, index) => !matchedPrevious.has(index))
    .map((decision) => decision.key));
  return {
    previous_head_sha: previous.head_sha,
    new_decision_keys: sorted(currentDecisions
      .filter((_, index) => !matchedCurrent.has(index))
      .map((decision) => decision.key)),
    unchanged_decision_keys: sorted(unchanged),
    resolved_decision_keys: current.completeness.verified ? unmatchedPrevious : [],
    unverified_previous_decision_keys: current.completeness.verified ? [] : unmatchedPrevious
  };
}

function unmatchedByIdentity(
  decisions: ComparableAgreementAudit["agreements"],
  matched: ReadonlySet<number>
): Map<string, number[]> {
  const grouped = new Map<string, number[]>();
  decisions.forEach((decision, index) => {
    if (matched.has(index)) return;
    const identity = decisionIdentity(decision);
    const indexes = grouped.get(identity);
    if (indexes) indexes.push(index);
    else grouped.set(identity, [index]);
  });
  return grouped;
}

function decisionIdentity(
  agreement: ComparableAgreementAudit["agreements"][number]
): string {
  return [
    agreement.kind,
    ...[...new Set(agreement.conversation_event_ids)].sort(compareStrings)
  ].join("\0");
}

function sorted(values: string[]): string[] {
  return values.sort(compareStrings);
}
