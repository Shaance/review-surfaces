import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CollectionResult } from "../src/collector/collect";
import { indexFeedbackFiles } from "../src/feedback/feedback";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { createReviewAreaMatcher } from "../src/review-areas/areas";
import { analyzeRisks } from "../src/risks/risks";
import { buildDogfood } from "../src/dogfood/dogfood";
import { defaultReviewSurfacesAreas } from "./helpers/review-areas";

test("indexes local feedback files with findings and validation commands", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-feedback-"));
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "feedback"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "feedback", "manual.yaml"),
    `schema_version: review-surfaces.feedback.v1
author: codex
head_sha: feedback-head
packet_path: .review-surfaces/review_packet.json
findings:
  - id: FB-001
    category: evidence_quality
    severity: high
    affected_section: risks.test_evidence
    finding: review-surfaces.RISK.2 needs validation evidence, not only claimed commands.
    desired_change: Preserve local validation commands as feedback evidence.
validation:
  passed:
    - pnpm run test
    - pnpm run build
  failed:
    - pnpm run lint
  notes:
    - review-surfaces.DOGFOOD.6 feedback was collected manually.
`
  );

  const feedback = await indexFeedbackFiles(tmp, [".review-surfaces/feedback/manual.yaml"]);

  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].findings[0].id, "FB-001");
  assert.equal(feedback[0].findings[0].category, "evidence_quality");
  assert.equal(feedback[0].findings[0].evidence[0].kind, "feedback");
  assert.equal(feedback[0].head_sha, "feedback-head");
  assert.deepEqual(feedback[0].validation.passed, ["pnpm run test", "pnpm run build"]);
  assert.deepEqual(feedback[0].validation.failed, ["pnpm run lint"]);
});

test("indexes reviewer feedback memory policies from local feedback files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-feedback-memory-"));
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "feedback"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "feedback", "memory.yaml"),
    `schema_version: review-surfaces.feedback.v1
reviewer: local
created_at: 2026-06-08T00:00:00.000Z
false_positives:
  - rule: large_diff
    path_pattern: pnpm-lock.yaml
    condition: lockfile_only
    action: downgrade_to_low
false_negatives:
  - description: Schema changes should always ask for compatibility tests.
    path_pattern: schemas/**/*.json
    desired_rule: schema_contract_change
team_policy:
  - id: POLICY-CI-SECRET-001
    trigger:
      path_pattern: .github/workflows/*.yml
    required_manual_check: Confirm PR-controlled code cannot access secrets.
reviewer_preferences:
  - always_prioritize:
      - docs/review-surfaces-trd.md
  - max_top_review_items: 7
`
  );

  const feedback = await indexFeedbackFiles(tmp, [".review-surfaces/feedback/memory.yaml"]);

  assert.equal(feedback[0].author, "local");
  assert.equal(feedback[0].false_positives[0]?.rule, "large_diff");
  assert.equal(feedback[0].false_positives[0]?.path_pattern, "pnpm-lock.yaml");
  assert.equal(feedback[0].false_negatives[0]?.desired_rule, "schema_contract_change");
  assert.equal(feedback[0].team_policy[0]?.id, "POLICY-CI-SECRET-001");
  assert.equal(feedback[0].team_policy[0]?.path_pattern, ".github/workflows/*.yml");
  assert.equal(feedback[0].reviewer_preferences[0]?.key, "always_prioritize");
  assert.deepEqual(feedback[0].reviewer_preferences[0]?.value, ["docs/review-surfaces-trd.md"]);
  assert.equal(feedback[0].reviewer_preferences[1]?.key, "max_top_review_items");
});

test("risk analysis maps feedback validation passed commands to claimed and failed to missing test evidence", () => {
  const collection = {
    changedFiles: [],
    feedback: [
      {
        path: ".review-surfaces/feedback/manual.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "codex",
        head_sha: "head123",
        findings: [],
        validation: {
          passed: ["pnpm run test", "pnpm run build"],
          failed: ["pnpm run lint"],
          notes: []
        }
      }
    ]
  } as unknown as CollectionResult;
  const evaluation: EvaluationModel = {
    summary: "no results",
    results: [],
    overreach: [],
    acai_coverage: {}
  };

  const risks = analyzeRisks(collection, evaluation, []);

  assert.equal(risks.test_evidence.length, 3);
  // review-surfaces.EVIDENCE.8: a feedback-recorded passed command is a CLAIM
  // (its output is not captured), so both passed commands classify as "claimed",
  // never "indirect" (which would promote them into Verified facts). The failed
  // command stays "missing". Manual-check notes remain "indirect" (separate test).
  assert.equal(risks.test_evidence[0].kind, "claimed");
  assert.equal(risks.test_evidence[1].kind, "claimed");
  assert.equal(risks.test_evidence[2].kind, "missing");
  assert.equal(risks.test_evidence[0].evidence?.[0].path, ".review-surfaces/feedback/manual.yaml");
});

