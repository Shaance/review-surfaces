import path from "node:path";
import { writeJson, writeText } from "../core/files";
import { EvidenceRef } from "../evidence/evidence";
import { redactSecrets } from "../privacy/secrets";
import { StructuredDiff } from "../pr/contract";
import type { ConversationAnalysis, ReviewerInsight } from "../contracts/conversation-review";
import { renderHunkExcerpt } from "./hunk-excerpt";
import { coverageHunkForAnchor, coverageSummaryLine } from "./coverage-gutter";
import { escapeMarkdownLiteral, markdownInlineCode } from "../render/markdown-literal";
import { renderDependencyTreeText } from "../diagrams/dep-tree";
import { extractAcids, fillAcidTemplate, normalizeAcidTemplate, RollupGroup, rollupBy } from "./rollup";
import { RISK_LENS_METADATA } from "./contract";
import {
  decisionFindingPresentation,
  decisionIntentSourceLabel,
  decisionProjectionHeading,
  EMPTY_DECISION_FINDINGS_TEXT,
  incompleteReviewScopeText
} from "./decision-projection-presentation";
import {
  conversationAnalysisCaveats,
  conversationAnalysisContextRows,
  conversationEvidenceStateLabel,
  conversationInsightBasisLabel,
  conversationInsightCitationGroups,
  conversationReviewPresentation,
  presentableConversationInsights
} from "./conversation-review-presentation";
import type {
  EvidenceCard,
  HumanReviewModel,
  IntentMismatchItem,
  MissingEvidenceSummary,
  ReviewQueueItem,
  RiskLensFinding,
  SinceLastReview,
  SinceLastReviewItem,
  SuggestedCommentSeverity,
  SuggestedReviewComment,
  TestPlanItem,
  TrustAudit
} from "./contract";
import { partitionSupportingPreview, SUPPORTING_PREVIEW_LIMIT } from "./primary-surface-policy";
import {
  decisionLabel,
  formatQueueLocation,
  rankingReasonsAreDefaultOnly
} from "./review-presentation";

export {
  conversationAnalysisCaveats,
  conversationAnalysisContextRows,
  conversationEvidenceStateLabel,
  conversationInsightBasisLabel,
  conversationInsightCitationGroups,
  conversationReviewPresentation
};
export {
  conversationAnalysisIsPartial,
  conversationReconciliationIncomplete
} from "./conversation-review-presentation";
export type {
  ConversationCitationGroup,
  ConversationContextRow,
  ConversationReviewPresentation
} from "./conversation-review-presentation";

// Keep the primary change purpose at the decision-projection/schema contract
// bound. This is the full human artifact; supporting summaries use their own
// smaller preview bounds below.
const MAX_DECISION_PURPOSE_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 600;
const MAX_FIELD_CHARS = 300;
const CONVERSATION_MARKDOWN_CONTROLS = new Set(["\\", "`", "*", "[", "]", "(", ")", "#", "!", "|", "~"]);
const MAX_STANDALONE_EVIDENCE = 8;
const MAX_SINCE_LAST_REVIEW = 5;

// review-surfaces.HUMAN_REVIEW.20: render-time inputs sourced from collected
// diff artifacts (never from the human_review.json model itself), used to inline
// bounded hunk excerpts. Optional so standalone re-renders without a diff still
// work (they simply omit the excerpt).
export interface HumanRenderContext {
  diff?: StructuredDiff;
}

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
    command: "intent-mismatch",
    artifact: "intent_mismatch.md",
    label: "Intent mismatch",
    heading: "# Intent Mismatch",
    render: renderIntentMismatchMarkdown
  },
  {
    command: "evidence-cards",
    artifact: "evidence_cards.md",
    label: "Evidence cards",
    heading: "# Evidence Cards",
    render: renderEvidenceCardsMarkdown
  },
  {
    command: "since-last-review",
    artifact: "since_last_review.md",
    label: "Since last review",
    heading: "# Since Last Review",
    render: renderSinceLastReviewMarkdown
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

export async function writeHumanReviewArtifacts(
  outputDir: string,
  model: HumanReviewModel,
  context: HumanRenderContext = {}
): Promise<void> {
  await writeJson(path.join(outputDir, "human_review.json"), model);
  await writeText(path.join(outputDir, "human_review.md"), renderHumanReviewMarkdown(model, context));
  for (const artifact of HUMAN_STANDALONE_ARTIFACTS) {
    await writeHumanStandaloneArtifact(outputDir, model, artifact, context);
  }
}

export async function writeHumanStandaloneArtifact(
  outputDir: string,
  model: HumanReviewModel,
  artifact: HumanStandaloneArtifact,
  context: HumanRenderContext = {}
): Promise<void> {
  await writeText(path.join(outputDir, artifact.artifact), artifact.render(model, context));
}

export function renderHumanReviewMarkdown(model: HumanReviewModel, context: HumanRenderContext = {}): string {
  const requiredCheckCount = model.test_plan.filter((item) => item.priority === "required").length;
  return `# Human Review

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.
${model.generated_from.uncommitted_files > 0 ? `\n**includes ${model.generated_from.uncommitted_files} uncommitted file(s) (working tree)**\n` : ""}${incompleteReviewScopeText(model.generated_from.omitted_untracked_files ?? 0) ? `\n**${incompleteReviewScopeText(model.generated_from.omitted_untracked_files ?? 0)}**\n` : ""}
## Verdict

**${decisionLabel(model.verdict.decision)}.**

Confidence: ${model.verdict.confidence}.

Approval-changing reasons and actions are listed once below.

${renderDecisionProjectionMarkdown(model)}

## Required checks

${requiredCheckCount > 0 ? `- ${requiredCheckCount} required check(s). See \`test_plan.md\` for exact commands and expected results.` : "- No required checks were generated."}

## Trust summary

${renderTrustSummary(model.trust_audit)}

## Supporting review queue

${renderSupportingReviewQueue(model, partitionSupportingPreview(model.review_queue).preview, context, 1)}
${supportingQueueNote(model.review_queue.length, SUPPORTING_PREVIEW_LIMIT)}

## Supporting artifacts

${renderSupportingArtifactIndex()}
`;
}

function renderSupportingArtifactIndex(): string {
  return [
    "- [Interactive HTML cockpit](human_review.html) — reading order, maps, coverage, trust, and the complete supporting review.",
    "- [`human_review.json`](human_review.json) — schema-validated machine model with every recorded fact.",
    ...HUMAN_STANDALONE_ARTIFACTS.map((artifact) =>
      `- [${artifact.label}](${artifact.artifact}) — focused supporting detail.`
    )
  ].join("\n");
}

function supportingQueueNote(total: number, visibleLimit: number): string {
  const omitted = Math.max(0, total - visibleLimit);
  return omitted > 0
    ? `_${omitted} additional queue item(s) remain in \`review_queue.md\` and \`human_review.json\` as supporting detail._`
    : "";
}

