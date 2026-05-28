import path from "node:path";
import { CollectionResult } from "../collector/collect";
import { writeText } from "../core/files";
import { EvidenceRef, fileEvidence, missingEvidence } from "../evidence/evidence";
import { EvaluationModel } from "../evaluation/evaluate";
import { matchesReviewPrefix, REVIEW_AREAS, ReviewArea } from "../review-areas/areas";

export interface ArchitectureModel {
  summary: string;
  diagrams: string[];
  diagram_validation: DiagramValidationResult[];
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

export interface DiagramValidationResult {
  path: string;
  status: "valid" | "invalid";
  diagram_type: "flowchart" | "sequenceDiagram" | "unknown";
  errors: string[];
  warnings: string[];
  evidence: EvidenceRef[];
}

interface DiagramArtifact {
  path: string;
  body: string;
  evidencePath?: string;
}

export async function buildArchitecture(collection: CollectionResult, evaluation: EvaluationModel): Promise<ArchitectureModel> {
  const outputDir = collection.outputDir;
  const diagramArtifacts = [
    { path: "diagrams/pipeline.mmd", body: pipelineDiagram() },
    { path: "diagrams/source-layout.mmd", body: sourceLayoutDiagram(collection) },
    { path: "diagrams/dogfood-flow.mmd", body: dogfoodFlowDiagram() }
  ];
  for (const diagram of diagramArtifacts) {
    await writeText(path.join(outputDir, diagram.path), diagram.body);
  }

  const diagramValidation = diagramArtifacts.map((diagram) =>
    validateMermaidDiagramArtifact({
      ...diagram,
      evidencePath: diagramEvidencePath(collection, diagram.path)
    })
  );
  const subsystems = REVIEW_AREAS.map((subsystem) => subsystemCard(subsystem, collection, evaluation)).filter((card) => card.files.length > 0);
  const invalidDiagrams = diagramValidation.filter((result) => result.status === "invalid");
  const validDiagrams = diagramValidation.length - invalidDiagrams.length;

  return {
    summary: `Generated ${diagramArtifacts.length} Mermaid diagram(s) (${validDiagrams} valid, ${invalidDiagrams.length} invalid) and ${subsystems.length} evidence-backed subsystem card(s).`,
    diagrams: diagramArtifacts.map((diagram) => diagram.path),
    diagram_validation: diagramValidation,
    subsystems,
    open_questions: [
      ...(subsystems.length === 0 ? ["No subsystem file evidence was found for this run."] : []),
      ...invalidDiagrams.map((diagram) => `Diagram validation failed for ${diagram.path}: ${diagram.errors.join("; ")}`)
    ]
  };
}

export function validateMermaidDiagramArtifact(diagram: DiagramArtifact): DiagramValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const trimmedBody = diagram.body.trim();
  const lines = trimmedBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("%%"));
  const firstLine = lines[0] ?? "";
  const diagramType = classifyMermaidDiagram(firstLine);

  if (path.isAbsolute(diagram.path) || diagram.path.includes("..") || !diagram.path.startsWith("diagrams/") || !diagram.path.endsWith(".mmd")) {
    errors.push("Diagram path must be a relative diagrams/*.mmd artifact path.");
  }
  if (!trimmedBody) {
    errors.push("Diagram body is empty.");
  }
  if (diagramType === "unknown") {
    errors.push("Diagram must start with a supported Mermaid declaration.");
  }
  if (diagram.body.includes("undefined") || diagram.body.includes("[object Object]")) {
    errors.push("Diagram contains placeholder output.");
  }
  if (!hasBalancedSyntax(diagram.body)) {
    errors.push("Diagram contains unbalanced brackets or quotes.");
  }
  if (lines.length > 40) {
    warnings.push("Diagram has more than 40 non-empty lines and may not be review-sized.");
  }
  if (diagramType === "flowchart") {
    const edgeLines = lines.slice(1).filter((line) => /-->|---|==>/.test(line));
    if (edgeLines.length === 0) {
      errors.push("Flowchart diagram must contain at least one edge.");
    }
    for (const line of edgeLines) {
      if (!hasCompleteFlowchartEdge(line)) {
        errors.push(`Flowchart edge is incomplete: ${line}`);
      }
    }
  }
  if (diagramType === "sequenceDiagram") {
    const messageLines = lines.slice(1).filter((line) => /[-=]+>>/.test(line));
    if (messageLines.length === 0) {
      errors.push("Sequence diagram must contain at least one message.");
    }
    for (const line of messageLines) {
      if (!hasCompleteSequenceMessage(line)) {
        errors.push(`Sequence message is incomplete: ${line}`);
      }
    }
  }

  const status = errors.length === 0 ? "valid" : "invalid";
  const note = `review-surfaces.ARCH.6 ${status === "valid" ? "validated" : "rejected"} Mermaid diagram artifact.`;
  return {
    path: diagram.path,
    status,
    diagram_type: diagramType,
    errors,
    warnings,
    evidence:
      status === "valid"
        ? [{ ...fileEvidence(diagram.evidencePath ?? diagram.path, note, "high"), validation_status: "valid" }]
        : [{ ...missingEvidence(note), validation_status: "invalid" }]
  };
}

function diagramEvidencePath(collection: CollectionResult, artifactPath: string): string {
  const cwd = collection.cwd ?? process.cwd();
  const outputDir = path.isAbsolute(collection.outputDir)
    ? collection.outputDir
    : path.resolve(cwd, collection.outputDir);
  return normalizeEvidencePath(path.relative(cwd, path.join(outputDir, artifactPath)));
}

function normalizeEvidencePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function classifyMermaidDiagram(firstLine: string): DiagramValidationResult["diagram_type"] {
  if (/^(flowchart|graph)\s+/.test(firstLine)) {
    return "flowchart";
  }
  if (firstLine === "sequenceDiagram") {
    return "sequenceDiagram";
  }
  return "unknown";
}

function hasCompleteFlowchartEdge(line: string): boolean {
  const match = line.match(/^(.*?)\s*(?:-->|---|==>)\s*(.*?)$/);
  return Boolean(match?.[1]?.trim() && match?.[2]?.trim());
}

function hasCompleteSequenceMessage(line: string): boolean {
  const match = line.match(/^(.+?)\s*[-=]+>>\s*(.+?):\s*(.+)$/);
  return Boolean(match?.[1]?.trim() && match?.[2]?.trim() && match?.[3]?.trim());
}

function hasBalancedSyntax(text: string): boolean {
  return count(text, "[") === count(text, "]")
    && count(text, "(") === count(text, ")")
    && count(text, "{") === count(text, "}")
    && count(text, "\"") % 2 === 0;
}

function count(text: string, character: string): number {
  return text.split(character).length - 1;
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
