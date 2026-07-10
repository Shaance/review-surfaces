export const REQUIREMENT_STATUSES = [
  "satisfied",
  "partial",
  "missing",
  "unknown",
  "overreach",
  "invalid_evidence"
] as const;

export const RISK_CATEGORIES = [
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

export const REVIEW_SEVERITIES = ["low", "medium", "high", "critical", "unknown"] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];
export type RiskCategory = (typeof RISK_CATEGORIES)[number];
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