function renderTrustSummary(trust: TrustAudit): string {
  return `${trust.verified_facts.length} verified fact(s); ${trust.claimed_not_verified.length} unverified claim(s); ${trust.missing_evidence.length} missing-evidence item(s); ${trust.invalid_evidence.length} invalid-evidence item(s).`;
}

export function renderDecisionProjectionMarkdown(model: HumanReviewModel): string {
  const projection = model.decision_projection;
  const source = decisionIntentSourceLabel(projection.active_intent.source);
  const findings = projection.findings.length === 0
    ? `- ${EMPTY_DECISION_FINDINGS_TEXT}`
    : projection.findings.map((finding, index) => {
      const row = decisionFindingPresentation(finding);
      const location = row.path ? ` ${markdownInlineCode(field(row.path))}` : "";
      const reason = row.reason ? ` — ${proseField(row.reason)}` : "";
      const evidenceLine = row.evidence.length > 0
        ? `\n   - Evidence: ${row.evidence.map((value) => markdownInlineCode(field(value))).join(", ")}`
        : "";
      return `${index + 1}. **${proseField(row.title)}**${location}${reason}\n   - Review: ${proseField(row.reviewerAction)}${evidenceLine}`;
    }).join("\n");
  const decisionHeading = `## ${decisionProjectionHeading(projection.findings.length)}`;
  return `## Change purpose

${proseField(projection.active_intent.summary, MAX_DECISION_PURPOSE_CHARS)}

_${source}._

${decisionHeading}

${findings}`;
}

/**
 * Reviewer guidance from conversation reconciliation. It is intentionally
 * rendered beside, but never folded into, the deterministic merge verdict.
 */
export function renderConversationInsightsMarkdown(model: HumanReviewModel): string {
  const analysis = model.conversation_analysis;
  const insights = presentableConversationInsights(analysis, model.review_insights);
  return renderConversationReviewMarkdown(analysis, insights);
}

export function renderConversationReviewMarkdown(
  analysis: ConversationAnalysis,
  insights: ReviewerInsight[]
): string {
  const renderField = conversationMarkdownField(field);
  const presentedInsights = presentableConversationInsights(analysis, insights);
  const status = conversationAnalysisStatusLineWithField(analysis, renderField, MAX_SUMMARY_CHARS);
  const context = conversationAnalysisContextMarkdownWithField(analysis, renderField);
  const caveats = conversationAnalysisCaveats(analysis);
  const header = [status, context, caveats.length > 0 ? `**Caveat:** ${caveats.join(" ")}` : ""]
    .filter(Boolean)
    .join("\n\n");
  if (presentedInsights.length === 0) {
    return `${header}\n\n${conversationReviewPresentation(analysis).emptyMessage}`;
  }

  const lines = presentedInsights.map((insight, index) => {
    const evidence = conversationInsightCitationsWithField(insight, renderField, 3);
    return `${index + 1}. **[${conversationEvidenceStateLabel(insight.evidence_state)} · ${renderField(insight.priority, 40)}] ${renderField(insight.title, 180)}**
   - What changed: ${renderField(insight.summary)}
   - Why it matters: ${renderField(insight.why_it_matters)}
   - Review: ${renderField(insight.reviewer_action)}
   - Grounding: ${conversationInsightBasisLabel(insight.basis)}${evidence ? ` Evidence: ${evidence}.` : ""}`;
  });
  return `${header}\n\n${lines.join("\n\n")}`;
}

type ConversationMarkdownField = (value: string, max?: number) => string;

export function conversationAnalysisStatusLine(analysis: ConversationAnalysis): string {
  return conversationAnalysisStatusLineWithField(analysis, conversationMarkdownField(field), MAX_SUMMARY_CHARS);
}

function conversationAnalysisStatusLineWithField(
  analysis: ConversationAnalysis,
  renderField: ConversationMarkdownField,
  summaryLimit: number
): string {
  const presentation = conversationReviewPresentation(analysis);
  const summary = renderField(presentation.summary, summaryLimit);
  return `**${presentation.statusLabel}.** ${presentation.summaryLabel ? `${presentation.summaryLabel}: ${summary}` : summary}`;
}

export function conversationInsightCitations(insight: ReviewerInsight): string {
  return conversationInsightCitationsWithField(insight, conversationMarkdownField(field), 3);
}

function conversationInsightCitationsWithField(
  insight: ReviewerInsight,
  renderField: ConversationMarkdownField,
  limit: number
): string {
  return conversationInsightCitationGroups(insight)
    .map((group) => `${group.label} ${compactCitationValuesWithField(group.values, renderField, limit)}`)
    .join("; ");
}

