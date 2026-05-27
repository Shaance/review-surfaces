import path from "node:path";
import { readText } from "../core/files";
import { parseYaml } from "../core/simple-yaml";

export interface AcaiSpecIndex {
  schema_version: "review-surfaces.specs.index.v1";
  specs: IndexedSpec[];
}

export interface IndexedSpec {
  path: string;
  feature_name: string;
  product?: string;
  version?: string;
  draft?: boolean;
  requirements: IndexedRequirement[];
}

export interface IndexedRequirement {
  acai_id: string;
  group_kind: "component" | "constraint";
  group_key: string;
  group_name?: string;
  requirement_id: string;
  requirement: string;
  note?: string;
  source_path: string;
}

interface ParsedSpec {
  feature: {
    name: string;
    product?: string;
    version?: string;
    draft?: boolean;
  };
  components?: Record<string, ParsedGroup>;
  constraints?: Record<string, ParsedGroup>;
}

interface ParsedGroup {
  name?: string;
  description?: string;
  requirements?: Record<string, string | ParsedRequirement>;
}

interface ParsedRequirement {
  requirement?: string;
  note?: string;
}

export async function indexAcaiSpecs(cwd: string, specPaths: string[]): Promise<AcaiSpecIndex> {
  const specs: IndexedSpec[] = [];

  for (const specPath of specPaths.sort()) {
    specs.push(await parseAcaiSpec(cwd, specPath));
  }

  return {
    schema_version: "review-surfaces.specs.index.v1",
    specs
  };
}

export async function parseAcaiSpec(cwd: string, specPath: string): Promise<IndexedSpec> {
  const absolutePath = path.resolve(cwd, specPath);
  const parsed = parseYaml(await readText(absolutePath));
  assertParsedSpec(parsed, specPath);

  const requirements: IndexedRequirement[] = [
    ...requirementsForGroups(parsed.feature.name, specPath, "component", parsed.components ?? {}),
    ...requirementsForGroups(parsed.feature.name, specPath, "constraint", parsed.constraints ?? {})
  ];

  return {
    path: specPath,
    feature_name: parsed.feature.name,
    product: parsed.feature.product,
    version: parsed.feature.version,
    draft: parsed.feature.draft,
    requirements
  };
}

export function requirementsForGroups(
  featureName: string,
  specPath: string,
  groupKind: "component" | "constraint",
  groups: Record<string, ParsedGroup>
): IndexedRequirement[] {
  const indexed: IndexedRequirement[] = [];
  for (const [groupKey, group] of Object.entries(groups)) {
    const requirements = group.requirements ?? {};
    for (const [requirementId, rawRequirement] of Object.entries(requirements)) {
      const body = normalizeRequirement(rawRequirement);
      indexed.push({
        acai_id: `${featureName}.${groupKey}.${requirementId}`,
        group_kind: groupKind,
        group_key: groupKey,
        group_name: group.name,
        requirement_id: requirementId,
        requirement: body.requirement,
        note: body.note,
        source_path: specPath
      });
    }
  }
  return indexed;
}

function normalizeRequirement(rawRequirement: string | ParsedRequirement): Required<ParsedRequirement> {
  if (typeof rawRequirement === "string") {
    return {
      requirement: rawRequirement,
      note: ""
    };
  }

  return {
    requirement: rawRequirement.requirement ?? "",
    note: rawRequirement.note ?? ""
  };
}

function assertParsedSpec(value: unknown, specPath: string): asserts value is ParsedSpec {
  if (!isRecord(value) || !isRecord(value.feature) || typeof value.feature.name !== "string") {
    throw new Error(`Feature spec ${specPath} must contain feature.name`);
  }
  if (value.components !== undefined && !isRecord(value.components)) {
    throw new Error(`Feature spec ${specPath} components must be an object`);
  }
  if (value.constraints !== undefined && !isRecord(value.constraints)) {
    throw new Error(`Feature spec ${specPath} constraints must be an object`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
