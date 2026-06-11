import path from "node:path";
import { CollectionResult } from "../collector/collect";
import { commandLooksLikeLocalValidationCommand } from "../commands/classify";
import { ArchitectureModel } from "../diagrams/diagrams";
import { DogfoodModel } from "../dogfood/dogfood";
import { EvaluationModel, RequirementStatus } from "../evaluation/evaluate";
import { SPEC_NONE_NOTE } from "../evaluation/status";
import { EnrichmentResult } from "../llm/provider";
import { IntentModel } from "../intent/intent";
import { MethodologyModel } from "../methodology/methodology";
import { RisksModel } from "../risks/risks";
import { relativePath, writeJson, writeText } from "../core/files";
import { stringifyYaml } from "../core/simple-yaml";
import { compareStrings } from "../core/compare";
import { stripUndefined, unique } from "../core/guards";
import { countRequirementStatuses, REQUIREMENT_STATUSES, RequirementStatusCount } from "../evaluation/status";
import { redactSecrets } from "../privacy/secrets";
import { PACKET_SCHEMA_VERSION } from "../schema/review-packet-contract";

export interface ReviewPacket {
  schema_version: typeof PACKET_SCHEMA_VERSION;
  manifest: Record<string, unknown>;
  intent: IntentModel;
  evaluation: EvaluationModel;
  architecture: ArchitectureModel;
  methodology: MethodologyModel;
  risks: RisksModel;
  dogfood?: DogfoodModel;
  agent_handoff?: {
    summary: string;
    current_milestone?: string;
    relevant_acids?: string[];
    implemented_changes?: string[];
    commands_to_run?: string[];
    validation_evidence?: string[];
    failed_validation?: string[];
    methodology_flags?: string[];
    next_tasks: string[];
    open_risks?: string[];
    deferrals?: string[];
    artifact_paths?: string[];
    changes_since_last_packet?: string[];
  };
}

export interface PacketInputs {
  collection: CollectionResult;
  intent: IntentModel;
  evaluation: EvaluationModel;
  architecture: ArchitectureModel;
  methodology: MethodologyModel;
  risks: RisksModel;
  dogfood?: DogfoodModel;
  enrichment: EnrichmentResult;
  commands: string[];
}

export function createReviewPacket(inputs: PacketInputs): ReviewPacket {
  const packet: ReviewPacket = {
    schema_version: PACKET_SCHEMA_VERSION,
    manifest: stripUndefined(inputs.collection.manifest) as unknown as Record<string, unknown>,
    intent: inputs.intent,
    evaluation: inputs.evaluation,
    architecture: inputs.architecture,
    methodology: inputs.methodology,
    risks: inputs.risks,
    dogfood: inputs.dogfood,
    agent_handoff: inputs.dogfood ? buildHandoff(inputs) : undefined
  };
  return packet;
}

export async function writeReviewPacket(inputs: PacketInputs): Promise<ReviewPacket> {
  const packet = createReviewPacket(inputs);
  // Round 7 (FINDING A): the packet markdown footer pointed reviewers at a
  // hardcoded `.review-surfaces/review_packet.json`. For a run using
  // `--out`/`output_dir` the file lives elsewhere, so the footer was stale. Thread
  // the SAME cwd-relative effective output dir the handoff/comment paths use so the
  // footer references the REAL artifact location. The default `.review-surfaces`
  // output stays byte-identical.
  await writeArtifacts(inputs.collection.outputDir, packet, effectiveOutputDirRelative(inputs.collection));
  return packet;
}

export async function rewriteReviewPacket(outputDir: string, packet: ReviewPacket): Promise<void> {
  // No collection context here (the packet does not carry cwd/outputDir), so the
  // footer keeps the default `.review-surfaces` pointer -- byte-identical to the
  // prior behavior for in-place re-renders.
  await writeArtifacts(outputDir, packet);
}

