import path from "node:path";
import { writeJson, writeText } from "../core/files";
import { EvidenceRef } from "../evidence/evidence";
import { redactSecrets } from "../privacy/secrets";
import { StructuredDiff } from "../pr/contract";
import { formatEnumChanges, formatTypeChanges } from "../risks/semantic-diff";
import { renderHunkExcerpt } from "./hunk-excerpt";
import { coverageHunkForAnchor, coverageSummaryLine } from "./coverage-gutter";
import { changeMapDetailEmbeds, changeMapMermaidEmbed } from "../render/change-map-embed";
import { esc } from "./esc";
import { renderDependencyTreeText } from "../diagrams/dep-tree";
import { extractAcids, fillAcidTemplate, normalizeAcidTemplate, RollupGroup, rollupBy } from "./rollup";
import { RISK_LENS_METADATA } from "./contract";
import type {
  ChangeNarrative,
  EvidenceCard,
  FeedbackPolicyEffect,
  HumanReviewModel,
  IntentMismatch,
  IntentMismatchItem,
  MissingEvidenceSummary,
  NarrativeClaim,
  ReadingOrder,
  ReviewerQuestion,
  ReviewQueueItem,
  ReviewRoute,
  ReviewRouteStep,
  RiskLensFinding,
  SinceLastReview,
  SinceLastReviewItem,
  SuggestedCommentSeverity,
  SuggestedReviewComment,
  TestPlanItem,
  TrustAudit
} from "./contract";

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
const MAX_EVIDENCE_CARDS = 6;
const MAX_RISK_LENSES = 6;
const MAX_SINCE_LAST_REVIEW = 5;
const MAX_REVIEW_ROUTES = 5;
const MAX_ROUTE_STEPS = 5;

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
    render: renderIntentMismatchMarkdown,
    isSatisfied: (model: HumanReviewModel) => Object.prototype.hasOwnProperty.call(model, "intent_mismatch")
  },
  {
    command: "routes",
    artifact: "review_routes.md",
    label: "Review routes",
    heading: "# Review Routes",
    render: renderReviewRoutesMarkdown,
    isSatisfied: (model: HumanReviewModel) => reviewRoutes(model).length > 0
  },
  {
    command: "evidence-cards",
    artifact: "evidence_cards.md",
    label: "Evidence cards",
    heading: "# Evidence Cards",
    render: renderEvidenceCardsMarkdown,
    isSatisfied: (model: HumanReviewModel) => evidenceCards(model).length > 0
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
  return `# Human Review

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.

## Verdict

**${decisionLabel(model.verdict.decision)}.**

${field(model.summary, MAX_SUMMARY_CHARS)}

Confidence: ${model.verdict.confidence}.

Reasons:
${bullets(model.verdict.reasons.slice(0, MAX_BLOCKERS).map((reason) => `${reason.summary}${reason.required_action ? ` Required action: ${reason.required_action}` : ""} (${reason.id}; ${reason.severity})`), "No readiness reasons recorded.")}

## Reading order

${renderReadingOrderSection(model.reading_order)}

## Change map

${renderChangeMapSection(model)}

## Change narrative

${renderNarrativeSection(model.narrative)}

## Semantic change facts

${renderSemanticFacts(model.semantic_facts)}

## Review first

${renderReviewFirst(model, model.review_queue.slice(0, MAX_REVIEW_FIRST), context)}

## Review routes

${renderReviewRoutesSummary(reviewRoutes(model).slice(0, MAX_REVIEW_ROUTES))}

## Evidence cards

${renderEvidenceCardsRollupSummary(evidenceCards(model), MAX_EVIDENCE_CARDS)}

## Blockers

${renderBlockers(model)}

## Since last review

${renderSinceLastReviewSummary(sinceLastReview(model), model.spec_mode)}

## Coverage evidence

${renderCoverageEvidence(model)}

## Review plan

${renderReviewPlan(model)}

## Intent mismatch

${renderIntentMismatchSummary(intentMismatch(model))}

## Questions for author

${renderQuestionRollups(model.questions, MAX_QUESTIONS)}

## Trust audit

Confidence summary: ${field(model.trust_audit.confidence_summary)}

Verified:
${bullets(verifiedTrustFacts(model.trust_audit).slice(0, MAX_TRUST).map((fact) => `${fact.summary} Evidence: ${evidenceList(fact.evidence)}`), "No verified facts recorded.")}

Claimed but not verified:
${bullets(unverifiedTrustClaims(model.trust_audit).slice(0, MAX_TRUST).map((claim) => `${claim.claim} Missing: ${claim.missing_evidence}`), "No unverified claims recorded.")}

Missing:
${renderTrustMissingRollups(missingTrustEvidence(model.trust_audit), MAX_TRUST)}

Invalid:
${bullets(invalidTrustEvidence(model.trust_audit).slice(0, MAX_TRUST).map((item) => `${item.summary} Evidence: ${evidenceList(item.evidence)}`), "None recorded.")}

## Risk lenses

${renderRiskLenses(riskLensFindings(model).slice(0, MAX_RISK_LENSES))}

## Test plan

${renderTestPlanRollups(model.test_plan, MAX_TEST_PLAN)}

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

${riskLensFindings(model).length === 0 ? "- No domain risk lenses fired." : riskLensFindings(model).map(renderRiskLensDetail).join("\n\n---\n\n")}
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
  const intent = intentMismatch(model);
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

export function renderReviewRoutesMarkdown(model: HumanReviewModel, _context: HumanRenderContext = {}): string {
  const routes = reviewRoutes(model);
  return `# Review Routes

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.

${routes.length === 0 ? "- This human review JSON was generated before review-route support." : routes.map(renderReviewRouteDetail).join("\n\n---\n\n")}
`;
}

export function renderEvidenceCardsMarkdown(model: HumanReviewModel, _context: HumanRenderContext = {}): string {
  const cards = evidenceCards(model);
  return `# Evidence Cards

Generated from \`${field(model.generated_from.packet_path)}\`${model.generated_from.pr_surface_path ? ` and \`${field(model.generated_from.pr_surface_path)}\`` : ""}.

