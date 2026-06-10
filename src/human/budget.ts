// review-surfaces.BUDGET.1/.2: time-budgeted review mode. A deterministic,
// deliberately crude post-ranking annotation pass: estimate a per-item review
// cost (base minutes + changed-hunk lines x a per-line factor, weighted by risk
// class, rounded to whole minutes — an estimate, not a promise), then greedily
// fill items by rank order into `read` until ~70% of the budget is consumed,
// `skim` to 100%, and defer the remainder with its evidence reason. Items
// carrying a blocker are budget-exempt and never deferred.
import { StructuredDiff } from "../pr/contract";
import type { ReviewPlan, ReviewPlanItem, ReviewQueueItem } from "./contract";

const BASE_MINUTES = 2;
const MINUTES_PER_LINE = 0.1;
const READ_FILL_RATIO = 0.7;
// Skimming reads the excerpt, not the file: a fixed fraction of the read cost.
const SKIM_COST_RATIO = 0.4;

// Parse "15m", "1h", "1h30m", "90m" into whole minutes. Returns undefined for
// anything else (the caller treats that as a usage error / budget off).
export function parseBudgetDuration(value: string | undefined | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) {
    return undefined;
  }
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  return minutes > 0 ? minutes : undefined;
}

export function emptyReviewPlan(): ReviewPlan {
  return { enabled: false, read: [], skim: [], defer: [] };
}

export function buildReviewPlan(
  queue: ReviewQueueItem[],
  diff: StructuredDiff | undefined,
  budgetMinutes: number | undefined
): ReviewPlan {
  if (!budgetMinutes || budgetMinutes <= 0) {
    return emptyReviewPlan();
  }
  const changedLinesByPath = new Map<string, number>();
  for (const file of diff?.files ?? []) {
    let lines = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== "context") {
          lines += 1;
        }
      }
    }
    changedLinesByPath.set(file.path, lines);
  }

  const read: ReviewPlanItem[] = [];
  const skim: ReviewPlanItem[] = [];
  const defer: ReviewPlanItem[] = [];
  let spent = 0;
  const readCeiling = budgetMinutes * READ_FILL_RATIO;

  for (const item of queue) {
    const cost = estimateMinutes(item, changedLinesByPath.get(item.path) ?? 0);
    const planItem: ReviewPlanItem = { queue_item_id: item.id, path: item.path, estimated_minutes: cost };
    // review-surfaces.BUDGET.2: blockers are budget-exempt — always read.
    if (item.priority === "blocker") {
      read.push({ ...planItem, reason: "carries a blocker; budget-exempt" });
      spent += cost;
      continue;
    }
    // `read.length === 0`: even a too-tight budget reads at least the top item.
    if (spent + cost <= readCeiling || read.length === 0) {
      read.push(planItem);
      spent += cost;
      continue;
    }
    const skimCost = Math.max(1, Math.round(cost * SKIM_COST_RATIO));
    if (spent + skimCost <= budgetMinutes) {
      skim.push({ ...planItem, estimated_minutes: skimCost, reason: "read the excerpt, not the file" });
      spent += skimCost;
      continue;
    }
    defer.push({ ...planItem, reason: item.ranking_reasons[0] ?? "lowest-ranked under the configured budget" });
  }

  return { enabled: true, budget_minutes: budgetMinutes, read, skim, defer };
}

// Deterministic, deliberately crude (BUDGET.1): minutes = base + lines x factor,
// weighted by risk class — contract-grade items read slower than low-churn ones.
function estimateMinutes(item: ReviewQueueItem, changedLines: number): number {
  const weight = item.priority === "blocker" || item.priority === "high" ? 1.5 : item.priority === "low" ? 0.75 : 1;
  return Math.max(1, Math.round((BASE_MINUTES + changedLines * MINUTES_PER_LINE) * weight));
}
