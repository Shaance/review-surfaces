import test from "node:test";
import assert from "node:assert/strict";
import { buildPrChangeDiagram } from "../src/diagrams/pr-change-diagram";
import { validateMermaidDiagramArtifact } from "../src/diagrams/diagrams";
import { fileEvidence } from "../src/evidence/evidence";
import type {
  PrAffectedArea,
  PrAffectedRequirement,
  PrRiskCandidate,
  PrRiskModel,
  PrScopeModel,
  ScopedChangedFile
} from "../src/pr/contract";

// --- Inline fixtures (construct the contract types directly) -----------------

function changedFile(path: string, areas: string[]): ScopedChangedFile {
  return { path, status: "M", areas, role: "implementation" };
}

function emptyScope(): PrScopeModel {
  return {
    base_ref: "origin/main",
    head_ref: "HEAD",
    head_sha: "HEAD",
    diff_source: "range",
    changed_files: [],
    affected_areas: [],
    affected_requirements: [],
    out_of_scope_changed_files: []
  };
}

function emptyRisks(): PrRiskModel {
  return { summary: "no risks", candidates: [] };
}

test("review-surfaces.pr_surface.v1 maps files -> areas -> requirements -> risks into a valid flowchart LR", () => {
  const scope: PrScopeModel = {
    base_ref: "origin/main",
    head_ref: "HEAD",
    head_sha: "HEAD",
    diff_source: "range",
    changed_files: [
      changedFile("src/cli/run.ts", ["CLI"]),
      changedFile("src/evidence/evidence.ts", ["EVIDENCE"])
    ],
    affected_areas: [
      { group_key: "CLI", area_ids: ["SUB-CLI"], name: "CLI", changed_files: ["src/cli/run.ts"] },
      {
        group_key: "EVIDENCE",
        area_ids: ["SUB-EVIDENCE"],
        name: "Evidence",
        changed_files: ["src/evidence/evidence.ts"]
      }
    ] satisfies PrAffectedArea[],
    affected_requirements: [
      {
        requirement_id: "REQ-CLI-001",
        acai_id: "review-surfaces.CLI.1",
        title: "CLI run",
        group_key: "CLI",
        reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "src/cli/run.ts" }]
      },
      {
        requirement_id: "REQ-EVIDENCE-004",
        acai_id: "review-surfaces.EVIDENCE.4",
        title: "Evidence refs",
        group_key: "EVIDENCE",
        reasons: [
          { rule: "changed_path_requirement_group", confidence: "high", path: "src/evidence/evidence.ts" }
        ]
      }
    ] satisfies PrAffectedRequirement[],
    out_of_scope_changed_files: []
  };

  const risks: PrRiskModel = {
    summary: "1 risk",
    candidates: [
      {
        id: "PR-RISK-001",
        rule: "untested_changed_impl",
        category: "testing",
        severity: "high",
        summary: "Changed implementation lacks a direct test",
        evidence: [fileEvidence("src/cli/run.ts", "changed without test")],
        suggested_checks: ["Add a test for src/cli/run.ts"]
      }
    ] satisfies PrRiskCandidate[]
  };

  const diagram = buildPrChangeDiagram({ scope, risks });

  assert.equal(diagram.path, "diagrams/pr-change-impact.mmd");
  assert.equal(diagram.status, "valid");

  const body = diagram.body;
  // It is a flowchart LR.
  assert.match(body, /^flowchart LR/);
  // The independent validator also accepts it.
  assert.equal(validateMermaidDiagramArtifact({ path: diagram.path, body }).status, "valid");

  // File labels are present.
  assert.ok(body.includes("src/cli/run.ts"));
  assert.ok(body.includes("src/evidence/evidence.ts"));
  // Requirement ids (the acai ids) are present.
  assert.ok(body.includes("review-surfaces.CLI.1"));
  assert.ok(body.includes("review-surfaces.EVIDENCE.4"));
  // Risk id is present.
  assert.ok(body.includes("PR-RISK-001"));

  // The full chain wired up: file -> area -> requirement, and requirement -> risk.
  assert.match(body, /F0 --> A_CLI/);
  assert.match(body, /A_CLI --> R_0/);
  // PR-RISK-001 references src/cli/run.ts (the file behind REQ-CLI-001), so the
  // requirement node anchors the risk.
  assert.match(body, /R_0 --> K_0/);

  // No raw '[' beyond the node-declaration brackets leaks into labels, and the
  // whole body stays bracket/quote-balanced.
  assertBalanced(body);
});

test("review-surfaces.pr_surface.v1 empty scope renders a minimal valid 'No mapped changes' diagram", () => {
  const diagram = buildPrChangeDiagram({ scope: emptyScope(), risks: emptyRisks() });

  assert.equal(diagram.status, "valid");
  assert.match(diagram.body, /^flowchart LR/);
  assert.ok(diagram.body.includes("No mapped changes"));
  assert.equal(validateMermaidDiagramArtifact({ path: diagram.path, body: diagram.body }).status, "valid");
  assertBalanced(diagram.body);
});

