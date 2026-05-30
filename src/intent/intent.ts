import path from "node:path";
import { IndexedRequirement } from "../acai/acai";
import { CollectionResult } from "../collector/collect";
import { fileExists, readText } from "../core/files";
import { SourceRef, specEvidence } from "../evidence/evidence";

export interface IntentRequirement {
  id: string;
  acai_id?: string;
  title?: string;
  requirement: string;
  source_refs: SourceRef[];
  constraints: string[];
  assumptions: string[];
  open_questions: string[];
  confidence: "high" | "medium" | "low" | "unknown";
  /**
   * True for requirements proposed by an LLM/agent reasoning stage rather than
   * indexed from an authoritative Acai spec. Such requirements never carry an
   * acai_id and never reach confidence "high".
   */
  llm_derived?: boolean;
}

export interface IntentModel {
  summary: string;
  requirements: IntentRequirement[];
  constraints: string[];
  non_goals: string[];
  assumptions: string[];
  open_questions: string[];
  sources: SourceRef[];
}

export async function buildIntent(cwd: string, collection: CollectionResult): Promise<IntentModel> {
  const specRequirements = collection.specIndex.specs.flatMap((spec) => spec.requirements);
  const requirements = specRequirements.map((requirement, index) => toIntentRequirement(requirement, index));
  const docSignals = await readDocSignals(cwd, collection.docs.map((doc) => doc.path));

  const constraints = [
    ...requirements
      .filter((requirement) => requirement.acai_id?.includes(".EVIDENCE.") || requirement.acai_id?.includes(".PRIVACY."))
      .slice(0, 8)
      .map((requirement) => `${requirement.acai_id}: ${requirement.requirement}`),
    ...docSignals.constraints
  ];

  const nonGoals = [
    "GitHub comments, dashboards, hosted Acai sync, and CI-first workflows are later renderers over local artifacts.",
    ...docSignals.non_goals
  ];

  const assumptions = [
    "Intent was built deterministically from local specs and docs; LLM enrichment is optional.",
    ...docSignals.assumptions
  ];

  const openQuestions = [
    ...docSignals.open_questions,
    ...sparseSourceQuestions(collection.specIndex.specs.length, requirements.length, collection.docs.length)
  ];
  const sources: SourceRef[] = [
    ...collection.specIndex.specs.map((spec) => ({
      kind: "spec" as const,
      ref: spec.path,
      title: spec.feature_name,
      evidence: [specEvidence(spec.path)]
    })),
    ...collection.docs.map((doc) => ({
      kind: doc.kind === "agent_instruction" || doc.kind === "agent_skill" ? ("file" as const) : ("doc" as const),
      ref: doc.path,
      title: doc.kind
    }))
  ];

  return {
    summary: `Built deterministic intent from ${collection.specIndex.specs.length} Acai spec(s), ${collection.docs.length} doc/agent input(s), and ${requirements.length} requirement(s).`,
    requirements,
    constraints: unique(constraints),
    non_goals: unique(nonGoals),
    assumptions: unique(assumptions),
    open_questions: unique(openQuestions),
    sources
  };
}

function toIntentRequirement(requirement: IndexedRequirement, index: number): IntentRequirement {
  return {
    id: `REQ-${String(index + 1).padStart(3, "0")}`,
    acai_id: requirement.acai_id,
    title: requirement.group_name ?? requirement.group_key,
    requirement: requirement.requirement,
    source_refs: [
      {
        kind: "spec",
        ref: requirement.source_path,
        title: requirement.acai_id,
        evidence: [specEvidence(requirement.source_path, requirement.acai_id, requirement.note || undefined)]
      }
    ],
    constraints: requirement.group_kind === "constraint" ? [requirement.requirement] : [],
    assumptions: [],
    open_questions: [],
    confidence: "high"
  };
}

async function readDocSignals(cwd: string, docPaths: string[]): Promise<{
  constraints: string[];
  non_goals: string[];
  assumptions: string[];
  open_questions: string[];
}> {
  const constraints: string[] = [];
  const non_goals: string[] = [];
  const assumptions: string[] = [];
  const open_questions: string[] = [];

  for (const docPath of docPaths) {
    const absolutePath = path.resolve(cwd, docPath);
    if (!fileExists(absolutePath)) {
      continue;
    }
    const text = await readText(absolutePath);
    for (const line of text.split("\n")) {
      const clean = line.replace(/^[-*#\s]+/, "").trim();
      if (clean === "") {
        continue;
      }
      const lower = clean.toLowerCase();
      if ((lower.includes("must") || lower.includes("non-negotiable") || lower.includes("constraint")) && constraints.length < 12) {
        constraints.push(`${docPath}: ${clean}`);
      }
      if ((lower.includes("later renderer") || lower.includes("not require") || lower.includes("do not start")) && non_goals.length < 8) {
        non_goals.push(`${docPath}: ${clean}`);
      }
      if ((lower.includes("assumes") || lower.includes("assumption")) && assumptions.length < 8) {
        assumptions.push(`${docPath}: ${clean}`);
      }
      if (hasExplicitConflictMarker(clean) && open_questions.length < 8) {
        open_questions.push(`${docPath}: Possible conflicting source: ${clean}`);
      }
      if (clean.endsWith("?") && !isReviewerChecklistQuestion(clean) && open_questions.length < 8) {
        open_questions.push(`${docPath}: ${clean}`);
      }
    }
  }

  return { constraints, non_goals, assumptions, open_questions };
}

function isReviewerChecklistQuestion(value: string): boolean {
  const normalized = value.replace(/^\d+\.\s*/, "").trim().toLowerCase();
  return new Set([
    "what changed?",
    "why?",
    "what proves it?",
    "what is missing?",
    "where should i look first?"
  ]).has(normalized);
}

function hasExplicitConflictMarker(value: string): boolean {
  return /^(conflict|contradiction|conflicting source)\s*:/i.test(value);
}

function sparseSourceQuestions(specCount: number, requirementCount: number, docCount: number): string[] {
  const questions: string[] = [];
  if (specCount === 0 || requirementCount === 0) {
    questions.push("No Acai requirements were indexed; confirm the intended task scope before evaluating implementation coverage.");
  }
  if (docCount === 0) {
    questions.push("No docs or agent instruction inputs were indexed; confirm constraints, non-goals, and reviewer expectations.");
  }
  return questions;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
