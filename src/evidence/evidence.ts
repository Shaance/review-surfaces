import type {
  Confidence,
  EvidenceKind,
  EvidenceRef,
  SourceRef,
  ValidationStatus
} from "../contracts/evidence";

export type {
  Confidence,
  EvidenceKind,
  EvidenceRef,
  SourceRef,
  ValidationStatus
} from "../contracts/evidence";

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
    sha?: string;
    validationStatus?: ValidationStatus;
  } = {}
): EvidenceRef {
  return {
    kind: "command",
    path: options.path,
    sha: options.sha,
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
    sha?: string;
    confidence?: Confidence;
    validationStatus?: ValidationStatus;
  } = {}
): EvidenceRef {
  return {
    kind: "feedback",
    path: feedbackPath,
    event_id: options.eventId,
    command: options.command,
    sha: options.sha,
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

export function uniqueEvidenceRefs(values: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return values.filter((ref) => {
    const key = JSON.stringify(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

/**
 * True when the evidence set is non-empty AND every ref is LLM-proposed, i.e. the
 * item rests ENTIRELY on hypotheses with no deterministic backing. An empty set
 * is NOT hypothesis-only (the item simply has no evidence), so a deterministic
 * finding with no refs is still treated as proof. Renderers use this to quarantine
 * hypothesis-only material away from deterministic findings (review-surfaces.EVIDENCE.6).
 */
export function isHypothesisOnly(evidence: EvidenceRef[] | undefined): boolean {
  const refs = evidence ?? [];
  return refs.length > 0 && refs.every((ref) => ref.llm_proposed === true);
}
