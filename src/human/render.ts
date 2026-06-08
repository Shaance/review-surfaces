import path from "node:path";
import { writeJson, writeText } from "../core/files";
import { EvidenceRef } from "../evidence/evidence";
import { redactSecrets } from "../privacy/secrets";
import { HumanReviewModel, ReviewQueueItem, SuggestedReviewComment, TestPlanItem } from "./contract";

const MAX_SUMMARY_CHARS = 600;
const MAX_FIELD_CHARS = 300;
const MAX_REVIEW_FIRST = 7;
const MAX_BLOCKERS = 6;
const MAX_QUESTIONS = 8;
const MAX_TRUST = 6;
const MAX_TEST_PLAN = 8;
const MAX_COMMENTS = 6;
const MAX_SKIM_SAFE = 8;

export async function writeHumanReviewArtifacts(outputDir: string, model: HumanReviewModel): Promise<void> {
  await writeJson(path.join(outputDir, "human_review.json"), model);
  await writeText(path.join(outputDir, "human_review.md"), renderHumanReviewMarkdown(model));
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
${bullets(model.trust_audit.verified_facts.slice(0, MAX_TRUST).map((fact) => `${fact.summary} Evidence: ${evidenceList(fact.evidence)}`), "No verified facts recorded.")}

Claimed but not verified:
${bullets(model.trust_audit.claimed_not_verified.slice(0, MAX_TRUST).map((claim) => `${claim.claim} Missing: ${claim.missing_evidence}`), "No unverified claims recorded.")}

Missing:
${bullets(model.trust_audit.missing_evidence.slice(0, MAX_TRUST).map((item) => `${item.summary} Evidence: ${evidenceList(item.evidence)}`), "No missing evidence recorded.")}

Invalid:
${bullets(model.trust_audit.invalid_evidence.slice(0, MAX_TRUST).map((item) => `${item.summary} Evidence: ${evidenceList(item.evidence)}`), "None recorded.")}

## Test plan

${renderTestPlan(model.test_plan.slice(0, MAX_TEST_PLAN))}

## Suggested comments

${renderSuggestedComments(model.suggested_comments.slice(0, MAX_COMMENTS))}

## Skim-safe

${bullets(model.skim_safe.slice(0, MAX_SKIM_SAFE).map((item) => `\`${field(item.path)}\`: ${item.reason}${item.caveat ? ` Caveat: ${item.caveat}` : ""}`), "No skim-safe files identified.")}

## Evidence pointers

- Packet: \`${field(model.generated_from.packet_path)}\`
${model.generated_from.pr_surface_path ? `- PR surface: \`${field(model.generated_from.pr_surface_path)}\`` : ""}
- Base/head: \`${field(model.generated_from.base_ref)}\` -> \`${field(model.generated_from.head_ref)}\`
- Head SHA: \`${field(model.generated_from.head_sha)}\`
`;
}

function renderReviewFirst(items: ReviewQueueItem[]): string {
  if (items.length === 0) {
    return "- No path-backed review queue items generated.";
  }
  return items
    .map((item) => {
      const location = item.line_start ? `${item.path}:${item.line_start}${item.line_end && item.line_end !== item.line_start ? `-${item.line_end}` : ""}` : item.path;
      return `${item.rank}. \`${field(location)}\`
   - Action: ${field(item.reviewer_action)}
   - Why ranked: ${field(item.reason)}
   - Risk: ${item.risk_ids.map((risk) => `\`${field(risk)}\``).join(", ") || "none"}
   - Evidence: ${evidenceList(item.evidence)}`;
    })
    .join("\n\n");
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
  return evidence.slice(0, 4).map(formatEvidenceRef).join(", ");
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

function field(value: string, max = MAX_FIELD_CHARS): string {
  const redacted = redactSecrets(value).text.replace(/\s+/g, " ").trim();
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 3)}...`;
}