// ---------------------------------------------------------------------------
// Phase 4a: per-stage artifact writers. Each composable subcommand writes ONLY
// its own artifact(s) using the exact same serialization writeArtifacts uses,
// so a stage run in isolation produces a byte-identical file to the same stage
// inside `all`.
// ---------------------------------------------------------------------------

export async function writeIntentArtifact(outputDir: string, intent: IntentModel): Promise<void> {
  await writeText(path.join(outputDir, "intent.yaml"), stringifyYaml(intent));
}

export async function writeEvaluationArtifact(outputDir: string, evaluation: EvaluationModel): Promise<void> {
  await writeText(path.join(outputDir, "evaluation.yaml"), stringifyYaml(evaluation));
}

export async function writeMethodologyArtifact(outputDir: string, methodology: MethodologyModel): Promise<void> {
  await writeText(path.join(outputDir, "methodology.yaml"), stringifyYaml(methodology));
}

export async function writeRisksArtifact(outputDir: string, risks: RisksModel): Promise<void> {
  await writeText(path.join(outputDir, "risks.yaml"), stringifyYaml(risks));
}

export async function writeArchitectureArtifact(outputDir: string, architecture: ArchitectureModel): Promise<void> {
  await writeText(path.join(outputDir, "architecture.md"), renderArchitectureMarkdown(architecture));
}

export async function writeHandoffArtifact(outputDir: string, inputs: PacketInputs): Promise<void> {
  const handoff = buildHandoff(inputs);
  if (handoff) {
    await writeText(path.join(outputDir, "agent_handoff.md"), renderHandoffMarkdown(handoff));
  }
}

async function writeArtifacts(
  outputDir: string,
  packet: ReviewPacket,
  // cwd-relative effective output dir for the packet markdown footer. Defaults to
  // `.review-surfaces` so the in-place re-render path stays byte-identical.
  packetDirRel: string = ".review-surfaces"
): Promise<void> {
  await writeJson(path.join(outputDir, "review_packet.json"), packet);
  await writeText(path.join(outputDir, "intent.yaml"), stringifyYaml(packet.intent));
  await writeText(path.join(outputDir, "evaluation.yaml"), stringifyYaml(packet.evaluation));
  await writeText(path.join(outputDir, "methodology.yaml"), stringifyYaml(packet.methodology));
  await writeText(path.join(outputDir, "risks.yaml"), stringifyYaml(packet.risks));
  await writeText(path.join(outputDir, "architecture.md"), renderArchitectureMarkdown(packet.architecture));
  await writeText(path.join(outputDir, "review_packet.md"), renderPacketMarkdown(packet, packetDirRel));
  if (packet.dogfood) {
    await writeText(path.join(outputDir, "dogfood.yaml"), stringifyYaml(packet.dogfood));
  }
  if (packet.agent_handoff) {
    await writeText(path.join(outputDir, "agent_handoff.md"), renderHandoffMarkdown(packet.agent_handoff));
  }
}

function buildHandoff(inputs: PacketInputs): ReviewPacket["agent_handoff"] {
  const missing = inputs.evaluation.results.filter((result) => result.status === "missing").slice(0, 5);
  const partial = inputs.evaluation.results.filter((result) => result.status === "partial").slice(0, 5);
  return {
    summary: `Local E2E packet generated with provider=${inputs.enrichment.provider}/${inputs.enrichment.status}; ${inputs.evaluation.summary}`,
    current_milestone: inputs.collection.manifest.milestone ?? "MVP",
    relevant_acids: unique([
      ...missing.map((result) => result.acai_id).filter(Boolean) as string[],
      ...partial.map((result) => result.acai_id).filter(Boolean) as string[]
    ]).slice(0, 12),
    implemented_changes: formatImplementedChanges(inputs.collection.changedFiles),
    commands_to_run: handoffCommandsToRun(),
    validation_evidence: inputs.risks.test_evidence
      .filter(isHandoffValidationEvidence)
      .slice(0, 8)
      .map(formatHandoffEvidence),
    failed_validation: inputs.risks.test_evidence
      .filter(isHandoffFailedValidationEvidence)
      .sort(compareHandoffFailedValidationEvidence)
      .slice(0, 6)
      .map(formatHandoffEvidence),
    methodology_flags: handoffMethodologyFlags(inputs.methodology),
    next_tasks: [
      ...inputs.risks.test_gaps.slice(0, 5).map((gap) => `${gap.acai_id ?? gap.requirement_id ?? gap.id}: ${gap.suggested_test ?? gap.summary}`),
      "Inspect .review-surfaces/review_packet.md before trusting generated summaries."
    ],
    open_risks: inputs.risks.items.slice(0, 6).map((risk) => `${risk.id}: ${risk.summary}`),
    deferrals: inputs.dogfood?.deferrals ?? [],
    changes_since_last_packet: changesSinceLastPacket(inputs.dogfood),
    artifact_paths: handoffArtifactPaths(inputs.collection)
  };
}

