import { agreementNeedsHumanDecision, type AgreementAudit, type GroundedAgreement } from "./contract";
import { safeMarkdownCode, safeMarkdownEvidence, safeMarkdownProse } from "./presentation-safety";

export function renderAgreementAuditMarkdown(audit: AgreementAudit): string {
  const lines = [
    "# Agreement audit",
    "",
    `Reviewed ${safeMarkdownCode(`${shortSha(audit.base_sha)}..${shortSha(audit.head_sha)}`)} in ${safeMarkdownCode(audit.repository)}.`,
    ""
  ];

  if (audit.comparison) {
    lines.push(
      "## Since the previous audit",
      "",
      `New decisions: **${audit.comparison.new_decision_keys.length}** · Unchanged: **${audit.comparison.unchanged_decision_keys.length}** · Resolved: **${audit.comparison.resolved_decision_keys.length}** · Pending recheck: **${audit.comparison.unverified_previous_decision_keys.length}**`,
      ""
    );
    if (audit.comparison.new_decision_keys.length > 0) lines.push(`New: ${audit.comparison.new_decision_keys.map(safeMarkdownCode).join(", ")}`, "");
    if (audit.comparison.resolved_decision_keys.length > 0) lines.push(`Resolved: ${audit.comparison.resolved_decision_keys.map(safeMarkdownCode).join(", ")}`, "");
    if (audit.comparison.unverified_previous_decision_keys.length > 0) lines.push(`Pending recheck: ${audit.comparison.unverified_previous_decision_keys.map(safeMarkdownCode).join(", ")}`, "");
  }

  const decisions = audit.agreements.filter(agreementNeedsHumanDecision);
  if (decisions.length > 0) {
    lines.push(
      "## Needs your decision",
      "",
      audit.completeness.verified
        ? "_Every eligible conversation event received a separately generated, deterministically checked disposition._"
        : "_This list may not be exhaustive; the separate completeness pass was not verified._",
      ""
    );
    for (const [index, agreement] of decisions.entries()) {
      lines.push(...renderDecision(agreement, index + 1, audit));
    }
  }
  if (audit.status === "no_mismatch_found") {
    lines.push(
      "## No agreement mismatch found",
      "",
      "Every eligible conversation event received a separately generated, deterministically validated disposition, and no grounded agreement needs a reviewer decision. Code correctness was not assessed.",
      ""
    );
  }
  if (audit.status === "cannot_audit") {
    lines.push(
      "## Audit incomplete",
      "",
      auditIncompleteMessage(audit),
      ""
    );
  }

  const unresolvedSupporting = audit.agreements.filter((agreement) =>
    agreement.materiality === "supporting" && agreement.state === "unresolved"
  );
  if (unresolvedSupporting.length > 0) {
    lines.push("## Other uncertainty", "");
    for (const agreement of unresolvedSupporting) lines.push(...renderSupportingAgreement(agreement, audit));
  }

  lines.push("<details>", "<summary>Final agreement and aligned work</summary>", "");
  if (audit.final_goal) {
    lines.push(`**Final goal:** ${safeMarkdownProse(audit.final_goal.text)}`, "", `Conversation: ${audit.final_goal.conversation_event_ids.map(eventRef).join(", ")}`, "");
  } else {
    lines.push("The final goal could not be grounded.", "");
  }
  const fulfilled = audit.agreements.filter((agreement) => agreement.state === "fulfilled");
  if (fulfilled.length === 0) lines.push("No fulfilled agreement was grounded.", "");
  else for (const agreement of fulfilled) lines.push(...renderSupportingAgreement(agreement, audit));
  lines.push("</details>", "");

  lines.push("<details>", "<summary>Scope and evidence limits</summary>", "");
  lines.push(`Conversation scope: **${audit.conversation.status}** across ${audit.conversation.sources.length} source(s).`, "");
  if (audit.conversation.sources.length > 0) {
    for (const source of audit.conversation.sources) {
      lines.push(`- ${safeMarkdownCode(source.id)} — ${source.selection}; sha256 ${safeMarkdownCode(source.sha256)}`);
    }
    lines.push("");
  }
  if (audit.limitations.length > 0) {
    lines.push("Limitations:", "");
    for (const limitation of audit.limitations) lines.push(`- ${safeMarkdownProse(limitation)}`);
    lines.push("");
  }
  if (audit.rejections.length > 0) {
    lines.push("Rejected conclusions:", "");
    for (const rejection of audit.rejections) {
      lines.push(`- ${safeMarkdownCode(rejection.key)}: ${safeMarkdownProse(rejection.reasons.join("; "))}`);
    }
    lines.push("");
  }
  lines.push("This audit compares the supplied conversation agreement with the reviewed change. It does not replace code-correctness review.", "", "</details>", "");
  return lines.join("\n");
}

