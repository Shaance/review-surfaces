import { compareStrings } from "../core/compare";
import { stripUndefined, uniqueTruthy } from "../core/guards";
import { EvidenceRef, fileEvidence, missingEvidence } from "../evidence/evidence";
import { normalizeEvidencePath } from "../evidence/validate";
import { PrRiskCandidate, PrReviewSurfaceModel, StructuredDiff, StructuredDiffFile, StructuredDiffHunk } from "../pr/contract";
import { PR_RISK_RULE_METADATA } from "../pr/risk-metadata";
import { ReviewPacket } from "../render/packet";
import { looksLikeRecordedCiSecretBoundaryManualCheck } from "../risks/manual-checks";
import { RiskItem, RisksModel } from "../risks/risks";
import type { PacketConfidence, PacketSeverity } from "../schema/review-packet-contract";
import {
  HUMAN_REVIEW_SCHEMA_VERSION,
  HumanReviewDecision,
  HumanReviewModel,
  HumanReviewPriority,
  HumanReviewVerdict,
  HumanReviewVerdictReason,
  MissingEvidenceSummary,
  ReviewBlocker,
  ReviewerQuestion,
  SuggestedReviewComment,
  TestPlanItem,
  TrustAudit
} from "./contract";

export interface BuildHumanReviewInput {
  packet: ReviewPacket;
  prSurface?: PrReviewSurfaceModel;
  diff?: StructuredDiff;
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

type RequirementGap = ReviewPacket["evaluation"]["results"][number];
type MissingAutomaticTestGap = NonNullable<RisksModel["missing_automatic_tests"]>[number];
type MissingManualCheckGap = NonNullable<RisksModel["missing_manual_checks"]>[number];
type PrChangedFile = PrReviewSurfaceModel["scope"]["changed_files"][number];

const MAX_QUEUE = 20;
const MAX_BLOCKERS = 8;
const MAX_QUESTIONS = 10;
const MAX_COMMENTS = 10;
const MAX_TEST_PLAN = 12;
const MAX_TRUST_ITEMS = 10;
const MAX_FOCUSED_REQUIREMENT_TESTS = 6;
const MAX_CHANGED_FILE_QUEUE = 8;

export function buildHumanReview(input: BuildHumanReviewInput): HumanReviewModel {
  const blockers = buildBlockers(input);
  const reviewQueue = buildReviewQueue(input);
  const questions = buildQuestions(input, blockers);
  const suggestedComments = buildSuggestedComments(input, blockers);
  const trustAudit = buildTrustAudit(input);
  const testPlan = buildTestPlan(input);
  const skimSafe = buildSkimSafe(input);
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

function buildBlockers(input: BuildHumanReviewInput): ReviewBlocker[] {
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

  const failedTestEvidence = input.packet.risks.test_evidence.filter(isFailedValidationEvidence);
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

  return dedupeById(blockers).slice(0, MAX_BLOCKERS);
}

function buildReviewQueue(input: BuildHumanReviewInput): HumanReviewModel["review_queue"] {
  const drafts: QueueDraft[] = [];
  const prChangedPaths = input.prSurface ? prChangedFilePaths(input.prSurface) : undefined;
  const diffIndex = buildDiffIndex(input.diff);

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    const first = firstPathEvidence(risk.evidence);
    if (!first) {
      continue;
    }
    const anchor = queueAnchorForEvidence(first, diffIndex);
    drafts.push({
      title: titleForPrRisk(risk),
      path: anchor.path,
      old_path: anchor.old_path,
      hunk_header: anchor.hunk_header,
      line_start: anchor.line_start,
      line_end: anchor.line_end,
      reviewer_action: risk.suggested_checks[0] ?? "Inspect the cited changed file before approving.",
      reason: rankReasonForPrRisk(risk),
      evidence: evidenceOrMissing(risk.evidence, risk.summary),
      requirement_ids: requirementIds(risk.evidence),
      risk_ids: [risk.id],
      confidence: anchor.line_start || anchor.hunk_header ? "high" : "medium",
      priority: priorityForSeverity(risk.severity),
      estimated_review_effort: effortForSeverity(risk.severity),
      score: scorePrRisk(risk, anchor),
      sortKey: `${risk.id}:${first.path}`
    });
  }

  if (input.prSurface && input.prSurface.risks.candidates.length === 0) {
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
      const areas = file.areas.length ? file.areas.join(", ") : "unmapped area";
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

function buildQuestions(input: BuildHumanReviewInput, blockers: ReviewBlocker[]): ReviewerQuestion[] {
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
  const focusedGaps = focusedRequirementGaps(input);

  for (const blocker of blockers) {
    comments.push({
      id: `SC-${String(comments.length + 1).padStart(3, "0")}`,
      severity: "blocking",
      path: firstPathEvidence(blocker.evidence)?.path,
      body: blocker.required_action,
      evidence: blocker.evidence,
      risk_ids: riskIdsFromBlocker(blocker),
      requirement_ids: requirementIds(blocker.evidence),
      confidence: "high",
      ready_to_post: blocker.evidence.length > 0
    });
  }

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    if (comments.length >= MAX_COMMENTS) {
      break;
    }
    if (risk.rule === "schema_contract_change") {
      comments.push(commentFromPrRisk(comments.length + 1, "blocking", risk, "This changes a persisted schema or artifact contract. Can you add a compatibility fixture for an existing generated artifact, or explicitly version this as a breaking change?"));
    } else if (risk.rule === "untested_changed_impl") {
      comments.push(commentFromPrRisk(comments.length + 1, "clarifying", risk, `What test or existing fixture covers the behavior changed in ${firstPathEvidence(risk.evidence)?.path ?? "this implementation file"}?`));
    } else if (risk.rule === "comment_surface_change") {
      comments.push(commentFromPrRisk(comments.length + 1, "non_blocking", risk, "Please include or inspect a rendered comment/human surface fixture so reviewers can verify the Markdown output directly."));
    }
  }

  if (hasNoValidationEvidence(input.packet.risks) && comments.length < MAX_COMMENTS) {
    comments.push({
      id: `SC-${String(comments.length + 1).padStart(3, "0")}`,
      severity: "clarifying",
      body: "I do not see direct validation evidence in the packet. Can you record the relevant test/typecheck command transcript or parsed test output?",
      evidence: [missingEvidence("No direct or indirect validation evidence found.")],
      risk_ids: [],
      requirement_ids: [],
      confidence: "medium",
      ready_to_post: true
    });
  }

  if (comments.length < MAX_COMMENTS) {
    const focusedGap = focusedGaps[0];
    if (focusedGap) {
      comments.push({
        id: `SC-${String(comments.length + 1).padStart(3, "0")}`,
        severity: focusedGap.status === "missing" || focusedGap.status === "invalid_evidence" ? "blocking" : "clarifying",
        body: `Can you point to the validation evidence or explicit deferral for ${focusedGap.acai_id ?? focusedGap.requirement_id}? The human review surface currently marks it as ${focusedGap.status}.`,
        evidence: requirementGapEvidence(focusedGap),
        risk_ids: [],
        requirement_ids: compactStrings([focusedGap.acai_id, focusedGap.requirement_id]),
        confidence: "medium",
        ready_to_post: true
      });
    }
  }

  return dedupeComments(comments).slice(0, MAX_COMMENTS);
}

function buildTrustAudit(input: BuildHumanReviewInput): TrustAudit {
  const verified = positiveValidationEvidence(input.packet.risks).slice(0, MAX_TRUST_ITEMS).map((evidence, index) => ({
    id: `TRUST-VERIFIED-${String(index + 1).padStart(3, "0")}`,
    summary: evidence.note ?? evidence.command ?? evidence.test_name ?? "Verified validation evidence is present.",
    evidence: [evidence]
  }));

  if (input.prSurface) {
    verified.push({
      id: `TRUST-VERIFIED-${String(verified.length + 1).padStart(3, "0")}`,
      summary: `PR scope contains ${input.prSurface.scope.changed_files.length} changed file(s), ${input.prSurface.scope.affected_requirements.length} affected requirement(s), and ${input.prSurface.risks.candidates.length} deterministic PR risk candidate(s).`,
      evidence: input.prSurface.scope.changed_files.slice(0, 5).map((file) => fileEvidence(file.path, "Changed file included in PR scope."))
    });
  }

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
    verified_facts: verified.slice(0, MAX_TRUST_ITEMS),
    claimed_not_verified: claimed,
    missing_evidence: missing,
    invalid_evidence: invalid,
    confidence_summary: confidenceSummary(verified.length, claimed.length, missing.length, invalid.length)
  };
}

function buildTestPlan(input: BuildHumanReviewInput): TestPlanItem[] {
  const items: TestPlanItem[] = [];
  const focusedGaps = focusedRequirementGaps(input);

  for (const risk of input.prSurface?.risks.candidates ?? []) {
    if (risk.rule === "schema_contract_change") {
      items.push({
        id: `TEST-${String(items.length + 1).padStart(3, "0")}`,
        kind: "automatic",
        priority: "required",
        suggested_file: "tests/schema-contract.test.ts",
        scenario: "Load a previous valid human or PR review surface fixture and validate it against the current schema.",
        expected_result: "The fixture validates, or the schema version is intentionally bumped for a breaking contract change.",
        command: "pnpm run test -- tests/schema-contract.test.ts",
        maps_to_requirements: requirementIds(risk.evidence),
        maps_to_risks: [risk.id],
        evidence_gap: risk.summary
      });
    } else if (risk.rule === "ci_secret_boundary_change" && !hasRecordedCiSecretBoundaryManualCheck(input)) {
      items.push({
        id: `TEST-${String(items.length + 1).padStart(3, "0")}`,
        kind: "manual",
        priority: "required",
        scenario: "Inspect workflow/provider/comment-posting changes for the CI secret boundary.",
        expected_result: "Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets, and secret-bearing steps run only from trusted code.",
        maps_to_requirements: requirementIds(risk.evidence),
        maps_to_risks: [risk.id],
        evidence_gap: "No manual CI secret-boundary check is recorded."
      });
    } else if (risk.rule === "comment_surface_change") {
      items.push({
        id: `TEST-${String(items.length + 1).padStart(3, "0")}`,
        kind: "automatic",
        priority: "recommended",
        suggested_file: "tests/pr-comment.test.ts",
        scenario: "Render the changed reviewer-facing Markdown surface from a deterministic fixture.",
        expected_result: "The Markdown stays bounded, evidence-backed, and avoids whole-packet fallback in PR mode.",
        command: "pnpm run test -- tests/pr-comment.test.ts",
        maps_to_requirements: requirementIds(risk.evidence),
        maps_to_risks: [risk.id],
        evidence_gap: risk.summary
      });
    }
  }

  for (const gap of focusedGaps.slice(0, MAX_FOCUSED_REQUIREMENT_TESTS)) {
    if (items.length >= MAX_TEST_PLAN) {
      break;
    }
    const requirementId = gap.acai_id ?? gap.requirement_id;
    const suggestedFile = suggestedTestFile(requirementId, gap.summary);
    items.push({
      id: `TEST-${String(items.length + 1).padStart(3, "0")}`,
      kind: "automatic",
      priority: gap.status === "missing" || gap.status === "invalid_evidence" ? "required" : "recommended",
      suggested_file: suggestedFile,
      scenario: `Add a focused unit or fixture test tied to ${requirementId}.`,
      expected_result: "The generated human review JSON and Markdown retain deterministic, evidence-backed behavior for this requirement.",
      command: suggestedFile ? `pnpm run test -- ${suggestedFile}` : "pnpm run test",
      maps_to_requirements: compactStrings([gap.acai_id, gap.requirement_id]),
      maps_to_risks: [],
      evidence_gap: gap.summary
    });
  }

  for (const gap of [...(input.packet.risks.missing_automatic_tests ?? [])].sort(compareMissingGapPriority)) {
    if (items.length >= MAX_TEST_PLAN) {
      break;
    }
    const suggestedFile = suggestedTestFile(gap.acai_id, gap.suggested_test);
    items.push({
      id: `TEST-${String(items.length + 1).padStart(3, "0")}`,
      kind: "automatic",
      priority: "recommended",
      suggested_file: suggestedFile,
      scenario: gap.suggested_test,
      expected_result: "The packet records direct or requirement-specific test evidence for the mapped requirement.",
      command: suggestedFile ? `pnpm run test -- ${suggestedFile}` : "pnpm run test",
      maps_to_requirements: compactStrings([gap.acai_id, gap.requirement_id]),
      maps_to_risks: [],
      evidence_gap: gap.summary
    });
  }

  for (const gap of [...(input.packet.risks.missing_manual_checks ?? [])].sort(compareMissingGapPriority)) {
    if (items.length >= MAX_TEST_PLAN) {
      break;
    }
    items.push({
      id: `TEST-${String(items.length + 1).padStart(3, "0")}`,
      kind: "manual",
      priority: "recommended",
      scenario: gap.manual_check,
      expected_result: "Reviewer records the files inspected, conclusion, and any follow-up action.",
      maps_to_requirements: compactStrings([gap.acai_id, gap.requirement_id]),
      maps_to_risks: [],
      evidence_gap: gap.summary
    });
  }

  return dedupeTests(items).slice(0, MAX_TEST_PLAN);
}

function buildSkimSafe(input: BuildHumanReviewInput): HumanReviewModel["skim_safe"] {
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

  return (input.prSurface?.scope.changed_files ?? [])
    .filter((file) => !highRiskPaths.has(file.path))
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
  return input.packet.evaluation.results
    .filter((result) => result.status === "invalid_evidence")
    .slice(0, MAX_TRUST_ITEMS)
    .map((result, index) => ({
      id: `INVALID-${String(index + 1).padStart(3, "0")}`,
      summary: `${result.acai_id ?? result.requirement_id}: ${result.summary}`,
      evidence: [...result.evidence, ...result.missing_evidence]
    }));
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

function ruleWeight(rule: PrRiskCandidate["rule"]): number {
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
      return 42;
    default:
      return 0;
  }
}

function priorityForChangedFile(file: PrChangedFile): HumanReviewPriority {
  return file.role === "test" ? "low" : "medium";
}

function affectedRequirementIdsForFile(prSurface: PrReviewSurfaceModel, file: PrChangedFile): string[] {
  const areas = new Set(file.areas);
  return prSurface.scope.affected_requirements
    .filter((requirement) => requirement.group_key && areas.has(requirement.group_key))
    .map((requirement) => requirement.acai_id ?? requirement.requirement_id)
    .slice(0, 8);
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

function commentFromPrRisk(
  index: number,
  severity: SuggestedReviewComment["severity"],
  risk: PrRiskCandidate,
  body: string
): SuggestedReviewComment {
  const first = firstPathEvidence(risk.evidence);
  return stripUndefined({
    id: `SC-${String(index).padStart(3, "0")}`,
    severity,
    path: first?.path,
    line_start: first?.line_start,
    line_end: first?.line_end,
    body,
    evidence: evidenceOrMissing(risk.evidence, risk.summary),
    risk_ids: [risk.id],
    requirement_ids: requirementIds(risk.evidence),
    confidence: "medium" as const,
    ready_to_post: risk.evidence.length > 0
  });
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
  const headSha = currentHeadSha(input);
  return input.packet.risks.test_evidence
    .filter((item) => item.kind === "direct" || item.kind === "indirect")
    .flatMap((item) => manualCheckEvidenceText(item.evidence ?? [], headSha))
    .some((text) => looksLikeRecordedCiSecretBoundaryManualCheck(text));
}

function currentHeadSha(input: BuildHumanReviewInput): string {
  const manifest = input.packet.manifest as { head_sha?: unknown };
  return input.prSurface?.scope.head_sha ?? stringOr(manifest.head_sha, "unknown");
}

function manualCheckEvidenceText(evidence: EvidenceRef[], headSha: string): string[] {
  if (headSha === "unknown") {
    return [];
  }
  return evidence
    .filter((ref) => ref.kind === "feedback" && ref.validation_status !== "invalid" && ref.sha === headSha)
    .flatMap((ref) => compactStrings([ref.note]));
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
  const haystack = `${acaiId ?? ""} ${suggested}`.toLowerCase();
  if (haystack.includes("schema")) {
    return "tests/schema-contract.test.ts";
  }
  if (haystack.includes("human")) {
    return "tests/human-review.test.ts";
  }
  if (haystack.includes("render") || haystack.includes("comment")) {
    return "tests/render.test.ts";
  }
  if (haystack.includes("provider") || /\bpr\b|pr-surface/.test(haystack)) {
    return "tests/pr-surface-e2e.test.ts";
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
    const key = `${item.severity}:${item.path ?? ""}:${item.body}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeTests(items: TestPlanItem[]): TestPlanItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.suggested_file ?? ""}:${item.scenario}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
