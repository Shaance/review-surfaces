import test from "node:test";
import assert from "node:assert/strict";
import { parseAcaiSpec } from "../src/acai/acai";
import { loadConfig } from "../src/config/config";
import { gateDecision } from "../src/core/gate";
import { ExitCodes } from "../src/core/exit-codes";
import type { CollectionResult } from "../src/collector/collect";
import type { EvaluationModel, RequirementResult, RequirementStatus } from "../src/evaluation/evaluate";

// iOS/Swift support uplift (docs/history/IOS_SWIFT_SUPPORT_GOAL.md) Phase 0 —
// spec promotion. These integrity tests assert the uplift is visible to the
// strict gate: every promoted ACID parses, none collides with the live ledger,
// and the allowlist stays well-formed (no duplicate or stale staging) while an
// UNRELATED missing requirement still trips the gate. They are PHASE-ROBUST: as
// later phases ship and unstage their ACIDs, the staged set shrinks toward [] but
// these invariants hold throughout.

const ROOT = process.cwd();
const SPEC = "features/review-surfaces.feature.yaml";

// Every ACID this uplift promotes into the ledger across all phases.
const PROMOTED_ACIDS = [
  "review-surfaces.COLLECTOR.8",
  "review-surfaces.COLLECTOR.9",
  "review-surfaces.SEMANTIC_DIFF.5",
  "review-surfaces.SEMANTIC_DIFF.6",
  "review-surfaces.BLAST_RADIUS.4",
  "review-surfaces.DEP_FACTS.6",
  "review-surfaces.CONFIG_FACTS.4",
  "review-surfaces.CONFIG_FACTS.5",
  "review-surfaces.PRIVACY.8",
  "review-surfaces.EVAL_HARNESS.7",
  "review-surfaces.BENCH.2",
  "review-surfaces.DISTRIBUTION.16"
] as const;

test("review-surfaces Phase 0: the feature parser loads every promoted Swift/iOS ACID", async () => {
  const spec = await parseAcaiSpec(ROOT, SPEC);
  const ledger = new Set(spec.requirements.map((requirement) => requirement.acai_id));
  for (const acid of PROMOTED_ACIDS) {
    assert.ok(ledger.has(acid), `${acid} must be present in the feature ledger`);
  }
});

test("review-surfaces Phase 0: no ACID collides in the live ledger", async () => {
  const spec = await parseAcaiSpec(ROOT, SPEC);
  const ids = spec.requirements.map((requirement) => requirement.acai_id);
  const seen = new Map<string, number>();
  for (const id of ids) {
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  assert.deepEqual(duplicates, [], `every ACID must be unique; duplicates: ${duplicates.join(", ")}`);
});

test("review-surfaces Phase 0: the allowlist has no duplicate or stale staging and max_missing stays 0", async () => {
  const [spec, config] = await Promise.all([parseAcaiSpec(ROOT, SPEC), loadConfig(ROOT)]);
  const ledger = new Set(spec.requirements.map((requirement) => requirement.acai_id));
  const allow = config.quality_gate.allow_missing;
  assert.equal(config.quality_gate.max_missing, 0, "max_missing must stay 0 — allowlist by ACID, never raise the cap");
  // No duplicate staging.
  assert.equal(new Set(allow).size, allow.length, `allow_missing must not contain duplicates: ${allow.join(", ")}`);
  // No stale staging: every entry maps to a real requirement in the ledger.
  for (const entry of allow) {
    assert.ok(ledger.has(entry), `allow_missing entry ${entry} must map to a real ledger requirement`);
  }
  // Each iOS ACID still staged appears exactly once (shipped ones are gone).
  for (const acid of PROMOTED_ACIDS) {
    const count = allow.filter((entry) => entry === acid).length;
    assert.ok(count <= 1, `${acid} must be staged at most once (found ${count})`);
  }
});

// --- gate behavior with the real staged allowlist -------------------------

function requirementResult(status: RequirementStatus, acaiId: string): RequirementResult {
  return {
    requirement_id: acaiId,
    acai_id: acaiId,
    status,
    summary: `status ${status}`,
    evidence: [],
    missing_evidence: [],
    review_focus: "",
    confidence: "medium"
  };
}

function evaluationOf(results: RequirementResult[]): EvaluationModel {
  return { summary: "", results, overreach: [], acai_coverage: {} };
}

const cleanCollection = { privacy: { remote_provider_blocked: false } } as unknown as CollectionResult;

test("review-surfaces Phase 0: a staged ACID missing does NOT trip the gate, but an UNRELATED missing one does", async () => {
  const config = await loadConfig(ROOT);
  const allowMissing = config.quality_gate.allow_missing;
  const options = { maxMissing: config.quality_gate.max_missing, allowMissing };

  // A currently-staged backlog ACID reporting "missing" is excused by the allowlist
  // (skipped only if the backlog is already fully drained at Phase 5).
  if (allowMissing.length > 0) {
    const stagedMissing = evaluationOf([requirementResult("missing", allowMissing[0])]);
    assert.equal(
      gateDecision(stagedMissing, cleanCollection, "mock", options).code,
      ExitCodes.success,
      "an allowlisted backlog ACID being missing must not trip the gate"
    );
  }

  // An UNRELATED requirement regressing to missing is NOT on the allowlist and must
  // still fail — allowlisting a backlog cannot mask a real regression.
  const unrelatedMissing = evaluationOf([
    requirementResult("missing", "review-surfaces.SYNTHETIC_REGRESSION.99")
  ]);
  assert.equal(
    gateDecision(unrelatedMissing, cleanCollection, "mock", options).code,
    ExitCodes.qualityGateFailed,
    "an unrelated missing requirement must still trip the strict gate"
  );
});
