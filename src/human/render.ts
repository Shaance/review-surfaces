import path from "node:path";
import { writeJson, writeText } from "../core/files";
import { EvidenceRef } from "../evidence/evidence";
import { redactSecrets } from "../privacy/secrets";
import { RISK_LENS_METADATA } from "./contract";
import type { FeedbackPolicyEffect, HumanReviewModel, ReviewQueueItem, RiskLensFinding, SuggestedReviewComment, TestPlanItem, TrustAudit } from "./contract";

const MAX_SUMMARY_CHARS = 600;
const MAX_FIELD_CHARS = 300;
const MAX_REVIEW_FIRST = 7;
const MAX_BLOCKERS = 6;
const MAX_QUESTIONS = 8;
const MAX_TRUST = 6;
const MAX_TEST_PLAN = 8;
const MAX_COMMENTS = 6;
const MAX_SKIM_SAFE = 8;
const MAX_STANDALONE_EVIDENCE = 8;
const MAX_RISK_LENSES = 6;

export const HUMAN_STANDALONE_ARTIFACTS = [
  {
    command: "queue",
    artifact: "review_queue.md",
    label: "Review queue",
    heading: "# Review Queue",
    render: renderReviewQueueMarkdown
  },
  {
    command: "comments",
    artifact: "suggested_comments.md",
    label: "Suggested comments",
    heading: "# Suggested Reviewer Comments",
    render: renderSuggestedCommentsMarkdown
  },
  {
    command: "trust",
    artifact: "trust_audit.md",
    label: "Trust audit",
    heading: "# Trust Audit",
    render: renderTrustAuditMarkdown
  },
  {
    command: "risk-lenses",
    artifact: "risk_lenses.md",
    label: "Risk lenses",
    heading: "# Risk Lenses",
    render: renderRiskLensesMarkdown
  },
  {
    command: "test-plan",
    artifact: "test_plan.md",
    label: "Test plan",
    heading: "# Test Plan",
    render: renderTestPlanMarkdown
  }
] as const;

export type HumanStandaloneArtifact = (typeof HUMAN_STANDALONE_ARTIFACTS)[number];

export function humanStandaloneArtifactForCommand(command: string): HumanStandaloneArtifact | undefined {
  return HUMAN_STANDALONE_ARTIFACTS.find((artifact) => artifact.command === command);
}

export async function writeHumanReviewArtifacts(outputDir: string, model: HumanReviewModel): Promise<void> {
  await writeJson(path.join(outputDir, "human_review.json"), model);
  await writeText(path.join(outputDir, "human_review.md"), renderHumanReviewMarkdown(model));
  for (const artifact of HUMAN_STANDALONE_ARTIFACTS) {
    await writeHumanStandaloneArtifact(outputDir, model, artifact);
  }
}

export async function writeHumanStandaloneArtifact(
  outputDir: string,
  model: HumanReviewModel,
  artifact: HumanStandaloneArtifact
): Promise<void> {
  await writeText(path.join(outputDir, artifact.artifact), artifact.render(model));
}

export function renderHumanReviewMarkdown(model: HumanReviewModel): string {
  return `# Human Review

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.

## Verdict

**${decisionLabel(model.verdict.decision)}.**

${field(model.summary, MAX_SUMMARY_CHARS)}

Confidence: ${model.verdict.confidence}.

Reasons:
${bullets(model.verdict.reasons.slice(0, MAX_BLOCKERS).map((reason) => `${reason.id} [${reason.severity}]: ${reason.summary}${reason.required_action ? ` Required action: ${reason.required_action}` : ""}`), "No readiness reasons recorded.")}

## Review first

${renderReviewFirst(model.review_queue.slice(0, MAX_REVIEW_FIRST))}

## Blockers

${renderBlockers(model)}

## Questions for author

${numbered(model.questions.slice(0, MAX_QUESTIONS).map((question) => `${question.question} (${question.severity}; evidence: ${evidenceList(question.evidence)})`), "No reviewer questions generated.")}

## Trust audit

Confidence summary: ${field(model.trust_audit.confidence_summary)}

Verified:
${bullets(verifiedTrustFacts(model.trust_audit).slice(0, MAX_TRUST).map((fact) => `${fact.summary} Evidence: ${evidenceList(fact.evidence)}`), "No verified facts recorded.")}

Claimed but not verified:
${bullets(unverifiedTrustClaims(model.trust_audit).slice(0, MAX_TRUST).map((claim) => `${claim.claim} Missing: ${claim.missing_evidence}`), "No unverified claims recorded.")}

Missing:
${bullets(missingTrustEvidence(model.trust_audit).slice(0, MAX_TRUST).map((item) => `${item.summary} Evidence: ${evidenceList(item.evidence)}`), "No missing evidence recorded.")}

Invalid:
${bullets(invalidTrustEvidence(model.trust_audit).slice(0, MAX_TRUST).map((item) => `${item.summary} Evidence: ${evidenceList(item.evidence)}`), "None recorded.")}

## Risk lenses

${renderRiskLenses(riskLensFindings(model).slice(0, MAX_RISK_LENSES))}

## Test plan

${renderTestPlan(model.test_plan.slice(0, MAX_TEST_PLAN))}

## Suggested comments

${renderSuggestedComments(model.suggested_comments.slice(0, MAX_COMMENTS))}

## Skim-safe

${bullets(model.skim_safe.slice(0, MAX_SKIM_SAFE).map((item) => `\`${field(item.path)}\`: ${item.reason}${item.caveat ? ` Caveat: ${item.caveat}` : ""}`), "No skim-safe files identified.")}

