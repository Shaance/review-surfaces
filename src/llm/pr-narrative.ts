import crypto from "node:crypto";
import { redactSecrets } from "../privacy/secrets";
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

export interface BuildPrNarrativeInput {
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
    text: { type: "string" },
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
    summary: { type: "string" },
    what_changed: { type: "array", maxItems: MAX_ANCHORED_ITEMS, items: anchoredItemSchema },
    why_it_matters: { type: "array", maxItems: MAX_ANCHORED_ITEMS, items: anchoredItemSchema },
    review_first: { type: "array", maxItems: MAX_ANCHORED_ITEMS, items: anchoredItemSchema },
    risk_narratives: {
      type: "array",
      maxItems: MAX_ANCHORED_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["risk_id", "text"],
        properties: {
          risk_id: { type: "string" },
          text: { type: "string" },
          suggested_checks: { type: "array", maxItems: 4, items: { type: "string" } }
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

  const diffExcerpt = redact(buildDiffExcerpt(input.diff)).slice(0, MAX_DIFF_EXCERPT_CHARS);

  const facts = {
    repo: input.repo,
    base_ref: input.scope.base_ref,
    head_ref: input.scope.head_ref,
    diff_source: input.scope.diff_source,
    changed_files: input.scope.changed_files.slice(0, MAX_CHANGED_FILES).map((file) => ({
      path: file.path,
      status: file.status,
      role: file.role,
      areas: file.areas
    })),
    diff_excerpt: diffExcerpt,
    affected_areas: input.scope.affected_areas,
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
    allowed_paths: [...allowedPaths].sort(compareStrings),
    allowed_requirement_ids: [...allowedRequirementIds].sort(compareStrings),
    allowed_risk_ids: [...allowedRiskIds].sort(compareStrings)
  };

  return { facts, allowedPaths, allowedRequirementIds, allowedRiskIds };
}

function buildDiffExcerpt(diff: StructuredDiff): string {
  const lines: string[] = [];
  for (const file of diff.files) {
    lines.push(`# ${file.status} ${file.path}`);
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") {
          lines.push(`+ ${line.text}`);
        } else if (line.kind === "delete") {
          lines.push(`- ${line.text}`);
        }
      }
    }
  }
  return lines.join("\n");
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
function validateItems(value: unknown, allowedPaths: Set<string>, allowedReqs: Set<string>, allowedRisks: Set<string>): AnchoredNarrativeItem[] {
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
    const item: AnchoredNarrativeItem = { text: redact(raw.text) };
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
  return items.slice(0, MAX_ANCHORED_ITEMS);
}

// Every free-text field (summary, item text, risk narrative text) gets the same
// anchored-or-dropped discipline as the structured anchors: scan the prose for
// path-like and ACID-like tokens and, if it names any that is NOT on an allowlist,
// treat it as having fabricated a reference. A clean text passes; a polluted one is
// replaced (summary) or its whole item/narrative is dropped. Risk ids (PR-RISK-NNN)
// match neither pattern, so a risk narrative may still name its own risk id freely.
// Path token: a slash-bearing token ending in an extension. A leading-dot segment
// (.github/workflows/ci.yml) is captured too — the prior \b anchor excluded the
// leading dot, so a dot-prefixed allowlisted path was extracted WITHOUT its dot,
// failed the allowlist match, and wrongly dropped valid items mentioning it.
const TEXT_PATH_TOKEN = /(?<![\w./-])\.?[\w-]+(?:\/[\w.-]+)+\.[A-Za-z][\w]*/g; // e.g. src/foo/bar.ts, .github/x/ci.yml
const TEXT_ACID_TOKEN = /\b[A-Za-z][\w-]*\.[A-Za-z][\w-]*\.\d+\b/g; // e.g. review-surfaces.PRIVACY.2
// A ROOT-level filename has no slash, so TEXT_PATH_TOKEN misses it. Match a bare
// filename with a known, file-only extension (e.g. package.json, tsconfig.json,
// README.md). .js/.jsx are deliberately excluded: prose like "Node.js"/"Next.js"
// would otherwise be misread as a fabricated path and drop a valid item.
const TEXT_ROOT_FILE_TOKEN = /(?<![\w./-])[\w-]+\.(?:json|jsonc|ya?ml|toml|cfg|lock|sh|md|tsx?)\b/g;

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

function deterministicSummary(scope: PrScopeModel): string {
  return `${scope.changed_files.length} changed file(s) across ${scope.affected_areas.length} review area(s); ${scope.affected_requirements.length} affected requirement(s).`;
}

function validateRiskNarratives(
  value: unknown,
  allowedRisks: Set<string>,
  allowedPaths: Set<string>,
  allowedReqs: Set<string>
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
    const checks = asStringArray(raw.suggested_checks).map(redact);
    if (checks.some((check) => !textCitesOnlyAllowed(check, allowedPaths, allowedReqs))) {
      continue;
    }
    const item: AnchoredRiskNarrative = { risk_id: raw.risk_id, text: redact(raw.text) };
    if (checks.length > 0) {
      item.suggested_checks = checks.slice(0, 4);
    }
    items.push(item);
  }
  return items.slice(0, MAX_ANCHORED_ITEMS);
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

  const whatChanged = validateItems(data.what_changed, allowedPaths, allowedRequirementIds, allowedRiskIds);
  const whyItMatters = validateItems(data.why_it_matters, allowedPaths, allowedRequirementIds, allowedRiskIds);
  const reviewFirst = validateItems(data.review_first, allowedPaths, allowedRequirementIds, allowedRiskIds);
  const riskNarratives = validateRiskNarratives(data.risk_narratives, allowedRiskIds, allowedPaths, allowedRequirementIds);

  // Require at least one validated item across the sections, else the surface is
  // blocked (deterministic-only is insufficient for PR mode).
  if (whatChanged.length + whyItMatters.length + reviewFirst.length + riskNarratives.length === 0) {
    return {
      meta: { ...baseMeta, status: "failed", validation_errors: ["no_valid_anchored_items"] },
      blocked_reason: "invalid_llm_output"
    };
  }

  // NOTE: no diagram_caption. It was un-anchored LLM free text (the only narrative
  // field that bypassed allowlist validation) and no renderer ever read it, so it
  // only ever risked shipping off-allowlist LLM prose into the persisted artifact.
  const rawSummary = typeof data.summary === "string" ? data.summary : "";
  const summary =
    rawSummary !== "" && textCitesOnlyAllowed(rawSummary, allowedPaths, allowedRequirementIds)
      ? redact(rawSummary)
      : deterministicSummary(input.scope);
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
