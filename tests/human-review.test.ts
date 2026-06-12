import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHumanReview, humanReviewConfigSignature } from "../src/human/human-review";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import type { CollectionResult } from "../src/collector/collect";
import type { EvaluationModel } from "../src/evaluation/evaluate";
import {
  HUMAN_STANDALONE_ARTIFACTS,
  renderEvidenceCardsMarkdown,
  renderHumanReviewMarkdown,
  renderIntentMismatchMarkdown,
  renderRiskLensesMarkdown,
  renderReviewQueueMarkdown,
  renderReviewRoutesMarkdown,
  renderSinceLastReviewMarkdown,
  writeHumanReviewArtifacts
} from "../src/human/render";
import { ReviewPacket } from "../src/render/packet";
import { PrReviewSurfaceModel, PR_RISK_RULES, PrRiskRule, PR_SURFACE_SCHEMA_VERSION } from "../src/pr/contract";
import { commandEvidence, feedbackEvidence, fileEvidence, missingEvidence, testEvidence } from "../src/evidence/evidence";
import { validateJsonSchema } from "../src/schema/json-schema";
import { analyzeRisks } from "../src/risks/risks";
import { minimalReviewPacket } from "./helpers/review-packet";
import { normalizeFeedbackRecord, type FeedbackFile } from "../src/feedback/feedback";
import { runWalkthrough } from "../src/review/walkthrough";
import {
  DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
  EVIDENCE_CARD_STATUSES,
  FEEDBACK_POLICY_EFFECT_KINDS,
  HUMAN_REVIEW_DECISIONS,
  HUMAN_REVIEW_PRIORITIES,
  HUMAN_REVIEW_SCHEMA_VERSION,
  REVIEW_ROUTE_PERSONAS,
  REVIEWER_QUESTION_SEVERITIES,
  RISK_LENSES,
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
    base_sha: "base123",
    head_ref: "HEAD",
    head_sha: "abc123"
  };
  packet.intent = {
    summary: "Human review fixture intent.",
    spec_mode: "acai",
    requirements: [
      {
        id: "REQ-HUMAN-1",
        acai_id: "review-surfaces.HUMAN_REVIEW.1",
        title: "Human reviewer cockpit",
        requirement: "The default human surface must start with a merge-readiness verdict, top blockers, and an ordered review queue.",
        source_refs: [
          {
            kind: "spec",
            ref: "features/review-surfaces.feature.yaml",
            title: "review-surfaces.HUMAN_REVIEW.1",
            evidence: [fileEvidence("features/review-surfaces.feature.yaml", "Human review fixture requirement.", "high")]
          }
        ],
        constraints: [],
        assumptions: [],
        open_questions: [],
        confidence: "high"
      }
    ],
    constraints: [],
    non_goals: [],
    assumptions: [],
    open_questions: [],
    sources: []
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
    evidence: [fileEvidence("docs/history/human-first-review-surfaces-comprehensive-feature-proposal.md", "Proposal is present.")]
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
    spec_mode: "acai",
    status: "blocked",
    blocked_reason: "llm_unavailable",
    scope: {
      base_ref: "origin/main",
      base_sha: "base123",
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
          reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "schemas/human_review.schema.json" }]
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

test("review-surfaces.COVERAGE.3 a current report feeds ranking reasons and emits uncovered/partial evidence cards", () => {
  const model = buildHumanReview({
    packet: packetFixture(),
    prSurface: prSurfaceFixture(),
    diff: structuredDiffFixture(),
    coverageEvidence: {
      status: "report",
      source_path: "coverage/lcov.info",
      postdates_head: true,
      files: [
        {
          path: "schemas/human_review.schema.json",
          changed_lines: 4,
          covered_lines: 0,
          classification: "uncovered",
          hunks: [{ hunk_header: "@@ -70,2 +70,3 @@", changed_lines: 4, covered_lines: 0, classification: "uncovered", uncovered_lines: []  }]
        }
      ]
    }
  });
  const uncoveredItem = model.review_queue.find((i) => i.path === "schemas/human_review.schema.json");
  assert.ok(uncoveredItem?.ranking_reasons.some((r) => /none of its 4 changed line\(s\) are executed by any test/.test(r)));
  const card = model.evidence_cards.find((c) => c.title === "Changed lines uncovered");
  assert.ok(card, "uncovered changed lines produce an evidence card");
  assert.match(card.summary, /0 of 4 changed line\(s\)/);
  assert.equal(model.coverage_evidence.status, "report");
});

test("review-surfaces.COVERAGE.2 a stale report (predates head) is recorded but never trusted as ranking or card evidence", () => {
  const model = buildHumanReview({
    packet: packetFixture(),
    prSurface: prSurfaceFixture(),
    diff: structuredDiffFixture(),
    coverageEvidence: {
      status: "report",
      source_path: "coverage/lcov.info",
      postdates_head: false,
      files: [
        {
          path: "src/human/human-review.ts",
          changed_lines: 4,
          covered_lines: 0,
          classification: "uncovered",
          hunks: [{ hunk_header: "@@ -220,2 +220,3 @@", changed_lines: 4, covered_lines: 0, classification: "uncovered", uncovered_lines: []  }]
        }
      ]
    }
  });
  assert.equal(model.coverage_evidence.postdates_head, false);
  assert.ok(!model.review_queue.some((i) => i.ranking_reasons.some((r) => /executed by any test/.test(r))));
  assert.ok(!model.evidence_cards.some((c) => c.title === "Changed lines uncovered"));
});

test("review-surfaces.COVERAGE.4 no report renders the honest negative, never a penalty", () => {
  const model = buildHumanReview({ packet: packetFixture(), prSurface: prSurfaceFixture(), diff: structuredDiffFixture() });
  assert.equal(model.coverage_evidence.status, "no_report");
  const markdown = renderHumanReviewMarkdown(model);
  assert.match(markdown, /No coverage evidence: no coverage report was provided\. This is different from changed lines being uncovered\./);
  assert.ok(!model.review_queue.some((i) => i.ranking_reasons.some((r) => /uncovered|executed by any test/.test(r))));
});

test("review-surfaces.RANKING.2 every review-queue item carries a why-ranked-here line", () => {
  const model = buildHumanReview({ packet: packetFixture(), prSurface: prSurfaceFixture(), diff: structuredDiffFixture() });
  assert.ok(model.review_queue.length > 0);
  for (const item of model.review_queue) {
    assert.ok(Array.isArray(item.ranking_reasons) && item.ranking_reasons.length > 0, `item ${item.id} has a ranking reason`);
  }
});

test("review-surfaces.RANKING.1 an untested changed impl is promoted with a 'no changed test' reason; a test-evidenced path is demoted", () => {
  const prSurface = prSurfaceFixture();
  prSurface.risks.candidates.push({
    id: "PR-RISK-UNTESTED",
    rule: "untested_changed_impl",
    category: "maintainability",
    severity: "medium",
    summary: "Implementation file src/untested.ts changed with no changed test.",
    evidence: [fileEvidence("src/untested.ts", "Changed impl, no test.")],
    suggested_checks: ["Add a test."]
  });
  const model = buildHumanReview({
    packet: packetFixture(),
    prSurface,
    diff: structuredDiffFixture(),
    rankingEvidence: { changed_tests_by_impl: { "src/new-name.ts": ["tests/new-name.test.ts"] } }
  });
  const untested = model.review_queue.find((i) => i.path === "src/untested.ts");
  assert.ok(untested, "the untested impl is in the queue (evidence never hides an item)");
  assert.ok(untested.ranking_reasons.some((r) => /no changed test or current-head transcript/.test(r)));
  const evidenced = model.review_queue.find((i) => i.path === "src/new-name.ts");
  if (evidenced) {
    assert.ok(evidenced.ranking_reasons.some((r) => /focused test changed alongside this file/.test(r)));
  }
});

test("review-surfaces.RANKING.3 the evidence modifier reorders but never drops an item, and is deterministic", () => {
  const base = { packet: packetFixture(), prSurface: prSurfaceFixture(), diff: structuredDiffFixture() };
  const without = buildHumanReview(base);
  const withEvidence = buildHumanReview({ ...base, rankingEvidence: { changed_tests_by_impl: { "src/new-name.ts": ["tests/new-name.test.ts"] } } });
  // The evidence tier demotes, it never removes: the item count is unchanged.
  assert.equal(withEvidence.review_queue.length, without.review_queue.length);
  // Evidence is a SECONDARY key, so it cannot reorder across the primary score —
  // the top (highest-class) item is unchanged by the evidence signal.
  assert.equal(withEvidence.review_queue[0].path, without.review_queue[0].path);
  // Byte-deterministic for identical inputs.
  assert.equal(JSON.stringify(buildHumanReview(base)), JSON.stringify(buildHumanReview(base)));
});

// review-surfaces.SEMANTIC_DIFF.4: the deterministic semantic facts carry their
// concrete, field/signature-level language into the review queue, the suggested
// comments, AND the risk lenses — not generic path-touch phrasing.
test("review-surfaces.SEMANTIC_DIFF.4 facts carry concrete language into the queue, comments, and lenses", () => {
  const semanticFacts = {
    schema_changes: [
      {
        path: "schemas/human_review.schema.json",
        properties_added: [],
        properties_removed: [],
        required_added: ["semantic_facts"],
        required_removed: [],
        type_changes: [],
        enum_changes: []
      }
    ],
    api_changes: [
      { path: "src/api.ts", exports_added: [], exports_removed: ["legacyExport"], signatures_changed: [] }
    ],
    test_weakening: []
  };
  const model = buildHumanReview({
    packet: packetFixture(),
    prSurface: prSurfaceFixture(),
    diff: structuredDiffFixture(),
    semanticFacts
  });

  // Stored verbatim on the model.
  assert.deepEqual(model.semantic_facts, semanticFacts);

  // Queue: concrete field-level language, not a generic path-touch reason.
  assert.ok(
    model.review_queue.some((item) => /became required/.test(item.reason)),
    "a queue item reason carries the field-level schema language"
  );

  // Comments: the removed export is named concretely.
  assert.ok(
    model.suggested_comments.some((comment) => /legacyExport/.test(comment.body)),
    "a suggested comment names the removed export"
  );

  // Lenses: the schema/API facts feed the api_contract lens (paths reach it).
  const apiLens = model.risk_lens_findings.find((finding) => finding.lens === "api_contract");
  assert.ok(apiLens, "an api_contract lens finding is produced from the facts");
  assert.ok(
    apiLens!.paths.includes("src/api.ts") || apiLens!.paths.includes("schemas/human_review.schema.json"),
    "the lens carries the changed contract paths from the facts"
  );
});

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
  assert.equal(model.generated_from.base_sha, "base123");
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
  assert.ok(model.risk_lens_findings.some((finding) => finding.lens === "security_privacy"));
  assert.ok(model.risk_lens_findings.some((finding) => finding.lens === "api_contract"));
  assert.ok(model.risk_lens_findings.every((finding) => finding.evidence.length > 0));
  assert.ok(model.intent_mismatch.expected_by_spec.some((item) => item.requirement_ids.includes("review-surfaces.HUMAN_REVIEW.1")));
  assert.ok(model.intent_mismatch.observed_in_diff.some((item) => item.paths.includes("schemas/human_review.schema.json")));
  assert.ok(model.intent_mismatch.possible_mismatches.some((item) => item.requirement_ids.includes("review-surfaces.HUMAN_REVIEW.1")));
  assert.ok(model.evidence_cards.length > 0);
  assert.ok(model.evidence_cards.some((card) => card.status === "mixed" || card.status === "missing_evidence"));
  assert.ok(model.evidence_cards.every((card) => card.reviewer_action.length > 0));
  assert.ok(model.test_plan.some((item) => item.kind === "manual" && item.priority === "required"));
  assert.ok(model.skim_safe.some((item) => item.path === "docs/notes.md"));

  const validation = validateJsonSchema(schema, model);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
});

