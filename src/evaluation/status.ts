// review-surfaces.COLD_START.5: the one-line honest note every surface renders
// instead of zero-count requirement language when no spec is configured.
export const SPEC_NONE_NOTE = "No requirement spec configured — intent checks are limited to docs and constraints.";

import {
  PACKET_REQUIREMENT_STATUSES,
  type PacketRequirementStatus
} from "../schema/review-packet-contract";

type CountedRequirementStatus = Exclude<PacketRequirementStatus, "overreach">;

export const REQUIREMENT_STATUSES = PACKET_REQUIREMENT_STATUSES.filter(
  (status): status is CountedRequirementStatus => status !== "overreach"
);

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