${cards.length === 0 ? "- This human review JSON was generated before evidence-card support." : cards.map(renderEvidenceCardDetail).join("\n\n---\n\n")}
`;
}

export function renderSinceLastReviewMarkdown(model: HumanReviewModel, _context: HumanRenderContext = {}): string {
  const since = sinceLastReview(model);
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

export function renderTestPlanMarkdown(model: HumanReviewModel, _context: HumanRenderContext = {}): string {
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
  // review-surfaces.HUMAN_REVIEW.21: lead with the concern and reviewer action;
  // lens/severity/id trail as metadata.
  return bullets(
    findings.map((finding) => `${finding.summary} Action: ${finding.reviewer_action} Evidence: ${evidenceList(finding.evidence)} (${finding.id}; ${RISK_LENS_METADATA[finding.lens].label}; ${finding.severity})`),
    "No domain risk lenses fired."
  );
}

function renderRiskLensDetail(finding: RiskLensFinding): string {
  const paths = finding.paths.length ? finding.paths.map((filePath) => `\`${field(filePath)}\``).join(", ") : "none";
  const risks = finding.risk_ids.length ? finding.risk_ids.map((id) => `\`${field(id)}\``).join(", ") : "none";
  const requirements = finding.requirement_ids.length ? finding.requirement_ids.map((id) => `\`${field(id)}\``).join(", ") : "none";
  return `## ${field(RISK_LENS_METADATA[finding.lens].label)} (${field(finding.id)})

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

function intentMismatch(model: HumanReviewModel): IntentMismatch {
  return model.intent_mismatch ?? {
    expected_by_spec: [],
    observed_in_diff: [],
    possible_mismatches: [],
    possible_overreach: [],
    missing_intent: []
  };
}

function reviewRoutes(model: HumanReviewModel): ReviewRoute[] {
  return model.review_routes ?? [];
}

function evidenceCards(model: HumanReviewModel): EvidenceCard[] {
  return model.evidence_cards ?? [];
}

function renderReviewRoutesSummary(routes: ReviewRoute[]): string {
  if (routes.length === 0) {
    return "- This human review JSON was generated before review-route support.";
  }
  return bullets(
    routes.map((route) => {
      const flags = [
        route.is_default ? "default" : undefined,
        route.is_secondary ? "secondary" : undefined
      ].filter((flag): flag is string => typeof flag === "string");
      const stepText = route.steps.slice(0, 3).map((step) => step.title).join(" -> ");
      return `${route.title}${flags.length ? ` (${flags.join(", ")})` : ""}: ${route.summary} Path: ${stepText || "no steps recorded."}`;
    }),
    "No review routes generated."
  );
}

function renderIntentMismatchSummary(intent: IntentMismatch): string {
  // review-surfaces.COLD_START.5: spec-less mode replaces the spec-coupled
  // counts and overreach items with the one-line honest note.
  if (intent.spec_note) {
    return bullets([intent.spec_note], "No intent mismatch summary generated.");
  }
  const risky = [...intent.possible_mismatches, ...intent.possible_overreach, ...intent.missing_intent];
  const lines = [
    `${intent.expected_by_spec.length} expected intent item(s), ${intent.observed_in_diff.length} observed changed-file item(s).`,
    `${intent.possible_mismatches.length} possible mismatch item(s), ${intent.possible_overreach.length} possible overreach item(s), ${intent.missing_intent.length} missing-intent item(s).`
  ];
  if (risky.length > 0) {
    for (const [index, item] of risky.slice(0, 3).entries()) {
      lines.push(`Review first ${index + 1}: ${item.summary} Evidence: ${evidenceList(item.evidence)}`);
    }
  } else {
    lines.push("No explicit intent mismatch, overreach, or missing-intent item was identified.");
  }
  return bullets(lines, "No intent mismatch summary generated.");
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

function renderReviewRouteDetail(route: ReviewRoute): string {
  const flags = [
    route.is_default ? "Default: yes" : "Default: no",
    route.is_secondary ? "Secondary: yes" : "Secondary: no"
  ];
  return `## ${field(route.title)}

