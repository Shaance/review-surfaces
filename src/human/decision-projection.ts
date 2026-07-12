import crypto from "node:crypto";
import type { ConversationAnalysis } from "../contracts/conversation-review";
import type { EvidenceRef } from "../contracts/evidence";
import { uniqueEvidenceRefs } from "../evidence/evidence";
import type { PrReviewSurfaceModel, PrRiskCandidate } from "../contracts/pr-review";
import type { ReviewPacket } from "../render/packet";
import { isBreakingSchemaChange, type SemanticChangeFacts } from "../risks/semantic-diff";
import type {
  DecisionFinding,
  DecisionProjection,
  HumanReviewPriority,
  ReviewBlocker,
  ReviewQueueItem
} from "./contract";
import { currentValidationRunState, decisionRootForApiChange, decisionRootForRisk, isDecisionScopedEvidenceRef, type DecisionScope } from "./decision-admission";

const MAX_DECISION_FINDINGS = 3;
const MAX_DECISION_STRING_ITEMS = 24;
const MAX_DECISION_ID_LENGTH = 1000;

export interface BuildDecisionProjectionInput {
  packet: ReviewPacket;
  prSurface?: PrReviewSurfaceModel;
  conversationAnalysis?: ConversationAnalysis;
  scope: DecisionScope;
  reviewQueue: ReviewQueueItem[];
  blockers: ReviewBlocker[];
  semanticFacts: SemanticChangeFacts;
}

type FindingDraft = Omit<DecisionFinding, "id">;

export function buildDecisionProjection(input: BuildDecisionProjectionInput): DecisionProjection {
  const drafts = [
    ...blockerDrafts(input),
    ...validationRunStateDrafts(input),
    ...queueDrafts(input)
  ];
  const merged = mergeRootCauses(drafts)
    .sort(compareFindingDrafts)
    .slice(0, MAX_DECISION_FINDINGS)
    .map((finding, index) => ({
      id: `DECISION-${String(index + 1).padStart(3, "0")}`,
      ...finding
    }));
  const projectedQueueIds = new Set(merged.flatMap((finding) => finding.source_queue_ids));
  const complianceKeys = new Set(input.packet.evaluation.results.map((result) => result.acai_id ?? result.requirement_id));
  const affectedRequirementCount = [...complianceKeys].filter((key) => input.scope.affected_requirement_ids.has(key)).length;
  return {
    active_intent: activeIntent(input),
    findings: merged,
    supporting_detail_counts: {
      total_queue_items: input.reviewQueue.length,
      projected_queue_items: projectedQueueIds.size,
      supporting_queue_items: Math.max(0, input.reviewQueue.length - projectedQueueIds.size),
      affected_requirement_count: affectedRequirementCount,
      supporting_requirement_count: Math.max(0, complianceKeys.size - affectedRequirementCount)
    }
  };
}

function activeIntent(input: BuildDecisionProjectionInput): DecisionProjection["active_intent"] {
  // review-surfaces.REVIEWER_VALUE.9: real-session decision quality starts from
  // the cited local goal; provider enrichment and mechanical supporting facts
  // cannot replace the reviewer-facing intent or independently move approval.
  const affected = affectedRequirements(input);
  const conversationIntent = input.conversationAnalysis?.status === "analyzed"
    ? input.conversationAnalysis.intent[0]
    : undefined;
  if (conversationIntent) {
    const latestRefinement = input.conversationAnalysis?.refinements.at(-1);
    return {
      summary: summarizeConversationIntent(conversationIntent, latestRefinement, affected),
      source: "conversation_advisory",
      requirement_ids: uniqueStrings(affected.flatMap((requirement) =>
        [requirement.id, requirement.acai_id].filter((id): id is string => Boolean(id))
      )),
      event_ids: uniqueStrings([
        ...conversationIntent.event_ids,
        ...(latestRefinement?.event_ids ?? [])
      ])
    };
  }
  if (affected.length > 0) {
    return {
      summary: summarizeAffectedIntent(affected),
      source: "affected_requirements",
      requirement_ids: uniqueStrings(affected.flatMap((requirement) => [requirement.id, requirement.acai_id].filter((id): id is string => Boolean(id)))),
      event_ids: []
    };
  }
  return {
    summary: boundedText(input.packet.intent.summary, 2000, "Packet intent."),
    source: "packet",
    requirement_ids: [],
    event_ids: []
  };
}

