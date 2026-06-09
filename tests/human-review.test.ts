import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHumanReview } from "../src/human/human-review";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import {
  HUMAN_STANDALONE_ARTIFACTS,
  renderHumanReviewMarkdown,
  renderReviewQueueMarkdown,
  writeHumanReviewArtifacts
} from "../src/human/render";
import { ReviewPacket } from "../src/render/packet";
import { PrReviewSurfaceModel, PR_RISK_RULES, PrRiskRule, PR_SURFACE_SCHEMA_VERSION } from "../src/pr/contract";
import { commandEvidence, feedbackEvidence, fileEvidence, missingEvidence } from "../src/evidence/evidence";
import { validateJsonSchema } from "../src/schema/json-schema";
import { minimalReviewPacket } from "./helpers/review-packet";
import type { FeedbackFile } from "../src/feedback/feedback";
import {
  FEEDBACK_POLICY_EFFECT_KINDS,
  HUMAN_REVIEW_DECISIONS,
  HUMAN_REVIEW_PRIORITIES,
  HUMAN_REVIEW_SCHEMA_VERSION,
  REVIEWER_QUESTION_SEVERITIES,
  SUGGESTED_COMMENT_SEVERITIES
} from "../src/human/contract";
import {
  PACKET_CONFIDENCE_LEVELS,
  PACKET_EVIDENCE_KINDS,
  PACKET_SEVERITIES,
  PACKET_VALIDATION_STATUSES
} from "../src/schema/review-packet-contract";

const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));

function packetFixture(): ReviewPacket {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  packet.manifest = {
    ...packet.manifest,
    base_ref: "origin/main",
    head_ref: "HEAD",
    head_sha: "abc123"
  };
  packet.evaluation = {
    summary: "1 satisfied, 1 partial",
    results: [
      {
        requirement_id: "REQ-HUMAN-1",
        acai_id: "review-surfaces.HUMAN_REVIEW.1",
        status: "partial",
        summary: "Human review exists but needs tests.",
        partial_reason: "impl_no_test",
        evidence: [fileEvidence("src/human/human-review.ts", "Builder exists.")],
        missing_evidence: [missingEvidence("Needs direct test evidence.")],
        review_focus: "Review human surface.",
        confidence: "medium"
      }
    ],
    overreach: [],
    acai_coverage: { "review-surfaces.HUMAN_REVIEW.1": "partial" }
  };
  packet.methodology = {
    ...packet.methodology,
    claims_without_evidence: ["All human review edge cases are covered."],
    evidence: [fileEvidence("docs/human-first-review-surfaces-comprehensive-feature-proposal.md", "Proposal is present.")]
  };
  packet.risks = {
    summary: "fixture risks",
    items: [
      {
        id: "RISK-001",
        category: "testing",
        severity: "medium",
        summary: "Human review has weak test evidence.",
        evidence: [fileEvidence("src/human/human-review.ts", "Risk cites builder.")],
        suggested_checks: ["Add focused human review tests."],
        manual_review: true
      }
    ],
    test_evidence: [
      {
        id: "TEST-TR-001",
        kind: "direct",
        summary: "Command transcript records exit 0: pnpm test",
        evidence: [commandEvidence("pnpm test", "pnpm test passed.", "high", { validationStatus: "valid" })]
      },
      {
        id: "TEST-CMD-001",
        kind: "claimed",
        summary: "Command invoked by this run context: pnpm run review-surfaces",
        evidence: [commandEvidence("pnpm run review-surfaces", "Invocation recorded without output.", "medium")]
      }
    ],
    test_gaps: [],
    missing_automatic_tests: [
      {
        id: "AUTO-001",
        requirement_id: "REQ-HUMAN-1",
        acai_id: "review-surfaces.HUMAN_REVIEW.1",
        summary: "Missing automatic test for review-surfaces.HUMAN_REVIEW.1.",
        suggested_test: "Add a focused unit or fixture test tied to review-surfaces.HUMAN_REVIEW.1.",
        evidence: [missingEvidence("Needs direct human review test evidence.")]
      }
    ],
    missing_manual_checks: [],
    review_focus: ["Confirm validation command output for the current branch."]
  };
  return packet;
}

function prSurfaceFixture(): PrReviewSurfaceModel {
  return {
    schema_version: PR_SURFACE_SCHEMA_VERSION,
    mode: "pr",
    status: "blocked",
    blocked_reason: "llm_unavailable",
    scope: {
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "abc123",
      diff_source: "range",
      changed_files: [
        {
          path: ".github/workflows/pr-review-comment.yml",
          status: "M",
          areas: ["PROVIDERS"],
          role: "ci",
          added_lines: 10,
          deleted_lines: 2
        },
        {
          path: "schemas/human_review.schema.json",
          status: "A",
          areas: ["HUMAN_REVIEW", "SCHEMA"],
          role: "spec",
          added_lines: 100,
          deleted_lines: 0
        },
        {
          path: "docs/notes.md",
          status: "M",
          areas: ["HUMAN_REVIEW"],
          role: "doc",
          added_lines: 1,
          deleted_lines: 0
        }
      ],
      affected_areas: [
        { group_key: "HUMAN_REVIEW", area_ids: ["SUB-HUMAN-REVIEW"], name: "Human review cockpit", changed_files: ["schemas/human_review.schema.json"] }
      ],
      affected_requirements: [
        {
          requirement_id: "REQ-HUMAN-1",
          acai_id: "review-surfaces.HUMAN_REVIEW.1",
          title: "Human surface starts with verdict",
          group_key: "HUMAN_REVIEW",
          reasons: []
        }
      ],
      out_of_scope_changed_files: []
    },
    coverage: {
      base_available: false,
      summary: "1 requirement in scope",
      in_scope_count: 1,
      deltas: [
        {
          requirement_id: "REQ-HUMAN-1",
          acai_id: "review-surfaces.HUMAN_REVIEW.1",
          base_status: "absent",
          head_status: "partial",
          delta: "newly_in_scope",
          reasons: ["baseline unavailable"],
          head_evidence: [fileEvidence("src/human/human-review.ts", "Human builder.")],
          missing_evidence: [missingEvidence("No baseline evaluation.")]
        }
      ],
      counts: { improved: 0, regressed: 0, unchanged: 0, new_requirement: 0, removed_requirement: 0, newly_in_scope: 1 }
    },
    risks: {
      summary: "3 PR risk candidates",
      candidates: [
        {
          id: "PR-RISK-001",
          rule: "ci_secret_boundary_change",
          category: "security",
          severity: "high",
          summary: "Workflow touches the CI secret boundary.",
          evidence: [fileEvidence(".github/workflows/pr-review-comment.yml", "Workflow changed.")],
          suggested_checks: ["Confirm PR-controlled code cannot access secrets."]
        },
        {
          id: "PR-RISK-002",
          rule: "schema_contract_change",
          category: "architecture",
          severity: "medium",
          summary: "Human review schema changed.",
          evidence: [fileEvidence("schemas/human_review.schema.json", "Schema changed.")],
          suggested_checks: ["Add a compatibility fixture."]
        },
        {
          id: "PR-RISK-003",
          rule: "large_diff",
          category: "maintainability",
          severity: "low",
          summary: "Large diff needs extra review time.",
          evidence: [missingEvidence("Diff size exceeded threshold.")],
          suggested_checks: ["Allocate extra review time."]
        }
      ]
    },
    llm: { required: true, provider: "mock", status: "blocked" }
  };
}

function structuredDiffFixture() {
  return parseStructuredDiff([
    "diff --git a/.github/workflows/pr-review-comment.yml b/.github/workflows/pr-review-comment.yml",
    "--- a/.github/workflows/pr-review-comment.yml",
    "+++ b/.github/workflows/pr-review-comment.yml",
    "@@ -10,3 +10,5 @@",
    " jobs:",
    "+  permissions: read-all",
    "+  review-surface: true",
    "   build:",
    "diff --git a/schemas/human_review.schema.json b/schemas/human_review.schema.json",
    "--- a/schemas/human_review.schema.json",
    "+++ b/schemas/human_review.schema.json",
    "@@ -70,2 +70,3 @@",
    " properties:",
    "+  hunk_header: { type: string }",
    "   verdict:",
    "diff --git a/src/human/human-review.ts b/src/human/human-review.ts",
    "--- a/src/human/human-review.ts",
    "+++ b/src/human/human-review.ts",
    "@@ -220,2 +220,3 @@",
    " function buildReviewQueue() {",
    "+  buildChangedFileFallbackQueue();",
    " }",
    "diff --git a/tests/human-review.test.ts b/tests/human-review.test.ts",
    "--- a/tests/human-review.test.ts",
    "+++ b/tests/human-review.test.ts",
    "@@ -395,2 +395,3 @@",
    " test('fallback') {",
    "+  assertChangedFileFallback();",
    " }",
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 90%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
    "--- a/src/old-name.ts",
    "+++ b/src/new-name.ts",
    "@@ -20,2 +20,2 @@",
    " keep",
    "-old trust boundary",
    "+new trust boundary",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -7,2 +0,0 @@",
    "-export const old = true;",
    "-export const gone = true;",
    ""
  ].join("\n"));
}

