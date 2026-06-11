// review-surfaces.READING_ORDER.2: the bounded first-leg tour snippet shared by
// BOTH sticky-comment paths (renderStickySummary and the PR-mode
// renderHumanPrComment) so the comment surfaces cannot drift. Redaction runs
// per field and the block signal is preserved for the postability gate.
import { HumanReviewModel } from "../human/contract";
import { redactSecrets } from "../privacy/secrets";

const MAX_STICKY_TOUR_STEPS = 5;
const MAX_FIELD_CHARS = 300;

export interface TourSnippet {
  text?: string;
  blocked: boolean;
}

export function firstTourLegSnippet(model: HumanReviewModel): TourSnippet {
  const leg = model.reading_order.legs[0];
  if (!leg || leg.steps.length === 0) {
    return { blocked: false };
  }
  let blocked = false;
  const field = (value: string): string => {
    const redaction = redactSecrets(value);
    if (redaction.blocked) {
      blocked = true;
    }
    const text = redaction.text.replace(/\s+/g, " ").trim();
    return text.length <= MAX_FIELD_CHARS ? text : `${text.slice(0, MAX_FIELD_CHARS - 3)}...`;
  };
  // Cap the leg itself too: a broad PR can put dozens of files in one leg, and
  // the comment must stay short.
  const shown = leg.steps.slice(0, MAX_STICKY_TOUR_STEPS);
  const steps = shown.map((step, index) => `${index + 1}. \`${field(step.path)}\` — ${field(step.why)}`).join("\n");
  const hiddenSteps = leg.steps.length - shown.length;
  const remainingLegs = model.reading_order.legs.length - 1;
  const pointers: string[] = [];
  if (hiddenSteps > 0) {
    pointers.push(`+ ${hiddenSteps} more step(s) in this leg`);
  }
  if (remainingLegs > 0) {
    pointers.push(`${remainingLegs} more leg(s)`);
  }
  const more = pointers.length > 0 ? `\n\n_${pointers.join("; ")} in the full reading order (human_review.md)._` : "";
  return { text: `### Start reading here (${field(leg.title)})\n\n${steps}${more}`, blocked };
}
