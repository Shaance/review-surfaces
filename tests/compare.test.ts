import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { comparePackets, loadPreviousPacket, resolvePreviousPacketPath, PreviousPacket } from "../src/dogfood/compare";
import { buildDogfood } from "../src/dogfood/dogfood";
import { CollectionResult } from "../src/collector/collect";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { MethodologyModel } from "../src/methodology/methodology";
import { RisksModel } from "../src/risks/risks";
import { validateJsonSchema } from "../src/schema/json-schema";

// review-surfaces.DOGFOOD.7 / CLI.6: deterministic previous-packet comparison.

function previousPacketJson(): unknown {
  return {
    schema_version: "review-surfaces.packet.v1",
    evaluation: {
      summary: "previous",
      results: [
        { requirement_id: "R1", acai_id: "review-surfaces.A.1", status: "missing", summary: "was missing" },
        { requirement_id: "R2", acai_id: "review-surfaces.B.2", status: "satisfied", summary: "was satisfied" },
        { requirement_id: "R3", acai_id: "review-surfaces.C.3", status: "partial", summary: "unchanged" }
      ],
      overreach: [
        {
          requirement_id: "OVERREACH-001",
          status: "overreach",
          summary: "unmapped",
          evidence: [{ kind: "file", path: "src/old-overreach.ts", confidence: "medium" }]
        }
      ],
      acai_coverage: {}
    },
    risks: {
      summary: "previous risks",
      items: [
        { id: "RISK-001", category: "correctness", severity: "high", summary: "Stays risky" },
        { id: "RISK-002", category: "testing", severity: "medium", summary: "Goes away" }
      ]
    }
  };
}

function currentEvaluation(): EvaluationModel {
  return {
    summary: "current",
    results: [
      // improved: missing -> satisfied
      { requirement_id: "R1", acai_id: "review-surfaces.A.1", status: "satisfied", summary: "now satisfied", evidence: [], missing_evidence: [], review_focus: "", confidence: "high" },
      // regressed: satisfied -> partial
      { requirement_id: "R2", acai_id: "review-surfaces.B.2", status: "partial", summary: "now partial", evidence: [], missing_evidence: [], review_focus: "", confidence: "medium" },
      // unchanged: partial -> partial (not reported)
      { requirement_id: "R3", acai_id: "review-surfaces.C.3", status: "partial", summary: "still partial", evidence: [], missing_evidence: [], review_focus: "", confidence: "medium" }
    ],
    overreach: [
      {
        requirement_id: "OVERREACH-001",
        status: "overreach",
        summary: "unmapped",
        evidence: [{ kind: "file", path: "src/new-overreach.ts", confidence: "medium" }],
        missing_evidence: [],
        review_focus: "",
        confidence: "medium"
      }
    ],
    acai_coverage: {}
  };
}

function currentRisks(): Pick<RisksModel, "items"> {
  return {
    items: [
      { id: "RISK-001", category: "correctness", severity: "high", summary: "Stays risky" },
      { id: "RISK-003", category: "security", severity: "high", summary: "Brand new risk" }
    ]
  };
}

test("review-surfaces.CLI.6 comparePackets reports improved/regressed status changes sorted by acai_id", () => {
  const previous = loadPreviousPacketFrom(previousPacketJson());
  const comparison = comparePackets(previous, { evaluation: currentEvaluation(), risks: currentRisks() });

  // Only CHANGED entries, sorted by acai_id (A.1 before B.2; C.3 unchanged omitted).
  assert.deepEqual(
    comparison.status_changes.map((change) => change.acai_id),
    ["review-surfaces.A.1", "review-surfaces.B.2"]
  );
  const improved = comparison.status_changes.find((change) => change.acai_id === "review-surfaces.A.1");
  assert.equal(improved?.previous_status, "missing");
  assert.equal(improved?.current_status, "satisfied");
  assert.equal(improved?.direction, "improved");

  const regressed = comparison.status_changes.find((change) => change.acai_id === "review-surfaces.B.2");
  assert.equal(regressed?.previous_status, "satisfied");
  assert.equal(regressed?.current_status, "partial");
  assert.equal(regressed?.direction, "regressed");
});

