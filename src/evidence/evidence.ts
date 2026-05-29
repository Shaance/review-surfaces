export type EvidenceKind =
  | "file"
  | "diff"
  | "test"
  | "ci"
  | "doc"
  | "spec"
  | "conversation"
  | "command"
  | "feedback"
  | "agent_instruction"
  | "url"
  | "unknown";

export type Confidence = "high" | "medium" | "low" | "unknown";
export type ValidationStatus = "valid" | "invalid" | "not_checked" | "unknown";

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
   * sets this. The renderer uses it to visibly distinguish hypotheses from proof
   * (review-surfaces.EVIDENCE.6).
   */
  llm_proposed?: boolean;
}

export interface SourceRef {
  kind: "spec" | "doc" | "file" | "conversation" | "feedback" | "unknown";
  ref: string;
  title?: string;
  evidence?: EvidenceRef[];
}

export function specEvidence(path: string, acaiId?: string, note?: string): EvidenceRef {
  return {
    kind: "spec",
    path,
    acai_id: acaiId,
    note,
    confidence: "high",
    validation_status: "valid"
  };
}

export function fileEvidence(path: string, note?: string, confidence: Confidence = "medium"): EvidenceRef {
  return {
    kind: "file",
    path,
    note,
    confidence,
    validation_status: "not_checked"
  };
}

export function testEvidence(path: string, note?: string, confidence: Confidence = "medium"): EvidenceRef {
  return {
    kind: "test",
    path,
    note,
    confidence,
    validation_status: "not_checked"
  };
}

export function commandEvidence(
  command: string,
  note?: string,
  confidence: Confidence = "medium",
  options: {
    path?: string;
    eventId?: string;
    excerptHash?: string;
    validationStatus?: ValidationStatus;
  } = {}
): EvidenceRef {
  return {
    kind: "command",
    path: options.path,
    event_id: options.eventId,
    command,
    excerpt_hash: options.excerptHash,
    note,
    confidence,
    validation_status: options.validationStatus ?? "not_checked"
  };
}

export function feedbackEvidence(
  feedbackPath: string,
  note?: string,
  options: {
    eventId?: string;
    command?: string;
    confidence?: Confidence;
    validationStatus?: ValidationStatus;
  } = {}
): EvidenceRef {
  return {
    kind: "feedback",
    path: feedbackPath,
    event_id: options.eventId,
    command: options.command,
    note,
    confidence: options.confidence ?? "high",
    validation_status: options.validationStatus ?? "valid"
  };
}

export function missingEvidence(note: string): EvidenceRef {
  return {
    kind: "unknown",
    note,
    confidence: "unknown",
    validation_status: "unknown"
  };
}

const LLM_PROPOSED_PREFIX = "LLM-proposed:";

/**
 * Build an LLM/agent-proposed candidate evidence ref. It is ALWAYS marked as a
 * hypothesis (llm_proposed=true, note prefixed "LLM-proposed:") and capped at
 * medium confidence. It still has to pass deterministic validation before any
 * caller is allowed to attach it; this helper only labels it.
 */
export function llmProposedEvidence(
  kind: EvidenceKind,
  options: {
    path?: string;
    line_start?: number;
    line_end?: number;
    test_name?: string;
    acai_id?: string;
    note?: string;
    confidence?: "low" | "medium";
  } = {}
): EvidenceRef {
  const baseNote = (options.note ?? "").trim();
  const note = baseNote.startsWith(LLM_PROPOSED_PREFIX)
    ? baseNote
    : `${LLM_PROPOSED_PREFIX} ${baseNote}`.trim();
  return {
    kind,
    path: options.path,
    line_start: options.line_start,
    line_end: options.line_end,
    test_name: options.test_name,
    acai_id: options.acai_id,
    note,
    confidence: options.confidence ?? "low",
    validation_status: "not_checked",
    llm_proposed: true
  };
}

export function isLlmProposed(ref: EvidenceRef): boolean {
  return ref.llm_proposed === true;
}
