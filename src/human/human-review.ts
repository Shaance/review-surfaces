import { compareStrings } from "../core/compare";
import { globToRegExp } from "../core/glob";
import { stripUndefined, uniqueTruthy } from "../core/guards";
import { EvidenceRef, feedbackEvidence, fileEvidence, missingEvidence } from "../evidence/evidence";
import { normalizeEvidencePath } from "../evidence/validate";
import type { FeedbackFile } from "../feedback/feedback";
import { PrRiskCandidate, PrReviewSurfaceModel, StructuredDiff, StructuredDiffFile, StructuredDiffHunk } from "../pr/contract";
import { PR_RISK_RULE_METADATA } from "../pr/risk-metadata";
import { ReviewPacket } from "../render/packet";
import { looksLikeRecordedCiSecretBoundaryManualCheck } from "../risks/manual-checks";
import { RiskItem, RisksModel } from "../risks/risks";
import type { PacketConfidence, PacketSeverity } from "../schema/review-packet-contract";
import {
  HUMAN_REVIEW_SCHEMA_VERSION,
  FeedbackPolicyEffect,
  HumanReviewDecision,
  HumanReviewModel,
  HumanReviewPriority,
  HumanReviewVerdict,
  HumanReviewVerdictReason,
  InvalidEvidenceSummary,
  MissingEvidenceSummary,
  ReviewBlocker,
  ReviewerQuestion,
  SuggestedReviewComment,
  TestPlanItem,
  TrustAudit,
  TrustFact
} from "./contract";

export interface BuildHumanReviewInput {
  packet: ReviewPacket;
  prSurface?: PrReviewSurfaceModel;
  diff?: StructuredDiff;
  feedback?: FeedbackFile[];
  packetPath?: string;
  prSurfacePath?: string;
}

interface QueueDraft {
  title: string;
  path: string;
  old_path?: string;
  hunk_header?: string;
  line_start?: number;
  line_end?: number;
  reviewer_action: string;
  reason: string;
  evidence: EvidenceRef[];
  requirement_ids: string[];
  risk_ids: string[];
  confidence: PacketConfidence;
  priority: HumanReviewPriority;
  estimated_review_effort: "quick" | "moderate" | "deep";
  score: number;
  sortKey: string;
}

type TestPlanDraft = Omit<TestPlanItem, "id">;
type TestPlanDraftCore =
  Omit<TestPlanDraft, "maps_to_requirements" | "maps_to_risks" | "evidence_gap"> &
  Partial<Pick<TestPlanDraft, "maps_to_requirements" | "maps_to_risks" | "evidence_gap">>;
type RequirementGap = ReviewPacket["evaluation"]["results"][number];
type MissingAutomaticTestGap = NonNullable<RisksModel["missing_automatic_tests"]>[number];
type MissingManualCheckGap = NonNullable<RisksModel["missing_manual_checks"]>[number];
type PrChangedFile = PrReviewSurfaceModel["scope"]["changed_files"][number];
type TrustFactDraft = Omit<TrustFact, "id">;
type InvalidEvidenceDraft = Omit<InvalidEvidenceSummary, "id">;
type SuggestedCommentDraft = Omit<SuggestedReviewComment, "id">;
interface SuggestedCommentCandidate {
  draft: SuggestedCommentDraft;
  risk?: PrRiskCandidate;
  sourceRank: number;
  sortKey: string;
}
interface TestPlanCandidate {
  draft: TestPlanDraft;
  risk?: PrRiskCandidate;
  sourceRank: number;
  sortKey: string;
}
type FeedbackPolicyEffectDraft = Omit<FeedbackPolicyEffect, "id">;
interface ManualCheckRecord {
  text: string;
  evidence: EvidenceRef[];
}

const MAX_QUEUE = 20;
const MAX_BLOCKERS = 8;
const MAX_QUESTIONS = 10;
const MAX_COMMENTS = 10;
const MAX_TEST_PLAN = 12;
const MAX_TRUST_ITEMS = 10;
const MAX_FOCUSED_REQUIREMENT_TESTS = 6;
const MAX_CHANGED_FILE_QUEUE = 8;
const FEEDBACK_ACTION_DOWNGRADE_TO_LOW = "downgrade_to_low";
const FEEDBACK_ACTION_RETAIN_LOW_PRIORITY = "retain_low_priority";
const FEEDBACK_ACTION_PRIORITIZE_REVIEW_FOCUS = "prioritize_review_focus";
const RECORD_MANUAL_CHECK_PREFIX = "Record manual check:";
const MANUAL_CHECK_RECORDED_PREFIX = "Manual check recorded:";
const MANUAL_CHECK_TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "can",
  "check",
  "confirm",
  "from",
  "in",
  "is",
  "manual",
  "record",
  "recorded",
  "required",
  "that",
  "the",
  "to"
]);

export function buildHumanReview(input: BuildHumanReviewInput): HumanReviewModel {
  const feedbackEffects = buildFeedbackPolicyEffects(input);
  const blockers = buildBlockers(input, feedbackEffects);
  const reviewQueue = buildReviewQueue(input, feedbackEffects);
  const questions = buildQuestions(input, blockers, feedbackEffects);
  const suggestedComments = buildSuggestedComments(input, blockers);
  const trustAudit = buildTrustAudit(input);
  const testPlan = buildTestPlan(input, feedbackEffects);
  const skimSafe = buildSkimSafe(input, feedbackEffects);
  const verdict = buildVerdict(input, blockers, trustAudit);
  const generatedFrom = buildGeneratedFrom(input);

  return stripUndefined({
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: input.prSurface ? "pr" : "repo",
    verdict,
    summary: summarizeHumanReview(input, verdict, reviewQueue.length, blockers.length),
    review_queue: reviewQueue,
    blockers,
    questions,
    suggested_comments: suggestedComments,
    trust_audit: trustAudit,
    test_plan: testPlan,
    skim_safe: skimSafe,
    feedback_effects: feedbackEffects,
    generated_from: generatedFrom
  });
}

function buildGeneratedFrom(input: BuildHumanReviewInput): HumanReviewModel["generated_from"] {
  const manifest = input.packet.manifest as { base_ref?: unknown; head_ref?: unknown; head_sha?: unknown };
  const prScope = input.prSurface?.scope;
  return {
    packet_path: input.packetPath ?? ".review-surfaces/review_packet.json",
    pr_surface_path: input.prSurface ? input.prSurfacePath ?? ".review-surfaces/pr_review_surface.json" : undefined,
    base_ref: prScope?.base_ref ?? stringOr(manifest.base_ref, "origin/main"),
    head_ref: prScope?.head_ref ?? stringOr(manifest.head_ref, "HEAD"),
    head_sha: prScope?.head_sha ?? stringOr(manifest.head_sha, "unknown")
  };
}

function buildVerdict(input: BuildHumanReviewInput, blockers: ReviewBlocker[], trustAudit: TrustAudit): HumanReviewVerdict {
  const reasons: HumanReviewVerdictReason[] = [];
  let decision: HumanReviewDecision = "no_signal";

  for (const blocker of blockers) {
    reasons.push({
      id: blocker.id,
      severity: blocker.severity,
      summary: blocker.summary,
      evidence: blocker.evidence,
      required_action: blocker.required_action
    });
  }

  if (blockers.length > 0) {
    decision = "block_before_merge";
  } else if (input.prSurface?.status === "blocked") {
    decision = input.prSurface.blocked_reason === "no_diff" ? "no_signal" : "needs_author_clarification";
    reasons.push({
      id: "READY-PR-SURFACE-BLOCKED",
      severity: input.prSurface.blocked_reason === "no_diff" ? "low" : "medium",
      summary: `PR review surface is blocked (${input.prSurface.blocked_reason ?? "unknown"}).`,
      evidence: [missingEvidence("PR surface narrative is unavailable; deterministic scope is still available.")],
      required_action: "Regenerate the PR surface with the required provider or review deterministic facts locally."
    });
  } else if (trustAudit.missing_evidence.length > 0 || trustAudit.claimed_not_verified.length > 0) {
    decision = "needs_author_clarification";
    reasons.push({
      id: "READY-MISSING-EVIDENCE",
      severity: "medium",
      summary: "Required review evidence is missing or claimed without proof.",
      evidence: trustAudit.missing_evidence[0]?.evidence ?? [missingEvidence("Missing evidence lowers readiness confidence.")],
      required_action: "Record validation evidence or answer the generated reviewer questions."
    });
  } else if (hasRiskAtLeast(input, "medium")) {
    decision = "reviewable_with_attention";
    reasons.push({
      id: "READY-RISKS-PRESENT",
      severity: "medium",
      summary: "Reviewable risks remain and should guide the review path.",
      evidence: firstRiskEvidence(input),
      required_action: "Review the ranked queue before approving."
    });
  } else if (hasPositiveValidationEvidence(input.packet.risks)) {
    decision = "probably_safe";
    reasons.push({
      id: "READY-POSITIVE-EVIDENCE",
      severity: "low",
      summary: "No high-risk blockers were detected and validation evidence is present.",
      evidence: positiveValidationEvidence(input.packet.risks).slice(0, 3)
    });
  }

  if (reasons.length === 0) {
    reasons.push({
      id: "READY-NO-SIGNAL",
      severity: "unknown",
      summary: "Not enough review signal was available to make a readiness claim.",
      evidence: [missingEvidence("No PR surface, risk evidence, or validation evidence was available.")],
      required_action: "Generate a packet with diff and validation evidence."
    });
  }

  return {
    decision,
    confidence: confidenceForDecision(decision, blockers, trustAudit),
    reasons: reasons.slice(0, MAX_BLOCKERS)
  };
}

function buildBlockers(input: BuildHumanReviewInput, feedbackEffects: FeedbackPolicyEffect[]): ReviewBlocker[] {
  const blockers: ReviewBlocker[] = [];
  const prSurface = input.prSurface;

  if (prSurface?.blocked_reason === "privacy_block") {
    blockers.push({
      id: "BLOCK-PRIVACY-001",
      severity: "high",
      summary: "A privacy or secret guard blocked the PR review surface.",
      evidence: [missingEvidence("Remote provider call was blocked by privacy checks.")],
      required_action: "Inspect redaction/secret findings and rerun only after sensitive material is removed or excluded."
    });
  }

  const failedTestEvidence = failedValidationEvidence(input);
  if (failedTestEvidence.length > 0) {
    blockers.push({
      id: "BLOCK-TESTS-001",
      severity: "high",
      summary: "Validation evidence records failing tests.",
      evidence: failedTestEvidence.flatMap((item) => item.evidence ?? [missingEvidence(item.summary)]).slice(0, 6),
      required_action: "Fix or explicitly defer the failing validation before merge."
    });
  }

  for (const risk of allCriticalRisks(input).slice(0, 3)) {
    blockers.push({
      id: `BLOCK-${risk.id}`,
      severity: "critical",
      summary: risk.summary,
      evidence: risk.evidence.length ? risk.evidence : [missingEvidence("Critical risk has no path-bearing evidence.")],
      required_action: risk.suggested_checks[0] ?? "Resolve or explicitly defer the critical risk."
    });
  }

  const secretBoundary = prSurface?.risks.candidates.find((risk) => risk.rule === "ci_secret_boundary_change");
  if (secretBoundary && !hasRecordedCiSecretBoundaryManualCheck(input)) {
    blockers.push({
      id: "BLOCK-CI-SECRET-001",
      severity: "high",
      summary: "CI / secret-boundary files changed without recorded manual check evidence.",
      evidence: evidenceOrMissing(secretBoundary.evidence, "CI / secret-boundary risk needs file evidence."),
      required_action: "Record a manual check confirming PR-controlled code cannot access secrets."
    });
  }

  for (const effect of feedbackEffects.filter(isMissingTeamPolicyEffect).slice(0, 4)) {
    blockers.push({
      id: `BLOCK-${stableFeedbackEffectId(effect.id)}`,
      severity: "high",
      summary: effect.summary,
      evidence: feedbackEffectEvidence(effect),
      required_action: effect.action
    });
  }

  return dedupeById(blockers).slice(0, MAX_BLOCKERS);
}

