import type { CommandTranscript } from "../contracts/command-transcript";
import type {
  ConversationAnalysis,
  ReviewerInsight,
  ReviewerInsightCategory,
  ReviewerInsightEvidenceState
} from "../contracts/conversation-review";
import { uniqueTruthy } from "../core/guards";
import type { EvidenceRef } from "../contracts/evidence";
import type { StructuredDiffLine } from "../contracts/pr-review";
import { conversationAnalysisEvidence } from "./analysis-result-grounding";
import {
  MAX_CONVERSATION_REVIEW_ANCHORS,
  MAX_CONVERSATION_REVIEW_PROVIDER_CANDIDATES,
  type ConversationReviewCandidateDiffAnchor
} from "./review-candidate-contract";
import { parseConversationReviewCandidate } from "./review-candidate-payload";
import {
  boundedConversationReviewText,
  conversationReviewTranscriptIsCurrent,
  type ConversationReviewPromptEvidenceContext,
  type ConversationReviewPromptRiskContext,
  type ConversationReviewVisibleDiffLine
} from "./review-evidence-context-builder";

interface MatchedConversationReviewDiffAnchor {
  anchor: ConversationReviewCandidateDiffAnchor;
  line: StructuredDiffLine;
}

export type GroundedConversationReviewInsight = ReviewerInsight & { rootCauseKey: string };

export function validateConversationReviewCandidates(
  values: unknown[],
  promptEvidence: ConversationReviewPromptEvidenceContext,
  analysis: ConversationAnalysis,
  headSha?: string
): {
  insights: GroundedConversationReviewInsight[];
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
  const insights: GroundedConversationReviewInsight[] = [];
  let rejectedCitations = 0;
  let invalidCandidates = 0;
  let outputRedacted = false;

  for (const value of values.slice(0, MAX_CONVERSATION_REVIEW_PROVIDER_CANDIDATES)) {
    const parsed = parseConversationReviewCandidate(value);
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