function affectedRequirements(input: BuildDecisionProjectionInput): ReviewPacket["intent"]["requirements"] {
  return input.packet.intent.requirements.filter((requirement) =>
    input.scope.affected_requirement_ids.has(requirement.id) ||
    (requirement.acai_id !== undefined && input.scope.affected_requirement_ids.has(requirement.acai_id))
  );
}

function blockerDrafts(input: BuildDecisionProjectionInput): FindingDraft[] {
  return input.blockers.flatMap((blocker) => {
    const risk = matchingPrRisk(input.prSurface, blocker.id);
    const path = firstChangedPath(input.scope, blocker.evidence) ?? firstChangedPath(input.scope, risk?.evidence ?? []);
    const evidence = eligibleEvidence(
      input.scope,
      [...blocker.evidence, ...(risk?.evidence ?? [])],
      blocker.id === "BLOCK-TESTS-001"
    );
    if (evidence.length === 0) return [];
    return [{
      root_cause: (risk && path && decisionRootForRisk(risk.rule, path)) || blockerRootCause(blocker.id, path),
      title: blocker.summary,
      path,
      priority: "blocker",
      reason: blocker.summary,
      reviewer_action: blocker.required_action,
      evidence,
      requirement_ids: uniqueStrings([
        ...requirementIds(blocker.evidence),
        ...requirementIds(risk?.evidence ?? [])
      ]),
      risk_ids: risk ? [risk.id] : [],
      source_queue_ids: [],
    }];
  });
}

function queueDrafts(input: BuildDecisionProjectionInput): FindingDraft[] {
  return input.reviewQueue.flatMap((item) => {
    const root = queueRoot(input, item);
    if (!root) return [];
    const evidence = eligibleEvidence(input.scope, item.evidence);
    if (evidence.length === 0) return [];
    return [{
      root_cause: root,
      title: item.title,
      path: item.path,
      priority: item.priority,
      reason: item.reason,
      reviewer_action: item.reviewer_action,
      evidence,
      requirement_ids: item.requirement_ids,
      risk_ids: item.risk_ids,
      source_queue_ids: [item.id],
    }];
  });
}

function validationRunStateDrafts(input: BuildDecisionProjectionInput): FindingDraft[] {
  return input.packet.risks.test_evidence.flatMap((item) => {
    const { state, evidence: currentEvidence } = currentValidationRunState(input.scope, item);
    if (state !== "failed" && state !== "skipped") return [];
    const evidence = eligibleEvidence(
      input.scope,
      currentEvidence,
      true
    );
    if (evidence.length === 0) return [];
    return [{
      root_cause: "test_integrity",
      title: state === "failed" ? "Validation failed" : "Validation was skipped",
      priority: "high",
      reason: item.summary,
      reviewer_action: state === "failed"
        ? "Fix the current-head validation failure before approval."
        : "Run the skipped validation or record why it is safe to defer before approval.",
      evidence,
      requirement_ids: uniqueStrings(item.requirement_ids ?? []),
      risk_ids: [item.id],
      source_queue_ids: [],
    }];
  });
}