test("review-surfaces.HUMAN_REVIEW.18 renders explicit intent mismatch buckets and reviewer questions", () => {
  const packet = packetFixture();
  packet.evaluation.overreach = [
    {
      requirement_id: "OVER-001",
      status: "overreach",
      summary: "Release helper changed outside stated human-review intent.",
      evidence: [fileEvidence("scripts/release.sh", "Release helper is not mapped to the stated intent.")],
      missing_evidence: [],
      review_focus: "Confirm whether the release helper belongs in this PR.",
      confidence: "medium"
    }
  ];
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files.push({
    path: "scripts/release.sh",
    status: "M",
    areas: [],
    role: "implementation",
    added_lines: 3,
    deleted_lines: 1
  });
  prSurface.scope.out_of_scope_changed_files.push({
    path: "scripts/release.sh",
    status: "M",
    reason: "unmapped"
  });

  const model = buildHumanReview({ packet, prSurface, diff: structuredDiffFixture() });

  assert.ok(model.intent_mismatch.expected_by_spec.some((item) => item.summary.includes("review-surfaces.HUMAN_REVIEW.1")));
  assert.ok(model.intent_mismatch.observed_in_diff.some((item) => item.paths.includes("scripts/release.sh")));
  assert.ok(model.intent_mismatch.possible_mismatches.some((item) => item.summary.includes("Partial implementation evidence")));
  assert.ok(model.intent_mismatch.possible_overreach.some((item) => item.paths.includes("scripts/release.sh")));
  assert.ok(model.intent_mismatch.missing_intent.some((item) => item.paths.includes("scripts/release.sh")));
  assert.ok(model.questions.some((question) => /intent gap/.test(question.question) && question.evidence.some((ref) => ref.path === "scripts/release.sh")));
  assert.equal(model.review_routes.find((route) => route.persona === "product")?.steps[0]?.artifact, "intent_mismatch.md");

  const humanMarkdown = renderHumanReviewMarkdown(model);
  assert.match(humanMarkdown, /## Intent mismatch/);
  assert.match(humanMarkdown, /missing-intent item/);

  const intentMarkdown = renderIntentMismatchMarkdown(model);
  assert.match(intentMarkdown, /^# Intent Mismatch/);
  assert.match(intentMarkdown, /## Expected by spec/);
  assert.match(intentMarkdown, /## Observed in diff/);
  assert.match(intentMarkdown, /## Possible mismatch/);
  assert.match(intentMarkdown, /scripts\/release\.sh/);

  const validation = validateJsonSchema(schema, model);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
});

test("review-surfaces.HUMAN_REVIEW.18 PR intent mismatch does not fall back to packet-wide gaps when focus is unmapped", () => {
  const packet = packetFixture();
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files = [
    {
      path: "scripts/release.sh",
      status: "M",
      areas: [],
      role: "implementation",
      added_lines: 3,
      deleted_lines: 1
    }
  ];
  prSurface.scope.affected_areas = [];
  prSurface.scope.affected_requirements = [];
  prSurface.scope.out_of_scope_changed_files = [
    {
      path: "scripts/release.sh",
      status: "M",
      reason: "unmapped"
    }
  ];
  prSurface.coverage.deltas = [];
  prSurface.coverage.in_scope_count = 0;
  prSurface.risks.candidates = [];
  const diff = parseStructuredDiff([
    "diff --git a/scripts/release.sh b/scripts/release.sh",
    "--- a/scripts/release.sh",
    "+++ b/scripts/release.sh",
    "@@ -1,1 +1,2 @@",
    " echo release",
    "+echo ship",
    ""
  ].join("\n"));

  const model = buildHumanReview({ packet, prSurface, diff });

  assert.deepEqual(model.intent_mismatch.possible_mismatches, []);
  assert.ok(model.intent_mismatch.missing_intent.some((item) => item.paths.includes("scripts/release.sh")));
  assert.ok(model.questions.some((question) => /scripts\/release\.sh/.test(question.question)));
});

test("review-surfaces.HUMAN_REVIEW.18 repo-scope intent mismatch observes diff files without PR surface", () => {
  const diff = parseStructuredDiff([
    "diff --git a/scripts/release.sh b/scripts/release.sh",
    "--- a/scripts/release.sh",
    "+++ b/scripts/release.sh",
    "@@ -1,1 +1,2 @@",
    " echo release",
    "+echo ship # review-surfaces.HUMAN_REVIEW.18.",
    ""
  ].join("\n"));

  const model = buildHumanReview({ packet: packetFixture(), diff });
  const observed = model.intent_mismatch.observed_in_diff.find((item) => item.paths.includes("scripts/release.sh"));

  assert.equal(model.mode, "repo");
  assert.ok(observed);
  assert.deepEqual(observed.requirement_ids, ["review-surfaces.HUMAN_REVIEW.18"]);
  assert.match(observed.summary, /references exact requirement/);
  assert.ok(model.intent_mismatch.missing_intent.some((item) => item.paths.includes("scripts/release.sh")));
  assert.ok(model.questions.some((question) => /scripts\/release\.sh/.test(question.question)));
});

test("review-surfaces.HUMAN_REVIEW.18 PR intent mismatch scopes packet overreach to changed paths", () => {
  const packet = packetFixture();
  packet.evaluation.overreach = [
    {
      requirement_id: "OVER-RELATED",
      status: "overreach",
      summary: "Schema surface changed beyond stated intent.",
      evidence: [fileEvidence("schemas/human_review.schema.json", "Changed schema path is in this PR.")],
      missing_evidence: [],
      review_focus: "Confirm whether schema change belongs in this PR.",
      confidence: "medium"
    },
    {
      requirement_id: "OVER-UNRELATED",
      status: "overreach",
      summary: "Old unrelated docs overreach.",
      evidence: [fileEvidence("docs/unrelated.md", "Whole-repo packet carried a stale overreach finding.")],
      missing_evidence: [],
      review_focus: "Ignore for this PR.",
      confidence: "medium"
    }
  ];

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture(), diff: structuredDiffFixture() });
  const summaries = model.intent_mismatch.possible_overreach.map((item) => item.summary);

  assert.ok(summaries.some((summary) => /OVER-RELATED/.test(summary)));
  assert.ok(!summaries.some((summary) => /OVER-UNRELATED/.test(summary)));
});

test("review-surfaces.HUMAN_REVIEW.18 observed diff prefers exact added ACIDs over broad spec path mappings", () => {
  const packet = packetFixture();
  const broadSpecAcid = ["review-surfaces", "BOOTSTRAP", "1"].join(".");
  packet.intent.requirements.push({
    id: "REQ-HUMAN-18",
    acai_id: "review-surfaces.HUMAN_REVIEW.18",
    title: "Intent mismatch",
    requirement: "Render intent mismatch findings.",
    source_refs: [
      {
        kind: "spec",
        ref: "features/review-surfaces.feature.yaml",
        title: "review-surfaces.HUMAN_REVIEW.18",
        evidence: [fileEvidence("features/review-surfaces.feature.yaml", "Intent mismatch requirement.", "high")]
      }
    ],
    constraints: [],
    assumptions: [],
    open_questions: [],
    confidence: "high"
  });
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files = [
    {
      path: "features/review-surfaces.feature.yaml",
      status: "M",
      areas: ["BOOTSTRAP"],
      role: "spec",
      added_lines: 3,
      deleted_lines: 0
    }
  ];
  prSurface.scope.affected_requirements = [
    {
      requirement_id: "REQ-BOOTSTRAP-1",
      acai_id: broadSpecAcid,
      title: "Bootstrap scaffold",
      group_key: "BOOTSTRAP",
      reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "features/review-surfaces.feature.yaml" }]
    }
  ];
  prSurface.scope.out_of_scope_changed_files = [];
  prSurface.coverage.deltas = [];
  prSurface.risks.candidates = [];
  const diff = parseStructuredDiff([
    "diff --git a/features/review-surfaces.feature.yaml b/features/review-surfaces.feature.yaml",
    "--- a/features/review-surfaces.feature.yaml",
    "+++ b/features/review-surfaces.feature.yaml",
    "@@ -250,2 +250,4 @@",
    "       17:",
    "+        requirement: review-surfaces.HUMAN_REVIEW.18 renders explicit intent mismatch.",
    ""
  ].join("\n"));

  const model = buildHumanReview({ packet, prSurface, diff });
  const observed = model.intent_mismatch.observed_in_diff.find((item) => item.paths.includes("features/review-surfaces.feature.yaml"));

  assert.ok(observed);
  assert.deepEqual(observed.requirement_ids, ["review-surfaces.HUMAN_REVIEW.18"]);
  assert.match(observed.summary, /references exact requirement/);
  assert.ok(!observed.requirement_ids.some((id) => id.includes("BOOTSTRAP")));
});

test("review-surfaces.HUMAN_REVIEW.18 observed diff requires whole-token exact ACIDs", () => {
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files = [
    {
      path: "tests/human-review.test.ts",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "test",
      added_lines: 2,
      deleted_lines: 0
    }
  ];
  prSurface.scope.affected_requirements = [
    {
      requirement_id: "REQ-HUMAN-1",
      acai_id: "review-surfaces.HUMAN_REVIEW.1",
      title: "Human surface starts with verdict",
      group_key: "HUMAN_REVIEW",
      reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "tests/human-review.test.ts" }]
    }
  ];
  prSurface.scope.out_of_scope_changed_files = [];
  prSurface.coverage.deltas = [];
  prSurface.risks.candidates = [];
  const diff = parseStructuredDiff([
    "diff --git a/tests/human-review.test.ts b/tests/human-review.test.ts",
    "--- a/tests/human-review.test.ts",
    "+++ b/tests/human-review.test.ts",
    "@@ -10,2 +10,4 @@",
    " test('intent') {",
    "+  const suffix = 'review-surfaces.HUMAN_REVIEW.18-beta';",
    "+  const word = 'review-surfaces.HUMAN_REVIEW.18foo';",
    ""
  ].join("\n"));

  const model = buildHumanReview({ packet: packetFixture(), prSurface, diff });
  const observed = model.intent_mismatch.observed_in_diff.find((item) => item.paths.includes("tests/human-review.test.ts"));

  assert.ok(observed);
  assert.deepEqual(observed.requirement_ids, ["review-surfaces.HUMAN_REVIEW.1"]);
  assert.ok(!observed.requirement_ids.includes("review-surfaces.HUMAN_REVIEW.18"));
  assert.doesNotMatch(observed.summary, /references exact requirement/);
});

