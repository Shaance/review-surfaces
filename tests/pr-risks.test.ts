import test from "node:test";
import assert from "node:assert/strict";
import { buildPrRiskCandidates, BuildPrRiskInput } from "../src/risks/pr-risks";
import type {
  PrRequirementCoverageDelta,
  PrScopedCoverageModel,
  PrScopeModel,
  ScopedChangedFile,
  StructuredDiff
} from "../src/pr/contract";

// --- Inline fixture builders (construct contract types directly; NO wiring to
// other PR modules) --------------------------------------------------------

function changedFile(overrides: Partial<ScopedChangedFile> & Pick<ScopedChangedFile, "path">): ScopedChangedFile {
  return {
    path: overrides.path,
    status: overrides.status ?? "M",
    areas: overrides.areas ?? [],
    role: overrides.role ?? "implementation",
    ...(overrides.old_path !== undefined ? { old_path: overrides.old_path } : {}),
    ...(overrides.added_lines !== undefined ? { added_lines: overrides.added_lines } : {}),
    ...(overrides.deleted_lines !== undefined ? { deleted_lines: overrides.deleted_lines } : {})
  };
}

function scope(overrides: Partial<PrScopeModel> = {}): PrScopeModel {
  return {
    base_ref: "main",
    head_ref: "feature",
    head_sha: "deadbeef",
    diff_source: "range",
    changed_files: [],
    affected_areas: [],
    affected_requirements: [],
    out_of_scope_changed_files: [],
    ...overrides
  };
}

function coverage(deltas: PrRequirementCoverageDelta[] = []): PrScopedCoverageModel {
  return {
    base_available: true,
    summary: "coverage fixture",
    in_scope_count: deltas.length,
    deltas,
    counts: {
      improved: 0,
      regressed: deltas.filter((d) => d.delta === "regressed").length,
      unchanged: 0,
      new_requirement: 0,
      removed_requirement: 0,
      newly_in_scope: 0
    }
  };
}

function emptyDiff(): StructuredDiff {
  return { files: [] };
}

function buildInput(overrides: Partial<BuildPrRiskInput> = {}): BuildPrRiskInput {
  return {
    scope: overrides.scope ?? scope(),
    coverage: overrides.coverage ?? coverage(),
    diff: overrides.diff ?? emptyDiff(),
    ...(overrides.testResults !== undefined ? { testResults: overrides.testResults } : {}),
    ...(overrides.config !== undefined ? { config: overrides.config } : {})
  };
}

function regressedDelta(requirementId: string, acaiId: string): PrRequirementCoverageDelta {
  return {
    requirement_id: requirementId,
    acai_id: acaiId,
    base_status: "satisfied",
    head_status: "partial",
    delta: "regressed",
    reasons: ["test removed"],
    head_evidence: [],
    missing_evidence: []
  };
}

// --- Tests -----------------------------------------------------------------

test("coverage-regression delta produces a coverage_regression candidate citing the requirement", () => {
  const input = buildInput({
    coverage: coverage([regressedDelta("REQ-PRIV-2", "review-surfaces.PRIVACY.2")])
  });

  const model = buildPrRiskCandidates(input);
  const candidate = model.candidates.find((c) => c.rule === "coverage_regression");

  assert.ok(candidate, "coverage_regression candidate emitted");
  assert.equal(candidate.category, "testing");
  assert.equal(candidate.severity, "high");
  assert.ok(
    candidate.evidence.some((ref) => ref.acai_id === "review-surfaces.PRIVACY.2"),
    "evidence cites the regressed requirement acai_id"
  );
  assert.ok(candidate.summary.includes("REQ-PRIV-2"), "summary names the regressed requirement");
});

test("changed .github/workflows file produces a ci_secret_boundary_change candidate", () => {
  const input = buildInput({
    scope: scope({
      changed_files: [
        changedFile({ path: ".github/workflows/review.yml", role: "ci", status: "M", areas: [] })
      ]
    })
  });

  const model = buildPrRiskCandidates(input);
  const candidate = model.candidates.find((c) => c.rule === "ci_secret_boundary_change");

  assert.ok(candidate, "ci_secret_boundary_change candidate emitted");
  assert.equal(candidate.category, "security");
  assert.equal(candidate.severity, "high");
  assert.ok(
    candidate.evidence.some((ref) => ref.path === ".github/workflows/review.yml"),
    "evidence cites the workflow file"
  );
});

