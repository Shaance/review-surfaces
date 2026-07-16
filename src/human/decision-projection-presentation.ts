import type { EvidenceRef } from "../contracts/evidence";
import type { DecisionFinding, DecisionIntentSource } from "./contract";

export const EMPTY_DECISION_FINDINGS_TEXT = "No approval-changing findings were admitted for this reviewed range.";

export function decisionIntentSourceLabel(source: DecisionIntentSource): string {
  switch (source) {
    case "pull_request": return "From the PR title and description";
    case "conversation_advisory": return "From advisory conversation context";
    case "affected_requirements": return "From affected requirements";
    case "packet": return "From repository intent";
  }
}

export function incompleteReviewScopeText(omittedCount: number): string | undefined {
  return omittedCount > 0
    ? `Review scope incomplete: ${omittedCount} untracked file(s) exceeded the collection budget and were omitted.`
    : undefined;
}

export function decisionProjectionHeading(count: number): string {
  if (count === 1) return "Approval decision";
  return count > 1 ? `Approval decisions (${count})` : "Approval decisions";
}

export function decisionEvidenceDisplayStrings(evidence: readonly EvidenceRef[]): string[] {
  return [...new Set(evidence
    .map((ref) => ref.path ? `${ref.path}${ref.line_start ? `:${ref.line_start}` : ""}` : ref.note)
    .filter((value): value is string => Boolean(value)))];
}

export interface DecisionFindingPresentation {
  title: string;
  path?: string;
  reason?: string;
  reviewerAction: string;
  evidence: string[];
}

export function decisionFindingPresentation(finding: DecisionFinding): DecisionFindingPresentation {
  const reason = finding.reason.trim() === finding.title.trim() ? undefined : finding.reason;
  return {
    title: finding.title,
    ...(finding.path ? { path: finding.path } : {}),
    ...(reason ? { reason } : {}),
    reviewerAction: finding.reviewer_action,
    evidence: decisionEvidenceDisplayStrings(finding.evidence)
  };
}
