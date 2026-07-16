import crypto from "node:crypto";
import type { ConversationAnalysis } from "../contracts/conversation-review";
import type { EvidenceRef } from "../contracts/evidence";
import { uniqueEvidenceRefs } from "../evidence/evidence";
import type { PrReviewSurfaceModel, PrRiskCandidate } from "../contracts/pr-review";
import type { ReviewPacket } from "../render/packet";
import type { SemanticChangeFacts } from "../risks/semantic-diff";
import type {
  DecisionFinding,
  DecisionProjection,
  HumanReviewPriority,
  ReviewBlocker,
  ReviewQueueItem
} from "./contract";
import {
  currentValidationRunState,
  decisionRootForApiChange,
  decisionRootForRisk,
  isDecisionScopedEvidenceRef,
  schemaChangeDisposition,
  type DecisionScope
} from "./decision-admission";

const MAX_DECISION_STRING_ITEMS = 24;
const MAX_DECISION_ID_LENGTH = 1000;
const REVIEW_ARTIFACT_SCHEMA_PATHS = new Set([
  "schemas/human_review.schema.json",
  "schemas/pr_review_surface.schema.json"
]);

export interface BuildDecisionProjectionInput {
  packet: ReviewPacket;
  prSurface?: PrReviewSurfaceModel;
  conversationAnalysis?: ConversationAnalysis;
  scope: DecisionScope;
  reviewQueue: ReviewQueueItem[];
  /** Internal exact queue-to-semantic-root association from queue ranking. */
  queueDecisionRoots?: ReadonlyMap<string, string>;
  blockers: ReviewBlocker[];
  semanticFacts: SemanticChangeFacts;
}

type FindingDraft = Omit<DecisionFinding, "id">;

interface OrderedRisk<T> {
  risk: T;
  order: number;
}

interface DecisionProjectionIndex {
  prRisksById: ReadonlyMap<string, OrderedRisk<PrRiskCandidate>>;
  prRisksByBlockerId: ReadonlyMap<string, PrRiskCandidate>;
  packetRisksById: ReadonlyMap<string, OrderedRisk<ReviewPacket["risks"]["items"][number]>>;
  apiRootsByPath: ReadonlyMap<string, string[]>;
  changedAreasByPath: ReadonlyMap<string, readonly string[]>;
  schemaDispositionByPath: Map<string, ReturnType<typeof schemaChangeDisposition>>;
}

export function buildDecisionProjection(input: BuildDecisionProjectionInput): DecisionProjection {
  const index = buildDecisionProjectionIndex(input);
  const drafts = [
    ...blockerDrafts(input, index),
    ...validationRunStateDrafts(input),
    ...queueDrafts(input, index)
  ];
  const merged = mergeRootCauses(drafts)
    .sort(compareFindingDrafts)
    .map((finding, index) => ({
      id: `DECISION-${String(index + 1).padStart(3, "0")}`,
      ...finding
    }));
  return {
    active_intent: activeIntent(input),
    findings: merged
  };
}

function buildDecisionProjectionIndex(input: BuildDecisionProjectionInput): DecisionProjectionIndex {
  const prRisksById = new Map<string, OrderedRisk<PrRiskCandidate>>();
  const prRisksByBlockerId = new Map<string, PrRiskCandidate>();
  for (const [order, risk] of (input.prSurface?.risks.candidates ?? []).entries()) {
    if (!prRisksById.has(risk.id)) prRisksById.set(risk.id, { risk, order });
    const blockerId = `BLOCK-${risk.id}`;
    if (!prRisksByBlockerId.has(blockerId)) prRisksByBlockerId.set(blockerId, risk);
  }
  const packetRisksById = new Map<string, OrderedRisk<ReviewPacket["risks"]["items"][number]>>();
  for (const [order, risk] of input.packet.risks.items.entries()) {
    if (!packetRisksById.has(risk.id)) packetRisksById.set(risk.id, { risk, order });
  }
  const apiRootDraftsByPath = new Map<string, string[]>();
  for (const change of input.semanticFacts.api_changes) {
    const root = decisionRootForApiChange(change);
    if (!root) continue;
    const roots = apiRootDraftsByPath.get(change.path);
    if (roots) roots.push(root);
    else apiRootDraftsByPath.set(change.path, [root]);
  }
  const apiRootsByPath = new Map<string, string[]>();
  for (const [filePath, roots] of apiRootDraftsByPath) {
    apiRootsByPath.set(filePath, uniqueStrings(roots));
  }
  const changedAreasByPath = new Map<string, readonly string[]>();
  for (const file of input.prSurface?.scope.changed_files ?? []) {
    if (!changedAreasByPath.has(file.path)) changedAreasByPath.set(file.path, file.areas);
  }
  return {
    prRisksById,
    prRisksByBlockerId,
    packetRisksById,
    apiRootsByPath,
    changedAreasByPath,
    schemaDispositionByPath: new Map()
  };
}

