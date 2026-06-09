import path from "node:path";
import { compareStrings } from "../core/compare";
import { readText } from "../core/files";
import { isRecord } from "../core/guards";
import { parseYaml } from "../core/simple-yaml";
import { EvidenceRef, feedbackEvidence } from "../evidence/evidence";
import {
  PACKET_DOGFOOD_CATEGORIES,
  PACKET_DOGFOOD_SEVERITIES,
  type PacketDogfoodCategory,
  type PacketSeverity
} from "../schema/review-packet-contract";

export type FeedbackCategory = PacketDogfoodCategory;

export type FeedbackSeverity = PacketSeverity;

export interface FeedbackFinding {
  id: string;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  affected_section?: string;
  finding: string;
  desired_change?: string;
  evidence: EvidenceRef[];
}

export interface FeedbackValidation {
  passed: string[];
  failed: string[];
  notes: string[];
}

export interface FeedbackFalsePositive {
  rule?: string;
  path_pattern?: string;
  condition?: string;
  action: string;
  evidence: EvidenceRef[];
}

export interface FeedbackFalseNegative {
  description: string;
  path_pattern?: string;
  desired_rule?: string;
  evidence: EvidenceRef[];
}

export interface FeedbackTeamPolicy {
  id: string;
  path_pattern?: string;
  required_manual_check?: string;
  evidence: EvidenceRef[];
}

export interface FeedbackReviewerPreference {
  key: string;
  value: unknown;
  evidence: EvidenceRef[];
}

export interface FeedbackFile {
  path: string;
  schema_version: string;
  author: string;
  created_at?: string;
  head_sha?: string;
  packet_path?: string;
  findings: FeedbackFinding[];
  validation: FeedbackValidation;
  false_positives: FeedbackFalsePositive[];
  false_negatives: FeedbackFalseNegative[];
  team_policy: FeedbackTeamPolicy[];
  reviewer_preferences: FeedbackReviewerPreference[];
}

const CATEGORIES = new Set<FeedbackCategory>(PACKET_DOGFOOD_CATEGORIES);
const SEVERITIES = new Set<FeedbackSeverity>(PACKET_DOGFOOD_SEVERITIES);

export async function indexFeedbackFiles(cwd: string, feedbackPaths: string[]): Promise<FeedbackFile[]> {
  const feedback: FeedbackFile[] = [];
  for (const feedbackPath of feedbackPaths.sort()) {
    feedback.push(await readFeedbackFile(cwd, feedbackPath));
  }
  return feedback;
}

async function readFeedbackFile(cwd: string, feedbackPath: string): Promise<FeedbackFile> {
  const parsed = parseYaml(await readText(path.resolve(cwd, feedbackPath)));
  return normalizeFeedbackRecord(feedbackPath, parsed);
}

export function normalizeFeedbackRecord(defaultFeedbackPath: string, value: unknown): FeedbackFile {
  const record = isRecord(value) ? value : {};
  const feedbackPath = optionalString(record.path) ?? defaultFeedbackPath;
  const findings = asArray(record.findings).map((finding, index) => normalizeFinding(feedbackPath, finding, index));
  const validationRecord = isRecord(record.validation) ? record.validation : {};

  return {
    path: feedbackPath,
    schema_version: stringValue(record.schema_version, "unknown"),
    author: stringValue(record.author, stringValue(record.reviewer, "unknown")),
    created_at: optionalString(record.created_at),
    head_sha: optionalString(record.head_sha),
    packet_path: optionalString(record.packet_path),
    findings,
    validation: {
      passed: stringArray(validationRecord.passed),
      failed: stringArray(validationRecord.failed),
      notes: stringArray(validationRecord.notes)
    },
    false_positives: asArray(record.false_positives).map((item, index) => normalizeFalsePositive(feedbackPath, item, index)),
    false_negatives: asArray(record.false_negatives).map((item, index) => normalizeFalseNegative(feedbackPath, item, index)),
    team_policy: asArray(record.team_policy).map((item, index) => normalizeTeamPolicy(feedbackPath, item, index)),
    reviewer_preferences: normalizeReviewerPreferences(feedbackPath, record.reviewer_preferences)
  };
}

