import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../privacy/secrets";
import { compareStrings } from "../core/compare";
import { isRecord, stripUndefined } from "../core/guards";

// Phase 5a: STRUCTURED TEST INGESTION.
//
// Parse JUnit XML (and optional istanbul coverage-summary.json) into a
// normalized, bounded, secret-redacted structure so test evidence can carry
// REAL per-test names and pass/fail status (TRD 8.4 & 11.2; RISK.2). This is
// deliberately defensive: it NEVER throws on malformed/partial input and
// returns whatever parses (empty on total failure).

export const TEST_RESULTS_SCHEMA_VERSION = "review-surfaces.tests.results.v1";
export const TEST_RESULTS_OUTPUT_FILENAME = "tests.results.json";

export type TestCaseStatus = "passed" | "failed" | "skipped";

export interface NormalizedTestCase {
  name: string;
  classname?: string;
  suite?: string;
  status: TestCaseStatus;
  time_ms?: number;
  failure_message?: string;
}

export interface NormalizedTestSuite {
  name: string;
  source_path: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  time_ms?: number;
}

export interface TestCoverageFile {
  path: string;
  statements_pct?: number;
  branches_pct?: number;
  functions_pct?: number;
  lines_pct?: number;
}

export interface TestCoverageSummary {
  total?: TestCoverageFile;
  files: TestCoverageFile[];
}

export interface TestResultsTotals {
  suites: number;
  cases: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface TestResults {
  suites: NormalizedTestSuite[];
  cases: NormalizedTestCase[];
  totals: TestResultsTotals;
  coverage?: TestCoverageSummary;
  source_paths: string[];
}

// Bounds keep artifacts compact and local-first.
const MAX_TEST_OUTPUT_FILE_BYTES = 5_000_000;
const FAILURE_MESSAGE_LIMIT = 600;
const MAX_CASES = 5_000;

export function emptyTestResults(): TestResults {
  return {
    suites: [],
    cases: [],
    totals: { suites: 0, cases: 0, passed: 0, failed: 0, skipped: 0 },
    source_paths: []
  };
}

/**
 * Split a comma-separated --test-output value into individual paths. Blank
 * entries are dropped so a trailing comma or empty flag is harmless.
 */
export function splitTestOutputPaths(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Ingest one or more JUnit XML files plus an optional istanbul
 * coverage-summary.json into normalized TestResults. Never throws: unreadable
 * or malformed inputs are skipped and contribute nothing.
 */
export function ingestTestOutputs(cwd: string, testOutputPaths: string[], coveragePath?: string): TestResults {
  const results = emptyTestResults();
  const seenSources = new Set<string>();

  for (const rawPath of testOutputPaths) {
    if (seenSources.has(rawPath)) {
      continue;
    }
    seenSources.add(rawPath);
    const xml = safeReadText(cwd, rawPath);
    if (xml === undefined) {
      continue;
    }
    const parsed = parseJunitXml(xml, rawPath);
    if (parsed.suites.length === 0 && parsed.cases.length === 0) {
      continue;
    }
    results.source_paths.push(rawPath);
    results.suites.push(...parsed.suites);
    results.cases.push(...parsed.cases);
    if (results.cases.length >= MAX_CASES) {
      results.cases = results.cases.slice(0, MAX_CASES);
    }
  }

  results.suites.sort((left, right) => compareStrings(left.name, right.name) || compareStrings(left.source_path, right.source_path));
  results.cases.sort(compareCases);
  results.totals = computeTotals(results.suites, results.cases);

  const coverage = coveragePath ? parseCoverageSummary(cwd, coveragePath) : undefined;
  if (coverage) {
    results.coverage = coverage;
  }
  return results;
}

function compareCases(left: NormalizedTestCase, right: NormalizedTestCase): number {
  return (
    compareStrings(left.classname ?? "", right.classname ?? "") ||
    compareStrings(left.suite ?? "", right.suite ?? "") ||
    compareStrings(left.name, right.name)
  );
}

function computeTotals(suites: NormalizedTestSuite[], cases: NormalizedTestCase[]): TestResultsTotals {
  const totals: TestResultsTotals = { suites: suites.length, cases: cases.length, passed: 0, failed: 0, skipped: 0 };
  for (const testCase of cases) {
    if (testCase.status === "passed") {
      totals.passed += 1;
    } else if (testCase.status === "failed") {
      totals.failed += 1;
    } else {
      totals.skipped += 1;
    }
  }
  return totals;
}

interface ParsedJunitFile {
  suites: NormalizedTestSuite[];
  cases: NormalizedTestCase[];
}

/**
 * Parse a single JUnit XML document. Handles a bare <testsuite>, a
 * <testsuites> wrapper, single-or-array <testcase>, and missing attributes.
 * Returns empty on any parse failure.
 */
export function parseJunitXml(xml: string, sourcePath: string): ParsedJunitFile {
  const empty: ParsedJunitFile = { suites: [], cases: [] };
  let document: unknown;
  try {
    // fast-xml-parser is a CommonJS module per the project guidance.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { XMLParser } = require("fast-xml-parser");
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      // Keep <failure>some text</failure> bodies addressable as #text.
      textNodeName: "#text",
      parseAttributeValue: false,
      trimValues: true
    });
    document = parser.parse(xml);
  } catch {
    return empty;
  }
  if (!isRecord(document)) {
    return empty;
  }