Persona: ${route.persona}
${flags.join("\n")}

${field(route.summary, 1000)}

${renderReviewRouteSteps(route.steps.slice(0, MAX_ROUTE_STEPS))}`;
}

function renderReviewRouteSteps(steps: ReviewRouteStep[]): string {
  if (steps.length === 0) {
    return "- No route steps recorded.";
  }
  return steps.map((step) => `${step.rank}. ${field(step.title)}
   - Priority: ${step.priority}
   - Action: ${field(step.action, 1000)}
   - Artifact: ${step.artifact ? `\`${field(step.artifact)}\`` : "human_review.md"}
   - Links: ${routeStepLinks(step)}
   - Evidence: ${evidenceList(step.evidence)}`).join("\n\n");
}

function routeStepLinks(step: ReviewRouteStep): string {
  const groups: Array<[string, string[]]> = [
    ["queue", step.queue_item_ids],
    ["lenses", step.risk_lens_ids],
    ["questions", step.question_ids],
    ["tests", step.test_plan_ids],
    ["comments", step.suggested_comment_ids]
  ];
  const rendered = groups
    .filter(([, ids]) => ids.length > 0)
    .map(([label, ids]) => `${label}: ${ids.map((id) => `\`${field(id)}\``).join(", ")}`);
  return rendered.length ? rendered.join("; ") : "none";
}

function renderEvidenceCardDetail(card: EvidenceCard): string {
  const sources = idList(card.source_ids);
  const risks = idList(card.risk_ids);
  const requirements = idList(card.requirement_ids);
  return `## Evidence Card: ${field(card.title)}

Status: ${evidenceCardStatusLabel(card.status)}.
Priority: ${card.priority}
Confidence: ${card.confidence}
Sources: ${sources}
Risks: ${risks}
Requirements: ${requirements}

Summary:
${field(card.summary, 800)}

