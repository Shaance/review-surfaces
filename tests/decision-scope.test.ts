import test from "node:test";
import assert from "node:assert/strict";
import { fileEvidence, missingEvidence } from "../src/evidence/evidence";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { buildHumanReview } from "../src/human/human-review";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { renderHumanReviewMarkdown } from "../src/human/render";
import { renderStickySummary } from "../src/render/sticky-summary";
import type { SemanticChangeFacts } from "../src/risks/semantic-diff";
import { decisionPacket as packet, decisionRisk as risk, decisionSurface as surface, emptyDecisionSemanticFacts as emptySemanticFacts, requirement } from "./helpers/decision-projection";

test("review-surfaces.REVIEWER_VALUE.5 unrelated repository totals cannot change the PR decision", () => {
  const basePacket = packet();
  const pr = surface(["src/reviewer.ts"]);
  const before = buildHumanReview({ packet: basePacket, prSurface: pr });

  const noisy = structuredClone(basePacket);
  noisy.intent.requirements.push(...Array.from({ length: 145 }, (_, index) => requirement(`UNRELATED-${index}`)));
  noisy.evaluation.results.push(...Array.from({ length: 145 }, (_, index) => ({
    requirement_id: `UNRELATED-${index}`,
    status: "partial" as const,
    summary: "Unrelated repository requirement is partial.",
    evidence: [fileEvidence(`src/unrelated/${index}.ts`, "Outside the reviewed range.")],
    missing_evidence: [missingEvidence("Repository-wide evidence is incomplete.")],
    review_focus: "Supporting compliance only.",
    confidence: "medium" as const
  })));
  noisy.risks.items.push({
    id: "RISK-001",
    category: "testing",
    severity: "high",
    summary: "145 repository requirements are partial.",
    evidence: [
      fileEvidence("src/unrelated/0.ts", "Outside the reviewed range."),
      fileEvidence("src/reviewer.ts", "A bounded aggregate sample happens to touch the reviewed range.")
    ],
    suggested_checks: ["Review the repository ledger."],
    manual_review: true
  });
  noisy.methodology.claims_without_evidence.push("All 145 repository requirements were checked.");

  const after = buildHumanReview({ packet: noisy, prSurface: pr });
  assert.deepEqual(after.verdict, before.verdict);
  assert.deepEqual(after.decision_projection?.findings, before.decision_projection?.findings);

  const repoDiff = parseStructuredDiff([
    "diff --git a/src/reviewer.ts b/src/reviewer.ts",
    "--- a/src/reviewer.ts",
    "+++ b/src/reviewer.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n"));
  assert.deepEqual(
    buildHumanReview({ packet: noisy, diff: repoDiff }).verdict,
    buildHumanReview({ packet: basePacket, diff: repoDiff }).verdict,
    "repo-mode review of a range must not re-admit whole-repository aggregates"
  );
});

test("review-surfaces.REVIEWER_VALUE.5 an exhaustive aggregate stays supporting even when its sample cites an affected requirement", () => {
  const value = packet();
  value.risks.items.push({
    id: "RISK-001",
    category: "testing",
    severity: "high",
    summary: "The affected reviewer requirement remains partial.",
    evidence: [{
      ...fileEvidence("src/reviewer.ts", "The aggregate explicitly cites the affected range requirement."),
      acai_id: "review-surfaces.REVIEWER_VALUE.4"
    }],
    suggested_checks: ["Review the affected requirement evidence."],
    manual_review: true
  });
  value.risks.items.push({
    id: "RISK-CONCRETE-REVIEWER",
    category: "correctness",
    severity: "high",
    summary: "The changed reviewer behavior has a concrete unresolved defect.",
    evidence: [{
      ...fileEvidence("src/reviewer.ts", "A scoped detector proves the changed behavior."),
      acai_id: "review-surfaces.REVIEWER_VALUE.4"
    }],
    suggested_checks: ["Fix the scoped reviewer behavior."],
    manual_review: true
  });

  const model = buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"]) });
  assert.equal(model.verdict.decision, "reviewable_with_attention");
  assert.ok(!model.decision_projection?.findings.some((finding) => finding.risk_ids.includes("RISK-001")));
  assert.ok(model.decision_projection?.findings.some((finding) =>
    finding.root_cause === "packet_risk:correctness:src/reviewer.ts" &&
    finding.risk_ids.includes("RISK-CONCRETE-REVIEWER")
  ));
});

test("review-surfaces.REVIEWER_VALUE.5 stale-head failed validation cannot block the current PR", () => {
  const stale = packet();
  stale.risks.test_evidence = [{
    id: "TEST-FAILED",
    kind: "missing",
    summary: "Validation failed with exit 1.",
    evidence: [{ kind: "command", command: "pnpm test", sha: "old-head", confidence: "high", validation_status: "invalid" }]
  }];
  const staleModel = buildHumanReview({ packet: stale, prSurface: surface(["src/reviewer.ts"]) });
  assert.ok(!staleModel.blockers.some((blocker) => blocker.id === "BLOCK-TESTS-001"));
  assert.ok(!staleModel.decision_projection?.findings.some((finding) => finding.root_cause === "test_integrity"));

  stale.risks.test_evidence[0].evidence = [{ kind: "command", command: "pnpm test", sha: "head", confidence: "high", validation_status: "invalid" }];
  const currentModel = buildHumanReview({ packet: stale, prSurface: surface(["src/reviewer.ts"]) });
  assert.ok(currentModel.blockers.some((blocker) => blocker.id === "BLOCK-TESTS-001"));
  assert.equal(currentModel.decision_projection?.findings.filter((finding) => finding.root_cause === "test_integrity").length, 1);
});