function buildReviewQueue(input: BuildHumanReviewInput, feedbackEffects: FeedbackPolicyEffect[]): HumanReviewModel["review_queue"] {
  const drafts: QueueDraft[] = [];
  const prChangedPaths = input.prSurface ? prChangedFilePaths(input.prSurface) : undefined;
  const diffIndex = buildDiffIndex(input.diff);
  let prRiskQueueItemCount = 0;

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    const first = firstPathEvidence(risk.evidence);
    if (!first) {
      continue;
    }
    const anchor = queueAnchorForEvidence(first, diffIndex);
    const feedbackDowngrade = feedbackFalsePositiveEffectForRisk(risk, feedbackEffects, first.path);
    prRiskQueueItemCount += 1;
    drafts.push({
      title: titleForPrRisk(risk),
      path: anchor.path,
      old_path: anchor.old_path,
      hunk_header: anchor.hunk_header,
      line_start: anchor.line_start,
      line_end: anchor.line_end,
      reviewer_action: risk.suggested_checks[0] ?? "Inspect the cited changed file before approving.",
      reason: feedbackDowngrade
        ? `${rankReasonForPrRisk(risk)} Feedback memory downgraded this review priority but retained the evidence-backed item.`
        : rankReasonForPrRisk(risk),
      evidence: feedbackDowngrade
        ? [...evidenceOrMissing(risk.evidence, risk.summary), ...feedbackDowngrade.evidence]
        : evidenceOrMissing(risk.evidence, risk.summary),
      requirement_ids: requirementIds(risk.evidence),
      risk_ids: [risk.id],
      confidence: anchor.line_start || anchor.hunk_header ? "high" : "medium",
      priority: feedbackDowngrade ? "low" : priorityForSeverity(risk.severity),
      estimated_review_effort: effortForSeverity(risk.severity),
      score: scorePrRisk(risk, anchor) + (feedbackDowngrade ? -60 : 0),
      sortKey: `${risk.id}:${first.path}`
    });
  }

  drafts.push(...feedbackReviewQueueDrafts(feedbackEffects, diffIndex));

  if (input.prSurface && prRiskQueueItemCount === 0) {
    drafts.push(...changedFileQueueDrafts(input.prSurface, diffIndex));
  }

  for (const risk of input.packet.risks.items) {
    const first = prChangedPaths
      ? firstPathEvidenceInScope(risk.evidence ?? [], prChangedPaths)
      : firstPathEvidence(risk.evidence ?? []);
    if (!first) {
      continue;
    }
    const anchor = queueAnchorForEvidence(first, diffIndex);
    drafts.push({
      title: titleFromSummary(risk.summary),
      path: anchor.path,
      old_path: anchor.old_path,
      hunk_header: anchor.hunk_header,
      line_start: anchor.line_start,
      line_end: anchor.line_end,
      reviewer_action: risk.suggested_checks?.[0] ?? "Inspect the cited packet risk evidence.",
      reason: `Ranked from whole-packet ${risk.severity} ${risk.category} risk ${risk.id}.`,
      evidence: evidenceOrMissing(risk.evidence ?? [], risk.summary),
      requirement_ids: requirementIds(risk.evidence ?? []),
      risk_ids: [risk.id],
      confidence: anchor.line_start || anchor.hunk_header ? "high" : "medium",
      priority: priorityForSeverity(risk.severity),
      estimated_review_effort: effortForSeverity(risk.severity),
      score: severityWeight(risk.severity) + 10 + (anchor.line_start ? 5 : 0) + (anchor.hunk_header ? 5 : 0),
      sortKey: `${risk.id}:${first.path}`
    });
  }

  drafts.sort((left, right) => right.score - left.score || compareStrings(left.sortKey, right.sortKey));
  return drafts.slice(0, MAX_QUEUE).map((draft, index) =>
    stripUndefined({
      id: `REVIEW-${String(index + 1).padStart(3, "0")}`,
      rank: index + 1,
      title: draft.title,
      path: draft.path,
      old_path: draft.old_path,
      hunk_header: draft.hunk_header,
      line_start: draft.line_start,
      line_end: draft.line_end,
      reviewer_action: draft.reviewer_action,
      reason: draft.reason,
      evidence: draft.evidence,
      requirement_ids: draft.requirement_ids,
      risk_ids: draft.risk_ids,
      confidence: draft.confidence,
      priority: draft.priority,
      estimated_review_effort: draft.estimated_review_effort
    })
  );
}

function changedFileQueueDrafts(
  prSurface: PrReviewSurfaceModel,
  diffIndex: DiffIndex | undefined
): QueueDraft[] {
  return prSurface.scope.changed_files
    .filter((file) => changedFileQueueWeight(file) > 0)
    .sort((left, right) => changedFileQueueWeight(right) - changedFileQueueWeight(left) || compareStrings(left.path, right.path))
    .slice(0, MAX_CHANGED_FILE_QUEUE)
    .map((file) => {
      const evidence = fileEvidence(file.path, "Changed PR file queued because no deterministic PR risk candidate fired.");
      const anchor = queueAnchorForEvidence(evidence, diffIndex);
      const fileAreas = changedFileAreas(file);
      const areas = fileAreas.length ? fileAreas.join(", ") : "unmapped area";
      return {
        title: titleForChangedFile(file),
        path: anchor.path,
        old_path: anchor.old_path,
        hunk_header: anchor.hunk_header,
        line_start: anchor.line_start,
        line_end: anchor.line_end,
        reviewer_action: actionForChangedFile(file),
        reason: `No deterministic PR risk candidate fired; queued changed ${file.role} file in ${areas}.`,
        evidence: [evidence],
        requirement_ids: affectedRequirementIdsForFile(prSurface, file),
        risk_ids: [],
        confidence: anchor.line_start || anchor.hunk_header ? "high" as const : "medium" as const,
        priority: priorityForChangedFile(file),
        estimated_review_effort: file.role === "test" ? "quick" as const : "moderate" as const,
        score: changedFileQueueWeight(file) + (anchor.line_start ? 8 : 0) + (anchor.hunk_header ? 8 : 0),
        sortKey: `changed:${file.path}`
      };
    });
}

function buildFeedbackPolicyEffects(input: BuildHumanReviewInput): FeedbackPolicyEffect[] {
  const drafts: FeedbackPolicyEffectDraft[] = [];
  const changedFiles = input.prSurface?.scope.changed_files ?? [];
  const riskRulePaths = buildPrRiskRulePathIndex(input.prSurface);

  for (const feedbackFile of input.feedback ?? []) {
    for (const policy of feedbackFile.false_positives ?? []) {
      const matcher = buildFeedbackPathMatcher(policy.path_pattern);
      for (const risk of input.prSurface?.risks.candidates ?? []) {
        const ruleMatches = policy.rule === undefined || policy.rule === risk.rule;
        if (!ruleMatches) {
          continue;
        }
        const riskHasPathEvidence = risk.evidence.some((ref) => ref.path);
        const paths = risk.evidence
          .filter((ref) => ref.path && matcher.matches(ref.path))
          .map((ref) => normalizeEvidencePath(String(ref.path)));
        const fallbackPaths = policy.path_pattern && !riskHasPathEvidence
          ? changedFiles.filter((file) => matcher.matches(file.path)).map((file) => normalizeEvidencePath(file.path))
          : [];
        const matchedPaths = uniqueTruthy([...paths, ...fallbackPaths]);
        if (policy.path_pattern && matchedPaths.length === 0) {
          continue;
        }
        if (!feedbackFalsePositiveConditionSatisfied(policy.condition, matchedPaths)) {
          continue;
        }
        drafts.push({
          kind: "false_positive",
          summary: `Feedback marks ${risk.rule} as noisy${matchedPaths.length ? ` for ${matchedPaths.join(", ")}` : ""}.`,
          action: feedbackFalsePositiveAction(policy.action),
          evidence: [...policy.evidence, ...evidenceOrMissing(risk.evidence, risk.summary)],
          paths: matchedPaths,
          risk_ids: [risk.id],
          confidence: "medium"
        });
      }
    }

    for (const policy of feedbackFile.false_negatives ?? []) {
      const matcher = buildFeedbackPathMatcher(policy.path_pattern);
      const paths = changedFiles
        .filter((file) => matcher.matches(file.path))
        .filter((file) => !policy.desired_rule || !prRiskRuleCoversPath(riskRulePaths, policy.desired_rule, file.path))
        .map((file) => normalizeEvidencePath(file.path));
      if (paths.length === 0) {
        continue;
      }
      drafts.push({
        kind: "false_negative",
        summary: `${policy.description}${policy.desired_rule ? ` Desired rule: ${policy.desired_rule}.` : ""}`,
        action: policy.desired_rule ? `Queue reviewer focus for feedback rule ${policy.desired_rule}.` : "Queue reviewer focus from feedback false-negative policy.",
        evidence: policy.evidence,
        paths,
        risk_ids: policy.desired_rule ? [`feedback:${policy.desired_rule}`] : [],
        confidence: "medium"
      });
    }

    for (const policy of feedbackFile.team_policy ?? []) {
      const matcher = buildFeedbackPathMatcher(policy.path_pattern);
      const paths = changedFiles
        .filter((file) => matcher.matches(file.path))
        .map((file) => normalizeEvidencePath(file.path));
      if (paths.length === 0 || !policy.required_manual_check) {
        continue;
      }
      const recordedEvidence = recordedManualCheckEvidence(input, policy.required_manual_check);
      const recorded = recordedEvidence.length > 0;
      drafts.push({
        kind: "team_policy",
        summary: recorded
          ? `Team policy ${policy.id} matched changed file(s), and matching manual-check evidence is recorded.`
          : `Team policy ${policy.id} matched changed file(s), but the required manual check is missing.`,
        action: recorded
          ? `${MANUAL_CHECK_RECORDED_PREFIX} ${policy.required_manual_check}`
          : `${RECORD_MANUAL_CHECK_PREFIX} ${policy.required_manual_check}`,
        evidence: recorded ? [...policy.evidence, ...recordedEvidence] : policy.evidence,
        paths,
        risk_ids: [`policy:${policy.id}`],
        confidence: recorded ? "medium" : "high"
      });
    }

    for (const preference of feedbackFile.reviewer_preferences ?? []) {
      const focusPatterns = reviewerPreferencePathPatterns(preference.key, preference.value);
      if (focusPatterns.length === 0) {
        continue;
      }
      const matchers = focusPatterns.map(buildFeedbackPathMatcher);
      const paths = changedFiles
        .filter((file) => matchers.some((matcher) => matcher.matches(file.path)))
        .map((file) => normalizeEvidencePath(file.path));
      if (paths.length === 0) {
        continue;
      }
      drafts.push({
        kind: "reviewer_preference",
        summary: `Reviewer preference ${preference.key} matched changed file(s).`,
        action: FEEDBACK_ACTION_PRIORITIZE_REVIEW_FOCUS,
        evidence: preference.evidence,
        paths,
        risk_ids: [],
        confidence: "medium"
      });
    }
  }

  return dedupeFeedbackEffects(drafts).slice(0, 12).map((draft, index) => ({
    id: `FEEDBACK-${String(index + 1).padStart(3, "0")}`,
    ...draft
  }));
}