Evidence:

Direct:
${evidenceBullets(card.direct_evidence, MAX_STANDALONE_EVIDENCE)}

Missing:
${evidenceBullets(card.missing_evidence, MAX_STANDALONE_EVIDENCE)}

Invalid:
${evidenceBullets(card.invalid_evidence, MAX_STANDALONE_EVIDENCE)}

Why it matters:
- ${field(card.why_it_matters, 500)}

Reviewer action:
- ${field(card.reviewer_action, 500)}`;
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

function idList(ids: string[], limit = 6): string {
  if (ids.length === 0) {
    return "none";
  }
  const visible = ids.slice(0, limit).map((id) => `\`${field(id)}\``);
  const omitted = ids.length - visible.length;
  return omitted > 0 ? `${visible.join(", ")}, ... ${omitted} more` : visible.join(", ");
}

function sinceLastReview(model: HumanReviewModel): SinceLastReview {
  return model.since_last_review ?? {
    unavailable_reason: "This human review JSON was generated before since-last-review support.",
    improved: [],
    regressed: [],
    new_risks: [],
    resolved_risks: [],
    new_overreach: [],
    resolved_overreach: [],
    still_open: [],
    count_deltas: {
      satisfied: { before: 0, after: 0, delta: 0 },
      partial: { before: 0, after: 0, delta: 0 },
      missing: { before: 0, after: 0, delta: 0 },
      unknown: { before: 0, after: 0, delta: 0 },
      invalid_evidence: { before: 0, after: 0, delta: 0 }
    }
  };
}

function renderSinceLastReviewSummary(since: SinceLastReview, specMode: HumanReviewModel["spec_mode"] = "acai"): string {
  if (since.unavailable_reason) {
    return bullets([since.unavailable_reason], "No previous packet comparison available.");
  }
  // review-surfaces.COLD_START.5: spec-less comparisons report only the
  // diff-derived risk deltas — no requirement or overreach counts.
  const lines = specMode === "none"
    ? [
        `${since.new_risks.length} new risk(s), ${since.resolved_risks.length} resolved risk(s).`,
        `${since.still_open.length} still-open item(s) to keep in review focus.`
      ]
    : [
        `${since.improved.length} improved requirement(s), ${since.regressed.length} regressed requirement(s).`,
        `${since.new_risks.length} new risk(s), ${since.resolved_risks.length} resolved risk(s).`,
        `${since.new_overreach.length} new overreach item(s), ${since.resolved_overreach.length} resolved overreach item(s).`,
        `${since.still_open.length} still-open item(s) to keep in review focus.`
      ];
  return bullets(lines, "No previous packet comparison available.");
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
  if (item.previous_status && item.current_status) {
    return ` Status: ${item.previous_status} -> ${item.current_status}.`;
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

// review-surfaces.NARRATIVE.1/.3: render the grounded narrative with a per-claim
// trust marker — `✓` for verified (all anchors valid) and `~` for claimed
// (demoted; an anchor is missing/invalid). Each line leads with the claim text
// (reviewer-language); anchors and any invalid anchors trail as metadata.
function renderNarrativeSection(narrative: ChangeNarrative | undefined): string {
  if (!narrative || narrative.claims.length === 0) {
    return "- No grounded narrative available; rely on the verdict and review queue below.";
  }
  const header = `_Source: ${narrative.source} (${narrative.provider}); validated at \`${field(narrative.validated_at_head)}\`. ✓ verified, ~ claimed (unverified anchor)._`;
  const lines = narrative.claims.map((claim) => renderNarrativeClaim(claim));
  return `${header}\n${lines.join("\n")}`;
}

function renderNarrativeClaim(claim: NarrativeClaim): string {
  const marker = claim.trust === "verified" ? "✓" : "~";
  const anchors = claim.anchors.length ? ` (anchors: ${evidenceList(claim.anchors)})` : "";
  const invalid = claim.invalid_anchors.length
    ? ` [claimed; unverified anchor(s): ${claim.invalid_anchors.map((token) => `\`${field(token)}\``).join(", ")}]`
    : "";
  return `- ${marker} ${field(claim.text, 600)}${anchors}${invalid}`;
}

// review-surfaces.SEMANTIC_DIFF.1-4: render the concrete change facts (schema
// contract changes, exported API surface changes, test-weakening signals) near
// the top of the surface, leading with the observable fact (reviewer-language).
function renderSemanticFacts(facts: HumanReviewModel["semantic_facts"]): string {
  const lines: string[] = [];
  for (const signal of facts.test_weakening) {
    lines.push(`⚠️ Test weakening — ${field(signal.detail)} (\`${field(signal.path)}\`; ${signal.kind.replace(/_/g, " ")})`);
  }
  for (const change of facts.schema_changes) {
    lines.push(`Schema contract — ${field(semanticSchemaSummary(change))} (\`${field(change.path)}\`)`);
  }
  for (const change of facts.api_changes) {
    lines.push(`Exported API — ${field(semanticApiSummary(change))} (\`${field(change.path)}\`)`);
  }
  return bullets(lines, "No semantic schema/API/test-weakening facts detected in this change.");
}