test("review-surfaces.HUMAN_REVIEW.18 observed diff accepts sentence punctuation after exact ACIDs", () => {
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files = [
    {
      path: "docs/intent.md",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 1,
      deleted_lines: 0
    }
  ];
  prSurface.scope.affected_requirements = [
    {
      requirement_id: "REQ-HUMAN-1",
      acai_id: "review-surfaces.HUMAN_REVIEW.1",
      title: "Human surface starts with verdict",
      group_key: "HUMAN_REVIEW",
      reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "docs/intent.md" }]
    }
  ];
  prSurface.scope.out_of_scope_changed_files = [];
  prSurface.coverage.deltas = [];
  prSurface.risks.candidates = [];
  const diff = parseStructuredDiff([
    "diff --git a/docs/intent.md b/docs/intent.md",
    "--- a/docs/intent.md",
    "+++ b/docs/intent.md",
    "@@ -1,1 +1,2 @@",
    " # Intent",
    "+This now covers review-surfaces.HUMAN_REVIEW.18.",
    ""
  ].join("\n"));

  const model = buildHumanReview({ packet: packetFixture(), prSurface, diff });
  const observed = model.intent_mismatch.observed_in_diff.find((item) => item.paths.includes("docs/intent.md"));

  assert.ok(observed);
  assert.deepEqual(observed.requirement_ids, ["review-surfaces.HUMAN_REVIEW.18"]);
  assert.match(observed.summary, /references exact requirement/);
});

test("review-surfaces.HUMAN_REVIEW.18 observed diff includes deleted ACIDs in exact focus", () => {
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files = [
    {
      path: "tests/human-review.test.ts",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "test",
      added_lines: 0,
      deleted_lines: 1
    }
  ];
  prSurface.scope.affected_requirements = [
    {
      requirement_id: "REQ-HUMAN-1",
      acai_id: "review-surfaces.HUMAN_REVIEW.1",
      title: "Human surface starts with verdict",
      group_key: "HUMAN_REVIEW",
      reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "tests/human-review.test.ts" }]
    }
  ];
  prSurface.scope.out_of_scope_changed_files = [];
  prSurface.coverage.deltas = [];
  prSurface.risks.candidates = [];
  const diff = parseStructuredDiff([
    "diff --git a/tests/human-review.test.ts b/tests/human-review.test.ts",
    "--- a/tests/human-review.test.ts",
    "+++ b/tests/human-review.test.ts",
    "@@ -10,2 +10,1 @@",
    " test('intent') {",
    "-  const removed = 'review-surfaces.HUMAN_REVIEW.18';",
    ""
  ].join("\n"));

  const model = buildHumanReview({ packet: packetFixture(), prSurface, diff });
  const observed = model.intent_mismatch.observed_in_diff.find((item) => item.paths.includes("tests/human-review.test.ts"));

  assert.ok(observed);
  assert.deepEqual(observed.requirement_ids, ["review-surfaces.HUMAN_REVIEW.18"]);
  assert.match(observed.summary, /references exact requirement/);
});

test("review-surfaces.HUMAN_REVIEW.18 possible mismatches combine exact and scoped focus", () => {
  const packet = packetFixture();
  packet.intent.requirements.push({
    id: "REQ-HUMAN-18",
    acai_id: "review-surfaces.HUMAN_REVIEW.18",
    title: "Intent mismatch",
    requirement: "Render explicit intent mismatch buckets.",
    source_refs: [
      {
        kind: "spec",
        ref: "features/review-surfaces.feature.yaml",
        title: "review-surfaces.HUMAN_REVIEW.18",
        evidence: [fileEvidence("features/review-surfaces.feature.yaml", "Intent mismatch requirement.", "high")]
      }
    ],
    constraints: [],
    assumptions: [],
    open_questions: [],
    confidence: "high"
  });
  packet.evaluation.results.push({
    requirement_id: "REQ-HUMAN-18",
    acai_id: "review-surfaces.HUMAN_REVIEW.18",
    status: "missing",
    summary: "Intent mismatch output lacks removal coverage.",
    evidence: [fileEvidence("docs/intent.md", "Diff names the intent mismatch requirement.")],
    missing_evidence: [missingEvidence("No removal-focused intent mismatch test.")],
    review_focus: "Review exact intent mismatch coverage.",
    confidence: "medium"
  });
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files = [
    {
      path: "src/human/human-review.ts",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "implementation",
      added_lines: 2,
      deleted_lines: 0
    },
    {
      path: "docs/intent.md",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 1,
      deleted_lines: 0
    }
  ];
  prSurface.scope.affected_requirements = [
    {
      requirement_id: "REQ-HUMAN-1",
      acai_id: "review-surfaces.HUMAN_REVIEW.1",
      title: "Human surface starts with verdict",
      group_key: "HUMAN_REVIEW",
      reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "src/human/human-review.ts" }]
    }
  ];
  prSurface.scope.out_of_scope_changed_files = [];
  prSurface.coverage.deltas = [];
  prSurface.risks.candidates = [];
  const diff = parseStructuredDiff([
    "diff --git a/docs/intent.md b/docs/intent.md",
    "--- a/docs/intent.md",
    "+++ b/docs/intent.md",
    "@@ -1,1 +1,2 @@",
    " # Intent",
    "+review-surfaces.HUMAN_REVIEW.18 should cover removals.",
    ""
  ].join("\n"));

  const model = buildHumanReview({ packet, prSurface, diff });
  const mismatchRequirementIds = model.intent_mismatch.possible_mismatches.flatMap((item) => item.requirement_ids);

  assert.ok(mismatchRequirementIds.includes("review-surfaces.HUMAN_REVIEW.18"));
  assert.ok(mismatchRequirementIds.includes("review-surfaces.HUMAN_REVIEW.1"));
});

test("review-surfaces.HUMAN_REVIEW.18 possible mismatch cap keeps higher-severity scoped gaps before exact partials", () => {
  const packet = packetFixture();
  packet.evaluation.results = [
    {
      requirement_id: "REQ-HUMAN-18",
      acai_id: "review-surfaces.HUMAN_REVIEW.18",
      status: "partial",
      summary: "Exact intent mismatch requirement is only partial.",
      evidence: [fileEvidence("docs/intent.md", "Diff names the intent mismatch requirement.")],
      missing_evidence: [missingEvidence("No exact implementation evidence for intent mismatch.")],
      review_focus: "Review exact partial intent evidence.",
      confidence: "medium"
    },
    {
      requirement_id: "REQ-HUMAN-2",
      acai_id: "review-surfaces.HUMAN_REVIEW.2",
      status: "missing",
      summary: "Scoped verdict policy evidence is missing.",
      evidence: [fileEvidence("src/human/human-review.ts", "Changed human review builder.")],
      missing_evidence: [missingEvidence("No scoped verdict policy evidence.")],
      review_focus: "Review scoped missing intent evidence.",
      confidence: "medium"
    }
  ];
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files = [
    {
      path: "src/human/human-review.ts",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "implementation",
      added_lines: 2,
      deleted_lines: 0
    },
    {
      path: "docs/intent.md",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 1,
      deleted_lines: 0
    }
  ];
  prSurface.scope.affected_requirements = [
    {
      requirement_id: "REQ-HUMAN-2",
      acai_id: "review-surfaces.HUMAN_REVIEW.2",
      title: "Merge readiness policy",
      group_key: "HUMAN_REVIEW",
      reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "src/human/human-review.ts" }]
    }
  ];
  prSurface.scope.out_of_scope_changed_files = [];
  prSurface.coverage.deltas = [];
  prSurface.risks.candidates = [];
  const diff = parseStructuredDiff([
    "diff --git a/docs/intent.md b/docs/intent.md",
    "--- a/docs/intent.md",
    "+++ b/docs/intent.md",
    "@@ -1,1 +1,2 @@",
    " # Intent",
    "+review-surfaces.HUMAN_REVIEW.18 should cover removals.",
    ""
  ].join("\n"));

  const model = buildHumanReview({ packet, prSurface, diff });

  assert.equal(model.intent_mismatch.possible_mismatches[0].requirement_ids[0], "review-surfaces.HUMAN_REVIEW.2");
  assert.match(model.intent_mismatch.possible_mismatches[0].summary, /Missing implementation evidence/);
});

test("review-surfaces.HUMAN_REVIEW.18 exact nonblocking mismatches outrank broad scoped unknowns", () => {
  const packet = packetFixture();
  const providerAcid = ["review-surfaces", "PROVIDERS", "2"].join(".");
  packet.evaluation.results = [
    {
      requirement_id: "REQ-HUMAN-18",
      acai_id: "review-surfaces.HUMAN_REVIEW.18",
      status: "partial",
      summary: "Exact intent mismatch requirement is only partial.",
      evidence: [fileEvidence("docs/intent.md", "Diff names the intent mismatch requirement.")],
      missing_evidence: [missingEvidence("No exact implementation evidence for intent mismatch.")],
      review_focus: "Review exact partial intent evidence.",
      confidence: "medium"
    },
    {
      requirement_id: "REQ-PROVIDER-2",
      acai_id: providerAcid,
      status: "unknown",
      summary: "Broad provider requirement is ambiguous.",
      evidence: [fileEvidence("tests/pr-surface-e2e.test.ts", "Changed broad provider test.")],
      missing_evidence: [],
      review_focus: "Review broad provider ambiguity.",
      confidence: "unknown"
    }
  ];
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files = [
    {
      path: "docs/intent.md",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 1,
      deleted_lines: 0
    },
    {
      path: "tests/pr-surface-e2e.test.ts",
      status: "M",
      areas: ["PROVIDERS"],
      role: "test",
      added_lines: 1,
      deleted_lines: 0
    }
  ];
  prSurface.scope.affected_requirements = [
    {
      requirement_id: "REQ-PROVIDER-2",
      acai_id: providerAcid,
      title: "SARIF provider",
      group_key: "PROVIDERS",
      reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "tests/pr-surface-e2e.test.ts" }]
    }
  ];
  prSurface.scope.out_of_scope_changed_files = [];
  prSurface.coverage.deltas = [];
  prSurface.risks.candidates = [];
  const diff = parseStructuredDiff([
    "diff --git a/docs/intent.md b/docs/intent.md",
    "--- a/docs/intent.md",
    "+++ b/docs/intent.md",
    "@@ -1,1 +1,2 @@",
    " # Intent",
    "+review-surfaces.HUMAN_REVIEW.18 should cover removals.",
    ""
  ].join("\n"));

  const model = buildHumanReview({ packet, prSurface, diff });

  assert.equal(model.intent_mismatch.possible_mismatches[0].requirement_ids[0], "review-surfaces.HUMAN_REVIEW.18");
});

