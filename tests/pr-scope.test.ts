import test from "node:test";
import assert from "node:assert/strict";
import { buildPrScope, BuildPrScopeInput } from "../src/scope/pr-scope";
import { CollectionResult } from "../src/collector/collect";
import { IntentModel, IntentRequirement } from "../src/intent/intent";
import { ReviewArea } from "../src/review-areas/areas";
import { specEvidence } from "../src/evidence/evidence";
import { StructuredDiff, StructuredDiffFile } from "../src/pr/contract";

// --- inline fixtures -------------------------------------------------------

function areas(): ReviewArea[] {
  return [
    {
      id: "SUB-PRIVACY",
      name: "Privacy controls",
      groupKey: "PRIVACY",
      prefixes: ["src/privacy/"],
      purpose: "Privacy redaction and ignore handling.",
      pattern: "privacy",
      testKeywords: ["privacy"]
    },
    {
      id: "SUB-INTENT",
      name: "Intent builder",
      groupKey: "INTENT",
      prefixes: ["src/intent/"],
      purpose: "Intent construction.",
      pattern: "intent",
      testKeywords: ["intent"]
    }
  ];
}

function requirement(overrides: Partial<IntentRequirement> & Pick<IntentRequirement, "id">): IntentRequirement {
  return {
    requirement: "Requirement text.",
    source_refs: [],
    constraints: [],
    assumptions: [],
    open_questions: [],
    confidence: "high",
    ...overrides
  };
}

function intentModel(requirements: IntentRequirement[]): IntentModel {
  return {
    summary: "Inline intent fixture.",
    spec_mode: "acai",
    requirements,
    constraints: [],
    non_goals: [],
    assumptions: [],
    open_questions: [],
    sources: []
  };
}

function collectionStub(
  changedFiles: Array<{ path: string; status: string }>
): CollectionResult {
  // Only the fields buildPrScope reads (changedFiles, git, diff_source) need to
  // be real; the rest are cast through unknown to keep the fixture minimal.
  const partial = {
    changedFiles: changedFiles.map((file) => ({ ...file, source: "diff" as const })),
    git: {
      repo: "acme/widgets",
      base_ref: "main",
      head_ref: "feature",
      base_sha: "base000",
      head_sha: "head111"
    },
    diff_source: "range" as const
  };
  return partial as unknown as CollectionResult;
}

function diffFile(path: string, addLines: string[], opts: Partial<StructuredDiffFile> = {}): StructuredDiffFile {
  return {
    path,
    status: "M",
    hunks: [
      {
        old_start: 1,
        old_lines: 0,
        new_start: 10,
        new_lines: addLines.length,
        lines: addLines.map((text, index) => ({ kind: "add" as const, text, new_line: 10 + index }))
      }
    ],
    ...opts
  };
}

function input(overrides: Partial<BuildPrScopeInput>): BuildPrScopeInput {
  return {
    collection: collectionStub([]),
    intent: intentModel([]),
    reviewAreas: areas(),
    diff: { files: [] },
    ...overrides
  };
}

// --- tests -----------------------------------------------------------------

