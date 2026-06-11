import crypto from "node:crypto";
import { redactSecrets } from "../privacy/secrets";
import { TEXT_ACID_TOKEN, TEXT_PATH_TOKEN, TEXT_ROOT_FILE_TOKEN } from "../core/anchor-tokens";
import { compareStrings } from "../core/compare";
import { isRecord } from "../core/guards";
import { ProviderName, ReasoningProvider } from "./provider";
import {
  AnchoredNarrativeItem,
  AnchoredRiskNarrative,
  PrChangeDiagramModel,
  PrNarrativeLlmMeta,
  PrNarrativeModel,
  PrRiskModel,
  PrScopeModel,
  PrScopedCoverageModel,
  PrSurfaceBlockedReason,
  StructuredDiff
} from "../pr/contract";

// ---------------------------------------------------------------------------
// PR narrative stage. The LLM (google/Gemini by default) authors ONLY the
// review prose — summary, what-changed, why-it-matters, review-first, and per-
// risk narratives. It may cite ONLY deterministic allowlists (changed paths,
// affected requirement IDs, PR risk IDs); any item with an off-allowlist anchor
// or no anchor is DROPPED (never "repaired"). Deterministic facts remain the
// authority; the LLM never sets statuses, evidence, or IDs.
// ---------------------------------------------------------------------------

const MAX_DIFF_EXCERPT_CHARS = 6000;
const MAX_CHANGED_FILES = 40;
const MAX_REQUIREMENTS = 20;
const MAX_RISKS = 12;
const MAX_ANCHORED_ITEMS = 6;
const MAX_WHAT_CHANGED_ITEMS = 3;
const MAX_WHY_IT_MATTERS_ITEMS = 3;
const MAX_REVIEW_FIRST_ITEMS = 5;
const MAX_RISK_NARRATIVE_ITEMS = 8;
const MAX_NARRATIVE_TEXT_CHARS = 1000;
const MAX_SUGGESTED_CHECK_CHARS = 500;

export interface BuildPrNarrativeInput {
  // review-surfaces.COLD_START.5: spec-less narratives never count requirements.
  specMode: "acai" | "none";
  provider: ReasoningProvider;
  providerName: ProviderName;
  model?: string;
  repo: string;
  scope: PrScopeModel;
  coverage: PrScopedCoverageModel;
  risks: PrRiskModel;
  diagram?: PrChangeDiagramModel;
  diff: StructuredDiff;
  redactSecrets: boolean;
  remotePrivacyBlocked: boolean;
}

export interface PrNarrativeResult {
  narrative?: PrNarrativeModel;
  meta: PrNarrativeLlmMeta;
  blocked_reason?: PrSurfaceBlockedReason;
}

const anchoredItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string", maxLength: MAX_NARRATIVE_TEXT_CHARS },
    paths: { type: "array", maxItems: 6, items: { type: "string" } },
    requirement_ids: { type: "array", maxItems: 6, items: { type: "string" } },
    risk_ids: { type: "array", maxItems: 6, items: { type: "string" } }
  }
} as const;

export const PR_NARRATIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "what_changed", "why_it_matters", "review_first", "risk_narratives"],
  properties: {
    summary: { type: "string", maxLength: MAX_NARRATIVE_TEXT_CHARS },
    what_changed: { type: "array", maxItems: MAX_WHAT_CHANGED_ITEMS, items: anchoredItemSchema },
    why_it_matters: { type: "array", maxItems: MAX_WHY_IT_MATTERS_ITEMS, items: anchoredItemSchema },
    review_first: { type: "array", maxItems: MAX_REVIEW_FIRST_ITEMS, items: anchoredItemSchema },
    risk_narratives: {
      type: "array",
      maxItems: MAX_RISK_NARRATIVE_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["risk_id", "text"],
        properties: {
          risk_id: { type: "string" },
          text: { type: "string", maxLength: MAX_NARRATIVE_TEXT_CHARS },
          suggested_checks: { type: "array", maxItems: 4, items: { type: "string", maxLength: MAX_SUGGESTED_CHECK_CHARS } }
        }
      }
    }
  }
} as const;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function redact(value: string): string {
  return redactSecrets(value).text;
}