function queueRoot(input: BuildDecisionProjectionInput, item: ReviewQueueItem): string | undefined {
  if (input.scope.mode === "pr" && !input.scope.changed_paths.has(item.path)) return undefined;
  const prRisk = input.prSurface?.risks.candidates.find((risk) => item.risk_ids.includes(risk.id));
  if (prRisk) {
    const riskRoot = decisionRootForRisk(prRisk.rule, item.path);
    if (riskRoot) return riskRoot;
  }

  // Packet risks predate the PR-risk candidate model, but a medium-or-higher
  // packet risk with evidence on a changed path is still an approval-changing
  // range fact. Keep it admitted under a stable category/path root so duplicate
  // manifestations collapse without allowing repository-wide aggregates into
  // the decision projection.
  const packetRisk = input.packet.risks.items.find((risk) => item.risk_ids.includes(risk.id));
  if (packetRisk && (item.priority === "blocker" || item.priority === "high" || item.priority === "medium")) {
    const aggregateIsAffected = !/^RISK-\d+$/u.test(packetRisk.id) || (packetRisk.evidence ?? []).some((ref) =>
      ref.acai_id !== undefined && input.scope.affected_requirement_ids.has(ref.acai_id)
    );
    if (!aggregateIsAffected) return undefined;
    return `packet_risk:${packetRisk.category}:${item.path}`;
  }

  const schema = input.semanticFacts.schema_changes.find((change) => change.path === item.path);
  if (schema && isBreakingSchemaChange(schema)) return `persisted_contract:${item.path}`;

  const api = input.semanticFacts.api_changes.find((change) => change.path === item.path);
  const apiRoot = api ? decisionRootForApiChange(api) : undefined;
  if (apiRoot) return apiRoot;

  const weakening = input.semanticFacts.test_weakening.find((signal) => signal.path === item.path);
  if (weakening) return `test_integrity:${item.path}`;
  if (/import cycle created/i.test(item.title)) return `architecture_cycle:${item.path}`;
  return undefined;
}

function matchingPrRisk(surface: PrReviewSurfaceModel | undefined, blockerId: string): PrRiskCandidate | undefined {
  return surface?.risks.candidates.find((risk) => blockerId === `BLOCK-${risk.id}`);
}

function blockerRootCause(fallback: string, path: string | undefined): string {
  const suffix = path ? `:${path}` : "";
  if (fallback.startsWith("BLOCK-SCHEMA-")) return `persisted_contract${suffix}`;
  if (fallback === "BLOCK-TESTS-001") return "test_integrity";
  if (fallback.includes("PRIVACY") || fallback.includes("SECRET")) return `secret_boundary${suffix}`;
  return `merge_gate:${fallback.toLowerCase()}${suffix}`;
}

function mergeRootCauses(drafts: FindingDraft[]): FindingDraft[] {
  const merged = new Map<string, FindingDraft>();
  for (const draft of drafts) {
    const rootCause = boundedRootCause(draft.root_cause);
    const normalizedDraft: FindingDraft = {
      ...draft,
      root_cause: rootCause,
      title: boundedText(draft.title, 500, "Review finding"),
      ...(draft.path ? { path: boundedText(draft.path, 1000, "unknown") } : {}),
      reason: boundedText(draft.reason, 2000, "Review evidence requires attention."),
      reviewer_action: boundedText(draft.reviewer_action, 2000, "Review this finding before approval."),
      requirement_ids: uniqueStrings(draft.requirement_ids),
      risk_ids: uniqueStrings(draft.risk_ids),
      source_queue_ids: uniqueStrings(draft.source_queue_ids)
    };
    const current = merged.get(rootCause);
    if (!current) {
      merged.set(rootCause, normalizedDraft);
      continue;
    }
    const stronger = priorityRank(normalizedDraft.priority) < priorityRank(current.priority) ? normalizedDraft : current;
    merged.set(rootCause, {
      ...stronger,
      evidence: uniqueEvidenceRefs([...current.evidence, ...normalizedDraft.evidence]).slice(0, 6),
      requirement_ids: uniqueStrings([...current.requirement_ids, ...normalizedDraft.requirement_ids]),
      risk_ids: uniqueStrings([...current.risk_ids, ...normalizedDraft.risk_ids]),
      source_queue_ids: uniqueStrings([...current.source_queue_ids, ...normalizedDraft.source_queue_ids]),
    });
  }
  return [...merged.values()];
}

function compareFindingDrafts(left: FindingDraft, right: FindingDraft): number {
  return priorityRank(left.priority) - priorityRank(right.priority) || left.root_cause.localeCompare(right.root_cause);
}