function conversationMarkdownField(renderField: ConversationMarkdownField): ConversationMarkdownField {
  return (value, max) => neutralizeConversationMarkdown(renderField(value, max));
}

function neutralizeConversationMarkdown(value: string): string {
  const markerPattern = /(\[REDACTED:[a-z_]+\])/g;
  return value.split(markerPattern).map((part) => {
    if (/^\[REDACTED:[a-z_]+\]$/.test(part)) {
      return part;
    }
    const htmlSafe = part
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const markdownSafe = [...htmlSafe]
      .map((character) => CONVERSATION_MARKDOWN_CONTROLS.has(character) ? `\\${character}` : character)
      .join("");
    return markdownSafe
      .replace(/\b(https?|ftp|mailto):/gi, "$1&#58;")
      .replace(/\bwww\./gi, "www&#46;")
      .replace(/@/g, "&#64;");
  }).join("");
}

function conversationAnalysisContextMarkdownWithField(
  analysis: ConversationAnalysis,
  renderField: ConversationMarkdownField
): string {
  return conversationAnalysisContextRows(analysis).map((row) =>
    `- **${row.label}:** ${row.items.map((item) =>
      `${renderField(item.text)} (${compactCitationValuesWithField(item.eventIds, renderField, 3)})`
    ).join("; ")}`
  ).join("\n");
}

function compactCitationValuesWithField(
  values: string[],
  renderField: ConversationMarkdownField,
  limit: number
): string {
  const shown = values.slice(0, limit).map((value) => inlineCodeWithField(value, renderField)).join(", ");
  const omitted = values.length - Math.min(values.length, limit);
  return shown ? `${shown}${omitted > 0 ? ` (+${omitted})` : ""}` : "";
}

function inlineCodeWithField(value: string, renderField: ConversationMarkdownField): string {
  return `\`${renderField(value).replace(/`/g, "'")}\``;
}

export function renderReviewQueueMarkdown(model: HumanReviewModel, context: HumanRenderContext = {}): string {
  return `# Review Queue

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.

${model.review_queue.length === 0 ? "- No path-backed review queue items generated." : model.review_queue.map((item) => renderQueueDetail(model, item, context)).join("\n\n---\n\n")}
`;
}

export function renderSuggestedCommentsMarkdown(model: HumanReviewModel, _context: HumanRenderContext = {}): string {
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

export function renderTrustAuditMarkdown(model: HumanReviewModel, _context: HumanRenderContext = {}): string {
  return `# Trust Audit

## Confidence summary

${field(model.trust_audit.confidence_summary, 1000)}

${renderTrustAuditSections(model.trust_audit, Number.POSITIVE_INFINITY)}
`;
}

export function renderRiskLensesMarkdown(model: HumanReviewModel, _context: HumanRenderContext = {}): string {
  return `# Risk Lenses

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.

${model.risk_lens_findings.length === 0 ? "- No domain risk lenses fired." : model.risk_lens_findings.map(renderRiskLensDetail).join("\n\n---\n\n")}
${renderDependencyChainsSection(model)}`;
}

// review-surfaces.RENDER.13: the attributed dependency chains as an indented
// tree on the supply-chain lens surface. Rendered only when chains exist —
// otherwise the flat transitive facts in the queue remain the honest output.
function renderDependencyChainsSection(model: HumanReviewModel): string {
  const chains = model.dependency_chains ?? [];
  if (chains.length === 0) {
    return "";
  }
  const tree = renderDependencyTreeText(chains)
    .map((line) => field(line, 400))
    .join("\n");
  return `\n## Dependency chains\n\nEach new transitive attributed to the direct dependency that pulled it (lockfile dependency edges):\n\n\`\`\`\n${tree}\n\`\`\`\n`;
}

export function renderIntentMismatchMarkdown(model: HumanReviewModel, _context: HumanRenderContext = {}): string {
  const intent = model.intent_mismatch;
  // review-surfaces.COLD_START.5: in spec-less mode the standalone surface is
  // the note plus the diff-derived observations — no empty spec sections.
  if (intent.spec_note) {
    return `# Intent Mismatch

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.

${field(intent.spec_note)}

## Observed in diff

${renderIntentMismatchItems(intent.observed_in_diff)}

## Provider-claimed candidates (unverified)

${renderIntentMismatchItems(intent.claimed_candidates ?? [])}
`;
  }
  return `# Intent Mismatch

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.

## Expected by spec

${renderIntentMismatchItems(intent.expected_by_spec)}

## Observed in diff

${renderIntentMismatchItems(intent.observed_in_diff)}

## Possible mismatch

${renderIntentMismatchItems(intent.possible_mismatches)}

## Possible overreach

${renderIntentMismatchItems(intent.possible_overreach)}

## Missing intent

${renderIntentMismatchItems(intent.missing_intent)}

## Provider-claimed candidates (unverified)

${renderIntentMismatchItems(intent.claimed_candidates ?? [])}
`;
}

export function renderEvidenceCardsMarkdown(model: HumanReviewModel, _context: HumanRenderContext = {}): string {
  const cards = model.evidence_cards;
  // review-surfaces.HUMAN_REVIEW.19: keep the standalone Markdown readable by
  // collapsing mechanically repeated cards. The complete structured cards stay
  // available in human_review.json and the HTML cockpit.
  return `# Evidence Cards

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.

${renderEvidenceCardsRollupSummary(cards, Number.POSITIVE_INFINITY)}
`;
}

export function renderSinceLastReviewMarkdown(model: HumanReviewModel, _context: HumanRenderContext = {}): string {
  const since = model.since_last_review;
  return `# Since Last Review

Generated from \`${field(model.generated_from.packet_path)}\`.
${since.previous_packet_path ? `Compared against \`${field(since.previous_packet_path)}\`.` : "No previous packet path recorded."}

${since.unavailable_reason ? `${field(since.unavailable_reason)}\n` : ""}
${model.spec_mode === "none" ? "" : `## Improved

${renderSinceLastReviewItems(since.improved)}

## Regressed

${renderSinceLastReviewItems(since.regressed)}

`}## New risks

${renderSinceLastReviewItems(since.new_risks)}

## Resolved risks

${renderSinceLastReviewItems(since.resolved_risks)}
${model.spec_mode === "none" ? "" : `
## New overreach

${renderSinceLastReviewItems(since.new_overreach)}

## Resolved overreach

${renderSinceLastReviewItems(since.resolved_overreach)}
`}

## Still open

${renderSinceLastReviewItems(since.still_open)}
${model.spec_mode === "none" ? "" : `
## Count deltas

${renderSinceLastReviewCountDeltas(since)}
`}`;
}

// review-surfaces.HUMAN_REVIEW.19: the per-item renderer for the standalone
// deep-dive surfaces (test_plan.md and the risk-lens detail). The standalone
// artifacts keep full per-item detail — every item's runnable command, no cap, no
// merge — so this is the surface a reviewer opens to actually run the
// required/recommended checks. The combined human_review.md keeps the rollup.
function renderTestPlan(items: TestPlanItem[]): string {
  if (items.length === 0) {
    return "- No concrete test-plan items generated.";
  }
  return items
    .map((item) => {
      const file = item.suggested_file ? `\n- Suggested file: \`${field(item.suggested_file)}\`` : "";
      const command = item.command ? `\n- Command: \`${field(item.command)}\`` : "";
      // review-surfaces.HUMAN_REVIEW.21: lead with the scenario; kind/priority/id trail.
      return `### ${field(item.scenario)} — ${item.kind} (${item.priority}; ${field(item.id)})

- Expected: ${field(item.expected_result)}${file}${command}
- Evidence gap: ${field(item.evidence_gap)}`;
    })
    .join("\n\n");
}