test("review-surfaces.CLI.6 comparePackets reports new/resolved risks and overreach by stable key", () => {
  const previous = loadPreviousPacketFrom(previousPacketJson());
  const comparison = comparePackets(previous, { evaluation: currentEvaluation(), risks: currentRisks() });

  // Risks are keyed by the STABLE category + summary (NOT the generated id).
  assert.deepEqual(comparison.new_risks, ["security: Brand new risk"]);
  assert.deepEqual(comparison.resolved_risks, ["testing: Goes away"]);
  assert.deepEqual(comparison.new_overreach, ["src/new-overreach.ts"]);
  assert.deepEqual(comparison.resolved_overreach, ["src/old-overreach.ts"]);
});

test("review-surfaces.CLI.6 inserting an EARLIER risk does not report unchanged later risks as new/resolved", () => {
  // Risk ids are assigned by insertion order, so adding a new FIRST risk shifts
  // every later id (RISK-001 -> RISK-002, etc.). Keying on the generated id used
  // to report the unchanged later risks as BOTH new and resolved; keying on the
  // stable category + summary must not.
  const previous = loadPreviousPacketFrom({
    schema_version: "review-surfaces.packet.v1",
    evaluation: { summary: "p", results: [], overreach: [], acai_coverage: {} },
    risks: {
      summary: "previous",
      items: [
        { id: "RISK-001", category: "correctness", severity: "high", summary: "Existing risk A" },
        { id: "RISK-002", category: "testing", severity: "medium", summary: "Existing risk B" }
      ]
    }
  });
  // A new risk is inserted FIRST, renumbering A and B to RISK-002 / RISK-003.
  const current: Pick<RisksModel, "items"> = {
    items: [
      { id: "RISK-001", category: "security", severity: "high", summary: "Brand new earlier risk" },
      { id: "RISK-002", category: "correctness", severity: "high", summary: "Existing risk A" },
      { id: "RISK-003", category: "testing", severity: "medium", summary: "Existing risk B" }
    ]
  };
  const comparison = comparePackets(previous, { evaluation: currentEvaluation(), risks: current });

  // ONLY the genuinely new risk is reported as new; nothing is resolved.
  assert.deepEqual(comparison.new_risks, ["security: Brand new earlier risk"]);
  assert.deepEqual(comparison.resolved_risks, []);
});

test("review-surfaces.DOGFOOD.7 missing -> invalid_evidence is a REGRESSION (invalid_evidence is worse than missing/unknown)", () => {
  const previous = loadPreviousPacketFrom({
    schema_version: "review-surfaces.packet.v1",
    evaluation: {
      summary: "p",
      results: [
        { requirement_id: "R1", acai_id: "review-surfaces.A.1", status: "missing", summary: "was missing" },
        { requirement_id: "R2", acai_id: "review-surfaces.B.2", status: "unknown", summary: "was unknown" }
      ],
      overreach: [],
      acai_coverage: {}
    },
    risks: { summary: "r", items: [] }
  });
  const current: EvaluationModel = {
    summary: "c",
    results: [
      // missing -> invalid_evidence: a claim went from absent to actively untrustworthy.
      { requirement_id: "R1", acai_id: "review-surfaces.A.1", status: "invalid_evidence", summary: "now invalid", evidence: [], missing_evidence: [], review_focus: "", confidence: "low" },
      // unknown -> invalid_evidence: same direction.
      { requirement_id: "R2", acai_id: "review-surfaces.B.2", status: "invalid_evidence", summary: "now invalid", evidence: [], missing_evidence: [], review_focus: "", confidence: "low" }
    ],
    overreach: [],
    acai_coverage: {}
  };
  const comparison = comparePackets(previous, { evaluation: current, risks: { items: [] } });

  const a = comparison.status_changes.find((change) => change.acai_id === "review-surfaces.A.1");
  assert.equal(a?.previous_status, "missing");
  assert.equal(a?.current_status, "invalid_evidence");
  assert.equal(a?.direction, "regressed");

  const b = comparison.status_changes.find((change) => change.acai_id === "review-surfaces.B.2");
  assert.equal(b?.direction, "regressed");

  // And leaving invalid_evidence (invalid_evidence -> missing) is an improvement.
  const wasInvalid = loadPreviousPacketFrom({
    schema_version: "review-surfaces.packet.v1",
    evaluation: {
      summary: "p",
      results: [{ requirement_id: "R1", acai_id: "review-surfaces.A.1", status: "invalid_evidence", summary: "was invalid" }],
      overreach: [],
      acai_coverage: {}
    },
    risks: { summary: "r", items: [] }
  });
  const nowMissing: EvaluationModel = {
    summary: "c",
    results: [{ requirement_id: "R1", acai_id: "review-surfaces.A.1", status: "missing", summary: "now missing", evidence: [], missing_evidence: [], review_focus: "", confidence: "low" }],
    overreach: [],
    acai_coverage: {}
  };
  const leaving = comparePackets(wasInvalid, { evaluation: nowMissing, risks: { items: [] } });
  const leavingChange = leaving.status_changes.find((change) => change.acai_id === "review-surfaces.A.1");
  assert.equal(leavingChange?.direction, "improved");
});