function priorityRank(priority: HumanReviewPriority): number {
  return { blocker: 0, high: 1, medium: 2, low: 3 }[priority];
}

function eligibleEvidence(scope: DecisionScope, evidence: readonly EvidenceRef[], allowInvalidOutcome = false): EvidenceRef[] {
  const valid = evidence.filter((ref) =>
    (allowInvalidOutcome || ref.validation_status !== "invalid") && ref.llm_proposed !== true
  );
  return uniqueEvidenceRefs(valid.filter((ref) => isDecisionScopedEvidenceRef(scope, ref))).slice(0, 6);
}

function firstChangedPath(scope: DecisionScope, evidence: readonly EvidenceRef[]): string | undefined {
  return evidence.find((ref) => ref.path !== undefined && scope.changed_paths.has(ref.path))?.path;
}

function requirementIds(evidence: readonly EvidenceRef[]): string[] {
  return uniqueStrings(evidence.map((ref) => ref.acai_id).filter((id): id is string => Boolean(id)));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => boundedText(value, MAX_DECISION_ID_LENGTH, "unknown")))]
    .sort()
    .slice(0, MAX_DECISION_STRING_ITEMS);
}

function boundedText(value: string, maxLength: number, fallback: string): string {
  const normalized = value.trim() || fallback;
  if (normalized.length <= maxLength) return normalized;
  const candidate = normalized.slice(0, maxLength - 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  return `${wordBoundary >= Math.floor(maxLength * 0.6) ? candidate.slice(0, wordBoundary) : candidate}…`;
}

function summarizeAffectedIntent(requirements: ReviewPacket["intent"]["requirements"]): string {
  if (requirements.length === 1) {
    const requirement = requirements[0];
    const text = boundedText(requirement.requirement.replace(/\s+/gu, " "), 500, "Affected requirement intent.");
    const id = boundedText(requirement.acai_id ?? requirement.id, MAX_DECISION_ID_LENGTH, "unknown");
    return boundedText(`${text.replace(/[.!?]+$/u, "")} [${id}]`, 2000, "Affected requirement intent.");
  }
  const areas = [...new Map(requirements.map((requirement) => {
    const acid = requirement.acai_id ?? requirement.id;
    const group = acid.replace(/\.\d+$/u, "");
    const title = requirement.title?.trim() || group;
    return [group, `${title} (${group})`];
  })).values()];
  const visible = areas.slice(0, 3);
  const omitted = areas.length - visible.length;
  const suffix = omitted > 0 ? ` (+${omitted} more area${omitted === 1 ? "" : "s"})` : "";
  return boundedText(
    `Reviewed change affects ${requirements.length} requirement(s) across ${visible.join(", ")}${suffix}.`,
    900,
    "Affected requirement intent."
  );
}

function summarizeConversationIntent(
  statedGoal: NonNullable<ConversationAnalysis>["intent"][number],
  latestRefinement: NonNullable<ConversationAnalysis>["refinements"][number] | undefined,
  affected: ReviewPacket["intent"]["requirements"]
): string {
  const goal = boundedText(statedGoal.text, 360, "Conversation goal.");
  const refinement = latestRefinement && latestRefinement.text.trim() !== statedGoal.text.trim()
    ? ` Latest direction: ${boundedText(latestRefinement.text, 220, "Conversation refinement.")}`
    : "";
  const acids = uniqueStrings(affected.map((requirement) => requirement.acai_id ?? requirement.id));
  const requirementContext = acids.length > 0
    ? ` Affected requirements: ${acids.slice(0, 3).join(", ")}${acids.length > 3 ? ` (+${acids.length - 3} more)` : ""}.`
    : "";
  return boundedText(`Reviewer goal: ${goal}${refinement}${requirementContext}`, 900, "Conversation-backed active intent.");
}

function boundedRootCause(value: string): string {
  if (value.length <= 500) return value;
  const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${value.slice(0, 483)}:${digest}`;
}
