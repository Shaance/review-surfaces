export const AGREEMENT_AUDIT_ARTIFACTS = {
  input: "agreement-audit-input.json",
  candidate: "agreement-audit-candidate.json",
  completeness: "agreement-audit-completeness.json",
  json: "audit.json",
  markdown: "audit.md"
} as const;

export const AGREEMENT_AUDIT_WORKING_ARTIFACTS = [
  AGREEMENT_AUDIT_ARTIFACTS.input,
  AGREEMENT_AUDIT_ARTIFACTS.candidate,
  AGREEMENT_AUDIT_ARTIFACTS.completeness
] as const;

export const AGREEMENT_AUDIT_FINAL_ARTIFACTS = [
  AGREEMENT_AUDIT_ARTIFACTS.json,
  AGREEMENT_AUDIT_ARTIFACTS.markdown
] as const;

export const AGREEMENT_AUDIT_ARTIFACT_NAMES = [
  ...AGREEMENT_AUDIT_WORKING_ARTIFACTS,
  ...AGREEMENT_AUDIT_FINAL_ARTIFACTS
] as const;