export function renderTestPlanMarkdown(model: HumanReviewModel, _context: HumanRenderContext = {}): string {
  const groups: Array<[string, TestPlanItem["priority"]]> = [
    ["Required", "required"],
    ["Recommended", "recommended"],
    ["Optional", "optional"]
  ];
  // review-surfaces.HUMAN_REVIEW.19: roll up repeated generated checks before
  // rendering this standalone Markdown. Every item and exact per-item command is
  // retained in human_review.json; the reviewer-facing document should not repeat
  // the same instruction once per requirement. Empty priority buckets are omitted.
  const sections = groups
    .map(([heading, priority]) => [heading, model.test_plan.filter((item) => item.priority === priority)] as const)
    .filter(([, items]) => items.length > 0)
    .map(([heading, items]) => `## ${heading}\n\n${renderTestPlanRollups(items, Number.POSITIVE_INFINITY)}`);
  const body = sections.length ? sections.join("\n\n") : "- No concrete test-plan items generated.";
  return `# Test Plan

Generated from \`${field(model.generated_from.packet_path)}\`.

${body}
`;
}

function renderRiskLensDetail(finding: RiskLensFinding): string {
  const paths = finding.paths.length ? finding.paths.map((filePath) => `\`${field(filePath)}\``).join(", ") : "none";
  const requirements = finding.requirement_ids.length ? finding.requirement_ids.map((id) => `\`${field(id)}\``).join(", ") : "none";
  // review-surfaces.HUMAN_REVIEW.23: omit the empty linked-risk-id line entirely
  // (path-only lenses carry no risk ids) rather than render a "Linked risk IDs:
  // none" placeholder next to the severity line, matching the queue renderer.
  const riskLine = finding.risk_ids.length ? `\nLinked risk IDs: ${finding.risk_ids.map((id) => `\`${field(id)}\``).join(", ")}` : "";
  return `## ${field(RISK_LENS_METADATA[finding.lens].label)} (${field(finding.id)})

Severity: ${finding.severity}
Confidence: ${finding.confidence}
Paths: ${paths}${riskLine}
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

function renderIntentMismatchItems(items: IntentMismatchItem[]): string {
  if (items.length === 0) {
    return "- None recorded.";
  }
  return items.map((item) => {
    const paths = item.paths.length ? item.paths.map((filePath) => `\`${field(filePath)}\``).join(", ") : "none";
    const requirements = item.requirement_ids.length ? item.requirement_ids.map((id) => `\`${field(id)}\``).join(", ") : "none";
    return `- ${field(item.summary, 1000)}
  - Confidence: ${item.confidence}${item.severity ? `; severity: ${item.severity}` : ""}
  - Paths: ${paths}
  - Requirements: ${requirements}
  - Evidence: ${evidenceList(item.evidence)}`;
  }).join("\n");
}

function evidenceCardStatusLabel(status: EvidenceCard["status"]): string {
  switch (status) {
    case "verified":
      return "Verified";
    case "unchecked":
      return "Unchecked direct evidence";
    case "missing_evidence":
      return "Missing evidence";
    case "invalid_evidence":
      return "Invalid evidence";
    case "mixed":
      return "Mixed evidence";
    case "unknown":
      return "Unknown";
  }
}

function renderSinceLastReviewItems(items: SinceLastReviewItem[]): string {
  if (items.length === 0) {
    return "- None recorded.";
  }
  return bullets(
    items.slice(0, MAX_SINCE_LAST_REVIEW).map((item) => {
      const status = formatSinceLastReviewStatus(item);
      const pathPart = item.path ? ` Path: \`${field(item.path)}\`.` : "";
      const severity = item.severity ? ` Severity: ${item.severity}.` : "";
      // review-surfaces.HUMAN_REVIEW.21: lead with the item summary; id/category trail.
      return `${item.summary}${status}${pathPart}${severity} Evidence: ${evidenceList(item.evidence)} (${item.id}; ${item.category})`;
    }),
    "None recorded."
  );
}

