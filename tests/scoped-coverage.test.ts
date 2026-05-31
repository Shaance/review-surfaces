import test from "node:test";
import assert from "node:assert/strict";
import { buildPrScopedCoverage } from "../src/evaluation/scoped-coverage";
import { EvaluationModel, RequirementResult } from "../src/evaluation/evaluate";
import { PrScopeModel } from "../src/pr/contract";

function result(acaiId: string, status: RequirementResult["status"]): RequirementResult {
  return {
    requirement_id: acaiId,
    acai_id: acaiId,
    status,
    summary: `${acaiId} ${status}`,
    evidence: [],
    missing_evidence: [],
    review_focus: "",
    confidence: "medium"
  };
}

function evaluation(results: RequirementResult[]): EvaluationModel {
  return { summary: "", results, overreach: [], acai_coverage: {} };
}

function scope(acaiIds: string[]): PrScopeModel {
  return {
    base_ref: "origin/main",
    head_ref: "HEAD",
    head_sha: "head",
    diff_source: "range",
    changed_files: [],
    affected_areas: [],
    affected_requirements: acaiIds.map((acai) => ({
      requirement_id: acai,
      acai_id: acai,
      title: acai,
      group_key: acai.split(".")[1],
      reasons: []
    })),
    out_of_scope_changed_files: []
  };
}

test("PR coverage delta reports improved/regressed/unchanged against the base, scoped to affected requirements only", () => {
  const head = evaluation([
    result("x.PRIVACY.2", "satisfied"),
    result("x.PRIVACY.3", "partial"),
    result("x.CLI.1", "partial"),
    result("x.UNRELATED.9", "missing") // not in scope, must be ignored
  ]);
  const base = evaluation([
    result("x.PRIVACY.2", "partial"), // improved
    result("x.PRIVACY.3", "satisfied"), // regressed
    result("x.CLI.1", "partial") // unchanged
  ]);
  const cov = buildPrScopedCoverage({ scope: scope(["x.PRIVACY.2", "x.PRIVACY.3", "x.CLI.1"]), headEvaluation: head, baseEvaluation: base });

  assert.equal(cov.base_available, true);
  assert.equal(cov.in_scope_count, 3, "only the 3 affected requirements, not the whole spec");
  assert.equal(cov.counts.improved, 1);
  assert.equal(cov.counts.regressed, 1);
  assert.equal(cov.counts.unchanged, 1);
  const byId = Object.fromEntries(cov.deltas.map((d) => [d.acai_id, d.delta]));
  assert.equal(byId["x.PRIVACY.2"], "improved");
  assert.equal(byId["x.PRIVACY.3"], "regressed");
  assert.equal(byId["x.CLI.1"], "unchanged");
  assert.ok(!cov.deltas.some((d) => d.acai_id === "x.UNRELATED.9"), "unrelated requirement must not appear");
});

test("PR coverage marks a requirement new when it is absent from a NON-EMPTY base eval", () => {
  // The base evaluation genuinely ran and produced results, just not for x.NEW.1
  // (it did not exist at the base) — so x.NEW.1 is truly new in this PR.
  const head = evaluation([result("x.NEW.1", "partial"), result("x.CLI.1", "satisfied")]);
  const base = evaluation([result("x.CLI.1", "satisfied")]); // x.NEW.1 absent on base
  const cov = buildPrScopedCoverage({ scope: scope(["x.NEW.1", "x.CLI.1"]), headEvaluation: head, baseEvaluation: base });
  assert.equal(cov.base_available, true);
  const byId = Object.fromEntries(cov.deltas.map((d) => [d.acai_id, d]));
  assert.equal(byId["x.NEW.1"].base_status, "absent");
  assert.equal(byId["x.NEW.1"].delta, "new_requirement");
  assert.equal(cov.counts.new_requirement, 1);
});

test("PR coverage treats a successful-but-EMPTY base eval as no baseline (not an all-new masquerade)", () => {
  // A base eval that produced ZERO results is ambiguous (spec predates the base, or
  // the base eval silently degraded). It must NOT be reported as a real baseline that
  // labels every in-scope requirement new_requirement / absent -> satisfied.
  const head = evaluation([result("x.NEW.1", "partial")]);
  const base = evaluation([]); // zero results
  const cov = buildPrScopedCoverage({ scope: scope(["x.NEW.1"]), headEvaluation: head, baseEvaluation: base });
  assert.equal(cov.base_available, false, "empty base eval is not a usable baseline");
  assert.equal(cov.deltas[0].delta, "newly_in_scope");
  assert.equal(cov.counts.new_requirement, 0);
  assert.match(cov.summary, /baseline unavailable/);
});

function scopeWithArea(affectedAcaiIds: string[]): PrScopeModel {
  return {
    base_ref: "origin/main",
    head_ref: "HEAD",
    head_sha: "head",
    diff_source: "range",
    changed_files: [],
    affected_areas: [{ group_key: "PRIVACY", area_ids: ["SUB-PRIVACY"], name: "Privacy", changed_files: [] }],
    affected_requirements: affectedAcaiIds.map((acai) => ({
      requirement_id: acai,
      acai_id: acai,
      title: acai,
      group_key: acai.split(".")[1],
      reasons: []
    })),
    out_of_scope_changed_files: []
  };
}

test("PR coverage reports a removed_requirement for a base requirement deleted from the spec in an affected area", () => {
  const head = evaluation([result("x.PRIVACY.2", "satisfied")]); // x.PRIVACY.5 is gone at head
  const base = evaluation([result("x.PRIVACY.2", "satisfied"), result("x.PRIVACY.5", "satisfied")]);
  const cov = buildPrScopedCoverage({ scope: scopeWithArea(["x.PRIVACY.2"]), headEvaluation: head, baseEvaluation: base });
  const removed = cov.deltas.find((d) => d.acai_id === "x.PRIVACY.5");
  assert.ok(removed, "the deleted requirement appears as a removed_requirement delta");
  assert.equal(removed!.delta, "removed_requirement");
  assert.equal(removed!.base_status, "satisfied");
  assert.equal(removed!.head_status, "absent");
  assert.equal(cov.counts.removed_requirement, 1);
});

test("a base requirement removed OUTSIDE any affected area is NOT reported (only diff-touched removals)", () => {
  const head = evaluation([result("x.PRIVACY.2", "satisfied")]);
  const base = evaluation([result("x.PRIVACY.2", "satisfied"), result("x.UNRELATED.9", "satisfied")]);
  const cov = buildPrScopedCoverage({ scope: scopeWithArea(["x.PRIVACY.2"]), headEvaluation: head, baseEvaluation: base });
  assert.ok(!cov.deltas.some((d) => d.acai_id === "x.UNRELATED.9"), "a removal outside affected areas is not reported");
  assert.equal(cov.counts.removed_requirement, 0);
});

test("PR coverage degrades to current-status when the baseline is unavailable (no whole-spec fallback)", () => {
  const head = evaluation([result("x.CLI.1", "partial"), result("x.CLI.2", "satisfied")]);
  const cov = buildPrScopedCoverage({ scope: scope(["x.CLI.1", "x.CLI.2"]), headEvaluation: head });
  assert.equal(cov.base_available, false);
  assert.equal(cov.in_scope_count, 2);
  assert.ok(cov.deltas.every((d) => d.delta === "newly_in_scope"));
  assert.match(cov.summary, /baseline unavailable/);
});
