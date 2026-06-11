import path from "node:path";
import fs from "node:fs";
import { defaultConfig } from "../config/config";
import { fileExists, readText, relativePath, writeText } from "../core/files";
import { stringifyYaml } from "../core/simple-yaml";
import { VERSION } from "../core/version";
import { DEFAULT_PRIVACY_IGNORE_PATTERNS } from "../privacy/ignore";
import { packagedSchemaPath } from "../schema/packaged-schemas";
import { parseAcaiSpec } from "../acai/acai";
import { loadConfig } from "../config/config";
import { expandPatterns } from "../core/glob";

/**
 * Phase 2 bootstrap scaffolding.
 *
 * `init` performs CREATE-OR-VALIDATE against a target repository (cwd):
 *   - missing target  -> create it
 *   - present target  -> do NOT overwrite; parse/validate and report status
 *   - `--force`       -> overwrite regardless of presence
 *
 * `bootstrap` performs VALIDATE-ONLY: it never writes, only reports whether
 * each required target exists and parses.
 *
 * The whole flow stays local-first and must never write outside cwd.
 */

export type TargetStatus = "created" | "exists" | "overwritten" | "invalid" | "found" | "missing";

export interface TargetReport {
  /** POSIX-relative path of the target inside the repo. */
  path: string;
  status: TargetStatus;
  /** Optional human-readable detail (e.g. "found 2", parse error). */
  detail?: string;
  /** Whether this target is required for `bootstrap --strict` to pass. */
  required: boolean;
}

export interface ScaffoldResult {
  reports: TargetReport[];
}

export interface InitOptions {
  cwd: string;
  force?: boolean;
  /** When true, do not write anything (validate-only / bootstrap). */
  validateOnly?: boolean;
}

const CONFIG_FILE = "review-surfaces.config.yaml";
const SCHEMA_FILE = path.posix.join("schemas", "review_packet.schema.json");
const IGNORE_FILE = ".review-surfacesignore";
const USAGE_SKILL_FILE = path.posix.join(".agents", "skills", "review-surfaces-usage", "SKILL.md");
const AGENTS_FILE = "AGENTS.md";
const FEATURE_GLOB = "features/**/*.feature.yaml";

/**
 * Run the create-or-validate scaffold (used by `init`).
 */
export async function runInit(options: InitOptions): Promise<ScaffoldResult> {
  const cwd = path.resolve(options.cwd);
  const force = options.force ?? false;
  const validateOnly = options.validateOnly ?? false;

  const reports: TargetReport[] = [];

  reports.push(await scaffoldTextTarget(cwd, CONFIG_FILE, force, validateOnly, true, renderConfig, validateConfig));
  reports.push(await scaffoldSchema(cwd, force, validateOnly));
  reports.push(await scaffoldTextTarget(cwd, IGNORE_FILE, force, validateOnly, true, renderIgnore, validateIgnore));
  reports.push(await scaffoldFeatureSpec(cwd, force, validateOnly));
  reports.push(await scaffoldTextTarget(cwd, USAGE_SKILL_FILE, force, validateOnly, true, renderUsageSkill, validateNonEmpty));
  reports.push(await scaffoldAgents(cwd, force, validateOnly));

  return { reports };
}

/**
 * Run the validate-only scaffold (used by `bootstrap`).
 */
export async function runBootstrap(options: Omit<InitOptions, "validateOnly" | "force">): Promise<ScaffoldResult> {
  return runInit({ cwd: options.cwd, validateOnly: true });
}

/**
 * Format the per-target report for console output. One line per target.
 */
export function formatReports(reports: TargetReport[]): string {
  return reports
    .map((report) => {
      const detail = report.detail ? ` (${report.detail})` : "";
      return `  ${report.status.padEnd(11)} ${report.path}${detail}`;
    })
    .join("\n");
}

/**
 * True when any required target is missing or invalid. Used by `bootstrap
 * --strict` to decide whether to fail the quality gate.
 */
export function hasRequiredFailure(reports: TargetReport[]): boolean {
  return reports.some((report) => report.required && (report.status === "missing" || report.status === "invalid"));
}

// ---------------------------------------------------------------------------
// Generic create-or-validate for a single text target.
// ---------------------------------------------------------------------------

type Renderer = (cwd: string) => Promise<string> | string;
type Validator = (cwd: string, absolutePath: string) => Promise<void> | void;

