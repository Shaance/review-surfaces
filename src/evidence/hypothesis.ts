import { redactSecrets } from "../privacy/secrets";

const HYPOTHESIS_PREFIX = "LLM-proposed:";

export function redactHypothesisText(value: string): string {
  return redactSecrets(value).text;
}

export function markHypothesis(value: string): string {
  const trimmed = redactHypothesisText(value).trim();
  if (trimmed === "") {
    return trimmed;
  }
  return trimmed.startsWith(HYPOTHESIS_PREFIX) ? trimmed : `${HYPOTHESIS_PREFIX} ${trimmed}`;
}