test("review-surfaces.pr_surface.v1 oversize scope collapses overflow into '... N more' nodes", () => {
  const fileCount = 20;
  const reqCount = 18;
  const riskCount = 12;

  const changed_files: ScopedChangedFile[] = [];
  const affected_requirements: PrAffectedRequirement[] = [];
  for (let i = 0; i < fileCount; i += 1) {
    changed_files.push(changedFile(`src/area/file${pad(i)}.ts`, ["AREA"]));
  }
  for (let i = 0; i < reqCount; i += 1) {
    affected_requirements.push({
      requirement_id: `REQ-AREA-${pad(i)}`,
      acai_id: `review-surfaces.AREA.${i}`,
      title: `Requirement ${i}`,
      group_key: "AREA",
      reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: `src/area/file${pad(i)}.ts` }]
    });
  }

  const scope: PrScopeModel = {
    base_ref: "origin/main",
    head_ref: "HEAD",
    head_sha: "HEAD",
    diff_source: "range",
    changed_files,
    affected_areas: [
      {
        group_key: "AREA",
        area_ids: ["SUB-AREA"],
        name: "Area",
        changed_files: changed_files.map((file) => file.path)
      }
    ],
    affected_requirements,
    out_of_scope_changed_files: []
  };

  const candidates: PrRiskCandidate[] = [];
  for (let i = 0; i < riskCount; i += 1) {
    candidates.push({
      id: `PR-RISK-${pad(i + 1)}`,
      rule: "large_diff",
      category: "testing",
      severity: "medium",
      summary: `Risk ${i}`,
      evidence: [fileEvidence(`src/area/file${pad(i)}.ts`)],
      suggested_checks: []
    });
  }
  const risks: PrRiskModel = { summary: `${riskCount} risks`, candidates };

  const diagram = buildPrChangeDiagram({ scope, risks });

  assert.equal(diagram.status, "valid");
  assert.equal(validateMermaidDiagramArtifact({ path: diagram.path, body: diagram.body }).status, "valid");

  const body = diagram.body;
  // Defaults: 12 files, 12 requirements, 8 risks -> overflow nodes for each.
  assert.ok(body.includes(`... ${fileCount - 12} more files`));
  assert.ok(body.includes(`... ${reqCount - 12} more requirements`));
  assert.ok(body.includes(`... ${riskCount - 8} more risks`));

  // No silent truncation: exactly 12 file nodes are shown (F0..F11) and no F12.
  assert.ok(body.includes('F11["'));
  assert.ok(!body.includes('F12["'));

  assertBalanced(body);
});

test("review-surfaces.pr_surface.v1 sanitizes labels so brackets/quotes cannot unbalance Mermaid", () => {
  const scope: PrScopeModel = {
    base_ref: "origin/main",
    head_ref: "HEAD",
    head_sha: "HEAD",
    diff_source: "range",
    changed_files: [changedFile('src/danger/[id]"weird"(x).ts', ["WEIRD:GROUP/KEY"])],
    affected_areas: [
      {
        group_key: "WEIRD:GROUP/KEY",
        area_ids: ["SUB-WEIRD"],
        name: 'Weird "Area" [name]',
        changed_files: ['src/danger/[id]"weird"(x).ts']
      }
    ],
    affected_requirements: [
      {
        requirement_id: "REQ-WEIRD-001",
        acai_id: "review-surfaces.WEIRD.1",
        title: 'Title with ] and " and (parens)',
        group_key: "WEIRD:GROUP/KEY",
        reasons: [
          { rule: "changed_path_requirement_group", confidence: "high", path: 'src/danger/[id]"weird"(x).ts' }
        ]
      }
    ],
    out_of_scope_changed_files: []
  };

  const risks: PrRiskModel = {
    summary: "1 risk",
    candidates: [
      {
        id: "PR-RISK-001",
        rule: "unmapped_change",
        category: "unknown",
        severity: "low",
        summary: 'Summary with [brackets] and "quotes"',
        evidence: [fileEvidence('src/danger/[id]"weird"(x).ts')],
        suggested_checks: []
      }
    ]
  };

  const diagram = buildPrChangeDiagram({ scope, risks });

  assert.equal(diagram.status, "valid");
  assert.equal(validateMermaidDiagramArtifact({ path: diagram.path, body: diagram.body }).status, "valid");

  // The dangerous bracket/quote characters from the raw input are stripped by the
  // sanitizer and never reach the label text. (Parentheses are NOT asserted absent
  // here: the file label format intentionally appends a balanced "(status)" wrapper
  // around the sanitized text; raw parens from the input are still stripped, and the
  // global assertBalanced below proves every paren in the body is balanced.)
  const labelText = extractLabelText(diagram.body);
  assert.ok(!labelText.includes("["), "no raw '[' should leak into labels");
  assert.ok(!labelText.includes("]"), "no raw ']' should leak into labels");
  assert.ok(!labelText.includes('"'), "no raw '\"' should leak into labels");
  assert.ok(!labelText.includes("{"), "no raw '{' should leak into labels");
  assert.ok(!labelText.includes("}"), "no raw '}' should leak into labels");

  // Node ids derived from "WEIRD:GROUP/KEY" are identifier-safe.
  assert.match(diagram.body, /A_WEIRD_GROUP_KEY/);

  assertBalanced(diagram.body);
});