async function scaffoldTextTarget(
  cwd: string,
  relTarget: string,
  force: boolean,
  validateOnly: boolean,
  required: boolean,
  render: Renderer,
  validate: Validator
): Promise<TargetReport> {
  const absolutePath = resolveInside(cwd, relTarget);
  const exists = fileExists(absolutePath);

  if (validateOnly) {
    if (!exists) {
      return { path: relTarget, status: "missing", required };
    }
    const error = await tryValidate(validate, cwd, absolutePath);
    return error
      ? { path: relTarget, status: "invalid", detail: error, required }
      : { path: relTarget, status: "exists", required };
  }

  if (exists && !force) {
    const error = await tryValidate(validate, cwd, absolutePath);
    return error
      ? { path: relTarget, status: "invalid", detail: error, required }
      : { path: relTarget, status: "exists", required };
  }

  const content = await render(cwd);
  await writeText(absolutePath, content);
  // Validate what we just wrote so a regression is caught immediately.
  const error = await tryValidate(validate, cwd, absolutePath);
  if (error) {
    return { path: relTarget, status: "invalid", detail: error, required };
  }
  return { path: relTarget, status: exists ? "overwritten" : "created", required };
}

async function tryValidate(validate: Validator, cwd: string, absolutePath: string): Promise<string | undefined> {
  try {
    await validate(cwd, absolutePath);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------------------
// review-surfaces.config.yaml
// ---------------------------------------------------------------------------

function renderConfig(): string {
  const header = [
    "# review-surfaces configuration.",
    "# Generated by `review-surfaces init`. Safe to edit and commit.",
    "# An `areas:` block is optional; without it, review areas are derived",
    "# automatically from changed-file clustering.",
    "# Example:",
    "#   areas:",
    "#     - id: SUB-CORE",
    "#       name: Core",
    "#       group_key: CORE",
    "#       prefixes: [src/core/]",
    ""
  ].join("\n");
  return `${header}${stringifyYaml(defaultConfig)}`;
}

async function validateConfig(cwd: string): Promise<void> {
  // loadConfig throws when the YAML object is malformed.
  await loadConfig(cwd, CONFIG_FILE);
}

// ---------------------------------------------------------------------------
// schemas/review_packet.schema.json
// ---------------------------------------------------------------------------

async function scaffoldSchema(cwd: string, force: boolean, validateOnly: boolean): Promise<TargetReport> {
  const absolutePath = resolveInside(cwd, SCHEMA_FILE);
  const exists = fileExists(absolutePath);

  if (validateOnly) {
    if (!exists) {
      return { path: SCHEMA_FILE, status: "missing", required: true };
    }
    const error = await tryValidate(validateSchema, cwd, absolutePath);
    return error
      ? { path: SCHEMA_FILE, status: "invalid", detail: error, required: true }
      : { path: SCHEMA_FILE, status: "exists", required: true };
  }

  if (exists && !force) {
    const error = await tryValidate(validateSchema, cwd, absolutePath);
    return error
      ? { path: SCHEMA_FILE, status: "invalid", detail: error, required: true }
      : { path: SCHEMA_FILE, status: "exists", required: true };
  }

  const source = await readPackagedSchema();
  await writeText(absolutePath, source);
  const error = await tryValidate(validateSchema, cwd, absolutePath);
  if (error) {
    return { path: SCHEMA_FILE, status: "invalid", detail: error, required: true };
  }
  return { path: SCHEMA_FILE, status: exists ? "overwritten" : "created", required: true };
}

function validateSchema(_cwd: string, absolutePath: string): void {
  const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("schema is not a JSON object");
  }
  if (parsed.$id !== "https://review-surfaces.local/schemas/review_packet.schema.v1.json") {
    throw new Error("schema is not the review-surfaces review packet schema");
  }
}

/**
 * Resolve the packet schema THIS TOOL ships, so the scaffolded repo can run
 * `validate` offline. Delegates to the shared package-root resolver
 * (review-surfaces.COLD_START.1) — never the user's CWD.
 */
export function locatePackagedSchema(): string {
  const candidate = packagedSchemaPath("review_packet.schema.json");
  if (!fileExists(candidate)) {
    throw new Error(`Could not locate the packaged review packet schema at ${candidate}.`);
  }
  return candidate;
}

async function readPackagedSchema(): Promise<string> {
  return readText(locatePackagedSchema());
}

// ---------------------------------------------------------------------------
// .review-surfacesignore
// ---------------------------------------------------------------------------

function renderIgnore(): string {
  const header = [
    "# review-surfaces privacy ignore patterns.",
    "# Generated by `review-surfaces init`. These files are excluded before",
    "# collection and before any remote provider call. Add your own patterns",
    "# below; lines beginning with `!` re-include a previously ignored path.",
    ""
  ].join("\n");
  return `${header}${DEFAULT_PRIVACY_IGNORE_PATTERNS.join("\n")}\n`;
}

async function validateIgnore(_cwd: string, absolutePath: string): Promise<void> {
  const content = await readText(absolutePath);
  if (content.trim().length === 0) {
    throw new Error("ignore file is empty");
  }
}

// ---------------------------------------------------------------------------
// features/<repoDirName>.feature.yaml
// ---------------------------------------------------------------------------

async function scaffoldFeatureSpec(cwd: string, force: boolean, validateOnly: boolean): Promise<TargetReport> {
  const existing = await findFeatureSpecs(cwd);
  const repoName = repoFeatureName(cwd);
  const relTarget = path.posix.join("features", `${repoName}.feature.yaml`);

  if (existing.length > 0) {
    // At least one spec already exists; never clobber existing specs even with
    // --force (the user owns their contracts).
    //
    // Round 6: validate EVERY discovered spec, not just the first sorted match.
    // A later malformed spec would otherwise let `bootstrap --strict` exit 0 even
    // though the next `collect`/`all` run fails indexing the whole set. Report the
    // FIRST invalid spec (deterministic by sort order) so the required-failure
    // gate trips; only report "found N" when ALL specs parse.
    for (const spec of existing) {
      const error = await tryValidate(validateFeatureSpec, cwd, resolveInside(cwd, spec));
      if (error) {
        return { path: spec, status: "invalid", detail: error, required: true };
      }
    }
    return { path: existing[0], status: "found", detail: `found ${existing.length}`, required: true };
  }

  const absolutePath = resolveInside(cwd, relTarget);
  const exists = fileExists(absolutePath);

  if (validateOnly) {
    return { path: relTarget, status: "missing", required: true };
  }

  if (exists && !force) {
    const error = await tryValidate(validateFeatureSpec, cwd, absolutePath);
    return error
      ? { path: relTarget, status: "invalid", detail: error, required: true }
      : { path: relTarget, status: "exists", required: true };
  }

  await writeText(absolutePath, renderFeatureSpec(repoName));
  const error = await tryValidate(validateFeatureSpec, cwd, absolutePath);
  if (error) {
    return { path: relTarget, status: "invalid", detail: error, required: true };
  }
  return { path: relTarget, status: exists ? "overwritten" : "created", required: true };
}

async function findFeatureSpecs(cwd: string): Promise<string[]> {
  try {
    return await expandPatterns(cwd, [FEATURE_GLOB]);
  } catch {
    return [];
  }
}

function renderFeatureSpec(featureName: string): string {
  const spec = {
    feature: {
      name: featureName,
      product: featureName,
      version: VERSION,
      draft: true,
      description:
        "Starter feature spec generated by `review-surfaces init`. Replace these placeholder requirements with the real contracts for this repository."
    },
    components: {
      CORE: {
        name: "Core behavior",
        description: "The primary behavior this repository must deliver.",
        requirements: {
          1: {
            requirement: "Describe the first observable behavior this repository must guarantee.",
            note: "Preserve the Acai-style ID (e.g. <feature>.CORE.1) in tests, notes, and review packets where useful."
          }
        }
      }
    }
  };
  const header = [
    "# Starter feature spec generated by `review-surfaces init`.",
    "# This file is an Acai-compatible requirements ledger. Edit freely.",
    ""
  ].join("\n");
  return `${header}${stringifyYaml(spec)}`;
}

async function validateFeatureSpec(cwd: string, absolutePath: string): Promise<void> {
  const rel = relativePath(cwd, absolutePath);
  const indexed = await parseAcaiSpec(cwd, rel);
  if (indexed.requirements.length === 0) {
    throw new Error("feature spec yields no Acai IDs");
  }
}

// ---------------------------------------------------------------------------
// .agents/skills/review-surfaces-usage/SKILL.md
// ---------------------------------------------------------------------------

function renderUsageSkill(): string {
  return `---
name: review-surfaces-usage
description: Use when running review-surfaces in any local repository to collect inputs, capture command transcripts, compile review packets, validate evidence, and record feedback without hosted services.
---

# review-surfaces usage

Covers \`review-surfaces.BOOTSTRAP.6\`.

Use this skill when applying \`review-surfaces\` to a repository, including repositories other than \`review-surfaces\`.

## Workflow

1. Identify the review range, usually \`--base origin/main --head HEAD\`.
2. Identify source contracts: \`features/**/*.feature.yaml\`, docs, tickets, AGENTS files, and local skills.
3. Capture important checks with \`review-surfaces run -- <command>\` so test claims have bounded command transcript evidence.
4. Run \`review-surfaces all --out .review-surfaces\` with \`--dogfood\` only when reviewing the \`review-surfaces\` repository itself.
5. Run \`review-surfaces validate .review-surfaces\` before treating the packet as evidence.
6. Inspect \`.review-surfaces/review_packet.md\`, \`.review-surfaces/evaluation.yaml\`, \`.review-surfaces/risks.yaml\`, and \`.review-surfaces/agent_handoff.md\`.
7. Convert packet findings into code changes, tests, spec updates, feedback files, or explicit deferrals.

## Evidence Rules

- Treat \`.review-surfaces/\` as the primary product surface.
- Do not use hosted comments, dashboards, CI, or provider calls as prerequisites for local packet generation.
- Do not claim a command passed unless a transcript or inspected output exists.
- Treat missing logs, missing tests, and missing implementation as missing evidence rather than prose to fill in.
- Keep packet output compact enough for a human reviewer to use.
`;
}

async function validateNonEmpty(_cwd: string, absolutePath: string): Promise<void> {
  const content = await readText(absolutePath);
  if (content.trim().length === 0) {
    throw new Error("file is empty");
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md
// ---------------------------------------------------------------------------

async function scaffoldAgents(cwd: string, force: boolean, validateOnly: boolean): Promise<TargetReport> {
  const absolutePath = resolveInside(cwd, AGENTS_FILE);
  const exists = fileExists(absolutePath);

  // FINDING A: AGENTS.md is part of the scaffold BOOTSTRAP.2/5 + the README
  // promise, so it is REQUIRED for `bootstrap --strict` (a missing/empty
  // AGENTS.md must trip the quality gate, not be silently ignored). The
  // no-overwrite behavior below is preserved independently of this flag: init
  // still never clobbers an existing AGENTS.md, even with --force.
  if (validateOnly) {
    if (!exists) {
      return { path: AGENTS_FILE, status: "missing", required: true };
    }
    const error = await tryValidate(validateNonEmpty, cwd, absolutePath);
    return error
      ? { path: AGENTS_FILE, status: "invalid", detail: error, required: true }
      : { path: AGENTS_FILE, status: "exists", required: true };
  }

  // AGENTS.md is user-owned context. If it already exists, never mutate it,
  // even with --force, so we do not stomp an existing contributor workflow.
  //
  // Round 8 (FINDING A): even though init never overwrites an existing AGENTS.md,
  // it MUST still validate it like every other scaffold target (and like
  // bootstrap's validate-only branch above). Previously init reported a bare
  // "exists" without running validateNonEmpty, so an empty/blank AGENTS.md left
  // `init` reporting success even though the file is invalid and would later trip
  // `bootstrap --strict`. Validate the existing file and report "invalid" when it
  // is empty (preserving the no-clobber guarantee: we never write over it).
  if (exists) {
    const error = await tryValidate(validateNonEmpty, cwd, absolutePath);
    return error
      ? { path: AGENTS_FILE, status: "invalid", detail: error, required: true }
      : { path: AGENTS_FILE, status: "exists", required: true };
  }

  await writeText(absolutePath, renderAgents(repoFeatureName(cwd)));
  return { path: AGENTS_FILE, status: "created", required: true };
}

function renderAgents(featureName: string): string {
  return `# AGENTS.md — ${featureName}

This repository is reviewed with \`review-surfaces\`, a local-first human review decision cockpit.

## Source of truth

1. Treat \`features/**/*.feature.yaml\` as the authoritative requirements ledger. Preserve Acai-style IDs such as \`${featureName}.CORE.1\` in implementation notes, tests, and review packets where useful.
2. Treat \`schemas/review_packet.schema.json\` as the machine-readable packet contract.
3. Treat \`.review-surfaces/\` artifacts as the primary review surface; hosted comments and CI are later renderers.

## Local workflow

1. Install and build the tool, then run the offline pipeline:

\`\`\`bash
review-surfaces all --base origin/main --head HEAD --provider mock --out .review-surfaces
review-surfaces validate .review-surfaces
\`\`\`

2. Capture important checks so test claims have evidence:

\`\`\`bash
review-surfaces run -- <command>
\`\`\`

3. Inspect \`.review-surfaces/review_packet.md\`, \`.review-surfaces/evaluation.yaml\`, \`.review-surfaces/risks.yaml\`, and \`.review-surfaces/agent_handoff.md\`.

## Review discipline

- Do not claim tests passed unless a command was run or output inspected.
- Do not invent file paths, line numbers, commands, ACIDs, or test names.
- Mark missing evidence as unknown rather than filling gaps with plausible prose.
- Keep generated review artifacts compact enough for a human reviewer to use.
`;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a target path inside cwd and guard against path escapes. Returns the
 * absolute path. Throws if the resolved path would land outside cwd.
 */
function resolveInside(cwd: string, relTarget: string): string {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, relTarget);
  const rel = path.relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside the target repo: ${relTarget}`);
  }
  return absolute;
}

function repoDirName(cwd: string): string {
  return path.basename(path.resolve(cwd)) || "repo";
}

/**
 * Derive a safe Acai feature name from the repo directory name. Acai IDs are
 * matched as ^[a-z0-9_-]+\.[A-Z0-9_]+\.[0-9]+$, so the feature segment must be
 * lowercase alphanumerics, hyphens, or underscores.
 */
function repoFeatureName(cwd: string): string {
  const base = repoDirName(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "repo";
}