function feedbackReviewQueueDrafts(
  feedbackEffects: FeedbackPolicyEffect[],
  diffIndex: DiffIndex | undefined
): QueueDraft[] {
  const drafts: QueueDraft[] = [];
  const effectToDrafts = (effect: FeedbackPolicyEffect, baseScore: number, priority: HumanReviewPriority): QueueDraft[] =>
    effect.paths.map((filePath) => {
      const evidence = fileEvidence(filePath, "Changed file matched reviewer feedback memory.", "medium");
      const anchor = queueAnchorForEvidence(evidence, diffIndex);
      return {
        title: feedbackQueueTitle(effect),
        path: anchor.path,
        old_path: anchor.old_path,
        hunk_header: anchor.hunk_header,
        line_start: anchor.line_start,
        line_end: anchor.line_end,
        reviewer_action: effect.action,
        reason: effect.summary,
        evidence: [evidence, ...effect.evidence],
        requirement_ids: requirementIds(effect.evidence),
        risk_ids: effect.risk_ids,
        confidence: anchor.line_start || anchor.hunk_header ? "high" : effect.confidence,
        priority,
        estimated_review_effort: priority === "high" ? "moderate" : "quick",
        score: baseScore + (anchor.line_start ? 8 : 0) + (anchor.hunk_header ? 8 : 0),
        sortKey: `${effect.id}:${filePath}`
      };
    });

  for (const effect of feedbackEffects) {
    if (effect.kind === "false_negative") {
      drafts.push(...effectToDrafts(effect, 70, "high"));
    } else if (isMissingTeamPolicyEffect(effect)) {
      drafts.push(...effectToDrafts(effect, 78, "high"));
    } else if (isReviewerPreferenceFocusEffect(effect)) {
      drafts.push(...effectToDrafts(effect, 55, "medium"));
    }
  }

  return dedupeQueueDrafts(drafts);
}

function feedbackFalsePositiveEffectForRisk(
  risk: PrRiskCandidate,
  feedbackEffects: FeedbackPolicyEffect[],
  anchorPath: string | undefined
): FeedbackPolicyEffect | undefined {
  const riskPaths = uniqueTruthy(
    risk.evidence
      .filter((ref) => ref.path)
      .map((ref) => normalizeEvidencePath(String(ref.path)))
  );
  const normalizedAnchorPath = anchorPath ? normalizeEvidencePath(anchorPath) : undefined;
  return feedbackEffects.find((effect) =>
    effect.kind === "false_positive" &&
    effect.risk_ids.includes(risk.id) &&
    (effect.action === FEEDBACK_ACTION_DOWNGRADE_TO_LOW || effect.action === FEEDBACK_ACTION_RETAIN_LOW_PRIORITY) &&
    feedbackFalsePositiveCoversRiskPaths(effect, riskPaths, normalizedAnchorPath)
  );
}

function feedbackFalsePositiveCoversRiskPaths(
  effect: FeedbackPolicyEffect,
  riskPaths: string[],
  anchorPath: string | undefined
): boolean {
  if (effect.paths.length === 0) {
    return true;
  }
  const effectPaths = new Set(effect.paths.map((filePath) => normalizeEvidencePath(filePath)));
  if (riskPaths.length > 1) {
    return riskPaths.every((filePath) => effectPaths.has(filePath));
  }
  return anchorPath ? effectPaths.has(anchorPath) : false;
}

function feedbackFalsePositiveAction(action: string): string {
  const normalized = action.trim().toLowerCase();
  if (normalized === FEEDBACK_ACTION_DOWNGRADE_TO_LOW) {
    return FEEDBACK_ACTION_DOWNGRADE_TO_LOW;
  }
  if (normalized === "suppress" || normalized === "ignore") {
    return FEEDBACK_ACTION_RETAIN_LOW_PRIORITY;
  }
  return normalized || FEEDBACK_ACTION_DOWNGRADE_TO_LOW;
}

function feedbackFalsePositiveConditionSatisfied(condition: string | undefined, matchedPaths: string[]): boolean {
  const normalized = condition?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized === "lockfile_only") {
    return matchedPaths.length > 0 && matchedPaths.every(isLockfilePath);
  }
  return false;
}

function isLockfilePath(filePath: string): boolean {
  const normalizedPath = normalizeEvidencePath(filePath);
  return /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|Cargo\.lock)$/.test(normalizedPath);
}

function isMissingTeamPolicyEffect(effect: FeedbackPolicyEffect): boolean {
  return effect.kind === "team_policy" && effect.action.startsWith(RECORD_MANUAL_CHECK_PREFIX);
}

function isReviewerPreferenceFocusEffect(effect: FeedbackPolicyEffect): boolean {
  return effect.kind === "reviewer_preference" && effect.action === FEEDBACK_ACTION_PRIORITIZE_REVIEW_FOCUS;
}

function manualCheckQuestionText(action: string): string {
  return action.replace(new RegExp(`^${escapeRegExp(RECORD_MANUAL_CHECK_PREFIX)}\\s*`), "");
}

function feedbackQueueTitle(effect: FeedbackPolicyEffect): string {
  switch (effect.kind) {
    case "false_negative":
      return "Feedback-requested review focus";
    case "team_policy":
      return "Feedback team policy manual check";
    case "reviewer_preference":
      return "Reviewer-preferred review focus";
    case "false_positive":
      return "Feedback-downgraded risk";
  }
}

function feedbackEffectEvidence(effect: FeedbackPolicyEffect): EvidenceRef[] {
  return [
    ...effect.paths.map((filePath) => fileEvidence(filePath, "Feedback policy matched this changed file.", effect.confidence)),
    ...effect.evidence
  ];
}

function stableFeedbackEffectId(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase();
}

function dedupeFeedbackEffects(drafts: FeedbackPolicyEffectDraft[]): FeedbackPolicyEffectDraft[] {
  const seen = new Set<string>();
  const result: FeedbackPolicyEffectDraft[] = [];
  for (const draft of drafts.sort(compareFeedbackEffectDrafts)) {
    const key = [
      draft.kind,
      draft.action,
      draft.summary,
      draft.paths.join(","),
      draft.risk_ids.join(",")
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(draft);
  }
  return result;
}

function compareFeedbackEffectDrafts(left: FeedbackPolicyEffectDraft, right: FeedbackPolicyEffectDraft): number {
  return (
    feedbackEffectKindRank(left.kind) - feedbackEffectKindRank(right.kind) ||
    compareStrings(left.action, right.action) ||
    compareStrings(left.summary, right.summary) ||
    compareStrings(left.paths.join(","), right.paths.join(","))
  );
}

function feedbackEffectKindRank(kind: FeedbackPolicyEffect["kind"]): number {
  switch (kind) {
    case "team_policy":
      return 0;
    case "false_negative":
      return 1;
    case "false_positive":
      return 2;
    case "reviewer_preference":
      return 3;
  }
}

function dedupeQueueDrafts(drafts: QueueDraft[]): QueueDraft[] {
  const seen = new Set<string>();
  const result: QueueDraft[] = [];
  for (const draft of drafts) {
    const key = `${draft.path}|${draft.reason}|${draft.reviewer_action}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(draft);
  }
  return result;
}

function buildPrRiskRulePathIndex(prSurface: PrReviewSurfaceModel | undefined): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const risk of prSurface?.risks.candidates ?? []) {
    const paths = risk.evidence
      .filter((ref) => ref.path)
      .map((ref) => normalizeEvidencePath(String(ref.path)));
    if (paths.length === 0) {
      continue;
    }
    const existing = index.get(risk.rule) ?? new Set<string>();
    for (const filePath of paths) {
      existing.add(filePath);
    }
    index.set(risk.rule, existing);
  }
  return index;
}

function prRiskRuleCoversPath(index: Map<string, Set<string>>, rule: string, filePath: string): boolean {
  const normalizedPath = normalizeEvidencePath(filePath);
  return index.get(rule)?.has(normalizedPath) ?? false;
}

function reviewerPreferencePathPatterns(key: string, value: unknown): string[] {
  if (key !== "always_review" && key !== "always_prioritize" && key !== "always_review_surfaces") {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface FeedbackPathMatcher {
  matches(filePath: string | undefined): boolean;
}

function buildFeedbackPathMatcher(pattern: string | undefined): FeedbackPathMatcher {
  const regex = pattern ? globToRegExp(pattern) : undefined;
  return {
    matches(filePath: string | undefined): boolean {
      if (!filePath) {
        return false;
      }
      if (!regex) {
        return true;
      }
      return regex.test(normalizeEvidencePath(filePath));
    }
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildQuestions(
  input: BuildHumanReviewInput,
  blockers: ReviewBlocker[],
  feedbackEffects: FeedbackPolicyEffect[]
): ReviewerQuestion[] {
  const questions: ReviewerQuestion[] = [];
  const focusedGaps = focusedRequirementGaps(input);

  for (const blocker of blockers) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "blocking",
      question: `${blocker.required_action}`,
      reason: blocker.summary,
      evidence: blocker.evidence,
      maps_to_risks: riskIdsFromBlocker(blocker),
      maps_to_requirements: requirementIds(blocker.evidence)
    });
  }

  const schemaRisk = input.prSurface?.risks.candidates.find((risk) => risk.rule === "schema_contract_change");
  if (schemaRisk) {
    questions.push(questionFromPrRisk(questions.length + 1, "blocking", schemaRisk, "Is the schema or persisted artifact contract change additive-only, and where is the compatibility fixture?"));
  }

  if (input.prSurface && !input.prSurface.coverage.base_available) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "clarifying",
      question: "Was the baseline evaluation intentionally unavailable for this run?",
      reason: "Coverage deltas are current-status only when the baseline is unavailable.",
      evidence: [missingEvidence("PR coverage base_available=false.")],
      maps_to_risks: [],
      maps_to_requirements: input.prSurface.coverage.deltas.map((delta) => delta.acai_id ?? delta.requirement_id).slice(0, 8)
    });
  }

  for (const effect of feedbackEffects.filter(isMissingTeamPolicyEffect).slice(0, 3)) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "blocking",
      question: `What current-head evidence records this team-policy manual check: ${manualCheckQuestionText(effect.action)}?`,
      reason: effect.summary,
      evidence: feedbackEffectEvidence(effect),
      maps_to_risks: effect.risk_ids,
      maps_to_requirements: requirementIds(effect.evidence)
    });
  }

  for (const effect of feedbackEffects.filter((effect) => effect.kind === "false_negative").slice(0, 3)) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "clarifying",
      question: `Should ${effect.paths.map((filePath) => `\`${filePath}\``).join(", ")} be reviewed under this feedback policy before approval?`,
      reason: effect.summary,
      evidence: feedbackEffectEvidence(effect),
      maps_to_risks: effect.risk_ids,
      maps_to_requirements: requirementIds(effect.evidence)
    });
  }

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    if (firstPathEvidence(risk.evidence)) {
      continue;
    }
    questions.push(questionFromPrRisk(
      questions.length + 1,
      questionSeverityForRisk(risk.severity),
      risk,
      risk.suggested_checks[0] ?? `How should reviewers account for this pathless PR risk: ${risk.summary}`
    ));
  }

  if (hasNoValidationEvidence(input.packet.risks)) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "clarifying",
      question: "Which validation command or parsed test artifact should reviewers trust for this change?",
      reason: "The packet does not contain direct or indirect validation evidence.",
      evidence: [missingEvidence("No direct or indirect validation evidence found in risks.test_evidence.")],
      maps_to_risks: [],
      maps_to_requirements: []
    });
  }

  for (const gap of focusedGaps.slice(0, 3)) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: gap.status === "missing" || gap.status === "invalid_evidence" ? "blocking" : "clarifying",
      question: `What validation evidence or explicit deferral should close ${gap.acai_id ?? gap.requirement_id}?`,
      reason: gap.summary,
      evidence: requirementGapEvidence(gap),
      maps_to_risks: [],
      maps_to_requirements: compactStrings([gap.acai_id, gap.requirement_id])
    });
  }

  if (focusedGaps.length === 0) {
    for (const item of missingEvidenceSummaries(input).slice(0, 2)) {
      questions.push({
        id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
        severity: "clarifying",
        question: `What evidence closes this review gap: ${item.summary}?`,
        reason: "The trust audit marks this evidence as missing.",
        evidence: item.evidence,
        maps_to_risks: [],
        maps_to_requirements: requirementIds(item.evidence)
      });
    }
  }

  if (input.prSurface?.status === "blocked" && input.prSurface.blocked_reason !== "no_diff") {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(3, "0")}`,
      severity: "clarifying",
      question: `Should the PR surface be regenerated so the blocked state (${input.prSurface.blocked_reason ?? "unknown"}) is resolved before review?`,
      reason: "The human artifact can use deterministic facts, but PR narrative evidence is unavailable.",
      evidence: [missingEvidence("PR surface is blocked.")],
      maps_to_risks: [],
      maps_to_requirements: []
    });
  }

  return dedupeQuestions(questions).slice(0, MAX_QUESTIONS);
}

