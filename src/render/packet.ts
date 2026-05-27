import path from "node:path";
import { IndexedRequirement } from "../acai/acai";
import { CollectionResult } from "../collector/collect";
import { writeJson, writeText } from "../core/files";
import { stringifyYaml } from "../core/simple-yaml";

export interface ReviewPacket {
  schema_version: "review-surfaces.packet.v1";
  manifest: Record<string, unknown>;
  intent: Record<string, unknown>;
  evaluation: Record<string, unknown>;
  architecture: Record<string, unknown>;
  methodology: Record<string, unknown>;
  risks: Record<string, unknown>;
  dogfood?: Record<string, unknown>;
  agent_handoff?: Record<string, unknown>;
}

export async function renderSkeletonPacket(collection: CollectionResult, dogfood: boolean): Promise<ReviewPacket> {
  const requirements = collection.specIndex.specs.flatMap((spec) => spec.requirements);
  const intentRequirements = requirements.map((requirement, index) => ({
    id: `REQ-${String(index + 1).padStart(3, "0")}`,
    acai_id: requirement.acai_id,
    title: requirement.group_name ?? requirement.group_key,
    requirement: requirement.requirement,
    source_refs: [
      {
        kind: "spec",
        ref: requirement.source_path,
        title: requirement.acai_id,
        evidence: [
          {
            kind: "spec",
            path: requirement.source_path,
            acai_id: requirement.acai_id,
            confidence: "high",
            validation_status: "valid"
          }
        ]
      }
    ],
    constraints: [],
    assumptions: [],
    open_questions: [],
    confidence: "high"
  }));

  const evaluationResults = intentRequirements.map((requirement) => ({
    requirement_id: requirement.id,
    acai_id: requirement.acai_id,
    status: "unknown",
    summary: "Implementation coverage has not been evaluated yet in this skeleton packet.",
    evidence: [],
    missing_evidence: [
      {
        kind: "unknown",
        confidence: "unknown",
        validation_status: "unknown",
        note: "Evaluator module is not implemented in the first local slice."
      }
    ],
    review_focus: "Verify this requirement manually until the evaluator module exists.",
    confidence: "unknown"
  }));

  const packet: ReviewPacket = {
    schema_version: "review-surfaces.packet.v1",
    manifest: stripUndefined(collection.manifest) as unknown as Record<string, unknown>,
    intent: {
      summary: `Indexed ${requirements.length} Acai-backed requirements from ${collection.specIndex.specs.length} feature spec(s).`,
      requirements: intentRequirements,
      constraints: [],
      non_goals: ["Hosted provider integrations and PR comments are outside the first local artifact slice."],
      assumptions: ["The first packet uses deterministic local indexing only; no remote LLM provider was used."],
      open_questions: [],
      sources: collection.specIndex.specs.map((spec) => ({
        kind: "spec",
        ref: spec.path,
        title: spec.feature_name,
        evidence: [
          {
            kind: "spec",
            path: spec.path,
            confidence: "high",
            validation_status: "valid"
          }
        ]
      }))
    },
    evaluation: {
      summary: "Evaluation is intentionally unknown until the evaluator module is implemented.",
      results: evaluationResults,
      overreach: [],
      acai_coverage: Object.fromEntries(intentRequirements.map((requirement) => [requirement.acai_id, "unknown"]))
    },
    architecture: {
      summary: "The first local slice records changed files and source indexes but does not infer architecture beyond deterministic file grouping.",
      diagrams: [],
      subsystems: subsystemCards(collection.changedFiles),
      open_questions: ["Architecture diagrams are planned for review-surfaces.ARCH.* in a later milestone."]
    },
    methodology: {
      summary: "No normalized conversation log was provided to this local run.",
      missing_logs: true,
      considered: [],
      research: [],
      decisions: ["Use deterministic local collection and mock/offline LLM boundaries for the first working version."],
      unchallenged_assumptions: [],
      skipped_checks: [],
      claims_without_evidence: [],
      evidence: []
    },
    risks: {
      summary: "The first packet can show missing evaluation/test evidence but cannot yet score implementation correctness.",
      items: [
        {
          id: "RISK-001",
          category: "testing",
          severity: "medium",
          likelihood: "medium",
          detectability: "easy",
          summary: "Requirement coverage is unknown until evaluator and test evidence ingestion are implemented.",
          impact: "Reviewers must manually inspect coverage for Acai-backed requirements.",
          evidence: [
            {
              kind: "spec",
              path: "features/review-surfaces.feature.yaml",
              acai_id: "review-surfaces.EVAL.1",
              confidence: "high",
              validation_status: "valid"
            }
          ],
          suggested_checks: ["Run focused tests for Acai parsing, schema validation, and collection."],
          manual_review: true
        }
      ],
      test_evidence: [
        {
          id: "TEST-001",
          kind: "unknown",
          summary: "Test command evidence is not embedded in the skeleton packet yet.",
          requirement_ids: [],
          evidence: []
        }
      ],
      test_gaps: [
        {
          id: "GAP-001",
          summary: "Evaluator, risk analyzer, and methodology auditor need fixture coverage in later milestones.",
          suggested_test: "Add fixture tests for missing tests, overreach, missing logs, and invalid evidence.",
          evidence: [
            {
              kind: "spec",
              path: "features/review-surfaces.feature.yaml",
              acai_id: "review-surfaces.QUALITY.2",
              confidence: "high",
              validation_status: "valid"
            }
          ]
        }
      ],
      review_focus: ["Inspect generated indexes and schema validation before trusting higher-level packet sections."]
    }
  };

  if (dogfood) {
    packet.dogfood = {
      milestone: collection.manifest.milestone ?? "unknown",
      command: "review-surfaces all",
      summary: "The CLI generated first local artifacts and a skeleton packet for its own repository.",
      helped_agent: "partially",
      helped_reviewer: "partially",
      findings: [
        {
          id: "DOG-001",
          category: "evidence_quality",
          severity: "medium",
          packet_section: "Requirement coverage",
          finding: "The skeleton packet preserves Acai requirements but marks implementation coverage unknown.",
          impact: "This is honest but still requires manual review until evaluation is implemented.",
          evidence: [
            {
              kind: "spec",
              path: "features/review-surfaces.feature.yaml",
              acai_id: "review-surfaces.EVAL.1",
              confidence: "high",
              validation_status: "valid"
            }
          ],
          remediation: {
            type: "code",
            description: "Implement evaluator coverage mapping in a later milestone.",
            acai_id: "review-surfaces.EVAL.1",
            target_milestone: "M3"
          }
        }
      ],
      remediation_tasks: [
        {
          type: "test",
          description: "Add fixture coverage for sparse specs, missing tests, missing logs, overreach, and invalid evidence.",
          acai_id: "review-surfaces.QUALITY.2",
          target_milestone: "M1"
        }
      ],
      deferrals: ["Architecture diagrams are deferred until review-surfaces.ARCH.* milestone work."]
    };
    packet.agent_handoff = {
      summary: "First working local CLI slice exists: config loading, Acai indexing, collection, schema validation, and skeleton packet rendering.",
      current_milestone: collection.manifest.milestone ?? "M1",
      relevant_acids: [
        "review-surfaces.CLI.1",
        "review-surfaces.COLLECTOR.2",
        "review-surfaces.RENDER.3",
        "review-surfaces.DOGFOOD.1"
      ],
      commands_to_run: [
        "pnpm run typecheck",
        "pnpm run test",
        "pnpm run review-surfaces -- all --base origin/main --head HEAD --spec features/review-surfaces.feature.yaml --dogfood --out .review-surfaces",
        "pnpm run review-surfaces -- validate .review-surfaces/review_packet.json"
      ],
      next_tasks: [
        "Broaden fixture tests for overreach, sparse specs, and missing logs.",
        "Implement evaluator and risk modules with direct versus missing evidence separation.",
        "Replace skeleton architecture output with deterministic subsystem grouping and Mermaid diagrams."
      ],
      open_risks: ["Schema validation is local and intentionally small; replace or harden it before accepting arbitrary external schemas."],
      artifact_paths: [
        ".review-surfaces/manifest.json",
        ".review-surfaces/inputs/specs.index.json",
        ".review-surfaces/review_packet.json",
        ".review-surfaces/review_packet.md"
      ]
    };
  }

  await writePacketArtifacts(collection.outputDir, packet, requirements);
  return packet;
}