function semanticSchemaSummary(change: HumanReviewModel["semantic_facts"]["schema_changes"][number]): string {
  const parts: string[] = [];
  if (change.required_added.length) parts.push(`now requires ${change.required_added.join(", ")} (existing artifacts without them fail validation)`);
  if (change.required_removed.length) parts.push(`no longer requires ${change.required_removed.join(", ")}`);
  if (change.properties_removed.length) parts.push(`removed ${change.properties_removed.join(", ")}`);
  if (change.properties_added.length) parts.push(`added ${change.properties_added.join(", ")}`);
  if (change.type_changes.length) parts.push(`type: ${formatTypeChanges(change.type_changes)}`);
  if (change.enum_changes.length) parts.push(`enum: ${formatEnumChanges(change.enum_changes)}`);
  return parts.join("; ");
}

function semanticApiSummary(change: HumanReviewModel["semantic_facts"]["api_changes"][number]): string {
  const parts: string[] = [];
  if (change.signatures_changed.length) parts.push(`signature changed: ${change.signatures_changed.map((s) => s.name).join(", ")}`);
  if (change.exports_removed.length) parts.push(`removed: ${change.exports_removed.join(", ")}`);
  if (change.exports_added.length) parts.push(`added: ${change.exports_added.join(", ")}`);
  return parts.join("; ");
}

