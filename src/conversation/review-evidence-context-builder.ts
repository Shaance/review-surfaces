import type { CommandTranscript } from "../contracts/command-transcript";
import {
  CONVERSATION_ANALYSIS_SECTIONS,
  type ConversationAnalysis,
  type ConversationReviewRiskCandidate,
  type ConversationReviewRiskModel
} from "../contracts/conversation-review";
import { compareStrings } from "../core/compare";
import { uniqueTruthy } from "../core/guards";
import type { EvidenceRef } from "../contracts/evidence";
import type {
  PrScopeModel,
  PrScopedCoverageModel,
  StructuredDiff,
  StructuredDiffLine
} from "../contracts/pr-review";
import type { ProviderName, ReasoningProvider } from "../contracts/provider";
import { reviewSeverityRank } from "../contracts/review";
import {
  containsBlockingSecretMaterial,
  inspectAndRedactSecrets
} from "../privacy/secrets";
import {
  compareConversationEvents,
  conversationEventOrderIsMonotonic
} from "./analysis-prompt-context";
import type { ConversationEvent } from "./events";
import {
  MAX_CONVERSATION_REVIEW_DIFF_LINE_TEXT
} from "./review-candidate-contract";

export interface BuildConversationReviewInput {
  provider: ReasoningProvider;
  providerName: ProviderName;
  events?: ConversationEvent[];
  diff?: StructuredDiff;
  scope?: PrScopeModel;
  coverage?: PrScopedCoverageModel;
  risks?: ConversationReviewRiskModel;
  commandTranscripts?: CommandTranscript[];
  requirementIds?: readonly string[];
  headSha?: string;
  redactSecrets?: boolean;
  remotePrivacyBlocked?: boolean;
}

export interface ConversationReviewDiffContext {
  text: string;
  truncated: boolean;
  blocked: boolean;
  paths: string[];
  lines: ConversationReviewVisibleDiffLine[];
}

export interface ConversationReviewVisibleDiffLine {
  path: string;
  oldPath?: string;
  line: StructuredDiffLine;
  lineNumber: number;
  text: string;
}

export interface ConversationReviewPromptRiskContext {
  candidate: ConversationReviewRiskCandidate;
  paths: string[];
  visibleEvidence: EvidenceRef[];
  pathContextTruncated: boolean;
  pathContextTotal: number;
}

export interface ConversationReviewPromptEvidenceContext {
  diff: ConversationReviewDiffContext;
  eventIds: string[];
  positiveIntentEventIds: string[];
  prohibitionEventIds: string[];
  requirementIds: string[];
  risks: ConversationReviewPromptRiskContext[];
  commands: CommandTranscript[];
  commandContextTruncated: boolean;
  commandContextTotal: number;
  requirementContextTruncated: boolean;
  requirementContextTotal: number;
  riskContextTruncated: boolean;
  riskContextTotal: number;
  riskPathContextTruncated: boolean;
  riskPathContextIncluded: number;
  riskPathContextTotal: number;
  coverageDeltaContextTruncated: boolean;
  coverageDeltaContextTotal: number;
  scopeFacts: {
    outOfScopeChangedFiles: string[];
    coverage?: {
      baseAvailable: boolean;
      counts: PrScopedCoverageModel["counts"];
      deltas: Array<{
        requirementId: string;
        baseStatus?: string;
        headStatus: string;
        delta: string;
      }>;
    };
  };
  blocked: boolean;
}

const MAX_DIFF_FILES = 40;
const MAX_DIFF_LINES = 220;
const MAX_REQUIREMENT_IDS = 200;
const MAX_RISKS = 60;
const MAX_RISK_PATHS_PER_RISK = 12;
const MAX_COMMANDS = 30;
const MAX_COVERAGE_DELTAS = 40;

export function conversationReviewContextQualityFlags(
  evidence: ConversationReviewPromptEvidenceContext
): string[] {
  return [
    ...(evidence.diff.truncated ? ["conversation_review_diff_truncated"] : []),
    ...(evidence.commandContextTruncated ? ["conversation_review_commands_truncated"] : []),
    ...(evidence.requirementContextTruncated ? ["conversation_review_requirements_truncated"] : []),
    ...(evidence.riskContextTruncated ? ["conversation_review_risks_truncated"] : []),
    ...(evidence.riskPathContextTruncated ? ["conversation_review_risk_paths_truncated"] : []),
    ...(evidence.coverageDeltaContextTruncated ? ["conversation_review_coverage_truncated"] : [])
  ];
}