test("changed src/privacy file produces a privacy_sensitive_change candidate", () => {
  const input = buildInput({
    scope: scope({
      changed_files: [
        changedFile({ path: "src/privacy/secrets.ts", role: "implementation", areas: ["PRIVACY"] })
      ]
    })
  });

  const model = buildPrRiskCandidates(input);
  const candidate = model.candidates.find((c) => c.rule === "privacy_sensitive_change");

  assert.ok(candidate, "privacy_sensitive_change candidate emitted");
  assert.equal(candidate.category, "privacy");
  assert.equal(candidate.severity, "high");
  assert.ok(
    candidate.evidence.some((ref) => ref.path === "src/privacy/secrets.ts"),
    "evidence cites the privacy file"
  );
});

test("comment_surface_change fires for a render file but NOT for src/evaluation or src/risks files", () => {
  const renderModel = buildPrRiskCandidates(
    buildInput({
      scope: scope({ changed_files: [changedFile({ path: "src/render/pr-comment.ts", role: "implementation", areas: ["RENDER"] })] })
    })
  );
  assert.ok(
    renderModel.candidates.some((c) => c.rule === "comment_surface_change"),
    "a real render-surface file should fire comment_surface_change"
  );

  // src/evaluation/ and src/risks/ are NOT the render surface. They previously
  // matched the over-broad "evaluation"/"risk" substrings and produced false
  // positives claiming the comment surface was affected.
  const nonRenderModel = buildPrRiskCandidates(
    buildInput({
      scope: scope({
        changed_files: [
          changedFile({ path: "src/evaluation/scoped-coverage.ts", role: "implementation", areas: ["EVAL"] }),
          changedFile({ path: "src/risks/pr-risks.ts", role: "implementation", areas: ["RISK"] })
        ]
      })
    })
  );
  assert.ok(
    !nonRenderModel.candidates.some((c) => c.rule === "comment_surface_change"),
    "evaluation/risks files must NOT be mislabeled as comment-surface changes"
  );
});

test("impl file with no co-changed test in its area produces an untested_changed_impl candidate", () => {
  const input = buildInput({
    scope: scope({
      changed_files: [
        changedFile({ path: "src/foo/widget.ts", role: "implementation", areas: ["FOO"] })
      ]
    })
  });

  const model = buildPrRiskCandidates(input);
  const candidate = model.candidates.find((c) => c.rule === "untested_changed_impl");

  assert.ok(candidate, "untested_changed_impl candidate emitted");
  assert.equal(candidate.category, "testing");
  assert.equal(candidate.severity, "medium");
  assert.ok(
    candidate.evidence.some((ref) => ref.path === "src/foo/widget.ts"),
    "evidence cites the untested impl file"
  );
});

test("impl file WITH a co-changed test in the same area does NOT fire untested_changed_impl", () => {
  const input = buildInput({
    scope: scope({
      changed_files: [
        changedFile({ path: "src/foo/widget.ts", role: "implementation", areas: ["FOO"] }),
        changedFile({ path: "tests/widget.test.ts", role: "test", areas: ["FOO"] })
      ]
    })
  });

  const model = buildPrRiskCandidates(input);
  assert.equal(
    model.candidates.find((c) => c.rule === "untested_changed_impl"),
    undefined,
    "co-changed test in the same area suppresses the untested candidate"
  );
});

