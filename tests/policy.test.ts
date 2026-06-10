import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  expiredPolicySuppressions,
  loadReviewPolicy,
  matchPolicySeverityOverride,
  matchPolicySuppression,
  PolicyValidationError
} from "../src/feedback/policy";
import { buildHumanReview } from "../src/human/human-review";
import type { ReviewPolicy } from "../src/feedback/policy";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-policy-"));
  fs.mkdirSync(path.join(dir, "schemas"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "schemas", "review_policy.schema.json"), path.join(dir, "schemas", "review_policy.schema.json"));
  return dir;
}

const VALID_POLICY = `schema_version: review-surfaces.policy.v1
suppressions:
  - rule: large_diff
    path_glob: "docs/**"
    reason: Docs-only churn is reviewed by the docs owner.
    expires: "2099-01-01"
severity_overrides:
  - rule: unmapped_change
    priority: high
required_manual_checks:
  - id: POLICY-CHECK-1
    path_patterns: ["src/auth/**"]
    prompt: Run the auth threat-model checklist.
`;

test("review-surfaces.POLICY.1 a valid committed policy loads; suppressions require reason and absolute expiry", () => {
  const dir = tmpRepo();
  try {
    fs.writeFileSync(path.join(dir, "review-surfaces.policy.yaml"), VALID_POLICY);
    const policy = loadReviewPolicy(dir);
    assert.equal(policy?.suppressions?.[0].reason, "Docs-only churn is reviewed by the docs owner.");
    assert.equal(policy?.required_manual_checks?.[0].id, "POLICY-CHECK-1");
    // A suppression without reason/expires fails schema validation LOUDLY.
    fs.writeFileSync(
      path.join(dir, "review-surfaces.policy.yaml"),
      'schema_version: review-surfaces.policy.v1\nsuppressions:\n  - rule: large_diff\n    path_glob: "docs/**"\n'
    );
    assert.throws(() => loadReviewPolicy(dir), PolicyValidationError);
    // Malformed YAML fails loudly too; an absent file is simply no policy.
    fs.writeFileSync(path.join(dir, "review-surfaces.policy.yaml"), "schema_version: [unclosed");
    assert.throws(() => loadReviewPolicy(dir), PolicyValidationError);
    fs.rmSync(path.join(dir, "review-surfaces.policy.yaml"));
    assert.equal(loadReviewPolicy(dir), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review-surfaces.POLICY.2 suppressions match stable keys (rule + path glob) with deterministic expiry", () => {
  const policy: ReviewPolicy = {
    schema_version: "review-surfaces.policy.v1",
    suppressions: [{ rule: "large_diff", path_glob: "docs/**", reason: "r", expires: "2026-01-01" }],
    severity_overrides: [{ rule: "unmapped_change", priority: "high" }]
  };
  const current = matchPolicySuppression(policy, "large_diff", "docs/guide.md", "2025-12-31T00:00:00Z");
  assert.equal(current?.expired, false);
  const expired = matchPolicySuppression(policy, "large_diff", "docs/guide.md", "2026-02-01T00:00:00Z");
  assert.equal(expired?.expired, true);
  // Key mismatches (different rule / non-matching glob) never match.
  assert.equal(matchPolicySuppression(policy, "unmapped_change", "docs/guide.md", "2025-12-31T00:00:00Z"), undefined);
  assert.equal(matchPolicySuppression(policy, "large_diff", "src/main.ts", "2025-12-31T00:00:00Z"), undefined);
  assert.equal(matchPolicySeverityOverride(policy, "unmapped_change", "anything")?.priority, "high");
  assert.equal(expiredPolicySuppressions(policy, "2026-02-01T00:00:00Z").length, 1);
});

// --- integration through buildHumanReview ------------------------------------

import { HUMAN_REVIEW_SCHEMA_VERSION } from "../src/human/contract";

function minimalInputs(): Parameters<typeof buildHumanReview>[0] {
  return {
    packet: {
      manifest: { head_sha: "headsha", base_ref: "origin/main", head_ref: "HEAD", created_at: "2026-06-01T00:00:00Z" },
      intent: { summary: "s", requirements: [], constraints: [], non_goals: [], assumptions: [], open_questions: [], sources: [] },
      evaluation: { summary: "e", results: [], overreach: [], acai_coverage: {} },
      methodology: { summary: "m", considered: [], research: [], decisions: [], unchallenged_assumptions: [], skipped_work: [], quality_flags: [], claims_without_evidence: [] },
      risks: { summary: "r", items: [], test_evidence: [], test_gaps: [], suggested_checks: [], review_focus: [], missing_automatic_tests: [], missing_manual_checks: [] },
      dogfood: undefined,
      agent_handoff: undefined
    } as never,
    prSurface: {
      schema_version: "review-surfaces.pr_review_surface.v1",
      mode: "pr",
      status: "ready",
      scope: {
        base_ref: "origin/main",
        head_ref: "HEAD",
        head_sha: "headsha",
        changed_files: [{ path: "docs/guide.md", status: "M", areas: [], role: "doc" }],
        affected_requirements: [],
        out_of_scope_changed_files: []
      },
      coverage: { base_available: false, summary: "", in_scope_count: 0, deltas: [], counts: { improved: 0, regressed: 0, unchanged: 0, new_requirement: 0, removed_requirement: 0, newly_in_scope: 0 } },
      risks: {
        summary: "1 candidate",
        candidates: [
          {
            id: "PR-RISK-001",
            rule: "large_diff",
            category: "maintainability",
            severity: "medium",
            summary: "Large diff exceeds review threshold.",
            evidence: [{ kind: "file", path: "docs/guide.md", confidence: "medium" }],
            suggested_checks: ["Allocate extra review time."]
          }
        ]
      },
      llm: { required: false, provider: "mock", status: "skipped" }
    } as never
  };
}

test("review-surfaces.POLICY.2 a current suppression demotes and annotates the queue item but never deletes it", () => {
  const inputs = minimalInputs();
  inputs.policy = {
    schema_version: "review-surfaces.policy.v1",
    suppressions: [{ rule: "large_diff", path_glob: "docs/**", reason: "Docs churn reviewed elsewhere.", expires: "2099-01-01" }]
  };
  inputs.policyNowIso = "2026-06-01T00:00:00Z";
  const model = buildHumanReview(inputs);
  const item = model.review_queue.find((entry) => entry.risk_ids.includes("PR-RISK-001"));
  assert.ok(item, "the suppressed item is RETAINED, never deleted");
  assert.equal(item.priority, "low");
  assert.match(item.reason, /Suppressed by policy: Docs churn reviewed elsewhere\./);
  assert.equal(model.schema_version, HUMAN_REVIEW_SCHEMA_VERSION);
});

test("review-surfaces.POLICY.2 an expired suppression does not demote and surfaces as its own finding", () => {
  const inputs = minimalInputs();
  inputs.policy = {
    schema_version: "review-surfaces.policy.v1",
    suppressions: [{ rule: "large_diff", path_glob: "docs/**", reason: "old", expires: "2026-01-01" }]
  };
  inputs.policyNowIso = "2026-06-01T00:00:00Z";
  const model = buildHumanReview(inputs);
  const item = model.review_queue.find((entry) => entry.risk_ids.includes("PR-RISK-001"));
  assert.ok(item && item.priority !== "low", "expired suppressions stop demoting");
  assert.ok(
    model.feedback_effects.some((effect) => effect.kind === "team_policy" && /expired 2026-01-01/.test(effect.summary)),
    "the expired suppression renders as its own finding"
  );
});

test("review-surfaces.POLICY.2 severity overrides re-prioritize matching rules", () => {
  const inputs = minimalInputs();
  inputs.policy = {
    schema_version: "review-surfaces.policy.v1",
    severity_overrides: [{ rule: "large_diff", priority: "blocker" }]
  };
  inputs.policyNowIso = "2026-06-01T00:00:00Z";
  const model = buildHumanReview(inputs);
  const item = model.review_queue.find((entry) => entry.risk_ids.includes("PR-RISK-001"));
  assert.equal(item?.priority, "blocker");
});