test("a privacy file change scopes to PRIVACY-group requirements and not unrelated ones", () => {
  const requirements = [
    requirement({
      id: "REQ-001",
      acai_id: "review-surfaces.PRIVACY.2",
      title: "Privacy controls",
      requirement: "Redact secrets in the diff."
    }),
    requirement({
      id: "REQ-002",
      acai_id: "review-surfaces.INTENT.1",
      title: "Intent builder",
      requirement: "Build intent deterministically."
    })
  ];
  const diff: StructuredDiff = {
    files: [diffFile("src/privacy/secrets.ts", ["export const redact = true;"])]
  };
  const model = buildPrScope(
    input({
      collection: collectionStub([{ path: "src/privacy/secrets.ts", status: "M" }]),
      intent: intentModel(requirements),
      diff
    })
  );

  // The privacy file maps to the PRIVACY area as implementation.
  const privacyFile = model.changed_files.find((file) => file.path === "src/privacy/secrets.ts");
  assert.ok(privacyFile);
  assert.deepEqual(privacyFile?.areas, ["PRIVACY"]);
  assert.equal(privacyFile?.role, "implementation");
  assert.equal(privacyFile?.added_lines, 1);
  assert.equal(privacyFile?.deleted_lines, 0);

  // PRIVACY requirement is affected via changed_path_requirement_group; the
  // INTENT requirement is NOT in scope (its area was not touched).
  const affectedIds = model.affected_requirements.map((req) => req.requirement_id);
  assert.deepEqual(affectedIds, ["REQ-001"]);
  const privacyReq = model.affected_requirements[0];
  assert.equal(privacyReq.group_key, "PRIVACY");
  assert.ok(privacyReq.reasons.some((reason) => reason.rule === "changed_path_requirement_group"));
  assert.ok(privacyReq.reasons.every((reason) => reason.confidence !== "low"));

  // affected_areas groups the change under PRIVACY only.
  assert.deepEqual(
    model.affected_areas.map((area) => area.group_key),
    ["PRIVACY"]
  );
  assert.equal(model.affected_areas[0].name, "Privacy controls");
  assert.deepEqual(model.affected_areas[0].area_ids, ["SUB-PRIVACY"]);
  assert.deepEqual(model.affected_areas[0].changed_files, ["src/privacy/secrets.ts"]);
});

test("review-surfaces.PERF.2 affected_areas precomputes area_ids by group_key once (multi-area group, multi-file) — output identical", () => {
  // Two review areas sharing ONE group_key (PRIVACY) plus a second group, and
  // TWO changed files mapping to the PRIVACY group. The accumulation used to
  // re-scan ALL review areas for every (file, group) pair — repeated even for a
  // group_key already seen on the first file. The precomputed areaIdsByGroupKey
  // map is now built once before the loop; this fixture proves the emitted
  // area_ids are exactly the full set for the group regardless of file count.
  const multiAreaSet: ReviewArea[] = [
    {
      id: "SUB-PRIVACY-A",
      name: "Privacy controls",
      groupKey: "PRIVACY",
      prefixes: ["src/privacy/"],
      purpose: "Privacy redaction.",
      pattern: "privacy",
      testKeywords: ["privacy"]
    },
    {
      id: "SUB-PRIVACY-B",
      name: "Privacy controls",
      groupKey: "PRIVACY",
      prefixes: ["src/redact/"],
      purpose: "Redaction helpers.",
      pattern: "redact",
      testKeywords: ["redact"]
    },
    {
      id: "SUB-INTENT",
      name: "Intent builder",
      groupKey: "INTENT",
      prefixes: ["src/intent/"],
      purpose: "Intent construction.",
      pattern: "intent",
      testKeywords: ["intent"]
    }
  ];
  const diff: StructuredDiff = {
    files: [
      diffFile("src/privacy/secrets.ts", ["export const redact = true;"]),
      diffFile("src/redact/util.ts", ["export const helper = 1;"]),
      diffFile("src/intent/build.ts", ["export const intent = 1;"])
    ]
  };
  const model = buildPrScope(
    input({
      collection: collectionStub([
        { path: "src/privacy/secrets.ts", status: "M" },
        { path: "src/redact/util.ts", status: "M" },
        { path: "src/intent/build.ts", status: "M" }
      ]),
      intent: intentModel([]),
      reviewAreas: multiAreaSet,
      diff
    })
  );

  // Two affected areas, sorted by group_key.
  assert.deepEqual(
    model.affected_areas.map((area) => area.group_key),
    ["INTENT", "PRIVACY"]
  );
  // PRIVACY carries BOTH of its area ids exactly once each (the multi-visit
  // group key did not drop or duplicate ids under the precompute), and lists
  // both changed files that mapped to it.
  const privacy = model.affected_areas.find((area) => area.group_key === "PRIVACY");
  assert.deepEqual(privacy?.area_ids, ["SUB-PRIVACY-A", "SUB-PRIVACY-B"]);
  assert.deepEqual(privacy?.changed_files, ["src/privacy/secrets.ts", "src/redact/util.ts"]);
  const intent = model.affected_areas.find((area) => area.group_key === "INTENT");
  assert.deepEqual(intent?.area_ids, ["SUB-INTENT"]);
  assert.deepEqual(intent?.changed_files, ["src/intent/build.ts"]);
});