test("no candidate restates whole-spec partial counts; only this PR's facts", () => {
  const input = buildInput({
    scope: scope({
      changed_files: [
        changedFile({ path: "src/privacy/secrets.ts", role: "implementation", areas: ["PRIVACY"] })
      ]
    }),
    coverage: coverage([regressedDelta("REQ-PRIV-2", "review-surfaces.PRIVACY.2")])
  });

  const model = buildPrRiskCandidates(input);

  for (const candidate of model.candidates) {
    assert.ok(
      !/whole[- ]spec|spec partial|partial requirement/i.test(candidate.summary),
      `${candidate.id} must not restate whole-spec partial counts`
    );
  }
  assert.ok(
    !/whole[- ]spec/i.test(model.summary),
    "model summary must not restate whole-spec partial counts"
  );
  assert.ok(model.summary.includes("PR risk candidate"), "model summary is PR-scoped");
});

test("candidate ids are zero-padded PR-RISK-00N in rule-priority order", () => {
  // Trigger several rules at once: privacy (high prio early), comment surface,
  // schema contract, ci boundary, and a regression. Verify monotonically padded ids.
  const input = buildInput({
    scope: scope({
      changed_files: [
        changedFile({ path: ".github/workflows/ci.yml", role: "ci" }),
        changedFile({ path: "schemas/packet.schema.json", role: "config" }),
        changedFile({ path: "src/privacy/redact.ts", role: "implementation", areas: ["PRIVACY"] }),
        changedFile({ path: "src/render/comment.ts", role: "implementation", areas: ["RENDER"] })
      ]
    }),
    coverage: coverage([regressedDelta("REQ-A", "review-surfaces.A.1")])
  });

  const model = buildPrRiskCandidates(input);

  assert.ok(model.candidates.length >= 3, "multiple candidates emitted");
  model.candidates.forEach((candidate, index) => {
    assert.equal(candidate.id, `PR-RISK-${String(index + 1).padStart(3, "0")}`);
    assert.match(candidate.id, /^PR-RISK-\d{3}$/);
  });

  // coverage_regression is the highest-priority rule, so it must be PR-RISK-001.
  assert.equal(model.candidates[0].rule, "coverage_regression");
  assert.equal(model.candidates[0].id, "PR-RISK-001");
});

test("no triggers => empty candidate set and a deterministic empty summary", () => {
  const model = buildPrRiskCandidates(buildInput());
  assert.deepEqual(model.candidates, []);
  assert.equal(model.summary, "No PR risk candidates.");
});

test("failed_or_skipped_test fires from parsed test totals", () => {
  const input = buildInput({
    testResults: {
      suites: [],
      cases: [],
      totals: { suites: 1, cases: 5, passed: 3, failed: 1, skipped: 1 },
      source_paths: []
    }
  });

  const model = buildPrRiskCandidates(input);
  const candidate = model.candidates.find((c) => c.rule === "failed_or_skipped_test");

  assert.ok(candidate, "failed_or_skipped_test candidate emitted");
  assert.equal(candidate.severity, "high");
  assert.ok(candidate.summary.includes("1 failed"));
  assert.ok(candidate.summary.includes("1 skipped"));
});

test("large_diff fires on the file cap and respects config overrides", () => {
  const manyFiles = Array.from({ length: 5 }, (_, i) =>
    changedFile({ path: `src/mod/file-${String(i).padStart(2, "0")}.ts`, role: "implementation" })
  );
  const input = buildInput({
    scope: scope({ changed_files: manyFiles }),
    config: { largeDiffFileCap: 4 }
  });

  const model = buildPrRiskCandidates(input);
  const candidate = model.candidates.find((c) => c.rule === "large_diff");

  assert.ok(candidate, "large_diff candidate emitted when over the file cap");
  assert.equal(candidate.severity, "low");
  assert.equal(candidate.category, "maintainability");
});

test("output is byte-stable across repeated calls with the same input", () => {
  const make = () =>
    buildInput({
      scope: scope({
        changed_files: [
          changedFile({ path: "src/render/comment.ts", role: "implementation", areas: ["RENDER"] }),
          changedFile({ path: "src/privacy/redact.ts", role: "implementation", areas: ["PRIVACY"] })
        ]
      }),
      coverage: coverage([regressedDelta("REQ-A", "review-surfaces.A.1")])
    });

  assert.equal(JSON.stringify(buildPrRiskCandidates(make())), JSON.stringify(buildPrRiskCandidates(make())));
});
