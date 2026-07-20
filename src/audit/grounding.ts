import {
  AGREEMENT_AUDIT_RESULT_VERSION,
  type AgreementAudit,
  type AgreementAuditCandidate,
  type AgreementCompletenessCandidate,
  type AgreementAuditInput,
  type AgreementCandidate,
  type AuditConversationEvent,
  type GroundedAgreement,
  agreementEvidenceFailures,
  agreementKindAllowsActor,
  agreementNeedsHumanDecision,
  auditDiffCoordinate
} from "./contract";
import { agreementCompletenessConfirmationToken, verifyAgreementCompleteness } from "./completeness";
import { redactAuditText } from "./presentation-safety";

export function groundAgreementAudit(
  input: AgreementAuditInput,
  candidate: AgreementAuditCandidate,
  completenessCandidate?: AgreementCompletenessCandidate,
  extractionConfirmationToken?: string
): AgreementAudit {
  const rawLimitations = unique(candidate.limitations);
  const rejections: AgreementAudit["rejections"] = [];
  const events = new Map(input.conversation.events.map((event) => [event.id, event]));
  const contextByEvent = buildAdjacentContext(input.conversation.events);
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
  const completeness = verifyAgreementCompleteness(input, candidate, completenessCandidate);
  const confirmationToken = completenessCandidate
    ? agreementCompletenessConfirmationToken(input, candidate, completenessCandidate)
    : undefined;
  const extractionCompletenessConfirmed = confirmationToken !== undefined &&
    extractionConfirmationToken === confirmationToken;
  const extractionCompletenessVerified = completeness.verified && extractionCompletenessConfirmed;

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
        return {
          id,
          source_id: sanitize(event.source_id),
          text: sanitize(event.text),
          order: event.order,
          context: (contextByEvent.get(id) ?? []).map((item) => ({
            id: item.id,
            source_id: item.source_id,
            actor: item.actor,
            text: sanitize(item.text)
          }))
        };
      }),
      diff_citations: diff_citations.map((citation) => ({
        ...citation,
        path: sanitize(citation.path),
        contains: sanitize(diffIndex.get(auditDiffCoordinate(citation))!),
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

  for (const limitation of completeness.limitations) limitations.push(sanitize(limitation));
  for (const rejection of completeness.rejections) limitations.push(`Completeness verification rejected: ${sanitize(rejection)}.`);
  if (completeness.verified && !extractionCompletenessConfirmed) {
    limitations.push(
      extractionConfirmationToken === undefined
        ? `The separate completeness pass is model-generated and cannot certify that it found every clause; review the extracted ledger, then rerun with --confirm-extraction ${confirmationToken} to confirm these exact bytes.`
        : "The extraction confirmation token did not match the current input and ledgers; review the newly generated artifacts before confirming them."
    );
  }

  const cannotAudit = input.conversation.status !== "complete" ||
    input.conversation.events.length === 0 ||
    agreements.length === 0 ||
    !candidate.complete ||
    rejections.length > 0 ||
    finalGoalReasons.length > 0 ||
    uncoveredUserEvents.length > 0;
  const needsDecision = agreements.some(agreementNeedsHumanDecision);
  if (sensitiveMaterialRedacted) limitations.push("Sensitive material was redacted from the persisted audit.");

  return {
    version: AGREEMENT_AUDIT_RESULT_VERSION,
    repository: sanitizedRepository,
    base_sha: input.base_sha,
    head_sha: input.head_sha,
    status: cannotAudit
      ? "cannot_audit"
      : needsDecision
        ? "needs_human_decision"
        : extractionCompletenessVerified
          ? "no_mismatch_found"
          : "cannot_audit",
    candidate_complete: candidate.complete,
    completeness: {
      verified: extractionCompletenessVerified,
      structurally_verified: completeness.verified,
      operator_confirmed: extractionCompletenessConfirmed,
      ...(confirmationToken ? { confirmation_token: confirmationToken } : {}),
      dispositions: completeness.dispositions.map((disposition) => ({
        ...disposition,
        ...(disposition.reason ? { reason: sanitize(disposition.reason) } : {})
      })),
      limitations: completeness.limitations.map(sanitize),
      rejections: completeness.rejections.map(sanitize)
    },
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

function buildAdjacentContext(
  events: readonly AuditConversationEvent[],
): ReadonlyMap<string, AuditConversationEvent[]> {
  const bySource = new Map<string, AuditConversationEvent[]>();
  for (const event of events) {
    const sourceEvents = bySource.get(event.source_id) ?? [];
    sourceEvents.push(event);
    bySource.set(event.source_id, sourceEvents);
  }
  const context = new Map<string, AuditConversationEvent[]>();
  for (const sourceEvents of bySource.values()) {
    sourceEvents.sort((left, right) => left.order - right.order);
    sourceEvents.forEach((event, index) => {
      context.set(event.id, [sourceEvents[index - 1], sourceEvents[index + 1]].filter(
        (neighbor): neighbor is AuditConversationEvent => neighbor !== undefined
      ));
    });
  }
  return context;
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
  diffIndex: ReadonlyMap<string, string>,
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
    const matched = diffIndex.get(auditDiffCoordinate(citation))?.includes(citation.contains) ?? false;
    if (!matched) reasons.push(`diff citation ${citation.path}:${citation.line} is not in the reviewed diff`);
  }

  for (const id of unique(agreement.command_ids)) {
    const command = commands.get(id);
    if (!command) reasons.push(`unknown command evidence ${id}`);
    else if (command.head_sha !== input.head_sha) {
      reasons.push(`command ${id} is not bound to the reviewed head`);
    }
  }

  const citedCommands = unique(agreement.command_ids)
    .map((id) => commands.get(id))
    .filter((command): command is AgreementAuditInput["commands"][number] => command !== undefined);
  reasons.push(...agreementEvidenceFailures({
    kind: agreement.kind,
    state: agreement.state,
    diff_sides: agreement.diff_citations.map((citation) => citation.side),
    commands: citedCommands.map((command) => ({
      status: command.status,
      exact_head: command.head_sha === input.head_sha
    }))
  }));
  const needsReviewerAction = agreementNeedsHumanDecision(agreement);
  if (needsReviewerAction && !agreement.reviewer_action?.trim()) {
    reasons.push("a reviewer decision needs an explicit action");
  }
  return unique(reasons);
}

function buildDiffIndex(input: AgreementAuditInput): Map<string, string> {
  const index = new Map<string, string>();
  for (const line of input.diff) {
    const key = auditDiffCoordinate(line);
    if (index.has(key)) throw new Error("input.diff coordinates must be unique");
    index.set(key, line.text);
  }
  return index;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
