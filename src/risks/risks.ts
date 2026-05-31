import { CollectionResult } from "../collector/collect";
import { COMMAND_TRANSCRIPT_OUTPUT_PATH, CommandTranscript } from "../commands/transcripts";
import { stripUndefined } from "../core/guards";
import { commandEvidence, EvidenceRef, feedbackEvidence, missingEvidence, specEvidence } from "../evidence/evidence";
import { EvaluationModel, RequirementResult } from "../evaluation/evaluate";
import { MethodologyModel } from "../methodology/methodology";
import type {
  PacketRiskCategory,
  PacketRiskDetectability,
  PacketRiskLikelihood,
  PacketSeverity,
  PacketTestEvidenceKind
} from "../schema/review-packet-contract";
import { NormalizedTestCase, TestResults } from "../tests-evidence/junit";

const MAX_PARSED_TEST_EVIDENCE = 40;

export interface RiskItem {
  id: string;
  category: PacketRiskCategory;
  severity: PacketSeverity;
  likelihood?: PacketRiskLikelihood;
  detectability?: PacketRiskDetectability;
  summary: string;
  impact?: string;
  evidence?: EvidenceRef[];
  suggested_checks?: string[];
  manual_review?: boolean;
}

export interface RisksModel {
  summary: string;
  items: RiskItem[];
  test_evidence: Array<{
    id: string;
    kind: PacketTestEvidenceKind;
    summary: string;
    requirement_ids?: string[];
    evidence?: EvidenceRef[];
  }>;
  test_gaps: Array<{
    id: string;
    requirement_id?: string;
    acai_id?: string;
    summary: string;
    suggested_test?: string;
    manual_check?: string;
    evidence?: EvidenceRef[];
  }>;
  missing_automatic_tests?: Array<{
    id: string;
    requirement_id?: string;
    acai_id?: string;
    summary: string;
    suggested_test: string;
    evidence?: EvidenceRef[];
  }>;
  missing_manual_checks?: Array<{
    id: string;
    requirement_id?: string;
    acai_id?: string;
    summary: string;
    manual_check: string;
    evidence?: EvidenceRef[];
  }>;
  review_focus: string[];
}