test("review-surfaces.HUMAN_REVIEW.18 observed source specs without exact ACIDs avoid broad path requirements", () => {
  const broadSpecAcid = ["review-surfaces", "BOOTSTRAP", "1"].join(".");
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files = [
    {
      path: "features/review-surfaces.feature.yaml",
      status: "M",
      areas: ["BOOTSTRAP"],
      role: "spec",
      added_lines: 2,
      deleted_lines: 0
    }
  ];
  prSurface.scope.affected_requirements = [
    {
      requirement_id: "REQ-BOOTSTRAP-1",
      acai_id: broadSpecAcid,
      title: "Bootstrap scaffold",
      group_key: "BOOTSTRAP",
      reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "features/review-surfaces.feature.yaml" }]
    }
  ];
  prSurface.scope.out_of_scope_changed_files = [];
  prSurface.coverage.deltas = [];
  prSurface.risks.candidates = [];
  const diff = parseStructuredDiff([
    "diff --git a/features/review-surfaces.feature.yaml b/features/review-surfaces.feature.yaml",
    "--- a/features/review-surfaces.feature.yaml",
    "+++ b/features/review-surfaces.feature.yaml",
    "@@ -250,2 +250,4 @@",
    "       18:",
    "+        note: Intent mismatch findings should stay source-backed.",
    ""
  ].join("\n"));

  const model = buildHumanReview({ packet: packetFixture(), prSurface, diff });
  const observed = model.intent_mismatch.observed_in_diff.find((item) => item.paths.includes("features/review-surfaces.feature.yaml"));

  assert.ok(observed);
  assert.deepEqual(observed.requirement_ids, []);
  assert.match(observed.summary, /source-of-truth spec intent/);
});

test("review-surfaces.HUMAN_REVIEW.18 missing intent skips generated and ignored out-of-scope files", () => {
  const prSurface = prSurfaceFixture();
  prSurface.scope.changed_files = [
    {
      path: "pnpm-lock.yaml",
      status: "M",
      areas: [],
      role: "generated",
      added_lines: 20,
      deleted_lines: 10
    },
    {
      path: "tmp/generated.txt",
      status: "M",
      areas: [],
      role: "generated",
      added_lines: 2,
      deleted_lines: 1
    },
    {
      path: "scripts/release.sh",
      status: "M",
      areas: [],
      role: "implementation",
      added_lines: 2,
      deleted_lines: 1
    }
  ];
  prSurface.scope.affected_areas = [];
  prSurface.scope.affected_requirements = [];
  prSurface.scope.out_of_scope_changed_files = [
    { path: "pnpm-lock.yaml", status: "M", reason: "generated" },
    { path: "tmp/generated.txt", status: "M", reason: "ignored" },
    { path: "scripts/release.sh", status: "M", reason: "unmapped" }
  ];
  prSurface.coverage.deltas = [];
  prSurface.risks.candidates = [];
  const model = buildHumanReview({ packet: packetFixture(), prSurface });

  assert.ok(model.intent_mismatch.missing_intent.some((item) => item.paths.includes("scripts/release.sh")));
  assert.ok(!model.intent_mismatch.missing_intent.some((item) => item.paths.includes("pnpm-lock.yaml")));
  assert.ok(!model.intent_mismatch.missing_intent.some((item) => item.paths.includes("tmp/generated.txt")));
});

test("review-surfaces.HUMAN_REVIEW.18 preserves an intent question under a tight question cap", () => {
  const prSurface = prSurfaceFixture();
  prSurface.risks.candidates = [];
  const model = buildHumanReview({
    packet: packetFixture(),
    prSurface,
    diff: structuredDiffFixture(),
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      max_questions: 2
    }
  });

  assert.equal(model.questions.length, 2);
  assert.ok(model.questions.some((question) => /intent gap/.test(question.question)));
});

test("review-surfaces.HUMAN_REVIEW.18 does not evict blocking questions for clarifying intent gaps", () => {
  const model = buildHumanReview({
    packet: packetFixture(),
    prSurface: prSurfaceFixture(),
    diff: structuredDiffFixture(),
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      max_questions: 1
    }
  });

  assert.equal(model.questions.length, 1);
  assert.equal(model.questions[0].severity, "blocking");
  assert.doesNotMatch(model.questions[0].question, /intent gap/);
});