// Round 6: the handoff must point reviewers at the REAL artifact location. The
// packet/comment paths already honor the effective output dir; the handoff used
// to hardcode `.review-surfaces/`, so a run using `--out`/`output_dir` pointed at
// files that were written elsewhere. Thread the cwd-relative effective output dir
// (collection.outputDir is absolute) so artifact_paths reference where the files
// actually live. The default `.review-surfaces` output is unchanged. Falls back
// to `.review-surfaces` when cwd/outputDir are absent (minimal test fixtures).
function handoffArtifactPaths(collection: PacketInputs["collection"]): string[] {
  const baseDir = effectiveOutputDirRelative(collection);
  return [
    "review_packet.md",
    "review_packet.json",
    "intent.yaml",
    "evaluation.yaml",
    "architecture.md",
    "risks.yaml",
    "methodology.yaml",
    "dogfood.yaml"
  ].map((file) => path.posix.join(baseDir, file));
}

function effectiveOutputDirRelative(collection: PacketInputs["collection"]): string {
  const { cwd, outputDir } = collection;
  if (!cwd || !outputDir) {
    return ".review-surfaces";
  }
  const rel = relativePath(cwd, outputDir);
  // An empty relative path means outputDir === cwd; treat the repo root as ".".
  // A path that escapes cwd (shouldn't happen) keeps the absolute form rather
  // than emitting a misleading relative path.
  if (rel === "" || rel.startsWith("..")) {
    return rel === "" ? "." : outputDir;
  }
  return rel;
}

