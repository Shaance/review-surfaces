import {
  AGREEMENT_AUDIT_VERSION,
  type AgreementAudit,
  type AgreementAuditCandidate,
  type AgreementAuditInput,
  type AgreementCandidate,
  type AuditConversationEvent,
  type GroundedAgreement,
  agreementKindAllowsActor,
  agreementNeedsHumanDecision
} from "./contract";
import { redactAuditText } from "./presentation-safety";

export function groundAgreementAudit(
  input: AgreementAuditInput,
  candidate: AgreementAuditCandidate
): AgreementAudit {
  const rawLimitations = unique(candidate.limitations);
  const rejections: AgreementAudit["rejections"] = [];
  const events = new Map(input.conversation.events.map((event) => [event.id, event]));
  const commands = new Map(input.commands.map((command) => [command.id, command]));
  const diffIndex = buildDiffIndex(input);
  const seenKeys = new Set<string>();
  let sensitiveMaterialRedacted = false;
  const sanitize = (value: string): string => {
    const result = redactAuditText(value);
    if (result.redacted) sensitiveMaterialRedacted = true;
    return result.text;
  };
  const limitations = rawLimitations.map(sanitize);
  const sanitizedFinalGoalText = sanitize(candidate.final_goal.text.trim());
  const sanitizedRepository = sanitize(input.repository);
  const sanitizedSources = input.conversation.sources.map((source) => ({
    ...source,
    id: sanitize(source.id)
  }));
  const sanitizedCaveat = input.conversation.caveat ? sanitize(input.conversation.caveat) : undefined;

  const finalGoalReasons = validateFinalGoal(candidate, events);
  if (finalGoalReasons.length > 0) {
    limitations.push("The candidate's final-goal citations were rejected.");
    rejections.push({ key: "final_goal", reasons: finalGoalReasons.map(sanitize) });
  }

  const agreements: GroundedAgreement[] = [];
  for (const agreement of candidate.agreements) {
    const reasons = validateAgreement(input, agreement, events, commands, diffIndex, seenKeys);
    if (reasons.length > 0) {
      rejections.push({ key: sanitize(agreement.key || "(missing key)"), reasons: reasons.map(sanitize) });
      continue;
    }
    seenKeys.add(agreement.key);
    const { command_ids, diff_citations, reviewer_action, ...grounded } = agreement;
    agreements.push({
      ...grounded,
      statement: sanitize(agreement.statement),
      ...(reviewer_action ? { reviewer_action: sanitize(reviewer_action) } : {}),
      conversation_event_ids: unique(agreement.conversation_event_ids),
      conversation_evidence: unique(agreement.conversation_event_ids).map((id) => {
        const event = events.get(id)!;
        return { id, source_id: sanitize(event.source_id), text: sanitize(event.text) };
      }),
      diff_citations: diff_citations.map((citation) => ({
        ...citation,
        path: sanitize(citation.path),
        contains: sanitize(citation.contains),
        validated: true as const
      })),
      commands: command_ids.map((id) => {
        const command = commands.get(id)!;
        return { ...command, command: sanitize(command.command), exact_head: command.head_sha === input.head_sha };
      })
    });
  }

  if (!candidate.complete) limitations.push("The analysis did not inspect all supplied evidence.");
  if (rejections.length > 0) limitations.push("One or more proposed conclusions failed evidence validation.");
  if (sanitizedCaveat) limitations.push(sanitizedCaveat);

  const coveredUserEvents = new Set(
    agreements.flatMap((agreement) => agreement.conversation_event_ids)
  );
  const uncoveredUserEvents = input.conversation.events
    .filter((event) => event.actor === "user" && !coveredUserEvents.has(event.id))
    .map((event) => event.id);
  if (uncoveredUserEvents.length > 0) {
    limitations.push(`${uncoveredUserEvents.length} user turn(s) were not represented by the candidate: ${uncoveredUserEvents.join(", ")}.`);
  }

  const cannotAudit = input.conversation.status !== "complete" ||
    input.conversation.events.length === 0 ||
    agreements.length === 0 ||
    uncoveredUserEvents.length > 0 ||
    !candidate.complete ||
    rejections.length > 0 ||
    finalGoalReasons.length > 0;
  const needsDecision = agreements.some(agreementNeedsHumanDecision);
  limitations.push("Agreement extraction completeness was not independently verified; this decision list may not be exhaustive and a clean conclusion is unavailable.");
  if (sensitiveMaterialRedacted) limitations.push("Sensitive material was redacted from the persisted audit.");

  return {
    version: AGREEMENT_AUDIT_VERSION,
    repository: sanitizedRepository,
    base_sha: input.base_sha,
    head_sha: input.head_sha,
    status: cannotAudit || !needsDecision
      ? "cannot_audit"
      : "needs_human_decision",
    candidate_complete: candidate.complete,
    final_goal: finalGoalReasons.length === 0 ? {
      text: sanitizedFinalGoalText,
      conversation_event_ids: unique(candidate.final_goal.conversation_event_ids)
    } : null,
    agreements,
    conversation: {
      status: input.conversation.status,
      sources: sanitizedSources,
      ...(sanitizedCaveat ? { caveat: sanitizedCaveat } : {})
    },
    limitations: unique(limitations),
    rejections
  };
}

