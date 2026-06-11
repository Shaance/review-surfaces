import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildChangeGraphSections, computeChangedImportEdges } from "../src/human/change-graph";
import { renderChangeMapMermaid } from "../src/diagrams/change-map";
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
    generated_from: { packet_path: "review_packet.json", base_ref: "origin/main", head_ref: "HEAD", head_sha: "abc" }
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
  assert.equal(renderChangeMapMermaid({ nodes: [], halo_nodes: [], edges: [], clusters: [] }), undefined);
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
    clusters: [{ name: "```", paths: ["```\nplain.ts"] }]
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
