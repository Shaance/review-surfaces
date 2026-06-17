import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildChangeGraphSections, buildGroupDetailViews, computeChangedImportEdges, detailViewSubGraph } from "../src/human/change-graph";
import { renderChangeMapMermaid, renderChangeMapOverviewMermaid } from "../src/diagrams/change-map";
import { changeMapLeadLevel, COCKPIT_WIDTH_PX } from "../src/human/legibility-budget";
import { renderChangeMapOverviewSvg } from "../src/human/render-svg-map";
import { changeMapDetailsBlock } from "../src/render/change-map-embed";
import { renderHumanPrComment } from "../src/render/pr-comment";
import { renderStickySummary } from "../src/render/sticky-summary";
import { renderHumanReviewMarkdown } from "../src/human/render";
import { ChangeGraph, HumanReviewModel, HUMAN_REVIEW_SCHEMA_VERSION, ReviewQueueItem, RiskLensFinding } from "../src/human/contract";
import { validateJsonSchema } from "../src/schema/json-schema";

function file(filePath: string, status = "M", added = 10, removed = 2) {
  return { path: filePath, status, added, removed };
}

function lensFinding(lens: RiskLensFinding["lens"], paths: string[], id = "LENS-001"): RiskLensFinding {
  return {
    id,
    lens,
    severity: "medium",
    summary: "fixture",
    reviewer_action: "look",
    evidence: [],
    suggested_tests: [],
    suggested_comments: [],
    risk_ids: [],
    requirement_ids: [],
    paths,
    confidence: "medium"
  };
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

function model(graph: ChangeGraph, legs: HumanReviewModel["reading_order"]["legs"] = []): HumanReviewModel {
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: "repo",
    spec_mode: "acai",
    verdict: { decision: "reviewable_with_attention", confidence: "medium", reasons: [] },
    summary: "Change map fixture.",
    narrative: { source: "fallback", provider: "mock", validated_at_head: "abc", claims: [] },
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: { confidence_summary: "", verified_facts: [], claimed_not_verified: [], missing_evidence: [], invalid_evidence: [] },
    risk_lens_findings: [],
    methodology_audit: { considered: [], research: [], workflow_findings: [] },
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
    reading_order: { legs },
    evidence_cards: [],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: { packet_path: "review_packet.json", base_ref: "origin/main", head_ref: "HEAD", head_sha: "abc", uncommitted_files: 0 }
  };
}

test("review-surfaces.CHANGE_MAP.1 change_graph carries churn/lens/status nodes, bounded halo from blast-radius facts, existing-kind edges, and sorted clusters", () => {
  const sections = buildChangeGraphSections({
    files: [file("src/render/b.ts", "M", 5, 1), file("src/core/a.ts", "A", 20, 0), file("tests/a.test.ts", "M", 3, 3)],
    edges: [
      { importer: "src/render/b.ts", imported: "src/core/a.ts" },
      { importer: "tests/a.test.ts", imported: "src/core/a.ts" },
      // Duplicate must dedupe; self-loop must drop.
      { importer: "src/render/b.ts", imported: "src/core/a.ts" },
      { importer: "src/core/a.ts", imported: "src/core/a.ts" }
    ],
    usedBy: [{ path: "src/core/a.ts", top: ["src/other/x.ts", "src/other/y.ts", "src/other/z.ts"] }],
    lensFindings: [lensFinding("security_privacy", ["src/core/a.ts"])],
    reviewQueue: [queueItem("Q-1", "src/core/a.ts", 1)]
  });
  const graph = sections.change_graph;
  assert.deepEqual(graph.nodes.map((node) => node.path), ["src/core/a.ts", "src/render/b.ts", "tests/a.test.ts"]);
  const a = graph.nodes[0];
  assert.equal(a.status, "added");
  assert.equal(a.churn_added, 20);
  assert.equal(a.lens, "security_privacy");
  assert.equal(a.cluster, "src/core");
  // Edges: importer -> imported per the contract (renderers reverse at draw
  // time), kind slot present (existing in M9), deduped.
  assert.deepEqual(graph.edges, [
    { from: "src/render/b.ts", to: "src/core/a.ts", kind: "existing" },
    { from: "tests/a.test.ts", to: "src/core/a.ts", kind: "existing" }
  ]);
  // Halo: at most TWO per high-blast node, alphabetical as the fact stores them.
  assert.deepEqual(graph.halo_nodes.map((node) => node.path), ["src/other/x.ts", "src/other/y.ts"]);
  assert.deepEqual(graph.halo_nodes[0].imports, ["src/core/a.ts"]);
  // Clusters cover every node, ordered by tour first-appearance.
  assert.deepEqual(graph.clusters.map((cluster) => cluster.name), ["src/core", "src/render", "tests"]);
  // The model validates against the strict schema as part of a full model.
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));
  const result = validateJsonSchema(schema, model(graph, sections.reading_order.legs));
  assert.ok(result.valid, JSON.stringify(result));
});