test("human review model is schema-valid and starts with deterministic readiness signals", () => {
  const model = buildHumanReview({
    packet: packetFixture(),
    prSurface: prSurfaceFixture(),
    diff: structuredDiffFixture(),
    packetPath: ".review-surfaces/review_packet.json",
    prSurfacePath: ".review-surfaces/pr_review_surface.json"
  });

  assert.equal(model.schema_version, "review-surfaces.human_review.v1");
  assert.equal(model.mode, "pr");
  assert.equal(model.verdict.decision, "block_before_merge");
  assert.equal(model.blockers[0].id, "BLOCK-CI-SECRET-001");
  assert.equal(model.review_queue[0].path, ".github/workflows/pr-review-comment.yml");
  assert.equal(model.review_queue[0].hunk_header, "@@ -10,3 +10,5 @@");
  assert.deepEqual(
    { line_start: model.review_queue[0].line_start, line_end: model.review_queue[0].line_end },
    { line_start: 11, line_end: 12 }
  );
  assert.deepEqual(model.review_queue[0].risk_ids, ["PR-RISK-001"]);
  assert.ok(model.review_queue.every((item) => item.path !== ""));
  assert.ok(model.questions.some((question) => question.severity === "blocking"));
  assert.ok(model.suggested_comments.length > 0);
  assert.ok(model.suggested_comments.every((comment) => comment.evidence.length > 0));
  assert.ok(model.trust_audit.claimed_not_verified.length > 0);
  assert.ok(model.test_plan.some((item) => item.kind === "manual" && item.priority === "required"));
  assert.ok(model.skim_safe.some((item) => item.path === "docs/notes.md"));

  const validation = validateJsonSchema(schema, model);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
});

test("human review Markdown renders a compact cockpit surface", () => {
  const model = buildHumanReview({ packet: packetFixture(), prSurface: prSurfaceFixture(), diff: structuredDiffFixture() });
  const markdown = renderHumanReviewMarkdown(model);

  assert.match(markdown, /^# Human Review/);
  assert.match(markdown, /## Verdict/);
  assert.match(markdown, /\*\*Block before merge\.\*\*/);
  assert.match(markdown, /## Review first/);
  assert.match(markdown, /\.github\/workflows\/pr-review-comment\.yml/);
  assert.match(markdown, /Hunk: `@@ -10,3 \+10,5 @@`/);
  assert.match(markdown, /## Trust audit/);
  assert.match(markdown, /Claimed but not verified/);
  assert.match(markdown, /## Suggested comments/);
  for (const artifact of HUMAN_STANDALONE_ARTIFACTS) {
    assert.match(markdown, new RegExp(`${artifact.label}: \`\\.review-surfaces/${artifact.artifact}\``));
  }
  assert.doesNotMatch(markdown, /Start with missing and partial requirement results/);
});

test("line-specific queue evidence does not inherit an unrelated diff hunk", () => {
  const surface = prSurfaceFixture();
  const schemaRisk = surface.risks.candidates.find((risk) => risk.id === "PR-RISK-002");
  assert.ok(schemaRisk);
  schemaRisk.evidence = [
    {
      ...fileEvidence("schemas/human_review.schema.json", "Schema evidence outside edited hunk."),
      line_start: 500,
      line_end: 502
    }
  ];

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface, diff: structuredDiffFixture() });
  const queueItem = model.review_queue.find((item) => item.risk_ids.includes("PR-RISK-002"));

  assert.ok(queueItem);
  assert.equal(queueItem.hunk_header, undefined);
  assert.deepEqual(
    { line_start: queueItem.line_start, line_end: queueItem.line_end },
    { line_start: 500, line_end: 502 }
  );
});

test("old-side queue evidence keeps rename and delete anchors on the old path", () => {
  const surface = prSurfaceFixture();
  const schemaRisk = surface.risks.candidates.find((risk) => risk.id === "PR-RISK-002");
  const largeDiffRisk = surface.risks.candidates.find((risk) => risk.id === "PR-RISK-003");
  assert.ok(schemaRisk);
  assert.ok(largeDiffRisk);
  schemaRisk.evidence = [
    {
      ...fileEvidence("src/old-name.ts", "Old-side rename evidence."),
      line_start: 21,
      line_end: 21
    }
  ];
  largeDiffRisk.evidence = [
    {
      ...fileEvidence("src/gone.ts", "Deleted-file evidence."),
      line_start: 8,
      line_end: 8
    }
  ];

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface, diff: structuredDiffFixture() });
  const renamed = model.review_queue.find((item) => item.risk_ids.includes("PR-RISK-002"));
  const deleted = model.review_queue.find((item) => item.risk_ids.includes("PR-RISK-003"));

  assert.ok(renamed);
  assert.equal(renamed.path, "src/old-name.ts");
  assert.equal(renamed.hunk_header, "@@ -20,2 +20,2 @@");
  assert.deepEqual({ line_start: renamed.line_start, line_end: renamed.line_end }, { line_start: 21, line_end: 21 });

  assert.ok(deleted);
  assert.equal(deleted.path, "src/gone.ts");
  assert.equal(deleted.hunk_header, "@@ -7,2 +0,0 @@");
  assert.deepEqual({ line_start: deleted.line_start, line_end: deleted.line_end }, { line_start: 8, line_end: 8 });
});

test("PR mode queues changed implementation files when no PR risk candidate fires", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files.push({
    path: "src/human/human-review.ts",
    status: "M",
    areas: ["HUMAN_REVIEW"],
    role: "implementation",
    added_lines: 12,
    deleted_lines: 2
  });

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface, diff: structuredDiffFixture() });
  const first = model.review_queue[0];
  const changedImpl = model.review_queue.find((item) => item.path === "src/human/human-review.ts");
  const broadRiskIndex = model.review_queue.findIndex((item) => item.risk_ids.includes("RISK-001"));
  const changedImplIndex = model.review_queue.findIndex((item) => item.path === "src/human/human-review.ts");

  assert.deepEqual(first.risk_ids, []);
  assert.match(first.reason, /No deterministic PR risk candidate fired/);
  assert.ok(changedImpl);
  assert.equal(changedImpl.title, "Changed implementation file");
  assert.equal(changedImpl.hunk_header, "@@ -220,2 +220,3 @@");
  assert.deepEqual(changedImpl.risk_ids, []);
  assert.ok(changedImpl.requirement_ids.includes("review-surfaces.HUMAN_REVIEW.1"));
  assert.ok(broadRiskIndex > changedImplIndex, "broad packet risk remains available below precise changed-file actions");
});

test("PR mode queues changed files when PR risk candidates are pathless", () => {
  const surface = prSurfaceFixture();
  const pathlessRisk = surface.risks.candidates.find((risk) => risk.id === "PR-RISK-003");
  assert.ok(pathlessRisk);
  surface.risks.candidates = [pathlessRisk];
  surface.scope.changed_files.push({
    path: "src/human/human-review.ts",
    status: "M",
    areas: ["HUMAN_REVIEW"],
    role: "implementation",
    added_lines: 12,
    deleted_lines: 2
  });

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface, diff: structuredDiffFixture() });
  const changedImpl = model.review_queue.find((item) => item.path === "src/human/human-review.ts");

  assert.ok(changedImpl);
  assert.deepEqual(changedImpl.risk_ids, []);
  assert.equal(model.review_queue.some((item) => item.risk_ids.includes("PR-RISK-003")), false);
  assert.equal(model.questions.some((question) => question.maps_to_risks.includes("PR-RISK-003")), true);
});

test("PR mode fallback maps path-scoped affected requirements without group keys", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files.push({
    path: "src/path-scoped.ts",
    status: "M",
    areas: [],
    role: "implementation",
    added_lines: 4,
    deleted_lines: 1
  });
  surface.scope.affected_requirements.push({
    requirement_id: "REQ-PATH-1",
    acai_id: "review-surfaces.HUMAN_REVIEW.PATH",
    title: "Path-scoped requirement",
    reasons: [{ rule: "spec_block_changed", confidence: "high", path: "./src\\path-scoped.ts" }]
  });

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface, diff: structuredDiffFixture() });
  const changedFile = model.review_queue.find((item) => item.path === "src/path-scoped.ts");

  assert.ok(changedFile);
  assert.ok(changedFile.requirement_ids.includes("review-surfaces.HUMAN_REVIEW.PATH"));
});