function formatSinceLastReviewStatus(item: SinceLastReviewItem): string {
  // review-surfaces.TREND.3: a status-change summary already encodes
  // "prev -> cur", so a separate "Status: prev -> cur." line just duplicates it.
  if (item.previous_status && item.current_status) {
    return "";
  }
  if (item.current_status) {
    return ` Status: ${item.current_status}.`;
  }
  if (item.previous_status) {
    return ` Previous status: ${item.previous_status}.`;
  }
  return "";
}

function renderSinceLastReviewCountDeltas(since: SinceLastReview): string {
  const deltas = since.count_deltas;
  return bullets(
    [
      `satisfied: ${deltas.satisfied.before} -> ${deltas.satisfied.after} (${formatSignedDelta(deltas.satisfied.delta)})`,
      `partial: ${deltas.partial.before} -> ${deltas.partial.after} (${formatSignedDelta(deltas.partial.delta)})`,
      `missing: ${deltas.missing.before} -> ${deltas.missing.after} (${formatSignedDelta(deltas.missing.delta)})`,
      `unknown: ${deltas.unknown.before} -> ${deltas.unknown.after} (${formatSignedDelta(deltas.unknown.delta)})`,
      `invalid_evidence: ${deltas.invalid_evidence.before} -> ${deltas.invalid_evidence.after} (${formatSignedDelta(deltas.invalid_evidence.delta)})`
    ],
    "No count deltas recorded."
  );
}

function formatSignedDelta(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function renderSupportingReviewQueue(
  model: HumanReviewModel,
  items: ReviewQueueItem[],
  context: HumanRenderContext = {},
  excerptLimit = Number.POSITIVE_INFINITY
): string {
  if (items.length === 0) {
    return "- No path-backed review queue items generated.";
  }
  return items
    .map((item, index) => {
      const location = formatQueueLocation(item);
      const excerpt = index < excerptLimit ? inlineHunkExcerpt(item, context) : undefined;
      // When an excerpt renders, its fenced @@ header names the hunk
      // authoritatively, so suppress the separate (possibly stale) Hunk: metadata
      // line to avoid contradictory labels.
      const hunkLine = item.hunk_header && !excerpt ? `   - Hunk: \`${field(item.hunk_header)}\`\n` : "";
      // review-surfaces.COVERAGE.6: one summary line per excerpt with the
      // uncovered ranges — no per-line markup games on markdown surfaces.
      const coverageHunk = excerpt ? coverageHunkForAnchor(model, item.path, item.hunk_header) : undefined;
      const coverageLine = coverageHunk ? `\n   - Coverage: ${field(coverageSummaryLine(coverageHunk))}` : "";
      // review-surfaces.RANKING.5 / HUMAN_REVIEW.23: suppress the default ranking
      // echo and the empty risk trailer rather than printing low-signal filler.
      const rankingLine = rankingReasonsAreDefaultOnly(item) ? "" : `\n   - Why ranked here: ${rankingReasonsLine(item)}`;
      const riskLine = item.risk_ids.length ? `\n   - Risk: ${item.risk_ids.map((risk) => `\`${field(risk)}\``).join(", ")}` : "";
      return `${item.rank}. \`${field(location)}\`
${hunkLine}   - Why it matters: ${field(item.reason)}${rankingLine}
   - Action: ${field(item.reviewer_action)}${excerpt ? `\n${excerpt}` : ""}${coverageLine}${riskLine}
   - Evidence: ${evidenceList(item.evidence)}`;
    })
    .join("\n\n");
}

// review-surfaces.RANKING.2: the "why ranked here" line — the per-item evidence
// signals that moved it up or down. Joined with "; "; older JSON written before
// ranking support degrades to a neutral note rather than an empty line.
function rankingReasonsLine(item: ReviewQueueItem): string {
  const reasons = item.ranking_reasons ?? [];
  return reasons.length > 0 ? field(reasons.join("; "), 600) : "ranked by deterministic risk severity";
}

// review-surfaces.RANKING.5: the "why ranked here" block earns its place only when
// it carries a real evidence signal (a co-changed test, an untested path, a
// coverage verdict). When the sole reason is the default severity echo ("ranked by
// high risk severity with a precise diff anchor") it merely restates the Priority
// line, so the render suppresses the block. The JSON model stays populated
// (RANKING.2 + schema minItems:1).
// review-surfaces.HUMAN_REVIEW.20: render a bounded, indented fenced diff
// excerpt for a queue item that carries hunk/line anchors. Returns "" when no
// diff context or no matching hunk is available so the queue item degrades to
// its anchor metadata.
function inlineHunkExcerpt(item: ReviewQueueItem, context: HumanRenderContext): string {
  const excerpt = renderHunkExcerpt(context.diff, {
    path: item.path,
    old_path: item.old_path,
    hunk_header: item.hunk_header,
    line_start: item.line_start,
    line_end: item.line_end,
    side: item.anchor_side
  });
  if (!excerpt) {
    return "";
  }
  // Indent the fenced block under the queue list item so it nests visually.
  return excerpt
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}