export function buildConversationReviewDiffContext(
  diff: StructuredDiff
): ConversationReviewDiffContext {
  const lines: string[] = [];
  const visibleLines: ConversationReviewVisibleDiffLine[] = [];
  const paths: string[] = [];
  const files = diff.files.slice(0, MAX_DIFF_FILES);
  let emitted = 0;
  let lineLimitExceeded = false;
  let truncated = diff.files.length > MAX_DIFF_FILES;
  let blocked = false;
  for (const file of files) {
    const pathField = safeConversationReviewPromptText(file.path, 300);
    const oldPathField = file.old_path ? safeConversationReviewPromptText(file.old_path, 300) : undefined;
    blocked ||= pathField.blocked || oldPathField?.blocked === true;
    const visiblePath = pathField.text === file.path ? pathField.text : undefined;
    const visibleOldPath = file.old_path && oldPathField?.text === file.old_path ? oldPathField.text : undefined;
    if (!visiblePath || (file.old_path && !visibleOldPath)) {
      truncated = true;
      continue;
    }
    paths.push(visiblePath, ...(visibleOldPath ? [visibleOldPath] : []));
    lines.push(JSON.stringify({
      record: "file",
      status: file.status,
      path: visiblePath,
      ...(visibleOldPath ? { old_path: visibleOldPath } : {})
    }));
    if (lineLimitExceeded) {
      continue;
    }
    hunks: for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "context") {
          continue;
        }
        if (emitted >= MAX_DIFF_LINES) {
          truncated = true;
          lineLimitExceeded = true;
          break hunks;
        }
        const lineNumber = line.kind === "add" ? line.new_line : line.old_line;
        if (!lineNumber) {
          truncated = true;
          continue;
        }
        const lineField = safeConversationReviewPromptText(line.text, MAX_CONVERSATION_REVIEW_DIFF_LINE_TEXT);
        blocked ||= lineField.blocked;
        truncated ||= line.text.length > MAX_CONVERSATION_REVIEW_DIFF_LINE_TEXT;
        const text = lineField.text;
        lines.push(JSON.stringify({
          record: "line",
          path: visiblePath,
          line_kind: line.kind,
          line: lineNumber,
          text
        }));
        visibleLines.push({
          path: visiblePath,
          ...(visibleOldPath ? { oldPath: visibleOldPath } : {}),
          line,
          lineNumber,
          text
        });
        emitted += 1;
      }
    }
  }
  return {
    text: lines.join("\n") || "(no changed lines)",
    truncated,
    blocked,
    paths: uniqueTruthy(paths),
    lines: visibleLines
  };
}