test("risk analysis maps manual CI secret-boundary feedback notes to indirect evidence", () => {
  const collection = {
    changedFiles: [],
    feedback: [
      {
        path: ".review-surfaces/feedback/manual.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "codex",
        head_sha: "head123",
        findings: [],
        validation: {
          passed: [],
          failed: [],
          notes: [
            "Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets.",
            "This slice requires an explicit recorded conclusion that PR-controlled code cannot access secrets before clearing the CI secret-boundary blocker.",
            "Policy requires a manual CI secret-boundary check recorded: PR-controlled code cannot access secrets.",
            "Manual CI secret-boundary check recorded: unable to confirm PR-controlled code cannot access secrets.",
            "Manual workflow security review recorded."
          ]
        }
      },
      {
        path: ".review-surfaces/feedback/stale.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "codex",
        head_sha: "oldhead",
        findings: [],
        validation: {
          passed: [],
          failed: [],
          notes: ["Manual CI secret-boundary check recorded: PR-controlled code cannot access secrets."]
        }
      }
    ]
  } as unknown as CollectionResult;
  collection.git = { head_sha: "head123" } as CollectionResult["git"];
  const evaluation: EvaluationModel = {
    summary: "no results",
    results: [],
    overreach: [],
    acai_coverage: {}
  };

  const risks = analyzeRisks(collection, evaluation, []);

  assert.equal(risks.test_evidence.length, 1);
  assert.equal(risks.test_evidence[0].kind, "indirect");
  assert.match(risks.test_evidence[0].summary, /manual CI secret-boundary check/);
  assert.equal(risks.test_evidence[0].evidence?.[0].path, ".review-surfaces/feedback/manual.yaml");
  assert.equal(risks.test_evidence[0].evidence?.[0].sha, "head123");
  assert.match(risks.test_evidence[0].evidence?.[0].note ?? "", /PR-controlled code cannot access secrets/);
});

test("feedback ingestion files map to the dogfood Acai review area", async () => {
  const areas = await defaultReviewSurfacesAreas();
  const matcher = createReviewAreaMatcher(areas);
  assert.ok(matcher.groupsForPath("src/feedback/feedback.ts", { purpose: "review_surface" }).includes("DOGFOOD"));
  assert.ok(matcher.groupsForPath("tests/feedback.test.ts", { purpose: "review_surface" }).includes("DOGFOOD"));
});

test("review-surfaces.DOGFOOD.4 surfaces latest feedback findings in dogfood output", () => {
  const collection = {
    manifest: { milestone: "M4" },
    feedback: [
      {
        path: ".review-surfaces/feedback/manual.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "codex",
        findings: Array.from({ length: 10 }, (_, index) => ({
          id: `FB-${String(index + 1).padStart(3, "0")}`,
          category: "diagram_quality" as const,
          severity: "low" as const,
          affected_section: "Architecture surfaces",
          finding: `Finding ${index + 1}`,
          desired_change: `Change ${index + 1}`,
          evidence: []
        })),
        validation: { passed: [], failed: [], notes: [] }
      }
    ]
  } as unknown as CollectionResult;
  const evaluation: EvaluationModel = {
    summary: "no results",
    results: [],
    overreach: [],
    acai_coverage: {}
  };
  const risks = { items: [], test_gaps: [], review_focus: [], summary: "no risks", test_evidence: [] };
  const methodology = {
    summary: "no logs",
    missing_logs: true,
    considered: [],
    research: [],
    decisions: [],
    unchallenged_assumptions: [],
    skipped_checks: [],
    claims_without_evidence: [],
    verified_claims: [],
    workflow_findings: [],
    quality_flags: [],
    evidence: []
  };

  const dogfood = buildDogfood(collection, evaluation, risks, methodology, "mock", []);

  assert.ok(dogfood.findings.some((finding) => finding.finding.includes("FB-010")));
  assert.ok(!dogfood.findings.some((finding) => finding.finding.includes("FB-001")));
  assert.ok(dogfood.remediation_tasks?.some((task) => task.description === "Change 10"));
});

