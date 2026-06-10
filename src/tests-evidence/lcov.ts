// review-surfaces.COVERAGE.1/.3: deterministic, offline lcov ingestion. Parses
// the SF/DA records every major JS runner can emit into a per-file covered-line
// model, and intersects that model with the changed lines of each diff hunk to
// classify changed code as covered / uncovered / partial. Mirrors the junit.ts
// shape: an external report ingested as evidence, never a new analysis path.
// An unsupported or unparseable report degrades to "no coverage evidence" —
// never a guess (COVERAGE.4).
import path from "node:path";
import { StructuredDiff } from "../pr/contract";

export interface LcovFileCoverage {
  // Sorted DA-instrumented line numbers (whatever the report measured).
  instrumented: number[];
  // Sorted instrumented lines executed at least once.
  covered: number[];
}

export interface LcovCoverage {
  files: Record<string, LcovFileCoverage>;
}

// Cheap format sniff: an lcov report has SF: (source file) and DA: (line data)
// records. Used to distinguish lcov input from the istanbul coverage-summary
// JSON the --coverage flag also accepts.
export function looksLikeLcov(text: string): boolean {
  return /^SF:/m.test(text) && /^DA:\d+,\d+/m.test(text);
}

export function parseLcov(text: string, cwd?: string): LcovCoverage | undefined {
  if (!looksLikeLcov(text)) {
    return undefined;
  }
  const files: Record<string, { instrumented: Set<number>; covered: Set<number> }> = {};
  let current: { instrumented: Set<number>; covered: Set<number> } | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      const filePath = normalizeCoveragePath(line.slice(3).trim(), cwd);
      current = filePath ? (files[filePath] ??= { instrumented: new Set(), covered: new Set() }) : undefined;
    } else if (line.startsWith("DA:") && current) {
      const [lineNumber, hits] = line.slice(3).split(",");
      const parsedLine = Number.parseInt(lineNumber, 10);
      const parsedHits = Number.parseInt(hits, 10);
      if (Number.isFinite(parsedLine) && parsedLine > 0 && Number.isFinite(parsedHits)) {
        // Keep ALL instrumented lines: a changed line with NO DA record (comment,
        // type-only) is "no evidence", which must never be counted as uncovered.
        current.instrumented.add(parsedLine);
        if (parsedHits > 0) {
          current.covered.add(parsedLine);
        }
      }
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }
  const sorted: Record<string, LcovFileCoverage> = {};
  for (const filePath of Object.keys(files).sort()) {
    sorted[filePath] = {
      instrumented: [...files[filePath].instrumented].sort((a, b) => a - b),
      covered: [...files[filePath].covered].sort((a, b) => a - b)
    };
  }
  return { files: sorted };
}

// lcov SF paths are often absolute; strip the repo root so they match diff paths.
function normalizeCoveragePath(filePath: string, cwd?: string): string {
  let normalized = filePath.replace(/\\/g, "/");
  if (cwd) {
    const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized.startsWith(`${root}/`)) {
      normalized = normalized.slice(root.length + 1);
    }
  }
  return path.posix.normalize(normalized).replace(/^\.\//, "");
}

export type ChangedLineClassification = "covered" | "uncovered" | "partial";

export interface ChangedHunkCoverage {
  hunk_header: string;
  changed_lines: number;
  covered_lines: number;
  classification: ChangedLineClassification;
}

export interface ChangedFileCoverage {
  path: string;
  changed_lines: number;
  covered_lines: number;
  classification: ChangedLineClassification;
  hunks: ChangedHunkCoverage[];
}

// Per changed file and PER HUNK (COVERAGE.3), intersect the new-side ADDED lines
// with the report. Only INSTRUMENTED lines count as changed: an added line with
// no DA record (comment, type-only) is no-evidence, never uncovered. Files (and
// hunks) with no instrumented changed lines yield no entry — absence of data is
// "no coverage evidence", never "uncovered" (COVERAGE.4).
export function intersectCoverageWithDiff(diff: StructuredDiff, coverage: LcovCoverage): ChangedFileCoverage[] {
  const results: ChangedFileCoverage[] = [];
  for (const file of diff.files) {
    const fileCoverage = coverage.files[file.path];
    if (!fileCoverage) {
      continue;
    }
    const instrumented = new Set(fileCoverage.instrumented);
    const covered = new Set(fileCoverage.covered);
    const hunks: ChangedHunkCoverage[] = [];
    let changed = 0;
    let hit = 0;
    for (const hunk of file.hunks) {
      let hunkChanged = 0;
      let hunkHit = 0;
      for (const line of hunk.lines) {
        if (line.kind === "add" && typeof line.new_line === "number" && instrumented.has(line.new_line)) {
          hunkChanged += 1;
          if (covered.has(line.new_line)) {
            hunkHit += 1;
          }
        }
      }
      if (hunkChanged === 0) {
        continue;
      }
      changed += hunkChanged;
      hit += hunkHit;
      hunks.push({
        hunk_header: `@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@`,
        changed_lines: hunkChanged,
        covered_lines: hunkHit,
        classification: hunkHit === 0 ? "uncovered" : hunkHit === hunkChanged ? "covered" : "partial"
      });
    }
    if (changed === 0) {
      continue;
    }
    results.push({
      path: file.path,
      changed_lines: changed,
      covered_lines: hit,
      classification: hit === 0 ? "uncovered" : hit === changed ? "covered" : "partial",
      hunks
    });
  }
  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return results;
}