// Bounded, redacted facts the model is allowed to see + the anchor allowlists.
function buildPromptFacts(input: BuildPrNarrativeInput): {
  facts: Record<string, unknown>;
  allowedPaths: Set<string>;
  allowedRequirementIds: Set<string>;
  allowedRiskIds: Set<string>;
} {
  const allowedPaths = new Set(input.scope.changed_files.map((file) => file.path));
  const allowedRequirementIds = new Set<string>();
  for (const requirement of input.scope.affected_requirements) {
    allowedRequirementIds.add(requirement.requirement_id);
    if (requirement.acai_id) {
      allowedRequirementIds.add(requirement.acai_id);
    }
  }
  const allowedRiskIds = new Set(input.risks.candidates.map((candidate) => candidate.id));

  const diffExcerpt = buildDiffExcerpt(input.diff, MAX_DIFF_EXCERPT_CHARS);
  const promptPaths = input.scope.changed_files.map((file) => file.path).slice(0, MAX_CHANGED_FILES);
  const promptRequirementIds = [...allowedRequirementIds].sort(compareStrings).slice(0, MAX_REQUIREMENTS * 2);
  const promptRiskIds = [...allowedRiskIds].sort(compareStrings).slice(0, MAX_RISKS);

  const facts = {
    repo: input.repo,
    // review-surfaces.COLD_START.5: tell the provider the repo has no
    // requirement spec so its prose does not speak in requirement counts.
    spec_mode: input.specMode,
    base_ref: input.scope.base_ref,
    head_ref: input.scope.head_ref,
    diff_source: input.scope.diff_source,
    changed_files: input.scope.changed_files.slice(0, MAX_CHANGED_FILES).map((file) => ({
      path: file.path,
      status: file.status,
      role: file.role,
      areas: file.areas
    })),
    diff_excerpt: diffExcerpt.text,
    diff_excerpt_omitted_line_count: diffExcerpt.omittedLines,
    affected_areas: input.scope.affected_areas.slice(0, MAX_CHANGED_FILES).map((area) => ({
      group_key: area.group_key,
      area_ids: area.area_ids,
      name: area.name,
      changed_files: area.changed_files.slice(0, MAX_CHANGED_FILES)
    })),
    affected_areas_omitted_count: Math.max(input.scope.affected_areas.length - MAX_CHANGED_FILES, 0),
    affected_requirements: input.scope.affected_requirements.slice(0, MAX_REQUIREMENTS).map((requirement) => ({
      requirement_id: requirement.requirement_id,
      acai_id: requirement.acai_id,
      title: requirement.title,
      reasons: requirement.reasons.map((reason) => reason.rule)
    })),
    coverage_deltas: input.coverage.deltas.slice(0, MAX_REQUIREMENTS).map((delta) => ({
      requirement_id: delta.acai_id ?? delta.requirement_id,
      base_status: delta.base_status,
      head_status: delta.head_status,
      delta: delta.delta
    })),
    risk_candidates: input.risks.candidates.slice(0, MAX_RISKS).map((candidate) => ({
      id: candidate.id,
      rule: candidate.rule,
      category: candidate.category,
      severity: candidate.severity,
      summary: candidate.summary
    })),
    allowed_paths: promptPaths,
    allowed_paths_omitted_count: Math.max(allowedPaths.size - promptPaths.length, 0),
    allowed_requirement_ids: promptRequirementIds,
    allowed_requirement_ids_omitted_count: Math.max(allowedRequirementIds.size - promptRequirementIds.length, 0),
    allowed_risk_ids: promptRiskIds,
    allowed_risk_ids_omitted_count: Math.max(allowedRiskIds.size - promptRiskIds.length, 0)
  };

  return { facts, allowedPaths, allowedRequirementIds, allowedRiskIds };
}

