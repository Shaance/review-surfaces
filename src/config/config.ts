import path from "node:path";
import { fileExists, readText } from "../core/files";
import { parseYaml } from "../core/simple-yaml";

export interface ReviewSurfacesConfig {
  schema_version: string;
  output_dir: string;
  specs: string[];
  docs: string[];
  tests: string[];
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
  return {
    schema_version: stringValue(raw.schema_version, defaultConfig.schema_version),
    output_dir: stringValue(raw.output_dir, defaultConfig.output_dir),
    specs: stringArray(raw.specs, defaultConfig.specs),
    docs: stringArray(raw.docs, defaultConfig.docs),
    tests: stringArray(raw.tests, defaultConfig.tests),
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
    }
  };
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

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