function normalizeFinding(feedbackPath: string, value: unknown, index: number): FeedbackFinding {
  const record = isRecord(value) ? value : {};
  const category = enumValue(record.category, CATEGORIES, "unknown");
  const severity = enumValue(record.severity, SEVERITIES, "unknown");
  const id = stringValue(record.id, `FB-${String(index + 1).padStart(3, "0")}`);

  return {
    id,
    category,
    severity,
    affected_section: optionalString(record.affected_section),
    finding: stringValue(record.finding, "Feedback finding did not include text."),
    desired_change: optionalString(record.desired_change),
    evidence: [feedbackEvidence(feedbackPath, `Feedback finding ${id}.`, { eventId: id })]
  };
}

function normalizeFalsePositive(feedbackPath: string, value: unknown, index: number): FeedbackFalsePositive {
  const record = isRecord(value) ? value : {};
  const id = `false_positive:${index + 1}`;
  return {
    rule: optionalString(record.rule),
    path_pattern: optionalString(record.path_pattern),
    condition: optionalString(record.condition),
    action: stringValue(record.action, "downgrade_to_low"),
    evidence: [feedbackEvidence(feedbackPath, `Feedback false-positive policy ${id}.`, { eventId: id })]
  };
}

function normalizeFalseNegative(feedbackPath: string, value: unknown, index: number): FeedbackFalseNegative {
  const record = isRecord(value) ? value : {};
  const id = `false_negative:${index + 1}`;
  return {
    description: stringValue(record.description, "Feedback false-negative policy did not include a description."),
    path_pattern: optionalString(record.path_pattern),
    desired_rule: optionalString(record.desired_rule),
    evidence: [feedbackEvidence(feedbackPath, `Feedback false-negative policy ${id}.`, { eventId: id })]
  };
}

function normalizeTeamPolicy(feedbackPath: string, value: unknown, index: number): FeedbackTeamPolicy {
  const record = isRecord(value) ? value : {};
  const trigger = isRecord(record.trigger) ? record.trigger : {};
  const id = stringValue(record.id, `POLICY-${String(index + 1).padStart(3, "0")}`);
  return {
    id,
    path_pattern: optionalString(trigger.path_pattern) ?? optionalString(record.path_pattern),
    required_manual_check: optionalString(record.required_manual_check),
    evidence: [feedbackEvidence(feedbackPath, `Feedback team policy ${id}.`, { eventId: id })]
  };
}

function normalizeReviewerPreferences(feedbackPath: string, value: unknown): FeedbackReviewerPreference[] {
  const preferences: FeedbackReviewerPreference[] = [];
  const pushPreference = (key: string, preferenceValue: unknown, index: number): void => {
    preferences.push({
      key,
      value: preferenceValue,
      evidence: [feedbackEvidence(feedbackPath, `Feedback reviewer preference ${key}.`, { eventId: `reviewer_preference:${index + 1}` })]
    });
  };

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (!isRecord(item)) {
        continue;
      }
      if (typeof item.key === "string" && Object.hasOwn(item, "value")) {
        pushPreference(item.key, item.value, preferences.length);
        continue;
      }
      for (const [key, preferenceValue] of Object.entries(item).sort(([left], [right]) => compareStrings(left, right))) {
        pushPreference(key, preferenceValue, preferences.length);
      }
    }
    return preferences;
  }

  if (isRecord(value)) {
    for (const [key, preferenceValue] of Object.entries(value).sort(([left], [right]) => compareStrings(left, right))) {
      pushPreference(key, preferenceValue, preferences.length);
    }
  }

  return preferences;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? (value as T) : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