function buildDiffExcerpt(diff: StructuredDiff, maxChars: number): { text: string; omittedLines: number } {
  const lines: string[] = [];
  let length = 0;
  let omittedLines = 0;
  const append = (line: string): void => {
    const extra = (lines.length === 0 ? 0 : 1) + line.length;
    if (length + extra > maxChars) {
      omittedLines += 1;
      return;
    }
    lines.push(line);
    length += extra;
  };
  for (const file of diff.files) {
    append(`# ${file.status} ${file.path}`);
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") {
          append(`+ ${line.text}`);
        } else if (line.kind === "delete") {
          append(`- ${line.text}`);
        }
      }
    }
  }
  return { text: redact(lines.join("\n")), omittedLines };
}

function buildPrompt(facts: Record<string, unknown>): string {
  return [
    "Write a compact PR review surface for the changes below. Explain WHAT changed,",
    "WHY it matters, and WHERE a reviewer should look first, plus a one-line narrative",
    "for each provided risk.",
    "",
    "STRICT RULES:",
    "- Use ONLY the allowed_paths, allowed_requirement_ids, and allowed_risk_ids below as anchors.",
    "- Every what_changed / why_it_matters / review_first item MUST cite at least one allowed",
    "  path, requirement id, or risk id. If the facts do not support a claim, OMIT it.",
    "- Do not invent file paths, requirement ids, risk ids, test names, or statuses.",
    "- Each risk_narratives entry must reference an allowed_risk_id.",
    "- Be concise and specific to THIS diff. Return JSON only matching the schema.",
    "",
    "FACTS:",
    JSON.stringify(facts, null, 2)
  ].join("\n");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function boundedRedactedText(value: string, maxChars: number): string | undefined {
  const redacted = redact(value);
  if (redacted.length === 0 || redacted.length > maxChars) {
    return undefined;
  }
  return redacted;
}

// An anchor field "violates" the allowlist if it is present but malformed (not an
// array, or contains a non-string element) OR contains a string not on the
// allowlist. A non-string element must count as a violation so an item that
// smuggles a fabricated non-string anchor is DROPPED, not silently repaired by
// asStringArray quietly discarding the non-string before the allowlist check.
function anchorViolatesAllowlist(value: unknown, allowed: Set<string>): boolean {
  if (value === undefined) {
    return false; // an omitted anchor field is fine (the item may cite other anchors)
  }
  if (!Array.isArray(value)) {
    return true;
  }
  return value.some((item) => typeof item !== "string" || !allowed.has(item));
}

// Keep an item only when every anchor it cites is on an allowlist AND it cites at
// least one. Drop (never repair) anything that fabricates an anchor.
function validateItems(
  value: unknown,
  allowedPaths: Set<string>,
  allowedReqs: Set<string>,
  allowedRisks: Set<string>,
  maxItems = MAX_ANCHORED_ITEMS
): AnchoredNarrativeItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: AnchoredNarrativeItem[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.text !== "string") {
      continue;
    }
    const paths = asStringArray(raw.paths).filter((path) => allowedPaths.has(path));
    const requirementIds = asStringArray(raw.requirement_ids).filter((id) => allowedReqs.has(id));
    const riskIds = asStringArray(raw.risk_ids).filter((id) => allowedRisks.has(id));
    const offAllowlist =
      anchorViolatesAllowlist(raw.paths, allowedPaths) ||
      anchorViolatesAllowlist(raw.requirement_ids, allowedReqs) ||
      anchorViolatesAllowlist(raw.risk_ids, allowedRisks);
    if (offAllowlist) {
      continue; // any fabricated anchor drops the whole item
    }
    if (!textCitesOnlyAllowed(raw.text, allowedPaths, allowedReqs)) {
      continue; // the prose itself names a fabricated path/ACID — drop the item
    }
    if (paths.length + requirementIds.length + riskIds.length === 0) {
      continue; // must cite at least one real anchor
    }
    const text = boundedRedactedText(raw.text, MAX_NARRATIVE_TEXT_CHARS);
    if (text === undefined) {
      continue;
    }
    const item: AnchoredNarrativeItem = { text };
    if (paths.length > 0) {
      item.paths = paths;
    }
    if (requirementIds.length > 0) {
      item.requirement_ids = requirementIds;
    }
    if (riskIds.length > 0) {
      item.risk_ids = riskIds;
    }
    items.push(item);
  }
  return items.slice(0, maxItems);
}