export function analyzeRisks(
  collection: CollectionResult,
  evaluation: EvaluationModel,
  commands: string[],
  methodology?: MethodologyModel
): RisksModel {
  const weakResults = evaluation.results.filter((result) => result.status !== "satisfied");
  const partialResults = evaluation.results.filter((result) => result.status === "partial");
  const missingResults = evaluation.results.filter((result) => result.status === "missing");
  const unknownResults = evaluation.results.filter((result) => result.status === "unknown");
  const items: RiskItem[] = [];

  if (missingResults.length > 0) {
    items.push({
      id: "RISK-001",
      category: "correctness",
      severity: "high",
      likelihood: "medium",
      detectability: "moderate",
      summary: `${missingResults.length} requirement(s) have no implementation or test evidence.`,
      impact: "Reviewers cannot tell whether required behavior exists.",
      evidence: missingResults.slice(0, 5).flatMap((result) => result.missing_evidence ?? []),
      suggested_checks: ["Implement or explicitly defer missing requirements.", "Add direct tests or artifact evidence for missing requirements."],
      manual_review: true
    });
  }

  if (partialResults.length > 0) {
    items.push({
      id: `RISK-${String(items.length + 1).padStart(3, "0")}`,
      category: "testing",
      severity: "medium",
      likelihood: "high",
      detectability: "easy",
      summary: `${partialResults.length} requirement(s) have implementation evidence but weak or missing test evidence.`,
      impact: "Implementation may exist but regressions are not well guarded.",
      evidence: evidenceOrMissing(
        partialResults.slice(0, 5).flatMap((result) => result.evidence ?? []),
        "Partial requirements need implementation and test evidence before release decisions."
      ),
      suggested_checks: ["Add unit or fixture tests tied to affected requirement groups."],
      manual_review: true
    });
  }

  if (evaluation.overreach.length > 0) {
    items.push({
      id: `RISK-${String(items.length + 1).padStart(3, "0")}`,
      category: "workflow",
      severity: "medium",
      likelihood: "medium",
      detectability: "easy",
      summary: `${evaluation.overreach.length} changed file(s) did not map to a stated requirement group.`,
      impact: "The diff may contain unstated scope or the spec may be incomplete.",
      evidence: evidenceOrMissing(
        evaluation.overreach.flatMap((result) => result.evidence ?? []).slice(0, 6),
        "Overreach findings need changed-file evidence or an explicit scope deferral."
      ),
      suggested_checks: ["Either map the changed file to an Acai requirement or add a spec update/deferral."],
      manual_review: true
    });
  }

  if (unknownResults.length > 0) {
    items.push({
      id: `RISK-${String(items.length + 1).padStart(3, "0")}`,
      category: "release",
      severity: "low",
      likelihood: "medium",
      detectability: "moderate",
      summary: `${unknownResults.length} requirement(s) remain unknown due to weak evidence.`,
      impact: "The packet is intentionally conservative and should not be treated as full coverage.",
      evidence: [missingEvidence("Unknown requirements need stronger evidence before release decisions.")],
      suggested_checks: ["Review unknown requirements manually and convert recurring unknowns into tests or explicit deferrals."],
      manual_review: true
    });
  }

  if (methodology?.claims_without_evidence?.length) {
    items.push({
      id: `RISK-${String(items.length + 1).padStart(3, "0")}`,
      category: "workflow",
      severity: "medium",
      likelihood: "medium",
      detectability: "easy",
      summary: `${methodology.claims_without_evidence.length} methodology claim(s) mention tests or passing checks without command transcript evidence.`,
      impact: "Reviewers may over-trust claimed validation unless the command output is recorded separately.",
      evidence: methodology.evidence?.length ? methodology.evidence.slice(0, 5) : [missingEvidence("Methodology claims need command transcript evidence.")],
      suggested_checks: ["Run validation through review-surfaces run or attach a bounded command transcript before treating the claim as proof."],
      manual_review: true
    });
  }

  // Parsed JUnit results carry REAL per-test names + pass/fail and are STRONGER
  // than coarse command-transcript evidence, so they lead. Transcripts are kept
  // too (a "test exited 0" signal remains useful when no parsed results exist).
  const parsedTestEvidence = validationEvidenceFromTestResults(collection.testResults);
  const testEvidence = validationEvidenceFromCommandTranscripts(collection);
  const transcriptCommands = new Set((collection.commandTranscripts ?? []).map((transcript) => normalizeCommand(transcript.command)));
  const feedbackEvidence = validationEvidenceFromFeedback(collection, transcriptCommands);
  const claimedCommandEvidence = commands
    .filter((command) => !transcriptCommands.has(normalizeCommand(command)))
    .map((command, index) => ({
      id: `TEST-CMD-${String(index + 1).padStart(3, "0")}`,
      kind: "claimed" as const,
      summary: `Command invoked by this run context: ${command}`,
      requirement_ids: [],
      evidence: [commandEvidence(command, "Command invocation is recorded by the CLI, but output is not captured in this artifact.", "medium")]
    }));
  const allTestEvidence = [...parsedTestEvidence, ...testEvidence, ...feedbackEvidence, ...claimedCommandEvidence];
  if (allTestEvidence.length === 0) {
    allTestEvidence.push({
      id: "TEST-001",
      kind: "missing" as const,
      summary: "No command transcript or validation feedback was supplied to prove test execution.",
      requirement_ids: [],
      evidence: [missingEvidence("Run validation commands and preserve output externally or in a future command transcript artifact.")]
    });
  }

  const testGaps = weakResults.slice(0, 20).map((result, index) => ({
    id: `GAP-${String(index + 1).padStart(3, "0")}`,
    requirement_id: result.requirement_id,
    acai_id: result.acai_id,
    summary: `${result.status} coverage for ${result.acai_id ?? result.requirement_id}: ${result.summary}`,
    suggested_test: suggestedTestFor(result),
    manual_check: "Inspect changed files and generated artifacts for this requirement before trusting coverage.",
    evidence: result.missing_evidence?.length ? result.missing_evidence : [specEvidence("features/review-surfaces.feature.yaml", result.acai_id)]
  }));
  const missingAutomaticTests = testGaps
    .filter((gap) => gap.suggested_test)
    .map((gap, index) => ({
      id: `AUTO-${String(index + 1).padStart(3, "0")}`,
      requirement_id: gap.requirement_id,
      acai_id: gap.acai_id,
      summary: `Missing automatic test for ${gap.acai_id ?? gap.requirement_id ?? gap.id}.`,
      suggested_test: gap.suggested_test,
      evidence: gap.evidence
    }));
  const missingManualChecks = testGaps
    .filter((gap) => gap.manual_check)
    .map((gap, index) => ({
      id: `MANUAL-${String(index + 1).padStart(3, "0")}`,
      requirement_id: gap.requirement_id,
      acai_id: gap.acai_id,
      summary: `Missing manual review check for ${gap.acai_id ?? gap.requirement_id ?? gap.id}.`,
      manual_check: gap.manual_check,
      evidence: gap.evidence
    }));

  return {
    summary: `${items.length} risk item(s), ${testGaps.length} test gap(s), ${collection.changedFiles.length} changed file(s) in scope.`,
    items,
    test_evidence: allTestEvidence,
    test_gaps: testGaps,
    missing_automatic_tests: missingAutomaticTests,
    missing_manual_checks: missingManualChecks,
    review_focus: buildRiskReviewFocus(methodology)
  };
}