function renderQueueDetail(model: HumanReviewModel, item: ReviewQueueItem, context: HumanRenderContext = {}): string {
  // review-surfaces.COVERAGE.6: the standalone queue artifact carries the same
  // one-line coverage summary as the supporting queue surface.
  const coverageHunkDetail = coverageHunkForAnchor(model, item.path, item.hunk_header);
  const coverageDetailLine = coverageHunkDetail ? `Coverage: ${field(coverageSummaryLine(coverageHunkDetail))}\n\n` : "";
  const location = formatQueueLocation(item);
  // review-surfaces.HUMAN_REVIEW.23: an empty `Requirements: none` / `Risks: none`
  // trailer is pure filler, and a bare `Risks: none` next to a high-severity
  // ranking line even reads as a false "no risk" claim. Omit each trailer line
  // when it has no IDs; a present line then means "here are the linked IDs".
  const requirements = item.requirement_ids.length ? item.requirement_ids.map((id) => `\`${field(id)}\``).join(", ") : null;
  const risks = item.risk_ids.length ? item.risk_ids.map((id) => `\`${field(id)}\``).join(", ") : null;
  const trailer = [requirements ? `Requirements: ${requirements}` : "", risks ? `Risks: ${risks}` : ""].filter(Boolean).join("\n");
  // review-surfaces.RANKING.5: drop the "Why ranked here" block when it is only
  // the default severity echo (it restates the Priority line above).
  const rankingBlock = rankingReasonsAreDefaultOnly(item) ? "" : `Why ranked here:\n${rankingReasonsLine(item)}\n\n`;
  const excerpt = renderHunkExcerpt(context.diff, {
    path: item.path,
    old_path: item.old_path,
    hunk_header: item.hunk_header,
    line_start: item.line_start,
    line_end: item.line_end,
    side: item.anchor_side
  });
  // review-surfaces.HUMAN_REVIEW.21: lead the heading with the changed file and
  // observable behavior; the queue id trails as metadata. When an excerpt
  // renders, suppress the separate (possibly stale) Hunk: line — the fenced
  // excerpt header is authoritative.
  return `## ${field(item.title)} — \`${field(location)}\` (${field(item.id)})

Priority: ${item.priority}
Confidence: ${item.confidence}
File: \`${field(location)}\`
${item.hunk_header && !excerpt ? `Hunk: \`${field(item.hunk_header)}\`\n` : ""}
${item.old_path ? `Old path: \`${field(item.old_path)}\`\n` : ""}
Why this matters:
${field(item.reason, 1000)}

${rankingBlock}Reviewer action:
${field(item.reviewer_action, 1000)}
${excerpt ? `\n${excerpt}\n` : ""}${coverageDetailLine}Evidence:
${evidenceBullets(item.evidence, MAX_STANDALONE_EVIDENCE)}${trailer ? `\n\n${trailer}` : ""}`;
}

// review-surfaces.HUMAN_REVIEW.25: a suggested comment that already names its
// path in the heading gains nothing from an "Evidence: <that same path>" line.
// Keep only evidence that adds something — a different file, a line range, or a
// non-file evidence kind — so a present Evidence line means "here is a second
// source", not an echo.
function distinctCommentEvidence(item: SuggestedReviewComment): EvidenceRef[] {
  if (!item.path) {
    return item.evidence;
  }
  return item.evidence.filter((ref) => ref.path !== item.path || Boolean(ref.line_start) || (Boolean(ref.kind) && ref.kind !== "file"));
}

function renderSuggestedComments(items: SuggestedReviewComment[]): string {
  if (items.length === 0) {
    return "- No suggested comments generated.";
  }
  return items
    .map((item) => {
      const pathLine = item.path ? `\nPath: \`${field(item.path)}\`\n` : "\n";
      const distinctEvidence = distinctCommentEvidence(item);
      const evidenceBlock = distinctEvidence.length ? `\nEvidence: ${evidenceList(distinctEvidence)}\n` : "";
      // review-surfaces.HUMAN_REVIEW.21: lead with the comment severity (and
      // path when present); the SC id trails as metadata.
      return `### ${suggestedCommentSeverityLabel(item.severity)} comment${item.path ? ` on \`${field(item.path)}\`` : ""} (${field(item.id)})${pathLine}
> ${field(item.body, 800)}
${evidenceBlock}
Ready to post: ${item.ready_to_post ? "yes" : "no"}.`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// review-surfaces.HUMAN_REVIEW.19: rollups for the default human_review.md
// surface. Items that are identical modulo Acai ID render once, listing the
// affected ACIDs. The JSON model and standalone artifacts keep per-item detail;
// only this entrypoint surface aggregates so a reviewer is not shown the same
// templated sentence per requirement.
// ---------------------------------------------------------------------------

// review-surfaces.HUMAN_REVIEW.22: build the rollup-key contribution for a
// test-plan item's command with its FILE-SPECIFIC part removed, so two items
// that differ only by which suggested file they touch (and therefore by the
// `pnpm run test -- ${suggestedFile}` command derived from it) merge into one
// heading. The suggested_file substring is removed from the command before
// ACID-normalizing the remainder, so `pnpm run test -- tests/a.test.ts` and
// `pnpm run test -- tests/b.test.ts` produce the same key contribution (the
// shared `pnpm run test --` stem). The verbatim per-item command stays in the
// JSON model and standalone test_plan.md.
function normalizeCommandTemplate(command: string, suggestedFile: string | undefined): string {
  if (!command) {
    return "";
  }
  const fileStripped =
    suggestedFile && suggestedFile.length > 0 ? command.split(suggestedFile).join("") : command;
  return normalizeAcidTemplate(fileStripped);
}

function renderTestPlanRollups(items: TestPlanItem[], maxGroups: number): string {
  if (items.length === 0) {
    return "- No concrete test-plan items generated.";
  }
  // Roll up the FULL list first, then cap the number of rendered groups, so a
  // distinct item beyond the raw item cap is not hidden behind earlier
  // duplicates (review-surfaces.HUMAN_REVIEW.19).
  // review-surfaces.HUMAN_REVIEW.22: the rollup KEY deliberately omits BOTH
  // suggested_file AND the per-file command derived from it. Items that are
  // identical except for which file they touch (the common api_contract /
  // schema-lens fan-out) carry a FILE-SPECIFIC command too — e.g.
  // apiContractTestPlanDrafts builds `pnpm run test -- ${suggestedFile}`. If the
  // key still keyed on command, those items would NOT merge after suggested_file
  // was dropped, and the surface would STILL emit a duplicate visually identical
  // `### <evidence_gap>` heading per file. So normalize the file-specific part
  // out of the command before keying (and drop it entirely if the command is
  // nothing but that per-file suffix): items that differ only by suggested_file
  // and its derived command merge into ONE heading that lists the affected files.
  // The per-item suggested_file/command stays in the JSON model and the
  // standalone test_plan.md (extends HUMAN_REVIEW.19/.21).
  const groups = rollupBy(
    items,
    (item) =>
      [
        item.kind,
        item.priority,
        normalizeAcidTemplate(item.scenario),
        normalizeAcidTemplate(item.expected_result),
        normalizeCommandTemplate(item.command ?? "", item.suggested_file),
        normalizeAcidTemplate(item.evidence_gap)
      ].join("|"),
    // Extract ACIDs from every field the rollup key normalizes, so two items
    // merged on an ACID in the expected result or command still list it.
    (item) => rollupAcids(item.maps_to_requirements, item.scenario, item.evidence_gap, item.expected_result, item.command ?? "")
  );
  return groups.slice(0, maxGroups).map(renderTestPlanRollup).join("\n\n");
}