function renderDecision(agreement: GroundedAgreement, index: number, audit: AgreementAudit): string[] {
  const label = agreement.state === "diverged" ? "Diverged from the agreement" : "Still unresolved";
  const lines = [
    `### ${index}. ${label}`,
    "",
    safeMarkdownProse(agreement.statement),
    "",
    `**Reviewer decision:** ${agreement.state === "diverged"
      ? "Accept this departure from the governing agreement, or require the agreed behavior to be restored."
      : "Decide whether the available evidence is sufficient for approval or whether the agreement must be resolved first."}`,
    "",
    `**Recommended author follow-up:** ${safeMarkdownProse(agreement.reviewer_action ?? "Resolve the agreement and attach exact evidence.")}`,
    "",
    "**Evidence:**",
    "",
    ...renderEvidence(agreement, audit),
    ""
  ];
  return lines;
}

function renderSupportingAgreement(agreement: GroundedAgreement, audit: AgreementAudit): string[] {
  return [
    `- **${stateLabel(agreement.state)}:** ${safeMarkdownProse(agreement.statement)}`,
    "  - Evidence:",
    ...renderEvidence(agreement, audit).map((line) => `    ${line}`),
    ""
  ];
}

function renderEvidence(agreement: GroundedAgreement, audit: AgreementAudit): string[] {
  const refs = [
    ...agreement.conversation_evidence.flatMap((event) => [
      `- Conversation ${safeMarkdownCode(event.id)} (${safeMarkdownCode(event.source_id)}, order ${event.order}): ${safeMarkdownEvidence(event.text)}`,
      ...event.context.map((context) =>
        `  - Adjacent ${context.actor} ${safeMarkdownCode(context.id)} (${safeMarkdownCode(context.source_id)}): ${safeMarkdownEvidence(context.text)}`
      )
    ]),
    ...agreement.diff_citations.map((citation) =>
      `- Diff ${renderDiffLocation(audit, citation)} (${citation.side}): ${safeMarkdownEvidence(citation.contains)}`
    ),
    ...agreement.commands.map((command) =>
      `- Command ${safeMarkdownCode(command.id)} (${command.status}, ${command.exact_head ? "exact head" : "not head-bound"}): ${safeMarkdownEvidence(command.command)}`
    )
  ];
  return refs.length > 0 ? refs : ["- None"];
}

function renderDiffLocation(
  audit: AgreementAudit,
  citation: GroundedAgreement["diff_citations"][number]
): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(audit.repository)) {
    return safeMarkdownCode(`${citation.path}:${citation.line}`);
  }
  const sha = citation.side === "delete" ? audit.base_sha : audit.head_sha;
  const encodedPath = citation.path.split("/").map(encodeURIComponent).join("/");
  return `[${safeMarkdownCode(`${citation.path}:${citation.line}`)}](https://github.com/${audit.repository}/blob/${sha}/${encodedPath}#L${citation.line})`;
}

function eventRef(id: string): string {
  return `conversation ${safeMarkdownCode(id)}`;
}

function auditIncompleteMessage(audit: AgreementAudit): string {
  if (audit.conversation.status !== "complete") {
    return "No alignment conclusion is available because the supplied conversation scope is incomplete.";
  }
  if (!audit.candidate_complete) {
    return "No alignment conclusion is available because agreement extraction did not complete.";
  }
  if (audit.rejections.length > 0) {
    return "No alignment conclusion is available because one or more candidate conclusions were rejected.";
  }
  if (!audit.final_goal) {
    return "No alignment conclusion is available because the final agreement could not be grounded.";
  }
  if (audit.agreements.length === 0) {
    return "No alignment conclusion is available because no agreement could be grounded.";
  }
  return "No clean alignment conclusion is available because the separate completeness pass was not verified.";
}

function stateLabel(state: GroundedAgreement["state"]): string {
  if (state === "fulfilled") return "Appears aligned";
  if (state === "diverged") return "Diverged";
  return "Unresolved";
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