test("since-last-review model turns packet comparison into reviewer-focused deltas", () => {
  const packet = packetFixture();
  packet.dogfood = {
    milestone: "M6",
    command: "review-surfaces all --previous-packet .review-surfaces-prev",
    summary: "comparison fixture",
    previous_packet_path: ".review-surfaces-prev/review_packet.json",
    comparison: {
      status_changes: [
        {
          acai_id: "review-surfaces.PROVIDERS.6",
          previous_status: "missing",
          current_status: "partial",
          direction: "improved"
        },
        {
          acai_id: "review-surfaces.SCHEMA.1",
          previous_status: "satisfied",
          current_status: "partial",
          direction: "regressed"
        }
      ],
      new_overreach: ["src/new-overreach.ts"],
      resolved_overreach: ["src/old-overreach.ts"],
      new_risks: ["security: Brand new risk"],
      resolved_risks: ["testing: Gone risk"],
      count_deltas: {
        satisfied: { before: 1, after: 0, delta: -1 },
        partial: { before: 0, after: 2, delta: 2 },
        missing: { before: 1, after: 0, delta: -1 },
        unknown: { before: 0, after: 0, delta: 0 },
        invalid_evidence: { before: 0, after: 0, delta: 0 }
      }
    },
    findings: []
  };
  packet.evaluation.results.push(
    {
      requirement_id: "REQ-PROVIDERS-6",
      acai_id: "review-surfaces.PROVIDERS.6",
      status: "partial",
      summary: "Provider secret boundary partially covered.",
      evidence: [fileEvidence(".github/workflows/review-surfaces-pr.yml", "Workflow fixture.")],
      missing_evidence: [missingEvidence("Manual check still required.")],
      review_focus: "Review CI secret boundary.",
      confidence: "medium"
    },
    {
      requirement_id: "REQ-SCHEMA-1",
      acai_id: "review-surfaces.SCHEMA.1",
      status: "partial",
      summary: "Schema compatibility fixture missing.",
      evidence: [fileEvidence("schemas/human_review.schema.json", "Schema changed.")],
      missing_evidence: [missingEvidence("Previous artifact fixture missing.")],
      review_focus: "Review schema compatibility.",
      confidence: "medium"
    }
  );
  packet.evaluation.overreach = [
    {
      requirement_id: "OVERREACH-001",
      status: "overreach",
      summary: "Still-open overreach",
      evidence: [fileEvidence("src/still-overreach.ts", "Overreach still present.")],
      missing_evidence: [],
      review_focus: "Review persistent overreach.",
      confidence: "medium"
    },
    {
      requirement_id: "OVERREACH-002",
      status: "overreach",
      summary: "New overreach",
      evidence: [fileEvidence("src/new-overreach.ts", "New overreach.")],
      missing_evidence: [],
      review_focus: "Review new overreach.",
      confidence: "medium"
    }
  ];
  packet.risks.items.push({
    id: "RISK-NEW",
    category: "security",
    severity: "high",
    summary: "Brand new risk",
    evidence: [fileEvidence("src/security.ts", "New risk evidence.")],
    suggested_checks: ["Review the new risk."]
  });

  const model = buildHumanReview({ packet, packetPath: ".review-surfaces/review_packet.json" });
  const since = model.since_last_review;

  assert.equal(since.previous_packet_path, ".review-surfaces-prev/review_packet.json");
  assert.equal(since.improved[0].acai_id, "review-surfaces.PROVIDERS.6");
  assert.equal(since.regressed[0].acai_id, "review-surfaces.SCHEMA.1");
  assert.equal(since.new_risks[0].summary, "New risk since last review: security: Brand new risk.");
  assert.equal(since.new_risks[0].severity, "high");
  assert.equal(since.resolved_risks[0].summary, "Resolved risk since last review: testing: Gone risk.");
  assert.equal(since.new_overreach[0].path, "src/new-overreach.ts");
  assert.equal(since.resolved_overreach[0].path, "src/old-overreach.ts");
  assert.ok(since.still_open.some((item) => item.summary.includes("review-surfaces.HUMAN_REVIEW.1 remains partial")));
  assert.ok(since.still_open.some((item) => item.summary.includes("testing: Human review has weak test evidence")));
  assert.ok(since.still_open.some((item) => item.path === "src/still-overreach.ts"));
  assert.ok([...since.improved, ...since.regressed, ...since.new_risks, ...since.still_open].every((item) => item.evidence.length > 0));

  const humanMarkdown = renderHumanReviewMarkdown(model);
  assert.match(humanMarkdown, /## Since last review/);
  assert.match(humanMarkdown, /1 improved requirement\(s\), 1 regressed requirement\(s\)/);

  const sinceMarkdown = renderSinceLastReviewMarkdown(model);
  assert.match(sinceMarkdown, /^# Since Last Review/);
  assert.match(sinceMarkdown, /## Improved/);
  assert.match(sinceMarkdown, /review-surfaces\.PROVIDERS\.6: missing -> partial/);
  assert.match(sinceMarkdown, /## Still open/);
  assert.match(sinceMarkdown, /src\/still-overreach\.ts/);

  const validation = validateJsonSchema(schema, model);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
});

test("since-last-review degrades cleanly when no previous packet was supplied", () => {
  const model = buildHumanReview({ packet: packetFixture() });

  assert.match(model.since_last_review.unavailable_reason ?? "", /No previous packet was supplied/);
  assert.deepEqual(model.since_last_review.improved, []);
  assert.match(renderHumanReviewMarkdown(model), /No previous packet was supplied/);
  assert.match(renderSinceLastReviewMarkdown(model), /No previous packet path recorded/);
});

test("review routes provide default human and secondary agent paths from shared evidence", () => {
  const model = buildHumanReview({ packet: packetFixture(), prSurface: prSurfaceFixture(), diff: structuredDiffFixture() });

  assert.equal(model.review_routes.length, 5);
  assert.equal(model.review_routes[0].persona, "human_reviewer");
  assert.equal(model.review_routes[0].is_default, true);
  assert.equal(model.review_routes[0].is_secondary, false);
  assert.equal(model.review_routes.filter((route) => route.is_default).length, 1);
  assert.equal(model.review_routes.find((route) => route.persona === "agent_continuation")?.is_secondary, true);
  assert.deepEqual(model.review_routes.map((route) => route.persona), [
    "human_reviewer",
    "maintainer",
    "security",
    "product",
    "agent_continuation"
  ]);
  assert.ok(model.review_routes.every((route) => route.steps.length > 0));
  assert.ok(model.review_routes.flatMap((route) => route.steps).every((step) => step.evidence.length > 0));
  assert.ok(model.review_routes.find((route) => route.persona === "human_reviewer")?.steps.some((step) => step.queue_item_ids.length > 0));
  assert.ok(model.review_routes.find((route) => route.persona === "maintainer")?.steps.some((step) => step.artifact === "risk_lenses.md"));
  assert.ok(model.review_routes.find((route) => route.persona === "security")?.steps.some((step) => step.risk_lens_ids.length > 0));
  assert.ok(model.review_routes.find((route) => route.persona === "product")?.steps.some((step) => step.artifact === "suggested_comments.md"));

  const markdown = renderReviewRoutesMarkdown(model);
  assert.match(markdown, /^# Review Routes/);
  assert.match(markdown, /## Human reviewer route/);
  assert.match(markdown, /Default: yes/);
  assert.match(markdown, /## Agent-continuation route/);
  assert.match(markdown, /Secondary: yes/);

  const validation = validateJsonSchema(schema, model);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
});

test("security review route degrades to skim guidance when no security signal fires", () => {
  const model = buildHumanReview({ packet: packetFixture() });
  const securityRoute = model.review_routes.find((route) => route.persona === "security");

  assert.ok(securityRoute);
  assert.equal(securityRoute.steps.find((step) => step.title === "Security and LLM trust-boundary lenses")?.priority, "low");
  assert.match(securityRoute.steps.find((step) => step.title === "Security and LLM trust-boundary lenses")?.action ?? "", /No security\/privacy/);
  assert.equal(securityRoute.steps.find((step) => step.title === "Manual security checks")?.priority, "low");
  assert.equal(securityRoute.steps.find((step) => step.title === "Privacy and trust audit gaps")?.priority, "low");
});

test("evidence cards separate direct, missing, and invalid evidence with reviewer actions", () => {
  const packet = packetFixture();
  packet.evaluation.results[0].status = "invalid_evidence";
  packet.evaluation.results[0].evidence.push({
    kind: "file",
    path: "src/invalid-evidence.ts",
    note: "Invalid evidence fixture.",
    confidence: "low",
    validation_status: "invalid"
  });
  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture(), diff: structuredDiffFixture() });

  const secretBoundaryCard = model.evidence_cards.find((card) => card.source_ids.includes("BLOCK-CI-SECRET-001"));
  assert.ok(secretBoundaryCard);
  assert.equal(secretBoundaryCard.priority, "high");
  assert.equal(secretBoundaryCard.status, "mixed");
  assert.ok(secretBoundaryCard.direct_evidence.some((ref) => ref.path === ".github/workflows/pr-review-comment.yml"));
  assert.ok(secretBoundaryCard.missing_evidence.length > 0, "CI secret-boundary card should show missing manual-check evidence");
  assert.equal(secretBoundaryCard.invalid_evidence.length, 0);
  assert.match(secretBoundaryCard.reviewer_action, /Record a manual check/);

  const invalidCard = model.evidence_cards.find((card) => card.invalid_evidence.length > 0);
  assert.ok(invalidCard);
  assert.ok(invalidCard.invalid_evidence.some((ref) => ref.path === "src/invalid-evidence.ts"));
  assert.ok(model.evidence_cards.some((card) => card.status === "unchecked"));
  assert.ok(model.evidence_cards.every((card) => card.direct_evidence.length + card.missing_evidence.length + card.invalid_evidence.length > 0));

  const markdown = renderEvidenceCardsMarkdown(model);
  assert.match(markdown, /^# Evidence Cards/);
  assert.match(markdown, /## Evidence Card:/);
  assert.match(markdown, /Direct:/);
  assert.match(markdown, /Missing:/);
  assert.match(markdown, /Invalid:/);
  assert.match(markdown, /Reviewer action:/);
  assert.doesNotMatch(markdown, /This human review JSON was generated before evidence-card support/);

  const validation = validateJsonSchema(schema, model);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
});

test("evidence cards preserve risk-lens priority when equal-severity lens cards are capped", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "src/llm/pr-narrative.ts",
      status: "M",
      areas: ["PROVIDERS"],
      role: "implementation",
      added_lines: 3,
      deleted_lines: 1
    },
    {
      path: "schemas/human_review.schema.json",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "spec",
      added_lines: 3,
      deleted_lines: 1
    }
  ];

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface });
  const llmIndex = model.evidence_cards.findIndex((card) => card.title === "LLM trust-boundary lens");
  const apiIndex = model.evidence_cards.findIndex((card) => card.title === "API / schema contract lens");

  assert.ok(llmIndex >= 0);
  assert.ok(apiIndex >= 0);
  assert.ok(llmIndex < apiIndex, "lower-ranked LLM trust-boundary lens should sort above API lens at equal severity");
});

test("human review Markdown renders a compact cockpit surface", () => {
  const model = buildHumanReview({ packet: packetFixture(), prSurface: prSurfaceFixture(), diff: structuredDiffFixture() });
  const markdown = renderHumanReviewMarkdown(model);

  assert.match(markdown, /^# Human Review/);
  assert.match(markdown, /## Verdict/);
  assert.match(markdown, /\*\*Block before merge\.\*\*/);
  assert.match(markdown, /## Review first/);
  assert.match(markdown, /## Review routes/);
  assert.match(markdown, /Human reviewer route \(default\)/);
  assert.match(markdown, /## Evidence cards/);
  assert.match(markdown, /\.github\/workflows\/pr-review-comment\.yml/);
  assert.match(markdown, /Hunk: `@@ -10,3 \+10,5 @@`/);
  assert.match(markdown, /## Since last review/);
  assert.match(markdown, /## Trust audit/);
  assert.match(markdown, /Claimed but not verified/);
  assert.match(markdown, /## Risk lenses/);
  assert.match(markdown, /Security \/ privacy lens/);
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
  // review-surfaces.HUMAN_REVIEW.21: the reason leads with the changed-file
  // behavior, not the bookkeeping "no deterministic PR risk candidate fired".
  assert.match(first.reason, /^Changed \w+ file in .*no risk rule fired/);
  assert.ok(changedImpl);
  assert.equal(changedImpl.title, "Changed implementation file");
  assert.equal(changedImpl.hunk_header, "@@ -220,2 +220,3 @@");
  assert.deepEqual(changedImpl.risk_ids, []);
  assert.ok(changedImpl.requirement_ids.includes("review-surfaces.HUMAN_REVIEW.1"));
  assert.ok(broadRiskIndex > changedImplIndex, "broad packet risk remains available below precise changed-file actions");
});

test("risk lenses fire from changed paths even when no PR risk candidate fires", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "src/llm/pr-narrative.ts",
      status: "M",
      areas: ["PROVIDERS"],
      role: "implementation",
      added_lines: 8,
      deleted_lines: 2
    },
    {
      path: "src/collector/artifact-provenance.ts",
      status: "M",
      areas: ["CACHE"],
      role: "implementation",
      added_lines: 6,
      deleted_lines: 1
    },
    {
      path: "src/cli/index.ts",
      status: "M",
      areas: ["CLI"],
      role: "implementation",
      added_lines: 4,
      deleted_lines: 1
    }
  ];

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface });
  const llmLens = model.risk_lens_findings.find((finding) => finding.lens === "llm_trust_boundary");
  const cacheLens = model.risk_lens_findings.find((finding) => finding.lens === "cache_provenance");
  const apiLens = model.risk_lens_findings.find((finding) => finding.lens === "api_contract");

  assert.ok(llmLens);
  assert.deepEqual(llmLens.risk_ids, []);
  assert.ok(llmLens.paths.includes("src/llm/pr-narrative.ts"));
  assert.ok(llmLens.suggested_tests.some((item) => item.suggested_file === "tests/pr-narrative.test.ts"));
  assert.ok(llmLens.suggested_comments.every((comment) => comment.evidence.length > 0));

  assert.ok(cacheLens);
  assert.ok(cacheLens.paths.includes("src/collector/artifact-provenance.ts"));
  assert.ok(cacheLens.suggested_tests.some((item) => item.suggested_file === "tests/artifact-provenance-input-hardening.test.ts"));

  assert.ok(apiLens);
  assert.ok(apiLens.paths.includes("src/cli/index.ts"));
  assert.match(apiLens.reviewer_action, /CLI, config, or feature-ledger contract/);
  assert.ok(apiLens.suggested_tests.some((item) => item.suggested_file === "tests/cli.test.ts"));
  assert.equal(apiLens.suggested_comments[0]?.severity, "clarifying");
  assert.match(apiLens.suggested_comments[0]?.body ?? "", /focused CLI, config, or feature-ledger test/);
  assert.doesNotMatch(apiLens.suggested_comments[0]?.body ?? "", /compatibility fixture/);

  assert.ok(model.questions.some((question) => /fabricated LLM paths/.test(question.question)));
  assert.ok(model.questions.some((question) => /focused CLI, config, or feature-ledger test/.test(question.question)));
  assert.ok(model.suggested_comments.some((comment) => /LLM trust-boundary lens/.test(comment.body)));
  assert.ok(model.test_plan.some((item) => item.maps_to_risks.length === 0 && item.suggested_file === "tests/pr-narrative.test.ts"));
});

test("review-surfaces.HUMAN_REVIEW.16 config caps reviewer-facing output and disables lens-derived actions", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files.push(
    {
      path: "src/llm/pr-narrative.ts",
      status: "M",
      areas: ["PROVIDERS"],
      role: "implementation",
      added_lines: 9,
      deleted_lines: 2
    },
    {
      path: "src/collector/artifact-provenance.ts",
      status: "M",
      areas: ["COLLECTOR"],
      role: "implementation",
      added_lines: 5,
      deleted_lines: 1
    }
  );

  const model = buildHumanReview({
    packet: packetFixture(),
    prSurface: surface,
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      max_review_first: 2,
      max_suggested_comments: 1,
      max_questions: 2,
      risk_lenses: {
        ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG.risk_lenses,
        api_contract: false,
        security_privacy: false,
        llm_trust_boundary: false
      }
    }
  });

  assert.equal(model.review_queue.length, 2);
  assert.ok(model.questions.length <= 2);
  assert.ok(model.suggested_comments.length <= 1);
  assert.equal(model.risk_lens_findings.some((finding) => finding.lens === "api_contract"), false);
  assert.equal(model.risk_lens_findings.some((finding) => finding.lens === "security_privacy"), false);
  assert.equal(model.risk_lens_findings.some((finding) => finding.lens === "llm_trust_boundary"), false);
  assert.equal(model.review_queue.some((item) => item.path === ".github/workflows/pr-review-comment.yml" || item.path === "schemas/human_review.schema.json"), true);
});

test("API contract lens suggests each focused CLI and config test for mixed contract paths", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "src/cli/index.ts",
      status: "M",
      areas: ["CLI"],
      role: "implementation",
      added_lines: 4,
      deleted_lines: 1
    },
    {
      path: "review-surfaces.config.yaml",
      status: "M",
      areas: ["BOOTSTRAP"],
      role: "config",
      added_lines: 1,
      deleted_lines: 0
    }
  ];

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface });
  const apiLens = model.risk_lens_findings.find((finding) => finding.lens === "api_contract");

  assert.ok(apiLens);
  assert.deepEqual(apiLens.suggested_tests.map((item) => item.suggested_file), ["tests/cli.test.ts", "tests/config.test.ts"]);
  assert.equal(apiLens.suggested_tests.every((item) => item.priority === "recommended"), true);
  assert.equal(apiLens.suggested_comments[0]?.severity, "clarifying");
  assert.match(model.questions.find((question) => question.evidence.some((ref) => ref.path === "review-surfaces.config.yaml"))?.question ?? "", /focused CLI, config, or feature-ledger test/);
});

