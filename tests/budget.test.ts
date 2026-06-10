import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPlan, parseBudgetDuration } from "../src/human/budget";
import type { ReviewQueueItem } from "../src/human/contract";

function item(over: Partial<ReviewQueueItem>): ReviewQueueItem {
  return {
    id: "Q",
    rank: 1,
    title: "t",
    path: "src/a.ts",
    reviewer_action: "act",
    reason: "r",
    ranking_reasons: ["well-evidenced: focused tests changed and pass"],
    evidence: [],
    requirement_ids: [],
    risk_ids: [],
    confidence: "medium",
    priority: "medium",
    ...over
  };
}

test("review-surfaces.BUDGET.1 parses 15m, 1h, 1h30m durations and rejects junk", () => {
  assert.equal(parseBudgetDuration("15m"), 15);
  assert.equal(parseBudgetDuration("1h"), 60);
  assert.equal(parseBudgetDuration("1h30m"), 90);
  assert.equal(parseBudgetDuration("90m"), 90);
  assert.equal(parseBudgetDuration("fast"), undefined);
  assert.equal(parseBudgetDuration("0m"), undefined);
  assert.equal(parseBudgetDuration(undefined), undefined);
});

test("review-surfaces.BUDGET.1 no budget yields a disabled plan (config default off)", () => {
  const plan = buildReviewPlan([item({})], undefined, undefined);
  assert.deepEqual(plan, { enabled: false, read: [], skim: [], defer: [] });
});

test("review-surfaces.BUDGET.2 greedy fill: read to ~70%, skim to 100%, defer with the evidence reason", () => {
  const queue = Array.from({ length: 10 }, (_, i) => item({ id: `Q${i + 1}`, rank: i + 1, path: `src/f${i + 1}.ts` }));
  // No diff -> each medium item costs 2 min. Budget 10m: read ceiling 7m -> 3 reads
  // (6m); skim cost 1m each -> 4 skims to 10m; rest deferred.
  const plan = buildReviewPlan(queue, undefined, 10);
  assert.equal(plan.enabled, true);
  assert.equal(plan.budget_minutes, 10);
  assert.equal(plan.read.length, 3);
  assert.equal(plan.skim.length, 4);
  assert.equal(plan.defer.length, 3);
  // Deferral carries the item's evidence-score reason.
  assert.match(plan.defer[0].reason ?? "", /well-evidenced/);
  // Whole-minute estimates.
  for (const entry of [...plan.read, ...plan.skim, ...plan.defer]) {
    assert.equal(Number.isInteger(entry.estimated_minutes), true);
  }
});

test("review-surfaces.BUDGET.2 blocker items are budget-exempt and never deferred", () => {
  const queue = [
    item({ id: "Q1", rank: 1, priority: "high" }),
    item({ id: "Q2", rank: 2 }),
    item({ id: "QB", rank: 3, priority: "blocker", path: "src/blocked.ts" })
  ];
  // A 1-minute budget would defer everything deferable — but never the blocker.
  const plan = buildReviewPlan(queue, undefined, 1);
  assert.ok(plan.read.some((entry) => entry.queue_item_id === "QB" && /budget-exempt/.test(entry.reason ?? "")));
  assert.ok(!plan.defer.some((entry) => entry.queue_item_id === "QB"));
});

test("review-surfaces.BUDGET.2 blocker time is OUTSIDE the budget (does not squeeze later items)", () => {
  // Budget 4m: the blocker (3m, exempt) must not consume capacity — both
  // non-blocker items (2m each, ceiling 2.8 -> first read, second skims).
  const queue = [
    item({ id: "QB", rank: 1, priority: "blocker" }),
    item({ id: "Q1", rank: 2 }),
    item({ id: "Q2", rank: 3 })
  ];
  const plan = buildReviewPlan(queue, undefined, 4);
  assert.ok(plan.read.some((e) => e.queue_item_id === "QB"));
  assert.ok(plan.read.some((e) => e.queue_item_id === "Q1"), "blocker cost must not displace Q1 from read");
  assert.equal(plan.defer.length, 0);
});

test("review-surfaces.BUDGET.1 renamed-file old-path anchors use the real changed-line count", () => {
  const diff = {
    files: [
      {
        path: "src/new.ts",
        old_path: "src/old.ts",
        status: "R",
        hunks: [
          {
            old_start: 1,
            old_lines: 40,
            new_start: 1,
            new_lines: 40,
            lines: Array.from({ length: 40 }, (_, i) => ({ kind: "add" as const, text: "x", new_line: i + 1 }))
          }
        ]
      }
    ]
  };
  const viaOldPath = buildReviewPlan([item({ path: "src/old.ts", priority: "high" })], diff, 60).read[0];
  // (2 + 40*0.1) * 1.5 = 9 — not the base cost.
  assert.equal(viaOldPath.estimated_minutes, 9);
});

test("review-surfaces.BUDGET.1 per-item cost scales with changed hunk lines and risk class weight", () => {
  const diff = {
    files: [
      {
        path: "src/big.ts",
        status: "M",
        hunks: [
          {
            old_start: 1,
            old_lines: 0,
            new_start: 1,
            new_lines: 40,
            lines: Array.from({ length: 40 }, (_, i) => ({ kind: "add" as const, text: "x", new_line: i + 1 }))
          }
        ]
      }
    ]
  };
  const cheap = buildReviewPlan([item({ priority: "low", path: "src/small.ts" })], diff, 60).read[0];
  const costly = buildReviewPlan([item({ priority: "high", path: "src/big.ts" })], diff, 60).read[0];
  // base 2 * 0.75 -> 2; (2 + 40*0.1=6) * 1.5 -> 9.
  assert.equal(cheap.estimated_minutes, 2);
  assert.equal(costly.estimated_minutes, 9);
});

test("review-surfaces.BUDGET.2 deterministic: identical inputs produce identical plans", () => {
  const queue = Array.from({ length: 6 }, (_, i) => item({ id: `Q${i}`, rank: i + 1, path: `src/p${i}.ts` }));
  assert.deepEqual(buildReviewPlan(queue, undefined, 12), buildReviewPlan(queue, undefined, 12));
});