// Every free-text field (summary, item text, risk narrative text) gets the same
// anchored-or-dropped discipline as the structured anchors: scan the prose for
// path-like and ACID-like tokens and, if it names any that is NOT on an allowlist,
// treat it as having fabricated a reference. A clean text passes; a polluted one is
// replaced (summary) or its whole item/narrative is dropped. Risk ids (PR-RISK-NNN)
// match neither pattern, so a risk narrative may still name its own risk id freely.
function textCitesOnlyAllowed(text: string, allowedPaths: Set<string>, allowedReqs: Set<string>): boolean {
  for (const match of text.matchAll(TEXT_PATH_TOKEN)) {
    if (!allowedPaths.has(match[0])) {
      return false;
    }
  }
  for (const match of text.matchAll(TEXT_ROOT_FILE_TOKEN)) {
    if (!allowedPaths.has(match[0])) {
      return false;
    }
  }
  for (const match of text.matchAll(TEXT_ACID_TOKEN)) {
    if (!allowedReqs.has(match[0])) {
      return false;
    }
  }
  return true;
}

function deterministicSummary(scope: PrScopeModel, specMode: "acai" | "none"): string {
  return specMode === "none"
    ? `${scope.changed_files.length} changed file(s) across ${scope.affected_areas.length} review area(s).`
    : `${scope.changed_files.length} changed file(s) across ${scope.affected_areas.length} review area(s); ${scope.affected_requirements.length} affected requirement(s).`;
}

function validateRiskNarratives(
  value: unknown,
  allowedRisks: Set<string>,
  allowedPaths: Set<string>,
  allowedReqs: Set<string>,
  maxItems = MAX_ANCHORED_ITEMS
): AnchoredRiskNarrative[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: AnchoredRiskNarrative[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.risk_id !== "string" || typeof raw.text !== "string") {
      continue;
    }
    if (!allowedRisks.has(raw.risk_id)) {
      continue;
    }
    // The risk narrative free text gets the same anchored-or-dropped scan as the
    // summary/items: a valid risk_id does not license fabricated paths/ACIDs in the
    // prose. Suggested_checks are scanned too; a polluted one drops the narrative.
    if (!textCitesOnlyAllowed(raw.text, allowedPaths, allowedReqs)) {
      continue;
    }
    const checkCandidates = asStringArray(raw.suggested_checks).map(redact);
    const checks = checkCandidates.filter((check) => check.length > 0 && check.length <= MAX_SUGGESTED_CHECK_CHARS);
    if (checks.some((check) => !textCitesOnlyAllowed(check, allowedPaths, allowedReqs))) {
      continue;
    }
    const text = boundedRedactedText(raw.text, MAX_NARRATIVE_TEXT_CHARS);
    if (text === undefined) {
      continue;
    }
    const item: AnchoredRiskNarrative = { risk_id: raw.risk_id, text };
    if (checks.length > 0) {
      item.suggested_checks = checks.slice(0, 4);
    }
    items.push(item);
  }
  return items.slice(0, maxItems);
}

/**
 * Run the PR narrative stage. Returns the validated narrative + LLM meta, or a
 * blocked result (no narrative) when the provider is unavailable, privacy-blocked,
 * or returns nothing that survives allowlist validation. The caller decides what
 * to do with a blocked surface (skip posting / write a blocked artifact).
 */
