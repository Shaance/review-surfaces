import { PR_RISK_RULES, PrRiskRule } from "./contract";

export interface PrRiskRuleMetadata {
  title: string;
  review_queue_weight: number;
}

export const PR_RISK_RULE_METADATA: Record<PrRiskRule, PrRiskRuleMetadata> = {
  coverage_regression: {
    title: "Coverage regression",
    review_queue_weight: 75
  },
  untested_changed_impl: {
    title: "Untested implementation change",
    review_queue_weight: 45
  },
  unmapped_change: {
    title: "Unmapped changed file",
    review_queue_weight: 25
  },
  privacy_sensitive_change: {
    title: "Privacy-sensitive change",
    review_queue_weight: 85
  },
  comment_surface_change: {
    title: "Reviewer surface change",
    review_queue_weight: 50
  },
  ci_secret_boundary_change: {
    title: "CI secret-boundary change",
    review_queue_weight: 90
  },
  schema_contract_change: {
    title: "Schema contract change",
    review_queue_weight: 65
  },
  deleted_or_renamed_surface: {
    title: "Deleted or renamed surface",
    review_queue_weight: 35
  },
  failed_or_skipped_test: {
    title: "Failed or skipped tests",
    review_queue_weight: 80
  },
  large_diff: {
    title: "Large diff",
    review_queue_weight: 20
  }
};

const PR_RISK_RULE_PRIORITY = new Map<PrRiskRule, number>(PR_RISK_RULES.map((rule, index) => [rule, index]));

export function prRiskRulePriority(rule: PrRiskRule): number {
  return PR_RISK_RULE_PRIORITY.get(rule) ?? PR_RISK_RULES.length;
}