function activeIntent(input: BuildDecisionProjectionInput): DecisionProjection["active_intent"] {
  // review-surfaces.REVIEWER_VALUE.9: real-session decision quality starts from
  // the cited local goal; provider enrichment and mechanical supporting facts
  // cannot replace the reviewer-facing intent or independently move approval.
  const affected = affectedRequirements(input);
  const changeContext = input.prSurface?.change_context;
  if (changeContext?.title) {
    return {
      summary: summarizeChangeContext(changeContext.title, changeContext.description),
      source: "pull_request",
      redaction_blocked: changeContext.redaction_blocked === true,
      requirement_ids: uniqueStrings(affected.flatMap((requirement) =>
        [requirement.id, requirement.acai_id].filter((id): id is string => Boolean(id))
      )),
      event_ids: []
    };
  }
  const conversationIntent = input.conversationAnalysis?.status === "analyzed"
    ? input.conversationAnalysis.intent[0]
    : undefined;
  if (conversationIntent) {
    const latestRefinement = input.conversationAnalysis?.refinements.at(-1);
    return {
      summary: summarizeConversationIntent(conversationIntent, latestRefinement, affected),
      source: "conversation_advisory",
      redaction_blocked: false,
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
    const totalRequirements = input.packet.intent.requirements.length;
    const areas = summarizeRequirementAreas(affected);
    const affectedShare = totalRequirements > 0 ? affected.length / totalRequirements : 0;
    const broadScope = affected.length >= 3 && (areas.length >= 3 || affectedShare >= 0.25);
    if (broadScope) {
      const milestone = input.packet.agent_handoff?.current_milestone?.trim();
      const visibleAreas = areas.slice(0, 3).map(({ label }) => label);
      const omittedAreas = Math.max(0, areas.length - visibleAreas.length);
      const areaSuffix = omittedAreas > 0 ? ` (+${omittedAreas} more)` : "";
      const goal = input.packet.intent.summary.trim() || "Review the changed behavior.";
      const milestoneContext = milestone ? ` Current milestone: ${milestone}.` : "";
      return {
        summary: boundedText(
          `${goal}${milestoneContext} Affected areas: ${visibleAreas.join(", ")}${areaSuffix}. Scope: ${affected.length} of ${totalRequirements} requirements are affected.`,
          2000,
          "Packet intent."
        ),
        source: "packet",
        redaction_blocked: false,
        requirement_ids: uniqueStrings(affected.flatMap((requirement) => [requirement.id, requirement.acai_id].filter((id): id is string => Boolean(id)))),
        event_ids: []
      };
    }
    return {
      summary: summarizeAffectedIntent(affected),
      source: "affected_requirements",
      redaction_blocked: false,
      requirement_ids: uniqueStrings(affected.flatMap((requirement) => [requirement.id, requirement.acai_id].filter((id): id is string => Boolean(id)))),
      event_ids: []
    };
  }
  return {
    summary: boundedText(input.packet.intent.summary, 2000, "Packet intent."),
    source: "packet",
    redaction_blocked: false,
    requirement_ids: [],
    event_ids: []
  };
}

function summarizeChangeContext(title: string, description: string | undefined): string {
  const normalizedTitle = title.trim();
  if (!description?.trim()) return boundedText(normalizedTitle, 2000, "Change purpose unavailable.");
  // PR templates commonly begin with hidden instructions and sections such as
  // Testing or Screenshots. Neither is the author's change purpose. Strip
  // template comments, prefer an explicitly named purpose section, and only use
  // unheaded leading prose otherwise.
  const lines = description.replace(/<!--[\s\S]*?-->/gu, "").split(/\r?\n/u);
  const summaryHeading = lines.findIndex((line) =>
    /^#{1,6}\s*(summary|overview|what changed|description|purpose)\s*[:\-\u2013\u2014]?\s*$/iu.test(line.trim())
  );
  const firstHeading = lines.findIndex((line) => /^#{1,6}\s+/u.test(line.trim()));
  const candidateLines = summaryHeading >= 0
    ? lines.slice(summaryHeading + 1)
    : lines.slice(0, firstHeading >= 0 ? firstHeading : lines.length);
  const selected: string[] = [];
  for (const line of candidateLines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/u.test(trimmed)) break;
    if (!trimmed) continue;
    selected.push(trimmed.replace(/^[-*+]\s+/u, ""));
  }
  const detail = selected.join(" ").trim();
  return boundedText(detail ? `${normalizedTitle}. ${detail}` : normalizedTitle, 2000, normalizedTitle || "Change purpose unavailable.");
}

function summarizeRequirementAreas(requirements: ReviewPacket["intent"]["requirements"]): Array<{ label: string; count: number; key: string }> {
  const areas = new Map<string, { label: string; count: number; key: string }>();
  for (const requirement of requirements) {
    const acid = requirement.acai_id ?? requirement.id;
    const key = acid.replace(/\.\d+$/u, "");
    const existing = areas.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      areas.set(key, { label: requirement.title?.trim() || key, count: 1, key });
    }
  }
  return [...areas.values()].sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function affectedRequirements(input: BuildDecisionProjectionInput): ReviewPacket["intent"]["requirements"] {
  return input.packet.intent.requirements.filter((requirement) =>
    input.scope.affected_requirement_ids.has(requirement.id) ||
    (requirement.acai_id !== undefined && input.scope.affected_requirement_ids.has(requirement.acai_id))
  );
}

function blockerDrafts(input: BuildDecisionProjectionInput, index: DecisionProjectionIndex): FindingDraft[] {
  return input.blockers.flatMap((blocker) => {
    const risk = index.prRisksByBlockerId.get(blocker.id);
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
    }];
  });
}