function renderPacketMarkdown(packet: ReviewPacket, packetDirRel: string = ".review-surfaces"): string {
  const statusCounts = countRequirementStatuses(packet.evaluation.results);
  // The footer points reviewers at the machine-readable packet at its EFFECTIVE
  // location. `path.posix.join` keeps the link forward-slashed on every platform,
  // matching the handoff artifact_paths.
  const packetJsonRel = path.posix.join(packetDirRel, "review_packet.json");
  const changedFiles = (packet.architecture.subsystems ?? []).flatMap((subsystem) => subsystem.files);
  const llmProposedRequirements = packet.intent.requirements.filter((requirement) => requirement.llm_derived).length;
  const hypotheses = llmProposedEvidenceLines(packet);
  // A "pure mock" run has zero LLM contributions: no llm_derived requirement and
  // no llm_proposed evidence/risk markers. Suppress the LLM-proposed appendix
  // line and the hypotheses section entirely so a naive grep for "LLM-proposed"
  // on a mock packet finds nothing misleading. The JSON still carries the zeros.
  const hasLlmContribution = llmProposedRequirements > 0 || hypotheses.length > 0;

  return `# Review Packet

## 1. Review focus
${packet.risks.review_focus.map((item) => `- ${item}`).join("\n") || "- No review focus generated."}

## 2. Intent
${packet.intent.summary}

${previewLines(packet.intent.requirements, (requirement) => `- ${requirement.id} (${requirement.acai_id ?? "no-acid"})${requirement.llm_derived ? " [LLM-proposed, non-authoritative]" : ""}: ${requirement.requirement}`)}

## 3. Requirement coverage
${(packet.intent as { spec_mode?: unknown }).spec_mode === "none"
    ? SPEC_NONE_NOTE
    : `- satisfied: ${statusCounts.satisfied}
- partial: ${statusCounts.partial}
- missing: ${statusCounts.missing}
- unknown: ${statusCounts.unknown}
- invalid_evidence: ${statusCounts.invalid_evidence}
- overreach: ${packet.evaluation.overreach.length}

${renderRequirementCoverage(packet.evaluation.results)}`}

## 4. Architecture surfaces
${packet.architecture.summary}

Diagrams:
${packet.architecture.diagrams.map((diagram) => `- ${diagram}`).join("\n") || "- None generated."}

Diagram validation:
${previewLines(packet.architecture.diagram_validation ?? [], (result) => `- ${result.path}: ${result.status}${result.warnings.length ? ` (${result.warnings.join("; ")})` : ""}`, 8)}

Changed areas:
${previewLines(packet.architecture.subsystems, (subsystem) => `- ${subsystem.name}: ${subsystem.files.length} file(s), ${subsystem.tests.length} test(s)`, 10)}

## 5. Methodology audit
${packet.methodology.summary}

Verified claims:
${previewLines(packet.methodology.verified_claims ?? [], (claim) => `- ${redactRenderedText(claim)}`, 5)}

Claims needing evidence:
${previewLines(packet.methodology.claims_without_evidence ?? [], (claim) => `- ${redactRenderedText(claim)}`, 5)}

Skipped/unknown:
${(packet.methodology.skipped_checks ?? []).map((item) => `- ${item}`).join("\n") || "- None recorded."}

## 6. Test evidence and gaps
${packet.risks.summary}

Validation evidence:
${previewLines(packet.risks.test_evidence ?? [], (evidence) => `- ${evidence.id} [${evidence.kind}]: ${evidence.summary}`, 8)}

Gaps:
${previewLines(packet.risks.test_gaps, (gap) => `- ${gap.id} (${gap.acai_id ?? gap.requirement_id ?? "unmapped"}): ${gap.summary}`, 10)}

Missing automatic tests:
${previewLines(packet.risks.missing_automatic_tests ?? [], (gap) => `- ${gap.id} (${gap.acai_id ?? gap.requirement_id ?? "unmapped"}): ${gap.suggested_test}`, 8)}

Missing manual checks:
${previewLines(packet.risks.missing_manual_checks ?? [], (gap) => `- ${gap.id} (${gap.acai_id ?? gap.requirement_id ?? "unmapped"}): ${gap.manual_check}`, 8)}

## 7. Risks
${previewLines(packet.risks.items, (risk) => `- ${risk.id} [${risk.severity}]: ${risk.summary}`, 10)}

## 8. Dogfood findings
${packet.dogfood ? previewLines(packet.dogfood.findings, (finding) => `- ${finding.id} [${finding.severity}]: ${finding.finding}`, 10) : "- Not a dogfood run."}

## 9. Open questions
${packet.intent.open_questions.map((item) => `- ${item}`).join("\n") || "- None recorded."}

## 10. Evidence appendix
- Requirements indexed: ${packet.intent.requirements.length}
- Authoritative requirements: ${packet.intent.requirements.filter((requirement) => !requirement.llm_derived).length}${hasLlmContribution ? `
- LLM-proposed (non-authoritative) requirements: ${llmProposedRequirements}` : ""}
- Changed files in subsystem cards: ${changedFiles.length}
- Methodology logs missing: ${packet.methodology.missing_logs}
- Packet schema: schemas/review_packet.schema.json
- Full machine-readable details: ${packetJsonRel}${hasLlmContribution ? `

LLM/agent hypotheses (not proof; verify against deterministic evidence):
${previewLines(hypotheses, (line) => `- ${redactRenderedText(line)}`, 12)}` : ""}
`;
}

