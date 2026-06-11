// review-surfaces.COVERAGE.6: shared helpers for rendering per-line coverage at
// the excerpt — the HTML cockpit draws a per-line gutter, the markdown surfaces
// render one summary line with the uncovered ranges. Both key off the SAME
// model data (CoverageEvidenceHunk.uncovered_lines), so the surfaces cannot
// disagree. Honest-negative rules apply upstream: no report or a stale report
// never reaches these helpers as line data.
import { CoverageEvidenceHunk, HumanReviewModel } from "./contract";

// Find the coverage hunk matching a queue item's anchor: the file by path, the
// hunk by exact header match, falling back to the only instrumented hunk when
// the file has exactly one (a stale header must not silently mis-attach).
export function coverageHunkForAnchor(model: HumanReviewModel, filePath: string, hunkHeader?: string): CoverageEvidenceHunk | undefined {
  const coverage = model.coverage_evidence;
  if (!coverage || coverage.status !== "report" || coverage.postdates_head === false) {
    return undefined;
  }
  const file = coverage.files.find((candidate) => candidate.path === filePath);
  if (!file) {
    return undefined;
  }
  if (hunkHeader) {
    const exact = file.hunks.find((hunk) => hunk.hunk_header === hunkHeader);
    if (exact) {
      return exact;
    }
  }
  return file.hunks.length === 1 ? file.hunks[0] : undefined;
}

// Compact "L120–L124, L130" range formatting over sorted line numbers.
export function formatUncoveredRanges(lines: number[]): string {
  const ranges: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  for (const line of lines) {
    if (start === undefined || prev === undefined) {
      start = prev = line;
      continue;
    }
    if (line === prev + 1) {
      prev = line;
      continue;
    }
    ranges.push(start === prev ? `L${start}` : `L${start}–L${prev}`);
    start = prev = line;
  }
  if (start !== undefined && prev !== undefined) {
    ranges.push(start === prev ? `L${start}` : `L${start}–L${prev}`);
  }
  return ranges.join(", ");
}

// The one-line markdown summary under an excerpt (COVERAGE.6).
export function coverageSummaryLine(hunk: CoverageEvidenceHunk): string {
  const uncovered = hunk.changed_lines - hunk.covered_lines;
  if (uncovered <= 0) {
    return `all ${hunk.changed_lines} instrumented changed line(s) executed by tests`;
  }
  const ranges = formatUncoveredRanges(hunk.uncovered_lines);
  const truncated = hunk.uncovered_truncated ? " (+ more; list truncated)" : "";
  return `${uncovered} of ${hunk.changed_lines} changed line(s) uncovered: ${ranges}${truncated}`;
}