function buildSuggestedComments(input: BuildHumanReviewInput, blockers: ReviewBlocker[]): SuggestedReviewComment[] {
  const comments: SuggestedReviewComment[] = [];
  const candidates: SuggestedCommentCandidate[] = [];
  const focusedGaps = focusedRequirementGaps(input);

  for (const blocker of blockers) {
    const first = firstPathEvidence(blocker.evidence);
    candidates.push({
      sourceRank: 0,
      sortKey: blocker.id,
      draft: stripUndefined({
        severity: "blocking",
        path: first?.path,
        line_start: first?.line_start,
        line_end: first?.line_end,
        body: blocker.required_action,
        evidence: blocker.evidence,
        risk_ids: riskIdsFromBlocker(blocker),
        requirement_ids: requirementIds(blocker.evidence),
        confidence: "high",
        ready_to_post: blocker.evidence.length > 0
      })
    });
  }

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    for (const draft of commentDraftsForPrRisk(input, risk)) {
      candidates.push({ risk, draft, sourceRank: 1, sortKey: risk.id });
    }
  }

  if (hasNoValidationEvidence(input.packet.risks)) {
    candidates.push({
      sourceRank: 2,
      sortKey: "missing-validation-evidence",
      draft: {
        severity: "clarifying",
        body: "I do not see direct validation evidence in the packet. Can you record the relevant test/typecheck command transcript or parsed test output?",
        evidence: [missingEvidence("No direct or indirect validation evidence found.")],
        risk_ids: [],
        requirement_ids: [],
        confidence: "medium",
        ready_to_post: true
      }
    });
  }

  const focusedGap = focusedGaps[0];
  if (focusedGap) {
    candidates.push({
      sourceRank: 3,
      sortKey: focusedGap.acai_id ?? focusedGap.requirement_id,
      draft: {
        severity: focusedGap.status === "missing" || focusedGap.status === "invalid_evidence" ? "blocking" : "clarifying",
        body: `Can you point to the validation evidence or explicit deferral for ${focusedGap.acai_id ?? focusedGap.requirement_id}? The human review surface currently marks it as ${focusedGap.status}.`,
        evidence: requirementGapEvidence(focusedGap),
        risk_ids: [],
        requirement_ids: compactStrings([focusedGap.acai_id, focusedGap.requirement_id]),
        confidence: "medium",
        ready_to_post: true
      }
    });
  }

  for (const candidate of candidates.sort(compareSuggestedCommentCandidates)) {
    appendSuggestedComment(comments, candidate.draft);
  }

  return comments.slice(0, MAX_COMMENTS);
}

function buildTrustAudit(input: BuildHumanReviewInput): TrustAudit {
  const positiveEvidenceFacts = positiveValidationEvidence(input.packet.risks).map((evidence) => ({
    summary: evidence.note ?? evidence.command ?? evidence.test_name ?? "Verified validation evidence is present.",
    evidence: [evidence]
  }));

  const prFacts: TrustFactDraft[] = [];
  if (input.prSurface) {
    prFacts.push({
      summary: `PR scope contains ${input.prSurface.scope.changed_files.length} changed file(s), ${input.prSurface.scope.affected_requirements.length} affected requirement(s), and ${input.prSurface.risks.candidates.length} deterministic PR risk candidate(s).`,
      evidence: input.prSurface.scope.changed_files.slice(0, 5).map((file) => fileEvidence(file.path, "Changed file included in PR scope."))
    });

    for (const risk of input.prSurface.risks.candidates) {
      if (prFacts.length >= MAX_TRUST_ITEMS) {
        break;
      }
      const concreteEvidence = risk.evidence.filter(isVerifiedTrustEvidence);
      if (concreteEvidence.length === 0) {
        continue;
      }
      prFacts.push({
        summary: `Deterministic PR risk ${risk.id} (${risk.rule}) fired: ${risk.summary}`,
        evidence: concreteEvidence.slice(0, 3)
      });
    }
  }

  const verified = withTrustFactIds([
    ...prFacts.slice(0, MAX_TRUST_ITEMS),
    ...positiveEvidenceFacts.slice(0, Math.max(0, MAX_TRUST_ITEMS - prFacts.length))
  ]);

  const claimed = [
    ...input.packet.methodology.claims_without_evidence.map((claim, index) => ({
      id: `TRUST-CLAIM-${String(index + 1).padStart(3, "0")}`,
      claim,
      status: "unverified" as const,
      missing_evidence: "No command transcript or parsed test artifact verifies this claim.",
      evidence: input.packet.methodology.evidence.length ? input.packet.methodology.evidence.slice(0, 3) : [missingEvidence("Methodology claim lacks evidence.")]
    })),
    ...input.packet.risks.test_evidence
      .filter((item) => item.kind === "claimed")
      .map((item, index) => ({
        id: `TRUST-CLAIM-TEST-${String(index + 1).padStart(3, "0")}`,
        claim: item.summary,
        status: "unverified" as const,
        missing_evidence: "The command or test is claimed but not backed by direct parsed output or transcript evidence.",
        evidence: item.evidence ?? [missingEvidence(item.summary)]
      }))
  ].slice(0, MAX_TRUST_ITEMS);

  const missing = missingEvidenceSummaries(input);
  const invalid = invalidEvidenceSummaries(input);

  return {
    verified_facts: verified,
    claimed_not_verified: claimed,
    missing_evidence: missing,
    invalid_evidence: invalid,
    confidence_summary: confidenceSummary(verified.length, claimed.length, missing.length, invalid.length)
  };
}

function buildTestPlan(input: BuildHumanReviewInput, feedbackEffects: FeedbackPolicyEffect[]): TestPlanItem[] {
  const items: TestPlanItem[] = [];
  const candidates: TestPlanCandidate[] = [];

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    for (const draft of testPlanDraftsForPrRisk(input, risk)) {
      candidates.push({ risk, draft, sourceRank: 0, sortKey: risk.id });
    }
  }

  for (const [index, gap] of focusedRequirementGaps(input).slice(0, MAX_FOCUSED_REQUIREMENT_TESTS).entries()) {
    const requirementId = gap.acai_id ?? gap.requirement_id;
    const suggestedFile = suggestedTestFile(requirementId, gap.summary);
    candidates.push({
      sourceRank: 1,
      sortKey: rankedSortKey(index, requirementId),
      draft: {
        kind: "automatic",
        priority: gap.status === "missing" || gap.status === "invalid_evidence" ? "required" : "recommended",
        suggested_file: suggestedFile,
        scenario: `Add a focused unit or fixture test tied to ${requirementId}.`,
        expected_result: "The generated human review JSON and Markdown retain deterministic, evidence-backed behavior for this requirement.",
        command: suggestedFile ? `pnpm run test -- ${suggestedFile}` : "pnpm run test",
        maps_to_requirements: compactStrings([gap.acai_id, gap.requirement_id]),
        maps_to_risks: [],
        evidence_gap: gap.summary
      }
    });
  }

  for (const [index, gap] of [...(input.packet.risks.missing_automatic_tests ?? [])].sort(compareMissingGapPriority).entries()) {
    const suggestedFile = suggestedTestFile(gap.acai_id, gap.suggested_test);
    candidates.push({
      sourceRank: 2,
      sortKey: rankedSortKey(index, gap.acai_id ?? gap.requirement_id ?? gap.id),
      draft: {
        kind: "automatic",
        priority: "recommended",
        suggested_file: suggestedFile,
        scenario: gap.suggested_test,
        expected_result: "The packet records direct or requirement-specific test evidence for the mapped requirement.",
        command: suggestedFile ? `pnpm run test -- ${suggestedFile}` : "pnpm run test",
        maps_to_requirements: compactStrings([gap.acai_id, gap.requirement_id]),
        maps_to_risks: [],
        evidence_gap: gap.summary
      }
    });
  }

  for (const [index, gap] of [...(input.packet.risks.missing_manual_checks ?? [])].sort(compareMissingGapPriority).entries()) {
    candidates.push({
      sourceRank: 3,
      sortKey: rankedSortKey(index, gap.acai_id ?? gap.requirement_id ?? gap.id),
      draft: {
        kind: "manual",
        priority: "recommended",
        scenario: gap.manual_check,
        expected_result: "Reviewer records the files inspected, conclusion, and any follow-up action.",
        maps_to_requirements: compactStrings([gap.acai_id, gap.requirement_id]),
        maps_to_risks: [],
        evidence_gap: gap.summary
      }
    });
  }

  for (const [index, effect] of feedbackEffects.filter(isMissingTeamPolicyEffect).entries()) {
    candidates.push({
      sourceRank: 4,
      sortKey: rankedSortKey(index, effect.id),
      draft: {
        kind: "manual",
        priority: "required",
        scenario: effect.action,
        expected_result: "Reviewer records the files inspected, conclusion, and any follow-up action in local feedback for the current head.",
        maps_to_requirements: requirementIds(effect.evidence),
        maps_to_risks: effect.risk_ids,
        evidence_gap: effect.summary
      }
    });
  }

  for (const candidate of candidates.sort(compareTestPlanCandidates)) {
    appendTestPlanItem(items, candidate.draft);
  }

  return items.slice(0, MAX_TEST_PLAN);
}

