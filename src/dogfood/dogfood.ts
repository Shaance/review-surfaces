import { CollectionResult } from "../collector/collect";
import { EvidenceRef } from "../evidence/evidence";
import { EvaluationModel } from "../evaluation/evaluate";
import { FeedbackFile, FeedbackFinding } from "../feedback/feedback";
import { MethodologyModel } from "../methodology/methodology";
import { RisksModel } from "../risks/risks";

export interface DogfoodModel {
  milestone: string;
  command?: string;
  summary: string;
  helped_agent?: "yes" | "partially" | "no" | "unknown";
  helped_reviewer?: "yes" | "partially" | "no" | "unknown";
  findings: Array<{
    id: string;
    category: "usability" | "review_value" | "evidence_quality" | "agent_workflow" | "schema" | "diagram_quality" | "test_gap" | "performance" | "unknown";
    severity: "low" | "medium" | "high" | "critical" | "unknown";
    packet_section?: string;
    finding: string;
    impact?: string;
    evidence?: EvidenceRef[];
    remediation?: {
      type: "code" | "test" | "schema" | "doc" | "spec" | "skill" | "feedback" | "defer";
      description: string;
      acai_id?: string;
      target_milestone?: string;
    };
  }>;
  remediation_tasks?: Array<{
    type: "code" | "test" | "schema" | "doc" | "spec" | "skill" | "feedback" | "defer";
    description: string;
    acai_id?: string;
    target_milestone?: string;
  }>;
  deferrals?: string[];
}

export function buildDogfood(
  collection: CollectionResult,
  evaluation: EvaluationModel,
  risks: RisksModel,
  methodology: MethodologyModel,
  providerName: string,
  commands: string[]
): DogfoodModel {
  const unsatisfied = evaluation.results.filter((result) => result.status !== "satisfied").length;
  const feedbackFindings = collection.feedback.flatMap((feedbackFile) => feedbackFile.findings);
  const highlightedFeedbackFindings = selectFeedbackFindings(collection.feedback, 8);
  const noisySections: string[] = [];
  if (risks.test_gaps.length > 15) {
    noisySections.push("test_gaps");
  }
  if (evaluation.results.length > 50) {
    noisySections.push("requirement_coverage");
  }

  return {
    milestone: collection.manifest.milestone ?? "MVP",
    command: commands.find((command) => command.includes("review-surfaces")) ?? "review-surfaces dogfood",
    summary: `Dogfood generated a packet with ${evaluation.results.length} requirement result(s), ${risks.items.length} risk(s), ${feedbackFindings.length} feedback finding(s), provider=${providerName}, noisy_sections=${noisySections.join(",") || "none"}.`,
    helped_agent: unsatisfied < evaluation.results.length ? "partially" : "unknown",
    helped_reviewer: risks.review_focus.length > 0 ? "partially" : "unknown",
    findings: [
      {
        id: "DOG-001",
        category: unsatisfied > 0 ? "evidence_quality" : "review_value",
        severity: unsatisfied > 0 ? "medium" : "low",
        packet_section: "Requirement coverage",
        finding: `${unsatisfied} requirement result(s) are not satisfied and need stronger evidence, implementation, tests, or explicit deferral.`,
        impact: "The packet is useful for review focus but should not be read as complete coverage.",
        evidence: [
          {
            kind: "spec",
            path: "features/review-surfaces.feature.yaml",
            confidence: "high",
            validation_status: "valid"
          }
        ],
        remediation: {
          type: "test",
          description: "Add fixture tests and evidence mapping for recurring unknown/missing results.",
          acai_id: "review-surfaces.QUALITY.2",
          target_milestone: "MVP"
        }
      },
      {
        id: "DOG-002",
        category: "agent_workflow",
        severity: methodology.missing_logs ? "low" : "medium",
        packet_section: "Methodology",
        finding: methodology.missing_logs ? "No conversation log was provided; methodology is marked not_provided." : "Conversation log was normalized and summarized.",
        impact: methodology.missing_logs ? "Workflow audit cannot judge options considered beyond local files." : "Workflow audit can help the next agent reconstruct process evidence.",
        remediation: {
          type: methodology.missing_logs ? "defer" : "doc",
          description: methodology.missing_logs ? "Provide --conversation when process reconstruction matters." : "Keep conversation adapters small and evidence-bound.",
          acai_id: "review-surfaces.METHODOLOGY.4",
          target_milestone: "MVP"
        }
      },
      ...highlightedFeedbackFindings.map((finding, index) => ({
        id: `DOG-FB-${String(index + 1).padStart(3, "0")}`,
        category: finding.category,
        severity: finding.severity,
        packet_section: finding.affected_section,
        finding: `Feedback ${finding.id}: ${finding.finding}`,
        impact: "Human or agent feedback is part of the local dogfood loop and should shape the next implementation slice.",
        evidence: finding.evidence,
        remediation: finding.desired_change
          ? {
              type: "feedback" as const,
              description: finding.desired_change,
              target_milestone: "MVP"
            }
          : undefined
      }))
    ],
    remediation_tasks: [
      ...risks.test_gaps.slice(0, 5).map((gap) => ({
        type: "test" as const,
        description: gap.suggested_test ?? gap.summary,
        acai_id: gap.acai_id,
        target_milestone: "MVP"
      })),
      ...feedbackFindings
        .filter((finding) => finding.desired_change)
        .slice(-5)
        .map((finding) => ({
          type: "feedback" as const,
          description: finding.desired_change as string,
          target_milestone: "MVP"
        }))
    ],
    deferrals: [
      "Provider comments and hosted dashboards remain deferred per local-first scope.",
      providerName === "mock" ? "AI SDK enrichment was not used in the default offline dogfood run." : `Provider used: ${providerName}.`
    ]
  };
}

function selectFeedbackFindings(feedbackFiles: FeedbackFile[], limit: number): FeedbackFinding[] {
  const selected: FeedbackFinding[] = [];
  const seen = new Set<string>();
  const add = (finding: FeedbackFinding | undefined): void => {
    if (!finding || seen.has(finding.id) || selected.length >= limit) {
      return;
    }
    seen.add(finding.id);
    selected.push(finding);
  };

  for (const feedbackFile of feedbackFiles) {
    add(feedbackFile.findings[feedbackFile.findings.length - 1]);
  }

  const allFindings = feedbackFiles.flatMap((feedbackFile) => feedbackFile.findings);
  for (let index = allFindings.length - 1; index >= 0; index -= 1) {
    add(allFindings[index]);
  }

  return selected;
}
