import test from "node:test";
import assert from "node:assert/strict";
import { renderChangeMapSvg } from "../src/human/render-svg-map";
import { changeMapLeadLevel, COCKPIT_WIDTH_PX } from "../src/human/legibility-budget";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { buildChangeGraphSections } from "../src/human/change-graph";
import { HumanReviewModel, HUMAN_REVIEW_SCHEMA_VERSION, ReviewQueueItem } from "../src/human/contract";

function file(filePath: string, status = "M") {
  return { path: filePath, status, added: 12, removed: 3 };
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

function model(overrides: Partial<HumanReviewModel> = {}): HumanReviewModel {
  const sections = buildChangeGraphSections({
    files: [file("src/core/a.ts"), file("src/render/b.ts")],
    edges: [{ importer: "src/render/b.ts", imported: "src/core/a.ts" }],
    edgeInsights: [{
      from: "src/render/b.ts",
      to: "src/core/a.ts",
      summary: "renderer reads the core map contract",
      detail: "The render file consumes the core change-map model, so review them together.",
      source: "provider"
    }],
    usedBy: [{ path: "src/core/a.ts", top: ["src/other/halo.ts"] }],
    lensFindings: [
      {
        id: "LENS-001",
        lens: "security_privacy",
        severity: "medium",
        summary: "fixture",
        reviewer_action: "look",
        evidence: [],
        suggested_tests: [],
        suggested_comments: [],
        risk_ids: ["RISK-1"],
        requirement_ids: [],
        paths: ["src/core/a.ts"],
        confidence: "medium"
      }
    ],
    reviewQueue: []
  });
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: "repo",
    spec_mode: "acai",
    verdict: { decision: "reviewable_with_attention", confidence: "medium", reasons: [] },
    summary: "Cockpit visuals fixture.",
    narrative: { source: "fallback", provider: "mock", validated_at_head: "abc", claims: [] },
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    review_queue: [queueItem("Q-1", "src/core/a.ts", 1), queueItem("Q-2", "src/render/b.ts", 2)],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      confidence_summary: "fixture",
      verified_facts: [{ id: "TF-1", summary: "v", evidence: [] }],
      claimed_not_verified: [{ id: "TC-1", status: "unverified", claim: "c", missing_evidence: "m", evidence: [] }],
      missing_evidence: [],
      invalid_evidence: []
    },
    risk_lens_findings: [
      {
        id: "LENS-001",
        lens: "security_privacy",
        severity: "medium",
        summary: "fixture",
        reviewer_action: "look",
        evidence: [],
        suggested_tests: [],
        suggested_comments: [],
        risk_ids: ["RISK-1"],
        requirement_ids: [],
        paths: ["src/core/a.ts"],
        confidence: "medium"
      }
    ],
    methodology_audit: { quality_flags: [], considered: [], research: [], workflow_findings: [] },
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
    review_plan: {
      enabled: true,
      budget_minutes: 30,
      read: [{ queue_item_id: "Q-1", path: "src/core/a.ts", estimated_minutes: 12 }],
      skim: [{ queue_item_id: "Q-2", path: "src/render/b.ts", estimated_minutes: 6 }],
      defer: []
    },
    change_graph: sections.change_graph,
    reading_order: sections.reading_order,
    evidence_cards: [],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: { packet_path: "review_packet.json", base_ref: "origin/main", head_ref: "HEAD", head_sha: "abc", uncommitted_files: 0 },
    ...overrides
  };
}