test("review-surfaces.REVIEWER_VALUE.5 unpinned failed validation cannot block the current head", () => {
  const value = packet();
  value.risks.test_evidence = [{
    id: "TEST-FAILED",
    kind: "missing",
    summary: "Validation failed with exit 1.",
    evidence: [{ kind: "command", command: "pnpm test", confidence: "high", validation_status: "invalid" }]
  }];
  const model = buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"]) });
  assert.ok(!model.blockers.some((blocker) => blocker.id === "BLOCK-TESTS-001"));
  assert.ok(!model.decision_projection?.findings.some((finding) => finding.root_cause === "test_integrity"));
});

test("review-surfaces.REVIEWER_VALUE.5 validation state is classified from current validation refs only", () => {
  const value = packet();
  const currentPass = { kind: "command" as const, command: "pnpm test", sha: "head", confidence: "high" as const, validation_status: "valid" as const };
  value.risks.test_evidence = [{
    id: "TEST-MIXED",
    kind: "missing",
    summary: "Validation failed with exit 1.",
    evidence: [
      { kind: "command", command: "pnpm test", sha: "old-head", confidence: "high", validation_status: "invalid" },
      currentPass
    ]
  }];
  const pr = surface(["src/reviewer.ts"]);
  const failed = buildHumanReview({ packet: value, prSurface: pr });
  assert.ok(!failed.blockers.some((blocker) => blocker.id === "BLOCK-TESTS-001"));
  assert.ok(!failed.decision_projection?.findings.some((finding) => finding.root_cause === "test_integrity"));

  value.risks.test_evidence[0].summary = "Validation skipped because the integration service was unavailable.";
  const skipped = buildHumanReview({ packet: value, prSurface: pr });
  assert.ok(!skipped.decision_projection?.findings.some((finding) => finding.root_cause === "test_integrity"));

  value.risks.test_evidence[0] = {
    id: "TEST-FILE-ONLY",
    kind: "missing",
    summary: "Validation failed with exit 1.",
    evidence: [{ kind: "file", path: "src/reviewer.ts", sha: "head", confidence: "high", validation_status: "invalid" }]
  };
  const fileOnly = buildHumanReview({ packet: value, prSurface: pr });
  assert.ok(!fileOnly.blockers.some((blocker) => blocker.id === "BLOCK-TESTS-001"));
  assert.ok(!fileOnly.decision_projection?.findings.some((finding) => finding.root_cause === "test_integrity"));
});

test("review-surfaces.REVIEWER_VALUE.5 current-head skipped validation becomes a decision finding", () => {
  const value = packet();
  value.risks.test_evidence = [{
    id: "TEST-SKIPPED",
    kind: "missing",
    summary: "Validation skipped because the integration service was unavailable.",
    evidence: [{ kind: "command", command: "pnpm test:integration", sha: "old-head", confidence: "high", validation_status: "not_checked" }]
  }];
  const staleModel = buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"]) });
  assert.ok(!staleModel.decision_projection?.findings.some((finding) => finding.root_cause === "test_integrity"));
  value.risks.test_evidence[0].evidence![0].sha = "head";
  const model = buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"]) });
  const findings = model.decision_projection?.findings.filter((finding) => finding.root_cause === "test_integrity") ?? [];
  assert.equal(findings.length, 1);
  assert.match(findings[0].reviewer_action, /Run the skipped validation/);
});

test("review-surfaces.REVIEWER_VALUE.5 validation classification ignores passing zero-count prose", () => {
  const value = packet();
  value.risks.test_evidence[0].summary = "Suite passed: 0 failed, 0 skipped.";
  const model = buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"]) });
  assert.equal(model.verdict.decision, "probably_safe");
  assert.ok(!model.decision_projection?.findings.some((finding) => finding.root_cause === "test_integrity"));
});

test("review-surfaces.REVIEWER_VALUE.6 failed validation manifestations share one decision slot", () => {
  const value = packet();
  value.risks.test_evidence = [{
    id: "TEST-FAILED",
    kind: "missing",
    summary: "Validation failed with exit 1.",
    evidence: [{ kind: "command", command: "pnpm test", sha: "head", confidence: "high", validation_status: "invalid" }]
  }];
  const model = buildHumanReview({
    packet: value,
    prSurface: surface(["tests/integration.test.ts"], [risk("PR-RISK-FAILED", "failed_or_skipped_test", "tests/integration.test.ts")])
  });
  assert.equal(model.decision_projection?.findings.filter((finding) => finding.root_cause === "test_integrity").length, 1);
});