test("review-surfaces.CHANGE_MAP.1 computeChangedImportEdges restricts buildImportGraph output to changed files", () => {
  const contents = new Map<string, string>([
    ["src/a.ts", "export const a = 1;"],
    ["src/b.ts", 'import { a } from "./a";\nexport const b = a;'],
    ["src/c.ts", 'import { b } from "./b";\nimport { unchanged } from "./unchanged";']
  ]);
  const edges = computeChangedImportEdges({
    changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
    read: (filePath) => contents.get(filePath),
    exists: (filePath) => contents.has(filePath) || filePath === "src/unchanged.ts"
  });
  assert.deepEqual(edges.map((edge) => `${edge.imported} -> ${edge.importer}`), ["src/a.ts -> src/b.ts", "src/b.ts -> src/c.ts"]);
});

test("review-surfaces.CHANGE_MAP.2 the mermaid emitter renders flowchart LR with cluster subgraphs, lens classDefs, and explicit overflow nodes — never silent truncation", () => {
  const manyFiles = Array.from({ length: 30 }, (_, index) => file(`src/core/file${String(index).padStart(2, "0")}.ts`));
  const sections = buildChangeGraphSections({
    files: manyFiles,
    edges: [],
    usedBy: [],
    lensFindings: [lensFinding("api_contract", [manyFiles[0].path])],
    reviewQueue: []
  });
  const body = renderChangeMapMermaid(sections.change_graph) as string;
  assert.ok(body.startsWith("flowchart LR"));
  assert.match(body, /subgraph c0\["src\/core"\]/);
  assert.match(body, /classDef lens_api_contract/);
  // 30 nodes, cap 25 -> an explicit "+ 5 more files" overflow node.
  assert.match(body, /\+ 5 more files/);
  // No spec/requirement anchors on the map (CHANGE_MAP.3): no ACID-shaped labels.
  assert.doesNotMatch(body, /review-surfaces\.[A-Z_]+\.\d/);
  // Empty graph renders nothing rather than an empty diagram.
  assert.equal(renderChangeMapMermaid({ nodes: [], halo_nodes: [], edges: [], clusters: [], overview: { groups: [], halo_count: 0, edges: [] } }), undefined);
});

test("review-surfaces.CHANGE_MAP.2 halo nodes render dashed with a cap and explicit overflow", () => {
  const sections = buildChangeGraphSections({
    files: Array.from({ length: 12 }, (_, index) => file(`src/core/mod${String(index).padStart(2, "0")}.ts`)),
    edges: [],
    usedBy: Array.from({ length: 12 }, (_, index) => ({
      path: `src/core/mod${String(index).padStart(2, "0")}.ts`,
      top: [`src/halo/h${String(index).padStart(2, "0")}.ts`]
    })),
    lensFindings: [],
    reviewQueue: []
  });
  assert.equal(sections.change_graph.halo_nodes.length, 12);
  const body = renderChangeMapMermaid(sections.change_graph) as string;
  assert.match(body, /blast radius \(unchanged importers\)/);
  assert.match(body, /\+ 2 more files/); // 12 halo - cap 10
  assert.match(body, /stroke-dasharray/);
});