test("API contract lens keeps TypeScript contract sources on compatibility checks", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "src/human/contract.ts",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "implementation",
      added_lines: 6,
      deleted_lines: 2
    }
  ];

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface });
  const apiLens = model.risk_lens_findings.find((finding) => finding.lens === "api_contract");

  assert.ok(apiLens);
  assert.match(apiLens.reviewer_action, /schema or artifact contract/);
  assert.deepEqual(apiLens.suggested_tests.map((item) => item.suggested_file), ["tests/schema-contract.test.ts"]);
  assert.equal(apiLens.suggested_tests[0]?.priority, "required");
  assert.equal(apiLens.suggested_comments[0]?.severity, "blocking");
  assert.match(apiLens.suggested_comments[0]?.body ?? "", /compatibility fixture/);
});

test("API contract lens keeps schema loader paths on compatibility checks", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "src/render/load.ts",
      status: "M",
      areas: ["PROVIDERS"],
      role: "implementation",
      added_lines: 5,
      deleted_lines: 1
    },
    {
      path: "src/schema/review-packet-contract.ts",
      status: "M",
      areas: ["EVIDENCE"],
      role: "implementation",
      added_lines: 2,
      deleted_lines: 1
    }
  ];

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface });
  const apiLens = model.risk_lens_findings.find((finding) => finding.lens === "api_contract");

  assert.ok(apiLens);
  assert.match(apiLens.reviewer_action, /schema or artifact contract/);
  assert.deepEqual(apiLens.suggested_tests.map((item) => item.suggested_file), ["tests/schema-contract.test.ts"]);
  assert.equal(apiLens.suggested_comments[0]?.severity, "blocking");
  assert.match(apiLens.suggested_comments[0]?.body ?? "", /compatibility fixture/);
});

test("review-surfaces.HUMAN_REVIEW.16 default config preserves the full queue beyond the markdown top seven", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = Array.from({ length: 10 }, (_, index) => ({
    path: `src/human/generated-${index}.ts`,
    status: "M" as const,
    areas: ["HUMAN_REVIEW"],
    role: "implementation" as const,
    added_lines: 2,
    deleted_lines: 1
  }));

  const model = buildHumanReview({
    packet: packetFixture(),
    prSurface: surface
  });

  assert.ok(model.review_queue.length > 7);
});

test("review-surfaces.HUMAN_REVIEW.17 required manual checks participate in the config signature", () => {
  assert.notEqual(
    humanReviewConfigSignature(DEFAULT_HUMAN_REVIEW_BUILD_CONFIG),
    humanReviewConfigSignature({
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      required_manual_checks: [
        {
          id: "docs_product_contract",
          path_patterns: ["docs/**"],
          prompt: "Confirm documentation changes do not alter product contract unexpectedly."
        }
      ]
    })
  );
});

test("review-surfaces.NARRATIVE.1 narrative_max_claims participates in the config signature", () => {
  // A config-only change to the narrative cap must bust the cache / trigger a
  // standalone rebuild so the requested cap is actually applied.
  assert.notEqual(
    humanReviewConfigSignature(DEFAULT_HUMAN_REVIEW_BUILD_CONFIG),
    humanReviewConfigSignature({ ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG, narrative_max_claims: 3 })
  );
});

test("risk lenses classify renamed source paths as review signals", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "src/provider-impl.ts",
      old_path: "src/llm/provider.ts",
      status: "R",
      areas: ["PROVIDERS"],
      role: "implementation",
      added_lines: 8,
      deleted_lines: 8
    },
    {
      path: "src/schema-output.ts",
      old_path: "schemas/legacy-review.json",
      status: "R",
      areas: ["HUMAN_REVIEW"],
      role: "implementation",
      added_lines: 4,
      deleted_lines: 4
    }
  ];

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface });
  const llmLens = model.risk_lens_findings.find((finding) => finding.lens === "llm_trust_boundary");
  const apiLens = model.risk_lens_findings.find((finding) => finding.lens === "api_contract");

  assert.ok(llmLens);
  assert.ok(llmLens.paths.includes("src/provider-impl.ts"));
  assert.ok(llmLens.paths.includes("src/llm/provider.ts"));
  assert.equal(llmLens.evidence[0]?.path, "src/provider-impl.ts");
  assert.match(llmLens.evidence[0]?.note ?? "", /renamed from src\/llm\/provider\.ts/);

  assert.ok(apiLens);
  assert.ok(apiLens.paths.includes("src/schema-output.ts"));
  assert.ok(apiLens.paths.includes("schemas/legacy-review.json"));
  assert.match(apiLens.reviewer_action, /compatibility fixture/);
  assert.equal(apiLens.suggested_comments[0]?.severity, "blocking");
  assert.match(apiLens.suggested_comments[0]?.body ?? "", /compatibility fixture/);
});

test("reviewer UX lens prefers renderer fixtures over schema fixtures", () => {
  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "schemas/human_review.schema.json",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "spec",
      added_lines: 4,
      deleted_lines: 1
    },
    {
      path: "src/human/render.ts",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "implementation",
      added_lines: 6,
      deleted_lines: 2
    }
  ];

  const model = buildHumanReview({ packet: packetFixture(), prSurface: surface });
  const uxLens = model.risk_lens_findings.find((finding) => finding.lens === "reviewer_ux");

  assert.ok(uxLens);
  assert.equal(uxLens.suggested_tests[0]?.suggested_file, "tests/human-review.test.ts");
  assert.equal(uxLens.suggested_comments[0]?.path, "src/human/render.ts");
  assert.ok(model.suggested_comments.some((comment) => comment.body.includes("reviewer UX lens") && comment.path === "src/human/render.ts"));
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

test("configured required manual checks block until current-head evidence records them", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  const config = {
    ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
    required_manual_checks: [
      {
        id: "docs_product_contract",
        path_patterns: ["docs/**"],
        prompt: "Confirm documentation changes do not alter product contract unexpectedly."
      }
    ]
  };

  const missing = buildHumanReview({
    packet,
    prSurface: surface,
    config
  });

  assert.equal(missing.feedback_effects.some((effect) => effect.kind === "team_policy" && effect.risk_ids.includes("config:docs_product_contract")), true);
  assert.equal(missing.blockers.some((blocker) => blocker.required_action.includes("Confirm documentation changes do not alter product contract unexpectedly.")), true);
  assert.equal(missing.questions.some((question) => question.maps_to_risks.includes("config:docs_product_contract")), true);
  assert.equal(missing.test_plan.some((item) => item.kind === "manual" && item.priority === "required" && item.maps_to_risks.includes("config:docs_product_contract")), true);

  packet.risks.test_evidence.push({
    id: "TEST-CONFIG-MANUAL-CHECK",
    kind: "indirect",
    summary: "Configured manual check recorded.",
    evidence: [
      feedbackEvidence(
        ".review-surfaces/feedback/manual-dogfood.yaml",
        "Manual check recorded: Confirm documentation changes do not alter product contract unexpectedly.",
        { sha: "abc123" }
      )
    ]
  });
  const recorded = buildHumanReview({
    packet,
    prSurface: surface,
    config
  });

  assert.equal(recorded.feedback_effects.some((effect) => effect.kind === "team_policy" && effect.action.startsWith("Manual check recorded:")), true);
  assert.equal(recorded.blockers.some((blocker) => blocker.required_action.includes("Confirm documentation changes do not alter product contract unexpectedly.")), false);
  assert.equal(recorded.test_plan.some((item) => item.maps_to_risks.includes("config:docs_product_contract")), false);
});

test("configured required manual checks match renamed source paths", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "docs/deploy-workflow.md",
      old_path: ".github/workflows/deploy.yml",
      status: "R",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 4,
      deleted_lines: 4
    }
  ];

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      required_manual_checks: [
        {
          id: "renamed_workflow_boundary",
          path_patterns: [".github/workflows/**"],
          prompt: "Confirm renamed workflow files preserve the CI secret boundary."
        }
      ]
    }
  });

  const effect = model.feedback_effects.find((item) => item.risk_ids.includes("config:renamed_workflow_boundary"));
  assert.ok(effect);
  assert.equal(effect.paths.includes("docs/deploy-workflow.md"), true);
  assert.equal(effect.paths.includes(".github/workflows/deploy.yml"), true);
  assert.equal(model.blockers.some((blocker) => blocker.required_action.includes("Confirm renamed workflow files preserve the CI secret boundary.")), true);
});

test("missing configured manual checks are not dropped by the feedback cap", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const recordedChecks = Array.from({ length: 12 }, (_, index) => ({
    id: `recorded_${String(index).padStart(2, "0")}`,
    path_patterns: ["docs/**"],
    prompt: `Verify dependency boundary remains isolated from untrusted code slot ${String(index).padStart(2, "0")}`
  }));
  for (const check of recordedChecks) {
    packet.risks.test_evidence.push({
      id: `TEST-${check.id.toUpperCase()}`,
      kind: "indirect",
      summary: "Configured manual check recorded.",
      evidence: [
        feedbackEvidence(
          ".review-surfaces/feedback/manual-dogfood.yaml",
          `Manual check recorded: ${check.prompt}`,
          { sha: "abc123" }
        )
      ]
    });
  }

  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "docs/notes.md",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 1,
      deleted_lines: 0
    }
  ];

  const missingPrompt = "Confirm documentation changes do not alter product contract unexpectedly.";
  const model = buildHumanReview({
    packet,
    prSurface: surface,
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      required_manual_checks: [
        ...recordedChecks,
        {
          id: "missing_docs_contract",
          path_patterns: ["docs/**"],
          prompt: missingPrompt
        }
      ]
    }
  });

  assert.ok(model.feedback_effects.length <= 12);
  assert.equal(model.feedback_effects.some((effect) => effect.risk_ids.includes("config:missing_docs_contract")), true);
  assert.equal(model.blockers.some((blocker) => blocker.required_action.includes(missingPrompt)), true);
  assert.equal(model.test_plan.some((item) => item.kind === "manual" && item.priority === "required" && item.maps_to_risks.includes("config:missing_docs_contract")), true);
});

