import {
  AGREEMENT_KINDS,
  AGREEMENT_MATERIALITIES,
  AGREEMENT_STATES,
  AGREEMENT_AUDIT_VERSION,
  COMMAND_STATUSES,
  CONVERSATION_ACTORS,
  CONVERSATION_SCOPE_STATUSES,
  CONVERSATION_SOURCE_SELECTIONS,
  DIFF_SIDES,
  auditDiffCoordinate,
  type AgreementAuditCandidate,
  type AgreementAuditInput,
  type AgreementCandidate,
  type AuditCommandEvidence,
  type AuditConversationEvent,
  type AuditConversationSource,
  type AuditDiffLine
} from "./contract";
import { inspectAndRedactSecrets } from "../privacy/secrets";


export function parseAgreementAuditInput(value: unknown): AgreementAuditInput {
  const input = record(value, "input");
  const version = string(input.version, "input.version");
  if (version !== AGREEMENT_AUDIT_VERSION) throw new Error(`input.version must be ${AGREEMENT_AUDIT_VERSION}`);
  const conversation = record(input.conversation, "input.conversation");
  const sources = array(conversation.sources, "input.conversation.sources").map(parseSource);
  const sourceIds = uniqueIds(sources, "conversation source");
  const events = array(conversation.events, "input.conversation.events").map((event, index) => parseEvent(event, index));
  uniqueIds(events, "conversation event");
  const orders = events.map((event) => event.order);
  if (new Set(orders).size !== orders.length) throw new Error("conversation event order values must be unique");
  for (const event of events) {
    if (!sourceIds.has(event.source_id)) throw new Error(`conversation event ${event.id} has unknown source_id ${event.source_id}`);
  }
  const commands = array(input.commands, "input.commands").map(parseCommand);
  uniqueIds(commands, "command");
  const diffCoordinates = new Set<string>();
  const diff = array(input.diff, "input.diff").map((value, index) => {
    const line = parseDiffLine(value, index);
    const coordinate = auditDiffCoordinate(line);
    if (diffCoordinates.has(coordinate)) throw new Error("input.diff coordinates must be unique");
    diffCoordinates.add(coordinate);
    return line;
  });
  return {
    version: AGREEMENT_AUDIT_VERSION,
    repository: nonEmpty(input.repository, "input.repository"),
    base_sha: commitSha(input.base_sha, "input.base_sha"),
    head_sha: commitSha(input.head_sha, "input.head_sha"),
    conversation: {
      status: enumValue(conversation.status, CONVERSATION_SCOPE_STATUSES, "input.conversation.status"),
      sources,
      events: [...events].sort((left, right) => left.order - right.order),
      ...(conversation.caveat === undefined ? {} : { caveat: nonEmpty(conversation.caveat, "input.conversation.caveat") })
    },
    diff,
    commands
  };
}

export function parseAgreementAuditCandidate(value: unknown): AgreementAuditCandidate {
  const candidate = record(value, "candidate");
  const goal = record(candidate.final_goal, "candidate.final_goal");
  return {
    final_goal: {
      text: nonEmpty(goal.text, "candidate.final_goal.text"),
      conversation_event_ids: safeIdArray(goal.conversation_event_ids, "candidate.final_goal.conversation_event_ids")
    },
    agreements: array(candidate.agreements, "candidate.agreements").map(parseAgreement),
    complete: boolean(candidate.complete, "candidate.complete"),
    limitations: stringArray(candidate.limitations, "candidate.limitations")
  };
}

function parseSource(value: unknown, index: number): AuditConversationSource {
  const source = record(value, `source[${index}]`);
  const sha256 = string(source.sha256, `source[${index}].sha256`);
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error(`source[${index}].sha256 must be a full SHA-256`);
  return {
    id: safeId(source.id, `source[${index}].id`),
    sha256,
    selection: enumValue(source.selection, CONVERSATION_SOURCE_SELECTIONS, `source[${index}].selection`)
  };
}

function parseEvent(value: unknown, index: number): AuditConversationEvent {
  const event = record(value, `event[${index}]`);
  return {
    id: safeId(event.id, `event[${index}].id`),
    source_id: safeId(event.source_id, `event[${index}].source_id`),
    actor: enumValue(event.actor, CONVERSATION_ACTORS, `event[${index}].actor`),
    kind: nonEmpty(event.kind, `event[${index}].kind`),
    text: nonEmpty(event.text, `event[${index}].text`),
    order: nonNegativeInteger(event.order, `event[${index}].order`)
  };
}