test("review-surfaces.CLI.6 comparePackets reports count deltas before vs after", () => {
  const previous = loadPreviousPacketFrom(previousPacketJson());
  const comparison = comparePackets(previous, { evaluation: currentEvaluation(), risks: currentRisks() });

  // previous results: missing=1, satisfied=1, partial=1
  // current results:  satisfied=1, partial=2
  assert.deepEqual(comparison.count_deltas.satisfied, { before: 1, after: 1, delta: 0 });
  assert.deepEqual(comparison.count_deltas.partial, { before: 1, after: 2, delta: 1 });
  assert.deepEqual(comparison.count_deltas.missing, { before: 1, after: 0, delta: -1 });
  assert.deepEqual(comparison.count_deltas.unknown, { before: 0, after: 0, delta: 0 });
  assert.deepEqual(comparison.count_deltas.invalid_evidence, { before: 0, after: 0, delta: 0 });
});

test("review-surfaces.CLI.6 comparison is deterministic across repeated runs", () => {
  const previous = loadPreviousPacketFrom(previousPacketJson());
  const first = comparePackets(previous, { evaluation: currentEvaluation(), risks: currentRisks() });
  const second = comparePackets(previous, { evaluation: currentEvaluation(), risks: currentRisks() });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("review-surfaces.CLI.6 loadPreviousPacket resolves a directory and an absent path", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-compare-"));
  const packetPath = path.join(tmp, "review_packet.json");
  fs.writeFileSync(packetPath, JSON.stringify(previousPacketJson()));

  // Directory resolves to its review_packet.json.
  assert.equal(resolvePreviousPacketPath(tmp, "."), packetPath);
  const loadedFromDir = loadPreviousPacket(resolvePreviousPacketPath(tmp, "."));
  assert.ok(loadedFromDir);
  assert.equal(loadedFromDir?.evaluation.results.length, 3);

  // Explicit .json file path is used as-is.
  const loadedFromFile = loadPreviousPacket(resolvePreviousPacketPath(tmp, "review_packet.json"));
  assert.ok(loadedFromFile);
});

test("review-surfaces.CLI.6 absent or unreadable previous packet is a clean no-op", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-compare-noop-"));

  // Absent file.
  assert.equal(loadPreviousPacket(path.join(tmp, "missing", "review_packet.json")), null);

  // Unreadable (malformed JSON) file.
  const badPath = path.join(tmp, "bad.json");
  fs.writeFileSync(badPath, "{ not valid json");
  assert.equal(loadPreviousPacket(badPath), null);

  // Syntactically-valid JSON whose top-level value is an ARRAY must no-op the
  // same way malformed JSON does. Without an Array.isArray guard it would slip
  // past the object check and fabricate an "everything improved" comparison
  // against a phantom empty baseline.
  const arrayPath = path.join(tmp, "array.json");
  fs.writeFileSync(arrayPath, "[1,2,3]");
  assert.equal(loadPreviousPacket(arrayPath), null);

  // A top-level primitive (number/string) is likewise a clean no-op.
  const numberPath = path.join(tmp, "number.json");
  fs.writeFileSync(numberPath, "42");
  assert.equal(loadPreviousPacket(numberPath), null);

  // FINDING C (round 3): a valid JSON OBJECT that is NOT a review packet (e.g.
  // package.json or manifest.json) must be the SAME clean no-op as the
  // array/primitive cases. Without a packet-shape guard its absent
  // evaluation/risks normalize to an empty baseline and the comparison falsely
  // reports everything as improved/new against a phantom baseline.
  const packageJsonPath = path.join(tmp, "package.json");
  fs.writeFileSync(packageJsonPath, JSON.stringify({ name: "some-pkg", version: "1.0.0", scripts: { build: "tsc" } }));
  assert.equal(loadPreviousPacket(packageJsonPath), null, "a non-packet JSON object must be a clean no-op");

  // A review-surfaces manifest.json (has tool_version/signature, no packet shape)
  // is likewise rejected as an unreadable baseline.
  const manifestPath = path.join(tmp, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ tool_version: "0.1.0", head_sha: "abc", input_hashes: [], signature: "deadbeef" }));
  assert.equal(loadPreviousPacket(manifestPath), null, "a manifest.json must be a clean no-op");

  // buildDogfood without comparison input carries no comparison metadata.
  const dogfood = buildDogfood(collectionFixture(), currentEvaluation() as EvaluationModel, risksFixture(), methodologyFixture(), "mock", []);
  assert.equal(dogfood.comparison, undefined);
  assert.equal(dogfood.previous_packet_path, undefined);
});