function renderArchitectureMarkdown(architecture: ArchitectureModel): string {
  return `# Architecture

${architecture.summary}

## Diagrams

${architecture.diagrams.map((diagram) => `- \`${diagram}\``).join("\n") || "- None generated."}

## Diagram validation

${(architecture.diagram_validation ?? [])
  .map((result) => `- \`${result.path}\`: ${result.status}${result.errors.length ? ` - ${result.errors.join("; ")}` : ""}${result.warnings.length ? ` (${result.warnings.join("; ")})` : ""}`)
  .join("\n") || "- No diagram validation results recorded."}

## Subsystems

${architecture.subsystems
  .map(
    (subsystem) => `### ${subsystem.name}

${subsystem.summary}

- Files: ${subsystem.files.length ? subsystem.files.join(", ") : "none"}
- Tests: ${subsystem.tests.length ? subsystem.tests.join(", ") : "none"}
- Risks: ${subsystem.risks.length ? subsystem.risks.join("; ") : "none"}
`
  )
  .join("\n") || "No subsystem cards generated."}
`;
}

function renderHandoffMarkdown(handoff: NonNullable<ReviewPacket["agent_handoff"]>): string {
  return `# Agent Handoff

${handoff.summary}

## Current Milestone

${handoff.current_milestone ?? "unknown"}

## Relevant ACIDs

${(handoff.relevant_acids ?? []).map((item) => `- ${item}`).join("\n") || "- None prioritized."}

## Commands To Run

${(handoff.commands_to_run ?? []).map((item) => `- \`${item}\``).join("\n") || "- None recorded."}

## Implemented Changes

${(handoff.implemented_changes ?? []).map((item) => `- ${item}`).join("\n") || "- None recorded."}

## Validation Evidence

${(handoff.validation_evidence ?? []).map((item) => `- ${item}`).join("\n") || "- None recorded."}

## Failed Or Missing Validation

${(handoff.failed_validation ?? []).map((item) => `- ${item}`).join("\n") || "- None recorded."}

## Methodology Flags

${(handoff.methodology_flags ?? []).map((item) => `- ${item}`).join("\n") || "- None recorded."}

## Next Tasks

${handoff.next_tasks.map((item) => `- ${item}`).join("\n")}

## Open Risks

${(handoff.open_risks ?? []).map((item) => `- ${item}`).join("\n") || "- None recorded."}

## Deferrals

${(handoff.deferrals ?? []).map((item) => `- ${item}`).join("\n") || "- None recorded."}

## Changes Since Last Packet

${(handoff.changes_since_last_packet ?? []).map((item) => `- ${item}`).join("\n") || "- No previous packet supplied; pass --previous-packet to compare."}

## Artifact Paths