function validateFinalGoal(
  candidate: AgreementAuditCandidate,
  events: ReadonlyMap<string, AuditConversationEvent>
): string[] {
  const reasons: string[] = [];
  if (!candidate.final_goal.text.trim()) reasons.push("final goal text is empty");
  if (candidate.final_goal.conversation_event_ids.length === 0) reasons.push("final goal has no conversation citation");
  for (const id of unique(candidate.final_goal.conversation_event_ids)) {
    const event = events.get(id);
    if (!event) reasons.push(`unknown conversation event ${id}`);
    else if (event.actor !== "user") reasons.push(`final goal cites non-user event ${id}`);
  }
  return reasons;
}

function validateAgreement(
  input: AgreementAuditInput,
  agreement: AgreementCandidate,
  events: ReadonlyMap<string, AuditConversationEvent>,
  commands: ReadonlyMap<string, AgreementAuditInput["commands"][number]>,
  diffIndex: ReadonlyMap<string, readonly string[]>,
  seenKeys: ReadonlySet<string>
): string[] {
  const reasons: string[] = [];
  if (!agreement.key.trim()) reasons.push("agreement key is empty");
  if (seenKeys.has(agreement.key)) reasons.push("agreement key is duplicated");
  if (!agreement.statement.trim()) reasons.push("agreement statement is empty");
  if (agreement.conversation_event_ids.length === 0) reasons.push("agreement has no conversation citation");

  for (const id of unique(agreement.conversation_event_ids)) {
    const event = events.get(id);
    if (!event) {
      reasons.push(`unknown conversation event ${id}`);
      continue;
    }
    if (!agreementKindAllowsActor(agreement.kind, event.actor)) {
      reasons.push(`${agreement.kind} cites event ${id} owned by ${event.actor}`);
    }
  }

  for (const citation of agreement.diff_citations) {
    if (!citation.contains) {
      reasons.push(`diff citation ${citation.path}:${citation.line} has an empty text anchor`);
      continue;
    }
    const matched = (diffIndex.get(diffKey(citation.path, citation.side, citation.line)) ?? [])
      .some((text) => text.includes(citation.contains));
    if (!matched) reasons.push(`diff citation ${citation.path}:${citation.line} is not in the reviewed diff`);
  }

  for (const id of unique(agreement.command_ids)) {
    const command = commands.get(id);
    if (!command) reasons.push(`unknown command evidence ${id}`);
    else if (command.head_sha !== input.head_sha) {
      reasons.push(`command ${id} is not bound to the reviewed head`);
    }
  }

  const hasChangedDiffCitation = agreement.diff_citations.some((citation) => citation.side !== "context");
  const citedCommands = unique(agreement.command_ids)
    .map((id) => commands.get(id))
    .filter((command): command is AgreementAuditInput["commands"][number] => command !== undefined);
  const hasPassedExactHeadCommand = citedCommands.some((command) =>
    command.head_sha === input.head_sha && command.status === "passed"
  );
  if (agreement.state === "diverged" && !hasChangedDiffCitation) {
    const hasContradictingExactHeadCommand = agreement.kind === "validation_claim" &&
      agreement.command_ids.some((id) => {
        const command = commands.get(id);
        return command?.head_sha === input.head_sha && command.status === "failed";
      });
    if (!hasContradictingExactHeadCommand) {
      reasons.push("a divergence needs an exact diff citation or a failed exact-head validation command");
    }
  }
  if (agreement.state === "fulfilled" && citedCommands.some((command) => command.status !== "passed")) {
    reasons.push("a fulfilled agreement cannot cite failed or unknown command evidence");
  }
  if (agreement.state === "fulfilled" && !hasPassedExactHeadCommand && !hasChangedDiffCitation &&
    !(agreement.kind === "human_boundary" && agreement.diff_citations.length > 0)) {
    reasons.push("a fulfilled agreement needs changed diff or exact-head command evidence; a preserved human boundary may use context");
  }
  if (agreement.state === "fulfilled" && agreement.kind === "validation_claim" && !hasPassedExactHeadCommand) {
    reasons.push("a fulfilled validation claim needs a passed exact-head command");
  }
  const needsReviewerAction = agreementNeedsHumanDecision(agreement);
  if (needsReviewerAction && !agreement.reviewer_action?.trim()) {
    reasons.push("a reviewer decision needs an explicit action");
  }
  return unique(reasons);
}

function buildDiffIndex(input: AgreementAuditInput): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const line of input.diff) {
    const key = diffKey(line.path, line.side, line.line);
    const values = index.get(key) ?? [];
    values.push(line.text);
    index.set(key, values);
  }
  return index;
}

function diffKey(path: string, side: AgreementAuditInput["diff"][number]["side"], line: number): string {
  return `${path}\0${side}\0${line}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