test("two area group_keys that differ only in punctuation get DISTINCT node ids (no collision)", () => {
  // safeIdToken collapses ':' and '/' (and '-') to '_', so these two keys would
  // otherwise both emit "A_CLUSTER_SRC_API" and coalesce into one node.
  const scope: PrScopeModel = {
    base_ref: "origin/main",
    head_ref: "HEAD",
    head_sha: "HEAD",
    diff_source: "range",
    changed_files: [changedFile("src/a.ts", ["CLUSTER:SRC/API"]), changedFile("src/b.ts", ["CLUSTER-SRC-API"])],
    affected_areas: [
      { group_key: "CLUSTER-SRC-API", area_ids: ["X"], name: "Cluster Beta", changed_files: ["src/b.ts"] },
      { group_key: "CLUSTER:SRC/API", area_ids: ["Y"], name: "Cluster Alpha", changed_files: ["src/a.ts"] }
    ],
    affected_requirements: [],
    out_of_scope_changed_files: []
  };
  const diagram = buildPrChangeDiagram({ scope, risks: emptyRisks() });

  assert.equal(diagram.status, "valid");
  assert.equal(validateMermaidDiagramArtifact({ path: diagram.path, body: diagram.body }).status, "valid");
  // Two DISTINCT area node declarations exist (the colliding base id is suffixed).
  const areaNodeIds = (diagram.body.match(/^ {2}(A_[A-Za-z0-9_]+)\["/gm) ?? []).map((m) => m.trim().split("[")[0]);
  assert.equal(new Set(areaNodeIds).size, 2, "two distinct area node ids");
  assert.equal(areaNodeIds.length, 2, "exactly two area nodes, no coalescing");
  // Both labels survive (neither area is lost to an id collision).
  assert.ok(diagram.body.includes("Cluster Alpha"));
  assert.ok(diagram.body.includes("Cluster Beta"));
  assertBalanced(diagram.body);
});

test("a requirement with NO group_key (LLM-derived) is anchored via its reason path, never a floating node", () => {
  const scope: PrScopeModel = {
    base_ref: "origin/main",
    head_ref: "HEAD",
    head_sha: "HEAD",
    diff_source: "range",
    changed_files: [changedFile("src/feature.ts", ["FOO"])],
    affected_areas: [{ group_key: "FOO", area_ids: ["SUB-FOO"], name: "Foo", changed_files: ["src/feature.ts"] }],
    affected_requirements: [
      {
        // No acai_id, no group_key — the normal shape for an llm_derived requirement.
        requirement_id: "REQ-LLM-1",
        title: "Agent-proposed behavior",
        reasons: [{ rule: "spec_block_changed", confidence: "high", path: "src/feature.ts" }]
      }
    ],
    out_of_scope_changed_files: []
  };
  const diagram = buildPrChangeDiagram({ scope, risks: emptyRisks() });

  assert.equal(diagram.status, "valid");
  // The requirement node exists AND has an incoming edge (file -> requirement),
  // rather than being declared and left unconnected.
  assert.match(diagram.body, /R_0\["REQ-LLM-1/);
  assert.match(diagram.body, /F0 --> R_0/);
  assertBalanced(diagram.body);
});

// --- Local helpers -----------------------------------------------------------

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

// Bracket/brace/paren balance and even quote count over the whole body — the same
// invariants the Mermaid validator enforces, asserted directly so a regression is
// caught even if the validator changes.
function assertBalanced(body: string): void {
  assert.equal(count(body, "["), count(body, "]"), "[] must be balanced");
  assert.equal(count(body, "("), count(body, ")"), "() must be balanced");
  assert.equal(count(body, "{"), count(body, "}"), "{} must be balanced");
  assert.equal(count(body, '"') % 2, 0, '" must be even');
}

function count(text: string, character: string): number {
  return text.split(character).length - 1;
}

// Concatenate just the text inside each node label (between [" and "]).
function extractLabelText(body: string): string {
  const matches = body.match(/\["([^"]*)"\]/g) ?? [];
  return matches.map((match) => match.slice(2, -2)).join("\n");
}