function queueDrafts(input: BuildDecisionProjectionInput, index: DecisionProjectionIndex): FindingDraft[] {
  return input.reviewQueue.flatMap((item) => {
    const root = queueRoot(input, item, index);
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
    }];
  });
}

function queueRoot(
  input: BuildDecisionProjectionInput,
  item: ReviewQueueItem,
  index: DecisionProjectionIndex
): string | undefined {
  if (input.scope.mode === "pr" && !input.scope.changed_paths.has(item.path)) return undefined;
  const exactSemanticRoot = input.queueDecisionRoots?.get(item.id);
  if (exactSemanticRoot) return exactSemanticRoot;
  const prRisk = firstRiskInSourceOrder(item.risk_ids, index.prRisksById);
  if (prRisk) {
    if (prRisk.rule === "schema_contract_change") {
      if (schemaDispositionForPath(input, index, item.path) === "additive") return undefined;
    }
    const riskRoot = prRisk.rule === "untested_changed_impl"
      ? testCoverageRoot(index, item.path)
      : decisionRootForRisk(prRisk.rule, item.path);
    if (riskRoot) {
      return riskRoot.startsWith("persisted_contract:")
        ? persistedContractRoot(item.path)
        : riskRoot;
    }
  }

  // Packet risks predate the PR-risk candidate model, but a medium-or-higher
  // concrete packet risk with evidence on a changed path can still be an
  // approval-changing range fact. Built-in RISK-NNN rows are exhaustive
  // repository rollups: a bounded evidence sample touching this range does not
  // turn the aggregate count into a PR fact.
  const packetRisk = firstRiskInSourceOrder(item.risk_ids, index.packetRisksById);
  if (packetRisk && (item.priority === "blocker" || item.priority === "high" || item.priority === "medium")) {
    if (/^RISK-\d+$/u.test(packetRisk.id)) return undefined;
    return `packet_risk:${packetRisk.category}:${item.path}`;
  }

  if (schemaDispositionForPath(input, index, item.path) === "breaking") {
    return persistedContractRoot(item.path);
  }

  const apiRoots = index.apiRootsByPath.get(item.path) ?? [];
  // A path-only queue row may support a single public-contract root. When
  // several independent contracts share package.json, guessing the first one
  // would merge unrelated decisions; exact semantic rows use the queue map.
  if (apiRoots.length === 1) return apiRoots[0];

  // Test-weakening heuristics are useful review evidence, but they do not ask
  // the reviewer to approve an independent product or contract choice.
  if (/import cycle created/i.test(item.title)) return `architecture_cycle:${item.path}`;
  return undefined;
}

