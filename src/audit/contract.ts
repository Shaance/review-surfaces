export const AGREEMENT_AUDIT_VERSION = "0.1.0" as const;

export const AGREEMENT_KINDS = [
  "human_instruction",
  "human_boundary",
  "agent_commitment",
  "validation_claim"
] as const;
export const AGREEMENT_STATES = ["fulfilled", "diverged", "unresolved"] as const;
export const AGREEMENT_MATERIALITIES = ["material", "supporting"] as const;
export const DIFF_SIDES = ["add", "delete", "context"] as const;
export const CONVERSATION_SCOPE_STATUSES = ["complete", "partial", "ambiguous", "missing"] as const;
export const CONVERSATION_ACTORS = ["user", "assistant", "agent", "tool"] as const;
export const CONVERSATION_SOURCE_SELECTIONS = ["explicit", "discovered"] as const;
export const COMMAND_STATUSES = ["passed", "failed", "unknown"] as const;

export type ConversationScopeStatus = (typeof CONVERSATION_SCOPE_STATUSES)[number];
export type AgreementKind = (typeof AGREEMENT_KINDS)[number];
export type AgreementState = (typeof AGREEMENT_STATES)[number];
export type AgreementMateriality = (typeof AGREEMENT_MATERIALITIES)[number];
export type AuditStatus = "needs_human_decision" | "no_mismatch_found" | "cannot_audit";

export function agreementNeedsHumanDecision(
  agreement: Pick<AgreementCandidate, "state" | "materiality">
): boolean {
  return agreement.state === "diverged" ||
    (agreement.materiality === "material" && agreement.state === "unresolved");
}

export function agreementKindAllowsActor(
  kind: AgreementKind,
  actor: AuditConversationEvent["actor"]
): boolean {
  if (kind === "human_instruction" || kind === "human_boundary") return actor === "user";
  return actor === "assistant" || actor === "agent";
}

export interface AuditConversationSource {
  /** Stable label safe to render; never an absolute local transcript path. */
  id: string;
  /** Hash of the exact source bytes used to create the normalized events. */
  sha256: string;
  selection: (typeof CONVERSATION_SOURCE_SELECTIONS)[number];
}

export interface AuditConversationEvent {
  id: string;
  source_id: string;
  actor: (typeof CONVERSATION_ACTORS)[number];
  kind: string;
  text: string;
  order: number;
}

export interface AuditConversationScope {
  status: ConversationScopeStatus;
  sources: AuditConversationSource[];
  events: AuditConversationEvent[];
  /** Plain-language reason when the selected scope is not complete. */
  caveat?: string;
}

export interface AuditDiffLine {
  path: string;
  side: (typeof DIFF_SIDES)[number];
  line: number;
  text: string;
}

export interface AuditCommandEvidence {
  id: string;
  command: string;
  status: (typeof COMMAND_STATUSES)[number];
  /** Full commit SHA. Omit when the observation is not bound to a commit. */
  head_sha?: string;
}

export interface AgreementAuditInput {
  version: typeof AGREEMENT_AUDIT_VERSION;
  repository: string;
  base_sha: string;
  head_sha: string;
  conversation: AuditConversationScope;
  diff: AuditDiffLine[];
  commands: AuditCommandEvidence[];
}

export interface CandidateDiffCitation {
  path: string;
  side: AuditDiffLine["side"];
  line: number;
  contains: string;
}

export interface AgreementCandidate {
  /** Candidate-owned stable key; benchmark gold keys are never supplied to the candidate. */
  key: string;
  kind: AgreementKind;
  statement: string;
  state: AgreementState;
  materiality: AgreementMateriality;
  conversation_event_ids: string[];
  diff_citations: CandidateDiffCitation[];
  command_ids: string[];
  reviewer_action?: string;
}

export interface AgreementAuditCandidate {
  final_goal: {
    text: string;
    conversation_event_ids: string[];
  };
  agreements: AgreementCandidate[];
  /** False when the provider was truncated or could not inspect all supplied evidence. */
  complete: boolean;
  limitations: string[];
}

export interface GroundedDiffCitation extends CandidateDiffCitation {
  validated: true;
}

export interface GroundedCommandCitation extends AuditCommandEvidence {
  exact_head: boolean;
}

export interface GroundedConversationEvidence {
  id: string;
  source_id: string;
  text: string;
}

export interface GroundedAgreement extends Omit<AgreementCandidate, "diff_citations" | "command_ids"> {
  conversation_evidence: GroundedConversationEvidence[];
  diff_citations: GroundedDiffCitation[];
  commands: GroundedCommandCitation[];
}

export interface AgreementAuditRejection {
  key: string;
  reasons: string[];
}

export interface AgreementAudit {
  version: typeof AGREEMENT_AUDIT_VERSION;
  repository: string;
  base_sha: string;
  head_sha: string;
  status: AuditStatus;
  candidate_complete: boolean;
  final_goal: AgreementAuditCandidate["final_goal"] | null;
  agreements: GroundedAgreement[];
  conversation: Pick<AuditConversationScope, "status" | "sources" | "caveat">;
  limitations: string[];
  rejections: AgreementAuditRejection[];
}