function testPlanDraftsForPrRisk(input: BuildHumanReviewInput, risk: PrRiskCandidate): TestPlanDraft[] {
  const riskEvidence = evidenceOrMissing(risk.evidence, risk.summary);
  const path = firstPathEvidence(risk.evidence)?.path;
  const suggestedFile = suggestedTestFileForPath(path);
  const mapsToRisks = [risk.id];
  const riskDraft = (draft: TestPlanDraftCore): TestPlanDraft => ({
    ...draft,
    maps_to_requirements: draft.maps_to_requirements ?? requirementIdsForPrRisk(input, risk),
    maps_to_risks: draft.maps_to_risks ?? mapsToRisks,
    evidence_gap: draft.evidence_gap ?? risk.summary
  });

  switch (risk.rule) {
    case "coverage_regression":
      return [riskDraft({
        kind: "automatic",
        priority: "required",
        suggested_file: "tests/scoped-coverage.test.ts",
        scenario: "Add or restore a fixture proving the regressed requirement returns to satisfied or partial-with-evidence coverage.",
        expected_result: "The scoped coverage delta no longer reports a regression for the mapped requirement.",
        command: "pnpm run test -- tests/scoped-coverage.test.ts"
      })];
    case "untested_changed_impl":
      return [riskDraft({
        kind: "automatic",
        priority: "required",
        suggested_file: suggestedFile,
        scenario: `Add or identify a focused test that exercises the changed implementation${path ? ` in ${path}` : ""}.`,
        expected_result: "A direct test or command transcript demonstrates the changed implementation behavior before approval.",
        command: suggestedFile ? `pnpm run test -- ${suggestedFile}` : "pnpm run test"
      })];
    case "unmapped_change":
      return [riskDraft({
        kind: "manual",
        priority: "recommended",
        scenario: "Inspect the unmapped changed files and decide whether they need review-area or requirement mappings.",
        expected_result: "Each unmapped file is either mapped to a review area/requirement or explicitly recorded as generated, ignored, or non-product behavior."
      })];
    case "privacy_sensitive_change":
      return [riskDraft({
        kind: "automatic",
        priority: "required",
        suggested_file: suggestedFile ?? "tests/privacy.test.ts",
        scenario: "Exercise the changed privacy, provider, redaction, secret, or token-handling path with sensitive-looking input.",
        expected_result: "No secret or unredacted sensitive value is emitted to artifacts, logs, comments, or remote-provider prompts.",
        command: `pnpm run test -- ${suggestedFile ?? "tests/privacy.test.ts"}`
      })];
    case "comment_surface_change":
      return [riskDraft({
        kind: "automatic",
        priority: "recommended",
        suggested_file: "tests/pr-comment.test.ts",
        scenario: "Render the changed reviewer-facing Markdown surface from a deterministic fixture.",
        expected_result: "The Markdown stays bounded, evidence-backed, and avoids whole-packet fallback in PR mode.",
        command: "pnpm run test -- tests/pr-comment.test.ts"
      })];
    case "ci_secret_boundary_change":
      if (hasRecordedCiSecretBoundaryManualCheck(input)) {
        return [];
      }
      return [riskDraft({
        kind: "manual",
        priority: "required",
        scenario: "Inspect workflow/provider/comment-posting changes for the CI secret boundary.",
        expected_result: "Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets, and secret-bearing steps run only from trusted code.",
        evidence_gap: "No manual CI secret-boundary check is recorded."
      })];
    case "schema_contract_change":
      return [riskDraft({
        kind: "automatic",
        priority: "required",
        suggested_file: "tests/schema-contract.test.ts",
        scenario: "Load a previous valid human or PR review surface fixture and validate it against the current schema.",
        expected_result: "The fixture validates, or the schema version is intentionally bumped for a breaking contract change.",
        command: "pnpm run test -- tests/schema-contract.test.ts"
      })];
    case "deleted_or_renamed_surface":
      return [riskDraft({
        kind: "automatic",
        priority: "recommended",
        suggested_file: suggestedFile,
        scenario: `Run or add a reference/import test for the deleted or renamed surface${path ? ` around ${path}` : ""}.`,
        expected_result: "No stale imports, generated artifact references, or reviewer-facing links point at the removed path.",
        command: suggestedFile ? `pnpm run test -- ${suggestedFile}` : "pnpm run test"
      })];
    case "failed_or_skipped_test":
      return [riskDraft({
        kind: "automatic",
        priority: "required",
        scenario: "Rerun the affected test command after fixing failures and confirming skipped tests are intentional.",
        expected_result: "Parsed test output records zero failures, and any skipped tests are explicitly justified or removed.",
        command: "pnpm run test"
      })];
    case "large_diff":
      return [riskDraft({
        kind: "manual",
        priority: "optional",
        scenario: "Decide whether the large diff should be split or reviewed with extra owner attention.",
        expected_result: "Reviewer records whether the diff size is acceptable for one review and which areas received deeper inspection.",
        evidence_gap: riskEvidence[0]?.note ?? risk.summary
      })];
  }
}

function compareTestPlanCandidates(
  left: TestPlanCandidate,
  right: TestPlanCandidate
): number {
  return (
    testPlanPriorityRank(left.draft.priority) - testPlanPriorityRank(right.draft.priority) ||
    (left.sourceRank - right.sourceRank) ||
    severityWeight(right.risk?.severity ?? "unknown") - severityWeight(left.risk?.severity ?? "unknown") ||
    ruleWeight(right.risk?.rule) - ruleWeight(left.risk?.rule) ||
    compareStrings(left.sortKey, right.sortKey)
  );
}

function testPlanPriorityRank(priority: TestPlanItem["priority"]): number {
  switch (priority) {
    case "required":
      return 0;
    case "recommended":
      return 1;
    case "optional":
      return 2;
  }
}

function rankedSortKey(index: number, key: string): string {
  return `${String(index).padStart(4, "0")}:${key}`;
}

function requirementIdsForPrRisk(input: BuildHumanReviewInput, risk: PrRiskCandidate): string[] {
  const fromEvidence = requirementIds(risk.evidence);
  if (risk.rule !== "coverage_regression") {
    return fromEvidence;
  }
  const fromDeltas = input.prSurface?.coverage.deltas
    .filter((delta) => delta.delta === "regressed")
    .map((delta) => delta.acai_id ?? delta.requirement_id) ?? [];
  return uniqueTruthy([...fromEvidence, ...fromDeltas]).slice(0, 8);
}

function withTestPlanId(index: number, draft: TestPlanDraft): TestPlanItem {
  return stripUndefined({
    id: `TEST-${String(index).padStart(3, "0")}`,
    ...draft
  });
}

function appendTestPlanItem(items: TestPlanItem[], draft: TestPlanDraft): void {
  if (items.length >= MAX_TEST_PLAN) {
    return;
  }
  const candidate = withTestPlanId(items.length + 1, draft);
  const candidateKey = testPlanDedupeKey(candidate);
  if (items.some((item) => testPlanDedupeKey(item) === candidateKey)) {
    return;
  }
  items.push(candidate);
}

function appendSuggestedComment(items: SuggestedReviewComment[], draft: SuggestedCommentDraft): void {
  if (items.length >= MAX_COMMENTS) {
    return;
  }
  const candidate = withSuggestedCommentId(items.length + 1, draft);
  const candidateKey = suggestedCommentDedupeKey(candidate);
  if (items.some((item) => suggestedCommentDedupeKey(item) === candidateKey)) {
    return;
  }
  items.push(candidate);
}

function withSuggestedCommentId(index: number, draft: SuggestedCommentDraft): SuggestedReviewComment {
  return stripUndefined({
    id: `SC-${String(index).padStart(3, "0")}`,
    ...draft
  });
}

function buildSkimSafe(input: BuildHumanReviewInput, feedbackEffects: FeedbackPolicyEffect[]): HumanReviewModel["skim_safe"] {
  const highRiskPaths = new Set<string>();
  for (const item of [...(input.prSurface?.risks.candidates ?? []), ...input.packet.risks.items]) {
    if (item.severity === "high" || item.severity === "critical") {
      for (const ref of item.evidence ?? []) {
        if (ref.path) {
          highRiskPaths.add(ref.path);
        }
      }
    }
  }
  const feedbackFocusPaths = new Set(
    feedbackEffects
      .filter((effect) => effect.kind === "false_negative" || effect.kind === "team_policy" || isReviewerPreferenceFocusEffect(effect))
      .flatMap((effect) => effect.paths)
      .map((filePath) => normalizeEvidencePath(filePath))
  );

  return (input.prSurface?.scope.changed_files ?? [])
    .filter((file) => !highRiskPaths.has(file.path))
    .filter((file) => !feedbackFocusPaths.has(normalizeEvidencePath(file.path)))
    .filter((file) => isSkimSafeCandidate(file.path, file.role))
    .slice(0, 8)
    .map((file) => ({
      path: file.path,
      reason: file.role === "generated" ? "Generated artifact with no mapped high-risk finding." : file.role === "doc" ? "Docs-only changed file with no mapped high-risk finding." : "Lockfile or generated dependency metadata with no mapped high-risk finding.",
      caveat: file.role === "doc" ? "Inspect if the doc defines product contracts, policies, or reviewer workflows." : "Inspect if runtime dependency versions or generated artifacts are intentionally part of the change.",
      evidence: [fileEvidence(file.path, "Changed file considered skim-safe by deterministic role/path heuristics.", "low")],
      confidence: "low" as const
    }));
}

function summarizeHumanReview(
  input: BuildHumanReviewInput,
  verdict: HumanReviewVerdict,
  queueCount: number,
  blockerCount: number
): string {
  const scope = input.prSurface
    ? `${input.prSurface.scope.changed_files.length} changed file(s), ${input.prSurface.scope.affected_requirements.length} affected requirement(s), ${input.prSurface.risks.candidates.length} PR risk candidate(s)`
    : `${input.packet.evaluation.results.length} requirement result(s), ${input.packet.risks.items.length} packet risk(s)`;
  return `Human review surface generated from local evidence: ${scope}. Verdict is ${verdict.decision} with ${blockerCount} blocker(s) and ${queueCount} review queue item(s).`;
}

