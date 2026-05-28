export const REQUIREMENT_STATUSES = ["satisfied", "partial", "missing", "unknown", "invalid_evidence"] as const;

export type RequirementStatusCount = Record<(typeof REQUIREMENT_STATUSES)[number], number>;

export function countRequirementStatuses(results: Array<{ status: string }>): RequirementStatusCount {
  const counts = Object.fromEntries(REQUIREMENT_STATUSES.map((status) => [status, 0])) as RequirementStatusCount;
  for (const result of results) {
    if (result.status in counts) {
      counts[result.status as keyof RequirementStatusCount] += 1;
    }
  }
  return counts;
}

export function formatRequirementStatusSummary(counts: RequirementStatusCount, overreachCount: number): string {
  return `${counts.satisfied} satisfied, ${counts.partial} partial, ${counts.missing} missing, ${counts.unknown} unknown, ${counts.invalid_evidence} invalid evidence, ${overreachCount} overreach item(s)`;
}
