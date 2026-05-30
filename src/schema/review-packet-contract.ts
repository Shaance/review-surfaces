export const PACKET_SCHEMA_VERSION = "review-surfaces.packet.v1" as const;

export const PACKET_RUN_MODES = ["local", "dogfood", "ci", "provider", "unknown"] as const;

export const PACKET_SOURCE_KINDS = ["spec", "doc", "file", "conversation", "feedback", "unknown"] as const;

export const PACKET_EVIDENCE_KINDS = [
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

export const PACKET_CONFIDENCE_LEVELS = ["high", "medium", "low", "unknown"] as const;

export const PACKET_VALIDATION_STATUSES = ["valid", "invalid", "not_checked", "unknown"] as const;

export const PACKET_REQUIREMENT_STATUSES = [
  "satisfied",
  "partial",
  "missing",
  "unknown",
  "overreach",
  "invalid_evidence"
] as const;

export const PACKET_PARTIAL_REASONS = [
  "impl_no_test",
  "test_no_impl",
  "impl_broad_no_exact_test",
  "exact_impl_broad_test",
  "broad_area_only",
  "other"
] as const;

export const PACKET_DIAGRAM_STATUSES = ["valid", "invalid"] as const;

export const PACKET_DIAGRAM_TYPES = ["flowchart", "sequenceDiagram", "unknown"] as const;

export const PACKET_SEVERITIES = ["low", "medium", "high", "critical", "unknown"] as const;

export const PACKET_RISK_CATEGORIES = [
  "correctness",
  "security",
  "privacy",
  "maintainability",
  "architecture",
  "testing",
  "workflow",
  "release",
  "performance",
  "unknown"
] as const;

export const PACKET_RISK_SEVERITIES = PACKET_SEVERITIES;

export const PACKET_DOGFOOD_SEVERITIES = PACKET_SEVERITIES;

export const PACKET_RISK_LIKELIHOODS = ["low", "medium", "high", "unknown"] as const;

export const PACKET_RISK_DETECTABILITY = ["easy", "moderate", "hard", "unknown"] as const;

export const PACKET_TEST_EVIDENCE_KINDS = ["direct", "indirect", "claimed", "missing", "unknown"] as const;

export const PACKET_REMEDIATION_TYPES = ["code", "test", "schema", "doc", "spec", "skill", "feedback", "defer"] as const;

export const PACKET_DOGFOOD_CATEGORIES = [
  "usability",
  "review_value",
  "evidence_quality",
  "agent_workflow",
  "schema",
  "diagram_quality",
  "test_gap",
  "performance",
  "unknown"
] as const;

export const PACKET_COMPARISON_DIRECTIONS = ["improved", "regressed", "unchanged"] as const;

export const PACKET_HELPFULNESS_VALUES = ["yes", "partially", "no", "unknown"] as const;

export type PacketRunMode = (typeof PACKET_RUN_MODES)[number];
export type PacketSourceKind = (typeof PACKET_SOURCE_KINDS)[number];
export type PacketEvidenceKind = (typeof PACKET_EVIDENCE_KINDS)[number];
export type PacketConfidence = (typeof PACKET_CONFIDENCE_LEVELS)[number];
export type PacketValidationStatus = (typeof PACKET_VALIDATION_STATUSES)[number];
export type PacketRequirementStatus = (typeof PACKET_REQUIREMENT_STATUSES)[number];
export type PacketPartialReason = (typeof PACKET_PARTIAL_REASONS)[number];
export type PacketDiagramStatus = (typeof PACKET_DIAGRAM_STATUSES)[number];
export type PacketDiagramType = (typeof PACKET_DIAGRAM_TYPES)[number];
export type PacketRiskCategory = (typeof PACKET_RISK_CATEGORIES)[number];
export type PacketSeverity = (typeof PACKET_SEVERITIES)[number];
export type PacketRiskLikelihood = (typeof PACKET_RISK_LIKELIHOODS)[number];
export type PacketRiskDetectability = (typeof PACKET_RISK_DETECTABILITY)[number];
export type PacketTestEvidenceKind = (typeof PACKET_TEST_EVIDENCE_KINDS)[number];
export type PacketRemediationType = (typeof PACKET_REMEDIATION_TYPES)[number];
export type PacketDogfoodCategory = (typeof PACKET_DOGFOOD_CATEGORIES)[number];
export type PacketComparisonDirection = (typeof PACKET_COMPARISON_DIRECTIONS)[number];
export type PacketHelpfulness = (typeof PACKET_HELPFULNESS_VALUES)[number];