function renderTestPlanRollup(group: RollupGroup<TestPlanItem>): string {
  const rep = group.representative;
  const scenario = fillAcidTemplate(normalizeAcidTemplate(rep.scenario), group.acids);
  const expected = fillAcidTemplate(normalizeAcidTemplate(rep.expected_result), group.acids);
  // Lead with the evidence gap (the distinguishing reason this test is needed)
  // so near-identical scenarios do not render as repeated headings; the generic
  // scenario action moves to a bullet. review-surfaces.HUMAN_REVIEW.19/.21.
  const gap = fillAcidTemplate(normalizeAcidTemplate(rep.evidence_gap), group.acids);
  // review-surfaces.HUMAN_REVIEW.22: the rollup KEY no longer includes
  // suggested_file, so a group may merge items that touch different files. List
  // every distinct suggested file under one heading (singular/plural label) so
  // the reviewer sees the full affected-file set without a duplicate heading per
  // file. Per-item files are still preserved in the JSON model / test_plan.md.
  const distinctFiles = [...new Set(group.items.map((item) => item.suggested_file).filter((f): f is string => Boolean(f)))];
  const file =
    distinctFiles.length === 0
      ? ""
      : distinctFiles.length === 1
        ? `\n- Suggested file: \`${field(distinctFiles[0])}\``
        : `\n- Suggested files (${distinctFiles.length}): ${distinctFiles.map((f) => `\`${field(f)}\``).join(", ")}`;
  // Fill the command through the same ACID template as the other fields, so a
  // rollup that merged items differing only by an ACID in the command does not
  // show a command naming just the first requirement (the exact per-item command
  // stays in the standalone test_plan.md). A single-item / single-file group
  // restores the verbatim command. review-surfaces.HUMAN_REVIEW.22: when the
  // group merged items touching MORE THAN ONE distinct file (the api-contract
  // fan-out), the per-file commands genuinely differ and the rep's command names
  // only its own file. Rendering the rep's command would misrepresent the merged
  // set; stripping the file from it (as an earlier round did) yields a
  // file-less, NON-RUNNABLE stem like `pnpm run test --` that can mislead a
  // reviewer into running an empty/unrelated check. So OMIT the `- Command:`
  // line entirely for the merged multi-file case — the listed files above carry
  // the affected set, and the exact per-file commands stay in the JSON model /
  // test_plan.md. Single-file (or single-item) groups still render their real,
  // runnable command.
  const command =
    rep.command && distinctFiles.length <= 1
      ? `\n- Command: \`${field(fillAcidTemplate(normalizeAcidTemplate(rep.command), group.acids))}\``
      : "";
  const requirements = group.acids.length
    ? `\n- Requirements (${group.acids.length}): ${group.acids.map((acid) => `\`${field(acid)}\``).join(", ")}`
    : "";
  const ids = group.items.map((item) => `\`${field(item.id)}\``).join(", ");
  return `### ${field(gap)} — ${rep.kind} (${rep.priority})${requirements}
- Add test: ${field(scenario)}
- Expected: ${field(expected)}${file}${command}
- Items: ${ids}`;
}

function renderEvidenceCardsRollupSummary(cards: EvidenceCard[], maxGroups: number): string {
  if (cards.length === 0) {
    return "- No evidence cards were generated.";
  }
  // Roll up the full list, then cap rendered groups (review-surfaces.HUMAN_REVIEW.19).
  const groups = rollupBy(
    cards,
    (card) => `${card.status}|${card.priority}|${normalizeAcidTemplate(card.summary)}|${normalizeAcidTemplate(card.reviewer_action)}`,
    (card) => rollupAcids(card.requirement_ids, card.summary, card.reviewer_action)
  );
  return bullets(
    groups.slice(0, maxGroups).map((group) => {
      const card = group.representative;
      const summary = fillAcidTemplate(normalizeAcidTemplate(card.summary), group.acids);
      const action = fillAcidTemplate(normalizeAcidTemplate(card.reviewer_action), group.acids);
      const requirements = group.acids.length ? ` Requirements: ${group.acids.map((acid) => `\`${field(acid)}\``).join(", ")}.` : "";
      const ids = group.items.map((item) => `\`${field(item.id)}\``).join(", ");
      // Keep the direct/missing/invalid evidence mix visible (unioned across the
      // group) so the reviewer can tell from human_review.md whether the rollup
      // is backed by proof, missing evidence, or invalid evidence.
      const counts = `direct ${uniqueEvidenceCount(group.items.flatMap((item) => item.direct_evidence))}, ` +
        `missing ${uniqueEvidenceCount(group.items.flatMap((item) => item.missing_evidence))}, ` +
        `invalid ${uniqueEvidenceCount(group.items.flatMap((item) => item.invalid_evidence))}`;
      return `${endSentence(summary)} Action: ${endSentence(action)}${requirements} [${evidenceCardStatusLabel(card.status)}; ${card.priority}; evidence: ${counts}] (${ids})`;
    }),
    "No evidence cards generated."
  );
}

