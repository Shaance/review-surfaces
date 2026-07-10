import type { CommandTranscript } from "../commands/transcripts";
import { compareStrings } from "../core/compare";
import { isRecord, uniqueTruthy } from "../core/guards";
import type { EvidenceRef } from "../evidence/evidence";
import { inspectAndRedactSecrets } from "../privacy/secrets";
import type { StructuredDiffLine } from "../pr/contract";
import { PACKET_SEVERITIES, type PacketSeverity } from "../schema/review-packet-contract";
import {
  conversationAnalysisEvidence,
  type ConversationAnalysis
} from "./analysis";
import {
  MAX_CONVERSATION_REVIEW_ANCHORS,
  MAX_CONVERSATION_REVIEW_DIFF_LINE_TEXT,
  MAX_CONVERSATION_REVIEW_PROVIDER_CANDIDATES,
  MAX_CONVERSATION_REVIEW_TEXT,
  MAX_CONVERSATION_REVIEW_TITLE,
  conversationReviewSeverityRank,
  type ConversationReviewCandidateDiffAnchor,
  type ConversationReviewCandidateInsight
} from "./review-candidate-contract";
import {
  MAX_VISIBLE_CONVERSATION_INSIGHTS,
  REVIEWER_INSIGHT_CATEGORIES,
  REVIEWER_INSIGHT_EVIDENCE_STATES,
  type ReviewerInsight,
  type ReviewerInsightCategory,
  type ReviewerInsightEvidenceState
} from "./review-contract";
import {
  boundedConversationReviewText,
  conversationReviewTranscriptIsCurrent,
  type ConversationReviewPromptEvidenceContext,
  type ConversationReviewPromptRiskContext,
  type ConversationReviewVisibleDiffLine
} from "./review-evidence-context";

interface ParsedConversationReviewCandidate {
  candidate: ConversationReviewCandidateInsight;
  outputRedacted: boolean;
  rejectedExactCitations: number;
}