test("PR mode fallback keeps changed test files above medium whole-packet risks", () => {
  const surface = prSurfaceFixture();
  const packet = packetFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files.push({
    path: "tests/human-review.test.ts",
    status: "M",
    areas: ["HUMAN_REVIEW"],
    role: "test",
    added_lines: 6,
    deleted_lines: 1
  });
  packet.risks.items[0] = {
    ...packet.risks.items[0],
    evidence: [fileEvidence("tests/human-review.test.ts", "Broad packet test risk cites changed test.")]
  };

  const model = buildHumanReview({ packet, prSurface: surface, diff: structuredDiffFixture() });
  const changedTestIndex = model.review_queue.findIndex(
    (item) => item.path === "tests/human-review.test.ts" && item.risk_ids.length === 0
  );
  const broadRiskIndex = model.review_queue.findIndex((item) => item.risk_ids.includes("RISK-001"));

  assert.ok(changedTestIndex >= 0);
  assert.ok(broadRiskIndex >= 0);
  assert.ok(changedTestIndex < broadRiskIndex, "precise changed test fallback should outrank the broad packet risk");
});

test("PR mode fallback queues source-of-truth docs but not ordinary docs", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files.push({
    path: "AGENTS.md",
    status: "M",
    areas: ["BOOTSTRAP"],
    role: "doc",
    added_lines: 3,
    deleted_lines: 1
  });
  surface.scope.changed_files.push({
    path: "packages/widget/AGENTS.md",
    status: "M",
    areas: ["BOOTSTRAP"],
    role: "doc",
    added_lines: 2,
    deleted_lines: 0
  });
  surface.scope.changed_files.push({
    path: "README.md",
    status: "M",
    areas: ["BOOTSTRAP"],
    role: "doc",
    added_lines: 2,
    deleted_lines: 0
  });
  surface.scope.affected_requirements.push({
    requirement_id: "REQ-BOOTSTRAP-1",
    acai_id: "review-surfaces.BOOTSTRAP.1",
    title: "Agent workflow source of truth",
    group_key: "BOOTSTRAP",
    reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "AGENTS.md" }]
  });

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface, diff: structuredDiffFixture() });
  const sourceDoc = model.review_queue.find((item) => item.path === "AGENTS.md");
  const nestedSourceDoc = model.review_queue.find((item) => item.path === "packages/widget/AGENTS.md");
  const readme = model.review_queue.find((item) => item.path === "README.md");

  assert.ok(sourceDoc);
  assert.equal(sourceDoc.title, "Changed source-of-truth document");
  assert.ok(sourceDoc.requirement_ids.includes("review-surfaces.BOOTSTRAP.1"));
  assert.ok(nestedSourceDoc);
  assert.equal(nestedSourceDoc.title, "Changed source-of-truth document");
  assert.ok(readme);
  assert.equal(model.skim_safe.some((item) => item.path === "README.md"), false);
  assert.equal(model.review_queue.some((item) => item.path === "docs/notes.md"), false);
  assert.ok(model.skim_safe.some((item) => item.path === "docs/notes.md"));
});

test("PR mode fallback tolerates stale changed files without areas", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files.push({
    path: "src/no-areas.ts",
    status: "M",
    role: "implementation",
    added_lines: 1,
    deleted_lines: 0
  } as PrReviewSurfaceModel["scope"]["changed_files"][number]);
  surface.scope.affected_requirements.push({
    requirement_id: "REQ-NO-REASONS",
    acai_id: "review-surfaces.HUMAN_REVIEW.NO_REASONS",
    title: "Stale requirement without reasons"
  } as PrReviewSurfaceModel["scope"]["affected_requirements"][number]);

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface, diff: structuredDiffFixture() });
  const changedFile = model.review_queue.find((item) => item.path === "src/no-areas.ts");

  assert.ok(changedFile);
  assert.match(changedFile.reason, /unmapped area/);
  assert.equal(changedFile.requirement_ids.includes("review-surfaces.HUMAN_REVIEW.NO_REASONS"), false);
});

