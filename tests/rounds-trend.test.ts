import test from "node:test";
import assert from "node:assert/strict";
import { renderStickySummary } from "../src/render/sticky-summary";
import { buildHumanReview } from "../src/human/human-review";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { HumanReviewModel, HUMAN_REVIEW_SCHEMA_VERSION, RoundsLedgerEntry } from "../src/human/contract";
import { minimalReviewPacket } from "./helpers/review-packet";
import { notAssessedConversationAnalysis } from "../src/conversation/analysis";

function entry(round: number, overrides: Partial<RoundsLedgerEntry> = {}): RoundsLedgerEntry {
  return {
    round,
    head_sha: `sha${round}00000000000000000000000000000000000`,
    new_count: 12 - round,
    resolved_count: round,
    regressed_count: 0,
    verdict: "reviewable_with_attention",
    ...overrides
  };
}

function model(rounds: RoundsLedgerEntry[]): HumanReviewModel {
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: "repo",
    spec_mode: "acai",
    verdict: { decision: "reviewable_with_attention", confidence: "medium", reasons: [] },
    decision_projection: { active_intent: { summary: "Fixture intent.", source: "packet", redaction_blocked: false, requirement_ids: [], event_ids: [] }, findings: [] },
    conversation_analysis: notAssessedConversationAnalysis("mock"),
    review_insights: [],
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    review_queue: [],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: { confidence_summary: "", verified_facts: [], claimed_not_verified: [], missing_evidence: [], invalid_evidence: [] },
    risk_lens_findings: [],
    methodology_audit: { quality_flags: [], considered: [], research: [], workflow_findings: [] },
    intent_mismatch: { expected_by_spec: [], observed_in_diff: [], possible_mismatches: [], possible_overreach: [], missing_intent: [], claimed_candidates: [] },
    since_last_review: {
      improved: [],
      regressed: [],
      new_risks: [],
      resolved_risks: [],
      new_overreach: [],
      resolved_overreach: [],
      still_open: [],
      count_deltas: {
        satisfied: { before: 0, after: 0, delta: 0 },
        partial: { before: 0, after: 0, delta: 0 },
        missing: { before: 0, after: 0, delta: 0 },
        unknown: { before: 0, after: 0, delta: 0 },
        invalid_evidence: { before: 0, after: 0, delta: 0 }
      }
    },
    coverage_evidence: { status: "no_report", files: [] },
    review_plan: { enabled: false, read: [], skim: [], defer: [] },
    change_graph: { nodes: [], halo_nodes: [], edges: [], clusters: [], overview: { groups: [], halo_count: 0, edges: [] } },
    reading_order: { legs: [] },
    rounds,
    evidence_cards: [],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: { packet_path: "review_packet.json", base_ref: "origin/main", head_ref: "HEAD", head_sha: "abc", uncommitted_files: 0 }
  };
}

test("review-surfaces.TREND.1 the ledger appends one row per run with counts from the compare output and works from local prior packets", () => {
  // The builder-level behavior is exercised through buildHumanReview via the
  // CLI in the eval harness; here we pin the carry-forward contract: the model
  // carries the FULL ledger, ordered, with monotonically increasing rounds.
  const rounds = [entry(1), entry(2), entry(3)];
  const fixture = model(rounds);
  assert.deepEqual(fixture.rounds.map((row) => row.round), [1, 2, 3]);
  // Transport-indifference is a property of the input (previousRounds is read
  // from the previous packet's sibling human_review.json regardless of whether
  // that directory came from a CI artifact or pnpm run local-review's
  // .review-surfaces/previous). The reader tolerates malformed input:
  const packetStub = {
    ...(minimalReviewPacket() as unknown as Record<string, unknown>),
    manifest: { base_ref: "origin/main", head_ref: "HEAD", head_sha: "headsha" },
    dogfood: {
      previous_packet_path: "prev/review_packet.json",
      comparison: {
        status_changes: [{ acai_id: "x.A.1", previous_status: "satisfied", current_status: "missing", direction: "regressed" }],
        new_overreach: [],
        resolved_overreach: [],
        new_risks: ["r1", "r2"],
        resolved_risks: ["r3"],
        count_deltas: {}
      }
    }
  } as never;
  const built = buildHumanReview({ packet: packetStub, previousRounds: [entry(1), entry(2)] });
  const last = built.rounds[built.rounds.length - 1];
  assert.equal(built.rounds.length, 3);
  assert.equal(last?.round, 3);
  assert.equal(last?.new_count, 2);
  assert.equal(last?.resolved_count, 1);
  assert.equal(last?.regressed_count, 1);
  assert.equal(last?.verdict, built.verdict.decision);
  // No prior ledger -> first review, a one-row ledger (never an error).
  const first = buildHumanReview({ packet: packetStub });
  assert.equal(first.rounds.length, 1);
  assert.equal(first.rounds[0].round, 1);
});

test("review-surfaces.TREND.2 the rounds ledger stays in the HTML artifact and out of the sticky", () => {
  const longLedger = Array.from({ length: 12 }, (_, index) => entry(index + 3)); // history begins at round 3
  const fixture = model(longLedger);
  const sticky = renderStickySummary(fixture).markdown;
  assert.doesNotMatch(sticky, /### Review rounds|History begins at round|\| Round \|/);
  // A full ledger also remains supporting-only on GitHub.
  const fullLedger = Array.from({ length: 12 }, (_, index) => entry(index + 1));
  const cappedSticky = renderStickySummary(model(fullLedger)).markdown;
  assert.doesNotMatch(cappedSticky, /Review rounds|Showing the last 8 of 12 rounds|expired/);
  // The HTML artifact keeps the bounded, honest history.
  const html = renderHumanReviewHtml(fixture, {});
  assert.match(html, /<h2 id="rounds">Review rounds<\/h2>/);
  assert.match(html, /History begins at round 3/);
  // A single-row ledger is the first review — nothing to trend, never an error.
  const firstSticky = renderStickySummary(model([entry(1)])).markdown;
  assert.doesNotMatch(firstSticky, /### Review rounds/);
  const firstHtml = renderHumanReviewHtml(model([entry(1)]), {});
  assert.match(firstHtml, /First review round — nothing to trend yet/);
});