function parseDiffLine(value: unknown, index: number): AuditDiffLine {
  const line = record(value, `diff[${index}]`);
  const number = finiteNumber(line.line, `diff[${index}].line`);
  if (!Number.isInteger(number) || number < 1) throw new Error(`diff[${index}].line must be a positive integer`);
  return {
    path: repositoryPath(line.path, `diff[${index}].path`),
    side: enumValue(line.side, DIFF_SIDES, `diff[${index}].side`),
    line: number,
    text: string(line.text, `diff[${index}].text`)
  };
}

function parseCommand(value: unknown, index: number): AuditCommandEvidence {
  const command = record(value, `command[${index}]`);
  return {
    id: safeId(command.id, `command[${index}].id`),
    command: nonEmpty(command.command, `command[${index}].command`),
    status: enumValue(command.status, COMMAND_STATUSES, `command[${index}].status`),
    ...(command.head_sha === undefined ? {} : { head_sha: commitSha(command.head_sha, `command[${index}].head_sha`) })
  };
}

function parseAgreement(value: unknown, index: number): AgreementCandidate {
  const agreement = record(value, `agreement[${index}]`);
  return {
    key: safeId(agreement.key, `agreement[${index}].key`),
    kind: enumValue(agreement.kind, AGREEMENT_KINDS, `agreement[${index}].kind`),
    statement: nonEmpty(agreement.statement, `agreement[${index}].statement`),
    state: enumValue(agreement.state, AGREEMENT_STATES, `agreement[${index}].state`),
    materiality: enumValue(agreement.materiality, AGREEMENT_MATERIALITIES, `agreement[${index}].materiality`),
    conversation_event_ids: safeIdArray(agreement.conversation_event_ids, `agreement[${index}].conversation_event_ids`),
    diff_citations: array(agreement.diff_citations, `agreement[${index}].diff_citations`).map((value, citationIndex) => {
      const citation = record(value, `agreement[${index}].diff_citations[${citationIndex}]`);
      const line = finiteNumber(citation.line, `agreement[${index}].diff_citations[${citationIndex}].line`);
      if (!Number.isInteger(line) || line < 1) throw new Error(`agreement[${index}].diff_citations[${citationIndex}].line must be a positive integer`);
      return {
        path: repositoryPath(citation.path, `agreement[${index}].diff_citations[${citationIndex}].path`),
        side: enumValue(citation.side, DIFF_SIDES, `agreement[${index}].diff_citations[${citationIndex}].side`),
        line,
        contains: nonEmpty(citation.contains, `agreement[${index}].diff_citations[${citationIndex}].contains`)
      };
    }),
    command_ids: safeIdArray(agreement.command_ids, `agreement[${index}].command_ids`),
    ...(agreement.reviewer_action === undefined ? {} : { reviewer_action: nonEmpty(agreement.reviewer_action, `agreement[${index}].reviewer_action`) })
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  const parsed = string(value, label).trim();
  if (!parsed) throw new Error(`${label} must not be empty`);
  return parsed;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function safeId(value: unknown, label: string): string {
  const parsed = nonEmpty(value, label);
  if (inspectAndRedactSecrets(parsed).redactions.length > 0) {
    throw new Error(`${label} must not contain secret material`);
  }
  if (!/^[A-Za-z0-9._:-]+$/u.test(parsed) || parsed.includes("..")) {
    throw new Error(`${label} must be a safe identifier`);
  }
  return parsed;
}

function repositoryPath(value: unknown, label: string): string {
  const parsed = nonEmpty(value, label);
  if (parsed.startsWith("/") || parsed.includes("\\") || /^[A-Za-z]:/u.test(parsed) ||
    /[\0\r\n]/u.test(parsed) || parsed.split("/").includes("..")) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  return parsed;
}

function commitSha(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^[a-f0-9]{40}$/i.test(parsed)) throw new Error(`${label} must be a full 40-character commit SHA`);
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => nonEmpty(item, `${label}[${index}]`));
}

function safeIdArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => safeId(item, `${label}[${index}]`));
}

function enumValue<const Values extends readonly string[]>(value: unknown, values: Values, label: string): Values[number] {
  const parsed = string(value, label);
  if (!values.includes(parsed)) throw new Error(`${label} must be one of ${values.join(", ")}`);
  return parsed as Values[number];
}

function uniqueIds<T extends { id: string }>(values: readonly T[], label: string): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`${label} id ${value.id} is duplicated`);
    ids.add(value.id);
  }
  return ids;
}