${(handoff.artifact_paths ?? []).map((item) => `- \`${item}\``).join("\n") || "- None recorded."}
`;
}

type RequirementResultView = ReviewPacket["evaluation"]["results"][number];

// Compact group-rollup threshold (#4). Past this many requirement results the
// per-requirement coverage list is too noisy to read inline (the dogfood
// manager already flags requirement_coverage as a noisy_section past 50), so we
// switch to one rollup line per Acai group plus a short "worst N" detail list.
// Small specs and full mode keep the full per-requirement list. Tied to a fixed
// count so the choice is deterministic and independent of any provider.
const COMPACT_ROLLUP_THRESHOLD = 40;
const WORST_DETAIL_LIMIT = 10;

// Order used to rank groups (and individual requirements) for the "worst N"
// detail list: the least-covered statuses come first so reviewers see the most
// actionable items. Satisfied results never appear in this section.
const COVERAGE_SEVERITY: RequirementStatus[] = ["invalid_evidence", "missing", "unknown", "partial"];

function renderRequirementCoverage(results: RequirementResultView[]): string {
  const unsatisfied = results.filter((result) => result.status !== "satisfied");
  if (results.length > COMPACT_ROLLUP_THRESHOLD) {
    return renderGroupRollups(results, unsatisfied);
  }
  return previewLines(unsatisfied, renderRequirementCoverageLine, 10);
}

// Full per-requirement coverage line. Surfaces the structured partial_reason
// (#5) inline, e.g. "REQ-012 (acid): partial [impl_no_test] - ...".
function renderRequirementCoverageLine(result: RequirementResultView): string {
  const reason = result.status === "partial" && result.partial_reason ? ` [${result.partial_reason}]` : "";
  const llm = hasLlmProposedEvidence(result) ? " [includes LLM-proposed evidence]" : "";
  return `- ${result.requirement_id} (${result.acai_id ?? "no-acid"}): ${result.status}${reason}${llm} - ${result.summary}`;
}

// Compact mode (#4): one rollup line per Acai group_key with per-status counts,
// instead of the full per-requirement list. Followed by a short "worst N"
// detail list so the most actionable requirements are still visible. Group
// order is deterministic (alphabetical by group_key); the no-group bucket
// sorts last under "(no-group)".
function renderGroupRollups(results: RequirementResultView[], unsatisfied: RequirementResultView[]): string {
  const groups = new Map<string, RequirementStatusCount>();
  for (const result of results) {
    const key = groupKeyForResult(result);
    const counts = groups.get(key) ?? blankStatusCount();
    if (result.status in counts) {
      counts[result.status as keyof RequirementStatusCount] += 1;
    }
    groups.set(key, counts);
  }

  const rollupLines = [...groups.entries()]
    .sort(([left], [right]) => compareGroupKey(left, right))
    .map(([key, counts]) => {
      const total = REQUIREMENT_STATUSES.reduce((sum, status) => sum + counts[status], 0);
      return `- ${key}: ${total} requirement(s) — satisfied ${counts.satisfied}, partial ${counts.partial}, missing ${counts.missing}, unknown ${counts.unknown}, invalid ${counts.invalid_evidence}`;
    });

  const worst = [...unsatisfied]
    .sort(compareCoverageSeverity)
    .slice(0, WORST_DETAIL_LIMIT)
    .map(renderRequirementCoverageLine);
  const worstOverflow = unsatisfied.length > WORST_DETAIL_LIMIT
    ? [`- ... ${unsatisfied.length - WORST_DETAIL_LIMIT} more unsatisfied requirement(s) in review_packet.json`]
    : [];

  return [
    `Group rollups (${results.length} requirements across ${groups.size} group(s); full per-requirement list in review_packet.json):`,
    ...rollupLines,
    "",
    `Worst ${Math.min(WORST_DETAIL_LIMIT, unsatisfied.length)} requirement(s):`,
    ...(worst.length > 0 ? [...worst, ...worstOverflow] : ["- None; all requirements satisfied."])
  ].join("\n");
}

function groupKeyForResult(result: RequirementResultView): string {
  return result.acai_id?.split(".")[1] ?? "(no-group)";
}

function compareGroupKey(left: string, right: string): number {
  // Keep the explicit no-group bucket last for a stable, readable ordering.
  if (left === "(no-group)") {
    return right === "(no-group)" ? 0 : 1;
  }
  if (right === "(no-group)") {
    return -1;
  }
  return compareStrings(left, right);
}

function compareCoverageSeverity(left: RequirementResultView, right: RequirementResultView): number {
  const rank = (status: string): number => {
    const index = COVERAGE_SEVERITY.indexOf(status as RequirementStatus);
    return index === -1 ? COVERAGE_SEVERITY.length : index;
  };
  const delta = rank(left.status) - rank(right.status);
  if (delta !== 0) {
    return delta;
  }
  // Stable secondary key so output is fully deterministic regardless of input
  // ordering.
  return compareStrings(left.acai_id ?? left.requirement_id, right.acai_id ?? right.requirement_id);
}

function blankStatusCount(): RequirementStatusCount {
  return Object.fromEntries(REQUIREMENT_STATUSES.map((status) => [status, 0])) as RequirementStatusCount;
}

function hasLlmProposedEvidence(result: ReviewPacket["evaluation"]["results"][number]): boolean {
  return (result.evidence ?? []).some((ref) => ref.llm_proposed === true)
    || (result.missing_evidence ?? []).some((ref) => ref.llm_proposed === true);
}

// review-surfaces.EVIDENCE.6: collect every LLM/agent-proposed marker so the
// packet visibly distinguishes hypotheses from verified deterministic evidence.
function llmProposedEvidenceLines(packet: ReviewPacket): string[] {
  const lines: string[] = [];
  for (const requirement of packet.intent.requirements) {
    if (requirement.llm_derived) {
      lines.push(`requirement ${requirement.id}: ${requirement.requirement}`);
    }
  }
  for (const result of packet.evaluation.results) {
    for (const ref of [...(result.evidence ?? []), ...(result.missing_evidence ?? [])]) {
      if (ref.llm_proposed === true) {
        lines.push(`${result.acai_id ?? result.requirement_id} [${ref.validation_status ?? "unknown"}]: ${ref.path ?? ref.note ?? ref.kind}`);
      }
    }
  }
  for (const item of packet.risks.items ?? []) {
    if ((item.evidence ?? []).some((ref) => ref.llm_proposed === true)) {
      lines.push(`${item.id}: ${item.summary}`);
    }
  }
  return lines;
}

function previewLines<T>(items: T[], render: (item: T) => string, limit = 12): string {
  const visible = items.slice(0, limit).map(render);
  if (items.length > limit) {
    visible.push(`- ... ${items.length - limit} more in review_packet.json`);
  }
  return visible.join("\n") || "- None.";
}

function handoffCommandsToRun(): string[] {
  // The tracked bin shim records `run` transcripts before dist exists, so the
  // first build command remains useful in a fresh checkout.
  return [
    "node bin/review-surfaces.js run --id CMD-PNPM-BUILD --command-transcripts .review-surfaces/commands -- pnpm run build",
    "node bin/review-surfaces.js run --id CMD-PNPM-LINT --command-transcripts .review-surfaces/commands -- pnpm run lint",
    "node bin/review-surfaces.js run --id CMD-PNPM-TEST --command-transcripts .review-surfaces/commands -- pnpm run test",
    "node bin/review-surfaces.js all --base origin/main --head HEAD --spec features/review-surfaces.feature.yaml --dogfood --provider mock --out .review-surfaces",
    "node bin/review-surfaces.js validate .review-surfaces"
  ];
}

function formatImplementedChanges(changedFiles: CollectionResult["changedFiles"], limit = 12): string[] {
  const visible = changedFiles.slice(0, limit).map((file) => `${file.status} ${file.path}`);
  if (changedFiles.length > limit) {
    visible.push(`... ${changedFiles.length - limit} more changed file(s) in .review-surfaces/inputs/changed_files.json`);
  }
  return visible;
}

// Phase 5b (CLI.6): compact, deterministic "Changes since last packet" lines
// for the handoff. Returns undefined when no --previous-packet was supplied so
// behavior is unchanged for runs without a comparison. When --previous-packet
// pointed at an absent/unreadable packet we still note the comparison was
// skipped rather than silently dropping the request.
function changesSinceLastPacket(dogfood: DogfoodModel | undefined): string[] | undefined {
  if (!dogfood?.previous_packet_path) {
    return undefined;
  }
  const comparison = dogfood.comparison;
  if (!comparison) {
    return [`Previous packet ${dogfood.previous_packet_path} was absent or unreadable; no comparison computed.`];
  }
  const lines: string[] = [`Compared against ${dogfood.previous_packet_path}.`];
  for (const change of comparison.status_changes) {
    lines.push(`${change.acai_id}: ${change.previous_status} -> ${change.current_status} (${change.direction})`);
  }
  for (const risk of comparison.new_risks) {
    lines.push(`New risk: ${risk}`);
  }
  for (const risk of comparison.resolved_risks) {
    lines.push(`Resolved risk: ${risk}`);
  }
  for (const filePath of comparison.new_overreach) {
    lines.push(`New overreach: ${filePath}`);
  }
  for (const filePath of comparison.resolved_overreach) {
    lines.push(`Resolved overreach: ${filePath}`);
  }
  const deltas = comparison.count_deltas;
  lines.push(
    `Count deltas: satisfied ${formatDelta(deltas.satisfied.delta)}, partial ${formatDelta(deltas.partial.delta)}, missing ${formatDelta(deltas.missing.delta)}, unknown ${formatDelta(deltas.unknown.delta)}, invalid_evidence ${formatDelta(deltas.invalid_evidence.delta)}.`
  );
  return lines;
}

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function redactRenderedText(value: string): string {
  return redactSecrets(value).text;
}

function formatHandoffEvidence(evidence: RisksModel["test_evidence"][number]): string {
  return redactRenderedText(`${evidence.id} [${evidence.kind}]: ${evidence.summary}`);
}

function compareHandoffFailedValidationEvidence(
  left: RisksModel["test_evidence"][number],
  right: RisksModel["test_evidence"][number]
): number {
  return handoffFailedValidationPriority(left) - handoffFailedValidationPriority(right);
}

function handoffFailedValidationPriority(evidence: RisksModel["test_evidence"][number]): number {
  const summary = evidence.summary.toLowerCase();
  if (summary.includes("failing validation command")) {
    return 0;
  }
  if (evidence.kind === "missing") {
    return 1;
  }
  if (evidence.kind === "unknown") {
    return 2;
  }
  if (evidence.kind === "claimed") {
    return 3;
  }
  if (evidence.kind === "indirect") {
    return 4;
  }
  return 5;
}

function isHandoffValidationEvidence(evidence: RisksModel["test_evidence"][number]): boolean {
  if (evidence.kind !== "direct" && evidence.kind !== "indirect") {
    return false;
  }
  // FINDING F: include parsed JUnit passes. A passing parsed test becomes a
  // kind:"direct" entry carrying only a kind:"test" evidence ref (the REAL
  // test_name) with validation_status "valid" -- it has NO command ref. The prior
  // filter required a command ref, so a run with --test-output but no command
  // transcript promoted requirements and listed parsed passes in risks.yaml while
  // agent_handoff.md claimed no validation evidence was recorded. Accept a
  // VERIFIED parsed-test ref (kind "test", validation_status "valid") alongside
  // the command-transcript path so the handoff reflects parsed-test validation.
  return (evidence.evidence ?? []).some(
    (ref) => ref.kind === "command" || (ref.kind === "test" && ref.validation_status === "valid")
  );
}

function isHandoffFailedValidationEvidence(evidence: RisksModel["test_evidence"][number]): boolean {
  if (evidence.kind === "missing" || evidence.kind === "unknown") {
    return true;
  }
  if (evidence.kind === "indirect" && isFeedbackOnlyEvidence(evidence)) {
    return true;
  }
  if (evidence.kind !== "claimed") {
    return false;
  }
  return (evidence.evidence ?? []).some((ref) =>
    ref.kind === "feedback"
      || (ref.kind === "command" && typeof ref.command === "string" && commandLooksLikeLocalValidationCommand(ref.command))
  );
}

function isFeedbackOnlyEvidence(evidence: RisksModel["test_evidence"][number]): boolean {
  const refs = evidence.evidence ?? [];
  return refs.length > 0 && refs.every((ref) => ref.kind === "feedback");
}

function handoffMethodologyFlags(methodology: MethodologyModel): string[] {
  return unique([
    ...methodology.quality_flags,
    ...(methodology.missing_logs ? ["conversation_log_missing"] : []),
    ...(methodology.claims_without_evidence.length > 0 ? ["claims_without_evidence"] : []),
    ...(methodology.verified_claims.length > 0 ? ["verified_claims_available"] : [])
  ]);
}
