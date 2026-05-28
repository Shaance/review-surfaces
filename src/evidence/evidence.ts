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

export function commandEvidence(command: string, note?: string, confidence: Confidence = "medium"): EvidenceRef {
  return {
    kind: "command",
    command,
    note,
    confidence,
    validation_status: "not_checked"
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
