import path from "node:path";
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

export interface FeedbackFile {
  path: string;
  schema_version: string;
  author: string;
  created_at?: string;
  packet_path?: string;
  findings: FeedbackFinding[];
  validation: FeedbackValidation;
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
  const record = isRecord(parsed) ? parsed : {};
  const findings = asArray(record.findings).map((finding, index) => normalizeFinding(feedbackPath, finding, index));
  const validationRecord = isRecord(record.validation) ? record.validation : {};

  return {
    path: feedbackPath,
    schema_version: stringValue(record.schema_version, "unknown"),
    author: stringValue(record.author, "unknown"),
    created_at: optionalString(record.created_at),
    packet_path: optionalString(record.packet_path),
    findings,
    validation: {
      passed: stringArray(validationRecord.passed),
      failed: stringArray(validationRecord.failed),
      notes: stringArray(validationRecord.notes)
    }
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
