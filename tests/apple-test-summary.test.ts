import test from "node:test";
import assert from "node:assert/strict";
import { formatAppleTestSummary, parseAppleTestSummary } from "../src/tests-evidence/apple-test-summary";

// review-surfaces.COLLECTOR.9: a bounded parser for XCTest / Swift Testing console
// summaries that extracts counts and a reported marker, but never overrides the
// captured process exit code (the caller keeps gating on the transcript status).

test("review-surfaces.COLLECTOR.9 parses an XCTest executed summary", () => {
  const summary = parseAppleTestSummary(
    "Test Suite 'All tests' passed at 2026-06-18.\n\t Executed 42 tests, with 0 failures (0 unexpected) in 1.234 (1.456) seconds"
  );
  assert.deepEqual(summary, { framework: "xctest", executed: 42, failures: 0, reported_success: true });
  assert.equal(formatAppleTestSummary(summary!), "XCTest summary: 42 executed, 0 failures");
});

test("review-surfaces.COLLECTOR.9 parses an XCTest failure count", () => {
  const summary = parseAppleTestSummary("Executed 10 tests, with 2 failures (1 unexpected) in 0.5 seconds");
  assert.deepEqual(summary, { framework: "xctest", executed: 10, failures: 2, reported_success: false });
});

test("review-surfaces.COLLECTOR.9 uses the FINAL XCTest summary, not an early passing suite", () => {
  // An early suite passes with 0 failures; the overall run fails. The parser must take
  // the last/overall summary and reconcile with the TEST FAILED marker — never render
  // the failed run as 0 failures / reported_success: true.
  const log = [
    "Test Suite 'FastTests' passed at 2026-06-19.",
    "\t Executed 5 tests, with 0 failures (0 unexpected) in 0.1 (0.1) seconds",
    "Test Suite 'SlowTests' failed at 2026-06-19.",
    "\t Executed 12 tests, with 2 failures (0 unexpected) in 0.4 (0.5) seconds",
    "** TEST FAILED **"
  ].join("\n");
  const summary = parseAppleTestSummary(log);
  assert.deepEqual(summary, { framework: "xctest", executed: 12, failures: 2, reported_success: false });
});

test("review-surfaces.COLLECTOR.9 parses a bare xcodebuild marker", () => {
  assert.deepEqual(parseAppleTestSummary("** TEST SUCCEEDED **"), { framework: "xctest", reported_success: true });
  assert.deepEqual(parseAppleTestSummary("** TEST FAILED **"), { framework: "xctest", reported_success: false });
});

test("review-surfaces.COLLECTOR.9 parses Swift Testing run summaries", () => {
  assert.deepEqual(parseAppleTestSummary("✔ Test run with 12 tests passed after 0.123 seconds."), {
    framework: "swift-testing",
    executed: 12,
    failures: 0,
    reported_success: true
  });
  assert.deepEqual(
    parseAppleTestSummary("✘ Test run with 12 tests failed after 0.2 seconds with 3 issues."),
    { framework: "swift-testing", executed: 12, failures: 3, reported_success: false }
  );
});

test("review-surfaces.COLLECTOR.9 a failed Swift Testing run without a parseable issue count never reads as 0 failures", () => {
  // The bounded excerpt caught the `failed` line but truncated the `with N issues`
  // phrase — failures must stay UNDEFINED (goal contract D10), never default to 0.
  const summary = parseAppleTestSummary("✘ Test run with 12 tests failed after 0.2 seconds");
  assert.deepEqual(summary, { framework: "swift-testing", executed: 12, reported_success: false });
  assert.equal(summary!.failures, undefined);
  // And the rendered prose surfaces the failure rather than omitting it.
  assert.equal(
    formatAppleTestSummary(summary!),
    "Swift Testing summary: 12 executed, reported failure (issue count unavailable)"
  );
});

test("review-surfaces.COLLECTOR.9 returns undefined for non-Apple / empty output (never a guess)", () => {
  assert.equal(parseAppleTestSummary(undefined), undefined);
  assert.equal(parseAppleTestSummary(""), undefined);
  assert.equal(parseAppleTestSummary("ok 1 - some node tap line\n# pass 1"), undefined);
  assert.equal(parseAppleTestSummary("PASS  src/foo.test.ts (jest)"), undefined);
});
