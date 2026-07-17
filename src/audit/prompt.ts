import {
  AGREEMENT_KINDS,
  AGREEMENT_MATERIALITIES,
  AGREEMENT_STATES,
  DIFF_SIDES,
  type AgreementAuditInput
} from "./contract";
import { inspectAndRedactSecrets } from "../privacy/secrets";

export type AuditPromptMode = "plain-agent" | "review-surfaces";

export function buildAuditPrompt(input: AgreementAuditInput, mode: AuditPromptMode): string {
  const task = mode === "plain-agent"
    ? PLAIN_TASK
    : REVIEW_SURFACES_TASK;
  const inspectedInput = inspectAndRedactSecrets(JSON.stringify(input));
  if (inspectedInput.redactions.length > 0) {
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

const PLAIN_TASK = `Review the coding-agent conversation and the code diff. Identify what the human asked for, what the agent committed to, whether the diff matches, and anything the human should decide before accepting the work. Do not perform an unrelated generic code review.`;

const REVIEW_SURFACES_TASK = `Audit the final agreement between the human and coding agent against the exact reviewed diff and validation evidence.

Read the conversation chronologically. Later human corrections and explicit boundaries supersede earlier requests and agent proposals. Represent every independently material instruction, boundary, commitment, or validation claim; the number of entries must follow the evidence rather than a fixed output cap. Collapse only duplicate evidence for the same decision.

Classify an agreement as fulfilled only with supplied diff or exact-head command evidence. Use diverged only when an exact changed line contradicts the governing conversation. Use unresolved for omissions, ambiguity, or claims that the supplied evidence cannot prove. Never invent a path, line, event, command, or clean conclusion. If the supplied scope or your inspection is incomplete, set complete=false. Do not perform generic code review: this task is only conversation-to-change alignment.`;

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
    "reviewer_action": string | undefined
  }],
  "complete": boolean,
  "limitations": string[]
}`;

function literalUnion(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(" | ");
}
