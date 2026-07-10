import { isRecord, uniqueTruthy } from "../core/guards";
import { REVIEW_SEVERITIES, type ReviewSeverity } from "../contracts/review";
import { inspectAndRedactSecrets } from "../privacy/secrets";
import {
  MAX_CONVERSATION_REVIEW_ANCHORS,
  MAX_CONVERSATION_REVIEW_DIFF_LINE_TEXT,
  MAX_CONVERSATION_REVIEW_PROVIDER_CANDIDATES,
  MAX_CONVERSATION_REVIEW_TEXT,
  MAX_CONVERSATION_REVIEW_TITLE,
  type ConversationReviewCandidateDiffAnchor,
  type ConversationReviewCandidateInsight
} from "./review-candidate-contract";
import {
  REVIEWER_INSIGHT_CATEGORIES,
  REVIEWER_INSIGHT_EVIDENCE_STATES,
  type ReviewerInsightCategory,
  type ReviewerInsightEvidenceState
} from "../contracts/conversation-review";

export interface ParsedConversationReviewCandidate {
  candidate: ConversationReviewCandidateInsight;
  outputRedacted: boolean;
  rejectedExactCitations: number;
}

export function isStrictConversationReviewInsightEnvelope(
  value: unknown
): value is { insights: unknown[] } {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, "insights") &&
    Array.isArray(value.insights) &&
    value.insights.length <= MAX_CONVERSATION_REVIEW_PROVIDER_CANDIDATES;
}

export function parseConversationReviewCandidate(
  value: unknown
): ParsedConversationReviewCandidate | undefined {
  if (!isRecord(value) || !isStrictCandidatePayload(value)) {
    return undefined;
  }
  const category = typeof value.category === "string" &&
    REVIEWER_INSIGHT_CATEGORIES.includes(value.category as ReviewerInsightCategory)
    ? value.category as ReviewerInsightCategory
    : undefined;
  const priority = packetSeverity(value.priority);
  const evidenceState = typeof value.evidence_state === "string" &&
    REVIEWER_INSIGHT_EVIDENCE_STATES.includes(value.evidence_state as ReviewerInsightEvidenceState)
    ? value.evidence_state as ConversationReviewCandidateInsight["evidence_state"]
    : undefined;
  const rootCauseKey = sanitizeCandidateProse(value.root_cause_key, 160);
  const title = sanitizeCandidateProse(value.title, MAX_CONVERSATION_REVIEW_TITLE);
  const summary = sanitizeCandidateProse(value.summary, MAX_CONVERSATION_REVIEW_TEXT);
  const why = sanitizeCandidateProse(value.why_it_matters, MAX_CONVERSATION_REVIEW_TEXT);
  const action = sanitizeCandidateProse(value.reviewer_action, MAX_CONVERSATION_REVIEW_TEXT);
  const eventIds = sanitizeCandidateStringArray(value.conversation_event_ids);
  const paths = sanitizeCandidateStringArray(value.paths);
  const requirementIds = sanitizeCandidateStringArray(value.requirement_ids);
  const riskIds = sanitizeCandidateStringArray(value.risk_ids);
  const commandIds = sanitizeCandidateStringArray(value.command_ids);
  const anchors = sanitizeCandidateDiffAnchors(value.diff_anchors);
  if (!category || !priority || !evidenceState ||
    !rootCauseKey.text || !title.text || !summary.text || !why.text || !action.text) {
    return undefined;
  }
  return {
    candidate: {
      root_cause_key: rootCauseKey.text,
      category,
      title: title.text,
      summary: summary.text,
      why_it_matters: why.text,
      reviewer_action: action.text,
      priority,
      evidence_state: evidenceState,
      conversation_event_ids: eventIds.values,
      paths: paths.values,
      requirement_ids: requirementIds.values,
      risk_ids: riskIds.values,
      command_ids: commandIds.values,
      diff_anchors: anchors.values
    },
    outputRedacted: [
      rootCauseKey,
      title,
      summary,
      why,
      action,
      eventIds,
      paths,
      requirementIds,
      riskIds,
      commandIds,
      anchors
    ].some((field) => field.redacted),
    rejectedExactCitations: eventIds.rejected + paths.rejected + requirementIds.rejected +
      riskIds.rejected + commandIds.rejected + anchors.rejected
  };
}

