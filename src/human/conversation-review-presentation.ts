import {
  MAX_VISIBLE_CONVERSATION_INSIGHTS,
  type ConversationAnalysis,
  type ReviewerInsight
} from "../contracts/conversation-review";
import { uniqueTruthy } from "../core/guards";
import type { HumanReviewModel } from "./contract";

export function conversationAnalysisForRender(model: HumanReviewModel): ConversationAnalysis | undefined {
  return model.conversation_analysis;
}

export function conversationInsightsForRender(model: HumanReviewModel): ReviewerInsight[] {
  return visibleConversationInsights(model.conversation_analysis, model.review_insights);
}

export interface ConversationReviewPresentation {
  status: ConversationAnalysis["status"];
  statusLabel: string;
  summary: string;
  summaryIsSynopsis: boolean;
  summaryLabel?: "AI synopsis" | "Local synopsis";
  emptyMessage: string;
}

/** Shared reviewer meaning; Markdown and HTML add only format-specific markup. */
export function conversationReviewPresentation(
  analysis: ConversationAnalysis | undefined
): ConversationReviewPresentation {
  const status = analysis?.status ?? "not_assessed";
  const suppliedSummary = typeof analysis?.summary === "string" && analysis.summary.trim().length > 0
    ? analysis.summary
    : undefined;
  const statusLabel = status === "analyzed"
    ? `Analyzed${analysis && conversationAnalysisIsPartial(analysis) ? " — partial" : ""}`
    : status === "degraded" ? "Degraded — incomplete" : "Not assessed";
  const summary = suppliedSummary ?? (analysis === undefined
    ? "No conversation analysis is present in this review artifact."
    : status === "analyzed"
      ? "Conversation intent was reconstructed."
      : status === "degraded"
        ? "Conversation analysis was unavailable or incomplete."
        : "The conversation log was not assessed.");
  const emptyMessage = conversationReconciliationIncomplete(analysis)
    ? "Diff reconciliation did not complete, so no conversation-grounded conclusion is available."
    : status === "analyzed"
      ? "No conversation-grounded insight survived reconciliation. This is not evidence that the change is clean."
      : "No conversation-grounded conclusions are available. This is not evidence that the change is clean.";
  return {
    status,
    statusLabel,
    summary,
    summaryIsSynopsis: status === "analyzed" && suppliedSummary !== undefined,
    ...(status === "analyzed" && suppliedSummary !== undefined
      ? { summaryLabel: analysis?.quality_flags.includes("conversation_deterministic_baseline") ? "Local synopsis" as const : "AI synopsis" as const }
      : {}),
    emptyMessage
  };
}

export function conversationEvidenceStateLabel(state: ReviewerInsight["evidence_state"]): string {
  switch (state) {
    case "supported":
      return "Aligned with intent";
    case "contradicted":
      return "Conflicts with intent";
    case "unverified":
      return "Needs verification";
  }
}

export function conversationAnalysisCaveats(analysis: ConversationAnalysis | undefined): string[] {
  if (!analysis) {
    return [];
  }
  const messages: string[] = [];
  const flags = new Set(analysis.quality_flags);
  if (flags.has("conversation_input_truncated")) {
    messages.push("The conversation input was bounded; omitted content may limit the interpretation.");
  }
  if (flags.has("conversation_analysis_partial")) {
    messages.push("One or more conversation windows could not be analyzed.");
  }
  if (flags.has("conversation_enrichment_unavailable")) {
    messages.push("Provider enrichment was unavailable; this brief contains the deterministic local baseline only.");
  }
  if (flags.has("conversation_review_diff_truncated")) {
    messages.push("Reconciliation used a bounded subset of changed lines.");
  }
  if (flags.has("conversation_review_commands_truncated")) {
    messages.push("Command transcript context was bounded; omitted commands may limit validation-gap conclusions.");
  }
  if (flags.has("conversation_review_requirements_truncated")) {
    messages.push("Requirement context was bounded; omitted requirements may limit scope conclusions.");
  }
  if (flags.has("conversation_review_risks_truncated")) {
    messages.push("Deterministic risk context was bounded; omitted risks may limit scope conclusions.");
  }
  if (flags.has("conversation_review_risk_paths_truncated")) {
    messages.push("Deterministic risk-path context was bounded; omitted paths cannot corroborate strong conclusions.");
  }
  if (flags.has("conversation_review_coverage_truncated")) {
    messages.push("Coverage-delta context was bounded; omitted deltas may limit scope or validation conclusions.");
  }
  if (flags.has("conversation_review_unavailable") || flags.has("conversation_review_invalid_payload")) {
    messages.push("Diff reconciliation did not complete.");
  }
  if (flags.has("conversation_review_citations_rejected") || flags.has("conversation_review_candidates_rejected")) {
    messages.push("Some proposed findings or citations were rejected by validation.");
  }
  if (flags.has("conversation_input_redacted") || flags.has("conversation_analysis_output_redacted") || flags.has("conversation_review_output_redacted")) {
    messages.push("Sensitive text was redacted.");
  }
  return uniqueTruthy(messages);
}

