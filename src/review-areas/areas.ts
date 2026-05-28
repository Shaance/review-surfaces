export interface ReviewArea {
  id: string;
  name: string;
  groupKey: string;
  prefixes: string[];
  purpose: string;
  pattern: string;
  testKeywords: string[];
}

export const REVIEW_AREAS: ReviewArea[] = [
  area("SUB-CLI", "CLI orchestration", "CLI", ["src/cli/", "bin/", "package.json"], "Parse commands and wire local pipeline stages.", "command dispatcher", ["cli"]),
  area("SUB-COLLECT", "Collection and indexing", "COLLECTOR", ["src/collector/", "src/acai/", "src/core/", "src/commands/"], "Collect Git, diff, docs, tests, and input indexes.", "deterministic collector", ["acai", "collect", "command"]),
  area("SUB-BOOTSTRAP", "Bootstrap files", "BOOTSTRAP", ["AGENTS.md", "CLAUDE.md", ".agents/", "features/", "docs/review-surfaces-trd.md", "review-surfaces.config.yaml", "src/config/", "scripts/copy-env.sh", "scripts/SECRETS.md"], "Keep local source-of-truth and agent workflow files available.", "spec-first bootstrap", ["config", "bootstrap"]),
  area("SUB-INTENT", "Intent builder", "INTENT", ["src/intent/"], "Build requirements and source-backed intent.", "deterministic synthesis", ["intent"]),
  area("SUB-EVAL", "Evaluator", "EVAL", ["src/evaluation/"], "Map intent requirements to implementation and test evidence.", "evidence classifier", ["eval", "evaluation"]),
  area("SUB-RISK", "Risk analyzer", "RISK", ["src/risks/"], "Summarize risks, test evidence, gaps, and review focus.", "risk register", ["risk"]),
  area("SUB-DIAGRAM", "Diagram generator", "ARCH", ["src/diagrams/", "architecture.md"], "Generate Mermaid diagrams and subsystem cards.", "artifact renderer", ["arch", "diagram"]),
  area("SUB-METH", "Methodology auditor", "METHODOLOGY", ["src/methodology/"], "Normalize conversation logs and process evidence.", "log normalizer", ["method"]),
  area("SUB-LLM", "Optional enrichment", "EVIDENCE", ["src/llm/"], "Optionally enrich packet summaries through mock, AI SDK, or agent files without treating them as proof.", "bounded optional adapter", ["llm", "provider"]),
  area("SUB-EVIDENCE", "Evidence and schema validation", "EVIDENCE", ["src/evidence/", "src/schema/", "src/review-areas/"], "Represent and validate evidence references used by packet claims.", "evidence model", ["evidence", "evaluation"]),
  area("SUB-PRIVACY", "Privacy controls", "PRIVACY", [".review-surfacesignore", ".env.example", "src/privacy/"], "Exclude sensitive files and prepare redaction boundaries before remote provider use.", "privacy guard", ["privacy"]),
  area("SUB-DOGFOOD", "Dogfood loop", "DOGFOOD", ["src/dogfood/", "src/feedback/", ".review-surfaces/agent_handoff.md", ".review-surfaces/feedback/", "docs/dogfooding.md"], "Turn self-review findings into local product feedback and handoff.", "feedback loop", ["dogfood", "feedback"]),
  area("SUB-RENDER", "Packet renderer", "RENDER", ["src/render/"], "Write JSON/YAML/Markdown packet artifacts.", "stable renderer", ["packet", "render"]),
  area("SUB-QUALITY", "Tests and fixtures", "QUALITY", ["tests/", "package.json"], "Verify local parsing, evidence, providers, and packet behavior.", "fixture tests", []),
  area("SUB-SCHEMA", "Packet schema", "SCHEMA", ["schemas/"], "Define machine-readable packet contracts.", "JSON schema", ["schema"])
];

export function groupsForReviewPath(filePath: string): string[] {
  const groups = REVIEW_AREAS
    .filter((area) => area.prefixes.some((prefix) => matchesPrefix(filePath, prefix)))
    .map((area) => area.groupKey);

  if (filePath.startsWith("tests/")) {
    for (const area of REVIEW_AREAS) {
      if (area.testKeywords.some((keyword) => filePath.toLowerCase().includes(keyword))) {
        groups.push(area.groupKey);
      }
    }
  }

  return [...new Set(groups)];
}

export function isLaterProviderGroup(groupKey: string): boolean {
  return groupKey === "PROVIDERS";
}

export function matchesReviewPrefix(filePath: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => matchesPrefix(filePath, prefix));
}

function area(
  id: string,
  name: string,
  groupKey: string,
  prefixes: string[],
  purpose: string,
  pattern: string,
  testKeywords: string[]
): ReviewArea {
  return { id, name, groupKey, prefixes, purpose, pattern, testKeywords };
}

function matchesPrefix(filePath: string, prefix: string): boolean {
  return filePath === prefix || filePath.startsWith(prefix) || filePath.includes(prefix);
}
