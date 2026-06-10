// review-surfaces.COVERAGE.1/.3: deterministic, offline lcov ingestion. Parses
// the SF/DA records every major JS runner can emit into a per-file covered-line
// model, and intersects that model with the changed lines of each diff hunk to
// classify changed code as covered / uncovered / partial. Mirrors the junit.ts
// shape: an external report ingested as evidence, never a new analysis path.
// An unsupported or unparseable report degrades to "no coverage evidence" —
// never a guess (COVERAGE.4).
import path from "node:path";
import { StructuredDiff } from "../pr/contract";

export interface LcovCoverage {
  // repo-relative file path -> sorted line numbers executed at least once.
  files: Record<string, number[]>;
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
  const files: Record<string, Set<number>> = {};
  let current: Set<number> | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      const filePath = normalizeCoveragePath(line.slice(3).trim(), cwd);
      current = filePath ? (files[filePath] ??= new Set()) : undefined;
    } else if (line.startsWith("DA:") && current) {
      const [lineNumber, hits] = line.slice(3).split(",");
      const parsedLine = Number.parseInt(lineNumber, 10);
      const parsedHits = Number.parseInt(hits, 10);
      if (Number.isFinite(parsedLine) && parsedLine > 0 && Number.isFinite(parsedHits) && parsedHits > 0) {
        current.add(parsedLine);
      }
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }
  const sorted: Record<string, number[]> = {};
  for (const filePath of Object.keys(files).sort()) {
    sorted[filePath] = [...files[filePath]].sort((a, b) => a - b);
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

export interface ChangedFileCoverage {
  path: string;
  changed_lines: number;
  covered_lines: number;
  classification: ChangedLineClassification;
}

// Per changed file, intersect the new-side ADDED lines with the covered-line set
// (COVERAGE.3). Files absent from the report yield no entry — absence of data is
// "no coverage evidence" for that file, never "uncovered" (COVERAGE.4).
export function intersectCoverageWithDiff(diff: StructuredDiff, coverage: LcovCoverage): ChangedFileCoverage[] {
  const results: ChangedFileCoverage[] = [];
  for (const file of diff.files) {
    const covered = coverage.files[file.path];
    if (!covered) {
      continue;
    }
    const coveredSet = new Set(covered);
    let changed = 0;
    let hit = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add" && typeof line.new_line === "number") {
          changed += 1;
          if (coveredSet.has(line.new_line)) {
            hit += 1;
          }
        }
      }
    }
    if (changed === 0) {
      continue;
    }
    results.push({
      path: file.path,
      changed_lines: changed,
      covered_lines: hit,
      classification: hit === 0 ? "uncovered" : hit === changed ? "covered" : "partial"
    });
  }
  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return results;
}