test("exact_acid_in_diff fires when a diff line contains the requirement acai_id", () => {
  const requirements = [
    requirement({
      id: "REQ-001",
      acai_id: "review-surfaces.PRIVACY.2",
      title: "Privacy controls",
      requirement: "Redact secrets."
    })
  ];
  const diff: StructuredDiff = {
    files: [diffFile("src/privacy/secrets.ts", ["// implements review-surfaces.PRIVACY.2"])]
  };
  const model = buildPrScope(
    input({
      collection: collectionStub([{ path: "src/privacy/secrets.ts", status: "M" }]),
      intent: intentModel(requirements),
      diff
    })
  );

  const req = model.affected_requirements.find((entry) => entry.requirement_id === "REQ-001");
  assert.ok(req);
  const exact = req?.reasons.find((reason) => reason.rule === "exact_acid_in_diff");
  assert.ok(exact, "expected exact_acid_in_diff reason");
  assert.equal(exact?.confidence, "high");
  assert.equal(exact?.path, "src/privacy/secrets.ts");
  assert.equal(exact?.line_start, 10);
  assert.equal(exact?.line_end, 10);
});

test("a changed test file with the acai_id fires changed_test_exact_acid (not exact_acid_in_diff)", () => {
  const requirements = [
    requirement({
      id: "REQ-001",
      acai_id: "review-surfaces.PRIVACY.2",
      requirement: "Redact secrets."
    })
  ];
  const diff: StructuredDiff = {
    files: [diffFile("tests/privacy.test.ts", ["// covers review-surfaces.PRIVACY.2"])]
  };
  const model = buildPrScope(
    input({
      collection: collectionStub([{ path: "tests/privacy.test.ts", status: "M" }]),
      intent: intentModel(requirements),
      diff
    })
  );

  const testFile = model.changed_files.find((file) => file.path === "tests/privacy.test.ts");
  assert.equal(testFile?.role, "test");

  const req = model.affected_requirements[0];
  const rules = req.reasons.map((reason) => reason.rule);
  assert.ok(rules.includes("changed_test_exact_acid"));
  assert.ok(!rules.includes("exact_acid_in_diff"));
});

test("non-JS colocated test naming conventions classify as tests", () => {
  const model = buildPrScope(
    input({
      collection: collectionStub([
        { path: "pkg/foo_test.go", status: "M" },
        { path: "pkg/test_auth.go", status: "M" },
        { path: "test_auth.py", status: "M" },
        { path: "foo_spec.rb", status: "M" },
        { path: "FooTest.php", status: "M" },
        { path: "Contest.java", status: "M" },
        { path: "latest.cs", status: "M" }
      ]),
      diff: {
        files: [
          diffFile("pkg/foo_test.go", ["func TestFoo(t *testing.T) {}"]),
          diffFile("pkg/test_auth.go", ["func Authenticate() {}"]),
          diffFile("test_auth.py", ["def test_auth(): pass"]),
          diffFile("foo_spec.rb", ["RSpec.describe Foo do end"]),
          diffFile("FooTest.php", ["final class FooTest extends TestCase {}"]),
          diffFile("Contest.java", ["final class Contest {}"]),
          diffFile("latest.cs", ["public class latest {}"])
        ]
      }
    })
  );

  for (const filePath of ["pkg/foo_test.go", "test_auth.py", "foo_spec.rb", "FooTest.php"]) {
    assert.equal(model.changed_files.find((file) => file.path === filePath)?.role, "test", `${filePath} should be a test`);
  }
  for (const filePath of ["pkg/test_auth.go", "Contest.java", "latest.cs"]) {
    assert.notEqual(model.changed_files.find((file) => file.path === filePath)?.role, "test", `${filePath} should not be a test`);
  }
});