// FINDING C (round 3): a --previous-packet pointing at a non-packet JSON object
// must produce NO comparison (loadPreviousPacket returns null), NOT a fabricated
// "all current requirements improved-from-missing / all risks new" diff.
test("review-surfaces.CLI.6 a non-packet JSON object yields no comparison (not all-improvements)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-compare-nonpacket-"));
  try {
    const packageJsonPath = path.join(tmp, "package.json");
    fs.writeFileSync(packageJsonPath, JSON.stringify({ name: "x", version: "1.0.0", dependencies: { foo: "^1" } }));

    // The loader treats it as an unreadable baseline (no-op).
    assert.equal(loadPreviousPacket(packageJsonPath), null);

    // Sanity: a genuine packet at the SAME shape WOULD load and (as a phantom
    // empty baseline) report improvements. Build that phantom baseline explicitly
    // and confirm the no-op path produces nothing like it.
    const phantom = loadPreviousPacketFrom({
      schema_version: "review-surfaces.packet.v1",
      evaluation: { summary: "", results: [], overreach: [], acai_coverage: {} },
      risks: { summary: "", items: [] }
    });
    const fabricated = comparePackets(phantom, { evaluation: currentEvaluation(), risks: currentRisks() });
    // The fabricated comparison against an empty baseline reports current entries
    // as new/improved; the non-packet path must NOT do this (it returns null), so
    // there is no comparison object at all.
    assert.ok(fabricated.status_changes.length > 0, "an empty phantom baseline DOES fabricate improvements (control)");
    assert.equal(loadPreviousPacket(packageJsonPath), null, "the non-packet object must never produce a comparison");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.CLI.6 buildDogfood records previous_packet_path when previous packet was unreadable", () => {
  const dogfood = buildDogfood(collectionFixture(), currentEvaluation() as EvaluationModel, risksFixture(), methodologyFixture(), "mock", [], {
    previous_packet_path: ".review-surfaces/prev/review_packet.json"
  });
  assert.equal(dogfood.previous_packet_path, ".review-surfaces/prev/review_packet.json");
  assert.equal(dogfood.comparison, undefined);
  assert.match(dogfood.summary, /absent or unreadable/);
});

test("review-surfaces.CLI.6 buildDogfood embeds the comparison and summarizes it", () => {
  const previous = loadPreviousPacketFrom(previousPacketJson());
  const comparison = comparePackets(previous, { evaluation: currentEvaluation(), risks: currentRisks() });
  const dogfood = buildDogfood(collectionFixture(), currentEvaluation() as EvaluationModel, risksFixture(), methodologyFixture(), "mock", [], {
    previous_packet_path: ".review-surfaces/prev/review_packet.json",
    comparison
  });

  assert.equal(dogfood.previous_packet_path, ".review-surfaces/prev/review_packet.json");
  assert.deepEqual(dogfood.comparison, comparison);
  assert.match(dogfood.summary, /1 improved, 1 regressed/);
  assert.match(dogfood.summary, /1 new risk\(s\), 1 resolved risk\(s\)/);
});