function renderReviewFirst(model: HumanReviewModel, items: ReviewQueueItem[], context: HumanRenderContext = {}): string {
  if (items.length === 0) {
    return "- No path-backed review queue items generated.";
  }
  return items
    .map((item) => {
      const location = formatQueueLocation(item);
      const excerpt = inlineHunkExcerpt(item, context);
      // When an excerpt renders, its fenced @@ header names the hunk
      // authoritatively, so suppress the separate (possibly stale) Hunk: metadata
      // line to avoid contradictory labels.
      const hunkLine = item.hunk_header && !excerpt ? `   - Hunk: \`${field(item.hunk_header)}\`\n` : "";
      // review-surfaces.COVERAGE.6: one summary line per excerpt with the
      // uncovered ranges — no per-line markup games on markdown surfaces.
      const coverageHunk = excerpt ? coverageHunkForAnchor(model, item.path, item.hunk_header) : undefined;
      const coverageLine = coverageHunk ? `\n   - Coverage: ${field(coverageSummaryLine(coverageHunk))}` : "";
      return `${item.rank}. \`${field(location)}\`
${hunkLine}   - Why it matters: ${field(item.reason)}
   - Why ranked here: ${rankingReasonsLine(item)}
   - Action: ${field(item.reviewer_action)}${excerpt ? `\n${excerpt}` : ""}${coverageLine}
   - Risk: ${item.risk_ids.map((risk) => `\`${field(risk)}\``).join(", ") || "none"}
   - Evidence: ${evidenceList(item.evidence)}`;
    })
    .join("\n\n");
}

// review-surfaces.BUDGET.1/.2: the explicit read/skim/defer cut. Off (the
// default) renders a single note; estimates are stated as estimates. Blockers
// are budget-exempt and the render says so on the item.
function renderReviewPlan(model: HumanReviewModel): string {
  const plan = model.review_plan;
  if (!plan || !plan.enabled) {
    return "- No time budget configured (pass --budget 15m or set human_review.review_budget).";
  }
  const group = (label: string, items: typeof plan.read): string =>
    `${label}:\n${items.length === 0 ? "- None." : items.map((item) => `- \`${field(item.path)}\` (~${item.estimated_minutes} min${item.reason ? `; ${field(item.reason)}` : ""}) [${item.queue_item_id}]`).join("\n")}`;
  return `Budget: ${plan.budget_minutes} minute(s). Estimates are deterministic approximations, not promises. Blocker items are budget-exempt.

${group("Read", plan.read)}

${group("Skim (read the excerpt, not the file)", plan.skim)}

${group("Safe to defer", plan.defer)}`;
}

// review-surfaces.COVERAGE.3/.4: changed-line coverage per file when a report
// exists; the honest negative ("no coverage evidence") when none was provided —
// explicitly distinct from "uncovered", and never a penalty.
function renderCoverageEvidence(model: HumanReviewModel): string {
  const coverage = model.coverage_evidence;
  if (!coverage || coverage.status === "no_report") {
    return "- No coverage evidence: no coverage report was provided. This is different from changed lines being uncovered.";
  }
  if (coverage.postdates_head === false) {
    // A stale report is recorded but NOT trusted: render only the warning, never
    // its per-file classifications as if they were current evidence.
    return `- The report at \`${field(coverage.source_path ?? "")}\` predates the reviewed code, so it is recorded but NOT trusted: no current coverage evidence.`;
  }
  if (coverage.files.length === 0) {
    return `- Report ingested from \`${field(coverage.source_path ?? "")}\`, but none of the changed lines are instrumented by it (no coverage evidence for this diff — distinct from uncovered).`;
  }
  return bullets(
    coverage.files.map((file) => `\`${field(file.path)}\`: ${file.covered_lines} of ${file.changed_lines} changed line(s) executed by tests (${file.classification}).`),
    "No coverage evidence recorded."
  );
}

// review-surfaces.RANKING.2: the "why ranked here" line — the per-item evidence
// signals that moved it up or down. Joined with "; "; older JSON written before
// ranking support degrades to a neutral note rather than an empty line.
function rankingReasonsLine(item: ReviewQueueItem): string {
  const reasons = item.ranking_reasons ?? [];
  return reasons.length > 0 ? field(reasons.join("; "), 600) : "ranked by deterministic risk severity";
}

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
  // one-line coverage summary as the Review first section.
  const coverageHunkDetail = coverageHunkForAnchor(model, item.path, item.hunk_header);
  const coverageDetailLine = coverageHunkDetail ? `Coverage: ${field(coverageSummaryLine(coverageHunkDetail))}\n\n` : "";
  const location = formatQueueLocation(item);
  const requirements = item.requirement_ids.map((id) => `\`${field(id)}\``).join(", ") || "none";
  const risks = item.risk_ids.map((id) => `\`${field(id)}\``).join(", ") || "none";
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

Why ranked here:
${rankingReasonsLine(item)}

