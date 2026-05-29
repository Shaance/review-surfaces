import path from "node:path";
import { CollectionResult } from "../collector/collect";
import { ArchitectureModel } from "../diagrams/diagrams";
import { DogfoodModel } from "../dogfood/dogfood";
import { EvaluationModel } from "../evaluation/evaluate";
import { EnrichmentResult } from "../llm/provider";
import { IntentModel } from "../intent/intent";
import { MethodologyModel } from "../methodology/methodology";
import { RisksModel } from "../risks/risks";
import { writeJson, writeText } from "../core/files";
import { stringifyYaml } from "../core/simple-yaml";
import { countRequirementStatuses } from "../evaluation/status";
import { redactSecrets } from "../privacy/secrets";

export interface ReviewPacket {
  schema_version: "review-surfaces.packet.v1";
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
    schema_version: "review-surfaces.packet.v1",
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
  await writeArtifacts(inputs.collection.outputDir, packet);
  return packet;
}

export async function rewriteReviewPacket(outputDir: string, packet: ReviewPacket): Promise<void> {
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

async function writeArtifacts(outputDir: string, packet: ReviewPacket): Promise<void> {
  await writeJson(path.join(outputDir, "review_packet.json"), packet);
  await writeText(path.join(outputDir, "intent.yaml"), stringifyYaml(packet.intent));
  await writeText(path.join(outputDir, "evaluation.yaml"), stringifyYaml(packet.evaluation));
  await writeText(path.join(outputDir, "methodology.yaml"), stringifyYaml(packet.methodology));
  await writeText(path.join(outputDir, "risks.yaml"), stringifyYaml(packet.risks));
  await writeText(path.join(outputDir, "architecture.md"), renderArchitectureMarkdown(packet.architecture));
  await writeText(path.join(outputDir, "review_packet.md"), renderPacketMarkdown(packet));
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
    artifact_paths: [
      ".review-surfaces/review_packet.md",
      ".review-surfaces/review_packet.json",
      ".review-surfaces/intent.yaml",
      ".review-surfaces/evaluation.yaml",
      ".review-surfaces/architecture.md",
      ".review-surfaces/risks.yaml",
      ".review-surfaces/methodology.yaml",
      ".review-surfaces/dogfood.yaml"
    ]
  };
}

function renderPacketMarkdown(packet: ReviewPacket): string {
  const statusCounts = countRequirementStatuses(packet.evaluation.results);
  const changedFiles = (packet.architecture.subsystems ?? []).flatMap((subsystem) => subsystem.files);

  return `# Review Packet

## 1. Review focus
${packet.risks.review_focus.map((item) => `- ${item}`).join("\n") || "- No review focus generated."}

## 2. Intent
${packet.intent.summary}

${previewLines(packet.intent.requirements, (requirement) => `- ${requirement.id} (${requirement.acai_id ?? "no-acid"})${requirement.llm_derived ? " [LLM-proposed, non-authoritative]" : ""}: ${requirement.requirement}`)}

## 3. Requirement coverage
- satisfied: ${statusCounts.satisfied}
- partial: ${statusCounts.partial}
- missing: ${statusCounts.missing}
- unknown: ${statusCounts.unknown}
- invalid_evidence: ${statusCounts.invalid_evidence}
- overreach: ${packet.evaluation.overreach.length}

${previewLines(packet.evaluation.results.filter((result) => result.status !== "satisfied"), (result) => `- ${result.requirement_id} (${result.acai_id ?? "no-acid"}): ${result.status}${hasLlmProposedEvidence(result) ? " [includes LLM-proposed evidence]" : ""} - ${result.summary}`, 10)}

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

## 7. Risks
${previewLines(packet.risks.items, (risk) => `- ${risk.id} [${risk.severity}]: ${risk.summary}`, 10)}

## 8. Dogfood findings
${packet.dogfood ? previewLines(packet.dogfood.findings, (finding) => `- ${finding.id} [${finding.severity}]: ${finding.finding}`, 10) : "- Not a dogfood run."}

## 9. Open questions
${packet.intent.open_questions.map((item) => `- ${item}`).join("\n") || "- None recorded."}

## 10. Evidence appendix
- Requirements indexed: ${packet.intent.requirements.length}
- Authoritative requirements: ${packet.intent.requirements.filter((requirement) => !requirement.llm_derived).length}
- LLM-proposed (non-authoritative) requirements: ${packet.intent.requirements.filter((requirement) => requirement.llm_derived).length}
- Changed files in subsystem cards: ${changedFiles.length}
- Methodology logs missing: ${packet.methodology.missing_logs}
- Packet schema: schemas/review_packet.schema.json
- Full machine-readable details: .review-surfaces/review_packet.json

LLM/agent hypotheses (not proof; verify against deterministic evidence):
${previewLines(llmProposedEvidenceLines(packet), (line) => `- ${redactRenderedText(line)}`, 12)}
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
  return (evidence.evidence ?? []).some((ref) => ref.kind === "command");
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
      || (ref.kind === "command" && typeof ref.command === "string" && commandLooksLikeLocalValidation(ref.command))
  );
}

function isFeedbackOnlyEvidence(evidence: RisksModel["test_evidence"][number]): boolean {
  const refs = evidence.evidence ?? [];
  return refs.length > 0 && refs.every((ref) => ref.kind === "feedback");
}

function commandLooksLikeLocalValidation(command: string): boolean {
  return /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w.-]+)?|lint|typecheck|build)|node\s+--test|tsc\s)/.test(command.toLowerCase().trim().replace(/\s+/g, " "));
}

function handoffMethodologyFlags(methodology: MethodologyModel): string[] {
  return unique([
    ...methodology.quality_flags,
    ...(methodology.missing_logs ? ["conversation_log_missing"] : []),
    ...(methodology.claims_without_evidence.length > 0 ? ["claims_without_evidence"] : []),
    ...(methodology.verified_claims.length > 0 ? ["verified_claims_available"] : [])
  ]);
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
