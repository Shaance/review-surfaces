import { agreementNeedsHumanDecision, type AgreementAudit, type GroundedAgreement } from "./contract";
import { safeMarkdownCode, safeMarkdownProse } from "./presentation-safety";

export function renderAgreementAuditMarkdown(audit: AgreementAudit): string {
  const lines = [
    "# Agreement audit",
    "",
    `Reviewed ${safeMarkdownCode(`${shortSha(audit.base_sha)}..${shortSha(audit.head_sha)}`)} in ${safeMarkdownCode(audit.repository)}.`,
    ""
  ];

  const decisions = audit.agreements.filter(agreementNeedsHumanDecision);
  if (audit.status === "cannot_audit") {
    lines.push(
      "## Audit incomplete",
      "",
      "No alignment conclusion is available because the conversation or evidence scope is incomplete.",
      ""
    );
  }
  if (decisions.length > 0) {
    lines.push(
      "## Needs your decision",
      "",
      "_This list may not be exhaustive; agreement extraction completeness is not independently verified._",
      ""
    );
    for (const [index, agreement] of decisions.entries()) {
      lines.push(...renderDecision(agreement, index + 1));
    }
  }

  const unresolvedSupporting = audit.agreements.filter((agreement) =>
    agreement.materiality === "supporting" && agreement.state === "unresolved"
  );
  if (unresolvedSupporting.length > 0) {
    lines.push("## Other uncertainty", "");
    for (const agreement of unresolvedSupporting) lines.push(...renderSupportingAgreement(agreement));
  }

  lines.push("<details>", "<summary>Final agreement and aligned work</summary>", "");
  if (audit.final_goal) {
    lines.push(`**Final goal:** ${safeMarkdownProse(audit.final_goal.text)}`, "", `Conversation: ${audit.final_goal.conversation_event_ids.map(eventRef).join(", ")}`, "");
  } else {
    lines.push("The final goal could not be grounded.", "");
  }
  const fulfilled = audit.agreements.filter((agreement) => agreement.state === "fulfilled");
  if (fulfilled.length === 0) lines.push("No fulfilled agreement was grounded.", "");
  else for (const agreement of fulfilled) lines.push(...renderSupportingAgreement(agreement));
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

function renderDecision(agreement: GroundedAgreement, index: number): string[] {
  const label = agreement.state === "diverged" ? "Diverged from the agreement" : "Still unresolved";
  const lines = [
    `### ${index}. ${label}`,
    "",
    safeMarkdownProse(agreement.statement),
    "",
    `**Decision:** ${safeMarkdownProse(agreement.reviewer_action ?? "Review the unresolved agreement.")}`,
    "",
    "**Evidence:**",
    "",
    ...renderEvidence(agreement),
    ""
  ];
  return lines;
}

function renderSupportingAgreement(agreement: GroundedAgreement): string[] {
  return [
    `- **${stateLabel(agreement.state)}:** ${safeMarkdownProse(agreement.statement)}`,
    "  - Evidence:",
    ...renderEvidence(agreement).map((line) => `    ${line}`),
    ""
  ];
}

function renderEvidence(agreement: GroundedAgreement): string[] {
  const refs = [
    ...agreement.conversation_evidence.map((event) =>
      `- Conversation ${safeMarkdownCode(event.id)} (${safeMarkdownCode(event.source_id)}): ${safeMarkdownCode(event.text)}`
    ),
    ...agreement.diff_citations.map((citation) =>
      `- Diff ${safeMarkdownCode(`${citation.path}:${citation.line}`)} (${citation.side}): ${safeMarkdownCode(citation.contains)}`
    ),
    ...agreement.commands.map((command) =>
      `- Command ${safeMarkdownCode(command.id)} (${command.status}, ${command.exact_head ? "exact head" : "not head-bound"}): ${safeMarkdownCode(command.command)}`
    )
  ];
  return refs.length > 0 ? refs : ["- None"];
}

function eventRef(id: string): string {
  return `conversation ${safeMarkdownCode(id)}`;
}

function stateLabel(state: GroundedAgreement["state"]): string {
  if (state === "fulfilled") return "Appears aligned";
  if (state === "diverged") return "Diverged";
  return "Unresolved";
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
