// review-surfaces.POLICY.1/.2: the committed, schema-validated team review
// policy (review-surfaces.policy.yaml). The team — not one laptop — owns
// false-positive tuning: suppression rules (each requiring a reason and an
// absolute expiry), severity overrides, and required manual checks per path
// glob, all merged via PR. Precedence: committed policy > local feedback files
// > defaults; the local walkthrough feedback memory COMPOSES with it.
//
// Suppressions DEMOTE (downgrade + annotate), never delete — the same
// non-destructive stance the feedback engine takes — and match on stable
// finding keys (rule id + path glob), never free text. An EXPIRED suppression
// is not silently dropped: it renders as its own finding, which is how the
// policy file stays maintained. Scope bound (documented): suppressions demote
// REVIEW-QUEUE items; lens findings and suggested comments keep their evidence
// visible so a suppression can never hide deterministic signals entirely.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { globToRegExp } from "../core/glob";
import { validateJsonSchema } from "../schema/json-schema";
import type { HumanReviewPriority, HumanReviewRequiredManualCheckConfig } from "../human/contract";

export const POLICY_FILE = "review-surfaces.policy.yaml";
export const POLICY_SCHEMA_PATH = "schemas/review_policy.schema.json";

export interface PolicySuppression {
  id?: string;
  rule: string;
  path_glob: string;
  reason: string;
  expires: string;
}

export interface PolicySeverityOverride {
  rule: string;
  path_glob?: string;
  priority: HumanReviewPriority;
}

export interface ReviewPolicy {
  schema_version: "review-surfaces.policy.v1";
  suppressions?: PolicySuppression[];
  severity_overrides?: PolicySeverityOverride[];
  required_manual_checks?: HumanReviewRequiredManualCheckConfig[];
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

// Load and schema-validate the committed policy. Absent file -> undefined (no
// policy). A malformed or schema-invalid file FAILS LOUDLY (POLICY.1) — a
// silently-ignored policy would un-own the team's tuning without anyone
// noticing.
export function loadReviewPolicy(cwd: string, policyFile = POLICY_FILE): ReviewPolicy | undefined {
  const policyPath = path.resolve(cwd, policyFile);
  let text: string;
  try {
    text = fs.readFileSync(policyPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new PolicyValidationError(`${policyFile} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const schema = JSON.parse(fs.readFileSync(path.resolve(cwd, POLICY_SCHEMA_PATH), "utf8"));
  const result = validateJsonSchema(schema, parsed);
  if (!result.valid) {
    throw new PolicyValidationError(
      `${policyFile} failed schema validation: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`
    );
  }
  return parsed as ReviewPolicy;
}

export interface PolicySuppressionMatch {
  suppression: PolicySuppression;
  expired: boolean;
}

// Match a finding's STABLE key (risk rule id + path) against the policy.
// `now` is the deterministic clock (the run's manifest timestamp), never
// Date.now(), so identical inputs produce identical expiry decisions.
const globCache = new Map<string, RegExp>();

function compiledGlob(pattern: string): RegExp {
  let regex = globCache.get(pattern);
  if (!regex) {
    regex = globToRegExp(pattern);
    globCache.set(pattern, regex);
  }
  return regex;
}

export function matchPolicySuppression(
  policy: ReviewPolicy | undefined,
  rule: string,
  filePath: string,
  nowIso: string
): PolicySuppressionMatch | undefined {
  for (const suppression of policy?.suppressions ?? []) {
    if (suppression.rule !== rule) {
      continue;
    }
    if (!compiledGlob(suppression.path_glob).test(filePath)) {
      continue;
    }
    const expired = Date.parse(suppression.expires) < Date.parse(nowIso);
    return { suppression, expired };
  }
  return undefined;
}

export function matchPolicySeverityOverride(
  policy: ReviewPolicy | undefined,
  rule: string,
  filePath: string
): PolicySeverityOverride | undefined {
  for (const override of policy?.severity_overrides ?? []) {
    if (override.rule !== rule) {
      continue;
    }
    if (override.path_glob && !compiledGlob(override.path_glob).test(filePath)) {
      continue;
    }
    return override;
  }
  return undefined;
}

// Expired suppressions surface as their own findings (POLICY.2) so the policy
// file stays maintained instead of rotting.
export function expiredPolicySuppressions(policy: ReviewPolicy | undefined, nowIso: string): PolicySuppression[] {
  return (policy?.suppressions ?? []).filter((suppression) => Date.parse(suppression.expires) < Date.parse(nowIso));
}
