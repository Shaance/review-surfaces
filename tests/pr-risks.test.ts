import test from "node:test";
import assert from "node:assert/strict";
import { buildPrRiskCandidates, BuildPrRiskInput } from "../src/risks/pr-risks";
import type {
  PrRequirementCoverageDelta,
  PrScopedCoverageModel,
  PrScopeModel,
  ScopedChangedFile
} from "../src/pr/contract";
import type { ReviewArea } from "../src/review-areas/areas";

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

function buildInput(overrides: Partial<BuildPrRiskInput> = {}): BuildPrRiskInput {
  return {
    scope: overrides.scope ?? scope(),
    coverage: overrides.coverage ?? coverage(),
    ...(overrides.testResults !== undefined ? { testResults: overrides.testResults } : {}),
    ...(overrides.commandTranscripts !== undefined ? { commandTranscripts: overrides.commandTranscripts } : {}),
    ...(overrides.changedFileSources !== undefined ? { changedFileSources: overrides.changedFileSources } : {}),
    ...(overrides.reviewAreas !== undefined ? { reviewAreas: overrides.reviewAreas } : {}),
    ...(overrides.config !== undefined ? { config: overrides.config } : {})
  };
}

function reviewArea(groupKey: string, testKeywords: string[]): ReviewArea {
  return {
    id: `SUB-${groupKey}`,
    name: `${groupKey} area`,
    groupKey,
    prefixes: [`src/${groupKey.toLowerCase()}/`],
    purpose: `${groupKey} fixture`,
    pattern: "fixture",
    testKeywords
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

test("coverage_regression risk anchors to the requirement's REAL evidence path, never its title", () => {
  const regressed: PrRequirementCoverageDelta = {
    requirement_id: "REQ-PRIV-2",
    acai_id: "review-surfaces.PRIVACY.2",
    title: "Redact secrets in the diff", // a TITLE — must never become an evidence path
    base_status: "satisfied",
    head_status: "partial",
    delta: "regressed",
    reasons: ["test removed"],
    head_evidence: [{ kind: "file", path: "src/privacy/secrets.ts", confidence: "medium", validation_status: "not_checked" }],
    missing_evidence: []
  };
  const model = buildPrRiskCandidates(buildInput({ coverage: coverage([regressed]) }));
  const candidate = model.candidates.find((c) => c.rule === "coverage_regression");
  assert.ok(candidate);
  assert.ok(candidate!.evidence.some((ref) => ref.path === "src/privacy/secrets.ts"), "cites the real source path");
  assert.ok(!candidate!.evidence.some((ref) => ref.path === "Redact secrets in the diff"), "title is never an evidence path");
});

test("coverage_regression without path-bearing evidence anchors by acai_id, not a fabricated path", () => {
  const regressed: PrRequirementCoverageDelta = {
    requirement_id: "REQ-PRIV-2",
    acai_id: "review-surfaces.PRIVACY.2",
    title: "Redact secrets in the diff",
    base_status: "satisfied",
    head_status: "partial",
    delta: "regressed",
    reasons: ["test removed"],
    head_evidence: [],
    missing_evidence: []
  };
  const model = buildPrRiskCandidates(buildInput({ coverage: coverage([regressed]) }));
  const candidate = model.candidates.find((c) => c.rule === "coverage_regression");
  assert.ok(candidate);
  assert.ok(candidate!.evidence.every((ref) => ref.path === undefined), "no fabricated path");
  assert.ok(candidate!.evidence.some((ref) => ref.acai_id === "review-surfaces.PRIVACY.2"), "anchored by acai_id");
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

test("impl file with a current-head focused test transcript in its area does NOT fire untested_changed_impl", () => {
  const input = buildInput({
    scope: scope({
      head_sha: "head123",
      changed_files: [
        changedFile({ path: "src/human/human-review.ts", role: "implementation", areas: ["HUMAN_REVIEW"] })
      ]
    }),
    reviewAreas: [reviewArea("HUMAN_REVIEW", ["human", "review"])],
    commandTranscripts: [
      {
        id: "CMD-HUMAN-FOCUSED",
        command: "node --test dist/tests/human-review.test.js",
        status: "passed",
        exit_code: 0,
        head_sha: "head123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-HUMAN-FOCUSED.json"
      }
    ]
  });

  const model = buildPrRiskCandidates(input);
  assert.equal(
    model.candidates.find((c) => c.rule === "untested_changed_impl"),
    undefined,
    "current-head focused test transcript suppresses the untested candidate"
  );
});

test("impl file with a stale focused test transcript still fires untested_changed_impl", () => {
  const input = buildInput({
    scope: scope({
      head_sha: "head123",
      changed_files: [
        changedFile({ path: "src/human/human-review.ts", role: "implementation", areas: ["HUMAN_REVIEW"] })
      ]
    }),
    reviewAreas: [reviewArea("HUMAN_REVIEW", ["human", "review"])],
    commandTranscripts: [
      {
        id: "CMD-HUMAN-STALE",
        command: "node --test dist/tests/human-review.test.js",
        status: "passed",
        exit_code: 0,
        head_sha: "oldhead",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-HUMAN-STALE.json"
      }
    ]
  });

  const model = buildPrRiskCandidates(input);
  const candidate = model.candidates.find((c) => c.rule === "untested_changed_impl");

  assert.ok(candidate, "stale focused transcript does not suppress the untested candidate");
  assert.ok(candidate.summary.includes("current-head test evidence"));
});

test("impl file with a failed focused test transcript still fires untested_changed_impl", () => {
  const input = buildInput({
    scope: scope({
      head_sha: "head123",
      changed_files: [
        changedFile({ path: "src/human/human-review.ts", role: "implementation", areas: ["HUMAN_REVIEW"] })
      ]
    }),
    reviewAreas: [reviewArea("HUMAN_REVIEW", ["human", "review"])],
    commandTranscripts: [
      {
        id: "CMD-HUMAN-FAILED",
        command: "node --test dist/tests/human-review.test.js",
        status: "failed",
        exit_code: 1,
        head_sha: "head123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-HUMAN-FAILED.json"
      }
    ]
  });

  const model = buildPrRiskCandidates(input);
  assert.ok(
    model.candidates.find((c) => c.rule === "untested_changed_impl"),
    "failed focused transcript does not suppress the untested candidate"
  );
});

test("impl file with a current-head broad test transcript does NOT fire untested_changed_impl", () => {
  const input = buildInput({
    scope: scope({
      head_sha: "head123",
      changed_files: [
        changedFile({ path: "src/risks/risks.ts", role: "implementation", areas: ["RISK"] }),
        changedFile({ path: "src/evidence/evidence.ts", role: "implementation", areas: ["EVIDENCE"] })
      ]
    }),
    commandTranscripts: [
      {
        id: "CMD-TEST-FAST",
        command: "pnpm run test:fast",
        status: "passed",
        exit_code: 0,
        head_sha: "head123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-TEST-FAST.json"
      }
    ]
  });

  const model = buildPrRiskCandidates(input);
  assert.equal(
    model.candidates.find((c) => c.rule === "untested_changed_impl"),
    undefined,
    "current-head broad test transcript suppresses the untested candidate"
  );
});

test("working-tree impl file with a current-head broad test transcript still fires untested_changed_impl", () => {
  const input = buildInput({
    scope: scope({
      head_sha: "head123",
      changed_files: [
        changedFile({ path: "src/risks/risks.ts", role: "implementation", areas: ["RISK"] })
      ]
    }),
    changedFileSources: {
      "src/risks/risks.ts": "working_tree"
    },
    commandTranscripts: [
      {
        id: "CMD-TEST-FAST",
        command: "pnpm run test:fast",
        status: "passed",
        exit_code: 0,
        head_sha: "head123",
        truncated: false,
        source_path: ".review-surfaces/commands/CMD-TEST-FAST.json"
      }
    ]
  });

  const model = buildPrRiskCandidates(input);
  assert.ok(
    model.candidates.find((c) => c.rule === "untested_changed_impl"),
    "HEAD-matched transcript is not enough to suppress working-tree implementation changes"
  );
});

test("impl file with a parsed passing test case in its area does NOT fire untested_changed_impl", () => {
  const input = buildInput({
    scope: scope({
      changed_files: [
        changedFile({ path: "src/risks/risks.ts", role: "implementation", areas: ["RISK"] })
      ]
    }),
    reviewAreas: [reviewArea("RISK", ["risk"])],
    testResults: {
      suites: [],
      cases: [
        {
          name: "review-surfaces.RISK.1 emits risk evidence",
          status: "passed"
        }
      ],
      totals: { suites: 1, cases: 1, passed: 1, failed: 0, skipped: 0 },
      source_paths: ["junit.xml"]
    }
  });

  const model = buildPrRiskCandidates(input);
  assert.equal(
    model.candidates.find((c) => c.rule === "untested_changed_impl"),
    undefined,
    "parsed passing test evidence suppresses the untested candidate"
  );
});

test("working-tree impl file with parsed passing test evidence still fires untested_changed_impl", () => {
  const input = buildInput({
    scope: scope({
      changed_files: [
        changedFile({ path: "src/risks/risks.ts", role: "implementation", areas: ["RISK"] })
      ]
    }),
    changedFileSources: {
      "src/risks/risks.ts": "working_tree"
    },
    reviewAreas: [reviewArea("RISK", ["risk"])],
    testResults: {
      suites: [],
      cases: [
        {
          name: "review-surfaces.RISK.1 emits risk evidence",
          status: "passed"
        }
      ],
      totals: { suites: 1, cases: 1, passed: 1, failed: 0, skipped: 0 },
      source_paths: ["junit.xml"]
    }
  });

  const model = buildPrRiskCandidates(input);
  assert.ok(
    model.candidates.find((c) => c.rule === "untested_changed_impl"),
    "parsed test output without content provenance is not enough to suppress working-tree implementation changes"
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