test("review-surfaces.CHANGE_MAP.3 the map embeds on renderHumanPrComment and the sticky as collapsed details, and the old narrative-path Change impact embed is retired", () => {
  const sections = buildChangeGraphSections({
    files: [file("src/a.ts"), file("src/b.ts")],
    edges: [{ importer: "src/b.ts", imported: "src/a.ts" }],
    usedBy: [],
    lensFindings: [],
    reviewQueue: []
  });
  const fixture = model(sections.change_graph, sections.reading_order.legs);
  const prComment = renderHumanPrComment(fixture).markdown;
  assert.match(prComment, /<details><summary>Change map<\/summary>/);
  assert.match(prComment, /```mermaid/);
  const sticky = renderStickySummary(fixture);
  assert.match(sticky.markdown, /<details><summary>Change map<\/summary>/);
  // human_review.md gets a Change map section.
  const markdown = renderHumanReviewMarkdown(fixture);
  assert.match(markdown, /## Change map/);
  assert.match(markdown, /```mermaid/);
  // The retired embed: the provider-narrative comment no longer renders the
  // requirements-hairball "Change impact" details block.
  const prCommentSource = fs.readFileSync(path.join(process.cwd(), "src", "render", "pr-comment.ts"), "utf8");
  assert.doesNotMatch(prCommentSource, /### Change impact/);
});

test("review-surfaces.CHANGE_MAP.4 labels pass the shared sanitizer, the fence-close guard omits hostile bodies, and determinism-check covers PR scope", () => {
  // A path crafted to unbalance mermaid syntax must be sanitized by the SHARED
  // diagramLabel (no private copies left in pr-change-diagram).
  const sections = buildChangeGraphSections({
    files: [file('src/evil"]x[/file.ts')],
    edges: [],
    usedBy: [],
    lensFindings: [],
    reviewQueue: []
  });
  const body = renderChangeMapMermaid(sections.change_graph) as string;
  assert.doesNotMatch(body, /evil"\]/);
  const prChangeDiagramSource = fs.readFileSync(path.join(process.cwd(), "src", "diagrams", "pr-change-diagram.ts"), "utf8");
  assert.doesNotMatch(prChangeDiagramSource, /function diagramLabel/);
  // Fence-close guard at the embed point: a graph whose rendered body would
  // close the fence is omitted entirely.
  const hostile: ChangeGraph = {
    nodes: [{ path: "```\nplain.ts", churn_added: 1, churn_removed: 0, status: "modified", cluster: "(root)" }],
    halo_nodes: [],
    edges: [],
    clusters: [{ name: "```", paths: ["```\nplain.ts"] }],
    overview: { groups: [{ name: "```", file_count: 1, cluster_count: 1, churn_added: 1, churn_removed: 0, queue_count: 0 }], halo_count: 0, edges: [] }
  };
  // diagramLabel collapses newlines, so a hostile label can never reach a line
  // start; the fence guard is the body-level backstop. Either the block is
  // omitted entirely or no inner body line can close the fence.
  const block = changeMapDetailsBlock(hostile);
  if (block !== undefined) {
    const inner = (block.split("```mermaid\n")[1] ?? "").split("\n```")[0];
    assert.doesNotMatch(inner, /^\s*```/m);
  }
  // determinism-check exercises a PR-scope run, not only repo scope.
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "determinism-check.sh"), "utf8");
  assert.match(script, /for SCOPE in repo pr/);
  assert.match(script, /--review-scope/);
});

// ---------------------------------------------------------------------------
// review-surfaces.MAP_SCALE.1-3: the overview level. The fixture reproduces
// the 2026-06-12 legibility evidence-log failure 1 shape — the aefc63c~8
// range: 99 changed files across 23 clusters, whose file-level map rendered
// at ~16% of natural size while hiding 74 files and dropping edges silently.

function wideFixtureSections() {
  const files = [];
  const srcDirs = ["cli", "collector", "core", "diagrams", "dogfood", "evaluation", "feedback", "human", "intent", "llm", "pipeline", "privacy", "render", "risks"];
  for (const dir of srcDirs) {
    for (let i = 0; i < 5; i++) {
      files.push(file(`src/${dir}/f${i}.ts`, "M", 7, 3));
    }
  }
  for (let i = 0; i < 8; i++) files.push(file(`tests/t${i}.test.ts`));
  for (let i = 0; i < 3; i++) files.push(file(`schemas/s${i}.schema.json`));
  for (let i = 0; i < 4; i++) files.push(file(`scripts/sc${i}.sh`));
  for (let i = 0; i < 5; i++) files.push(file(`docs/d${i}.md`));
  for (let i = 0; i < 2; i++) files.push(file(`features/f${i}.feature.yaml`));
  for (let i = 0; i < 2; i++) files.push(file(`bin/b${i}.js`));
  for (let i = 0; i < 2; i++) files.push(file(`.github/workflows/w${i}.yml`));
  files.push(file("README.md"), file("package.json"), file("types/global.d.ts"));
  assert.equal(files.length, 99);
  return buildChangeGraphSections({
    files,
    edges: [
      // Intra-group (src -> src across clusters): the zoom level's job, must
      // NOT appear as overview edges but must be accounted for in the honesty
      // assertion below.
      { importer: "src/render/f0.ts", imported: "src/core/f0.ts" },
      { importer: "src/human/f0.ts", imported: "src/core/f1.ts" },
      // Cross-group: tests -> src (x2) and bin -> src.
      { importer: "tests/t0.test.ts", imported: "src/core/f0.ts" },
      { importer: "tests/t1.test.ts", imported: "src/core/f0.ts" },
      { importer: "bin/b0.js", imported: "src/cli/f0.ts" }
    ],
    driftEdges: {
      // bin -> src is newly added (has_new); a removed tests -> src edge
      // appends with kind removed (has_removed merges onto the same group edge
      // as the two existing tests -> src edges).
      added: [{ importer: "bin/b0.js", imported: "src/cli/f0.ts" }],
      removed: [{ importer: "tests/t2.test.ts", imported: "src/core/f3.ts" }]
    },
    usedBy: [{ path: "src/core/f0.ts", top: ["src/unchanged/u0.ts", "src/unchanged/u1.ts"] }],
    lensFindings: [
      lensFinding("security_privacy", ["src/core/f0.ts", "src/core/f1.ts"], "LENS-001"),
      lensFinding("api_contract", ["src/cli/f0.ts"], "LENS-002"),
      // tests group: one reviewer_ux + one test_evidence finding — a count tie
      // the lens rank must break deterministically (test_evidence rank 3 beats
      // reviewer_ux rank 4).
      lensFinding("reviewer_ux", ["tests/t0.test.ts"], "LENS-003"),
      lensFinding("test_evidence", ["tests/t1.test.ts"], "LENS-004")
    ],
    reviewQueue: [
      queueItem("Q-1", "src/core/f0.ts", 1),
      queueItem("Q-2", "tests/t0.test.ts", 2),
      queueItem("Q-3", "README.md", 3),
      // A repo-level item that maps to no changed file belongs to no group.
      queueItem("Q-4", "(repo)", 4)
    ]
  });
}

test("review-surfaces.MAP_SCALE.1 change_graph grows a schema-visible overview: clusters merged by first path segment, (root) stays itself, counts/churn/lens/queue per group, one aggregate halo entry, weighted inter-group edges", () => {
  const sections = wideFixtureSections();
  const graph = sections.change_graph;
  assert.equal(graph.nodes.length, 99);
  assert.equal(graph.clusters.length, 23);
  const overview = graph.overview;
  // Groups: 14 src/* clusters merge into one "src"; "(root)" stays itself.
  const names = overview.groups.map((group) => group.name);
  assert.deepEqual([...names].sort(), ["(root)", ".github", "bin", "docs", "features", "schemas", "scripts", "src", "tests", "types"]);
  const src = overview.groups.find((group) => group.name === "src");
  assert.ok(src);
  assert.equal(src.file_count, 70);
  assert.equal(src.cluster_count, 14);
  assert.equal(src.churn_added, 70 * 7);
  assert.equal(src.churn_removed, 70 * 3);
  assert.equal(src.queue_count, 1);
  // Dominant lens: security_privacy cites 2 src files vs api_contract's 1.
  assert.equal(src.lens, "security_privacy");
  // Count tie in tests group breaks by lens rank (test_evidence rank 3 < reviewer_ux rank 4).
  const tests = overview.groups.find((group) => group.name === "tests");
  assert.ok(tests);
  assert.equal(tests.lens, "test_evidence");
  assert.equal(tests.queue_count, 1);
  const root = overview.groups.find((group) => group.name === "(root)");
  assert.ok(root);
  assert.equal(root.file_count, 2);
  assert.equal(root.queue_count, 1);
  // One aggregate halo entry: the count of file-level halo nodes.
  assert.equal(overview.halo_count, 2);
  assert.equal(graph.halo_nodes.length, 2);
  // Aggregated inter-group edges: tests->src carries weight 3 (two existing +
  // one removed) with has_removed; bin->src weight 1 with has_new. Intra-src
  // edges do NOT surface here.
  assert.deepEqual(overview.edges, [
    { from: "bin", to: "src", weight: 1, has_new: true, has_removed: false },
    { from: "tests", to: "src", weight: 3, has_new: false, has_removed: true }
  ]);
  // The full model with the overview validates against the strict schema.
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));
  const result = validateJsonSchema(schema, model(graph, sections.reading_order.legs));
  assert.ok(result.valid, JSON.stringify(result));
});

test("review-surfaces.MAP_SCALE.2 the legibility budget decides per surface: the overview leads everywhere on the wide fixture and the small-diff file-level map is unchanged", () => {
  const wide = wideFixtureSections();
  assert.equal(changeMapLeadLevel(wide.change_graph, "mermaid"), "overview");
  assert.equal(changeMapLeadLevel(wide.change_graph, "svg"), "overview");
  const fixture = model(wide.change_graph, wide.reading_order.legs);
  // human_review.md: honest lead-in plus the overview mermaid, not 99 file nodes.
  const markdown = renderHumanReviewMarkdown(fixture);
  assert.match(markdown, /Overview — 99 changed file\(s\) across 10 group\(s\)/);
  assert.match(markdown, /70 file\(s\) · 14 cluster\(s\)/);
  // The LEAD diagram is the overview (no per-file subgraphs); the per-group
  // detail blocks below it carry the file-level subgraphs (MAP_SCALE.6).
  const leadFence = markdown.split("## Change map")[1].split("```mermaid\n")[1].split("\n```")[0];
  assert.doesNotMatch(leadFence, /subgraph c0/);
  assert.match(leadFence, /^flowchart LR/);
  // Sticky comment: the details block is titled honestly and stays compact.
  const sticky = renderStickySummary(fixture);
  assert.match(sticky.markdown, /<details><summary>Change map \(overview\)<\/summary>/);
  assert.doesNotMatch(sticky.markdown, /\+ \d+ more files/);
  // PR comment surface: same decision, same title.
  const prComment = renderHumanPrComment(fixture).markdown;
  assert.match(prComment, /<details><summary>Change map \(overview\)<\/summary>/);
  // The overview mermaid carries weighted edges with flags, dashed halo, and
  // dominant-lens classes.
  const body = renderChangeMapOverviewMermaid(wide.change_graph.overview) as string;
  assert.match(body, /×3 · removed/);
  assert.match(body, /×1 · new/);
  assert.match(body, /blast radius<br\/>2 unchanged importer\(s\)/);
  assert.match(body, /classDef lens_security_privacy/);
  // Small diff (4 columns incl. halo): the file-level map still leads with
  // today's structure on every surface.
  const small = buildChangeGraphSections({
    files: [file("src/core/a.ts"), file("src/render/b.ts"), file("tests/a.test.ts")],
    edges: [{ importer: "src/render/b.ts", imported: "src/core/a.ts" }],
    usedBy: [{ path: "src/core/a.ts", top: ["src/other/halo.ts"] }],
    lensFindings: [],
    reviewQueue: []
  });
  assert.equal(changeMapLeadLevel(small.change_graph, "mermaid"), "file");
  assert.equal(changeMapLeadLevel(small.change_graph, "svg"), "file");
  const smallSticky = renderStickySummary(model(small.change_graph, small.reading_order.legs));
  assert.match(smallSticky.markdown, /<details><summary>Change map<\/summary>/);
  const smallBody = renderChangeMapMermaid(small.change_graph) as string;
  assert.match(smallBody, /subgraph c0\["src\/core"\]/);
});

test("review-surfaces.MAP_SCALE.3 the overview is honest by construction: group file counts sum to every changed file, edge weights account for every inter-group model edge, and the overview SVG fits the width budget at full size", () => {
  const sections = wideFixtureSections();
  const graph = sections.change_graph;
  const overview = graph.overview;
  // File counts sum to the FULL changed-file count — nothing hidden behind
  // "+ N more" (the 74-hidden-files half of evidence-log failure 2).
  assert.equal(overview.groups.reduce((sum, group) => sum + group.file_count, 0), graph.nodes.length);
  // Cluster counts sum to every model cluster.
  assert.equal(overview.groups.reduce((sum, group) => sum + group.cluster_count, 0), graph.clusters.length);
  // Churn totals sum to the full model churn.
  assert.equal(overview.groups.reduce((sum, group) => sum + group.churn_added, 0), graph.nodes.reduce((sum, node) => sum + node.churn_added, 0));
  // Every model edge is accounted for: inter-group edges aggregate into
  // weights; the remainder are intra-group (the zoom level's job) — none
  // silently dropped (the silent-edge half of failure 2).
  const groupOfCluster = new Map(graph.nodes.map((node) => [node.path, node.cluster.split("/")[0]]));
  const intraGroup = graph.edges.filter((edge) => groupOfCluster.get(edge.from) === groupOfCluster.get(edge.to)).length;
  const aggregatedWeight = overview.edges.reduce((sum, edge) => sum + edge.weight, 0);
  assert.equal(aggregatedWeight + intraGroup, graph.edges.length);
  // The overview SVG wraps and never exceeds the width budget — full-size
  // rendering by construction, summarize-never-shrink.
  const rendered = renderChangeMapOverviewSvg(overview);
  assert.ok(rendered);
  const viewBox = rendered.svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.ok(viewBox);
  assert.ok(Number(viewBox[1]) <= COCKPIT_WIDTH_PX, `overview width ${viewBox[1]} must fit the ${COCKPIT_WIDTH_PX}px budget`);
  // Groups carry the zoom hook and an explicit aggregate halo card.
  assert.match(rendered.svg, /data-map-group="src"/);
  assert.match(rendered.svg, /blast radius/);
  assert.match(rendered.svg, /2 unchanged importer\(s\)/);
  // Empty overview renders nothing rather than an empty diagram.
  assert.equal(renderChangeMapOverviewSvg({ groups: [], halo_count: 0, edges: [] }), undefined);
  assert.equal(renderChangeMapOverviewMermaid({ groups: [], halo_count: 0, edges: [] }), undefined);
});

// ---------------------------------------------------------------------------
// review-surfaces.MAP_SCALE.4-6: the zoom level.

test("review-surfaces.MAP_SCALE.4 every overview group expands to a detail view of its model clusters verbatim, intra-group edges, explicit cross-group stubs, and its halo share — every changed file in exactly one view", () => {
  const sections = wideFixtureSections();
  const graph = sections.change_graph;
  const views = buildGroupDetailViews(graph);
  // One view per overview group, in model group order.
  assert.deepEqual(views.map((view) => view.group), graph.overview.groups.map((group) => group.name));
  // Clusters are the MODEL clusters verbatim (map/tour agreement): each view
  // carries exactly the model cluster objects of its group.
  const allViewClusters = views.flatMap((view) => view.clusters);
  assert.equal(allViewClusters.length, graph.clusters.length);
  const modelClusterByName = new Map(graph.clusters.map((cluster) => [cluster.name, cluster]));
  for (const cluster of allViewClusters) {
    assert.equal(cluster, modelClusterByName.get(cluster.name));
  }
  // Every changed file appears in EXACTLY one detail view (asserted on the
  // 99-file fixture).
  const seen = new Map<string, number>();
  for (const view of views) {
    for (const cluster of view.clusters) {
      for (const filePath of cluster.paths) {
        seen.set(filePath, (seen.get(filePath) ?? 0) + 1);
      }
    }
  }
  assert.equal(seen.size, graph.nodes.length);
  assert.ok([...seen.values()].every((count) => count === 1));
  // Intra-group edges stay inside the view; cross-group edges become explicit
  // stub ports on BOTH sides with aggregated weight and kind flags.
  const src = views.find((view) => view.group === "src");
  assert.ok(src);
  assert.equal(src.edges.length, 2);
  assert.deepEqual(src.stubs, [
    { other: "bin", direction: "out", weight: 1, has_new: true, has_removed: false },
    { other: "tests", direction: "out", weight: 3, has_new: false, has_removed: true }
  ]);
  const tests = views.find((view) => view.group === "tests");
  assert.ok(tests);
  assert.deepEqual(tests.stubs, [{ other: "src", direction: "in", weight: 3, has_new: false, has_removed: true }]);
  // Halo share: the two unchanged importers of src/core/f0.ts appear only in
  // the src view, imports restricted to that group's files.
  assert.deepEqual(src.halo_nodes.map((node) => node.path), ["src/unchanged/u0.ts", "src/unchanged/u1.ts"]);
  assert.deepEqual(src.halo_nodes[0].imports, ["src/core/f0.ts"]);
  assert.ok(views.filter((view) => view.group !== "src").every((view) => view.halo_nodes.length === 0));
  // The detail sub-graph renders with the file-level emitter: per-view cap,
  // cluster subgraphs, and the stub subgraph.
  const body = renderChangeMapMermaid(detailViewSubGraph(graph, src), { stubs: src.stubs }) as string;
  assert.match(body, /subgraph c0\["src\/cli"\]/);
  assert.match(body, /subgraph stubs\["cross-group"\]/);
  assert.match(body, /→ tests ×3/);
  assert.match(body, /\+ \d+ more files/); // 70 files, per-view cap 25 -> explicit overflow
  assert.match(body, /classDef stub stroke-dasharray: 3 3/);
});

test("review-surfaces.MAP_SCALE.6 human_review.md renders one collapsed detail block per group in model order, the sticky stays overview-only, and the PR comment stays overview-only", () => {
  const sections = wideFixtureSections();
  const fixture = model(sections.change_graph, sections.reading_order.legs);
  const markdown = renderHumanReviewMarkdown(fixture);
  // One <details> block per group with an honest summary, in group order.
  const summaries = [...markdown.matchAll(/<details><summary>([^<]+) — (\d+) file\(s\) · (\d+) cluster\(s\)<\/summary>/g)].map((match) => match[1]);
  assert.deepEqual(summaries, sections.change_graph.overview.groups.map((group) => group.name));
  assert.match(markdown, /<details><summary>src — 70 file\(s\) · 14 cluster\(s\)<\/summary>/);
  // Each block carries its own mermaid fence (per-block embed guard).
  const detailFences = markdown.split("## Change map")[1].split("\n## ")[0].match(/```mermaid/g) ?? [];
  assert.equal(detailFences.length, 1 + sections.change_graph.overview.groups.length);
  // The sticky comment stays overview-only: one map block, no group details.
  const sticky = renderStickySummary(fixture);
  assert.match(sticky.markdown, /<details><summary>Change map \(overview\)<\/summary>/);
  assert.doesNotMatch(sticky.markdown, /file\(s\) · \d+ cluster\(s\)<\/summary>/);
  const stickyFences = sticky.markdown.match(/```mermaid/g) ?? [];
  assert.equal(stickyFences.length, 1);
  // The PR comment surface stays overview-only too.
  const prComment = renderHumanPrComment(fixture).markdown;
  const prFences = prComment.match(/```mermaid/g) ?? [];
  assert.equal(prFences.length, 1);
});
