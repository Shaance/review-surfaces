import path from "node:path";
import { CollectionResult } from "../collector/collect";
import { writeText } from "../core/files";
import { EvaluationModel } from "../evaluation/evaluate";
import { matchesReviewPrefix, REVIEW_AREAS, ReviewArea } from "../review-areas/areas";

export interface ArchitectureModel {
  summary: string;
  diagrams: string[];
  subsystems: Array<{
    id: string;
    name: string;
    summary: string;
    files: string[];
    responsibilities: string[];
    interactions: string[];
    tests: string[];
    risks: string[];
    evidence: Array<{
      kind: "file" | "test" | "spec" | "unknown";
      path?: string;
      confidence: "high" | "medium" | "low" | "unknown";
      validation_status?: "valid" | "invalid" | "not_checked" | "unknown";
      note?: string;
    }>;
  }>;
  open_questions: string[];
}

export async function buildArchitecture(collection: CollectionResult, evaluation: EvaluationModel): Promise<ArchitectureModel> {
  const outputDir = collection.outputDir;
  const diagrams = [
    "diagrams/pipeline.mmd",
    "diagrams/source-layout.mmd",
    "diagrams/dogfood-flow.mmd"
  ];
  await writeText(path.join(outputDir, diagrams[0]), pipelineDiagram());
  await writeText(path.join(outputDir, diagrams[1]), sourceLayoutDiagram(collection));
  await writeText(path.join(outputDir, diagrams[2]), dogfoodFlowDiagram());

  const subsystems = REVIEW_AREAS.map((subsystem) => subsystemCard(subsystem, collection, evaluation)).filter((card) => card.files.length > 0);

  return {
    summary: `Generated ${diagrams.length} Mermaid diagram(s) and ${subsystems.length} evidence-backed subsystem card(s).`,
    diagrams,
    subsystems,
    open_questions: subsystems.length === 0 ? ["No subsystem file evidence was found for this run."] : []
  };
}

function pipelineDiagram(): string {
  return `flowchart LR
  A["Acai specs and docs"] --> B["Collector"]
  B --> C["Intent"]
  C --> D["Evaluation"]
  D --> E["Diagrams"]
  D --> F["Risks and test gaps"]
  B --> G["Methodology"]
  E --> H["Optional enrichment"]
  F --> H
  G --> H
  H --> I["review_packet.json/md"]
  I --> J["Dogfood"]
  J --> K["agent_handoff.md"]
`;
}

function sourceLayoutDiagram(collection: CollectionResult): string {
  const changed = new Set(collection.changedFiles.map((file) => file.path));
  const lines = ["flowchart TB", "  ROOT[\"review-surfaces\"]"];
  for (const subsystem of REVIEW_AREAS) {
    const count = collection.changedFiles.filter((file) => matchesReviewPrefix(file.path, subsystem.prefixes)).length;
    lines.push(`  ROOT --> ${subsystem.id.replace(/-/g, "_")}[\"${subsystem.name} (${count} changed)\"]`);
  }
  if (changed.size === 0) {
    lines.push("  ROOT --> CLEAN[\"No changed files detected\"]");
  }
  return `${lines.join("\n")}\n`;
}

function dogfoodFlowDiagram(): string {
  return `sequenceDiagram
  participant Dev as Developer/Agent
  participant CLI as review-surfaces CLI
  participant FS as .review-surfaces
  Dev->>CLI: dogfood --provider mock
  CLI->>FS: manifest + input indexes
  CLI->>FS: intent/evaluation/risks/diagrams
  CLI->>FS: review_packet.json/md
  CLI->>FS: dogfood.yaml + agent_handoff.md
  Dev->>FS: inspect packet and gaps
`;
}

function subsystemCard(definition: ReviewArea, collection: CollectionResult, evaluation: EvaluationModel): ArchitectureModel["subsystems"][number] {
  const files = collection.changedFiles
    .map((file) => file.path)
    .filter((filePath) => matchesReviewPrefix(filePath, definition.prefixes));
  const tests = collection.tests
    .map((test) => test.path)
    .filter((filePath) => filePath.startsWith("tests/") && relatedToSubsystem(filePath, definition));
  const risks = evaluation.results
    .filter((result) => result.acai_id?.includes(`.${definition.groupKey}.`) && result.status !== "satisfied")
    .slice(0, 4)
    .map((result) => `${result.acai_id}: ${result.status}`);

  return {
    id: definition.id,
    name: definition.name,
    summary: `${definition.purpose} Pattern: ${definition.pattern}.`,
    files,
    responsibilities: [definition.purpose],
    interactions: ["Reads collector/evaluation outputs and feeds packet artifacts when applicable."],
    tests,
    risks,
    evidence: [
      ...files.map((filePath) => ({ kind: "file" as const, path: filePath, confidence: "medium" as const, validation_status: "not_checked" as const })),
      ...tests.map((filePath) => ({ kind: "test" as const, path: filePath, confidence: "medium" as const, validation_status: "not_checked" as const }))
    ]
  };
}

function relatedToSubsystem(filePath: string, definition: ReviewArea): boolean {
  if (definition.prefixes.includes("tests/")) {
    return filePath.startsWith("tests/");
  }
  return definition.testKeywords.some((keyword) => filePath.toLowerCase().includes(keyword));
}