## Feedback memory

${renderFeedbackEffects(model.feedback_effects ?? [])}

## Evidence pointers

${bullets(evidencePointers(model), "No evidence pointers recorded.")}
`;
}

export function renderReviewQueueMarkdown(model: HumanReviewModel): string {
  return `# Review Queue

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.

${model.review_queue.length === 0 ? "- No path-backed review queue items generated." : model.review_queue.map(renderQueueDetail).join("\n\n---\n\n")}
`;
}

export function renderSuggestedCommentsMarkdown(model: HumanReviewModel): string {
  const groups: Array<[string, SuggestedReviewComment["severity"]]> = [
    ["Blocking", "blocking"],
    ["Clarifying", "clarifying"],
    ["Non-blocking", "non_blocking"]
  ];
  return `# Suggested Reviewer Comments

Generated from \`${field(model.generated_from.packet_path)}\`.

${groups.map(([heading, severity]) => `## ${heading}

${renderSuggestedComments(model.suggested_comments.filter((item) => item.severity === severity))}`).join("\n\n")}
`;
}

export function renderTrustAuditMarkdown(model: HumanReviewModel): string {
  return `# Trust Audit

## Confidence summary

${field(model.trust_audit.confidence_summary, 1000)}

${renderTrustAuditSections(model.trust_audit, Number.POSITIVE_INFINITY)}
`;
}

export function renderRiskLensesMarkdown(model: HumanReviewModel): string {
  return `# Risk Lenses

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.

${riskLensFindings(model).length === 0 ? "- No domain risk lenses fired." : riskLensFindings(model).map(renderRiskLensDetail).join("\n\n---\n\n")}
`;
}

export function renderTestPlanMarkdown(model: HumanReviewModel): string {
  const groups: Array<[string, TestPlanItem["priority"]]> = [
    ["Required", "required"],
    ["Recommended", "recommended"],
    ["Optional", "optional"]
  ];
  return `# Test Plan

Generated from \`${field(model.generated_from.packet_path)}\`.

${groups.map(([heading, priority]) => `## ${heading}

${renderTestPlan(model.test_plan.filter((item) => item.priority === priority))}`).join("\n\n")}
`;
}

function renderRiskLenses(findings: RiskLensFinding[]): string {
  if (findings.length === 0) {
    return "- No domain risk lenses fired.";
  }
  return bullets(
    findings.map((finding) => `${finding.id} [${finding.lens}; ${finding.severity}]: ${finding.summary} Action: ${finding.reviewer_action} Evidence: ${evidenceList(finding.evidence)}`),
    "No domain risk lenses fired."
  );
}

function renderRiskLensDetail(finding: RiskLensFinding): string {
  const paths = finding.paths.length ? finding.paths.map((filePath) => `\`${field(filePath)}\``).join(", ") : "none";
  const risks = finding.risk_ids.length ? finding.risk_ids.map((id) => `\`${field(id)}\``).join(", ") : "none";
  const requirements = finding.requirement_ids.length ? finding.requirement_ids.map((id) => `\`${field(id)}\``).join(", ") : "none";
  return `## ${field(finding.id)} - ${field(RISK_LENS_METADATA[finding.lens].label)}

Severity: ${finding.severity}
Confidence: ${finding.confidence}
Paths: ${paths}
Risks: ${risks}
Requirements: ${requirements}

Why this matters:
${field(finding.summary, 1000)}

Reviewer action:
${field(finding.reviewer_action, 1000)}

Evidence:
${evidenceBullets(finding.evidence, MAX_STANDALONE_EVIDENCE)}

Suggested tests:
${renderTestPlan(finding.suggested_tests)}

Suggested comments:
${renderSuggestedComments(finding.suggested_comments)}`;
}

function riskLensFindings(model: HumanReviewModel): RiskLensFinding[] {
  return model.risk_lens_findings ?? [];
}