test("review-surfaces.SCHEMA.3 ajv validates a dogfood packet carrying a comparison", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "review_packet.schema.json"), "utf8"));
  const previous = loadPreviousPacketFrom(previousPacketJson());
  const comparison = comparePackets(previous, { evaluation: currentEvaluation(), risks: currentRisks() });

  const packet = dogfoodPacketFixture();
  (packet.dogfood as Record<string, unknown>).previous_packet_path = ".review-surfaces/prev/review_packet.json";
  (packet.dogfood as Record<string, unknown>).comparison = comparison;
  (packet.agent_handoff as Record<string, unknown>).changes_since_last_packet = [
    "Compared against .review-surfaces/prev/review_packet.json.",
    "review-surfaces.A.1: missing -> satisfied (improved)"
  ];

  const result = validateJsonSchema(schema, packet);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function loadPreviousPacketFrom(json: unknown): PreviousPacket {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-prev-"));
  const packetPath = path.join(tmp, "review_packet.json");
  fs.writeFileSync(packetPath, JSON.stringify(json));
  const loaded = loadPreviousPacket(packetPath);
  assert.ok(loaded);
  return loaded as PreviousPacket;
}

function collectionFixture(): CollectionResult {
  return { manifest: { milestone: "M5" }, feedback: [] } as unknown as CollectionResult;
}

function risksFixture(): RisksModel {
  return {
    summary: "no risks",
    items: [],
    test_evidence: [],
    test_gaps: [],
    missing_automatic_tests: [],
    missing_manual_checks: [],
    review_focus: []
  };
}

function methodologyFixture(): MethodologyModel {
  return {
    summary: "no logs",
    missing_logs: true,
    considered: [],
    research: [],
    decisions: [],
    unchallenged_assumptions: [],
    skipped_checks: [],
    claims_without_evidence: [],
    verified_claims: [],
    quality_flags: [],
    evidence: []
  };
}

function dogfoodPacketFixture(): {
  schema_version: string;
  manifest: Record<string, unknown>;
  intent: Record<string, unknown>;
  evaluation: Record<string, unknown>;
  architecture: Record<string, unknown>;
  methodology: Record<string, unknown>;
  risks: Record<string, unknown>;
  dogfood: Record<string, unknown>;
  agent_handoff: Record<string, unknown>;
} {
  return {
    schema_version: "review-surfaces.packet.v1",
    manifest: {
      tool_version: "0.1.0",
      created_at: "2026-05-28T00:00:00.000Z",
      repo: "review-surfaces",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "abc",
      uncommitted_files: 0,
      run_mode: "dogfood",
      milestone: "M5",
      input_hashes: []
    },
    intent: { summary: "fixture", spec_mode: "acai", requirements: [] },
    evaluation: { summary: "fixture", results: [], overreach: [], acai_coverage: {} },
    architecture: { summary: "fixture", diagrams: [], diagram_validation: [], subsystems: [], open_questions: [] },
    methodology: {
      summary: "fixture",
      missing_logs: true,
      considered: [],
      research: [],
      decisions: [],
      unchallenged_assumptions: [],
      skipped_checks: [],
      claims_without_evidence: [],
      verified_claims: [],
      quality_flags: [],
      evidence: []
    },
    risks: {
      summary: "fixture",
      items: [],
      test_evidence: [],
      test_gaps: [],
      missing_automatic_tests: [],
      missing_manual_checks: [],
      review_focus: []
    },
    dogfood: {
      milestone: "M5",
      summary: "fixture dogfood",
      findings: []
    },
    agent_handoff: {
      summary: "fixture handoff",
      validation_evidence: [],
      failed_validation: [],
      methodology_flags: [],
      next_tasks: ["inspect"],
      deferrals: []
    }
  };
}