function firstRiskInSourceOrder<T>(ids: readonly string[], risksById: ReadonlyMap<string, OrderedRisk<T>>): T | undefined {
  let selected: OrderedRisk<T> | undefined;
  for (const id of ids) {
    const candidate = risksById.get(id);
    if (candidate && (!selected || candidate.order < selected.order)) selected = candidate;
  }
  return selected?.risk;
}

function schemaDispositionForPath(
  input: BuildDecisionProjectionInput,
  index: DecisionProjectionIndex,
  filePath: string
): ReturnType<typeof schemaChangeDisposition> {
  const cached = index.schemaDispositionByPath.get(filePath);
  if (cached) return cached;
  const disposition = schemaChangeDisposition([filePath], input.semanticFacts.schema_changes);
  index.schemaDispositionByPath.set(filePath, disposition);
  return disposition;
}

function blockerRootCause(fallback: string, path: string | undefined): string {
  const suffix = path ? `:${path}` : "";
  if (fallback.startsWith("BLOCK-SCHEMA-")) return path ? persistedContractRoot(path) : `persisted_contract${suffix}`;
  if (fallback === "BLOCK-TESTS-001") return "test_integrity";
  if (fallback.includes("PRIVACY") || fallback.includes("SECRET")) return `secret_boundary${suffix}`;
  return `merge_gate:${fallback.toLowerCase()}${suffix}`;
}

function mergeRootCauses(drafts: FindingDraft[]): FindingDraft[] {
  const merged = new Map<string, {
    representative: FindingDraft;
    evidence: EvidenceRef[];
    requirementIds: string[];
    riskIds: string[];
  }>();
  for (const draft of drafts) {
    const rootCause = boundedRootCause(draft.root_cause);
    const normalizedDraft: FindingDraft = {
      ...draft,
      root_cause: rootCause,
      title: boundedText(draft.title, 500, "Review finding"),
      ...(draft.path ? { path: boundedText(draft.path, 1000, "unknown") } : {}),
      reason: boundedText(withoutInlineCodeMarkup(draft.reason), 2000, "Review evidence requires attention."),
      reviewer_action: boundedText(withoutInlineCodeMarkup(draft.reviewer_action), 2000, "Review this finding before approval."),
      requirement_ids: uniqueStrings(draft.requirement_ids),
      risk_ids: uniqueStrings(draft.risk_ids)
    };
    const current = merged.get(rootCause);
    if (!current) {
      merged.set(rootCause, {
        representative: normalizedDraft,
        evidence: [...normalizedDraft.evidence],
        requirementIds: [...normalizedDraft.requirement_ids],
        riskIds: [...normalizedDraft.risk_ids]
      });
      continue;
    }
    if (priorityRank(normalizedDraft.priority) < priorityRank(current.representative.priority)) {
      current.representative = normalizedDraft;
    }
    appendAll(current.evidence, normalizedDraft.evidence);
    appendAll(current.requirementIds, normalizedDraft.requirement_ids);
    appendAll(current.riskIds, normalizedDraft.risk_ids);
  }
  return [...merged.values()].map((entry) => summarizeMergedDecision({
    ...entry.representative,
    evidence: uniqueEvidenceRefs(entry.evidence),
    requirement_ids: uniqueStrings(entry.requirementIds),
    risk_ids: uniqueStrings(entry.riskIds)
  }));
}

