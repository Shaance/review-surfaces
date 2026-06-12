import test from "node:test";
import assert from "node:assert/strict";
import { buildChangeGraphSections } from "../src/human/change-graph";
import { renderHumanReviewMarkdown } from "../src/human/render";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { renderStickySummary } from "../src/render/sticky-summary";
import { ChangeGraph, HumanReviewModel, HUMAN_REVIEW_SCHEMA_VERSION, ReadingOrder, ReviewQueueItem } from "../src/human/contract";

function file(filePath: string, status = "M") {
  return { path: filePath, status, added: 1, removed: 1 };
}

function queueItem(id: string, itemPath: string, rank: number): ReviewQueueItem {
  return {
    id,
    rank,
    title: "fixture",
    path: itemPath,
    reviewer_action: "review",
    reason: "fixture",
    ranking_reasons: ["fixture"],
    evidence: [],
    requirement_ids: [],
    risk_ids: [],
    confidence: "medium",
    priority: "medium"
  };
}

function model(graph: ChangeGraph, order: ReadingOrder): HumanReviewModel {
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: "repo",
    spec_mode: "acai",
    verdict: { decision: "reviewable_with_attention", confidence: "medium", reasons: [] },
    summary: "Reading order fixture.",
    narrative: { source: "fallback", provider: "mock", validated_at_head: "abc", claims: [] },
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: { confidence_summary: "", verified_facts: [], claimed_not_verified: [], missing_evidence: [], invalid_evidence: [] },
    risk_lens_findings: [],
    intent_mismatch: { expected_by_spec: [], observed_in_diff: [], possible_mismatches: [], possible_overreach: [], missing_intent: [], claimed_candidates: [] },
    review_routes: [],
    since_last_review: {
      improved: [],
      regressed: [],
      new_risks: [],
      resolved_risks: [],
      new_overreach: [],
      resolved_overreach: [],
      still_open: [],
      count_deltas: {
        satisfied: { before: 0, after: 0, delta: 0 },
        partial: { before: 0, after: 0, delta: 0 },
        missing: { before: 0, after: 0, delta: 0 },
        unknown: { before: 0, after: 0, delta: 0 },
        invalid_evidence: { before: 0, after: 0, delta: 0 }
      }
    },
    coverage_evidence: { status: "no_report", files: [] },
    review_plan: { enabled: false, read: [], skim: [], defer: [] },
    change_graph: graph,
    reading_order: order,
    evidence_cards: [],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: { packet_path: "review_packet.json", base_ref: "origin/main", head_ref: "HEAD", head_sha: "abc", uncommitted_files: 0 }
  };
}