function isStrictCandidatePayload(value: Record<string, unknown>): boolean {
  const expected = new Set([
    "root_cause_key",
    "category",
    "title",
    "summary",
    "why_it_matters",
    "reviewer_action",
    "priority",
    "evidence_state",
    "conversation_event_ids",
    "paths",
    "requirement_ids",
    "risk_ids",
    "command_ids",
    "diff_anchors"
  ]);
  if (!(Object.keys(value).every((key) => expected.has(key)) &&
    [...expected].every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    isBoundedString(value.root_cause_key, 1, 160) &&
    typeof value.category === "string" &&
    REVIEWER_INSIGHT_CATEGORIES.includes(value.category as ReviewerInsightCategory) &&
    isBoundedString(value.title, 1, MAX_CONVERSATION_REVIEW_TITLE) &&
    isBoundedString(value.summary, 1, MAX_CONVERSATION_REVIEW_TEXT) &&
    isBoundedString(value.why_it_matters, 1, MAX_CONVERSATION_REVIEW_TEXT) &&
    isBoundedString(value.reviewer_action, 1, MAX_CONVERSATION_REVIEW_TEXT) &&
    packetSeverity(value.priority) !== undefined &&
    typeof value.evidence_state === "string" &&
    REVIEWER_INSIGHT_EVIDENCE_STATES.includes(value.evidence_state as ReviewerInsightEvidenceState) &&
    isStrictStringArray(value.conversation_event_ids) &&
    isStrictStringArray(value.paths) &&
    isStrictStringArray(value.requirement_ids) &&
    isStrictStringArray(value.risk_ids) &&
    isStrictStringArray(value.command_ids) &&
    Array.isArray(value.diff_anchors) &&
    value.diff_anchors.length <= MAX_CONVERSATION_REVIEW_ANCHORS)) {
    return false;
  }
  return value.diff_anchors.every(isStrictDiffAnchor);
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" &&
    value.trim().length >= minimum &&
    value.length <= maximum;
}

function isStrictStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= MAX_CONVERSATION_REVIEW_ANCHORS &&
    value.every((entry) => isBoundedString(entry, 1, 300)) &&
    new Set(value).size === value.length;
}

function isStrictDiffAnchor(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const expected = new Set(["path", "line_kind", "line", "contains"]);
  return Object.keys(value).every((key) => expected.has(key)) &&
    [...expected].every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    isBoundedString(value.path, 1, 300) &&
    (value.line_kind === "add" || value.line_kind === "delete") &&
    typeof value.line === "number" &&
    Number.isInteger(value.line) &&
    value.line >= 1 &&
    isBoundedString(value.contains, 4, MAX_CONVERSATION_REVIEW_DIFF_LINE_TEXT);
}

function sanitizeCandidateProse(
  value: unknown,
  limit: number
): { text: string; redacted: boolean } {
  const result = inspectAndRedactSecrets(value as string);
  const boundedText = result.text.slice(0, limit);
  return {
    text: boundedText.trim(),
    redacted: result.redactions.length > 0
  };
}

function sanitizeCandidateStringArray(
  value: unknown
): { values: string[]; redacted: boolean; rejected: number } {
  let redacted = false;
  let rejected = 0;
  const values = (value as string[]).flatMap((entry) => {
    const result = inspectAndRedactSecrets(entry);
    const changed = result.text !== entry;
    redacted ||= changed;
    // Citation strings are exact-match capabilities. Never trim or truncate
    // them into an allowlist match that the provider did not actually emit.
    // A secret-derived redaction marker is not the same capability as the raw
    // provider string, so reject it instead of matching prompt-visible markers.
    if (changed) {
      rejected += 1;
      return [];
    }
    return [entry];
  });
  return { values: uniqueTruthy(values), redacted, rejected };
}

function sanitizeCandidateDiffAnchors(
  value: unknown
): { values: ConversationReviewCandidateDiffAnchor[]; redacted: boolean; rejected: number } {
  let redacted = false;
  let rejected = 0;
  const values = (value as Array<Record<string, unknown>>).flatMap((entry) => {
    const rawPath = entry.path as string;
    const rawContains = entry.contains as string;
    const path = inspectAndRedactSecrets(rawPath);
    const contains = inspectAndRedactSecrets(rawContains);
    const changed = path.text !== rawPath || contains.text !== rawContains;
    redacted ||= changed;
    if (changed) {
      rejected += 1;
      return [];
    }
    return [{
      path: rawPath,
      line_kind: entry.line_kind as ConversationReviewCandidateDiffAnchor["line_kind"],
      line: entry.line as number,
      contains: rawContains
    }];
  });
  return { values, redacted, rejected };
}

function packetSeverity(value: unknown): ReviewSeverity | undefined {
  return typeof value === "string" && REVIEW_SEVERITIES.includes(value as ReviewSeverity)
    ? value as ReviewSeverity
    : undefined;
}