test("spec_block_changed fires when a changed spec hunk overlaps the requirement source range", () => {
  const specPath = "features/privacy.feature.yaml";
  const evidence = specEvidence(specPath, "review-surfaces.PRIVACY.2");
  evidence.line_start = 12;
  evidence.line_end = 16;
  const requirements = [
    requirement({
      id: "REQ-001",
      acai_id: "review-surfaces.PRIVACY.2",
      requirement: "Redact secrets.",
      source_refs: [
        {
          kind: "spec",
          ref: specPath,
          title: "review-surfaces.PRIVACY.2",
          evidence: [evidence]
        }
      ]
    })
  ];
  const specDiff: StructuredDiffFile = {
    path: specPath,
    status: "M",
    hunks: [
      {
        old_start: 12,
        old_lines: 3,
        new_start: 12,
        new_lines: 4,
        lines: [{ kind: "add", text: "      2: Redact PEM blocks.", new_line: 14 }]
      }
    ]
  };
  const model = buildPrScope(
    input({
      collection: collectionStub([{ path: specPath, status: "M" }]),
      intent: intentModel(requirements),
      diff: { files: [specDiff] }
    })
  );

  const specFile = model.changed_files.find((file) => file.path === specPath);
  assert.equal(specFile?.role, "spec");

  const req = model.affected_requirements[0];
  const spec = req.reasons.find((reason) => reason.rule === "spec_block_changed");
  assert.ok(spec, "expected spec_block_changed reason");
  assert.equal(spec?.confidence, "high");
  assert.equal(spec?.path, specPath);
});

test("spec_block_changed fires for a WHOLE-FILE spec ref (no line numbers) edited anywhere but line 1", () => {
  // specEvidence() does NOT set line_start/line_end, so the requirement's spec
  // range is line-less. A hunk editing the spec at lines 30-40 must still scope the
  // requirement; defaulting the overlap window to line 1 would silently drop it.
  const specPath = "features/privacy.feature.yaml";
  const evidence = specEvidence(specPath, "review-surfaces.PRIVACY.2"); // no line numbers
  assert.equal(evidence.line_start, undefined);
  assert.equal(evidence.line_end, undefined);
  const requirements = [
    requirement({
      id: "REQ-001",
      acai_id: "review-surfaces.PRIVACY.2",
      requirement: "Redact secrets.",
      source_refs: [{ kind: "spec", ref: specPath, title: "review-surfaces.PRIVACY.2", evidence: [evidence] }]
    })
  ];
  const specDiff: StructuredDiffFile = {
    path: specPath,
    status: "M",
    hunks: [
      {
        old_start: 30,
        old_lines: 3,
        new_start: 30,
        new_lines: 4,
        lines: [{ kind: "add", text: "      9: Redact PEM blocks.", new_line: 33 }]
      }
    ]
  };
  const model = buildPrScope(
    input({
      collection: collectionStub([{ path: specPath, status: "M" }]),
      intent: intentModel(requirements),
      diff: { files: [specDiff] }
    })
  );

  const req = model.affected_requirements[0];
  assert.ok(req, "requirement must be in scope via its changed whole-file spec");
  const spec = req.reasons.find((reason) => reason.rule === "spec_block_changed");
  assert.ok(spec, "expected spec_block_changed reason for a whole-file spec ref edited at lines 30-40");
  assert.equal(spec?.confidence, "high");
  assert.equal(spec?.path, specPath);
});

test("exact_acid_in_diff matches whole ACID tokens only (PRIVACY.1 does not match PRIVACY.10 or suffix text)", () => {
  const requirements = [
    requirement({ id: "REQ-001", acai_id: "review-surfaces.PRIVACY.1", requirement: "Redact secrets." })
  ];
  // The added line cites PRIVACY.10 — PRIVACY.1 is a prefix substring but a DIFFERENT token.
  const diff: StructuredDiff = {
    files: [
      diffFile("src/privacy/secrets.ts", [
        "// implements review-surfaces.PRIVACY.10",
        "// not a token: review-surfaces.PRIVACY.1beta"
      ])
    ]
  };
  const model = buildPrScope(
    input({
      collection: collectionStub([{ path: "src/privacy/secrets.ts", status: "M" }]),
      intent: intentModel(requirements),
      diff
    })
  );
  const req = model.affected_requirements.find((entry) => entry.requirement_id === "REQ-001");
  // It is still scoped via changed_path_requirement_group (the file maps to PRIVACY),
  // but must NOT claim an exact_acid_in_diff match against the PRIVACY.10 token.
  assert.ok(!req?.reasons.some((reason) => reason.rule === "exact_acid_in_diff"), "PRIVACY.1 must not match the PRIVACY.10 token");
});