test("missing configured manual checks fold before blocker and question caps", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "docs/notes.md",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 1,
      deleted_lines: 0
    }
  ];
  const missingChecks = Array.from({ length: 5 }, (_, index) => ({
    id: `missing_${String(index).padStart(2, "0")}`,
    path_patterns: ["docs/**"],
    prompt: `Confirm required manual check ${String(index).padStart(2, "0")} before approval.`
  }));

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      required_manual_checks: missingChecks
    }
  });

  assert.equal(model.feedback_effects.length, 3);
  assert.equal(model.feedback_effects[0].risk_ids.includes("config:missing_04"), true);
  assert.match(model.feedback_effects[0].summary, /additional configured manual check/);
  assert.equal(model.blockers.some((blocker) => blocker.required_action.includes("additional configured manual check")), true);
  assert.equal(model.questions.some((question) => question.maps_to_risks.includes("config:missing_04")), true);
  assert.equal(model.test_plan.some((item) => item.maps_to_risks.includes("config:missing_04")), true);
});

test("folded feedback team-policy checks preserve policy prompts", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "docs/notes.md",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 1,
      deleted_lines: 0
    }
  ];

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    feedback: [
      {
        path: ".review-surfaces/feedback/team.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "local",
        findings: [],
        validation: { passed: [], failed: [], notes: [] },
        false_positives: [],
        false_negatives: [],
        team_policy: Array.from({ length: 8 }, (_, index) => ({
          id: `POLICY-${String(index).padStart(2, "0")}`,
          path_pattern: "docs/**",
          required_manual_check: `Inspect docs policy ${String(index).padStart(2, "0")} before approval.`,
          evidence: [feedbackEvidence(".review-surfaces/feedback/team.yaml", `Policy ${index}.`, { eventId: `POLICY-${index}` })]
        })),
        reviewer_preferences: []
      }
    ]
  });

  const folded = model.feedback_effects[0];
  assert.ok(folded);
  assert.match(folded.summary, /feedback policy manual check/);
  assert.doesNotMatch(folded.action, /configured required manual check/);
  assert.match(folded.action, /policy:POLICY-02: Inspect docs policy 02 before approval/);
  assert.match(folded.action, /1 more policy ID\(s\): policy:POLICY-07/);
  assert.equal(model.blockers.some((blocker) => blocker.required_action.includes("Inspect docs policy 02 before approval.")), true);
  assert.equal(model.test_plan.some((item) => item.scenario.includes("Inspect docs policy 02 before approval.")), true);
});

test("missing configured manual checks stay bounded with more than twelve policies", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [];
  surface.scope.changed_files = [
    {
      path: "docs/notes.md",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 1,
      deleted_lines: 0
    }
  ];

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      required_manual_checks: Array.from({ length: 13 }, (_, index) => ({
        id: `wide_${String(index).padStart(2, "0")}`,
        path_patterns: ["docs/**"],
        prompt: `Confirm wide required manual check ${String(index).padStart(2, "0")} before approval.`
      }))
    }
  });

  assert.ok(model.feedback_effects.length <= 12);
  assert.equal(model.feedback_effects[0].risk_ids.includes("config:wide_12"), true);
});

test("configured required manual checks reserve required test-plan space", () => {
  const packet = packetFixture();
  packet.evaluation.results = Array.from({ length: 6 }, (_, index) => ({
    requirement_id: `REQ-HUMAN-CAP-${index}`,
    acai_id: `review-surfaces.HUMAN_REVIEW.CAP_${index}`,
    status: "missing" as const,
    summary: `Missing focused requirement ${index}.`,
    evidence: [fileEvidence(`src/human/cap-${index}.ts`, "Focused gap.")],
    missing_evidence: [missingEvidence("Needs direct test evidence.")],
    review_focus: "Add focused validation.",
    confidence: "medium" as const
  }));
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const requiredRules: PrRiskRule[] = [
    "coverage_regression",
    "untested_changed_impl",
    "privacy_sensitive_change",
    "ci_secret_boundary_change",
    "schema_contract_change",
    "failed_or_skipped_test"
  ];
  const surface = prSurfaceFixture();
  surface.scope.changed_files = [
    {
      path: "docs/notes.md",
      status: "M",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 1,
      deleted_lines: 0
    }
  ];
  surface.risks.candidates = requiredRules.map((rule, index) => ({
    ...prRiskFixture(rule),
    id: `PR-RISK-CAP-${index}`,
    evidence: [fileEvidence(`src/human/risk-${index}.ts`, "Required risk.")]
  }));

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      required_manual_checks: [
        {
          id: "docs_required_check",
          path_patterns: ["docs/**"],
          prompt: "Confirm documentation changes do not alter product contract unexpectedly."
        }
      ]
    }
  });

  assert.equal(model.test_plan.length, 12);
  assert.equal(model.test_plan[0].maps_to_risks.includes("config:docs_required_check"), true);
});

test("configured required manual checks clear from command transcript evidence", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];
  packet.risks.test_evidence.push({
    id: "TEST-CONFIG-MANUAL-CHECK-CMD",
    kind: "indirect",
    summary: "Configured manual check recorded through command transcript.",
    evidence: [
      commandEvidence(
        "manual-check --note 'Manual check recorded: Confirm documentation changes do not alter product contract unexpectedly.'",
        "Command transcript CMD-MANUAL-CHECK recorded exit_code=0 and status=passed.",
        "high",
        {
          path: ".review-surfaces/inputs/commands.json",
          sha: "abc123",
          eventId: "CMD-MANUAL-CHECK",
          validationStatus: "valid"
        }
      )
    ]
  });

  const surface = prSurfaceFixture();
  surface.risks.candidates = [];

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      required_manual_checks: [
        {
          id: "docs_product_contract",
          path_patterns: ["docs/**"],
          prompt: "Confirm documentation changes do not alter product contract unexpectedly."
        }
      ]
    }
  });

  assert.equal(model.feedback_effects.some((effect) => effect.kind === "team_policy" && effect.action.startsWith("Manual check recorded:")), true);
  assert.equal(model.blockers.some((blocker) => blocker.required_action.includes("Confirm documentation changes do not alter product contract unexpectedly.")), false);
});

test("configured required manual checks clear through analyzed current-head command transcripts", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];
  const collection = {
    changedFiles: [],
    feedback: [],
    commandTranscriptOutputPath: ".review-surfaces/inputs/commands.json",
    commandTranscripts: [
      {
        id: "CMD-MANUAL-CHECK-CURRENT-HEAD",
        command: "manual-check --note 'Manual check recorded: Confirm documentation changes do not alter product contract unexpectedly.'",
        status: "passed",
        exit_code: 0,
        head_sha: "abc123",
        truncated: false,
        source_path: ".review-surfaces/commands/manual.json"
      }
    ]
  } as unknown as CollectionResult;
  const emptyEvaluation: EvaluationModel = {
    summary: "no results",
    results: [],
    overreach: [],
    acai_coverage: {}
  };
  packet.risks.test_evidence = analyzeRisks(collection, emptyEvaluation, []).test_evidence;

  assert.equal(packet.risks.test_evidence[0].evidence?.[0].sha, "abc123");

  const surface = prSurfaceFixture();
  surface.risks.candidates = [];

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      required_manual_checks: [
        {
          id: "docs_product_contract",
          path_patterns: ["docs/**"],
          prompt: "Confirm documentation changes do not alter product contract unexpectedly."
        }
      ]
    }
  });

  assert.equal(model.feedback_effects.some((effect) => effect.kind === "team_policy" && effect.action.startsWith("Manual check recorded:")), true);
  assert.equal(model.blockers.some((blocker) => blocker.required_action.includes("Confirm documentation changes do not alter product contract unexpectedly.")), false);
});

test("configured required manual checks do not clear from failed command transcript evidence", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];
  packet.risks.test_evidence.push({
    id: "TEST-CONFIG-MANUAL-CHECK-CMD-FAILED",
    kind: "indirect",
    summary: "Configured manual check command transcript failed.",
    evidence: [
      commandEvidence(
        "manual-check --note 'Manual check recorded: Confirm documentation changes do not alter product contract unexpectedly.'",
        "Command transcript CMD-MANUAL-CHECK recorded exit_code=1 and status=failed.",
        "medium",
        {
          path: ".review-surfaces/inputs/commands.json",
          sha: "abc123",
          eventId: "CMD-MANUAL-CHECK",
          validationStatus: "valid"
        }
      )
    ]
  });

  const surface = prSurfaceFixture();
  surface.risks.candidates = [];

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      required_manual_checks: [
        {
          id: "docs_product_contract",
          path_patterns: ["docs/**"],
          prompt: "Confirm documentation changes do not alter product contract unexpectedly."
        }
      ]
    }
  });

  assert.equal(model.feedback_effects.some((effect) => effect.kind === "team_policy" && effect.action.startsWith("Manual check recorded:")), false);
  assert.equal(model.blockers.some((blocker) => blocker.required_action.includes("Confirm documentation changes do not alter product contract unexpectedly.")), true);
});

test("configured required manual checks do not clear from stale command transcript evidence", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];
  packet.risks.test_evidence.push({
    id: "TEST-CONFIG-MANUAL-CHECK-CMD-STALE",
    kind: "indirect",
    summary: "Configured manual check command transcript was recorded on an older head.",
    evidence: [
      commandEvidence(
        "manual-check --note 'Manual check recorded: Confirm documentation changes do not alter product contract unexpectedly.'",
        "Command transcript CMD-MANUAL-CHECK recorded exit_code=0 and status=passed.",
        "high",
        {
          path: ".review-surfaces/inputs/commands.json",
          sha: "old-head-sha",
          eventId: "CMD-MANUAL-CHECK",
          validationStatus: "valid"
        }
      )
    ]
  });

  const surface = prSurfaceFixture();
  surface.risks.candidates = [];

  const model = buildHumanReview({
    packet,
    prSurface: surface,
    config: {
      ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
      required_manual_checks: [
        {
          id: "docs_product_contract",
          path_patterns: ["docs/**"],
          prompt: "Confirm documentation changes do not alter product contract unexpectedly."
        }
      ]
    }
  });

  assert.equal(model.feedback_effects.some((effect) => effect.kind === "team_policy" && effect.action.startsWith("Manual check recorded:")), false);
  assert.equal(model.blockers.some((blocker) => blocker.required_action.includes("Confirm documentation changes do not alter product contract unexpectedly.")), true);
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

