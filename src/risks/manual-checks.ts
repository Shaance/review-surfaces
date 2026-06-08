const COMPLETED_CI_SECRET_BOUNDARY_CHECK_PATTERNS = [
  /\bmanual ci secret[- ]boundary (?:check|review) (?:recorded|completed|passed|done)\b/,
  /\bci secret[- ]boundary manual (?:check|review) (?:recorded|completed|passed|done)\b/,
  /\bmanual workflow secret[- ]boundary (?:check|review) (?:recorded|completed|passed|done)\b/,
  /\bworkflow secret[- ]boundary manual (?:check|review) (?:recorded|completed|passed|done)\b/
];

const POSITIVE_CI_SECRET_BOUNDARY_CONCLUSIONS = [
  /pr-controlled code cannot access secrets/,
  /secret-bearing steps run only from trusted code.*pr-controlled files cannot influence credentialed execution/
];

const POLICY_OR_REQUIREMENT_MARKER =
  /\b(?:policy|requires?|required|must|should|needs?|prompt|before clearing|blocker|required action)\b/;

const INCONCLUSIVE_OR_FAILED_MARKER =
  /\b(?:unable|failed|failure|did not|does not|can't|cannot|not able|inconclusive|unverified|unknown)\s+(?:to\s+)?(?:confirm|verify|prove|complete|record|determine)\b|\b(?:not|never)\s+(?:confirmed|verified|completed|recorded|passed|done|safe)\b|\b(?:unsafe|leaked?|exposed?|can access secrets)\b/;

export function looksLikeRecordedCiSecretBoundaryManualCheck(text: string): boolean {
  const lower = text.toLowerCase();
  if (POLICY_OR_REQUIREMENT_MARKER.test(lower) || INCONCLUSIVE_OR_FAILED_MARKER.test(lower)) {
    return false;
  }
  const normalized = lower.replace(/\s+/g, " ");
  return (
    COMPLETED_CI_SECRET_BOUNDARY_CHECK_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    POSITIVE_CI_SECRET_BOUNDARY_CONCLUSIONS.some((pattern) => pattern.test(normalized))
  );
}