export function buildRiskReviewFocus(methodology: MethodologyModel | undefined): string[] {
  return [
    "Start with missing and partial requirement results.",
    "Check overreach files before reviewing implementation detail.",
    "Treat AI-enriched summaries as review aids, not proof.",
    "Confirm validation command output for the current branch.",
    ...methodologyReviewFocus(methodology)
  ];
}

function evidenceOrMissing(evidence: EvidenceRef[], fallback: string): EvidenceRef[] {
  return evidence.length > 0 ? evidence : [missingEvidence(fallback)];
}

function methodologyReviewFocus(methodology: MethodologyModel | undefined): string[] {
  if (!methodology) {
    return [];
  }
  if (methodology.claims_without_evidence.length > 0) {
    return ["Inspect methodology claims without command evidence before relying on claimed tests."];
  }
  if (methodology.missing_logs) {
    return ["Methodology conversation logs are missing; rely on local artifacts and command transcripts only."];
  }
  if (methodology.verified_claims.length > 0) {
    return ["Use verified methodology claims only when backed by command transcript evidence."];
  }
  return [];
}

function validationEvidenceFromFeedback(collection: CollectionResult, transcriptCommands: Set<string>): RisksModel["test_evidence"] {
  const entries: RisksModel["test_evidence"] = [];
  for (const feedbackFile of collection.feedback) {
    for (const command of feedbackFile.validation.passed) {
      if (transcriptCommands.has(normalizeCommand(command))) {
        continue;
      }
      entries.push({
        id: `TEST-FB-${String(entries.length + 1).padStart(3, "0")}`,
        kind: commandLooksLikeTestCommand(command) ? "claimed" : "indirect",
        summary: `Feedback records a passing validation command: ${command}`,
        requirement_ids: [],
        evidence: [
          feedbackEvidence(feedbackFile.path, "Validation command recorded in local feedback; command output is not captured in this artifact.", {
            command
          })
        ]
      });
    }
    for (const command of feedbackFile.validation.failed) {
      if (transcriptCommands.has(normalizeCommand(command))) {
        continue;
      }
      entries.push({
        id: `TEST-FB-${String(entries.length + 1).padStart(3, "0")}`,
        kind: "missing",
        summary: `Feedback records a failing validation command: ${command}`,
        requirement_ids: [],
        evidence: [
          feedbackEvidence(feedbackFile.path, "Failed validation command recorded in local feedback.", { command })
        ]
      });
    }
  }
  return entries;
}