test("review-surfaces.RENDER.11 the cockpit renders the change_graph as deterministic inline SVG with layered clusters, useful relationships, title hover details, and click-to-filter hooks", () => {
  const fixture = model();
  const rendered = renderChangeMapSvg(fixture.change_graph);
  assert.ok(rendered);
  const svg = rendered!.svg;
  // Fixed viewBox, system fonts, no external libraries.
  assert.match(svg, /<svg viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /-apple-system/);
  assert.doesNotMatch(svg, /mermaid/i);
  // Clusters as column headers in model (tour) order; nodes carry churn text.
  assert.match(svg, />src\/core</);
  assert.match(svg, /\+12\/-3/);
  // Click-to-filter via the data- attribute pattern; hover via <title>.
  assert.match(svg, /data-map-file="src\/core\/a\.ts"/);
  assert.match(svg, /<title>/);
  // Blast-radius halo facts stay out of the human map; otherwise they create
  // orphan-looking lanes for files that are not part of the diff.
  assert.doesNotMatch(svg, /unchanged files using/);
  assert.doesNotMatch(svg, /src\/other\/halo\.ts/);
  // Provider-backed relationships render as routed lines, preserving the
  // visual link without drawing through cards or adding a disconnected note list.
  assert.match(svg, /<polyline/);
  assert.doesNotMatch(svg, /Why files are linked/);
  assert.match(svg, /renderer reads the core map contract/);
  assert.doesNotMatch(svg, /<path d="M /);
  // Byte-deterministic: identical model -> identical output.
  assert.equal(svg, renderChangeMapSvg(fixture.change_graph)!.svg);
  // Empty graph renders no SVG.
  assert.equal(renderChangeMapSvg({ nodes: [], halo_nodes: [], edges: [], clusters: [], overview: { groups: [], halo_count: 0, edges: [] } }), undefined);
  // Lens color never alone: the lens name appears as text alongside the fill.
  assert.match(svg, /security_privacy/);
  // The map uses the muted DESIGN.md palette instead of saturated warning fills.
  assert.match(svg, /fill="#f3ede6"/);
  assert.doesNotMatch(svg, /#fde2e2|#fee2b3|#f9fafb|#6b7280/);
  // The cockpit embeds the SVG with a text legend and the filter note.
  const html = renderHumanReviewHtml(fixture, {});
  assert.match(html, /<h2 id="map">Change map<\/h2>/);
  assert.match(html, /<svg viewBox/);
  assert.match(html, /Click a node to filter the review queue/);
  assert.match(html, /data-path="src\/core\/a\.ts"/);
});

test("review-surfaces.RENDER.11 SVG caps render explicit overflow entries, never silent truncation", () => {
  const many = buildChangeGraphSections({
    files: Array.from({ length: 30 }, (_, index) => file(`src/core/f${String(index).padStart(2, "0")}.ts`)),
    edges: [],
    usedBy: Array.from({ length: 12 }, (_, index) => ({
      path: `src/core/f${String(index).padStart(2, "0")}.ts`,
      top: [`src/halo/h${String(index).padStart(2, "0")}.ts`]
    })),
    lensFindings: [],
    reviewQueue: []
  });
  const svg = renderChangeMapSvg(many.change_graph)!.svg;
  assert.match(svg, /\+ 5 more files/); // 30 changed - 25 cap
  assert.doesNotMatch(svg, /src\/halo/);
  assert.doesNotMatch(svg, /unchanged files using/);
});

test("review-surfaces.RENDER.11 same-row relationship routes avoid intermediate cards", () => {
  const sections = buildChangeGraphSections({
    files: [file("src/a/a.ts"), file("src/b/b.ts"), file("src/c/c.ts")],
    edges: [{ importer: "src/c/c.ts", imported: "src/a/a.ts" }],
    edgeInsights: [{
      from: "src/c/c.ts",
      to: "src/a/a.ts",
      summary: "third column consumes the first column contract",
      source: "provider"
    }],
    usedBy: [],
    lensFindings: [],
    reviewQueue: []
  });
  const svg = renderChangeMapSvg(sections.change_graph)!.svg;
  const points = svg.match(/<polyline points="([^"]+)"/)?.[1];
  assert.ok(points);
  const ys = points.split(" ").map((point) => Number(point.split(",")[1]));
  assert.ok(Math.min(...ys) < Math.max(...ys), points);
});

test("review-surfaces.RENDER.12 the header strip renders lens-chip filter buttons with counts, the review_plan stacked bar with minutes, trust counts, and a progress bar — all with text labels", () => {
  const html = renderHumanReviewHtml(model(), {});
  // Chips ARE the filter buttons, with counts.
  assert.match(html, /data-lens-filter="security_privacy">Security \/ privacy lens \(\d+\)<\/button>/);
  assert.match(html, /data-lens-filter="all">All lenses \(2\)/);
  // Stacked budget bar with minutes as text (color never alone).
  assert.match(html, /read 12m/);
  assert.match(html, /skim 6m/);
  assert.match(html, /class="strip-bar"/);
  assert.match(html, /class="progress-track"/);
  // Trust counts with glyphs.
  assert.match(html, /✓ 1 verified · ~ 1 claimed/);
  // Progress bar fed by the existing checkbox state.
  assert.match(html, /id="progress-bar"/);
  assert.match(html, /0 of 2 reviewed/);
  assert.match(html, /updateProgress/);
  // The strip renders purely from existing model fields before the tour.
  assert.ok(html.indexOf('id="strip"') < html.indexOf('id="reading-order"'));
  // No chart/canvas library.
  assert.doesNotMatch(html, /<canvas/);
});

// ---------------------------------------------------------------------------
// review-surfaces.MAP_SCALE.5/.6: wrapped layout and the cockpit zoom.

test("review-surfaces.MAP_SCALE.5 the file-level SVG wraps columns into bands and long stacks into continuation slots — width never exceeds the budget, height grows", () => {
  // The typical-PR shape (evidence-log failure 1, aefc63c~1: 7 clusters,
  // previously 1792px natural width rendered at ~55%).
  const files = [];
  for (const dir of ["cli", "core", "diagrams", "human", "render", "risks"]) {
    for (let i = 0; i < 3; i++) files.push(file(`src/${dir}/f${i}.ts`));
  }
  for (let i = 0; i < 5; i++) files.push(file(`tests/t${i}.test.ts`));
  const sections = buildChangeGraphSections({
    files,
    edges: [{ importer: "src/render/f0.ts", imported: "src/core/f0.ts" }],
    usedBy: [{ path: "src/core/f0.ts", top: ["src/halo/h0.ts"] }],
    lensFindings: [],
    reviewQueue: []
  });
  // 23 nodes <= cap, so the file level leads on the cockpit despite 8 columns.
  assert.equal(changeMapLeadLevel(sections.change_graph, "svg"), "file");
  const rendered = renderChangeMapSvg(sections.change_graph) as { svg: string };
  const viewBox = rendered.svg.match(/viewBox="0 0 (\d+) (\d+)"/) as RegExpMatchArray;
  assert.ok(Number(viewBox[1]) <= COCKPIT_WIDTH_PX, `wrapped width ${viewBox[1]} must fit the ${COCKPIT_WIDTH_PX}px budget`);
  // 7 changed-file columns at 3 per band -> 3 bands: the same column x repeats
  // across bands. Blast-radius halo facts no longer add a visual column.
  const headerXs = [...rendered.svg.matchAll(/<text x="(\d+)" y="(\d+)" font-size="11" font-weight="600"/g)];
  assert.equal(headerXs.length, 7);
  const distinctY = new Set(headerXs.map((match) => match[2]));
  assert.equal(distinctY.size, 3);
  // A long stack wraps into a continuation slot with an attributable header.
  const tall = buildChangeGraphSections({
    files: Array.from({ length: 13 }, (_, i) => file(`src/core/long${String(i).padStart(2, "0")}.ts`)),
    edges: [],
    usedBy: [],
    lensFindings: [],
    reviewQueue: []
  });
  const tallSvg = (renderChangeMapSvg(tall.change_graph) as { svg: string }).svg;
  assert.match(tallSvg, /src\/core \(cont\.\)/);
});

test("review-surfaces.MAP_SCALE.6 the cockpit pre-renders hidden per-group detail SVGs toggled by overview-group clicks, and file clicks inside details keep filtering the queue", () => {
  // A wide model (>25 nodes) so the overview leads on the cockpit.
  const files = [];
  for (const dir of ["cli", "core", "human", "render"]) {
    for (let i = 0; i < 8; i++) files.push(file(`src/${dir}/w${i}.ts`));
  }
  for (let i = 0; i < 4; i++) files.push(file(`tests/w${i}.test.ts`));
  const sections = buildChangeGraphSections({
    files,
    edges: [{ importer: "tests/w0.test.ts", imported: "src/core/w0.ts" }],
    usedBy: [],
    lensFindings: [],
    reviewQueue: []
  });
  assert.equal(changeMapLeadLevel(sections.change_graph, "svg"), "overview");
  const html = renderHumanReviewHtml(model({ change_graph: sections.change_graph, reading_order: sections.reading_order }));
  // Overview cards carry data-map-group; each group gets a HIDDEN pre-rendered
  // detail panel; detail file nodes carry data-map-file so the existing
  // click-to-filter binding picks them up.
  assert.match(html, /data-map-group="src"/);
  assert.match(html, /<div class="map-detail" data-map-detail="src" hidden>/);
  assert.match(html, /<div class="map-detail" data-map-detail="tests" hidden>/);
  assert.match(html, /aria-label="Change map detail: src"/);
  const srcPanel = html.split('data-map-detail="src"')[1].split("</div>")[0];
  assert.match(srcPanel, /data-map-file="src\/core\/w0\.ts"/);
  // Generic cross-area stubs like "tests use src" stay out of the visual map;
  // they do not explain what to review together.
  assert.doesNotMatch(srcPanel, /tests use src/);
  assert.doesNotMatch(srcPanel, /outside this area/);
  assert.doesNotMatch(srcPanel, /stroke="#cf2d56"/);
  assert.doesNotMatch(srcPanel, /#f54e00/);
  assert.doesNotMatch(srcPanel, /<path d="M /);
  // The vanilla JS toggle handler ships with the cockpit.
  assert.match(html, /\[data-map-group\]/);
  assert.match(html, /panel\.hidden = !panel\.hidden/);
  // Every rendered SVG in the cockpit (overview + details) fits the budget.
  for (const match of html.matchAll(/viewBox="0 0 (\d+) \d+"/g)) {
    assert.ok(Number(match[1]) <= COCKPIT_WIDTH_PX, `SVG width ${match[1]} exceeds the budget`);
  }
});
