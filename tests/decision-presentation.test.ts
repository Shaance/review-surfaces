import test from "node:test";
import assert from "node:assert/strict";
import { buildHumanReview } from "../src/human/human-review";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { renderHumanReviewMarkdown } from "../src/human/render";
import { renderStickySummary } from "../src/render/sticky-summary";
import { decisionPacket as packet, decisionRisk as risk, decisionSurface as surface } from "./helpers/decision-projection";

test("review-surfaces.REVIEWER_VALUE.4 all reviewer surfaces lead with the shared decision projection", () => {
  const path = "src/reviewer.ts";
  const model = buildHumanReview({ packet: packet(), prSurface: surface([path], [risk("PR-RISK-1", "untested_changed_impl", path)]) });
  const projection = model.decision_projection!;
  const surfaces = [
    ["Markdown", renderHumanReviewMarkdown(model), "## Verdict", "## Change purpose", "## Approval decision", "## Supporting review queue"],
    ["HTML", renderHumanReviewHtml(model), "id=\"verdict\"", "id=\"change-purpose\"", "id=\"approval-decisions\"", "id=\"queue\""],
    ["sticky", renderStickySummary(model).markdown, "**Reviewable with attention.**", "### Change purpose", "### Approval decision", undefined]
  ] as const;
  for (const [name, rendered, verdictMarker, purposeHeading, decisionsHeading, queueHeading] of surfaces) {
    const verdictIndex = rendered.indexOf(verdictMarker);
    const purposeIndex = rendered.indexOf(purposeHeading);
    const decisionsIndex = rendered.indexOf(decisionsHeading);
    assert.ok(verdictIndex >= 0, `${name} must render verdict first`);
    assert.ok(purposeIndex > verdictIndex, `${name} must render purpose after verdict`);
    assert.ok(decisionsIndex > purposeIndex, `${name} must render decisions after purpose`);
    if (queueHeading) {
      assert.ok(rendered.indexOf(queueHeading) > decisionsIndex, `${name} must move the supporting queue below approval decisions`);
    } else {
      assert.doesNotMatch(rendered, /Review first|Review queue|Supporting review queue/, `${name} must not repeat the mechanical queue`);
    }
    const purposeLead = projection.active_intent.summary.split(" [")[0];
    assert.ok(rendered.includes(purposeLead), `${name} must use the shared purpose`);
    assert.ok(rendered.includes(projection.findings[0].title), `${name} must use the shared finding title`);
    assert.ok(rendered.includes(projection.findings[0].path!), `${name} must use the shared finding path`);
    assert.doesNotMatch(rendered, /remain as supporting detail/, `${name} must not lead with internal machinery counts`);
  }
});

test("the full reviewer surfaces preserve the complete shared author purpose", () => {
  const path = "src/reviewer.ts";
  const model = buildHumanReview({ packet: packet(), prSurface: surface([path], [risk("PR-RISK-1", "untested_changed_impl", path)]) });
  const purpose = `${"p".repeat(1_980)} purpose-tail-marker`;
  assert.equal(purpose.length, 2_000);
  model.decision_projection.active_intent.summary = purpose;

  const surfaces = [
    ["Markdown", renderHumanReviewMarkdown(model)],
    ["HTML", renderHumanReviewHtml(model)],
    ["sticky", renderStickySummary(model).markdown]
  ] as const;
  for (const [name, rendered] of surfaces) {
    assert.ok(rendered.includes(purpose), `${name} must preserve the complete shared author purpose`);
  }
});
