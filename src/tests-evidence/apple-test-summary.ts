// review-surfaces.COLLECTOR.9 — bounded parser for standard XCTest and Swift
// Testing console summaries (NOT .xcresult, which is deferred). It extracts counts
// and a success/failure marker for richer evidence prose, but it NEVER overrides
// the captured process exit code — the transcript's exit_code/status remains the
// source of truth (goal contract D2). Pure and deterministic over the text.

export type AppleTestFramework = "xctest" | "swift-testing";

export interface AppleTestSummary {
  framework: AppleTestFramework;
  executed?: number;
  failures?: number;
  // The marker the SUMMARY TEXT itself reports. Advisory only — callers must keep
  // gating trust on the process exit code, not on this field.
  reported_success?: boolean;
}

// XCTest: "Executed 42 tests, with 1 failure (0 unexpected) in 1.2 (1.4) seconds".
// Global so the LAST (overall) summary wins over an early per-suite line.
const XCTEST_EXECUTED = /Executed\s+(\d+)\s+tests?,\s+with\s+(\d+)\s+failures?\b/g;
// XCTest overall markers printed by xcodebuild.
const XCTEST_SUCCEEDED = /\*\*\s*TEST SUCCEEDED\s*\*\*/;
const XCTEST_FAILED = /\*\*\s*TEST FAILED\s*\*\*/;
// Swift Testing: "Test run with 12 tests passed after 0.1 seconds." /
// "Test run with 12 tests failed after 0.1 seconds with 2 issues.".
const SWIFT_TESTING_RUN = /Test run with\s+(\d+)\s+tests?\s+(passed|failed)\b/;
const SWIFT_TESTING_ISSUES = /\bwith\s+(\d+)\s+issues?\b/;

// Parse the FIRST recognizable summary in the text, preferring Swift Testing's
// explicit run line, then XCTest's executed line, then the bare xcodebuild marker.
// Returns undefined when no supported summary is present (never a guess).
export function parseAppleTestSummary(text: string | undefined): AppleTestSummary | undefined {
  if (!text) {
    return undefined;
  }

  const swift = SWIFT_TESTING_RUN.exec(text);
  if (swift) {
    const executed = Number(swift[1]);
    const passed = swift[2] === "passed";
    // A failed run with a truncated/absent "with N issues" phrase must NOT default to
    // 0 failures — that would render a failure as "0 failures" (goal contract D10:
    // uncertainty is never shown as success). Leave failures undefined in that case;
    // reported_success=false still carries the failure marker.
    const issuesRaw = passed ? "0" : SWIFT_TESTING_ISSUES.exec(text)?.[1];
    const issues = issuesRaw === undefined ? undefined : Number(issuesRaw);
    return stripUndefinedSummary({
      framework: "swift-testing",
      executed: Number.isFinite(executed) ? executed : undefined,
      failures: issues !== undefined && Number.isFinite(issues) ? issues : undefined,
      reported_success: passed
    });
  }

  // Take the FINAL "Executed N tests, with M failures" line (the overall total), not
  // the first per-suite line — an early suite passing with 0 failures must not render a
  // later-failing run as "0 failures". Also reconcile with the ** TEST FAILED ** marker.
  const xctestMatches = [...text.matchAll(XCTEST_EXECUTED)];
  const xctest = xctestMatches.at(-1);
  if (xctest) {
    const executed = Number(xctest[1]);
    const failures = Number(xctest[2]);
    const markedFailed = XCTEST_FAILED.test(text);
    return stripUndefinedSummary({
      framework: "xctest",
      executed: Number.isFinite(executed) ? executed : undefined,
      failures: Number.isFinite(failures) ? failures : undefined,
      reported_success: markedFailed ? false : Number.isFinite(failures) ? failures === 0 : undefined
    });
  }

  if (XCTEST_SUCCEEDED.test(text)) {
    return { framework: "xctest", reported_success: true };
  }
  if (XCTEST_FAILED.test(text)) {
    return { framework: "xctest", reported_success: false };
  }
  return undefined;
}

function stripUndefinedSummary(summary: AppleTestSummary): AppleTestSummary {
  const result: AppleTestSummary = { framework: summary.framework };
  if (summary.executed !== undefined) {
    result.executed = summary.executed;
  }
  if (summary.failures !== undefined) {
    result.failures = summary.failures;
  }
  if (summary.reported_success !== undefined) {
    result.reported_success = summary.reported_success;
  }
  return result;
}

// A compact, human-facing phrase for a parsed summary, e.g.
// "XCTest summary: 42 executed, 0 failures" — for evidence prose only.
export function formatAppleTestSummary(summary: AppleTestSummary): string {
  const label = summary.framework === "swift-testing" ? "Swift Testing" : "XCTest";
  const parts: string[] = [];
  if (summary.executed !== undefined) {
    parts.push(`${summary.executed} executed`);
  }
  if (summary.failures !== undefined) {
    parts.push(`${summary.failures} ${summary.failures === 1 ? "failure" : "failures"}`);
  } else if (summary.reported_success === false) {
    // Failed run without a parseable failure count — surface the failure rather than
    // silently omit it (never let a failure read as success / 0 failures).
    parts.push("reported failure (issue count unavailable)");
  }
  if (parts.length === 0 && summary.reported_success !== undefined) {
    parts.push(summary.reported_success ? "reported success" : "reported failure");
  }
  return `${label} summary: ${parts.join(", ")}`;
}