function renderReviewFirst(items: ReviewQueueItem[]): string {
  if (items.length === 0) {
    return "- No path-backed review queue items generated.";
  }
  return items
    .map((item) => {
      const location = formatQueueLocation(item);
      return `${item.rank}. \`${field(location)}\`
${item.hunk_header ? `   - Hunk: \`${field(item.hunk_header)}\`\n` : ""}   - Action: ${field(item.reviewer_action)}
   - Why ranked: ${field(item.reason)}
   - Risk: ${item.risk_ids.map((risk) => `\`${field(risk)}\``).join(", ") || "none"}
   - Evidence: ${evidenceList(item.evidence)}`;
    })
    .join("\n\n");
}

function renderQueueDetail(item: ReviewQueueItem): string {
  const location = formatQueueLocation(item);
  const requirements = item.requirement_ids.map((id) => `\`${field(id)}\``).join(", ") || "none";
  const risks = item.risk_ids.map((id) => `\`${field(id)}\``).join(", ") || "none";
  return `## ${field(item.id)} - ${field(item.title)}

Priority: ${item.priority}
Confidence: ${item.confidence}
File: \`${field(location)}\`
${item.hunk_header ? `Hunk: \`${field(item.hunk_header)}\`\n` : ""}
${item.old_path ? `Old path: \`${field(item.old_path)}\`\n` : ""}
Why this matters:
${field(item.reason, 1000)}

Reviewer action:
${field(item.reviewer_action, 1000)}

Evidence:
${evidenceBullets(item.evidence, MAX_STANDALONE_EVIDENCE)}

Requirements: ${requirements}
Risks: ${risks}`;
}

function renderBlockers(model: HumanReviewModel): string {
  if (model.blockers.length === 0) {
    return "- No merge blockers generated from deterministic evidence.";
  }
  return bullets(
    model.blockers.slice(0, MAX_BLOCKERS).map((blocker) => `${blocker.summary} Required action: ${blocker.required_action} Evidence: ${evidenceList(blocker.evidence)}`),
    "No merge blockers generated from deterministic evidence."
  );
}

function renderFeedbackEffects(effects: FeedbackPolicyEffect[]): string {
  if (effects.length === 0) {
    return "- No reviewer feedback policy effects applied.";
  }
  return bullets(
    effects.slice(0, 8).map((effect) => {
      const paths = effect.paths.length ? ` Paths: ${effect.paths.map((filePath) => `\`${field(filePath)}\``).join(", ")}.` : "";
      const risks = effect.risk_ids.length ? ` Risks: ${effect.risk_ids.map((id) => `\`${field(id)}\``).join(", ")}.` : "";
      return `${effect.id} [${effect.kind}]: ${effect.summary} Action: ${effect.action}.${paths}${risks} Evidence: ${evidenceList(effect.evidence)}`;
    }),
    "No reviewer feedback policy effects applied."
  );
}

function renderTestPlan(items: TestPlanItem[]): string {
  if (items.length === 0) {
    return "- No concrete test-plan items generated.";
  }
  return items
    .map((item) => {
      const file = item.suggested_file ? `\n- Suggested file: \`${field(item.suggested_file)}\`` : "";
      const command = item.command ? `\n- Command: \`${field(item.command)}\`` : "";
      return `### ${field(item.id)} — ${item.kind} (${item.priority})

- Scenario: ${field(item.scenario)}
- Expected: ${field(item.expected_result)}${file}${command}
- Evidence gap: ${field(item.evidence_gap)}`;
    })
    .join("\n\n");
}

function renderSuggestedComments(items: SuggestedReviewComment[]): string {
  if (items.length === 0) {
    return "- No suggested comments generated.";
  }
  return items
    .map((item) => {
      const pathLine = item.path ? `\nPath: \`${field(item.path)}\`\n` : "\n";
      return `### ${field(item.id)} — ${item.severity}${pathLine}
> ${field(item.body, 800)}

Evidence: ${evidenceList(item.evidence)}

Ready to post: ${item.ready_to_post ? "yes" : "no"}.`;
    })
    .join("\n\n");
}

function renderTrustAuditSections(audit: TrustAudit, limit: number): string {
  const verified = verifiedTrustFacts(audit).slice(0, limit);
  const claimed = unverifiedTrustClaims(audit).slice(0, limit);
  const missing = missingTrustEvidence(audit).slice(0, limit);
  const invalid = invalidTrustEvidence(audit).slice(0, limit);

  return `## Verified facts

${bullets(verified.map((fact) => `${fact.summary} Evidence: ${evidenceList(fact.evidence)}`), "No verified facts recorded.")}

## Claimed but not verified

${bullets(claimed.map((claim) => `${claim.claim} Missing: ${claim.missing_evidence} Evidence: ${evidenceList(claim.evidence)}`), "No unverified claims recorded.")}

## Missing evidence

${bullets(missing.map((item) => `${item.summary} Evidence: ${evidenceList(item.evidence)}`), "No missing evidence recorded.")}

## Invalid evidence

${bullets(invalid.map((item) => `${item.summary} Evidence: ${evidenceList(item.evidence)}`), "None recorded.")}`;
}

