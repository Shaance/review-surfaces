import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { looksLikeLcov, parseLcov, intersectCoverageWithDiff } from "../src/tests-evidence/lcov";
import { parseStructuredDiff } from "../src/collector/diff-hunks";

const LCOV = [
  "TN:",
  "SF:src/foo.ts",
  "DA:1,1",
  "DA:2,0",
  "DA:3,5",
  "end_of_record",
  "SF:src/bar.ts",
  "DA:10,0",
  "end_of_record",
  ""
].join("\n");

test("review-surfaces.COVERAGE.1 parseLcov reads SF/DA records into a sorted per-file covered-line model", () => {
  assert.equal(looksLikeLcov(LCOV), true);
  const coverage = parseLcov(LCOV);
  assert.ok(coverage);
  // All DA lines are instrumented; only hits > 0 are covered; sorted.
  assert.deepEqual(coverage.files, {
    "src/bar.ts": { instrumented: [10], covered: [] },
    "src/foo.ts": { instrumented: [1, 2, 3], covered: [1, 3] }
  });
});

test("review-surfaces.COVERAGE.1 absolute SF paths are normalized repo-relative; non-lcov input degrades to undefined", () => {
  const coverage = parseLcov("SF:/repo/src/foo.ts\nDA:1,1\nend_of_record\n", "/repo");
  assert.deepEqual(coverage?.files, { "src/foo.ts": { instrumented: [1], covered: [1] } });
  assert.equal(parseLcov('{"total": {}}'), undefined);
});

function diffFor(file: string, addedLines: number[]): ReturnType<typeof parseStructuredDiff> {
  const start = Math.min(...addedLines);
  const body = addedLines.map(() => "+added");
  return parseStructuredDiff(
    [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -${start},0 +${start},${addedLines.length} @@`, ...body].join("\n")
  );
}

test("review-surfaces.COVERAGE.3 intersection classifies changed lines covered/uncovered/partial per file", () => {
  const coverage = {
    files: {
      "src/foo.ts": { instrumented: [1, 2, 3, 10, 11], covered: [1, 3] },
      "src/gone.ts": { instrumented: [7], covered: [7] }
    }
  };
  const partial = intersectCoverageWithDiff(diffFor("src/foo.ts", [1, 2, 3]), coverage);
  assert.deepEqual(partial, [
    {
      path: "src/foo.ts",
      changed_lines: 3,
      covered_lines: 2,
      classification: "partial",
      hunks: [{ hunk_header: "@@ -1,0 +1,3 @@", changed_lines: 3, covered_lines: 2, classification: "partial", uncovered_lines: [2], covered_line_numbers: [1, 3] }]
    }
  ]);
  const uncovered = intersectCoverageWithDiff(diffFor("src/foo.ts", [10, 11]), coverage);
  assert.equal(uncovered[0].classification, "uncovered");
  // diffFor numbers added lines consecutively from start, so [1] is line 1 only.
  const covered = intersectCoverageWithDiff(diffFor("src/foo.ts", [1]), coverage);
  assert.equal(covered[0].classification, "covered");
  // A changed line with NO DA record is no-evidence, never uncovered: lines 20-21
  // are not instrumented, so the file yields no entry at all.
  assert.deepEqual(intersectCoverageWithDiff(diffFor("src/foo.ts", [20, 21]), coverage), []);
});

test("review-surfaces.COVERAGE.4 a changed file absent from the report yields NO entry (no evidence, not uncovered)", () => {
  const result = intersectCoverageWithDiff(diffFor("src/other.ts", [5]), { files: { "src/foo.ts": { instrumented: [1], covered: [1] } } });
  assert.deepEqual(result, []);
});

// --- e2e: input channels + manifest provenance ------------------------------

test("review-surfaces.COVERAGE.1/.2 e2e: --coverage lcov is ingested with manifest provenance; auto-detect coverage/lcov.info works", () => {
  const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-lcov-"));
  try {
    fs.cpSync(process.cwd(), tmp, {
      recursive: true,
      filter: (source) => {
        const rel = path.relative(process.cwd(), source);
        return rel !== ".git" && !rel.startsWith(`.git${path.sep}`) && rel !== "dist" && !rel.startsWith(`dist${path.sep}`) && rel !== ".review-surfaces" && !rel.startsWith(`.review-surfaces${path.sep}`);
      }
    });
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "report.lcov"), LCOV);
    execFileSync(
      "node",
      [CLI, "collect", "--base", "HEAD", "--head", "HEAD", "--spec", "features/review-surfaces.feature.yaml", "--coverage", "report.lcov", "--out", ".review-surfaces"],
      { cwd: tmp, stdio: "ignore" }
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "manifest.json"), "utf8"));
    assert.equal(manifest.coverage.source_path, "report.lcov");
    assert.equal(manifest.coverage.algorithm, "sha256");
    assert.equal(typeof manifest.coverage.hash, "string");
    // The report was written AFTER the head commit, so it postdates head.
    assert.equal(manifest.coverage.postdates_head, true);
    const coverageInput = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "inputs", "coverage.json"), "utf8"));
    assert.deepEqual(coverageInput.files["src/foo.ts"], { instrumented: [1, 2, 3], covered: [1, 3] });

    // Auto-detect: no flag, coverage/lcov.info present.
    fs.mkdirSync(path.join(tmp, "coverage"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "coverage", "lcov.info"), LCOV);
    execFileSync(
      "node",
      [CLI, "collect", "--base", "HEAD", "--head", "HEAD", "--spec", "features/review-surfaces.feature.yaml", "--out", ".rs-auto"],
      { cwd: tmp, stdio: "ignore" }
    );
    const autoManifest = JSON.parse(fs.readFileSync(path.join(tmp, ".rs-auto", "manifest.json"), "utf8"));
    assert.equal(autoManifest.coverage.source_path, "coverage/lcov.info");

    // Stale-input cleanup: re-collecting into the same out dir WITHOUT a report
    // must remove the prior inputs/coverage.json (no report = no evidence).
    fs.rmSync(path.join(tmp, "coverage"), { recursive: true, force: true });
    execFileSync(
      "node",
      [CLI, "collect", "--base", "HEAD", "--head", "HEAD", "--spec", "features/review-surfaces.feature.yaml", "--out", ".rs-auto"],
      { cwd: tmp, stdio: "ignore" }
    );
    assert.equal(fs.existsSync(path.join(tmp, ".rs-auto", "inputs", "coverage.json")), false);
    const cleanedManifest = JSON.parse(fs.readFileSync(path.join(tmp, ".rs-auto", "manifest.json"), "utf8"));
    assert.equal(cleanedManifest.coverage, undefined);

    // A coverage-bearing run must still produce a packet that passes the strict
    // packet schema (manifest.coverage is allowed by review_packet.schema.json).
    execFileSync(
      "node",
      [CLI, "all", "--provider", "mock", "--base", "HEAD", "--head", "HEAD", "--spec", "features/review-surfaces.feature.yaml", "--coverage", "report.lcov", "--out", ".review-surfaces"],
      { cwd: tmp, stdio: "ignore" }
    );
    execFileSync("node", [CLI, "validate", ".review-surfaces"], { cwd: tmp, stdio: "ignore" });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
