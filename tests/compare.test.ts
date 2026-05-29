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

  assert.deepEqual(comparison.new_risks, ["RISK-003: Brand new risk"]);
  assert.deepEqual(comparison.resolved_risks, ["RISK-002: Goes away"]);
  assert.deepEqual(comparison.new_overreach, ["src/new-overreach.ts"]);
  assert.deepEqual(comparison.resolved_overreach, ["src/old-overreach.ts"]);
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

  // buildDogfood without comparison input carries no comparison metadata.
  const dogfood = buildDogfood(collectionFixture(), currentEvaluation() as EvaluationModel, risksFixture(), methodologyFixture(), "mock", []);
  assert.equal(dogfood.comparison, undefined);
  assert.equal(dogfood.previous_packet_path, undefined);
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
  return { summary: "no risks", items: [], test_evidence: [], test_gaps: [], review_focus: [] };
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
      run_mode: "dogfood",
      milestone: "M5",
      input_hashes: []
    },
    intent: { summary: "fixture", requirements: [] },
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
    risks: { summary: "fixture", items: [], test_evidence: [], test_gaps: [], review_focus: [] },
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