test("review-surfaces.READING_ORDER.1 the tour is topological dependencies-first, collapses cycles into one read-together leg alphabetical inside, and carries derived why lines with queue refs", () => {
  const sections = buildChangeGraphSections({
    files: [
      file("src/render/consumer.ts"),
      file("src/core/contract.ts"),
      file("tests/consumer.test.ts"),
      // A two-file import cycle.
      file("src/cycle/x.ts"),
      file("src/cycle/y.ts"),
      file("README.md")
    ],
    edges: [
      { importer: "src/render/consumer.ts", imported: "src/core/contract.ts" },
      { importer: "tests/consumer.test.ts", imported: "src/render/consumer.ts" },
      { importer: "src/cycle/x.ts", imported: "src/cycle/y.ts" },
      { importer: "src/cycle/y.ts", imported: "src/cycle/x.ts" }
    ],
    usedBy: [],
    lensFindings: [],
    reviewQueue: [queueItem("Q-7", "src/core/contract.ts", 1)]
  });
  const order = sections.reading_order;
  const flat = order.legs.flatMap((leg) => leg.steps.map((step) => step.path));
  // Dependencies first: contract before consumer before its test.
  assert.ok(flat.indexOf("src/core/contract.ts") < flat.indexOf("src/render/consumer.ts"));
  assert.ok(flat.indexOf("src/render/consumer.ts") < flat.indexOf("tests/consumer.test.ts"));
  // The cycle collapses into one read-together leg, alphabetical inside.
  const cycleLeg = order.legs.find((leg) => leg.read_together);
  assert.ok(cycleLeg, "expected a read-together leg for the import cycle");
  assert.deepEqual(cycleLeg?.steps.map((step) => step.path), ["src/cycle/x.ts", "src/cycle/y.ts"]);
  // Every step has a derived why and queue cross-links where queue items exist.
  for (const leg of order.legs) {
    for (const step of leg.steps) {
      assert.ok(step.why.length > 0);
    }
  }
  const contractStep = order.legs.flatMap((leg) => leg.steps).find((step) => step.path === "src/core/contract.ts");
  assert.deepEqual(contractStep?.queue_refs, ["Q-7"]);
  // Total and deterministic: every changed file appears exactly once.
  assert.equal(flat.length, 6);
  assert.equal(new Set(flat).size, 6);
  // Identical inputs -> identical output.
  const again = buildChangeGraphSections({
    files: [file("README.md"), file("src/cycle/y.ts"), file("src/cycle/x.ts"), file("tests/consumer.test.ts"), file("src/core/contract.ts"), file("src/render/consumer.ts")],
    edges: [
      { importer: "src/cycle/y.ts", imported: "src/cycle/x.ts" },
      { importer: "src/cycle/x.ts", imported: "src/cycle/y.ts" },
      { importer: "tests/consumer.test.ts", imported: "src/render/consumer.ts" },
      { importer: "src/render/consumer.ts", imported: "src/core/contract.ts" }
    ],
    usedBy: [],
    lensFindings: [],
    reviewQueue: [queueItem("Q-7", "src/core/contract.ts", 1)]
  });
  assert.deepEqual(again.reading_order, order);
});

test("review-surfaces.READING_ORDER.1 the tour never includes unchanged files (halo files belong to the map)", () => {
  const sections = buildChangeGraphSections({
    files: [file("src/a.ts")],
    edges: [],
    usedBy: [{ path: "src/a.ts", top: ["src/unchanged/importer.ts"] }],
    lensFindings: [],
    reviewQueue: []
  });
  const flat = sections.reading_order.legs.flatMap((leg) => leg.steps.map((step) => step.path));
  assert.deepEqual(flat, ["src/a.ts"]);
  assert.equal(sections.change_graph.halo_nodes.length, 1);
});

test("review-surfaces.READING_ORDER.2 the tour renders after the verdict in human_review.md and the cockpit, and the sticky carries only the first leg", () => {
  const sections = buildChangeGraphSections({
    files: [file("src/core/contract.ts"), file("src/render/consumer.ts"), file("tests/consumer.test.ts")],
    edges: [
      { importer: "src/render/consumer.ts", imported: "src/core/contract.ts" },
      { importer: "tests/consumer.test.ts", imported: "src/render/consumer.ts" }
    ],
    usedBy: [],
    lensFindings: [],
    reviewQueue: []
  });
  const fixture = model(sections.change_graph, sections.reading_order);
  const markdown = renderHumanReviewMarkdown(fixture);
  const verdictIndex = markdown.indexOf("## Verdict");
  const orderIndex = markdown.indexOf("## Reading order");
  const mapIndex = markdown.indexOf("## Change map");
  const narrativeIndex = markdown.indexOf("## Change narrative");
  assert.ok(verdictIndex >= 0 && orderIndex > verdictIndex && orderIndex < mapIndex && mapIndex < narrativeIndex, "reading order is THE section after the verdict, before the change map");
  const html = renderHumanReviewHtml(fixture, {});
  assert.match(html, /<h2 id="reading-order">Reading order<\/h2>/);
  assert.ok(html.indexOf('id="reading-order"') < html.indexOf('id="queue"'));
  // Sticky: only the FIRST leg, with a pointer to the rest.
  const sticky = renderStickySummary(fixture).markdown;
  assert.match(sticky, /### Start reading here/);
  assert.match(sticky, /src\/core\/contract\.ts/);
  assert.doesNotMatch(sticky, /tests\/consumer\.test\.ts.*read after/);
  assert.match(sticky, /more leg\(s\) in the full reading order/);
});