// Phase 5a: map parsed JUnit cases to test_evidence. A PASSING case becomes
// "direct" evidence carrying the REAL EvidenceRef.test_name (classname/suite in
// the note); a FAILING case becomes "missing" evidence (the test ran but did not
// prove the behavior). Skipped cases are recorded as "claimed" so they are
// visible without being treated as proof.
function validationEvidenceFromTestResults(testResults: TestResults | undefined): RisksModel["test_evidence"] {
  const entries: RisksModel["test_evidence"] = [];
  if (!testResults || testResults.cases.length === 0) {
    return entries;
  }
  // Round 8 (FINDING D): testResults.cases arrives sorted ALPHABETICALLY
  // (classname/suite/name). Capping that order with slice(0, 40) silently DROPS a
  // FAILED/skipped case that sorts late, so the packet could show many passing
  // tests while HIDING a real failure (and the handoff failed-validation section
  // would miss it). Order so non-passed (failed/error/skipped) cases come BEFORE
  // passed ones BEFORE applying the cap, so failures are never hidden. Ordering is
  // STABLE within each status group: the underlying array is already
  // deterministically sorted, and the priority sort below preserves that order
  // among equal-priority cases.
  const prioritized = orderTestCasesFailuresFirst(testResults.cases).slice(0, MAX_PARSED_TEST_EVIDENCE);
  for (const testCase of prioritized) {
    entries.push({
      id: `TEST-RESULT-${String(entries.length + 1).padStart(3, "0")}`,
      kind: parsedTestEvidenceKind(testCase),
      summary: parsedTestCaseSummary(testCase),
      requirement_ids: [],
      evidence: [parsedTestCaseEvidence(testCase)]
    });
  }
  return entries;
}

// FINDING D: a stable reordering that puts non-passing cases first so the 40-entry
// cap reserves slots for failures. `passed` cases sort last; everything else
// (failed / skipped / any other non-passed status) keeps its existing
// deterministic relative order. Failures sort ahead of skips so a genuine FAILED
// test is the very last thing the cap would ever drop. A plain Array.prototype.sort
// in Node is stable, so within each priority bucket the input order is preserved.
function orderTestCasesFailuresFirst(cases: NormalizedTestCase[]): NormalizedTestCase[] {
  const priority = (testCase: NormalizedTestCase): number => {
    if (testCase.status === "passed") {
      return 2; // passing tests are the LEAST important to keep under the cap
    }
    if (testCase.status === "skipped") {
      return 1;
    }
    return 0; // failed (and any non-passed/non-skipped) status: never hide these
  };
  return [...cases].sort((left, right) => priority(left) - priority(right));
}

function parsedTestEvidenceKind(testCase: NormalizedTestCase): RisksModel["test_evidence"][number]["kind"] {
  if (testCase.status === "passed") {
    return "direct";
  }
  if (testCase.status === "failed") {
    return "missing";
  }
  return "claimed";
}

function parsedTestCaseSummary(testCase: NormalizedTestCase): string {
  const context = parsedTestContext(testCase);
  const where = context ? ` (${context})` : "";
  if (testCase.status === "passed") {
    return `Parsed test passed: ${testCase.name}${where}`;
  }
  if (testCase.status === "failed") {
    const reason = testCase.failure_message ? `: ${testCase.failure_message}` : "";
    return `Parsed test FAILED: ${testCase.name}${where}${reason}`;
  }
  return `Parsed test skipped: ${testCase.name}${where}`;
}