test("review-surfaces.DOGFOOD.4 keeps latest feedback across files with duplicate local ids", () => {
  const collection = {
    manifest: { milestone: "M4" },
    feedback: Array.from({ length: 10 }, (_, index) => ({
      path: `.review-surfaces/feedback/${String(index + 1).padStart(2, "0")}.yaml`,
      schema_version: "review-surfaces.feedback.v1",
      author: "codex",
      findings: [
        {
          id: "FB-001",
          category: "diagram_quality" as const,
          severity: "low" as const,
          affected_section: "Architecture surfaces",
          finding: `Finding file ${index + 1}`,
          desired_change: `Change file ${index + 1}`,
          evidence: []
        }
      ],
      validation: { passed: [], failed: [], notes: [] }
    }))
  } as unknown as CollectionResult;
  const evaluation: EvaluationModel = {
    summary: "no results",
    results: [],
    overreach: [],
    acai_coverage: {}
  };
  const risks = { items: [], test_gaps: [], review_focus: [], summary: "no risks", test_evidence: [] };
  const methodology = {
    summary: "no logs",
    missing_logs: true,
    considered: [],
    research: [],
    decisions: [],
    unchallenged_assumptions: [],
    skipped_checks: [],
    claims_without_evidence: [],
    verified_claims: [],
    workflow_findings: [],
    quality_flags: [],
    evidence: []
  };

  const dogfood = buildDogfood(collection, evaluation, risks, methodology, "mock", []);

  assert.ok(dogfood.findings.some((finding) => finding.finding.includes("Finding file 10")));
  assert.ok(dogfood.findings.some((finding) => finding.finding.includes("Finding file 3")));
  assert.ok(!dogfood.findings.some((finding) => /Finding file 1\b/.test(finding.finding)));
  assert.ok(!dogfood.findings.some((finding) => /Finding file 2\b/.test(finding.finding)));
});

test("review-surfaces.DOGFOOD.4 sorts feedback by created_at before selecting latest findings", () => {
  const olderFiles = Array.from({ length: 8 }, (_, index) => ({
    path: `.review-surfaces/feedback/zz-old-${index + 1}.yaml`,
    schema_version: "review-surfaces.feedback.v1",
    author: "codex",
    created_at: `2026-05-27T0${index}:00:00.000Z`,
    findings: [
      {
        id: `FB-OLD-${index + 1}`,
        category: "diagram_quality" as const,
        severity: "low" as const,
        affected_section: "Architecture surfaces",
        finding: `Older path-sorted finding ${index + 1}`,
        desired_change: `Older path-sorted change ${index + 1}`,
        evidence: []
      }
    ],
    validation: { passed: [], failed: [], notes: [] }
  }));
  const collection = {
    manifest: { milestone: "M4" },
    feedback: [
      {
        path: ".review-surfaces/feedback/manual.yaml",
        schema_version: "review-surfaces.feedback.v1",
        author: "codex",
        created_at: "2026-05-28T12:00:00.000Z",
        findings: [
          {
            id: "FB-NEW",
            category: "diagram_quality" as const,
            severity: "medium" as const,
            affected_section: "Architecture surfaces",
            finding: "Newer manually named feedback",
            desired_change: "Change newer manual feedback",
            evidence: []
          }
        ],
        validation: { passed: [], failed: [], notes: [] }
      },
      ...olderFiles
    ]
  } as unknown as CollectionResult;
  const evaluation: EvaluationModel = {
    summary: "no results",
    results: [],
    overreach: [],
    acai_coverage: {}
  };
  const risks = { items: [], test_gaps: [], review_focus: [], summary: "no risks", test_evidence: [] };
  const methodology = {
    summary: "no logs",
    missing_logs: true,
    considered: [],
    research: [],
    decisions: [],
    unchallenged_assumptions: [],
    skipped_checks: [],
    claims_without_evidence: [],
    verified_claims: [],
    workflow_findings: [],
    quality_flags: [],
    evidence: []
  };

  const dogfood = buildDogfood(collection, evaluation, risks, methodology, "mock", []);

  assert.ok(dogfood.findings.some((finding) => finding.finding.includes("FB-NEW")));
  assert.ok(!dogfood.findings.some((finding) => finding.finding.includes("FB-OLD-1")));
  assert.ok(dogfood.remediation_tasks?.some((task) => task.description === "Change newer manual feedback"));
});