function renderTrustMissingRollups(items: MissingEvidenceSummary[], limit: number): string {
  if (items.length === 0) {
    return "- No missing evidence recorded.";
  }
  const groups = rollupBy(
    items,
    (item) => normalizeAcidTemplate(item.summary),
    // Collect ACIDs from the structured evidence metadata as well as the summary
    // text, so a gap that carries its requirement only in EvidenceRef.acai_id
    // still contributes to the rolled-up Requirements list.
    (item) => rollupAcids(evidenceAcids(item.evidence), item.summary)
  );
  return bullets(
    groups.slice(0, limit).map((group) => {
      const summary = fillAcidTemplate(normalizeAcidTemplate(group.representative.summary), group.acids);
      const count = group.items.length > 1 ? ` (${group.items.length} requirements)` : "";
      // List the affected ACIDs (as the other rollups do) so the actionable
      // requirement identifiers are not lost on the default surface.
      const requirements = group.acids.length ? ` Requirements: ${group.acids.map((acid) => `\`${field(acid)}\``).join(", ")}.` : "";
      // Union the evidence across the rolled-up gaps, with an omitted-count
      // marker so the line does not look fully evidenced while hiding the other
      // requirements' proof points past the display cap.
      const evidence = evidenceListWithOmission(group.items.flatMap((item) => item.evidence));
      return `${summary}${count}${requirements} Evidence: ${evidence}`;
    }),
    "No missing evidence recorded."
  );
}

// Normalize a clause to end with exactly one sentence terminator so concatenated
// "summary. Action: action." prose never doubles a period.
function endSentence(text: string): string {
  const trimmed = text.replace(/[\s.]+$/, "");
  return trimmed.length === 0 ? "" : `${trimmed}.`;
}

// Acai IDs carried in structured evidence metadata (EvidenceRef.acai_id), used
// by rollups whose items keep the requirement in evidence rather than in prose.
function evidenceAcids(evidence: EvidenceRef[]): string[] {
  return evidence.flatMap((ref) => (ref.acai_id ? [ref.acai_id] : []));
}

// Union of explicitly mapped requirement IDs and any ACIDs embedded in the
// item's templated text, so a rollup lists every affected requirement even when
// the mapping array is sparse.
function rollupAcids(mapped: string[], ...texts: string[]): string[] {
  const acids = new Set<string>(mapped);
  for (const text of texts) {
    for (const acid of extractAcids(text)) {
      acids.add(acid);
    }
  }
  return [...acids];
}

function suggestedCommentSeverityLabel(severity: SuggestedCommentSeverity): string {
  switch (severity) {
    case "blocking":
      return "Blocking";
    case "clarifying":
      return "Clarifying";
    case "non_blocking":
      return "Non-blocking";
  }
}

function renderTrustAuditSections(audit: TrustAudit, limit: number): string {
  // review-surfaces.HUMAN_REVIEW.19: repeated missing-evidence statements are
  // one reviewer concern, not one concern per requirement. Keep all raw entries
  // in human_review.json while the Markdown unions their IDs and evidence.
  const verified = verifiedTrustFacts(audit).slice(0, limit);
  const claimed = unverifiedTrustClaims(audit).slice(0, limit);
  const invalid = invalidTrustEvidence(audit).slice(0, limit);

  return `## Verified facts

${bullets(verified.map((fact) => `${fact.summary} Evidence: ${evidenceList(fact.evidence)}`), "No verified facts recorded.")}

## Claimed but not verified

${bullets(claimed.map((claim) => `${claim.claim} Missing: ${claim.missing_evidence} Evidence: ${evidenceList(claim.evidence)}`), "No unverified claims recorded.")}

## Missing evidence

${renderTrustMissingRollups(missingTrustEvidence(audit), limit)}

## Invalid evidence

${bullets(invalid.map((item) => `${item.summary} Evidence: ${evidenceList(item.evidence)}`), "None recorded.")}`;
}

function evidenceList(evidence: EvidenceRef[]): string {
  if (evidence.length === 0) {
    return "missing";
  }
  return formatUniqueEvidenceRefs(evidence, 4).refs.join(", ");
}

// Like evidenceList, but appends a "(+N more)" marker when distinct refs are
// truncated, so a rolled-up line does not look fully evidenced while hiding the
// remaining grouped pointers.
function evidenceListWithOmission(evidence: EvidenceRef[], limit = 4): string {
  if (evidence.length === 0) {
    return "missing";
  }
  const total = uniqueEvidenceCount(evidence);
  const { refs } = formatUniqueEvidenceRefs(evidence, limit);
  const omitted = total - refs.length;
  return omitted > 0 ? `${refs.join(", ")} (+${omitted} more)` : refs.join(", ");
}

// Count distinct evidence refs (by their rendered location), used to summarize
// the evidence mix of a rolled-up group without double-counting shared refs.
function uniqueEvidenceCount(evidence: EvidenceRef[]): number {
  return new Set(evidence.map(formatEvidenceRef)).size;
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

function proseField(value: string, max = MAX_FIELD_CHARS): string {
  return escapeMarkdownLiteral(field(value, max));
}