export function conversationInsightBasisLabel(basis: ReviewerInsight["basis"]): string {
  return basis === "validated_anchors"
    ? "conversation and review anchors validated; the relationship is AI-inferred."
    : "AI reconciliation without enough deterministic anchors; verify before relying on it.";
}

export interface ConversationContextRow {
  label: string;
  items: ConversationAnalysisItemForRender[];
}

interface ConversationAnalysisItemForRender {
  text: string;
  eventIds: string[];
}

export interface ConversationCitationGroup {
  label: "events" | "diff" | "paths" | "requirements" | "risks" | "commands";
  values: string[];
}

export function conversationAnalysisContextRows(
  analysis: ConversationAnalysis | undefined
): ConversationContextRow[] {
  if (!analysis || analysis.status !== "analyzed") {
    return [];
  }
  const rows: ConversationContextRow[] = [];
  appendConversationContextRow(rows, "Stated goal", analysis.intent, 2);
  appendConversationContextRow(rows, "Later refinement", analysis.refinements, 2);
  appendConversationContextRow(rows, "Constraint", analysis.constraints, 2);
  appendConversationContextRow(rows, "Explicit non-goal", analysis.non_goals, 1);
  appendConversationContextRow(rows, "Rejected direction", analysis.rejected_alternatives, 1);
  appendConversationContextRow(rows, "Agent claim", analysis.claims, 1);
  appendConversationContextRow(rows, "Claimed validation", analysis.validation_claims, 2);
  appendConversationContextRow(
    rows,
    "Observed validation",
    (analysis.validation_observations ?? []).map((item) => ({
      text: `${item.status}: ${item.text}`,
      event_ids: item.event_ids
    })),
    2
  );
  appendConversationContextRow(rows, "Known gap", analysis.known_gaps, 1);
  return rows;
}

export function conversationInsightCitationGroups(insight: ReviewerInsight): ConversationCitationGroup[] {
  const diffEvidence = insight.evidence.filter((ref) => ref.kind === "diff" && typeof ref.path === "string");
  const locatedPaths = new Set(diffEvidence.map((ref) => ref.path as string));
  const candidates: ConversationCitationGroup[] = [
    { label: "events", values: insight.conversation_event_ids },
    {
      label: "diff",
      values: uniqueTruthy(diffEvidence.map((ref) => `${ref.path}${ref.line_start ? `:L${ref.line_start}` : ""}`))
    },
    { label: "paths", values: insight.paths.filter((pathValue) => !locatedPaths.has(pathValue)) },
    { label: "requirements", values: insight.requirement_ids },
    { label: "risks", values: insight.risk_ids },
    { label: "commands", values: insight.command_ids }
  ];
  return candidates.filter((group) => group.values.length > 0);
}

function appendConversationContextRow(
  rows: ConversationContextRow[],
  label: string,
  items: ConversationAnalysis["intent"],
  limit: number
): void {
  const visible = items.slice(0, limit);
  if (visible.length === 0) {
    return;
  }
  rows.push({
    label,
    items: visible.map((item) => ({ text: item.text, eventIds: item.event_ids }))
  });
}

export function conversationAnalysisIsPartial(analysis: ConversationAnalysis): boolean {
  return analysis.quality_flags.some((flag) =>
    flag === "conversation_input_truncated" ||
    flag === "conversation_analysis_partial" ||
    flag === "conversation_enrichment_unavailable" ||
    flag === "conversation_review_diff_truncated" ||
    flag === "conversation_review_commands_truncated" ||
    flag === "conversation_review_requirements_truncated" ||
    flag === "conversation_review_risks_truncated" ||
    flag === "conversation_review_risk_paths_truncated" ||
    flag === "conversation_review_coverage_truncated" ||
    flag === "conversation_review_unavailable" ||
    flag === "conversation_review_invalid_payload"
  );
}

export function conversationReconciliationIncomplete(analysis: ConversationAnalysis | undefined): boolean {
  return analysis?.quality_flags.some((flag) =>
    flag === "conversation_review_unavailable" || flag === "conversation_review_invalid_payload"
  ) === true;
}

export function visibleConversationInsights(
  analysis: ConversationAnalysis | undefined,
  insights: ReviewerInsight[] | undefined
): ReviewerInsight[] {
  if (
    analysis?.status !== "analyzed" ||
    conversationReconciliationIncomplete(analysis) ||
    !Array.isArray(insights)
  ) {
    return [];
  }
  return insights.slice(0, MAX_VISIBLE_CONVERSATION_INSIGHTS);
}