export async function buildPrNarrative(input: BuildPrNarrativeInput): Promise<PrNarrativeResult> {
  const { facts, allowedPaths, allowedRequirementIds, allowedRiskIds } = buildPromptFacts(input);
  const prompt = buildPrompt(facts);
  const promptHash = sha256(JSON.stringify(facts));

  const baseMeta: PrNarrativeLlmMeta = {
    required: true,
    provider: input.providerName,
    model: input.model,
    status: "blocked",
    prompt_hash: promptHash
  };

  const result = await input.provider.generateStructured("pr_narrative", prompt, PR_NARRATIVE_SCHEMA, {
    redactSecrets: input.redactSecrets,
    remotePrivacyBlocked: input.remotePrivacyBlocked
  });

  if (!result.ok) {
    const reason = result.reason;
    // Distinguish a runtime call failure (key was present, the request errored:
    // timeout/network/invalid-model) from a missing provider/credential. Both are
    // blocked, but the renderer must not tell a reviewer to "configure a key" when
    // the key was already configured and the call simply failed.
    const isRuntimeFailure = reason.startsWith("ai_sdk_error");
    const blockedReason: PrSurfaceBlockedReason = reason === "privacy_block" ? "privacy_block" : isRuntimeFailure ? "llm_failed" : "llm_unavailable";
    return {
      meta: { ...baseMeta, status: isRuntimeFailure ? "failed" : "blocked", validation_errors: [reason] },
      blocked_reason: blockedReason
    };
  }

  const data = result.data;
  if (!isRecord(data)) {
    return { meta: { ...baseMeta, status: "failed", validation_errors: ["non_object_output"] }, blocked_reason: "invalid_llm_output" };
  }

  const whatChanged = validateItems(data.what_changed, allowedPaths, allowedRequirementIds, allowedRiskIds, MAX_WHAT_CHANGED_ITEMS);
  const whyItMatters = validateItems(data.why_it_matters, allowedPaths, allowedRequirementIds, allowedRiskIds, MAX_WHY_IT_MATTERS_ITEMS);
  const reviewFirst = validateItems(data.review_first, allowedPaths, allowedRequirementIds, allowedRiskIds, MAX_REVIEW_FIRST_ITEMS);
  const riskNarratives = validateRiskNarratives(data.risk_narratives, allowedRiskIds, allowedPaths, allowedRequirementIds, MAX_RISK_NARRATIVE_ITEMS);

  // Require the three core PR reviewer questions to survive validation. A risk
  // narrative alone is not enough for a PR review surface.
  if (whatChanged.length === 0 || whyItMatters.length === 0 || reviewFirst.length === 0) {
    return {
      meta: { ...baseMeta, status: "failed", validation_errors: ["missing_valid_core_narrative"] },
      blocked_reason: "invalid_llm_output"
    };
  }

  // NOTE: no diagram_caption. It was un-anchored LLM free text (the only narrative
  // field that bypassed allowlist validation) and no renderer ever read it, so it
  // only ever risked shipping off-allowlist LLM prose into the persisted artifact.
  const rawSummary = typeof data.summary === "string" ? data.summary : "";
  const boundedSummary =
    rawSummary !== "" && textCitesOnlyAllowed(rawSummary, allowedPaths, allowedRequirementIds)
      ? boundedRedactedText(rawSummary, MAX_NARRATIVE_TEXT_CHARS)
      : undefined;
  // review-surfaces.COLD_START.5: in spec-less mode a provider summary that
  // talks in requirement counts is replaced by the deterministic no-requirement
  // summary rather than rendered verbatim at the top of the PR comment.
  const summary =
    boundedSummary !== undefined && !(input.specMode === "none" && /requirement/i.test(boundedSummary))
      ? boundedSummary
      : deterministicSummary(input.scope, input.specMode);
  const narrative: PrNarrativeModel = {
    summary,
    what_changed: whatChanged,
    why_it_matters: whyItMatters,
    review_first: reviewFirst,
    risk_narratives: riskNarratives
  };

  return {
    narrative,
    meta: { ...baseMeta, status: "applied", output_hash: sha256(JSON.stringify(narrative)) }
  };
}
