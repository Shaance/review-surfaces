export const EVIDENCE_SOURCE_KINDS = [
  "spec",
  "doc",
  "file",
  "conversation",
  "feedback",
  "unknown"
] as const;

export const EVIDENCE_KINDS = [
  "file",
  "diff",
  "test",
  "ci",
  "doc",
  "spec",
  "conversation",
  "command",
  "feedback",
  "agent_instruction",
  "url",
  "unknown"
] as const;

export const EVIDENCE_CONFIDENCE_LEVELS = ["high", "medium", "low", "unknown"] as const;

export const EVIDENCE_VALIDATION_STATUSES = [
  "valid",
  "invalid",
  "not_checked",
  "unknown"
] as const;

export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type Confidence = (typeof EVIDENCE_CONFIDENCE_LEVELS)[number];
export type ValidationStatus = (typeof EVIDENCE_VALIDATION_STATUSES)[number];

export interface EvidenceRef {
  kind: EvidenceKind;
  path?: string;
  line_start?: number;
  line_end?: number;
  sha?: string;
  url?: string;
  acai_id?: string;
  event_id?: string;
  test_name?: string;
  command?: string;
  excerpt_hash?: string;
  note?: string;
  confidence: Confidence;
  validation_status?: ValidationStatus;
  /**
   * True when this evidence was proposed by an LLM/agent reasoning stage rather
   * than discovered deterministically. Verified deterministic evidence never
   * sets this. Renderers use it to distinguish hypotheses from proof.
   */
  llm_proposed?: boolean;
  /**
   * True when this is a passing parsed test case that the deterministic
   * verification loop accepted as proof a requirement is satisfied. It is only
   * set on `kind: "test"` evidence with `validation_status: "valid"` and a real
   * parsed `test_name`. LLM-pinpointed paths additionally require deterministic
   * group corroboration; the model's claim alone can never set this flag.
   */
  verified?: boolean;
}

export interface SourceRef {
  kind: EvidenceSourceKind;
  ref: string;
  title?: string;
  evidence?: EvidenceRef[];
}