Reviewer action:
${field(item.reviewer_action, 1000)}
${excerpt ? `\n${excerpt}\n` : ""}${coverageDetailLine}Evidence:
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
  // review-surfaces.HUMAN_REVIEW.21: lead with the effect summary and action;
  // the effect id and kind trail as metadata.
  return bullets(
    effects.slice(0, 8).map((effect) => {
      const paths = effect.paths.length ? ` Paths: ${effect.paths.map((filePath) => `\`${field(filePath)}\``).join(", ")}.` : "";
      const risks = effect.risk_ids.length ? ` Risks: ${effect.risk_ids.map((id) => `\`${field(id)}\``).join(", ")}.` : "";
      return `${effect.summary} Action: ${effect.action}.${paths}${risks} Evidence: ${evidenceList(effect.evidence)} (${effect.id}; ${effect.kind})`;
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
      // review-surfaces.HUMAN_REVIEW.21: lead with the scenario (the concrete
      // test to add); kind/priority/id trail as metadata.
      return `### ${field(item.scenario)} — ${item.kind} (${item.priority}; ${field(item.id)})

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
      // review-surfaces.HUMAN_REVIEW.21: lead with the comment severity (and
      // path when present); the SC id trails as metadata.
      return `### ${suggestedCommentSeverityLabel(item.severity)} comment${item.path ? ` on \`${field(item.path)}\`` : ""} (${field(item.id)})${pathLine}
> ${field(item.body, 800)}

Evidence: ${evidenceList(item.evidence)}

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

function renderTestPlanRollups(items: TestPlanItem[], maxGroups: number): string {
  if (items.length === 0) {
    return "- No concrete test-plan items generated.";
  }
  // Roll up the FULL list first, then cap the number of rendered groups, so a
  // distinct item beyond the raw item cap is not hidden behind earlier
  // duplicates (review-surfaces.HUMAN_REVIEW.19).
  const groups = rollupBy(
    items,
    (item) =>
      [
        item.kind,
        item.priority,
        normalizeAcidTemplate(item.scenario),
        normalizeAcidTemplate(item.expected_result),
        item.suggested_file ?? "",
        normalizeAcidTemplate(item.command ?? ""),
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
  const file = rep.suggested_file ? `\n- Suggested file: \`${field(rep.suggested_file)}\`` : "";
  // Fill the command through the same ACID template as the other fields, so a
  // rollup that merged items differing only by an ACID in the command does not
  // show a command naming just the first requirement (the exact per-item command
  // stays in the standalone test_plan.md). A single-item group restores the
  // verbatim command.
  const command = rep.command ? `\n- Command: \`${field(fillAcidTemplate(normalizeAcidTemplate(rep.command), group.acids))}\`` : "";
  const requirements = group.acids.length
    ? `\n- Requirements (${group.acids.length}): ${group.acids.map((acid) => `\`${field(acid)}\``).join(", ")}`
    : "";
  const ids = group.items.map((item) => `\`${field(item.id)}\``).join(", ");
  return `### ${field(gap)} — ${rep.kind} (${rep.priority})${requirements}
- Add test: ${field(scenario)}
- Expected: ${field(expected)}${file}${command}
- Items: ${ids}`;
}