function decisionLabel(decision: HumanReviewModel["verdict"]["decision"]): string {
  switch (decision) {
    case "probably_safe":
      return "Probably safe";
    case "reviewable_with_attention":
      return "Reviewable with attention";
    case "needs_author_clarification":
      return "Needs author clarification";
    case "block_before_merge":
      return "Block before merge";
    case "no_signal":
      return "No signal";
  }
}

function evidenceList(evidence: EvidenceRef[]): string {
  if (evidence.length === 0) {
    return "missing";
  }
  return formatUniqueEvidenceRefs(evidence, 4).refs.join(", ");
}

function evidenceBullets(evidence: EvidenceRef[], limit: number): string {
  const { refs, omitted } = formatUniqueEvidenceRefs(evidence, limit);
  return bullets(
    omitted ? [...refs, "Additional evidence ref(s) omitted."] : refs,
    "No evidence recorded."
  );
}

function formatUniqueEvidenceRefs(evidence: EvidenceRef[], limit: number): { refs: string[]; omitted: boolean } {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const ref of evidence) {
    const formatted = formatEvidenceRef(ref);
    if (seen.has(formatted)) {
      continue;
    }
    seen.add(formatted);
    if (refs.length >= limit) {
      return { refs, omitted: true };
    }
    refs.push(formatted);
  }
  return { refs, omitted: false };
}

function formatEvidenceRef(ref: EvidenceRef): string {
  const location = ref.path
    ? `${ref.path}${ref.line_start ? `:${ref.line_start}${ref.line_end && ref.line_end !== ref.line_start ? `-${ref.line_end}` : ""}` : ""}`
    : ref.acai_id ?? ref.test_name ?? ref.command ?? ref.note ?? ref.kind;
  return `\`${field(location)}\``;
}

function bullets(items: string[], emptyText: string): string {
  return items.length ? items.map((item) => `- ${field(item, 900)}`).join("\n") : `- ${emptyText}`;
}

function numbered(items: string[], emptyText: string): string {
  return items.length ? items.map((item, index) => `${index + 1}. ${field(item, 900)}`).join("\n") : `- ${emptyText}`;
}

function evidencePointers(model: HumanReviewModel): string[] {
  return [
    `Packet: \`${field(model.generated_from.packet_path)}\``,
    model.generated_from.pr_surface_path ? `PR surface: \`${field(model.generated_from.pr_surface_path)}\`` : undefined,
    ...HUMAN_STANDALONE_ARTIFACTS.map((artifact) => `${artifact.label}: \`${field(siblingArtifactPath(model.generated_from.packet_path, artifact.artifact))}\``),
    `Base/head: \`${field(model.generated_from.base_ref)}\` -> \`${field(model.generated_from.head_ref)}\``,
    `Head SHA: \`${field(model.generated_from.head_sha)}\``
  ].filter((item): item is string => typeof item === "string");
}

function verifiedTrustFacts(audit: TrustAudit): TrustAudit["verified_facts"] {
  return uniqueBy(
    audit.verified_facts,
    (fact) => `${fact.summary}|${evidenceList(fact.evidence)}`
  );
}

function unverifiedTrustClaims(audit: TrustAudit): TrustAudit["claimed_not_verified"] {
  return uniqueBy(
    audit.claimed_not_verified,
    (claim) => `${claim.claim}|${claim.missing_evidence}|${evidenceList(claim.evidence)}`
  );
}

function missingTrustEvidence(audit: TrustAudit): TrustAudit["missing_evidence"] {
  return uniqueBy(
    audit.missing_evidence,
    (item) => `${item.summary}|${evidenceList(item.evidence)}`
  );
}

function invalidTrustEvidence(audit: TrustAudit): TrustAudit["invalid_evidence"] {
  return uniqueBy(
    audit.invalid_evidence,
    (item) => `${item.summary}|${evidenceList(item.evidence)}`
  );
}

function formatQueueLocation(item: ReviewQueueItem): string {
  return item.line_start
    ? `${item.path}:${item.line_start}${item.line_end && item.line_end !== item.line_start ? `-${item.line_end}` : ""}`
    : item.path;
}

function siblingArtifactPath(packetPath: string, artifact: string): string {
  const dir = path.dirname(packetPath);
  return dir === "." ? artifact : path.join(dir, artifact);
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function field(value: string, max = MAX_FIELD_CHARS): string {
  const redacted = redactSecrets(value).text.replace(/\s+/g, " ").trim();
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 3)}...`;
}