// review-surfaces.REVIEW_LOOP.2: the full loop — a reviewer marks a risk-backed
// queue item a false positive in the walkthrough; the written feedback, re-read by
// the pipeline on the next run, downgrades the matching finding with a visible
// feedback-effect note (and never deletes its evidence).
test("review-surfaces.REVIEW_LOOP.2 a walkthrough false-positive downgrades the matching finding on rerun", async () => {
  const packet = packetFixture();
  const surface = prSurfaceFixture();
  surface.risks.candidates = [{
    ...prRiskFixture("schema_contract_change"),
    id: "PR-RISK-WT",
    severity: "high",
    evidence: [fileEvidence("schemas/human_review.schema.json", "Hand-edited schema changed.")]
  }];

  // First pass: the review the reviewer walks through.
  const initial = buildHumanReview({ packet, prSurface: surface });
  const target = initial.review_queue.find((item) => item.risk_ids.includes("PR-RISK-WT"));
  assert.ok(target);
  assert.equal(target.reason.includes("Feedback memory downgraded"), false);

  // Walk the queue, marking the target a false positive (skip the rest).
  const answers = initial.review_queue.map((item) => (item.id === target.id ? "p" : "s"));
  let index = 0;
  const io = { interactive: true, write: () => undefined, prompt: async () => (index < answers.length ? answers[index++] : undefined) };
  // The handler resolves a PR-risk rule per item from the surface; mirror that so
  // the false positive is a scoped downgrade policy.
  const rulesForItem = (queued: typeof target) => (queued.risk_ids.includes("PR-RISK-WT") ? ["schema_contract_change"] : []);
  const result = await runWalkthrough(initial, undefined, io, { author: "tester", headSha: "h", packetPath: ".review-surfaces/review_packet.json", rulesForItem });
  assert.ok(result.feedback, "the false-positive decision produced a feedback record");

  // The written feedback, re-read by the pipeline, downgrades the finding on rerun.
  const feedback = normalizeFeedbackRecord(".review-surfaces/feedback/walkthrough.yaml", result.feedback);
  const rerun = buildHumanReview({ packet, prSurface: surface, feedback: [feedback] });
  const downgraded = rerun.review_queue.find((item) => item.risk_ids.includes("PR-RISK-WT"));
  assert.ok(downgraded, "the finding is retained, not deleted");
  assert.equal(downgraded.reason.includes("Feedback memory downgraded"), true, "the matching finding carries the visible feedback-effect note");
  assert.equal(rerun.feedback_effects.some((effect) => effect.kind === "false_positive" && effect.action === "downgrade_to_low"), true);
});

test("pathless false-positive feedback can match renamed source paths", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.scope.changed_files = [
    {
      path: "docs/generated-schema-notes.md",
      old_path: "schemas/generated.schema.json",
      status: "R",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 2,
      deleted_lines: 2
    }
  ];
  surface.risks.candidates = [{
    ...prRiskFixture("schema_contract_change"),
    id: "PR-RISK-PATHLESS-SCHEMA",
    severity: "medium",
    evidence: [missingEvidence("Pathless schema risk.")]
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
            evidence: [feedbackEvidence(".review-surfaces/feedback/memory.yaml", "Generated schema rename is noisy.", { eventId: "false_positive:rename" })]
          }
        ],
        false_negatives: [],
        team_policy: [],
        reviewer_preferences: []
      }
    ]
  });

  const effect = model.feedback_effects.find((item) => item.risk_ids.includes("PR-RISK-PATHLESS-SCHEMA"));
  assert.ok(effect);
  assert.equal(effect.paths.includes("docs/generated-schema-notes.md"), true);
  assert.equal(effect.paths.includes("schemas/generated.schema.json"), true);
});

test("false-negative desired rules check coverage per matched rename path", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.scope.changed_files = [
    {
      path: "docs/review-helper.ts",
      old_path: "src/review-helper.ts",
      status: "R",
      areas: ["HUMAN_REVIEW"],
      role: "doc",
      added_lines: 2,
      deleted_lines: 2
    }
  ];
  surface.risks.candidates = [{
    ...prRiskFixture("schema_contract_change"),
    id: "PR-RISK-DOC-SIDE",
    evidence: [fileEvidence("docs/review-helper.ts", "Desired rule covers only the renamed-to path.")]
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
        false_positives: [],
        false_negatives: [
          {
            description: "Source files moved out of src still need reviewer focus.",
            path_pattern: "src/**",
            desired_rule: "schema_contract_change",
            evidence: [feedbackEvidence(".review-surfaces/feedback/memory.yaml", "Rename old side false-negative policy.", { eventId: "false_negative:rename" })]
          }
        ],
        team_policy: [],
        reviewer_preferences: []
      }
    ]
  });

  const effect = model.feedback_effects.find((item) => item.kind === "false_negative");
  assert.ok(effect);
  assert.deepEqual(effect.paths, ["src/review-helper.ts"]);
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

test("false-positive feedback without a rule or path selector is skipped", () => {
  const packet = packetFixture();
  packet.evaluation.results = [];
  packet.evaluation.acai_coverage = {};
  packet.risks.items = [];
  packet.risks.missing_automatic_tests = [];
  packet.risks.missing_manual_checks = [];

  const surface = prSurfaceFixture();
  surface.risks.candidates = [{
    ...prRiskFixture("schema_contract_change"),
    id: "PR-RISK-NO-SELECTOR",
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
            action: "downgrade_to_low",
            evidence: [feedbackEvidence(".review-surfaces/feedback/memory.yaml", "Incomplete false-positive policy.", { eventId: "false_positive:1" })]
          }
        ],
        false_negatives: [],
        team_policy: [],
        reviewer_preferences: []
      }
    ]
  });

  const queueItem = model.review_queue.find((item) => item.risk_ids.includes("PR-RISK-NO-SELECTOR"));
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
  assert.deepEqual(schema.$defs.riskLensFinding.properties.lens.enum, [...RISK_LENSES]);
  assert.deepEqual(schema.$defs.reviewRoute.properties.persona.enum, [...REVIEW_ROUTE_PERSONAS]);
  assert.deepEqual(schema.$defs.evidenceCard.properties.status.enum, [...EVIDENCE_CARD_STATUSES]);
  assert.deepEqual(schema.$defs.evidenceCard.properties.priority.enum, [...HUMAN_REVIEW_PRIORITIES]);
  assert.deepEqual(schema.$defs.confidence.enum, [...PACKET_CONFIDENCE_LEVELS]);
  assert.deepEqual(schema.$defs.severity.enum, [...PACKET_SEVERITIES]);
  assert.deepEqual(schema.$defs.evidenceRef.properties.kind.enum, [...PACKET_EVIDENCE_KINDS]);
  assert.deepEqual(schema.$defs.evidenceRef.properties.validation_status.enum, [...PACKET_VALIDATION_STATUSES]);
});

test("review-surfaces.SCHEMA.3 rejects prior v1 artifacts without optional fields but the renderer still degrades", () => {
  const model = JSON.parse(JSON.stringify(buildHumanReview({ packet: packetFixture(), prSurface: prSurfaceFixture() }))) as Record<string, unknown>;
  delete model.feedback_effects;
  delete model.risk_lens_findings;
  delete model.review_routes;
  delete model.since_last_review;
  delete model.evidence_cards;

  // review-surfaces.SCHEMA.3: the strict schema rejects the partial artifact so
  // a stale human_review.json fails validation instead of degrading quietly...
  const result = validateJsonSchema(schema, model);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => /review_routes/.test(issue.message)));

  // ...while the RENDERER stays backward-compatible: an old artifact that bypassed
  // validation still renders with explicit "generated before X support" fallbacks.
  assert.match(renderHumanReviewMarkdown(model as unknown as ReturnType<typeof buildHumanReview>), /No domain risk lenses fired/);
  assert.match(renderHumanReviewMarkdown(model as unknown as ReturnType<typeof buildHumanReview>), /generated before review-route support/);
  assert.match(renderRiskLensesMarkdown(model as unknown as ReturnType<typeof buildHumanReview>), /No domain risk lenses fired/);
  assert.match(renderReviewRoutesMarkdown(model as unknown as ReturnType<typeof buildHumanReview>), /generated before review-route support/);
  assert.match(renderEvidenceCardsMarkdown(model as unknown as ReturnType<typeof buildHumanReview>), /generated before evidence-card support/);
  assert.match(renderSinceLastReviewMarkdown(model as unknown as ReturnType<typeof buildHumanReview>), /generated before since-last-review support/);
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

  // 11 rules now exceed the default max_suggested_comments cap (10); raise it so
  // the per-rule synthesis (not the cap) is what this test exercises.
  const model = buildHumanReview({ packet, prSurface: surface, config: { ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG, max_suggested_comments: PR_RISK_RULES.length + 2 } });
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

test("human trust audit ignores claimed artifact-generation commands but keeps claimed validation commands", () => {
  const packet = packetFixture();
  packet.methodology.claims_without_evidence = [];
  packet.risks.test_evidence = [
    {
      id: "TEST-CMD-001",
      kind: "claimed",
      summary: "Command invoked by this run context: review-surfaces all --review-scope pr --provider mock --dogfood",
      evidence: [commandEvidence("review-surfaces all --review-scope pr --provider mock --dogfood", "Artifact generation command.", "medium")]
    },
    {
      id: "TEST-CMD-002",
      kind: "claimed",
      summary: "Command invoked by this run context: pnpm run test:fast",
      evidence: [commandEvidence("pnpm run test:fast", "Validation command without captured output.", "medium")]
    },
    {
      id: "TEST-CLAIM-003",
      kind: "claimed",
      summary: "Skipped test result requires reviewer attention.",
      evidence: [testEvidence("tests/human-review.test.ts", "Skipped test result was parsed without command evidence.")]
    }
  ];

  const model = buildHumanReview({ packet, prSurface: prSurfaceFixture() });
  const claims = model.trust_audit.claimed_not_verified.map((claim) => claim.claim).join("\n");

  assert.doesNotMatch(claims, /review-surfaces all/);
  assert.match(claims, /pnpm run test:fast/);
  assert.match(claims, /Skipped test result/);
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
  const apiLens = model.risk_lens_findings.find((finding) => finding.lens === "api_contract");

  assert.doesNotMatch(verifiedSummaries, /PR-RISK-SCHEMA/);
  assert.match(invalidSummaries, /PR-RISK-SCHEMA: PR risk evidence is invalid or not deterministic/);
  assert.ok(apiLens);
  assert.equal(apiLens.confidence, "low");
  assert.equal(apiLens.suggested_comments.every((comment) => !comment.ready_to_post), true);
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
    },
    secret_in_diff: {
      id: "PR-RISK-SECRET",
      category: "security",
      severity: "critical",
      summary: "Added line(s) in src/server.ts match high-confidence secret pattern(s): github_token.",
      evidence: [fileEvidence("src/server.ts", "Added line matches secret pattern(s): github_token.")],
      suggested_checks: ["Remove the secret and rotate the credential."]
    }
  } satisfies Record<PrRiskRule, Omit<PrReviewSurfaceModel["risks"]["candidates"][number], "rule">>;

  return { rule, ...fixtures[rule] };
}