function renderQuestionRollups(questions: ReviewerQuestion[], maxGroups: number): string {
  if (questions.length === 0) {
    return "- No reviewer questions generated.";
  }
  // Roll up the full list, then cap rendered groups (review-surfaces.HUMAN_REVIEW.19).
  const groups = rollupBy(
    questions,
    (question) => `${question.severity}|${normalizeAcidTemplate(question.question)}`,
    (question) => rollupAcids(question.maps_to_requirements, question.question)
  );
  return groups
    .slice(0, maxGroups)
    .map((group, index) => {
      const text = fillAcidTemplate(normalizeAcidTemplate(group.representative.question), group.acids);
      const requirements = group.acids.length ? `; requirements: ${group.acids.map((acid) => `\`${field(acid)}\``).join(", ")}` : "";
      const count = group.items.length > 1 ? `; ${group.items.length} questions` : "";
      // Preserve the evidence pointer the per-question renderer carried, unioned
      // across the rolled-up questions (with an omitted-count marker) so the
      // reviewer still sees why to ask and is not misled by the 4-ref cap.
      const evidence = evidenceListWithOmission(group.items.flatMap((question) => question.evidence));
      return `${index + 1}. ${field(text)} (${group.representative.severity}${requirements}${count}; evidence: ${evidence})`;
    })
    .join("\n");
}

function renderEvidenceCardsRollupSummary(cards: EvidenceCard[], maxGroups: number): string {
  if (cards.length === 0) {
    return "- This human review JSON was generated before evidence-card support.";
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

export function decisionLabel(decision: HumanReviewModel["verdict"]["decision"]): string {
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

function evidencePointers(model: HumanReviewModel): string[] {
  return [
    `Packet: \`${field(model.generated_from.packet_path)}\``,
    model.generated_from.pr_surface_path ? `PR surface: \`${field(model.generated_from.pr_surface_path)}\`` : undefined,
    ...HUMAN_STANDALONE_ARTIFACTS.map((artifact) => `${artifact.label}: \`${field(siblingArtifactPath(model.generated_from.packet_path, artifact.artifact))}\``),
    `Base/head: \`${field(model.generated_from.base_ref)}\` -> \`${field(model.generated_from.head_ref)}\``,
    `Head SHA: \`${field(model.generated_from.head_sha)}\``,
    // COLD_START.7: a literal-HEAD review that absorbed working-tree files says
    // so on every human surface; a clean or pinned-head run renders nothing.
    model.generated_from.uncommitted_files > 0
      ? `Working tree: includes ${model.generated_from.uncommitted_files} uncommitted file(s) (working tree)`
      : undefined
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

export function formatQueueLocation(item: ReviewQueueItem): string {
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

// review-surfaces.CHANGE_MAP.3: the change map embeds on human_review.md (the
// mermaid renders in editor previews and on GitHub; the cockpit's SVG is the
// local answer). The shared embed helper runs redaction + the fence guard.
// review-surfaces.MAP_SCALE.2: the embed helper consults the legibility budget
// — when the overview leads, an honest lead-in line says so.
function renderChangeMapSection(model: HumanReviewModel): string {
  const embed = changeMapMermaidEmbed(model.change_graph);
  const body = embed.body;
  if (!body) {
    // Honest omission: a populated graph whose rendered body tripped the size
    // cap or fence-close guard is OMITTED, never reported as "no changes".
    return model.change_graph.nodes.length === 0
      ? "No changed files to map."
      : `Change map omitted (${model.change_graph.nodes.length} changed file(s); the rendered diagram exceeded the embed size cap or contained fence-closing content).`;
  }
  const lead =
    embed.level === "overview"
      ? `Overview — ${model.change_graph.nodes.length} changed file(s) across ${model.change_graph.overview.groups.length} group(s); the file-level map exceeds the legibility budget, so groups lead.\n\n`
      : "";
  const sections = [`${lead}\`\`\`mermaid\n${body}\n\`\`\``];
  // review-surfaces.MAP_SCALE.6: when the overview leads, every group expands
  // to its own collapsed detail view (deterministic model order; per-block
  // embed guard). The group name is redacted-then-escaped — the summary is not
  // a constant title.
  if (embed.level === "overview") {
    for (const detail of changeMapDetailEmbeds(model.change_graph)) {
      const summary = `${esc(detail.group)} — ${detail.file_count} file(s) · ${detail.cluster_count} cluster(s)`;
      sections.push(
        detail.body
          ? `<details><summary>${summary}</summary>\n\n\`\`\`mermaid\n${detail.body}\n\`\`\`\n\n</details>`
          : `Detail view for ${esc(detail.group)} omitted (the rendered diagram exceeded the embed size cap or contained fence-closing content).`
      );
    }
  }
  return sections.join("\n\n");
}

// review-surfaces.READING_ORDER.2: the guided tour renders right after the
// verdict — comprehension order, never including unchanged files.
function renderReadingOrderSection(order: ReadingOrder): string {
  if (order.legs.length === 0) {
    return "No changed files to order.";
  }
  const lines: string[] = [];
  let stepNumber = 0;
  for (const leg of order.legs) {
    lines.push(`**${field(leg.title)}**`);
    for (const step of leg.steps) {
      stepNumber += 1;
      const refs = step.queue_refs.length > 0 ? ` (queue: ${step.queue_refs.map((ref) => field(ref)).join(", ")})` : "";
      lines.push(`${stepNumber}. \`${field(step.path)}\` — ${field(step.why)}${refs}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