  const suites: NormalizedTestSuite[] = [];
  const cases: NormalizedTestCase[] = [];

  // A <testsuites> wrapper may itself hold suites; a bare <testsuite> document
  // is also valid. Collect every testsuite element we can find at either level.
  const suiteNodes = collectSuiteNodes(document);
  for (const suiteNode of suiteNodes) {
    const suiteName = stringAttr(suiteNode, "name") ?? "unnamed suite";
    const suiteResult = normalizeSuite(suiteNode, suiteName, sourcePath);
    if (suiteResult) {
      suites.push(suiteResult.suite);
      cases.push(...suiteResult.cases);
    }
  }

  // Some tools emit a flat <testsuites> with testcase children and no inner
  // <testsuite>. Capture those too so we never silently drop real cases.
  for (const wrapperKey of ["testsuites", "testsuite"]) {
    const wrapper = (document as Record<string, unknown>)[wrapperKey];
    for (const node of asArray(wrapper)) {
      if (!isRecord(node)) {
        continue;
      }
      if (suiteNodes.includes(node)) {
        continue;
      }
      const directCases = normalizeCases(node, stringAttr(node, "name"), sourcePath);
      if (directCases.length > 0) {
        cases.push(...directCases);
      }
    }
  }

  return { suites, cases };
}

function collectSuiteNodes(document: Record<string, unknown>): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const seen = new Set<Record<string, unknown>>();

  // Recursively register a <testsuite> and descend into any nested
  // <testsuite> children. A <testsuite> nested inside another <testsuite> is
  // legitimate JUnit output (vitest nested describe blocks, pytest,
  // maven-surefire aggregated reports). The seen-set guards against cycles and
  // duplicate registration. Each nested suite becomes its own suite node so
  // normalizeCases attributes its direct cases to the inner suite name.
  const pushSuite = (node: unknown): void => {
    if (!isRecord(node) || seen.has(node)) {
      return;
    }
    seen.add(node);
    nodes.push(node);
    for (const child of asArray(node.testsuite)) {
      pushSuite(child);
    }
  };

  // Bare <testsuite> as the document root (may itself nest <testsuite>).
  for (const node of asArray(document.testsuite)) {
    pushSuite(node);
  }

  // <testsuites> wrapper(s) holding inner <testsuite> nodes (any depth).
  for (const wrapper of asArray(document.testsuites)) {
    if (!isRecord(wrapper)) {
      continue;
    }
    for (const node of asArray(wrapper.testsuite)) {
      pushSuite(node);
    }
  }

  return nodes;
}

interface NormalizedSuiteResult {
  suite: NormalizedTestSuite;
  cases: NormalizedTestCase[];
}

function normalizeSuite(node: Record<string, unknown>, suiteName: string, sourcePath: string): NormalizedSuiteResult | undefined {
  const cases = normalizeCases(node, suiteName, sourcePath);
  if (cases.length === 0) {
    // A suite with no cases carries no test evidence; skip it.
    return undefined;
  }
  const suite: NormalizedTestSuite = stripUndefined({
    name: suiteName,
    source_path: sourcePath,
    total: cases.length,
    passed: cases.filter((testCase) => testCase.status === "passed").length,
    failed: cases.filter((testCase) => testCase.status === "failed").length,
    skipped: cases.filter((testCase) => testCase.status === "skipped").length,
    time_ms: timeMs(node)
  });
  return { suite, cases };
}

