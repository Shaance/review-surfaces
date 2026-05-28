import { CollectionResult } from "../collector/collect";
import { COMMAND_TRANSCRIPT_OUTPUT_PATH, CommandTranscript } from "../commands/transcripts";
import { commandEvidence, EvidenceRef, feedbackEvidence, missingEvidence, specEvidence } from "../evidence/evidence";
import { EvaluationModel, RequirementResult } from "../evaluation/evaluate";
import { MethodologyModel } from "../methodology/methodology";

export interface RiskItem {
  id: string;
  category: "correctness" | "security" | "privacy" | "maintainability" | "architecture" | "testing" | "workflow" | "release" | "performance" | "unknown";
  severity: "low" | "medium" | "high" | "critical" | "unknown";
  likelihood?: "low" | "medium" | "high" | "unknown";
  detectability?: "easy" | "moderate" | "hard" | "unknown";
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
    kind: "direct" | "indirect" | "claimed" | "missing" | "unknown";
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
      evidence: partialResults.slice(0, 5).flatMap((result) => result.evidence ?? []),
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
      evidence: evaluation.overreach.flatMap((result) => result.evidence ?? []).slice(0, 6),
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
  const allTestEvidence = [...testEvidence, ...feedbackEvidence, ...claimedCommandEvidence];
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

  return {
    summary: `${items.length} risk item(s), ${testGaps.length} test gap(s), ${collection.changedFiles.length} changed file(s) in scope.`,
    items,
    test_evidence: allTestEvidence,
    test_gaps: testGaps,
    review_focus: [
      "Start with missing and partial requirement results.",
      "Check overreach files before reviewing implementation detail.",
      "Treat AI-enriched summaries as review aids, not proof.",
      "Confirm validation command output for the current branch.",
      ...methodologyReviewFocus(methodology)
    ]
  };
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