export function buildConversationReviewEvidenceContext(
  input: BuildConversationReviewInput,
  analysis: ConversationAnalysis,
  diff: ConversationReviewDiffContext
): ConversationReviewPromptEvidenceContext {
  const eventIds = conversationAnalysisEventIds(analysis);
  const citedPositiveIntentEventIds = conversationPositiveIntentEventIds(analysis);
  const citedProhibitionEventIds = conversationProhibitionEventIds(analysis);
  const positiveIntentCandidates = new Set(citedPositiveIntentEventIds);
  const prohibitionCandidates = new Set(citedProhibitionEventIds);
  const targetEventIds = new Set([...positiveIntentCandidates, ...prohibitionCandidates]);
  const positiveUserEventIds = new Set<string>();
  const prohibitionUserEventIds = new Set<string>();
  if (targetEventIds.size > 0) {
    for (const event of earliestTargetEvents(input.events ?? [], targetEventIds)) {
      if (event.actor.toLowerCase() === "user") {
        if (positiveIntentCandidates.has(event.id)) {
          positiveUserEventIds.add(event.id);
        }
        if (prohibitionCandidates.has(event.id)) {
          prohibitionUserEventIds.add(event.id);
        }
      }
    }
  }
  const positiveIntentEventIds = citedPositiveIntentEventIds
    .filter((eventId) => positiveUserEventIds.has(eventId));
  const prohibitionEventIds = citedProhibitionEventIds
    .filter((eventId) => prohibitionUserEventIds.has(eventId));
  const requirementCandidates = knownRequirementIds(input);
  const requirementIds = requirementCandidates.slice(0, MAX_REQUIREMENT_IDS);
  const riskCandidates = input.risks?.candidates ?? [];
  const risks = riskCandidates
    .map((risk, index) => ({ risk, index }))
    .filter(({ risk }) => promptExactConversationReviewText(risk.id, 300) === risk.id)
    .sort((left, right) =>
      reviewSeverityRank(left.risk.severity) - reviewSeverityRank(right.risk.severity) ||
      compareStrings(left.risk.id, right.risk.id) ||
      left.index - right.index
    )
    .slice(0, MAX_RISKS)
    .map(({ risk }) => buildPromptRiskContext(risk));
  const riskPathContextIncluded = risks.reduce((total, risk) => total + risk.paths.length, 0);
  const riskPathContextTotal = risks.reduce((total, risk) => total + risk.pathContextTotal, 0);
  const commandCandidates = input.commandTranscripts ?? [];
  const exactCommandCandidates = commandCandidates
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => promptExactConversationReviewText(command.id, 300) === command.id);
  const commandIdCounts = new Map<string, number>();
  for (const { command } of exactCommandCandidates) {
    commandIdCounts.set(command.id, (commandIdCounts.get(command.id) ?? 0) + 1);
  }
  const commands = exactCommandCandidates
    .filter(({ command }) => commandIdCounts.get(command.id) === 1)
    .sort((left, right) =>
      Number(conversationReviewTranscriptIsCurrent(right.command, input.headSha)) -
        Number(conversationReviewTranscriptIsCurrent(left.command, input.headSha)) ||
      left.index - right.index
    )
    .slice(0, MAX_COMMANDS)
    .map(({ command }) => command);
  const commandContextTruncated = commands.length < commandCandidates.length;
  const requirementSet = new Set(requirementIds);
  const requirementOrder = new Map(requirementIds.map((id, index) => [id, index]));
  const coverageCandidates = (input.coverage?.deltas ?? [])
    .map((delta, index) => ({ delta, index, id: delta.acai_id ?? delta.requirement_id }))
    .filter(({ id }) => requirementSet.has(id))
    .sort((left, right) =>
      (requirementOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (requirementOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      left.index - right.index
    )
    .slice(0, MAX_COVERAGE_DELTAS);
  const scopeFacts: ConversationReviewPromptEvidenceContext["scopeFacts"] = {
    outOfScopeChangedFiles: (input.scope?.out_of_scope_changed_files ?? [])
      .filter((file) => diff.paths.includes(file.path))
      .map((file) => file.path)
      .slice(0, MAX_DIFF_FILES),
    ...(input.coverage ? {
      coverage: {
        baseAvailable: input.coverage.base_available,
        counts: input.coverage.counts,
        deltas: coverageCandidates
          .map(({ delta }) => ({
            requirementId: delta.acai_id ?? delta.requirement_id,
            ...(delta.base_status ? { baseStatus: delta.base_status } : {}),
            headStatus: delta.head_status,
            delta: delta.delta
          }))
      }
    } : {})
  };
  const blocked = diff.blocked ||
    isBlockingConversationReviewPromptValue(JSON.stringify(analysis)) ||
    eventIds.some(isBlockingConversationReviewPromptValue) ||
    requirementIds.some(isBlockingConversationReviewPromptValue) ||
    risks.some((risk) =>
      [risk.candidate.id, risk.candidate.rule, risk.candidate.summary, ...risk.paths]
        .some(isBlockingConversationReviewPromptValue)
    ) ||
    commands.some((command) =>
      command.secret_blocked === true ||
      [command.id, command.command, command.stdout_excerpt, command.stderr_excerpt]
        .some((value) => typeof value === "string" && isBlockingConversationReviewPromptValue(value))
    );
  return {
    diff,
    eventIds,
    positiveIntentEventIds,
    prohibitionEventIds,
    requirementIds,
    risks,
    commands,
    commandContextTruncated,
    commandContextTotal: commandCandidates.length,
    requirementContextTruncated: requirementIds.length < requirementCandidates.length,
    requirementContextTotal: requirementCandidates.length,
    riskContextTruncated: risks.length < riskCandidates.length,
    riskContextTotal: riskCandidates.length,
    riskPathContextTruncated: risks.some((risk) => risk.pathContextTruncated),
    riskPathContextIncluded,
    riskPathContextTotal,
    coverageDeltaContextTruncated: coverageCandidates.length < (input.coverage?.deltas.length ?? 0),
    coverageDeltaContextTotal: input.coverage?.deltas.length ?? 0,
    scopeFacts,
    blocked
  };
}

function buildPromptRiskContext(
  candidate: ConversationReviewRiskCandidate
): ConversationReviewPromptRiskContext {
  const deterministicEvidence = candidate.evidence.filter((ref) =>
    ref.llm_proposed !== true && ref.validation_status !== "invalid"
  );
  const allPaths = uniqueTruthy(deterministicEvidence.flatMap((ref) =>
    typeof ref.path === "string" ? [ref.path] : []
  )).sort(compareStrings);
  const paths = allPaths
    .filter((path) => promptExactConversationReviewText(path, 300) === path)
    .slice(0, MAX_RISK_PATHS_PER_RISK);
  const visiblePaths = new Set(paths);
  return {
    candidate,
    paths,
    visibleEvidence: deterministicEvidence.filter((ref) =>
      typeof ref.path !== "string" || visiblePaths.has(ref.path)
    ),
    pathContextTruncated: paths.length < allPaths.length,
    pathContextTotal: allPaths.length
  };
}

function earliestTargetEvents(
  events: ConversationEvent[],
  targetEventIds: Set<string>
): ConversationEvent[] {
  if (conversationEventOrderIsMonotonic(events)) {
    const resolved = new Set<string>();
    const selected: ConversationEvent[] = [];
    for (const event of events) {
      if (!targetEventIds.has(event.id) || resolved.has(event.id)) {
        continue;
      }
      resolved.add(event.id);
      selected.push(event);
      if (resolved.size === targetEventIds.size) {
        break;
      }
    }
    return selected;
  }

  const earliest = new Map<string, ConversationEvent>();
  for (const event of events) {
    if (!targetEventIds.has(event.id)) {
      continue;
    }
    const current = earliest.get(event.id);
    if (!current || compareConversationEvents(event, current) < 0) {
      earliest.set(event.id, event);
    }
  }
  return [...earliest.values()].sort(compareConversationEvents);
}

function knownRequirementIds(input: BuildConversationReviewInput): string[] {
  return uniqueTruthy([
    ...(input.scope?.affected_requirements ?? []).flatMap((requirement) => [
      requirement.requirement_id,
      ...(requirement.acai_id ? [requirement.acai_id] : [])
    ]),
    ...(input.requirementIds ?? [])
  ]).filter((id) => promptExactConversationReviewText(id, 300) === id);
}

function conversationAnalysisEventIds(analysis: ConversationAnalysis): string[] {
  return uniqueTruthy(CONVERSATION_ANALYSIS_SECTIONS
    .flatMap((section) => analysis[section])
    .flatMap((item) => item.event_ids));
}

function conversationPositiveIntentEventIds(analysis: ConversationAnalysis): string[] {
  return uniqueTruthy([
    ...analysis.intent,
    ...analysis.refinements,
    ...analysis.decisions,
    ...analysis.constraints
  ].flatMap((item) => item.event_ids));
}

function conversationProhibitionEventIds(analysis: ConversationAnalysis): string[] {
  return uniqueTruthy([
    ...analysis.non_goals,
    ...analysis.rejected_alternatives
  ].flatMap((item) => item.event_ids));
}

export function conversationReviewTranscriptIsCurrent(
  transcript: CommandTranscript | undefined,
  headSha: string | undefined
): boolean {
  if (!transcript || transcript.status === "unknown") {
    return false;
  }
  return Boolean(headSha && transcript.head_sha && transcript.head_sha === headSha);
}

export function boundedConversationReviewText(value: string, limit: number): string {
  return safeConversationReviewPromptText(value, limit).text;
}

function promptExactConversationReviewText(value: string, limit: number): string | undefined {
  const safe = safeConversationReviewPromptText(value, limit).text;
  return safe === value ? safe : undefined;
}

function safeConversationReviewPromptText(
  value: string,
  limit: number
): { text: string; blocked: boolean } {
  const redacted = inspectAndRedactSecrets(value);
  return {
    text: redacted.text.slice(0, limit),
    blocked: redacted.blocked
  };
}

function isBlockingConversationReviewPromptValue(value: string): boolean {
  return containsBlockingSecretMaterial(value);
}