test("review-surfaces.REVIEWER_VALUE.5 positive validation must be pinned to the current head", () => {
  const value = packet();
  value.risks.test_evidence[0].evidence![0].sha = "old-head";
  assert.notEqual(buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"]) }).verdict.decision, "probably_safe");
  value.risks.test_evidence[0].evidence![0].sha = "head";
  assert.equal(buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"]) }).verdict.decision, "probably_safe");
  value.risks.test_evidence[0].evidence = [{ kind: "file", path: "src/reviewer.ts", sha: "head", confidence: "high", validation_status: "valid" }];
  assert.notEqual(buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"]) }).verdict.decision, "probably_safe");
});

test("review-surfaces.REVIEWER_VALUE.5 commit-pinned validation stays supporting for a dirty worktree", () => {
  const value = packet();
  value.manifest.uncommitted_files = 1;
  assert.notEqual(buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"]) }).verdict.decision, "probably_safe");
  value.risks.test_evidence = [{
    id: "TEST-FAILED",
    kind: "missing",
    summary: "Validation failed with exit 1.",
    evidence: [{ kind: "command", command: "pnpm test", sha: "head", confidence: "high", validation_status: "invalid" }]
  }];
  const failed = buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"]) });
  assert.ok(!failed.blockers.some((blocker) => blocker.id === "BLOCK-TESTS-001"));
  assert.ok(!failed.decision_projection?.findings.some((finding) => finding.root_cause === "test_integrity"));

  const omitted = packet();
  omitted.manifest.uncommitted_files = 0;
  omitted.manifest.omitted_untracked_files = 1;
  const omittedModel = buildHumanReview({ packet: omitted, prSurface: surface(["src/reviewer.ts"]) });
  assert.notEqual(omittedModel.verdict.decision, "probably_safe");
  for (const rendered of [
    renderHumanReviewMarkdown(omittedModel),
    renderHumanReviewHtml(omittedModel),
    renderStickySummary(omittedModel).markdown,
    renderStickySummary(omittedModel).markdown
  ]) assert.match(rendered, /Review scope incomplete/);
});

test("review-surfaces.REVIEWER_VALUE.5 PR scope cannot be widened by a mismatched secondary diff", () => {
  const prPath = "src/in-range.ts";
  const stalePath = "schemas/stale.schema.json";
  const diff = parseStructuredDiff([
    `diff --git a/${stalePath} b/${stalePath}`,
    `--- a/${stalePath}`,
    `+++ b/${stalePath}`,
    "@@ -1 +1 @@",
    "-{}",
    "+{\"required\":[\"x\"]}"
  ].join("\n"));
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface([prPath]),
    diff,
    semanticFacts: {
      ...emptySemanticFacts,
      schema_changes: [{
        path: stalePath,
        properties_added: [], properties_removed: [], required_added: ["x"], required_removed: [], type_changes: [], enum_changes: []
      }]
    }
  });
  assert.ok(!model.decision_projection?.findings.some((finding) => finding.path === stalePath));
  assert.ok(!model.blockers.some((blocker) => blocker.summary.includes(stalePath)));
});

test("review-surfaces.REVIEWER_VALUE.5 stale repo facts and PR gates cannot bypass decision scope", () => {
  const changedPath = "src/in-range.ts";
  const stalePath = "schemas/stale.schema.json";
  const diff = parseStructuredDiff([
    `diff --git a/${changedPath} b/${changedPath}`,
    `--- a/${changedPath}`,
    `+++ b/${changedPath}`,
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n"));
  const semanticFacts: SemanticChangeFacts = {
    ...emptySemanticFacts,
    schema_changes: [{
      path: stalePath,
      properties_added: [], properties_removed: ["legacy"], required_added: [], required_removed: [], type_changes: [], enum_changes: []
    }]
  };
  const repoBaseline = buildHumanReview({ packet: packet(), diff });
  const repoStale = buildHumanReview({ packet: packet(), diff, semanticFacts });
  assert.ok(!repoStale.blockers.some((blocker) => blocker.id.startsWith("BLOCK-SCHEMA-")));
  assert.equal(repoStale.verdict.decision, repoBaseline.verdict.decision);
  assert.deepEqual(repoStale.decision_projection?.findings, repoBaseline.decision_projection?.findings);

  const pr = surface([changedPath], [
    risk("PR-RISK-COVERAGE", "coverage_regression", stalePath),
    risk("PR-RISK-CI", "ci_secret_boundary_change", ".github/workflows/stale.yml")
  ]);
  const model = buildHumanReview({ packet: packet(), prSurface: pr });
  const prBaseline = buildHumanReview({ packet: packet(), prSurface: surface([changedPath]) });
  assert.ok(!model.blockers.some((blocker) => blocker.id === "BLOCK-PR-RISK-COVERAGE"));
  assert.ok(!model.blockers.some((blocker) => blocker.id === "BLOCK-CI-SECRET-001"));
  assert.equal(model.verdict.decision, prBaseline.verdict.decision);
  assert.deepEqual(model.decision_projection?.findings, prBaseline.decision_projection?.findings);
});