function appendAll<T>(target: T[], values: readonly T[]): void {
  for (const value of values) target.push(value);
}

function summarizeMergedDecision(finding: FindingDraft): FindingDraft {
  if (finding.root_cause === "review_surface") {
    const { path: _representativePath, ...withoutRepresentativePath } = finding;
    return {
      ...withoutRepresentativePath,
      title: "Reviewer brief contract",
      reason: "The reviewer-facing GitHub brief changes what people see first and how approval decisions are explained.",
      reviewer_action: "Confirm the brief states the change purpose, includes every independent approval decision once, and keeps diagnostics in supporting artifacts."
    };
  }
  if (finding.root_cause === "review_artifact_contract") {
    const { path: _representativePath, ...withoutRepresentativePath } = finding;
    return {
      ...withoutRepresentativePath,
      title: "Review artifact contract reset",
      reason: "The persisted PR facts and human reviewer brief change together as one saved review contract.",
      reviewer_action: "Confirm the reset is intentional and that the current producer, renderer, and workflow consume the new artifact pair together."
    };
  }
  if (finding.root_cause.startsWith("test_validation_area:") && changedImplementationEvidencePaths(finding).length > 1) {
    const { path: _representativePath, ...withoutRepresentativePath } = finding;
    const paths = changedImplementationEvidencePaths(finding);
    return {
      ...withoutRepresentativePath,
      title: "Current-head test evidence",
      reason: `${paths.length} changed implementation files share one unresolved validation question: the available evidence does not yet show that their behavior was exercised at the current head.`,
      reviewer_action: "Confirm the changed behavior is covered, add focused tests only where coverage is missing, and attach one current-head transcript for the relevant test run."
    };
  }
  if (finding.root_cause.startsWith("persisted_contract:")) {
    return {
      ...finding,
      title: `${persistedContractName(finding.root_cause)} artifact contract reset`,
      reason: "The saved reviewer artifact changes shape, so older artifacts or consumers may no longer validate.",
      reviewer_action: "Confirm the reset is intentional and that every supported producer and consumer ships with the new contract."
    };
  }
  return finding;
}

function testCoverageRoot(index: DecisionProjectionIndex, filePath: string): string {
  const areas = uniqueStrings(index.changedAreasByPath.get(filePath) ?? []).sort();
  if (areas.length > 0) return `test_validation_area:${areas.join("+")}`;
  const directory = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "(root)";
  return `test_validation_area:${directory}`;
}

function changedImplementationEvidencePaths(finding: FindingDraft): string[] {
  return uniqueStrings(finding.evidence
    .filter((ref) => ref.kind === "file")
    .map((ref) => ref.path)
    .filter((path): path is string => Boolean(path)));
}

function persistedContractRoot(path: string): string {
  return REVIEW_ARTIFACT_SCHEMA_PATHS.has(path) ? "review_artifact_contract" : `persisted_contract:${path}`;
}

function persistedContractName(rootCause: string): string {
  const contractPath = rootCause.slice("persisted_contract:".length);
  const filename = contractPath.split("/").at(-1) ?? "persisted";
  const stem = filename.replace(/\.schema\.json$/u, "").replace(/\.[^.]+$/u, "");
  const words = stem.split(/[-_]+/u).filter(Boolean).map((word) => word.toLowerCase() === "pr" ? "PR" : word.toLowerCase());
  if (words.length === 0) return "Persisted";
  if (words[0] !== "PR") words[0] = `${words[0][0]?.toUpperCase() ?? ""}${words[0].slice(1)}`;
  return words.join(" ");
}

function withoutInlineCodeMarkup(value: string): string {
  return value.replace(/`([^`]*)`/gu, "$1");
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
  return uniqueEvidenceRefs(valid.filter((ref) => isDecisionScopedEvidenceRef(scope, ref)));
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