test("human review writer emits standalone cockpit artifacts from the JSON model", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-human-artifacts-"));
  try {
    const model = buildHumanReview({
      packet: packetFixture(),
      prSurface: prSurfaceFixture(),
      packetPath: ".review-surfaces/review_packet.json",
      prSurfacePath: ".review-surfaces/pr_review_surface.json"
    });

    await writeHumanReviewArtifacts(tmp, model);

    const expected = ["human_review.json", "human_review.md", ...HUMAN_STANDALONE_ARTIFACTS.map((artifact) => artifact.artifact)];
    for (const artifact of expected) {
      assert.ok(fs.existsSync(path.join(tmp, artifact)), `${artifact} should be written`);
    }

    for (const artifact of HUMAN_STANDALONE_ARTIFACTS) {
      assert.match(
        fs.readFileSync(path.join(tmp, artifact.artifact), "utf8"),
        new RegExp(`^${artifact.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("standalone review queue bounds and de-duplicates evidence refs", () => {
  const model = buildHumanReview({ packet: packetFixture(), prSurface: prSurfaceFixture() });
  model.review_queue[0].evidence = [
    fileEvidence("src/a.ts", "first"),
    fileEvidence("src/a.ts", "duplicate"),
    fileEvidence("src/b.ts", "second"),
    fileEvidence("src/c.ts", "third"),
    fileEvidence("src/d.ts", "fourth"),
    fileEvidence("src/e.ts", "fifth"),
    fileEvidence("src/f.ts", "sixth"),
    fileEvidence("src/g.ts", "seventh"),
    fileEvidence("src/h.ts", "eighth"),
    fileEvidence("src/i.ts", "ninth")
  ];

  const markdown = renderReviewQueueMarkdown(model);

  assert.equal((markdown.match(/`src\/a\.ts`/g) ?? []).length, 1);
  assert.match(markdown, /Additional evidence ref\(s\) omitted/);
  assert.doesNotMatch(markdown, /`src\/i\.ts`/);
});

test("pathless PR risks become questions and out-of-scope packet risks stay out of PR queue", () => {
  const model = buildHumanReview({ packet: packetFixture(), prSurface: prSurfaceFixture() });
  assert.equal(model.review_queue.some((item) => item.risk_ids.includes("PR-RISK-003")), false);
  assert.equal(model.review_queue.some((item) => item.risk_ids.includes("RISK-001")), false);
  assert.equal(model.questions.some((question) => question.maps_to_risks.includes("PR-RISK-003")), true);
});

test("PR-scoped packet risks match changed files with normalized evidence paths", () => {
  const packet = packetFixture();
  packet.risks.items = [
    {
      id: "RISK-NORMALIZED",
      category: "maintainability",
      severity: "medium",
      summary: "Human review implementation should remain in the PR queue.",
      evidence: [fileEvidence("./src\\human\\human-review.ts", "Equivalent changed path spelling.")],
      suggested_checks: ["Inspect the normalized path-backed risk."],
      manual_review: true
    }
  ];
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files.push({
    path: "src/human/human-review.ts",
    status: "M",
    areas: ["HUMAN_REVIEW"],
    role: "implementation",
    added_lines: 5,
    deleted_lines: 1
  });

  const model = buildHumanReview({ packet, prSurface });
  const item = model.review_queue.find((queueItem) => queueItem.risk_ids.includes("RISK-NORMALIZED"));

  assert.equal(item?.path, "src/human/human-review.ts");
});

test("PR-scoped packet risks include renamed old paths in the changed-file scope", () => {
  const packet = packetFixture();
  packet.risks.items = [
    {
      id: "RISK-RENAMED-OLD-PATH",
      category: "maintainability",
      severity: "medium",
      summary: "Renamed old path evidence should remain in the PR queue.",
      evidence: [fileEvidence("src/human/old-review.ts", "Old side of a rename.")],
      suggested_checks: ["Inspect the renamed file risk."],
      manual_review: true
    }
  ];
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files.push({
    path: "src/human/new-review.ts",
    old_path: "src/human/old-review.ts",
    status: "R",
    areas: ["HUMAN_REVIEW"],
    role: "implementation",
    added_lines: 3,
    deleted_lines: 3
  });

  const model = buildHumanReview({ packet, prSurface });
  const item = model.review_queue.find((queueItem) => queueItem.risk_ids.includes("RISK-RENAMED-OLD-PATH"));

  assert.equal(item?.path, "src/human/old-review.ts");
});

test("repo-mode human review promotes focused human gaps into actions", () => {
  const model = buildHumanReview({ packet: packetFixture() });

  assert.equal(model.mode, "repo");
  assert.equal(model.questions[0].maps_to_requirements.includes("review-surfaces.HUMAN_REVIEW.1"), true);
  assert.match(model.questions[0].question, /validation evidence/);
  assert.equal(model.suggested_comments[0].requirement_ids.includes("review-surfaces.HUMAN_REVIEW.1"), true);
  assert.equal(model.test_plan[0].maps_to_requirements.includes("review-surfaces.HUMAN_REVIEW.1"), true);
  assert.equal(model.test_plan[0].suggested_file, "tests/human-review.test.ts");
});

test("nonzero validation command evidence blocks merge readiness", () => {
  const packet = packetFixture();
  packet.risks.test_evidence = [
    {
      id: "TEST-TR-FAIL",
      kind: "missing",
      summary: "Command transcript CMD-PNPM-TEST records exit 1: pnpm test",
      evidence: [
        commandEvidence(
          "pnpm test",
          "Command transcript CMD-PNPM-TEST recorded exit_code=1 and status=failed.",
          "medium",
          { validationStatus: "valid" }
        )
      ]
    }
  ];

  const model = buildHumanReview({ packet });

  assert.equal(model.verdict.decision, "block_before_merge");
  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-TESTS-001"), true);
});

test("passing test evidence whose name mentions errors does not block merge readiness", () => {
  const packet = packetFixture();
  packet.risks.test_evidence = [
    {
      id: "TEST-PASSING-ERROR-NAME",
      kind: "direct",
      summary: "Parsed test passed: renders error state",
      evidence: [
        {
          kind: "test",
          test_name: "renders error state",
          note: "Parsed test passed.",
          confidence: "high",
          validation_status: "valid"
        }
      ]
    }
  ];

  const model = buildHumanReview({ packet });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-TESTS-001"), false);
  assert.notEqual(model.verdict.decision, "block_before_merge");
});

test("recorded CI secret-boundary manual evidence clears the deterministic blocker", () => {
  const packet = packetFixture();
  packet.risks.test_evidence.push({
    id: "TEST-MANUAL-CI-SECRET",
    kind: "indirect",
    summary: "Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets.",
    evidence: [
      feedbackEvidence(
        ".review-surfaces/feedback/manual-dogfood.yaml",
        "Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets.",
        { sha: "abc123" }
      )
    ]
  });

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture() });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-CI-SECRET-001"), false);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-001") && item.kind === "manual"), false);
});

test("recorded CI secret-boundary canonical expected result clears the deterministic blocker", () => {
  const packet = packetFixture();
  packet.risks.test_evidence.push({
    id: "TEST-MANUAL-CI-SECRET-CANONICAL",
    kind: "indirect",
    summary: "Manual CI secret-boundary check recorded.",
    evidence: [
      feedbackEvidence(
        ".review-surfaces/feedback/manual-dogfood.yaml",
        "Manual CI secret-boundary check recorded: Secret-bearing steps run only from trusted code and PR-controlled files cannot influence credentialed execution.",
        { sha: "abc123" }
      )
    ]
  });

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture() });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-CI-SECRET-001"), false);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-001") && item.kind === "manual"), false);
});

test("stale-head CI secret-boundary feedback does not clear the deterministic blocker", () => {
  const packet = packetFixture();
  packet.risks.test_evidence.push({
    id: "TEST-MANUAL-CI-SECRET-STALE",
    kind: "indirect",
    summary: "Manual CI secret-boundary check recorded for an older head.",
    evidence: [
      feedbackEvidence(
        ".review-surfaces/feedback/manual-dogfood.yaml",
        "Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets.",
        { sha: "oldhead" }
      )
    ]
  });

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture() });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-CI-SECRET-001"), true);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-001") && item.kind === "manual"), true);
});

test("command text does not clear the CI secret-boundary blocker", () => {
  const packet = packetFixture();
  packet.risks.test_evidence.push({
    id: "TEST-COMMAND-MANUAL-CI-SECRET",
    kind: "direct",
    summary: "Command transcript records exit 0.",
    evidence: [
      commandEvidence(
        "echo \"Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets\"",
        "Command transcript recorded exit_code=0 and status=passed.",
        "high",
        { validationStatus: "valid" }
      )
    ]
  });

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture() });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-CI-SECRET-001"), true);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-001") && item.kind === "manual"), true);
});

test("summary-only CI secret-boundary claims do not clear the deterministic blocker", () => {
  const packet = packetFixture();
  packet.risks.test_evidence.push({
    id: "TEST-MANUAL-CI-SECRET-CLAIM",
    kind: "indirect",
    summary: "Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets.",
    evidence: []
  });

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture() });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-CI-SECRET-001"), true);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-001") && item.kind === "manual"), true);
});

test("CI secret-boundary policy wording does not clear the deterministic blocker", () => {
  const packet = packetFixture();
  packet.risks.test_evidence.push({
    id: "TEST-MANUAL-CI-SECRET-POLICY",
    kind: "indirect",
    summary: "Feedback policy requires a manual CI secret-boundary conclusion.",
    evidence: [
      feedbackEvidence(
        ".review-surfaces/feedback/manual-dogfood.yaml",
        "This slice requires an explicit recorded conclusion that PR-controlled code cannot access secrets before clearing the CI secret-boundary blocker.",
        { sha: "abc123" }
      )
    ]
  });

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture() });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-CI-SECRET-001"), true);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-001") && item.kind === "manual"), true);
});

test("CI secret-boundary policy text with recorded wording does not clear the deterministic blocker", () => {
  const packet = packetFixture();
  packet.risks.test_evidence.push({
    id: "TEST-MANUAL-CI-SECRET-POLICY-RECORDED",
    kind: "indirect",
    summary: "Feedback policy requires a manual CI secret-boundary check.",
    evidence: [
      feedbackEvidence(
        ".review-surfaces/feedback/manual-dogfood.yaml",
        "Policy requires a manual CI secret-boundary check recorded: PR-controlled code cannot access secrets.",
        { sha: "abc123" }
      )
    ]
  });

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture() });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-CI-SECRET-001"), true);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-001") && item.kind === "manual"), true);
});

test("inconclusive CI secret-boundary evidence does not clear the deterministic blocker", () => {
  const packet = packetFixture();
  packet.risks.test_evidence.push({
    id: "TEST-MANUAL-CI-SECRET-INCONCLUSIVE",
    kind: "indirect",
    summary: "Feedback records inconclusive manual CI secret-boundary evidence.",
    evidence: [
      feedbackEvidence(
        ".review-surfaces/feedback/manual-dogfood.yaml",
        "Manual CI secret-boundary check recorded: unable to confirm PR-controlled code cannot access secrets.",
        { sha: "abc123" }
      )
    ]
  });

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture() });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-CI-SECRET-001"), true);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-001") && item.kind === "manual"), true);
});

test("split CI secret-boundary phrases do not clear the deterministic blocker", () => {
  const packet = packetFixture();
  packet.risks.test_evidence.push({
    id: "TEST-MANUAL-CI-SECRET-SPLIT",
    kind: "indirect",
    summary: "Feedback records manual and conclusion fragments separately.",
    evidence: [
      feedbackEvidence(".review-surfaces/feedback/manual-dogfood.yaml", "Manual CI secret-boundary check recorded.", { sha: "abc123" }),
      feedbackEvidence(".review-surfaces/feedback/manual-dogfood.yaml", "PR-controlled code cannot access secrets.", { sha: "abc123" })
    ]
  });

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture() });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-CI-SECRET-001"), true);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-001") && item.kind === "manual"), true);
});

test("unrelated manual security wording does not clear the CI secret-boundary blocker", () => {
  const packet = packetFixture();
  packet.risks.test_evidence.push({
    id: "TEST-MANUAL-UNRELATED",
    kind: "indirect",
    summary: "Manual workflow security review recorded.",
    evidence: [feedbackEvidence(".review-surfaces/feedback/manual-dogfood.yaml", "Manual security review recorded.", { sha: "abc123" })]
  });

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture() });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-CI-SECRET-001"), true);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-001") && item.kind === "manual"), true);
});

test("reviewer feedback memory visibly tunes human review focus without hiding evidence", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.scope.changed_files.push(
    {
      path: "pnpm-lock.yaml",
      status: "M",
      areas: [],
      role: "generated",
      added_lines: 1200,
      deleted_lines: 900
    },
    {
      path: "docs/review-surfaces-trd.md",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 3,
      deleted_lines: 0
    }
  );
  surface.risks.candidates = [{
    ...prRiskFixture("large_diff"),
    severity: "high",
    evidence: [missingEvidence("Large diff: 2100 changed lines.")]
  }];

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    feedback: [
      {
        path: ".review-surfaces/feedback/memory.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "local",
        findings: [],
        validation: { passed: [], failed: [], notes: [] },
        false_positives: [
          {
            rule: "large_diff",
            path_pattern: "pnpm-lock.yaml",
            condition: "lockfile_only",
            action: "downgrade_to_low",
            evidence: [feedbackEvidence(".review-surfaces/feedback/memory.yaml", "Large lockfile diffs are noisy.", { eventId: "false_positive:1" })]
          }
        ],
        false_negatives: [
          {
            description: "Schema changes should always ask for compatibility tests.",
            path_pattern: "schemas/**/*.json",
            desired_rule: "schema_contract_change",
            evidence: [feedbackEvidence(".review-surfaces/feedback/memory.yaml", "Schema false-negative policy.", { eventId: "false_negative:1" })]
          }
        ],
        team_policy: [
          {
            id: "POLICY-CI-SECRET-001",
            path_pattern: ".github/workflows/*.yml",
            required_manual_check: "Confirm PR-controlled code cannot access secrets.",
            evidence: [feedbackEvidence(".review-surfaces/feedback/memory.yaml", "Team policy requires CI secret review.", { eventId: "POLICY-CI-SECRET-001" })]
          }
        ],
        reviewer_preferences: [
          {
            key: "always_prioritize",
            value: ["docs/review-surfaces-trd.md"],
            evidence: [feedbackEvidence(".review-surfaces/feedback/memory.yaml", "Always prioritize TRD changes.", { eventId: "reviewer_preference:1" })]
          }
        ]
      }
    ]
  });

  const schemaQueueItem = model.review_queue.find((item) => item.path === "schemas/human_review.schema.json" && item.risk_ids.includes("feedback:schema_contract_change"));
  const trdQueueItem = model.review_queue.find((item) => item.path === "docs/review-surfaces-trd.md");

  assert.equal(model.feedback_effects.some((effect) => effect.kind === "false_positive" && effect.action === "downgrade_to_low"), true);
  assert.equal(model.feedback_effects.some((effect) => effect.kind === "false_positive" && effect.risk_ids.includes("PR-RISK-LARGE") && effect.paths.includes("pnpm-lock.yaml")), true);
  assert.equal(model.feedback_effects.some((effect) => effect.kind === "false_negative" && effect.paths.includes("schemas/human_review.schema.json")), true);
  assert.equal(model.feedback_effects.some((effect) => effect.kind === "team_policy" && effect.action.startsWith("Record manual check:")), true);
  assert.equal(model.feedback_effects.some((effect) => effect.kind === "reviewer_preference" && effect.action === "prioritize_review_focus"), true);
  assert.ok(schemaQueueItem);
  assert.ok(trdQueueItem);
  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-FEEDBACK-001"), true);
  assert.equal(model.questions.some((question) => question.maps_to_risks.includes("policy:POLICY-CI-SECRET-001")), true);
  assert.equal(model.test_plan.some((item) => item.kind === "manual" && item.priority === "required" && item.maps_to_risks.includes("policy:POLICY-CI-SECRET-001")), true);
  assert.equal(model.skim_safe.some((item) => item.path === "pnpm-lock.yaml"), true);
  assert.equal(model.skim_safe.some((item) => item.path === "docs/review-surfaces-trd.md"), false);
  assert.equal(validateJsonSchema(schema, model).valid, true);
  assert.match(renderHumanReviewMarkdown(model), /## Feedback memory/);
});

test("recorded team-policy manual check clears the feedback policy blocker", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];
  packet.risks.test_evidence.push({
    id: "TEST-POLICY-MANUAL-CHECK",
    kind: "indirect",
    summary: "Manual team-policy check recorded.",
    evidence: [
      feedbackEvidence(
        ".review-surfaces/feedback/manual-dogfood.yaml",
        "Manual check recorded: Confirm PR-controlled code cannot access secrets.",
        { sha: "abc123" }
      )
    ]
  });

  const surface = prSurfaceFixture();
  surface.risks.candidates = [];

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    feedback: [
      {
        path: ".review-surfaces/feedback/memory.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "local",
        findings: [],
        validation: { passed: [], failed: [], notes: [] },
        false_positives: [],
        false_negatives: [],
        team_policy: [
          {
            id: "POLICY-CI-SECRET-001",
            path_pattern: ".github/workflows/*.yml",
            required_manual_check: "Confirm PR-controlled code cannot access secrets.",
            evidence: [feedbackEvidence(".review-surfaces/feedback/memory.yaml", "Team policy requires CI secret review.", { eventId: "POLICY-CI-SECRET-001" })]
          }
        ],
        reviewer_preferences: []
      }
    ]
  });

  const recordedEffect = model.feedback_effects.find((effect) => effect.kind === "team_policy" && effect.action.startsWith("Manual check recorded:"));
  assert.ok(recordedEffect);
  assert.equal(recordedEffect.evidence.some((ref) => ref.note?.includes("Manual check recorded: Confirm PR-controlled code cannot access secrets.")), true);
  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-FEEDBACK-001"), false);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("policy:POLICY-CI-SECRET-001")), false);
});

test("path-scoped false-positive feedback does not downgrade mixed-path risk evidence", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.scope.changed_files.push({
    path: "schemas/generated.schema.json",
    status: "M",
    areas: ["SCHEMA"],
    role: "config",
    added_lines: 10,
    deleted_lines: 0
  });
  surface.risks.candidates = [{
    ...prRiskFixture("schema_contract_change"),
    id: "PR-RISK-MIXED-SCHEMA",
    severity: "high",
    evidence: [
      fileEvidence("schemas/human_review.schema.json", "Hand-edited schema changed."),
      fileEvidence("schemas/generated.schema.json", "Generated schema changed.")
    ]
  }];

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    feedback: [
      {
        path: ".review-surfaces/feedback/memory.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "local",
        findings: [],
        validation: { passed: [], failed: [], notes: [] },
        false_positives: [
          {
            rule: "schema_contract_change",
            path_pattern: "schemas/generated.schema.json",
            action: "downgrade_to_low",
            evidence: [feedbackEvidence(".review-surfaces/feedback/memory.yaml", "Generated schema change is noisy.", { eventId: "false_positive:1" })]
          }
        ],
        false_negatives: [],
        team_policy: [],
        reviewer_preferences: []
      }
    ]
  });

  const queueItem = model.review_queue.find((item) => item.risk_ids.includes("PR-RISK-MIXED-SCHEMA"));
  assert.ok(queueItem);
  assert.equal(queueItem.path, "schemas/human_review.schema.json");
  assert.equal(queueItem.priority, "high");
  assert.equal(queueItem.reason.includes("Feedback memory downgraded"), false);
  assert.equal(model.feedback_effects.some((effect) => effect.kind === "false_positive" && effect.paths.includes("schemas/generated.schema.json")), true);
});

test("unsupported conditional false-positive feedback is skipped", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [{
    ...prRiskFixture("schema_contract_change"),
    id: "PR-RISK-CONDITIONAL-SCHEMA",
    severity: "high",
    evidence: [fileEvidence("schemas/human_review.schema.json", "Hand-edited schema changed.")]
  }];

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    feedback: [
      {
        path: ".review-surfaces/feedback/memory.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "local",
        findings: [],
        validation: { passed: [], failed: [], notes: [] },
        false_positives: [
          {
            rule: "schema_contract_change",
            path_pattern: "schemas/**/*.json",
            condition: "generated_schema",
            action: "downgrade_to_low",
            evidence: [feedbackEvidence(".review-surfaces/feedback/memory.yaml", "Generated schema condition is unsupported.", { eventId: "false_positive:1" })]
          }
        ],
        false_negatives: [],
        team_policy: [],
        reviewer_preferences: []
      }
    ]
  });

  const queueItem = model.review_queue.find((item) => item.risk_ids.includes("PR-RISK-CONDITIONAL-SCHEMA"));
  assert.ok(queueItem);
  assert.equal(queueItem.priority, "high");
  assert.equal(model.feedback_effects.some((effect) => effect.kind === "false_positive"), false);
});

test("legacy feedback indexes without policy arrays do not break human review rebuild", () => {
  const model = buildHumanReview({
    packet: packetFixture(),
    prSurface: prSurfaceFixture(),
    feedback: [
      {
        path: ".review-surfaces/feedback/legacy.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "local",
        findings: [],
        validation: { passed: [], failed: [], notes: [] }
      } as unknown as FeedbackFile
    ]
  });

  assert.deepEqual(model.feedback_effects, []);
});

test("team-policy manual checks require recorded positive evidence, not policy or inconclusive wording", () => {
  const build = (note: string) => {
    const packet = packetFixture();
    packet.evaluation.results = [];
    packet.evaluation.acai_coverage = {};
    packet.risks.items = [];
    packet.risks.missing_automatic_tests = [];
    packet.risks.missing_manual_checks = [];
    packet.risks.test_evidence.push({
      id: "TEST-POLICY-MANUAL-CHECK",
      kind: "indirect",
      summary: "Manual team-policy check note.",
      evidence: [feedbackEvidence(".review-surfaces/feedback/manual-dogfood.yaml", note, { sha: "abc123" })]
    });

    const surface = prSurfaceFixture();
    surface.risks.candidates = [];
    return buildHumanReview({
      packet,
      prSurface: surface,
      feedback: [
        {
          path: ".review-surfaces/feedback/memory.yaml",
          schema_version: "review-surfaces.feedback.v1",
          author: "local",
          findings: [],
          validation: { passed: [], failed: [], notes: [] },
          false_positives: [],
          false_negatives: [],
          team_policy: [
            {
              id: "POLICY-CI-SECRET-001",
              path_pattern: ".github/workflows/*.yml",
              required_manual_check: "Confirm PR-controlled code cannot access secrets.",
              evidence: [feedbackEvidence(".review-surfaces/feedback/memory.yaml", "Team policy requires CI secret review.", { eventId: "POLICY-CI-SECRET-001" })]
            }
          ],
          reviewer_preferences: []
        }
      ]
    });
  };

  const policyText = build("Policy requires a manual check: Confirm PR-controlled code cannot access secrets.");
  const inconclusiveText = build("Manual check recorded: unable to confirm PR-controlled code cannot access secrets.");
  const notRecordedText = build("Manual check not recorded: Confirm PR-controlled code cannot access secrets.");
  const notReviewedText = build("Manual check not reviewed: Confirm PR-controlled code cannot access secrets.");
  const notInspectedText = build("Manual check not inspected: Confirm PR-controlled code cannot access secrets.");
  const reviewedWhetherText = build("Reviewed whether to confirm PR-controlled code cannot access secrets.");
  const unverifiedText = build("Unverified: manual check recorded: Confirm PR-controlled code cannot access secrets.");
  const noManualCheckText = build("No manual check recorded: Confirm PR-controlled code cannot access secrets.");

  assert.equal(policyText.blockers.some((blocker) => blocker.id === "BLOCK-FEEDBACK-001"), true);
  assert.equal(inconclusiveText.blockers.some((blocker) => blocker.id === "BLOCK-FEEDBACK-001"), true);
  assert.equal(notRecordedText.blockers.some((blocker) => blocker.id === "BLOCK-FEEDBACK-001"), true);
  assert.equal(notReviewedText.blockers.some((blocker) => blocker.id === "BLOCK-FEEDBACK-001"), true);
  assert.equal(notInspectedText.blockers.some((blocker) => blocker.id === "BLOCK-FEEDBACK-001"), true);
  assert.equal(reviewedWhetherText.blockers.some((blocker) => blocker.id === "BLOCK-FEEDBACK-001"), true);
  assert.equal(unverifiedText.blockers.some((blocker) => blocker.id === "BLOCK-FEEDBACK-001"), true);
  assert.equal(noManualCheckText.blockers.some((blocker) => blocker.id === "BLOCK-FEEDBACK-001"), true);
});

test("human review schema enums stay aligned with runtime contract constants", () => {
  assert.equal(schema.properties.schema_version.const, HUMAN_REVIEW_SCHEMA_VERSION);
  assert.deepEqual(schema.properties.verdict.properties.decision.enum, [...HUMAN_REVIEW_DECISIONS]);
  assert.deepEqual(schema.$defs.reviewQueueItem.properties.priority.enum, [...HUMAN_REVIEW_PRIORITIES]);
  assert.deepEqual(schema.$defs.question.properties.severity.enum, [...REVIEWER_QUESTION_SEVERITIES]);
  assert.deepEqual(schema.$defs.suggestedComment.properties.severity.enum, [...SUGGESTED_COMMENT_SEVERITIES]);
  assert.deepEqual(schema.$defs.feedbackEffect.properties.kind.enum, [...FEEDBACK_POLICY_EFFECT_KINDS]);
  assert.deepEqual(schema.$defs.confidence.enum, [...PACKET_CONFIDENCE_LEVELS]);
  assert.deepEqual(schema.$defs.severity.enum, [...PACKET_SEVERITIES]);
  assert.deepEqual(schema.$defs.evidenceRef.properties.kind.enum, [...PACKET_EVIDENCE_KINDS]);
  assert.deepEqual(schema.$defs.evidenceRef.properties.validation_status.enum, [...PACKET_VALIDATION_STATUSES]);
});

test("human review schema accepts prior v1 artifacts without feedback effects", () => {
  const model = JSON.parse(JSON.stringify(buildHumanReview({ packet: packetFixture(), prSurface: prSurfaceFixture() }))) as Record<string, unknown>;
  delete model.feedback_effects;

  const result = validateJsonSchema(schema, model);

  assert.equal(result.valid, true);
});

test("human trust gaps suggest human review tests, not PR tests from incidental substrings", () => {
  const packet = packetFixture();
  packet.evaluation.results = [
    {
      requirement_id: "REQ-HUMAN-TRUST-1",
      acai_id: "review-surfaces.HUMAN_TRUST.1",
      status: "partial",
      summary: "Implementation and test-path evidence exist, but no requirement-specific proof was found.",
      partial_reason: "broad_area_only",
      evidence: [fileEvidence("src/human/human-review.ts", "Human trust builder evidence.")],
      missing_evidence: [missingEvidence("Needs exact HUMAN_TRUST test evidence.")],
      review_focus: "Review human trust surface.",
      confidence: "medium"
    }
  ];
  packet.evaluation.acai_coverage = { "review-surfaces.HUMAN_TRUST.1": "partial" };

  const model = buildHumanReview({ packet });

  assert.equal(model.test_plan[0].maps_to_requirements.includes("review-surfaces.HUMAN_TRUST.1"), true);
  assert.equal(model.test_plan[0].suggested_file, "tests/human-review.test.ts");
});

test("human suggested comments synthesize evidence-backed drafts for non-cleared PR risk rules", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];
  packet.risks.test_evidence.push({
    id: "TEST-MANUAL-CI-SECRET",
    kind: "indirect",
    summary: "Manual CI secret-boundary check recorded.",
    evidence: [
      feedbackEvidence(
        ".review-surfaces/feedback/manual-dogfood.yaml",
        "Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets.",
        { sha: "abc123" }
      )
    ]
  });

  const surface = prSurfaceFixture();
  surface.risks.candidates = PR_RISK_RULES.map((rule) => prRiskFixture(rule));

  const model = buildHumanReview({ packet, prSurface: surface });
  const byRisk = new Map(model.suggested_comments.flatMap((comment) => comment.risk_ids.map((riskId) => [riskId, comment] as const)));
  const expectedRisks = surface.risks.candidates.filter((risk) => risk.rule !== "ci_secret_boundary_change");

  assert.equal(model.suggested_comments.length, expectedRisks.length);
  assert.equal(surface.risks.candidates.length, PR_RISK_RULES.length);
  assert.equal(model.suggested_comments.every((comment) => comment.evidence.length > 0), true);
  assert.equal(model.suggested_comments.every((comment) => comment.ready_to_post), true);
  assert.ok(model.suggested_comments.some((comment) => comment.severity === "blocking"));
  assert.ok(model.suggested_comments.some((comment) => comment.severity === "clarifying"));
  assert.ok(model.suggested_comments.some((comment) => comment.severity === "non_blocking"));
  assert.equal(byRisk.has("PR-RISK-CI"), false);
  for (const risk of expectedRisks) {
    assert.ok(byRisk.has(risk.id), `missing suggested comment for ${risk.rule}`);
  }
});

test("human suggested comments ask for CI secret-boundary manual check only when missing", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [prRiskFixture("ci_secret_boundary_change")];

  const missing = buildHumanReview({ packet, prSurface: surface });
  const missingManualCheckComments = missing.suggested_comments.filter((comment) => /manual check/.test(comment.body));
  assert.equal(missingManualCheckComments.length, 1);
  assert.equal(missingManualCheckComments[0]?.severity, "blocking");
  assert.equal(missing.suggested_comments.some((comment) => comment.risk_ids.includes("PR-RISK-CI")), false);

  packet.risks.test_evidence.push({
    id: "TEST-MANUAL-CI-SECRET",
    kind: "indirect",
    summary: "Manual CI secret-boundary check recorded.",
    evidence: [
      feedbackEvidence(
        ".review-surfaces/feedback/manual-dogfood.yaml",
        "Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets.",
        { sha: "abc123" }
      )
    ]
  });

  const recorded = buildHumanReview({ packet, prSurface: surface });
  assert.equal(recorded.suggested_comments.some((comment) => comment.risk_ids.includes("PR-RISK-CI")), false);
  assert.equal(recorded.suggested_comments.some((comment) => /CI secret boundary.*manual check/.test(comment.body)), false);
});

test("human suggested comments do not duplicate failed-test blocker comments", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];
  packet.risks.test_evidence.push({
    id: "TEST-FAILED",
    kind: "missing",
    summary: "Parsed test results report one failed test.",
    evidence: [missingEvidence("Test totals: 1 failed out of 100 cases.")]
  });

  const surface = prSurfaceFixture();
  surface.risks.candidates = [prRiskFixture("failed_or_skipped_test")];

  const model = buildHumanReview({ packet, prSurface: surface });
  const failedValidationComments = model.suggested_comments.filter((comment) => /fail/i.test(comment.body));

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-TESTS-001"), true);
  assert.equal(failedValidationComments.length, 1);
  assert.equal(failedValidationComments[0]?.body, "Fix or explicitly defer the failing validation before merge.");
  assert.equal(model.suggested_comments.some((comment) => comment.risk_ids.includes("PR-RISK-TEST")), false);
});

test("human suggested comments keep skipped-only test risk drafts", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [
    {
      ...prRiskFixture("failed_or_skipped_test"),
      summary: "Parsed test results report one skipped test.",
      evidence: [missingEvidence("Test totals: 1 skipped out of 100 cases.")]
    }
  ];

  const model = buildHumanReview({ packet, prSurface: surface });

  assert.equal(model.blockers.some((blocker) => blocker.id === "BLOCK-TESTS-001"), false);
  assert.equal(model.suggested_comments.some((comment) => comment.risk_ids.includes("PR-RISK-TEST")), true);
  assert.equal(model.suggested_comments.find((comment) => comment.risk_ids.includes("PR-RISK-TEST"))?.severity, "blocking");
});

test("blocking suggested comments stay visible when non-blocking risk drafts exceed the cap", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [
    ...Array.from({ length: 10 }, (_, index) => ({
      ...prRiskFixture("large_diff"),
      id: `PR-RISK-LARGE-${String(index + 1).padStart(3, "0")}`,
      evidence: [fileEvidence(`src/human/large-${index + 1}.ts`, "Large diff risk.")]
    })),
    prRiskFixture("privacy_sensitive_change")
  ];

  const model = buildHumanReview({ packet, prSurface: surface });

  assert.equal(model.suggested_comments.length, 10);
  assert.ok(model.suggested_comments.some((comment) => comment.risk_ids.includes("PR-RISK-PRIVACY")));
  assert.equal(model.suggested_comments.find((comment) => comment.risk_ids.includes("PR-RISK-PRIVACY"))?.severity, "blocking");
  assert.equal(model.suggested_comments.some((comment) => comment.risk_ids.includes("PR-RISK-LARGE-010")), false);
});

test("human test plan synthesizes concrete checks for every PR risk rule", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = PR_RISK_RULES.map((rule) => prRiskFixture(rule));

  const model = buildHumanReview({ packet, prSurface: surface });
  const byRisk = new Map(model.test_plan.flatMap((item) => item.maps_to_risks.map((riskId) => [riskId, item] as const)));

  assert.equal(surface.risks.candidates.length, PR_RISK_RULES.length);
  assert.equal(byRisk.get("PR-RISK-COVERAGE")?.suggested_file, "tests/scoped-coverage.test.ts");
  assert.equal(byRisk.get("PR-RISK-COVERAGE")?.priority, "required");
  assert.equal(byRisk.get("PR-RISK-UNTESTED")?.suggested_file, "tests/human-review.test.ts");
  assert.equal(byRisk.get("PR-RISK-UNTESTED")?.priority, "required");
  assert.equal(byRisk.get("PR-RISK-UNMAPPED")?.kind, "manual");
  assert.equal(byRisk.get("PR-RISK-PRIVACY")?.suggested_file, "tests/privacy.test.ts");
  assert.equal(byRisk.get("PR-RISK-COMMENT")?.suggested_file, "tests/pr-comment.test.ts");
  assert.equal(byRisk.get("PR-RISK-CI")?.kind, "manual");
  assert.equal(byRisk.get("PR-RISK-SCHEMA")?.suggested_file, "tests/schema-contract.test.ts");
  assert.equal(byRisk.get("PR-RISK-DELETE")?.command, "pnpm run test -- tests/human-review.test.ts");
  assert.equal(byRisk.get("PR-RISK-TEST")?.command, "pnpm run test");
  assert.equal(byRisk.get("PR-RISK-LARGE")?.priority, "optional");
  assert.equal(model.test_plan.every((item) => item.maps_to_risks.length > 0), true);
});

test("human trust audit records concrete deterministic PR risk firings", () => {
  const surface = prSurfaceFixture();
  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface });
  const verifiedSummaries = model.trust_audit.verified_facts.map((fact) => fact.summary).join("\n");

  assert.match(verifiedSummaries, /Deterministic PR risk PR-RISK-001 \(ci_secret_boundary_change\) fired/);
  assert.match(verifiedSummaries, /Deterministic PR risk PR-RISK-002 \(schema_contract_change\) fired/);
  assert.doesNotMatch(verifiedSummaries, /PR-RISK-003 \(large_diff\) fired/);
});

test("required PR risk checks stay visible when the test plan is capped", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [
    ...Array.from({ length: 12 }, (_, index) => ({
      ...prRiskFixture("untested_changed_impl"),
      id: `PR-RISK-UNTESTED-${String(index + 1).padStart(3, "0")}`,
      evidence: [fileEvidence(`src/human/impl-${index + 1}.ts`, "Untested implementation change.")]
    })),
    prRiskFixture("ci_secret_boundary_change")
  ];

  const model = buildHumanReview({ packet, prSurface: surface });

  assert.equal(model.test_plan.length, 12);
  assert.ok(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-CI")));
  assert.equal(model.test_plan.find((item) => item.maps_to_risks.includes("PR-RISK-CI"))?.kind, "manual");
});

test("duplicate PR risk drafts do not consume the cap before distinct focused gaps", () => {
  const packet = packetFixture();
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = Array.from({ length: 12 }, (_, index) => ({
    ...prRiskFixture("failed_or_skipped_test"),
    id: `PR-RISK-TEST-${String(index + 1).padStart(3, "0")}`
  }));

  const model = buildHumanReview({ packet, prSurface: surface });

  assert.ok(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-TEST-001")));
  assert.ok(model.test_plan.some((item) => item.maps_to_requirements.includes("review-surfaces.HUMAN_REVIEW.1")));
});

test("optional PR risk checks do not crowd out required focused gaps at the cap", () => {
  const packet = packetFixture();
  packet.evaluation.results = [{
    requirement_id: "REQ-HUMAN-MISSING",
    acai_id: "review-surfaces.HUMAN_TRUST.MISSING",
    status: "missing",
    summary: "Required human trust evidence is missing.",
    evidence: [],
    missing_evidence: [missingEvidence("No focused human trust test evidence.")],
    review_focus: "Review missing human trust evidence.",
    confidence: "medium"
  }];
  packet.evaluation.acai_coverage = { "review-surfaces.HUMAN_TRUST.MISSING": "missing" };
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [
    ...Array.from({ length: 11 }, (_, index) => ({
      ...prRiskFixture("untested_changed_impl"),
      id: `PR-RISK-UNTESTED-${String(index + 1).padStart(3, "0")}`,
      evidence: [fileEvidence(`src/human/impl-${index + 1}.ts`, "Untested implementation change.")]
    })),
    prRiskFixture("large_diff")
  ];

  const model = buildHumanReview({ packet, prSurface: surface });

  assert.equal(model.test_plan.length, 12);
  assert.ok(model.test_plan.some((item) => item.maps_to_requirements.includes("review-surfaces.HUMAN_TRUST.MISSING")));
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("PR-RISK-LARGE")), false);
});

test("coverage-regression test plan maps requirements from scoped deltas when risk evidence is path-only", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.coverage.deltas = [
    {
      requirement_id: "REQ-HUMAN-REGRESSED",
      acai_id: "review-surfaces.HUMAN_REVIEW.REGRESSION",
      base_status: "satisfied",
      head_status: "partial",
      delta: "regressed",
      reasons: ["path-only evidence"],
      head_evidence: [fileEvidence("src/human/human-review.ts", "Head evidence without ACID.")],
      missing_evidence: []
    }
  ];
  surface.risks.candidates = [{
    ...prRiskFixture("coverage_regression"),
    evidence: [fileEvidence("src/human/human-review.ts", "Path-only coverage evidence.")]
  }];

  const model = buildHumanReview({ packet, prSurface: surface });
  const item = model.test_plan.find((testItem) => testItem.maps_to_risks.includes("PR-RISK-COVERAGE"));

  assert.ok(item);
  assert.ok(item.maps_to_requirements.includes("review-surfaces.HUMAN_REVIEW.REGRESSION"));
});

test("coverage-regression test plan merges evidence and scoped regressed requirements", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.coverage.deltas = [
    {
      requirement_id: "REQ-HUMAN-EVIDENCE",
      acai_id: "review-surfaces.HUMAN_REVIEW.EVIDENCE_REGRESSION",
      base_status: "satisfied",
      head_status: "partial",
      delta: "regressed",
      reasons: ["evidence-backed regression"],
      head_evidence: [],
      missing_evidence: []
    },
    {
      requirement_id: "REQ-HUMAN-PATH",
      acai_id: "review-surfaces.HUMAN_REVIEW.PATH_REGRESSION",
      base_status: "satisfied",
      head_status: "partial",
      delta: "regressed",
      reasons: ["path-backed regression"],
      head_evidence: [fileEvidence("src/human/human-review.ts", "Path-backed coverage evidence.")],
      missing_evidence: []
    }
  ];
  surface.risks.candidates = [{
    ...prRiskFixture("coverage_regression"),
    evidence: [
      { kind: "spec", acai_id: "review-surfaces.HUMAN_REVIEW.EVIDENCE_REGRESSION", note: "Coverage regressed.", confidence: "high", validation_status: "valid" },
      fileEvidence("src/human/human-review.ts", "Path-only coverage evidence.")
    ]
  }];

  const model = buildHumanReview({ packet, prSurface: surface });
  const item = model.test_plan.find((testItem) => testItem.maps_to_risks.includes("PR-RISK-COVERAGE"));

  assert.ok(item);
  assert.ok(item.maps_to_requirements.includes("review-surfaces.HUMAN_REVIEW.EVIDENCE_REGRESSION"));
  assert.ok(item.maps_to_requirements.includes("review-surfaces.HUMAN_REVIEW.PATH_REGRESSION"));
});

test("invalid PR risk evidence is not rendered as a verified trust fact", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [{
    ...prRiskFixture("schema_contract_change"),
    evidence: [{
      ...fileEvidence("schemas/human_review.schema.json", "Invalid schema evidence."),
      validation_status: "invalid"
    }]
  }];

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface });
  const verifiedSummaries = model.trust_audit.verified_facts.map((fact) => fact.summary).join("\n");
  const invalidSummaries = model.trust_audit.invalid_evidence.map((item) => item.summary).join("\n");

  assert.doesNotMatch(verifiedSummaries, /PR-RISK-SCHEMA/);
  assert.match(invalidSummaries, /PR-RISK-SCHEMA: PR risk evidence is invalid or not deterministic/);
});

test("trust audit reserves capped verified slots for deterministic PR risk facts", () => {
  const packet = packetFixture();
  packet.risks.test_evidence = Array.from({ length: 12 }, (_, index) => ({
    id: `TEST-DIRECT-${String(index + 1).padStart(3, "0")}`,
    kind: "direct",
    summary: `Direct validation evidence ${index + 1}.`,
    evidence: [commandEvidence(`pnpm test -- --case ${index + 1}`, `Direct validation evidence ${index + 1}.`, "high", { validationStatus: "valid" })]
  }));

  const surface = prSurfaceFixture();
  surface.risks.candidates = [
    prRiskFixture("ci_secret_boundary_change"),
    prRiskFixture("schema_contract_change")
  ];

  const model = buildHumanReview({ packet, prSurface: surface });
  const verifiedSummaries = model.trust_audit.verified_facts.map((fact) => fact.summary).join("\n");

  assert.equal(model.trust_audit.verified_facts.length, 10);
  assert.match(verifiedSummaries, /PR scope contains/);
  assert.match(verifiedSummaries, /Deterministic PR risk PR-RISK-CI \(ci_secret_boundary_change\) fired/);
  assert.match(verifiedSummaries, /Deterministic PR risk PR-RISK-SCHEMA \(schema_contract_change\) fired/);
});

test("trust audit reserves capped invalid-evidence slots for PR risk refs", () => {
  const packet = packetFixture();
  packet.evaluation.results = Array.from({ length: 12 }, (_, index) => ({
    requirement_id: `REQ-INVALID-${String(index + 1).padStart(3, "0")}`,
    acai_id: `review-surfaces.INVALID.${index + 1}`,
    status: "invalid_evidence",
    summary: `Invalid requirement evidence ${index + 1}.`,
    evidence: [fileEvidence(`src/invalid-${index + 1}.ts`, "Invalid requirement evidence.")],
    missing_evidence: [missingEvidence(`Missing valid evidence ${index + 1}.`)],
    review_focus: "Review invalid evidence.",
    confidence: "medium"
  }));

  const surface = prSurfaceFixture();
  surface.risks.candidates = [{
    ...prRiskFixture("schema_contract_change"),
    evidence: [{
      ...fileEvidence("schemas/human_review.schema.json", "LLM-proposed schema evidence."),
      llm_proposed: true
    }]
  }];

  const model = buildHumanReview({ packet, prSurface: surface });
  const invalidSummaries = model.trust_audit.invalid_evidence.map((item) => item.summary).join("\n");

  assert.equal(model.trust_audit.invalid_evidence.length, 10);
  assert.match(invalidSummaries, /PR-RISK-SCHEMA: PR risk evidence is invalid or not deterministic/);
  assert.match(invalidSummaries, /review-surfaces.INVALID.1/);
});

function prRiskFixture(rule: PrRiskRule): PrReviewSurfaceModel["risks"]["candidates"][number] {
  const fixtures = {
    coverage_regression: {
      id: "PR-RISK-COVERAGE",
      category: "testing",
      severity: "high",
      summary: "Coverage regressed for review-surfaces.HUMAN_REVIEW.1.",
      evidence: [{ kind: "spec", acai_id: "review-surfaces.HUMAN_REVIEW.1", note: "Coverage regressed.", confidence: "high", validation_status: "valid" }],
      suggested_checks: ["Restore coverage."]
    },
    untested_changed_impl: {
      id: "PR-RISK-UNTESTED",
      category: "testing",
      severity: "medium",
      summary: "Implementation file changed without a co-changed test.",
      evidence: [fileEvidence("src/human/human-review.ts", "Untested implementation change.")],
      suggested_checks: ["Add a focused test."]
    },
    unmapped_change: {
      id: "PR-RISK-UNMAPPED",
      category: "workflow",
      severity: "low",
      summary: "A changed file is unmapped.",
      evidence: [fileEvidence("scripts/review-helper.ts", "Unmapped file.")],
      suggested_checks: ["Map or defer the file."]
    },
    privacy_sensitive_change: {
      id: "PR-RISK-PRIVACY",
      category: "privacy",
      severity: "high",
      summary: "Privacy-sensitive file changed.",
      evidence: [fileEvidence("src/privacy/secrets.ts", "Privacy-sensitive changed file.")],
      suggested_checks: ["Verify redaction."]
    },
    comment_surface_change: {
      id: "PR-RISK-COMMENT",
      category: "maintainability",
      severity: "medium",
      summary: "Reviewer comment surface changed.",
      evidence: [fileEvidence("src/render/pr-comment.ts", "Comment renderer changed.")],
      suggested_checks: ["Render the comment."]
    },
    ci_secret_boundary_change: {
      id: "PR-RISK-CI",
      category: "security",
      severity: "high",
      summary: "CI secret boundary changed.",
      evidence: [fileEvidence(".github/workflows/review-surfaces-pr.yml", "Workflow changed.")],
      suggested_checks: ["Record manual check."]
    },
    schema_contract_change: {
      id: "PR-RISK-SCHEMA",
      category: "architecture",
      severity: "medium",
      summary: "Schema contract changed.",
      evidence: [fileEvidence("schemas/human_review.schema.json", "Schema changed.")],
      suggested_checks: ["Add compatibility fixture."]
    },
    deleted_or_renamed_surface: {
      id: "PR-RISK-DELETE",
      category: "maintainability",
      severity: "low",
      summary: "Implementation surface was renamed.",
      evidence: [fileEvidence("src/old-human.ts", "Renamed implementation file.")],
      suggested_checks: ["Check stale references."]
    },
    failed_or_skipped_test: {
      id: "PR-RISK-TEST",
      category: "testing",
      severity: "high",
      summary: "Parsed test results report one failed test.",
      evidence: [missingEvidence("Test totals: 1 failed out of 100 cases.")],
      suggested_checks: ["Fix failing tests."]
    },
    large_diff: {
      id: "PR-RISK-LARGE",
      category: "maintainability",
      severity: "low",
      summary: "Large diff exceeds review threshold.",
      evidence: [missingEvidence("Diff size exceeded threshold.")],
      suggested_checks: ["Allocate extra review time."]
    }
  } satisfies Record<PrRiskRule, Omit<PrReviewSurfaceModel["risks"]["candidates"][number], "rule">>;

  return { rule, ...fixtures[rule] };
}
