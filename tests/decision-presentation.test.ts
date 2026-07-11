import test from "node:test";
import assert from "node:assert/strict";
import { buildHumanReview } from "../src/human/human-review";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { renderHumanReviewMarkdown } from "../src/human/render";
import { compactDecisionSupportingText, fullDecisionSupportingText } from "../src/human/decision-projection-presentation";
import { renderHumanPrComment } from "../src/render/pr-comment";
import { renderStickySummary } from "../src/render/sticky-summary";
import { decisionPacket as packet, decisionRisk as risk, decisionSurface as surface } from "./helpers/decision-projection";

test("review-surfaces.REVIEWER_VALUE.4 all reviewer surfaces lead with the shared decision projection", () => {
  const path = "src/reviewer.ts";
  const model = buildHumanReview({ packet: packet(), prSurface: surface([path], [risk("PR-RISK-1", "untested_changed_impl", path)]) });
  const projection = model.decision_projection!;
  const surfaces = [
    ["Markdown", renderHumanReviewMarkdown(model), "## Verdict", "## Active intent", "## Decision findings", "## Reading order", fullDecisionSupportingText(projection.supporting_detail_counts)],
    ["HTML", renderHumanReviewHtml(model), "id=\"verdict\"", "id=\"active-intent\"", "id=\"decision-findings\"", "id=\"reading-order\"", fullDecisionSupportingText(projection.supporting_detail_counts)],
    ["sticky", renderStickySummary(model).markdown, "**Reviewable with attention.**", "### Active intent", "### Decision findings", "### Review first", compactDecisionSupportingText(projection.supporting_detail_counts)],
    ["PR comment", renderHumanPrComment(model).markdown, "**Verdict:**", "### Active intent", "### Decision findings", "### Review first", compactDecisionSupportingText(projection.supporting_detail_counts)]
  ] as const;
  for (const [name, rendered, verdictMarker, intentHeading, findingsHeading, supportingHeading, supportingText] of surfaces) {
    const verdictIndex = rendered.indexOf(verdictMarker);
    const intentIndex = rendered.indexOf(intentHeading);
    const findingsIndex = rendered.indexOf(findingsHeading);
    const supportingIndex = rendered.indexOf(supportingHeading);
    assert.ok(verdictIndex >= 0, `${name} must render verdict first`);
    assert.ok(intentIndex >= 0, `${name} must render active intent`);
    assert.ok(intentIndex > verdictIndex, `${name} must render intent after verdict`);
    assert.ok(findingsIndex > intentIndex, `${name} must render findings after intent`);
    assert.ok(supportingIndex > findingsIndex, `${name} must move supporting machinery below findings`);
    assert.ok(rendered.includes(projection.active_intent.summary), `${name} must use the shared intent summary`);
    assert.ok(rendered.includes(projection.findings[0].title), `${name} must use the shared finding title`);
    assert.ok(rendered.includes(projection.findings[0].path!), `${name} must use the shared finding path`);
    assert.ok(rendered.includes(supportingText), `${name} must render the shared supporting counts`);
  }
});