function missingEvidenceSummaries(input: BuildHumanReviewInput): MissingEvidenceSummary[] {
  const missing: MissingEvidenceSummary[] = [];
  for (const item of input.packet.risks.test_evidence) {
    if (item.kind === "missing" || item.kind === "unknown") {
      missing.push({
        id: `MISSING-${String(missing.length + 1).padStart(3, "0")}`,
        summary: item.summary,
        evidence: item.evidence ?? [missingEvidence(item.summary)]
      });
    }
  }
  if (input.prSurface && !input.prSurface.coverage.base_available) {
    missing.push({
      id: `MISSING-${String(missing.length + 1).padStart(3, "0")}`,
      summary: "Baseline evaluation unavailable; coverage deltas are current-status only.",
      evidence: [missingEvidence("coverage.base_available=false")]
    });
  }
  for (const gap of input.packet.risks.missing_manual_checks ?? []) {
    missing.push({
      id: `MISSING-${String(missing.length + 1).padStart(3, "0")}`,
      summary: gap.summary,
      evidence: gap.evidence ?? [missingEvidence(gap.manual_check)]
    });
  }
  return missing.slice(0, MAX_TRUST_ITEMS);
}

function invalidEvidenceSummaries(input: BuildHumanReviewInput): HumanReviewModel["trust_audit"]["invalid_evidence"] {
  const packetInvalid = input.packet.evaluation.results
    .filter((result) => result.status === "invalid_evidence")
    .map((result) => ({
      summary: `${result.acai_id ?? result.requirement_id}: ${result.summary}`,
      evidence: [...result.evidence, ...result.missing_evidence]
    }));

  const prRiskInvalid: InvalidEvidenceDraft[] = [];
  for (const risk of input.prSurface?.risks.candidates ?? []) {
    const invalidRiskEvidence = risk.evidence.filter(isInvalidTrustEvidence);
    if (invalidRiskEvidence.length === 0) {
      continue;
    }
    prRiskInvalid.push({
      summary: `${risk.id}: PR risk evidence is invalid or not deterministic.`,
      evidence: invalidRiskEvidence
    });
  }

  return withInvalidEvidenceIds([
    ...prRiskInvalid.slice(0, MAX_TRUST_ITEMS),
    ...packetInvalid.slice(0, Math.max(0, MAX_TRUST_ITEMS - prRiskInvalid.length))
  ]);
}

function withTrustFactIds(drafts: TrustFactDraft[]): TrustFact[] {
  return drafts.slice(0, MAX_TRUST_ITEMS).map((draft, index) => ({
    id: `TRUST-VERIFIED-${String(index + 1).padStart(3, "0")}`,
    ...draft
  }));
}

function withInvalidEvidenceIds(drafts: InvalidEvidenceDraft[]): InvalidEvidenceSummary[] {
  return drafts.slice(0, MAX_TRUST_ITEMS).map((draft, index) => ({
    id: `INVALID-${String(index + 1).padStart(3, "0")}`,
    ...draft
  }));
}

function isVerifiedTrustEvidence(ref: EvidenceRef): boolean {
  return ref.kind !== "unknown" && ref.validation_status !== "invalid" && ref.llm_proposed !== true;
}

function isInvalidTrustEvidence(ref: EvidenceRef): boolean {
  return ref.validation_status === "invalid" || ref.llm_proposed === true;
}

function positiveValidationEvidence(risks: RisksModel): EvidenceRef[] {
  return risks.test_evidence
    .filter((item) => item.kind === "direct" || item.kind === "indirect")
    .flatMap((item) => item.evidence ?? [missingEvidence(item.summary)]);
}

function hasPositiveValidationEvidence(risks: RisksModel): boolean {
  return positiveValidationEvidence(risks).length > 0;
}

function hasNoValidationEvidence(risks: RisksModel): boolean {
  return !risks.test_evidence.some((item) => item.kind === "direct" || item.kind === "indirect");
}

function allCriticalRisks(input: BuildHumanReviewInput): Array<{
  id: string;
  summary: string;
  evidence: EvidenceRef[];
  suggested_checks: string[];
}> {
  return [
    ...input.packet.risks.items
      .filter((risk) => risk.severity === "critical")
      .map((risk) => ({ id: risk.id, summary: risk.summary, evidence: risk.evidence ?? [], suggested_checks: risk.suggested_checks ?? [] })),
    ...(input.prSurface?.risks.candidates ?? [])
      .filter((risk) => risk.severity === "critical")
      .map((risk) => ({ id: risk.id, summary: risk.summary, evidence: risk.evidence, suggested_checks: risk.suggested_checks }))
  ];
}

function firstRiskEvidence(input: BuildHumanReviewInput): EvidenceRef[] {
  const prRisk = input.prSurface?.risks.candidates[0];
  if (prRisk) {
    return evidenceOrMissing(prRisk.evidence, prRisk.summary).slice(0, 3);
  }
  const packetRisk = input.packet.risks.items[0];
  return packetRisk ? evidenceOrMissing(packetRisk.evidence ?? [], packetRisk.summary).slice(0, 3) : [missingEvidence("Risk evidence unavailable.")];
}

function hasRiskAtLeast(input: BuildHumanReviewInput, severity: PacketSeverity): boolean {
  const threshold = severityWeight(severity);
  return [
    ...input.packet.risks.items.map((risk) => risk.severity),
    ...(input.prSurface?.risks.candidates.map((risk) => risk.severity) ?? [])
  ].some((riskSeverity) => severityWeight(riskSeverity) >= threshold);
}

function confidenceForDecision(
  decision: HumanReviewDecision,
  blockers: ReviewBlocker[],
  trustAudit: TrustAudit
): PacketConfidence {
  if (decision === "no_signal") {
    return "unknown";
  }
  if (trustAudit.invalid_evidence.length > 0) {
    return "low";
  }
  if (blockers.length > 0) {
    return "high";
  }
  if (trustAudit.missing_evidence.length > 0 || trustAudit.claimed_not_verified.length > 0) {
    return "medium";
  }
  return "high";
}

function confidenceSummary(verified: number, claimed: number, missing: number, invalid: number): string {
  if (invalid > 0) {
    return `Low confidence: ${invalid} invalid evidence item(s) require inspection before trusting the surface.`;
  }
  if (missing > 0 || claimed > 0) {
    return `Medium confidence: ${verified} verified fact(s), ${missing} missing evidence item(s), and ${claimed} unverified claim(s).`;
  }
  if (verified > 0) {
    return `High confidence: ${verified} verified fact(s) and no missing or invalid evidence surfaced in the compact audit.`;
  }
  return "Unknown confidence: no verified facts were available in the compact audit.";
}

function isFailedValidationEvidence(item: RisksModel["test_evidence"][number]): boolean {
  if (item.evidence?.some((ref) => ref.validation_status === "invalid")) {
    return true;
  }
  if (item.kind !== "missing") {
    return false;
  }
  if (/\b(fail(?:ed|ing)?|error)\b/i.test(item.summary)) {
    return true;
  }
  const commandText = [
    item.summary,
    ...(item.evidence ?? []).filter((ref) => ref.kind === "command").flatMap((ref) => [ref.note, ref.command])
  ].join(" ");
  return /\b(?:exit(?:_code)?=|exit\s+)(?:[1-9]\d*)\b/i.test(commandText) || /\bstatus=failed\b/i.test(commandText);
}

function failedValidationEvidence(input: BuildHumanReviewInput): RisksModel["test_evidence"] {
  return input.packet.risks.test_evidence.filter(isFailedValidationEvidence);
}

function prRiskMentionsFailedTests(risk: PrRiskCandidate): boolean {
  const evidenceText = risk.evidence
    .flatMap((ref) => compactStrings([ref.note, ref.command, ref.test_name, ref.path, ref.acai_id]))
    .join(" ");
  return /\b(fail(?:ed|ing)?|error)\b/i.test(`${risk.summary} ${evidenceText}`);
}

function scorePrRisk(risk: PrRiskCandidate, anchor: QueueAnchor): number {
  return severityWeight(risk.severity) + ruleWeight(risk.rule) + (anchor.line_start ? 10 : 0) + (anchor.hunk_header ? 10 : 0);
}

function severityWeight(severity: PacketSeverity): number {
  switch (severity) {
    case "critical":
      return 100;
    case "high":
      return 75;
    case "medium":
      return 40;
    case "low":
      return 15;
    default:
      return 5;
  }
}

function ruleWeight(rule: PrRiskCandidate["rule"] | undefined): number {
  if (!rule) {
    return 0;
  }
  return PR_RISK_RULE_METADATA[rule].review_queue_weight;
}

function titleForPrRisk(risk: PrRiskCandidate): string {
  return PR_RISK_RULE_METADATA[risk.rule].title;
}

function rankReasonForPrRisk(risk: PrRiskCandidate): string {
  return `Ranked from deterministic PR risk rule ${risk.rule} with ${risk.severity} severity.`;
}

function titleFromSummary(summary: string): string {
  const first = summary.split(/[.:]/)[0]?.trim();
  if (!first) {
    return "Packet risk";
  }
  return first.length <= 80 ? first : `${first.slice(0, 77)}...`;
}

function titleForChangedFile(file: PrChangedFile): string {
  if (file.role === "doc" && isSourceOfTruthReviewDoc(file.path)) {
    return "Changed source-of-truth document";
  }
  switch (file.role) {
    case "implementation":
      return "Changed implementation file";
    case "test":
      return "Changed test file";
    case "ci":
      return "Changed CI file";
    case "config":
      return "Changed configuration file";
    case "spec":
      return "Changed contract or spec file";
    default:
      return "Changed review file";
  }
}

function actionForChangedFile(file: PrChangedFile): string {
  if (file.role === "doc" && isSourceOfTruthReviewDoc(file.path)) {
    return `Inspect ${file.path} for reviewer workflow, requirement, or product-contract changes.`;
  }
  switch (file.role) {
    case "implementation":
      return `Inspect ${file.path} and confirm the changed behavior is covered by existing or co-changed tests.`;
    case "test":
      return `Inspect ${file.path} to confirm the new or changed test exercises the intended behavior.`;
    case "ci":
      return `Inspect ${file.path} for workflow permissions, checkout boundaries, and reviewer-facing side effects.`;
    case "config":
      return `Inspect ${file.path} for configuration contract or runtime behavior changes.`;
    case "spec":
      return `Inspect ${file.path} for public requirement, schema, or workflow contract changes.`;
    default:
      return `Inspect ${file.path} before approving.`;
  }
}

function changedFileQueueWeight(file: PrChangedFile): number {
  switch (file.role) {
    case "ci":
      return 72;
    case "implementation":
      return 68;
    case "spec":
    case "config":
      return 60;
    case "test":
      return 50;
    case "doc":
      return isSourceOfTruthReviewDoc(file.path) ? 46 : 0;
    default:
      return 0;
  }
}

function isSourceOfTruthReviewDoc(filePath: string): boolean {
  const normalizedPath = normalizeEvidencePath(filePath);
  return (
    /(^|\/)AGENTS\.md$/.test(normalizedPath) ||
    /(^|\/)CLAUDE\.md$/.test(normalizedPath) ||
    normalizedPath === "README.md" ||
    normalizedPath === "README.bootstrap.md" ||
    normalizedPath === "docs/review-surfaces-trd.md" ||
    normalizedPath === "docs/dogfooding.md" ||
    /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(normalizedPath)
  );
}