function parsedTestCaseEvidence(testCase: NormalizedTestCase): EvidenceRef {
  const context = parsedTestContext(testCase);
  const note =
    testCase.status === "failed" && testCase.failure_message
      ? `Parsed JUnit case ${context ? `(${context}) ` : ""}failed: ${testCase.failure_message}`
      : `Parsed JUnit case${context ? ` (${context})` : ""} with status=${testCase.status}.`;
  return stripUndefinedEvidence({
    kind: "test",
    test_name: testCase.name,
    note,
    confidence: testCase.status === "passed" ? "high" : testCase.status === "failed" ? "medium" : "low",
    validation_status: testCase.status === "passed" ? "valid" : testCase.status === "failed" ? "invalid" : "not_checked"
  });
}

function parsedTestContext(testCase: NormalizedTestCase): string | undefined {
  const parts = [testCase.classname, testCase.suite].filter(
    (part): part is string => Boolean(part && part.length > 0)
  );
  if (parts.length === 0) {
    return undefined;
  }
  return [...new Set(parts)].join(" / ");
}

function stripUndefinedEvidence(ref: EvidenceRef): EvidenceRef {
  return stripUndefined(ref);
}

function validationEvidenceFromCommandTranscripts(collection: CollectionResult): RisksModel["test_evidence"] {
  const entries: RisksModel["test_evidence"] = [];
  const evidencePath = collection.commandTranscriptOutputPath ?? COMMAND_TRANSCRIPT_OUTPUT_PATH;
  for (const transcript of collection.commandTranscripts ?? []) {
    entries.push({
      id: `TEST-TR-${String(entries.length + 1).padStart(3, "0")}`,
      kind: testEvidenceKindForTranscript(transcript),
      summary: commandTranscriptSummary(transcript),
      requirement_ids: [],
      evidence: [
        commandEvidence(
          transcript.command,
          `Command transcript ${transcript.id} recorded exit_code=${transcript.exit_code ?? "unknown"} and status=${transcript.status}.`,
          transcript.exit_code === 0 ? "high" : "medium",
          {
            path: evidencePath,
            eventId: transcript.id,
            excerptHash: transcript.stdout_hash ?? transcript.stderr_hash,
            validationStatus: "valid"
          }
        )
      ]
    });
  }
  return entries;
}

function testEvidenceKindForTranscript(transcript: CommandTranscript): RisksModel["test_evidence"][number]["kind"] {
  if (transcript.status === "passed" && transcript.exit_code === 0 && commandLooksLikeTestCommand(transcript.command)) {
    return "direct";
  }
  if (transcript.status === "passed" && transcript.exit_code === 0) {
    return "indirect";
  }
  if (transcript.status === "failed" || typeof transcript.exit_code === "number") {
    return "missing";
  }
  return "unknown";
}

function commandTranscriptSummary(transcript: CommandTranscript): string {
  const exit = transcript.exit_code === undefined ? "unknown exit" : `exit ${transcript.exit_code}`;
  return `Command transcript ${transcript.id} records ${exit}: ${transcript.command}`;
}

function commandLooksLikeTestCommand(command: string): boolean {
  return /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test(?::[\w.-]+)?|node\s+--test|(?:pnpm|npm|yarn|bun)\s+exec\s+(?:vitest|jest|tap|uvu)|(?:vitest|jest|tap|uvu))(?:\s|$)/.test(normalizeCommand(command));
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function suggestedTestFor(result: RequirementResult): string {
  if (result.acai_id?.includes(".INTENT.")) {
    return "Add intent fixture tests proving source refs, assumptions, and open questions are preserved.";
  }
  if (result.acai_id?.includes(".EVAL.")) {
    return "Add evaluator fixture tests for satisfied, partial, missing, unknown, and overreach statuses.";
  }
  if (result.acai_id?.includes(".ARCH.")) {
    return "Add diagram generation tests that assert Mermaid files and subsystem cards exist.";
  }
  if (result.acai_id?.includes(".METHODOLOGY.")) {
    return "Add methodology tests for both missing logs and supplied Markdown/JSONL logs.";
  }
  return `Add a focused unit or fixture test tied to ${result.acai_id ?? result.requirement_id}.`;
}
