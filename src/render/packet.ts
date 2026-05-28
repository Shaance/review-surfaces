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
    implemented_changes: inputs.collection.changedFiles
      .slice(0, 12)
      .map((file) => `${file.status} ${file.path}`),
    commands_to_run: [
      "pnpm run lint",
      "pnpm run test",
      "pnpm run build",
      "pnpm run review-surfaces -- dogfood --provider mock --base origin/main --head HEAD --spec features/review-surfaces.feature.yaml --out .review-surfaces",
      "pnpm run review-surfaces -- validate .review-surfaces"
    ],
    validation_evidence: inputs.risks.test_evidence
      .filter((evidence) => evidence.kind === "direct" || evidence.kind === "indirect")
      .slice(0, 8)
      .map((evidence) => `${evidence.id} [${evidence.kind}]: ${evidence.summary}`),
    failed_validation: inputs.risks.test_evidence
      .filter((evidence) => evidence.kind === "missing")
      .slice(0, 6)
      .map((evidence) => `${evidence.id}: ${evidence.summary}`),
    methodology_flags: handoffMethodologyFlags(inputs.methodology),
    next_tasks: [
      ...inputs.risks.test_gaps.slice(0, 5).map((gap) => `${gap.acai_id ?? gap.requirement_id ?? gap.id}: ${gap.suggested_test ?? gap.summary}`),
      "Inspect .review-surfaces/review_packet.md before trusting generated summaries."
    ],
    open_risks: inputs.risks.items.slice(0, 6).map((risk) => `${risk.id}: ${risk.summary}`),
    deferrals: inputs.dogfood?.deferrals ?? [],
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

${previewLines(packet.intent.requirements, (requirement) => `- ${requirement.id} (${requirement.acai_id ?? "no-acid"}): ${requirement.requirement}`)}

## 3. Requirement coverage
- satisfied: ${statusCounts.satisfied}
- partial: ${statusCounts.partial}
- missing: ${statusCounts.missing}
- unknown: ${statusCounts.unknown}
- invalid_evidence: ${statusCounts.invalid_evidence}
- overreach: ${packet.evaluation.overreach.length}

${previewLines(packet.evaluation.results.filter((result) => result.status !== "satisfied"), (result) => `- ${result.requirement_id} (${result.acai_id ?? "no-acid"}): ${result.status} - ${result.summary}`, 10)}

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
${previewLines(packet.methodology.verified_claims ?? [], (claim) => `- ${claim}`, 5)}

Claims needing evidence:
${previewLines(packet.methodology.claims_without_evidence ?? [], (claim) => `- ${claim}`, 5)}

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
- Changed files in subsystem cards: ${changedFiles.length}
- Methodology logs missing: ${packet.methodology.missing_logs}
- Packet schema: schemas/review_packet.schema.json
- Full machine-readable details: .review-surfaces/review_packet.json
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

## Artifact Paths

${(handoff.artifact_paths ?? []).map((item) => `- \`${item}\``).join("\n") || "- None recorded."}
`;
}

function previewLines<T>(items: T[], render: (item: T) => string, limit = 12): string {
  const visible = items.slice(0, limit).map(render);
  if (items.length > limit) {
    visible.push(`- ... ${items.length - limit} more in review_packet.json`);
  }
  return visible.join("\n") || "- None.";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