function priorityForChangedFile(file: PrChangedFile): HumanReviewPriority {
  return file.role === "test" ? "low" : "medium";
}

function affectedRequirementIdsForFile(prSurface: PrReviewSurfaceModel, file: PrChangedFile): string[] {
  const areas = new Set(changedFileAreas(file));
  const paths = new Set(compactStrings([file.path, file.old_path]).map((filePath) => normalizeEvidencePath(filePath)));
  return prSurface.scope.affected_requirements
    .filter((requirement) =>
      (requirement.group_key && areas.has(requirement.group_key)) ||
      affectedRequirementReasons(requirement).some((reason) => reason.path && paths.has(normalizeEvidencePath(reason.path)))
    )
    .map((requirement) => requirement.acai_id ?? requirement.requirement_id)
    .slice(0, 8);
}

function changedFileAreas(file: PrChangedFile): string[] {
  return Array.isArray(file.areas) ? file.areas : [];
}

function affectedRequirementReasons(
  requirement: PrReviewSurfaceModel["scope"]["affected_requirements"][number]
): PrReviewSurfaceModel["scope"]["affected_requirements"][number]["reasons"] {
  return Array.isArray(requirement.reasons) ? requirement.reasons : [];
}

function priorityForSeverity(severity: PacketSeverity): HumanReviewPriority {
  if (severity === "critical") {
    return "blocker";
  }
  if (severity === "high") {
    return "high";
  }
  if (severity === "medium") {
    return "medium";
  }
  return "low";
}

function effortForSeverity(severity: PacketSeverity): "quick" | "moderate" | "deep" {
  if (severity === "critical" || severity === "high") {
    return "deep";
  }
  if (severity === "medium") {
    return "moderate";
  }
  return "quick";
}

function questionFromPrRisk(
  index: number,
  severity: ReviewerQuestion["severity"],
  risk: PrRiskCandidate,
  question: string
): ReviewerQuestion {
  return {
    id: `QUESTION-${String(index).padStart(3, "0")}`,
    severity,
    question,
    reason: risk.summary,
    evidence: evidenceOrMissing(risk.evidence, risk.summary),
    maps_to_risks: [risk.id],
    maps_to_requirements: requirementIds(risk.evidence)
  };
}

function commentDraftsForPrRisk(input: BuildHumanReviewInput, risk: PrRiskCandidate): SuggestedCommentDraft[] {
  const path = firstPathEvidence(risk.evidence)?.path;
  switch (risk.rule) {
    case "coverage_regression":
      return [commentDraftFromPrRisk(input, "blocking", risk, "Coverage regressed for this PR. Can you add or point to validation that restores the regressed requirement coverage before approval?")];
    case "untested_changed_impl":
      return [commentDraftFromPrRisk(input, "clarifying", risk, `What test or existing fixture covers the behavior changed in ${path ?? "this implementation file"}?`)];
    case "unmapped_change":
      return [commentDraftFromPrRisk(input, "clarifying", risk, "This change is outside the mapped review areas. Can you confirm whether it is intentional and add a review-area mapping or explicit deferral if needed?")];
    case "privacy_sensitive_change":
      return [commentDraftFromPrRisk(input, "blocking", risk, "This touches privacy, provider, redaction, secret, or token-handling code. Can you add or point to sensitive-input validation before approval?")];
    case "comment_surface_change":
      return [commentDraftFromPrRisk(input, "non_blocking", risk, "Please include or inspect a rendered comment/human surface fixture so reviewers can verify the Markdown output directly.")];
    case "ci_secret_boundary_change":
      // The merge-readiness blocker is the canonical suggested comment for this manual-check gate.
      return [];
    case "schema_contract_change":
      return [commentDraftFromPrRisk(input, "blocking", risk, "This changes a persisted schema or artifact contract. Can you add a compatibility fixture for an existing generated artifact, or explicitly version this as a breaking change?")];
    case "deleted_or_renamed_surface":
      return [commentDraftFromPrRisk(input, "clarifying", risk, "This deletes or renames a generated or reviewer-facing surface. Can you confirm no stale imports, generated references, or reviewer links still point to the old path?")];
    case "failed_or_skipped_test":
      if (failedValidationEvidence(input).length > 0 && prRiskMentionsFailedTests(risk)) {
        return [];
      }
      return [commentDraftFromPrRisk(input, "blocking", risk, "Validation evidence indicates failed or skipped tests. Can you fix the failures or record why the skipped tests are intentional before approval?")];
    case "large_diff":
      return [commentDraftFromPrRisk(input, "non_blocking", risk, "This is a large diff. Consider splitting it or listing the areas that received deeper owner review.")];
  }
}

function commentDraftFromPrRisk(
  input: BuildHumanReviewInput,
  severity: SuggestedReviewComment["severity"],
  risk: PrRiskCandidate,
  body: string
): SuggestedCommentDraft {
  const first = firstPathEvidence(risk.evidence);
  return stripUndefined({
    severity,
    path: first?.path,
    line_start: first?.line_start,
    line_end: first?.line_end,
    body,
    evidence: evidenceOrMissing(risk.evidence, risk.summary),
    risk_ids: [risk.id],
    requirement_ids: requirementIdsForPrRisk(input, risk),
    confidence: "medium" as const,
    ready_to_post: true
  });
}

function compareSuggestedCommentCandidates(
  left: SuggestedCommentCandidate,
  right: SuggestedCommentCandidate
): number {
  return (
    suggestedCommentSeverityRank(left.draft.severity) - suggestedCommentSeverityRank(right.draft.severity) ||
    (left.sourceRank - right.sourceRank) ||
    severityWeight(right.risk?.severity ?? "unknown") - severityWeight(left.risk?.severity ?? "unknown") ||
    ruleWeight(right.risk?.rule) - ruleWeight(left.risk?.rule) ||
    compareStrings(left.sortKey, right.sortKey)
  );
}

function suggestedCommentSeverityRank(severity: SuggestedReviewComment["severity"]): number {
  switch (severity) {
    case "blocking":
      return 0;
    case "clarifying":
      return 1;
    case "non_blocking":
      return 2;
  }
}

function firstPathEvidence(evidence: EvidenceRef[]): EvidenceRef | undefined {
  return evidence.find((ref) => typeof ref.path === "string" && ref.path.length > 0);
}

function firstPathEvidenceInScope(evidence: EvidenceRef[], changedPaths: Set<string>): EvidenceRef | undefined {
  for (const ref of evidence) {
    if (typeof ref.path !== "string") {
      continue;
    }
    const normalizedPath = normalizeEvidencePath(ref.path);
    if (changedPaths.has(normalizedPath)) {
      return normalizedPath === ref.path ? ref : { ...ref, path: normalizedPath };
    }
  }
  return undefined;
}

interface DiffIndex {
  byPath: Map<string, DiffIndexEntry>;
}

interface DiffIndexEntry {
  file: StructuredDiffFile;
  side: "old" | "new";
}

interface QueueAnchor {
  path: string;
  old_path?: string;
  hunk_header?: string;
  line_start?: number;
  line_end?: number;
}

function buildDiffIndex(diff: StructuredDiff | undefined): DiffIndex | undefined {
  if (!diff || diff.files.length === 0) {
    return undefined;
  }
  const byPath = new Map<string, DiffIndexEntry>();
  for (const file of diff.files) {
    byPath.set(normalizeEvidencePath(file.path), { file, side: file.status === "D" ? "old" : "new" });
    if (file.old_path) {
      byPath.set(normalizeEvidencePath(file.old_path), { file, side: "old" });
    }
  }
  return { byPath };
}

function queueAnchorForEvidence(evidence: EvidenceRef, diffIndex: DiffIndex | undefined): QueueAnchor {
  const path = normalizeEvidencePath(String(evidence.path));
  const fallbackRange = normalizedEvidenceRange(evidence);
  const fallback = stripUndefined({
    path,
    line_start: fallbackRange?.line_start,
    line_end: fallbackRange?.line_end
  });
  if (!diffIndex) {
    return fallback;
  }
  const entry = diffIndex.byPath.get(path);
  if (!entry) {
    return fallback;
  }
  const { file: diffFile, side } = entry;
  const anchorPath = anchorPathForSide(diffFile, side);
  const hunk = hunkForEvidence(diffFile, evidence, side) ?? (fallbackRange ? undefined : firstChangedHunk(diffFile));
  if (!hunk) {
    return stripUndefined({
      path: anchorPath,
      old_path: oldPathForAnchor(diffFile, anchorPath),
      line_start: fallbackRange?.line_start,
      line_end: fallbackRange?.line_end
    });
  }
  const changedRange = fallbackRange ?? changedLineRange(hunk, side);
  return stripUndefined({
    path: anchorPath,
    old_path: oldPathForAnchor(diffFile, anchorPath),
    hunk_header: formatHunkHeader(hunk),
    line_start: changedRange?.line_start,
    line_end: changedRange?.line_end
  });
}

function hunkForEvidence(
  diffFile: StructuredDiffFile,
  evidence: EvidenceRef,
  side: "old" | "new"
): StructuredDiffHunk | undefined {
  if (!evidence.line_start) {
    return undefined;
  }
  const range = normalizedEvidenceRange(evidence);
  if (!range) {
    return undefined;
  }
  return diffFile.hunks.find((hunk) => hunkOverlapsRange(hunk, side, range.line_start, range.line_end));
}

function normalizedEvidenceRange(evidence: EvidenceRef): { line_start: number; line_end: number } | undefined {
  if (!evidence.line_start || evidence.line_start < 1) {
    return undefined;
  }
  const lineEnd = evidence.line_end && evidence.line_end >= evidence.line_start ? evidence.line_end : evidence.line_start;
  return { line_start: evidence.line_start, line_end: lineEnd };
}

function hunkOverlapsRange(
  hunk: StructuredDiffHunk,
  side: "old" | "new",
  lineStart: number,
  lineEnd: number
): boolean {
  const hunkStart = side === "old" ? hunk.old_start : hunk.new_start;
  const hunkLines = side === "old" ? hunk.old_lines : hunk.new_lines;
  const hunkEnd = hunkStart + Math.max(hunkLines, 1) - 1;
  return hunkStart > 0 && hunkStart <= lineEnd && hunkEnd >= lineStart;
}

function firstChangedHunk(diffFile: StructuredDiffFile): StructuredDiffHunk | undefined {
  return diffFile.hunks.find((hunk) => hunk.lines.some((line) => line.kind === "add" || line.kind === "delete"));
}

function changedLineRange(hunk: StructuredDiffHunk, side: "old" | "new"): { line_start: number; line_end: number } | undefined {
  let lineStart: number | undefined;
  let lineEnd: number | undefined;
  for (const line of hunk.lines) {
    const lineNumber = side === "old" ? line.old_line : line.new_line;
    const wantedKind = side === "old" ? "delete" : "add";
    if (line.kind !== wantedKind || typeof lineNumber !== "number" || lineNumber <= 0) {
      continue;
    }
    lineStart = lineStart === undefined ? lineNumber : Math.min(lineStart, lineNumber);
    lineEnd = lineEnd === undefined ? lineNumber : Math.max(lineEnd, lineNumber);
  }
  if (lineStart === undefined || lineEnd === undefined) {
    return undefined;
  }
  return { line_start: lineStart, line_end: lineEnd };
}

