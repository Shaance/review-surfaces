import path from "node:path";
import { parseBudgetDuration } from "../human/budget";
import type { CommandRule, CommandRuleClassification } from "../commands/classify";
import { CliError, ExitCodes } from "../core/exit-codes";
import { fileExists, readText } from "../core/files";
import { isRecord } from "../core/guards";
import { parseYaml } from "../core/simple-yaml";
import {
  DEFAULT_HUMAN_REVIEW_BUILD_CONFIG,
  HumanReviewBuildConfig,
  HumanReviewRequiredManualCheckConfig,
  RISK_LENSES,
  RiskLens
} from "../human/contract";
import { PACKET_SEVERITIES } from "../schema/review-packet-contract";

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
    allow_missing: string[];
    // review-surfaces.QUALITY_GATE.1: optional default risk-severity threshold for
    // the --fail-on gate. null (the default) leaves the risk gate OFF; a severity
    // ("critical"|"high"|"medium"|"low"|"unknown") trips the quality gate when any
    // non-hypothesis risk item is at or above it. --fail-on overrides this default.
    fail_on: string | null;
  };
  human_review: HumanReviewBuildConfig & {
    enabled: boolean;
    default_entrypoint: boolean;
  };
  // review-surfaces.COLLECTOR.9: validated repository wrapper command rules. A
  // direct command is always classified by the built-ins; these rules only
  // classify local wrappers the built-ins do not recognize. Empty by default.
  command_rules: CommandRule[];
}

export const defaultConfig: ReviewSurfacesConfig = {
  schema_version: "review-surfaces.config.v1",
  output_dir: ".review-surfaces",
  specs: ["features/**/*.feature.yaml"],
  docs: ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md", "docs/**/*.md", ".agents/skills/**/SKILL.md"],
  // review-surfaces.COLLECTOR.8: zero-config repositories index Swift/Xcode tests
  // alongside the existing JS/TS defaults (added, not replaced) so XCTest / Swift
  // Testing suites are collected as tests rather than implementation.
  tests: [
    "tests/**/*.test.ts",
    "tests/**/*.test.js",
    "**/*Tests.swift",
    "**/*Test.swift",
    "**/Tests/**/*.swift",
    "**/UITests/**/*.swift"
  ],
  privacy: {
    ignore_file: ".review-surfacesignore",
    redact_secrets: true
  },
  llm: {
    // review-surfaces.PROVIDERS.3: local MVP runs against the deterministic mock
    // provider unless a caller opts into a provider adapter.
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
    max_missing: 0,
    // Acai IDs allowed to be missing (a planned, not-yet-implemented backlog).
    // Allowlisted misses are excluded from the gate so an unrelated regression
    // still trips it. Empty by default.
    allow_missing: [],
    // The risk-severity gate is OFF by default; opt in via config or --fail-on.
    fail_on: null
  },
  human_review: {
    enabled: true,
    default_entrypoint: true,
    ...DEFAULT_HUMAN_REVIEW_BUILD_CONFIG
  },
  command_rules: []
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
      max_missing: nonNegativeIntValue(readRecord(raw.quality_gate).max_missing, defaultConfig.quality_gate.max_missing),
      allow_missing: stringArray(readRecord(raw.quality_gate).allow_missing, defaultConfig.quality_gate.allow_missing),
      // review-surfaces.QUALITY_GATE.1: an UNSET (null/absent) fail_on leaves the
      // risk gate off; a SET value must be a recognized severity. An invalid
      // non-null value (a typo like "hihg") FAILS the load loudly — like a bad
      // --fail-on — instead of being silently nulled, which would disarm the gate
      // for every default run without the operator noticing.
      fail_on: failOnSeverityValue(readRecord(raw.quality_gate).fail_on, defaultConfig.quality_gate.fail_on)
    },
    human_review: {
      enabled: booleanValue(readRecord(raw.human_review).enabled, defaultConfig.human_review.enabled),
      default_entrypoint: booleanValue(readRecord(raw.human_review).default_entrypoint, defaultConfig.human_review.default_entrypoint),
      max_review_first: positiveIntValue(readRecord(raw.human_review).max_review_first, defaultConfig.human_review.max_review_first),
      max_suggested_comments: positiveIntValue(
        readRecord(raw.human_review).max_suggested_comments,
        defaultConfig.human_review.max_suggested_comments
      ),
      max_questions: positiveIntValue(readRecord(raw.human_review).max_questions, defaultConfig.human_review.max_questions),
      risk_lenses: riskLensConfig(readRecord(raw.human_review).risk_lenses, defaultConfig.human_review.risk_lenses),
      required_manual_checks: requiredManualChecksConfig(
        readRecord(raw.human_review).required_manual_checks,
        defaultConfig.human_review.required_manual_checks
      ),
      // YAML path human_review.narrative.max_claims -> flat build-config field.
      narrative_max_claims: positiveIntValue(
        readRecord(readRecord(raw.human_review).narrative).max_claims,
        defaultConfig.human_review.narrative_max_claims
      ),
      // review-surfaces.BUDGET.1: human_review.review_budget ("15m"/"1h"), default
      // off. Invalid values fall back to off rather than failing the load.
      review_budget_minutes:
        parseBudgetDuration(typeof readRecord(raw.human_review).review_budget === "string" ? (readRecord(raw.human_review).review_budget as string) : undefined) ??
        defaultConfig.human_review.review_budget_minutes
    },
    command_rules: parseCommandRules(raw.command_rules)
  };
}

