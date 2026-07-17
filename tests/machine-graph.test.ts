import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildChangeGraphSections, computeChangedImportEdges } from "../src/human/change-graph";
import { renderStickySummary } from "../src/render/sticky-summary";
import { renderHumanReviewMarkdown } from "../src/human/render";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { ChangeGraph, HumanReviewModel, HUMAN_REVIEW_SCHEMA_VERSION, ReviewQueueItem, RiskLensFinding } from "../src/human/contract";
import { validateJsonSchema } from "../src/schema/json-schema";
import { notAssessedConversationAnalysis } from "../src/conversation/analysis";

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
    decision_projection: {
      active_intent: { summary: "Machine graph fixture intent.", source: "packet", redaction_blocked: false, requirement_ids: [], event_ids: [] },
      findings: []
    },
    conversation_analysis: notAssessedConversationAnalysis("mock"),
    review_insights: [],
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: { confidence_summary: "", verified_facts: [], claimed_not_verified: [], missing_evidence: [], invalid_evidence: [] },
    risk_lens_findings: [],
    methodology_audit: { quality_flags: [], considered: [], research: [], workflow_findings: [] },
    intent_mismatch: { expected_by_spec: [], observed_in_diff: [], possible_mismatches: [], possible_overreach: [], missing_intent: [], claimed_candidates: [] },
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
    rounds: [],
    evidence_cards: [],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: { packet_path: "review_packet.json", base_ref: "origin/main", head_ref: "HEAD", head_sha: "abc", uncommitted_files: 0 }
  };
}

test("review-surfaces.CHANGE_MAP.1 change_graph carries churn/lens/status nodes, existing-kind edges, and sorted clusters", () => {
  const sections = buildChangeGraphSections({
    files: [file("src/render/b.ts", "M", 5, 1), file("src/core/a.ts", "A", 20, 0), file("tests/a.test.ts", "M", 3, 3)],
    edges: [
      { importer: "src/render/b.ts", imported: "src/core/a.ts" },
      { importer: "tests/a.test.ts", imported: "src/core/a.ts" },
      // Duplicate must dedupe; self-loop must drop.
      { importer: "src/render/b.ts", imported: "src/core/a.ts" },
      { importer: "src/core/a.ts", imported: "src/core/a.ts" }
    ],
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
  // Edges: importer -> imported per the machine contract, kind slot present
  // (existing in M9), deduped.
  assert.deepEqual(graph.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })), [
    { from: "src/render/b.ts", to: "src/core/a.ts", kind: "existing" },
    { from: "tests/a.test.ts", to: "src/core/a.ts", kind: "existing" }
  ]);
  // Clusters cover every node in deterministic graph order.
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

test("review-surfaces.CHANGE_MAP.2 the machine graph stays out of every human reviewer surface", () => {
  const sections = buildChangeGraphSections({
    files: [file("src/a.ts"), file("src/b.ts")],
    edges: [{ importer: "src/b.ts", imported: "src/a.ts" }],
    lensFindings: [],
    reviewQueue: []
  });
  const fixture = model(sections.change_graph, sections.reading_order.legs);
  const sticky = renderStickySummary(fixture);
  assert.doesNotMatch(sticky.markdown, /<details><summary>Change map|```mermaid/);
  const markdown = renderHumanReviewMarkdown(fixture);
  assert.doesNotMatch(markdown, /## Change map|```mermaid/);
  assert.match(markdown, /\[Interactive HTML cockpit\]\(human_review\.html\)/);
  const html = renderHumanReviewHtml(fixture);
  assert.doesNotMatch(html, /<h2 id="map">Change map<\/h2>|data-map-/);
  assert.match(html, /<h2 id="reading-order">Reading order<\/h2>/);
  // determinism-check exercises a PR-scope run, not only repo scope.
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "determinism-check.sh"), "utf8");
  assert.match(script, /for SCOPE in repo pr/);
  assert.match(
    script,
    /comment --review-scope "\$scope" --out/,
    "the GitHub/sticky renderer must use the same scope as the artifact it validates"
  );
  assert.equal(
    [...script.matchAll(/node bin\/review-surfaces\.js comment /g)].length,
    1,
    "github and sticky are aliases, so determinism renders the shared surface once per run"
  );
});