function formatHunkHeader(hunk: StructuredDiffHunk): string {
  return `@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@`;
}

function anchorPathForSide(diffFile: StructuredDiffFile, side: "old" | "new"): string {
  return side === "old" && diffFile.old_path ? diffFile.old_path : diffFile.path;
}

function oldPathForAnchor(diffFile: StructuredDiffFile, anchorPath: string): string | undefined {
  return diffFile.old_path && diffFile.old_path !== anchorPath ? diffFile.old_path : undefined;
}

function prChangedFilePaths(prSurface: PrReviewSurfaceModel): Set<string> {
  return new Set(
    prSurface.scope.changed_files.flatMap((file) =>
      compactStrings([file.path, file.old_path]).map((filePath) => normalizeEvidencePath(filePath))
    )
  );
}

function evidenceOrMissing(evidence: EvidenceRef[], fallback: string): EvidenceRef[] {
  return evidence.length ? evidence : [missingEvidence(fallback)];
}

function requirementIds(evidence: EvidenceRef[]): string[] {
  return compactStrings(evidence.map((ref) => ref.acai_id));
}

function compactStrings(values: Array<string | undefined>): string[] {
  return uniqueTruthy(values).filter((value): value is string => typeof value === "string");
}

function riskIdsFromBlocker(blocker: ReviewBlocker): string[] {
  const match = blocker.id.match(/(PR-RISK-\d+|RISK-\d+)/);
  return match ? [match[1]] : [];
}

function questionSeverityForRisk(severity: PacketSeverity): ReviewerQuestion["severity"] {
  return severity === "critical" || severity === "high" ? "blocking" : "clarifying";
}

function hasRecordedCiSecretBoundaryManualCheck(input: BuildHumanReviewInput): boolean {
  return recordedManualCheckRecords(input).some((record) => looksLikeRecordedCiSecretBoundaryManualCheck(record.text));
}

function recordedManualCheckEvidence(input: BuildHumanReviewInput, requiredManualCheck: string): EvidenceRef[] {
  const requiredTokens = normalizedManualCheckTokens(requiredManualCheck);
  if (requiredTokens.length === 0) {
    return [];
  }
  for (const record of recordedManualCheckRecords(input)) {
    if (!looksLikePositiveManualCheckRecord(record.text)) {
      continue;
    }
    const textTokens = new Set(normalizedManualCheckTokens(record.text));
    if (requiredTokens.every((token) => textTokens.has(token))) {
      return record.evidence;
    }
  }
  return [];
}

function recordedManualCheckRecords(input: BuildHumanReviewInput): ManualCheckRecord[] {
  const headSha = currentHeadSha(input);
  return [
    ...input.packet.risks.test_evidence
      .filter((item) => item.kind === "direct" || item.kind === "indirect")
      .flatMap((item) => manualCheckEvidenceRecords(item.evidence ?? [], headSha)),
    ...(input.feedback ?? [])
      .filter((feedbackFile) => feedbackFileAppliesToHead(feedbackFile, headSha))
      .flatMap((feedbackFile) =>
        (feedbackFile.validation?.notes ?? []).map((note, index) => ({
          text: note,
          evidence: [
            feedbackEvidence(feedbackFile.path, note, {
              eventId: `validation-note:${index + 1}`,
              sha: headSha
            })
          ]
        }))
      )
  ];
}

function feedbackFileAppliesToHead(feedbackFile: FeedbackFile, headSha: string): boolean {
  return headSha !== "unknown" && feedbackFile.head_sha === headSha;
}

function looksLikePositiveManualCheckRecord(value: string): boolean {
  const normalized = value.toLowerCase();
  if (/\b(?:unable|could not|cannot|can't)\s+(?:to\s+)?(?:confirm|verify)\b/.test(normalized)) {
    return false;
  }
  if (/\bnot\s+(?:confirmed|verified|safe|completed|recorded|reviewed|inspected)\b/.test(normalized)) {
    return false;
  }
  if (/\bno\s+(?:manual\s+)?check\s+(?:recorded|completed|reviewed|inspected|verified)\b/.test(normalized)) {
    return false;
  }
  if (/\b(?:failed|unsafe|unverified|unconfirmed|unresolved|pending|planned|planning|todo|missing evidence|no evidence)\b/.test(normalized)) {
    return false;
  }
  if (/\b(?:reviewed|inspected)\s+(?:whether|if|to)\b/.test(normalized)) {
    return false;
  }
  return (
    /\bmanual check\s+(?:recorded|completed|confirmed|verified|passed)\b/.test(normalized) ||
    /\b(?:confirmed|verified)\b.*\b(?:safe|isolated|cannot access|no secrets?|does not leak|protected)\b/.test(normalized) ||
    /\b(?:reviewed|inspected)\b.*\b(?:confirmed|verified|safe|no secrets?|cannot access|does not leak)\b/.test(normalized)
  );
}

function normalizedManualCheckTokens(value: string): string[] {
  return uniqueTruthy(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !MANUAL_CHECK_TOKEN_STOP_WORDS.has(token))
  );
}

function currentHeadSha(input: BuildHumanReviewInput): string {
  const manifest = input.packet.manifest as { head_sha?: unknown };
  return input.prSurface?.scope.head_sha ?? stringOr(manifest.head_sha, "unknown");
}

function manualCheckEvidenceRecords(evidence: EvidenceRef[], headSha: string): ManualCheckRecord[] {
  if (headSha === "unknown") {
    return [];
  }
  return evidence
    .filter((ref) => ref.kind === "feedback" && ref.validation_status !== "invalid" && ref.sha === headSha)
    .flatMap((ref) =>
      compactStrings([ref.note]).map((text) => ({
        text,
        evidence: [ref]
      }))
    );
}

function focusedRequirementGaps(input: BuildHumanReviewInput): RequirementGap[] {
  return input.packet.evaluation.results
    .filter((result) => result.status !== "satisfied")
    .filter((result) => {
      const id = result.acai_id ?? result.requirement_id;
      return id.includes(".HUMAN_REVIEW.") || id.includes(".HUMAN_TRUST.");
    })
    .sort(compareRequirementGapPriority);
}

function compareRequirementGapPriority(left: RequirementGap, right: RequirementGap): number {
  return (
    requirementGapPriority(left) - requirementGapPriority(right) ||
    compareStrings(left.acai_id ?? left.requirement_id, right.acai_id ?? right.requirement_id)
  );
}

function requirementGapPriority(gap: RequirementGap): number {
  const id = gap.acai_id ?? gap.requirement_id;
  if (gap.status === "invalid_evidence") {
    return 0;
  }
  if (gap.status === "missing") {
    return 1;
  }
  if (id.includes(".HUMAN_TRUST.")) {
    return 2;
  }
  return 3;
}

function requirementGapEvidence(gap: RequirementGap): EvidenceRef[] {
  return evidenceOrMissing(
    [...(gap.evidence ?? []), ...(gap.missing_evidence ?? [])],
    `${gap.acai_id ?? gap.requirement_id} needs evidence.`
  );
}

function compareMissingGapPriority(
  left: MissingAutomaticTestGap | MissingManualCheckGap,
  right: MissingAutomaticTestGap | MissingManualCheckGap
): number {
  return (
    missingGapPriority(left) - missingGapPriority(right) ||
    compareStrings(left.acai_id ?? left.requirement_id ?? left.id, right.acai_id ?? right.requirement_id ?? right.id)
  );
}

function missingGapPriority(gap: MissingAutomaticTestGap | MissingManualCheckGap): number {
  const id = gap.acai_id ?? gap.requirement_id ?? "";
  if (id.includes(".HUMAN_TRUST.")) {
    return 0;
  }
  if (id.includes(".HUMAN_REVIEW.")) {
    return 1;
  }
  if (id.includes(".PRIVACY.") || id.includes(".PROVIDERS.") || id.includes(".SCHEMA.")) {
    return 2;
  }
  return 3;
}

function suggestedTestFile(acaiId: string | undefined, suggested: string): string | undefined {
  return suggestedTestFileFromKeywords(`${acaiId ?? ""} ${suggested}`);
}

function suggestedTestFileForPath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const normalizedPath = normalizeEvidencePath(filePath);
  const shared = suggestedTestFileFromKeywords(normalizedPath);
  if (shared) {
    return shared;
  }
  const lower = normalizedPath.toLowerCase();
  if (!lower.startsWith("src/")) {
    return undefined;
  }
  const basename = normalizedPath.split("/").pop()?.replace(/\.[cm]?[tj]sx?$/, "");
  return basename ? `tests/${basename}.test.ts` : undefined;
}

function suggestedTestFileFromKeywords(value: string): string | undefined {
  const lower = value.toLowerCase();
  if (lower.includes("schema")) {
    return "tests/schema-contract.test.ts";
  }
  if (lower.includes("human")) {
    return "tests/human-review.test.ts";
  }
  if (lower.includes("pr-risks")) {
    return "tests/pr-risks.test.ts";
  }
  if (lower.includes("pr-scope")) {
    return "tests/pr-scope.test.ts";
  }
  if (lower.includes("pr-comment")) {
    return "tests/pr-comment.test.ts";
  }
  if (lower.includes("pr-narrative")) {
    return "tests/pr-narrative.test.ts";
  }
  if (lower.includes("render/") || lower.includes("comment")) {
    return "tests/render.test.ts";
  }
  if (lower.includes("privacy") || lower.includes("redact") || lower.includes("secret")) {
    return "tests/privacy.test.ts";
  }
  if (lower.includes("provider")) {
    return "tests/provider.test.ts";
  }
  if (lower.includes("coverage")) {
    return "tests/scoped-coverage.test.ts";
  }
  if (lower.includes("provider")) {
    return "tests/provider.test.ts";
  }
  if (/\bpr\b|pr-surface/.test(lower)) {
    return "tests/pr-surface-e2e.test.ts";
  }
  if (lower.includes("render/") || lower.includes("render") || lower.includes("comment")) {
    return "tests/render.test.ts";
  }
  return undefined;
}

function isSkimSafeCandidate(filePath: string, role: string): boolean {
  if (filePath === "pnpm-lock.yaml") {
    return true;
  }
  if (role === "generated") {
    return true;
  }
  if (role !== "doc") {
    return false;
  }
  if (isSourceOfTruthReviewDoc(filePath)) {
    return false;
  }
  const lower = filePath.toLowerCase();
  return !lower.includes("feature") && !lower.includes("trd") && !lower.includes("proposal") && !lower.includes("agents.md");
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

function dedupeQuestions(items: ReviewerQuestion[]): ReviewerQuestion[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.question;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeComments(items: SuggestedReviewComment[]): SuggestedReviewComment[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = suggestedCommentDedupeKey(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function suggestedCommentDedupeKey(item: SuggestedReviewComment): string {
  return `${item.severity}:${item.path ?? ""}:${item.body}`;
}

function dedupeTests(items: TestPlanItem[]): TestPlanItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = testPlanDedupeKey(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function testPlanDedupeKey(item: TestPlanItem): string {
  return `${item.kind}:${item.suggested_file ?? ""}:${item.scenario}`;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