// review-surfaces.COLLECTOR.9: parse and VALIDATE wrapper command rules. A
// malformed or duplicate rule FAILS the load loudly (usage exit code) rather than
// silently weakening evidence — the same fail-fast contract as quality_gate.fail_on.
// Rules are sorted most-specific-first (longest command, then exact over prefix,
// then id) so application order is deterministic regardless of authored order.
const COMMAND_RULE_MATCHES: readonly CommandRule["match"][] = ["exact", "prefix"];
const COMMAND_RULE_CLASSIFICATIONS: readonly CommandRuleClassification[] = ["broad_test", "focused_test", "validation"];

function parseCommandRules(value: unknown): CommandRule[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new CliError("Invalid command_rules: must be a list of rule objects.", ExitCodes.usageError);
  }
  const rules: CommandRule[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const record = readRecord(entry);
    const id = stringValue(record.id, "").trim();
    const command = stringValue(record.command, "").trim();
    const match = stringValue(record.match, "");
    const classification = stringValue(record.classification, "");
    const where = `command_rules[${index}]`;
    if (!id) {
      throw new CliError(`Invalid ${where}: a stable non-empty id is required.`, ExitCodes.usageError);
    }
    if (seenIds.has(id)) {
      throw new CliError(`Invalid command_rules: duplicate id ${JSON.stringify(id)}.`, ExitCodes.usageError);
    }
    if (!command) {
      throw new CliError(`Invalid ${where} (${id}): a non-empty command is required.`, ExitCodes.usageError);
    }
    if (!(COMMAND_RULE_MATCHES as string[]).includes(match)) {
      throw new CliError(`Invalid ${where} (${id}): match must be one of ${COMMAND_RULE_MATCHES.join(", ")}.`, ExitCodes.usageError);
    }
    if (!(COMMAND_RULE_CLASSIFICATIONS as string[]).includes(classification)) {
      throw new CliError(
        `Invalid ${where} (${id}): classification must be one of ${COMMAND_RULE_CLASSIFICATIONS.join(", ")}.`,
        ExitCodes.usageError
      );
    }
    seenIds.add(id);
    rules.push({ id, command, match: match as CommandRule["match"], classification: classification as CommandRuleClassification });
  }
  return sortCommandRules(rules);
}

function sortCommandRules(rules: CommandRule[]): CommandRule[] {
  return rules.slice().sort((left, right) => {
    if (left.command.length !== right.command.length) {
      return right.command.length - left.command.length; // longest (most specific) first
    }
    if (left.match !== right.match) {
      return left.match === "exact" ? -1 : 1; // exact beats prefix on equal length
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function positiveIntValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeIntValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

// review-surfaces.QUALITY_GATE.1: resolve the risk-gate threshold from config.
// An UNSET value (null/undefined/absent) leaves the gate OFF (the fallback). A
// SET value MUST be a recognized PacketSeverity; an invalid non-null value (a
// typo like "hihg", an empty string, or a non-string) FAILS the load loudly —
// the same fail-fast contract as a bad --fail-on — rather than being silently
// nulled, which would disarm the risk gate for every default run.
function failOnSeverityValue(value: unknown, fallback: string | null): string | null {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string" && (PACKET_SEVERITIES as readonly string[]).includes(value)) {
    return value;
  }
  // Throw a CliError carrying the usage exit code (2) so an invalid config
  // fail_on exits like a bad `--fail-on` flag, NOT a runtime failure (exit 1):
  // the CLI top-level catch maps a plain Error to runtimeError but honors a
  // CliError's exitCode. exit-codes.ts imports nothing, so there is no cycle.
  throw new CliError(
    `Invalid quality_gate.fail_on: ${JSON.stringify(value)}. Must be null (off) or one of ${PACKET_SEVERITIES.join(", ")}.`,
    ExitCodes.usageError
  );
}

function riskLensConfig(value: unknown, fallback: Record<RiskLens, boolean>): Record<RiskLens, boolean> {
  const record = readRecord(value);
  const config = { ...fallback };
  for (const lens of RISK_LENSES) {
    if (typeof record[lens] === "boolean") {
      config[lens] = record[lens];
    }
  }
  return config;
}

function requiredManualChecksConfig(value: unknown, fallback: HumanReviewRequiredManualCheckConfig[]): HumanReviewRequiredManualCheckConfig[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const checks: HumanReviewRequiredManualCheckConfig[] = [];
  for (const [index, entry] of value.entries()) {
    const record = readRecord(entry);
    const id = stringValue(record.id, `manual_check_${index + 1}`).trim();
    const prompt = stringValue(record.prompt, stringValue(record.required_manual_check, "")).trim();
    const pathPatterns = uniqueStrings([
      ...stringArray(record.path_patterns, []),
      ...stringArray(record.paths, []),
      ...compactString(record.path_pattern),
      ...compactString(record.path)
    ]);
    if (!id || !prompt || pathPatterns.length === 0) {
      continue;
    }
    checks.push({
      id,
      path_patterns: pathPatterns,
      prompt
    });
  }
  return checks;
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

function compactString(value: unknown): string[] {
  return typeof value === "string" && value.trim() ? [value] : [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
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