async function writePacketArtifacts(outputDir: string, packet: ReviewPacket, requirements: IndexedRequirement[]): Promise<void> {
  await writeJson(path.join(outputDir, "review_packet.json"), packet);
  await writeText(path.join(outputDir, "intent.yaml"), stringifyYaml(packet.intent));
  await writeText(path.join(outputDir, "evaluation.yaml"), stringifyYaml(packet.evaluation));
  await writeText(path.join(outputDir, "methodology.yaml"), stringifyYaml(packet.methodology));
  await writeText(path.join(outputDir, "risks.yaml"), stringifyYaml(packet.risks));
  if (packet.dogfood) {
    await writeText(path.join(outputDir, "dogfood.yaml"), stringifyYaml(packet.dogfood));
  }
  if (packet.agent_handoff) {
    await writeText(path.join(outputDir, "agent_handoff.md"), renderHandoffMarkdown(packet.agent_handoff));
  }
  await writeText(path.join(outputDir, "architecture.md"), renderArchitectureMarkdown(packet, requirements));
  await writeText(path.join(outputDir, "review_packet.md"), renderPacketMarkdown(packet));
}

function subsystemCards(changedFiles: Array<{ path: string; status: string }>): Array<Record<string, unknown>> {
  if (changedFiles.length === 0) {
    return [];
  }
  return [
    {
      id: "SUB-001",
      name: "Changed files",
      summary: "Deterministic list of files changed between the selected refs or in the working tree.",
      files: changedFiles.map((file) => file.path),
      responsibilities: ["Show reviewers the concrete files included in this local run."],
      interactions: [],
      tests: [],
      risks: ["No semantic architecture inference has run yet."],
      evidence: changedFiles.map((file) => ({
        kind: "file",
        path: file.path,
        confidence: "medium",
        validation_status: "not_checked"
      }))
    }
  ];
}