test("exact_acid_in_diff does NOT fire when the acai_id is only on an unchanged CONTEXT line", () => {
  const requirements = [
    requirement({ id: "REQ-001", acai_id: "review-surfaces.PRIVACY.2", requirement: "Redact secrets." })
  ];
  // The ACID appears only on a context (unchanged) line; the actual added line does not.
  const ctxDiff: StructuredDiffFile = {
    path: "src/privacy/secrets.ts",
    status: "M",
    hunks: [
      {
        old_start: 10,
        old_lines: 2,
        new_start: 10,
        new_lines: 2,
        lines: [
          { kind: "context", text: "// implements review-surfaces.PRIVACY.2", old_line: 10, new_line: 10 },
          { kind: "add", text: "const unrelated = 1;", new_line: 11 }
        ]
      }
    ]
  };
  const model = buildPrScope(
    input({
      collection: collectionStub([{ path: "src/privacy/secrets.ts", status: "M" }]),
      intent: intentModel(requirements),
      diff: { files: [ctxDiff] }
    })
  );
  const req = model.affected_requirements.find((entry) => entry.requirement_id === "REQ-001");
  // It is still scoped via changed_path_requirement_group (the impl file maps to PRIVACY),
  // but must NOT carry a high-confidence exact_acid_in_diff reason from the context line.
  assert.ok(!req?.reasons.some((reason) => reason.rule === "exact_acid_in_diff"), "context-line ACID must not fire exact_acid_in_diff");
});

test("a renamed file carries its old_path into the scoped changed file", () => {
  const renameDiff: StructuredDiffFile = {
    path: "src/intent/new-name.ts",
    old_path: "src/intent/old-name.ts",
    status: "R",
    hunks: []
  };
  const model = buildPrScope(
    input({
      collection: collectionStub([{ path: "src/intent/new-name.ts", status: "R" }]),
      diff: { files: [renameDiff] }
    })
  );
  const file = model.changed_files.find((entry) => entry.path === "src/intent/new-name.ts");
  assert.equal(file?.old_path, "src/intent/old-name.ts");
});

test("a mapped CONFIG/SCHEMA file (no ACID literal) scopes its group's requirements", () => {
  const schemaArea: ReviewArea = {
    id: "SUB-SCHEMA",
    name: "Schema",
    groupKey: "SCHEMA",
    prefixes: ["schemas/"],
    purpose: "Review packet JSON schema.",
    pattern: "schema",
    testKeywords: ["schema"]
  };
  const requirements = [
    requirement({ id: "REQ-001", acai_id: "review-surfaces.SCHEMA.1", requirement: "Packet matches the schema." })
  ];
  // A changed schema file with NO acai_id text in its diff — only the path mapping.
  const diff: StructuredDiff = {
    files: [diffFile("schemas/review_packet.schema.json", ['  "added": true'])]
  };
  const model = buildPrScope(
    input({
      reviewAreas: [schemaArea],
      collection: collectionStub([{ path: "schemas/review_packet.schema.json", status: "M" }]),
      intent: intentModel(requirements),
      diff
    })
  );

  // The schema file is classified config but still maps to the SCHEMA area.
  const schemaFile = model.changed_files.find((file) => file.path === "schemas/review_packet.schema.json");
  assert.equal(schemaFile?.role, "config");
  assert.deepEqual(schemaFile?.areas, ["SCHEMA"]);
  // Its requirement is in scope via changed_path_requirement_group (not zero).
  const req = model.affected_requirements.find((entry) => entry.requirement_id === "REQ-001");
  assert.ok(req, "a mapped config/schema change must scope its group's requirements");
  assert.ok(req?.reasons.some((reason) => reason.rule === "changed_path_requirement_group"));
});

