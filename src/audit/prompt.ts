import {
  AGREEMENT_KINDS,
  AGREEMENT_MATERIALITIES,
  AGREEMENT_STATES,
  DIFF_SIDES,
  COMPLETENESS_DISPOSITIONS,
  type AgreementAuditCandidate,
  type AgreementAuditInput
} from "./contract";
import { inspectAndRedactSecrets } from "../privacy/secrets";

export type AuditPromptMode = "plain-agent" | "review-surfaces";

export function buildAuditPrompt(input: AgreementAuditInput, mode: AuditPromptMode): string {
  const task = mode === "plain-agent"
    ? PLAIN_TASK
    : REVIEW_SURFACES_TASK;
  const inspectedInput = inspectAndRedactSecrets(JSON.stringify(input));
  if (inspectedInput.blocked || inspectedInput.redactions.length > 0) {
    throw new Error("audit input contains secret material; refusing provider generation");
  }
  return [
    task,
    "",
    "Return only JSON matching the candidate contract described below.",
    "",
    CANDIDATE_CONTRACT,
    "",
    "Input:",
    inspectedInput.text
  ].join("\n");
}

export function buildCompletenessPrompt(
  input: AgreementAuditInput,
  candidate: AgreementAuditCandidate
): string {
  const inspected = inspectAndRedactSecrets(JSON.stringify({
    conversation: input.conversation,
    candidate: {
      final_goal: candidate.final_goal,
      agreements: candidate.agreements.map((agreement) => ({
        key: agreement.key,
        kind: agreement.kind,
        statement: agreement.statement,
        materiality: agreement.materiality,
        conversation_event_ids: agreement.conversation_event_ids
      })),
      complete: candidate.complete,
      limitations: candidate.limitations
    }
  }));
  if (inspected.blocked || inspected.redactions.length > 0) {
    throw new Error("audit input contains secret material; refusing completeness generation");
  }
  return [
    "Independently verify whether the proposed agreement extraction covers the supplied conversation.",
    "Inspect every user, assistant, and agent event. Give each exactly one disposition. Mark an event represented only when a listed atomic agreement cites that exact event and no other auditable event. This untrusted pass cannot safely declare user, assistant, or agent text non_material; report any event missing its own instruction, boundary, commitment, or validation agreement. Do not assess generic code quality and do not trust the candidate's complete flag.",
    "",
    "Return only JSON matching this contract:",
    COMPLETENESS_CONTRACT,
    "",
    "Input and proposed extraction:",
    inspected.text
  ].join("\n");
}

const PLAIN_TASK = `Review the coding-agent conversation and the code diff. Identify what the human asked for, what the agent committed to, whether the diff matches, and anything the human should decide before accepting the work. Do not perform an unrelated generic code review.`;

const REVIEW_SURFACES_TASK = `Audit the final agreement between the human and coding agent against the exact reviewed diff and validation evidence.

Read the conversation chronologically. Later human corrections and explicit boundaries supersede earlier requests and agent proposals. Represent every independently material instruction, boundary, commitment, or validation claim; the number of entries must follow the evidence rather than a fixed output cap. Collapse only duplicate evidence for the same decision.

Each agreement must cite exactly one user, assistant, or agent event; split separate turns into separate atomic agreements even when they discuss the same work. Classify an agreement as fulfilled only with supplied diff or exact-head command evidence. Use diverged only when an exact changed line contradicts the governing conversation or, for a validation claim, a failed exact-head command contradicts a claimed pass. Use unresolved for omissions, ambiguity, or claims that the supplied evidence cannot prove. For every diverged or unresolved agreement, include a concrete reviewer_action. Never invent a path, line, event, command, or clean conclusion. If the supplied scope or your inspection is incomplete, set complete=false. Do not perform generic code review: this task is only conversation-to-change alignment.`;

const CANDIDATE_CONTRACT = `{
  "final_goal": { "text": string, "conversation_event_ids": string[] },
  "agreements": [{
    "key": string,
    "kind": ${literalUnion(AGREEMENT_KINDS)},
    "statement": string,
    "state": ${literalUnion(AGREEMENT_STATES)},
    "materiality": ${literalUnion(AGREEMENT_MATERIALITIES)},
    "conversation_event_ids": string[],
    "diff_citations": [{ "path": string, "side": ${literalUnion(DIFF_SIDES)}, "line": number, "contains": string }],
    "command_ids": string[],
    "reviewer_action": string (required for every diverged or unresolved agreement; otherwise omit)
  }],
  "complete": boolean,
  "limitations": string[]
}`;

const COMPLETENESS_CONTRACT = `{
  "complete": boolean,
  "dispositions": [{
    "event_id": string,
    "disposition": ${literalUnion(COMPLETENESS_DISPOSITIONS)},
    "agreement_keys": string[],
    "reason": string (required for non_material; otherwise omit)
  }],
  "missing_agreements": string[],
  "limitations": string[]
}`;

export const AGREEMENT_CANDIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["final_goal", "agreements", "complete", "limitations"],
  properties: {
    final_goal: {
      type: "object",
      additionalProperties: false,
      required: ["text", "conversation_event_ids"],
      properties: { text: { type: "string" }, conversation_event_ids: { type: "array", items: { type: "string" } } }
    },
    agreements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "kind", "statement", "state", "materiality", "conversation_event_ids", "diff_citations", "command_ids"],
        properties: {
          key: { type: "string" },
          kind: { type: "string", enum: [...AGREEMENT_KINDS] },
          statement: { type: "string" },
          state: { type: "string", enum: [...AGREEMENT_STATES] },
          materiality: { type: "string", enum: [...AGREEMENT_MATERIALITIES] },
          conversation_event_ids: { type: "array", items: { type: "string" } },
          diff_citations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "side", "line", "contains"],
              properties: {
                path: { type: "string" }, side: { type: "string", enum: [...DIFF_SIDES] },
                line: { type: "integer", minimum: 1 }, contains: { type: "string" }
              }
            }
          },
          command_ids: { type: "array", items: { type: "string" } },
          reviewer_action: { type: "string" }
        }
      }
    },
    complete: { type: "boolean" },
    limitations: { type: "array", items: { type: "string" } }
  }
} as const;

export const AGREEMENT_COMPLETENESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["complete", "dispositions", "missing_agreements", "limitations"],
  properties: {
    complete: { type: "boolean" },
    dispositions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["event_id", "disposition", "agreement_keys"],
        properties: {
          event_id: { type: "string" },
          disposition: { type: "string", enum: [...COMPLETENESS_DISPOSITIONS] },
          agreement_keys: { type: "array", items: { type: "string" } },
          reason: { type: "string" }
        }
      }
    },
    missing_agreements: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } }
  }
} as const;

function literalUnion(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(" | ");
}
