import path from "node:path";
import { fileExists, readText } from "../core/files";
import { isRecord } from "../core/guards";
import { parseYaml } from "../core/simple-yaml";

export interface ReviewAreaConfig {
  id: string;
  name: string;
  group_key: string;
  prefixes: string[];
  purpose: string;
  pattern: string;
  test_keywords: string[];
}

export interface ReviewSurfacesConfig {
  schema_version: string;
  output_dir: string;
  specs: string[];
  docs: string[];
  tests: string[];
  areas?: ReviewAreaConfig[];
  privacy: {
    ignore_file: string;
    redact_secrets: boolean;
  };
  llm: {
    provider: string;
    model: string | null;
    require_json_schema: boolean;
  };
  diagrams: {
    format: string;
  };
  render: {
    mode: string;
    include_evidence_appendix: boolean;
  };
  dogfood: {
    enabled: boolean;
    milestone: string;
  };
  quality_gate: {
    max_missing: number;
  };
}

export const defaultConfig: ReviewSurfacesConfig = {
  schema_version: "review-surfaces.config.v1",
  output_dir: ".review-surfaces",
  specs: ["features/**/*.feature.yaml"],
  docs: ["README.md", "README.bootstrap.md", "AGENTS.md", "CLAUDE.md", "docs/**/*.md", ".agents/skills/**/SKILL.md"],
  tests: ["tests/**/*.test.ts", "tests/**/*.test.js"],
  privacy: {
    ignore_file: ".review-surfacesignore",
    redact_secrets: true
  },
  llm: {
    provider: "mock",
    model: null,
    require_json_schema: true
  },
  diagrams: {
    format: "mermaid"
  },
  render: {
    mode: "compact",
    include_evidence_appendix: true
  },
  dogfood: {
    enabled: false,
    milestone: "unknown"
  },
  quality_gate: {
    // The default quality gate trips when there is ANY missing requirement.
    // Tune upward in config (quality_gate.max_missing) or via --max-missing N
    // to tolerate a known number of missing requirements before failing.
    max_missing: 0
  }
};

export async function loadConfig(cwd: string, configPath = "review-surfaces.config.yaml"): Promise<ReviewSurfacesConfig> {
  const absolutePath = path.resolve(cwd, configPath);
  if (!fileExists(absolutePath)) {
    return defaultConfig;
  }

  const parsed = parseYaml(await readText(absolutePath));
  if (!isRecord(parsed)) {
    throw new Error(`Config file ${configPath} must contain a YAML object`);
  }

  return normalizeConfig(parsed);
}

export function normalizeConfig(raw: Record<string, unknown>): ReviewSurfacesConfig {
  const areas = parseAreas(raw.areas);
  return {
    schema_version: stringValue(raw.schema_version, defaultConfig.schema_version),
    output_dir: stringValue(raw.output_dir, defaultConfig.output_dir),
    specs: stringArray(raw.specs, defaultConfig.specs),
    docs: stringArray(raw.docs, defaultConfig.docs),
    tests: stringArray(raw.tests, defaultConfig.tests),
    ...(areas ? { areas } : {}),
    privacy: {
      ignore_file: stringValue(readRecord(raw.privacy).ignore_file, defaultConfig.privacy.ignore_file),
      redact_secrets: booleanValue(readRecord(raw.privacy).redact_secrets, defaultConfig.privacy.redact_secrets)
    },
    llm: {
      provider: stringValue(readRecord(raw.llm).provider, defaultConfig.llm.provider),
      model: nullableString(readRecord(raw.llm).model, defaultConfig.llm.model),
      require_json_schema: booleanValue(readRecord(raw.llm).require_json_schema, defaultConfig.llm.require_json_schema)
    },
    diagrams: {
      format: stringValue(readRecord(raw.diagrams).format, defaultConfig.diagrams.format)
    },
    render: {
      mode: stringValue(readRecord(raw.render).mode, defaultConfig.render.mode),
      include_evidence_appendix: booleanValue(
        readRecord(raw.render).include_evidence_appendix,
        defaultConfig.render.include_evidence_appendix
      )
    },
    dogfood: {
      enabled: booleanValue(readRecord(raw.dogfood).enabled, defaultConfig.dogfood.enabled),
      milestone: stringValue(readRecord(raw.dogfood).milestone, defaultConfig.dogfood.milestone)
    },
    quality_gate: {
      max_missing: nonNegativeIntValue(readRecord(raw.quality_gate).max_missing, defaultConfig.quality_gate.max_missing)
    }
  };
}

function nonNegativeIntValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown, fallback: string | null): string | null {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

function onlyStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseAreas(value: unknown): ReviewAreaConfig[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const areas: ReviewAreaConfig[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = stringValue(entry.id, "");
    const group_key = stringValue(entry.group_key, "");
    if (!id || !group_key) {
      continue;
    }
    areas.push({
      id,
      name: stringValue(entry.name, id),
      group_key,
      prefixes: onlyStrings(entry.prefixes),
      purpose: stringValue(entry.purpose, ""),
      pattern: stringValue(entry.pattern, ""),
      test_keywords: onlyStrings(entry.test_keywords)
    });
  }
  return areas;
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