test("an unmapped changed file lands in out_of_scope_changed_files", () => {
  const model = buildPrScope(
    input({
      collection: collectionStub([
        { path: "scripts/release.sh", status: "A" },
        { path: "pnpm-lock.yaml", status: "M" }
      ]),
      diff: {
        files: [
          diffFile("scripts/release.sh", ["echo release"]),
          diffFile("pnpm-lock.yaml", ["+ dep"])
        ]
      }
    })
  );

  const unmapped = model.out_of_scope_changed_files;
  const byPath = new Map(unmapped.map((entry) => [entry.path, entry.reason]));
  assert.equal(byPath.get("scripts/release.sh"), "unmapped");
  assert.equal(byPath.get("pnpm-lock.yaml"), "generated");

  // Unmapped files contribute no affected areas.
  assert.deepEqual(model.affected_areas, []);
  // Generated lockfile is classified as generated, not unknown.
  const lock = model.changed_files.find((file) => file.path === "pnpm-lock.yaml");
  assert.equal(lock?.role, "generated");
});

test("changed_test_group fires for a test file mapping to a group with no exact acid", () => {
  const requirements = [
    requirement({
      id: "REQ-001",
      acai_id: "review-surfaces.PRIVACY.2",
      requirement: "Redact secrets."
    })
  ];
  // A test file under tests/ matched by the PRIVACY test keyword, with NO acid
  // text in its diff lines.
  const diff: StructuredDiff = {
    files: [diffFile("tests/privacy.test.ts", ["assert.ok(redacted);"])]
  };
  const model = buildPrScope(
    input({
      collection: collectionStub([{ path: "tests/privacy.test.ts", status: "M" }]),
      intent: intentModel(requirements),
      diff
    })
  );

  const req = model.affected_requirements[0];
  assert.ok(req);
  const rules = req.reasons.map((reason) => reason.rule);
  assert.ok(rules.includes("changed_test_group"));
  assert.ok(!rules.includes("changed_test_exact_acid"));
});

test("output is deterministic: lists sorted and reasons deduped", () => {
  const requirements = [
    requirement({ id: "REQ-002", acai_id: "review-surfaces.PRIVACY.2", requirement: "B." }),
    requirement({ id: "REQ-001", acai_id: "review-surfaces.INTENT.1", requirement: "A." })
  ];
  const diff: StructuredDiff = {
    files: [
      diffFile("src/privacy/secrets.ts", ["// review-surfaces.PRIVACY.2", "// review-surfaces.PRIVACY.2 again"]),
      diffFile("src/intent/intent.ts", ["// review-surfaces.INTENT.1"])
    ]
  };
  const model = buildPrScope(
    input({
      collection: collectionStub([
        { path: "src/privacy/secrets.ts", status: "M" },
        { path: "src/intent/intent.ts", status: "M" }
      ]),
      intent: intentModel(requirements),
      diff
    })
  );

  // changed_files sorted by path.
  assert.deepEqual(
    model.changed_files.map((file) => file.path),
    ["src/intent/intent.ts", "src/privacy/secrets.ts"]
  );
  // affected_areas sorted by group_key.
  assert.deepEqual(
    model.affected_areas.map((area) => area.group_key),
    ["INTENT", "PRIVACY"]
  );
  // affected_requirements sorted by requirement_id.
  assert.deepEqual(
    model.affected_requirements.map((req) => req.requirement_id),
    ["REQ-001", "REQ-002"]
  );

  // Duplicate acid lines on one path collapse to a single exact_acid_in_diff
  // reason. Confirm at most one exact reason per path.
  const privacyReq = model.affected_requirements.find((req) => req.requirement_id === "REQ-002");
  const exactReasons = privacyReq?.reasons.filter((reason) => reason.rule === "exact_acid_in_diff") ?? [];
  assert.equal(exactReasons.length, 1, "first-acid-line scan yields one exact reason per file");

  // base/head metadata carried through from collection.git.
  assert.equal(model.base_ref, "main");
  assert.equal(model.head_ref, "feature");
  assert.equal(model.base_sha, "base000");
  assert.equal(model.head_sha, "head111");
  assert.equal(model.diff_source, "range");
});