interface MatchedConversationReviewDiffAnchor {
  anchor: ConversationReviewCandidateDiffAnchor;
  line: StructuredDiffLine;
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

export function validateConversationReviewCandidates(
  values: unknown[],
  promptEvidence: ConversationReviewPromptEvidenceContext,
  analysis: ConversationAnalysis,
  headSha?: string
): {
  insights: Array<ReviewerInsight & { rootCauseKey: string }>;
  rejectedCitations: number;
  invalidCandidates: number;
  outputRedacted: boolean;
} {
  const knownEvents = new Set(promptEvidence.eventIds);
  const knownPositiveIntentEvents = new Set(promptEvidence.positiveIntentEventIds);
  const knownProhibitionEvents = new Set(promptEvidence.prohibitionEventIds);
  const knownPaths = new Set(promptEvidence.diff.paths);
  const knownRequirements = new Set(promptEvidence.requirementIds);
  const risksById = new Map(promptEvidence.risks.map((risk) => [risk.candidate.id, risk]));
  const commandsById = new Map(promptEvidence.commands.map((transcript) => [transcript.id, transcript]));
  const knownRiskIds = new Set(risksById.keys());
  const knownCommandIds = new Set(commandsById.keys());
  const analysisIncomplete = analysis.quality_flags.some((flag) =>
    flag === "conversation_input_truncated" || flag === "conversation_analysis_partial"
  );
  const insights: Array<ReviewerInsight & { rootCauseKey: string }> = [];
  let rejectedCitations = 0;
  let invalidCandidates = 0;
  let outputRedacted = false;

  for (const value of values.slice(0, MAX_CONVERSATION_REVIEW_PROVIDER_CANDIDATES)) {
    const parsed = parseCandidate(value);
    if (!parsed) {
      invalidCandidates += 1;
      continue;
    }
    const { candidate } = parsed;
    outputRedacted ||= parsed.outputRedacted;

    const events = filterKnown(candidate.conversation_event_ids, knownEvents);
    const paths = filterKnown(candidate.paths, knownPaths);
    const requirements = filterKnown(candidate.requirement_ids, knownRequirements);
    const riskIds = filterKnown(candidate.risk_ids, knownRiskIds);
    const commandIds = filterKnown(candidate.command_ids, knownCommandIds);
    const matchedDiff = matchDiffAnchors(candidate.diff_anchors, promptEvidence.diff.lines);
    const proposedCitationCount = candidate.conversation_event_ids.length + candidate.paths.length +
      candidate.requirement_ids.length + candidate.risk_ids.length + candidate.command_ids.length +
      candidate.diff_anchors.length + parsed.rejectedExactCitations;
    const acceptedCitationCount = events.length + paths.length + requirements.length + riskIds.length +
      commandIds.length + matchedDiff.length;
    const rejectedForCandidate = Math.max(0, proposedCitationCount - acceptedCitationCount);
    rejectedCitations += rejectedForCandidate;

    if (events.length === 0) {
      continue;
    }
    if (paths.length + requirements.length + riskIds.length + commandIds.length + matchedDiff.length === 0) {
      continue;
    }

    // A current-head command proves that command's captured outcome, not the
    // behavior described by arbitrary prose. In particular, a green broad suite
    // is non-probative when the relevant assertion was deleted. Exact diff-line
    // or deterministic-risk corroboration is required to retain a semantic
    // supported/contradicted state; command evidence remains visible below.
    const relatedRiskIds = riskIds.filter((riskId) => riskTouchesPaths(risksById.get(riskId), paths));
    const hasValidatedAnchors = matchedDiff.length > 0 || relatedRiskIds.length > 0;
    const hasPositiveIntentAnchor = events.some((eventId) => knownPositiveIntentEvents.has(eventId));
    const hasProhibitionAnchor = events.some((eventId) => knownProhibitionEvents.has(eventId));
    const hasStateSpecificIntentAnchor = candidate.evidence_state === "supported"
      ? hasPositiveIntentAnchor
      : hasPositiveIntentAnchor || hasProhibitionAnchor;
    const absenceEvidenceIncomplete = findingMayDependOnOmittedContext(candidate.category, promptEvidence);
    const evidenceState: ReviewerInsightEvidenceState =
      rejectedForCandidate > 0 ||
      analysisIncomplete ||
      absenceEvidenceIncomplete ||
      ((candidate.evidence_state === "supported" || candidate.evidence_state === "contradicted") &&
        (!hasValidatedAnchors || !hasStateSpecificIntentAnchor))
        ? "unverified"
        : candidate.evidence_state;
    const evidence = insightEvidence({
      events,
      matchedDiff,
      requirements,
      riskIds: uniqueTruthy([...relatedRiskIds, ...riskIds]),
      commandIds,
      risksById,
      commandsById,
      headSha
    });

    insights.push({
      id: "",
      category: candidate.category,
      title: candidate.title,
      summary: candidate.summary,
      why_it_matters: candidate.why_it_matters,
      reviewer_action: candidate.reviewer_action,
      priority: candidate.priority,
      evidence_state: evidenceState,
      basis: evidenceState !== "unverified" && hasValidatedAnchors
        ? "validated_anchors"
        : "ai_reconciliation",
      conversation_event_ids: events,
      paths: uniqueTruthy([...matchedDiff.map((match) => match.anchor.path), ...paths])
        .slice(0, MAX_CONVERSATION_REVIEW_ANCHORS),
      requirement_ids: requirements,
      risk_ids: riskIds,
      command_ids: commandIds,
      evidence,
      rootCauseKey: normalizeKey(candidate.root_cause_key)
    });
  }

  return { insights, rejectedCitations, invalidCandidates, outputRedacted };
}

function findingMayDependOnOmittedContext(
  category: ReviewerInsightCategory,
  evidence: ConversationReviewPromptEvidenceContext
): boolean {
  if (category === "validation_gap") {
    return evidence.commandContextTruncated ||
      evidence.requirementContextTruncated ||
      evidence.coverageDeltaContextTruncated;
  }
  if (category === "scope_surprise") {
    return evidence.requirementContextTruncated ||
      evidence.riskContextTruncated ||
      evidence.riskPathContextTruncated ||
      evidence.coverageDeltaContextTruncated;
  }
  if (category === "unresolved_assumption") {
    return evidence.requirementContextTruncated ||
      evidence.riskContextTruncated ||
      evidence.riskPathContextTruncated;
  }
  return false;
}

function parseCandidate(value: unknown): ParsedConversationReviewCandidate | undefined {
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

function matchDiffAnchors(
  anchors: ConversationReviewCandidateDiffAnchor[],
  visibleLines: ConversationReviewVisibleDiffLine[]
): MatchedConversationReviewDiffAnchor[] {
  const matches: MatchedConversationReviewDiffAnchor[] = [];
  for (const anchor of anchors) {
    const visible = visibleLines.find(
      (candidate) =>
        (candidate.path === anchor.path || candidate.oldPath === anchor.path) &&
        candidate.line.kind === anchor.line_kind &&
        candidate.lineNumber === anchor.line &&
        candidate.text.includes(anchor.contains)
    );
    if (visible) {
      matches.push({ anchor, line: visible.line });
    }
  }
  return matches;
}

function riskTouchesPaths(
  risk: ConversationReviewPromptRiskContext | undefined,
  paths: string[]
): boolean {
  if (!risk || paths.length === 0) {
    return false;
  }
  const candidatePaths = new Set(paths);
  return risk.paths.some((path) => candidatePaths.has(path));
}

function insightEvidence(input: {
  events: string[];
  matchedDiff: MatchedConversationReviewDiffAnchor[];
  requirements: string[];
  riskIds: string[];
  commandIds: string[];
  risksById: Map<string, ConversationReviewPromptRiskContext>;
  commandsById: Map<string, CommandTranscript>;
  headSha?: string;
}): EvidenceRef[] {
  const conversationEvidence: EvidenceRef[] = input.events.slice(0, 3).flatMap((eventId) =>
    conversationAnalysisEvidence({ text: "Reviewer insight conversation anchor.", event_ids: [eventId] })
  );
  const diffEvidence: EvidenceRef[] = [];
  for (const match of input.matchedDiff) {
    const line = match.line.kind === "delete" ? match.line.old_line : match.line.new_line;
    diffEvidence.push({
      kind: "diff",
      path: match.anchor.path,
      ...(line ? { line_start: line, line_end: line } : {}),
      note: `Exact ${match.anchor.line_kind} line anchor: ${boundedConversationReviewText(match.anchor.contains, 120)}`,
      confidence: "high",
      validation_status: "valid",
      llm_proposed: true
    });
  }
  const riskEvidence: EvidenceRef[] = [];
  for (const riskId of input.riskIds) {
    const risk = input.risksById.get(riskId);
    riskEvidence.push(...(risk?.visibleEvidence ?? []).slice(0, 2));
  }
  const commandEvidence: EvidenceRef[] = [];
  for (const commandId of input.commandIds) {
    const transcript = input.commandsById.get(commandId);
    if (!transcript) {
      continue;
    }
    const current = conversationReviewTranscriptIsCurrent(transcript, input.headSha);
    commandEvidence.push({
      kind: "command",
      event_id: transcript.id,
      command: transcript.command,
      sha: transcript.head_sha,
      note: `Captured command transcript status: ${transcript.status}${current ? " at reviewed head" : " (not current-head proven)"}.`,
      confidence: current ? "high" : "low",
      validation_status: current && transcript.status === "passed"
        ? "valid"
        : transcript.status === "failed" ? "invalid" : "not_checked"
    });
  }
  const supplementalEvidence: EvidenceRef[] = [];
  for (const requirementId of input.requirements) {
    supplementalEvidence.push({
      kind: "spec",
      acai_id: requirementId,
      note: "Requirement id is present in the diff-scoped allowlist.",
      confidence: "medium",
      validation_status: "valid",
      llm_proposed: true
    });
  }
  // State-bearing facts come before supplemental requirement references so the
  // evidence cap can never hide the diff/risk anchor that earned a strong label.
  return uniqueEvidence([
    ...conversationEvidence,
    ...diffEvidence,
    ...riskEvidence,
    ...commandEvidence,
    ...supplementalEvidence
  ]).slice(0, 18);
}

export function rankDedupeAndCapConversationReviewInsights(
  values: Array<ReviewerInsight & { rootCauseKey: string }>
): ReviewerInsight[] {
  const sorted = [...values].sort((left, right) =>
    evidenceStateRank(left.evidence_state) - evidenceStateRank(right.evidence_state) ||
    conversationReviewSeverityRank(left.priority) - conversationReviewSeverityRank(right.priority) ||
    compareStrings(left.title, right.title)
  );
  const kept: Array<ReviewerInsight & { rootCauseKey: string }> = [];
  for (const candidate of sorted) {
    if (kept.some((existing) => sameRootCause(existing, candidate))) {
      continue;
    }
    kept.push(candidate);
    if (kept.length >= MAX_VISIBLE_CONVERSATION_INSIGHTS) {
      break;
    }
  }
  return kept.map(({ rootCauseKey: _rootCauseKey, ...insight }, index) => ({
    ...insight,
    id: `CONV-INSIGHT-${String(index + 1).padStart(3, "0")}`
  }));
}

function sameRootCause(
  left: ReviewerInsight & { rootCauseKey: string },
  right: ReviewerInsight & { rootCauseKey: string }
): boolean {
  if (left.rootCauseKey && left.rootCauseKey === right.rootCauseKey) {
    return true;
  }
  if (left.category !== right.category) {
    return false;
  }
  const leftPaths = new Set(left.paths);
  const overlap = right.paths.filter((path) => leftPaths.has(path)).length;
  return overlap > 0 && overlap >= Math.ceil(Math.min(left.paths.length, right.paths.length) / 2);
}

function packetSeverity(value: unknown): PacketSeverity | undefined {
  return typeof value === "string" && PACKET_SEVERITIES.includes(value as PacketSeverity)
    ? value as PacketSeverity
    : undefined;
}

function filterKnown(values: string[], known: Set<string>): string[] {
  return values.filter((value) => known.has(value));
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function uniqueEvidence(values: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify([value.kind, value.path, value.line_start, value.acai_id, value.event_id, value.command]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function evidenceStateRank(value: ReviewerInsightEvidenceState): number {
  return { contradicted: 0, unverified: 1, supported: 2 }[value];
}