function normalizeCases(node: Record<string, unknown>, suiteName: string | undefined, sourcePath: string): NormalizedTestCase[] {
  const cases: NormalizedTestCase[] = [];
  for (const testcaseNode of asArray(node.testcase)) {
    if (!isRecord(testcaseNode)) {
      continue;
    }
    const name = stringAttr(testcaseNode, "name") ?? "unnamed test";
    const classname = stringAttr(testcaseNode, "classname");
    const status = caseStatus(testcaseNode);
    cases.push(
      stripUndefined({
        name,
        classname,
        suite: suiteName,
        status,
        time_ms: timeMs(testcaseNode),
        failure_message: status === "failed" ? failureMessage(testcaseNode) : undefined
      })
    );
  }
  return cases;
}

function caseStatus(testcaseNode: Record<string, unknown>): TestCaseStatus {
  if (hasChild(testcaseNode, "failure") || hasChild(testcaseNode, "error")) {
    return "failed";
  }
  if (hasChild(testcaseNode, "skipped") || stringAttr(testcaseNode, "status") === "skipped") {
    return "skipped";
  }
  return "passed";
}

function failureMessage(testcaseNode: Record<string, unknown>): string | undefined {
  const fragments: string[] = [];
  for (const key of ["failure", "error"]) {
    for (const child of asArray(testcaseNode[key])) {
      const message = childMessageText(child);
      if (message) {
        fragments.push(message);
      }
    }
  }
  if (fragments.length === 0) {
    return undefined;
  }
  const combined = fragments.join(" | ").replace(/\s+/g, " ").trim();
  if (combined.length === 0) {
    return undefined;
  }
  const redacted = redactSecrets(combined).text;
  return redacted.length > FAILURE_MESSAGE_LIMIT ? `${redacted.slice(0, FAILURE_MESSAGE_LIMIT)}…` : redacted;
}

function childMessageText(child: unknown): string | undefined {
  if (typeof child === "string") {
    return child;
  }
  if (!isRecord(child)) {
    return undefined;
  }
  const attrMessage = stringAttr(child, "message") ?? stringAttr(child, "type");
  const body = typeof child["#text"] === "string" ? (child["#text"] as string) : undefined;
  return [attrMessage, body].filter((part): part is string => Boolean(part && part.length > 0)).join(": ") || undefined;
}

function hasChild(node: Record<string, unknown>, key: string): boolean {
  const value = node[key];
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function timeMs(node: Record<string, unknown>): number | undefined {
  const raw = (node as Record<string, unknown>)["@_time"];
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.round(seconds * 1000);
}

function stringAttr(node: Record<string, unknown>, attribute: string): string | undefined {
  const value = node[`@_${attribute}`];
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

// --- istanbul coverage-summary.json (optional, bounded) --------------------

function parseCoverageSummary(cwd: string, coveragePath: string): TestCoverageSummary | undefined {
  const text = safeReadText(cwd, coveragePath);
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const files: TestCoverageFile[] = [];
  let total: TestCoverageFile | undefined;
  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      continue;
    }
    const entry = coverageEntry(key, value);
    if (!entry) {
      continue;
    }
    if (key === "total") {
      total = { ...entry, path: "total" };
    } else {
      files.push(entry);
    }
  }
  if (!total && files.length === 0) {
    return undefined;
  }
  files.sort((left, right) => compareStrings(left.path, right.path));
  return stripUndefined({ total, files });
}

function coverageEntry(key: string, value: Record<string, unknown>): TestCoverageFile | undefined {
  const entry: TestCoverageFile = stripUndefined({
    path: key,
    statements_pct: pct(value.statements),
    branches_pct: pct(value.branches),
    functions_pct: pct(value.functions),
    lines_pct: pct(value.lines)
  });
  const hasAnyPct =
    entry.statements_pct !== undefined ||
    entry.branches_pct !== undefined ||
    entry.functions_pct !== undefined ||
    entry.lines_pct !== undefined;
  return hasAnyPct ? entry : undefined;
}

function pct(metric: unknown): number | undefined {
  if (!isRecord(metric)) {
    return undefined;
  }
  const value = metric.pct;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// --- shared helpers --------------------------------------------------------

function safeReadText(cwd: string, relativeOrAbsolute: string): string | undefined {
  try {
    const absolutePath = path.resolve(cwd, relativeOrAbsolute);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_TEST_OUTPUT_FILE_BYTES) {
      return undefined;
    }
    return fs.readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