function renderPacketMarkdown(packet: ReviewPacket): string {
  const requirements = packet.intent.requirements as Array<Record<string, string>>;
  const results = packet.evaluation.results as Array<Record<string, string>>;
  const risks = packet.risks.items as Array<Record<string, string>>;

  return `# Review Packet

## 1. Review focus
${(packet.risks.review_focus as string[]).map((item) => `- ${item}`).join("\n") || "- No review focus generated."}

## 2. Intent
${packet.intent.summary}

${previewLines(requirements, (requirement) => `- ${requirement.id} (${requirement.acai_id}): ${requirement.requirement}`)}

## 3. Requirement coverage
${previewLines(results, (result) => `- ${result.requirement_id} (${result.acai_id}): ${result.status} - ${result.summary}`)}

## 4. Architecture surfaces
${packet.architecture.summary}

## 5. Methodology audit
${packet.methodology.summary}

## 6. Test evidence and gaps
${packet.risks.summary}

## 7. Risks
${risks.map((risk) => `- ${risk.id} [${risk.severity}]: ${risk.summary}`).join("\n")}

## 8. Dogfood findings
${packet.dogfood ? ((packet.dogfood.findings as Array<Record<string, string>>).map((finding) => `- ${finding.id}: ${finding.finding}`).join("\n")) : "- Not a dogfood run."}

## 9. Open questions
${(packet.intent.open_questions as string[]).map((item) => `- ${item}`).join("\n") || "- None recorded."}

## 10. Evidence appendix
- Specs indexed: ${(packet.intent.sources as unknown[]).length}
- Packet schema: schemas/review_packet.schema.json
`;
}

function previewLines<T>(items: T[], render: (item: T) => string, limit = 12): string {
  const visible = items.slice(0, limit).map(render);
  if (items.length > limit) {
    visible.push(`- ... ${items.length - limit} more in review_packet.json`);
  }
  return visible.join("\n") || "- None.";
}

function renderArchitectureMarkdown(packet: ReviewPacket, requirements: IndexedRequirement[]): string {
  return `# Architecture

${packet.architecture.summary}

## Evidence-backed Inputs

- Requirements indexed: ${requirements.length}
- Diagrams generated: ${(packet.architecture.diagrams as string[]).length}

## Subsystems

${((packet.architecture.subsystems as Array<Record<string, unknown>>) ?? [])
  .map((subsystem) => `### ${subsystem.name}\n\n${subsystem.summary}\n`)
  .join("\n") || "No changed-file subsystem card was generated."}
`;
}

function renderHandoffMarkdown(handoff: Record<string, unknown>): string {
  return `# Agent Handoff

${handoff.summary}

## Current Milestone

${handoff.current_milestone}

## Relevant ACIDs

${((handoff.relevant_acids as string[]) ?? []).map((item) => `- ${item}`).join("\n")}

## Commands To Run

${((handoff.commands_to_run as string[]) ?? []).map((item) => `- \`${item}\``).join("\n")}

## Next Tasks

${((handoff.next_tasks as string[]) ?? []).map((item) => `- ${item}`).join("\n")}

## Open Risks

${((handoff.open_risks as string[]) ?? []).map((item) => `- ${item}`).join("\n")}

## Artifact Paths

${((handoff.artifact_paths as string[]) ?? []).map((item) => `- \`${item}\``).join("\n")}
`;
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
