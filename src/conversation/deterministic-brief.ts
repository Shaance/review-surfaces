import type {
  ConversationAnalysis,
  ConversationAnalysisItem,
  ConversationValidationObservation
} from "../contracts/conversation-review";
import type { ProviderName } from "../contracts/provider";
import { compareStrings } from "../core/compare";
import type { SanitizedConversationEvent } from "./analysis-prompt-context";
import { conversationEventLooksLikeGeneratedPayload } from "./generated-payload";

const MAX_ITEMS = 12;
const MAX_TEXT = 500;
const MAX_SUMMARY = 900;

const CORRECTION = /^(?:no\b|actually\b|correction\b|instead\b|change\b|final correction\b)|\b(?:rather than|not that|supersedes?)\b/i;
const CONSTRAINT = /\b(?:must|must not|need to|required|only|without|preserve|keep|do not|don't|never)\b/i;
const NON_GOAL = /^(?:do not|don't)\b|\b(?:non[- ]goal|out of scope|not in scope|no need to|do not include|don't include|exclude from scope|skip (?:support for|adding))\b/i;
const AGENT_CLAIM = /\b(?:i|we)\s+(?:added|changed|chose|completed|created|fixed|implemented|kept|preserved|removed|updated|used|wired)\b/i;
const VALIDATION_MENTION = /\b(?:tests?|test suite|lint|typecheck|type check|build|validation|checks?|pnpm|npm|yarn|bun|node --test|tsc)\b/i;
const VALIDATION_OUTCOME = /\b(?:pass(?:ed|es|ing)?|fail(?:ed|ing)?|green|succeed(?:ed)?|successful|validated|verified|errored|errors?)\b/i;
export function buildDeterministicConversationBrief(
  events: readonly SanitizedConversationEvent[],
  provider: ProviderName,
  qualityFlags: readonly string[] = []
): ConversationAnalysis {
  const ordered = [...events].sort((left, right) =>
    left.raw_index - right.raw_index || compareStrings(left.id, right.id)
  );
  const userEvents = ordered.filter(isEligibleUserMessage);
  const assistantEvents = ordered.filter(isEligibleAssistantMessage);
  const intent: ConversationAnalysisItem[] = [];
  const refinements: ConversationAnalysisItem[] = [];
  const constraints: ConversationAnalysisItem[] = [];
  const nonGoals: ConversationAnalysisItem[] = [];
  const claims: ConversationAnalysisItem[] = [];
  const validationClaims: ConversationAnalysisItem[] = [];
  const observations: ConversationValidationObservation[] = [];

  for (const [index, event] of userEvents.entries()) {
    const item = itemFromEvent(event);
    if (index === 0) intent.push(item);
    if (CORRECTION.test(event.summary)) intent.push(item);
    if (index > 0) refinements.push(item);
    if (CONSTRAINT.test(event.summary)) constraints.push(item);
    if (NON_GOAL.test(event.summary)) nonGoals.push(item);
  }
  for (const event of assistantEvents) {
    if (VALIDATION_MENTION.test(event.summary) && VALIDATION_OUTCOME.test(event.summary)) {
      validationClaims.push(itemFromEvent(event));
    } else if (AGENT_CLAIM.test(event.summary)) {
      claims.push(itemFromEvent(event));
    }
  }
  for (const event of ordered) {
    const observation = validationObservation(event);
    if (observation) observations.push(observation);
  }

  const latestIntent = intent.at(-1) ?? refinements.at(-1);
  const hasDeterministicContent = intent.length > 0 || refinements.length > 0 ||
    constraints.length > 0 || nonGoals.length > 0 || claims.length > 0 ||
    validationClaims.length > 0 || observations.length > 0;
  const summary = latestIntent
    ? `Deterministic conversation brief: ${latestIntent.text}`
    : observations.length > 0 || claims.length > 0 || validationClaims.length > 0
      ? "Deterministic conversation brief recovered agent claims and observed validation outcomes; active user intent was not explicit."
      : "Deterministic conversation brief found no eligible explicit intent or claims."
  return {
    status: hasDeterministicContent ? "analyzed" : "degraded",
    provider,
    summary: bound(summary, MAX_SUMMARY),
    intent: cap(intent),
    refinements: cap(refinements),
    decisions: [],
    constraints: cap(constraints),
    non_goals: cap(nonGoals),
    rejected_alternatives: [],
    claims: cap(claims),
    validation_claims: cap(validationClaims),
    validation_observations: cap(observations),
    known_gaps: [],
    quality_flags: [...new Set([
      "conversation_deterministic_baseline",
      ...qualityFlags,
      ...(!hasDeterministicContent ? ["conversation_no_eligible_baseline_events"] : [])
    ])].slice(0, 20)
  };
}

export function mergeConversationAnalysis(
  baseline: ConversationAnalysis,
  enrichment: ConversationAnalysis
): ConversationAnalysis {
  if (enrichment.status !== "analyzed") {
    return {
      ...baseline,
      quality_flags: [...new Set([
        ...baseline.quality_flags,
        ...enrichment.quality_flags,
        "conversation_enrichment_unavailable"
      ])].slice(0, 20)
    };
  }
  return {
    ...baseline,
    status: "analyzed",
    summary: baseline.status === "analyzed" ? baseline.summary : enrichment.summary,
    // A deterministic active-intent sequence is authoritative. Provider intent
    // may fill a genuinely absent baseline, but can never trail and supersede it.
    intent: mergeIntent(enrichment.intent, baseline.intent),
    refinements: mergeItems(baseline.refinements, enrichment.refinements),
    decisions: mergeItems(baseline.decisions, enrichment.decisions),
    constraints: mergeItems(baseline.constraints, enrichment.constraints),
    non_goals: mergeItems(baseline.non_goals, enrichment.non_goals),
    rejected_alternatives: mergeItems(baseline.rejected_alternatives, enrichment.rejected_alternatives),
    claims: mergeItems(baseline.claims, enrichment.claims),
    validation_claims: mergeItems(baseline.validation_claims, enrichment.validation_claims),
    validation_observations: baseline.validation_observations ?? [],
    known_gaps: mergeItems(baseline.known_gaps, enrichment.known_gaps),
    quality_flags: [...new Set([...baseline.quality_flags, ...enrichment.quality_flags])].slice(0, 20)
  };
}

function isEligibleUserMessage(event: SanitizedConversationEvent): boolean {
  return event.actor.trim().toLowerCase() === "user" && isNaturalLanguageEvent(event) &&
    reviewerText(event.summary).trim().length > 0;
}

function isEligibleAssistantMessage(event: SanitizedConversationEvent): boolean {
  const actor = event.actor.trim().toLowerCase();
  return (actor === "assistant" || actor === "agent") && isNaturalLanguageEvent(event) &&
    reviewerText(event.summary).trim().length > 0;
}

function isNaturalLanguageEvent(event: SanitizedConversationEvent): boolean {
  const kind = event.kind.trim().toLowerCase();
  return kind !== "tool_call" && kind !== "custom_tool_call" &&
    kind !== "tool_result" && kind !== "custom_tool_call_output" &&
    kind !== "function_call" && kind !== "function_call_output" &&
    !conversationEventLooksLikeGeneratedPayload(event.summary);
}

function validationObservation(event: SanitizedConversationEvent): ConversationValidationObservation | undefined {
  const actor = event.actor.trim().toLowerCase();
  const kind = event.kind.trim().toLowerCase();
  if (actor !== "tool" || (kind !== "tool_result" && kind !== "custom_tool_call_output" && kind !== "function_call_output")) {
    return undefined;
  }
  if (!event.command || !looksLikeValidationCommand(event.command)) return undefined;
  if (!event.result_status) return undefined;
  const text = bound(event.summary, MAX_TEXT) ||
    bound(`${event.command} completed with structured status ${event.result_status}.`, MAX_TEXT);
  return {
    text,
    event_ids: [event.id],
    status: event.result_status,
    ...(event.tool ? { tool: bound(event.tool, 240) } : {}),
    ...(event.command ? { command: bound(event.command, 500) } : {})
  };
}

function itemFromEvent(event: SanitizedConversationEvent): ConversationAnalysisItem {
  return { text: bound(reviewerText(event.summary), MAX_TEXT), event_ids: [event.id] };
}

function reviewerText(summary: string): string {
  const marker = "## My request for Codex:";
  const requestIndex = summary.indexOf(marker);
  return requestIndex >= 0 ? summary.slice(requestIndex + marker.length) : summary;
}

function looksLikeValidationCommand(command: string): boolean {
  return command.split(/&&|\|\||;|\n/).some((segment) =>
    /^(?:rtk\s+)?(?:(?:\/usr\/bin\/env|env)\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:(?:\S*\/)?(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|build|check)(?::[\w.-]+)?|(?:\S*\/)?node\s+--test|(?:\S*\/)?tsc|(?:\S*\/)?cargo\s+(?:test|check|clippy)|(?:\S*\/)?go\s+test|(?:\S*\/)?pytest)(?:\s|$)/i.test(segment.trim())
  );
}

function cap<Item extends ConversationAnalysisItem>(items: readonly Item[]): Item[] {
  if (items.length <= MAX_ITEMS) return [...items];
  return [items[0], ...items.slice(-(MAX_ITEMS - 1))];
}

function mergeItems(
  baseline: readonly ConversationAnalysisItem[],
  enrichment: readonly ConversationAnalysisItem[]
): ConversationAnalysisItem[] {
  const result = [...baseline];
  const seen = new Set(result.map(itemKey));
  for (const item of enrichment) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= MAX_ITEMS) break;
  }
  return result;
}

function mergeIntent(
  enrichment: readonly ConversationAnalysisItem[],
  baseline: readonly ConversationAnalysisItem[]
): ConversationAnalysisItem[] {
  if (baseline.length === 0) return cap(enrichment);
  const baselineKeys = new Set(baseline.map(itemKey));
  const additions = enrichment
    .filter((item) => !baselineKeys.has(itemKey(item)))
    .slice(0, Math.max(0, MAX_ITEMS - baseline.length));
  // Provider context may precede the canonical local sequence, but it can never
  // trail it and accidentally become the active `.at(-1)` intent.
  return [...additions, ...baseline];
}

function itemKey(item: ConversationAnalysisItem): string {
  return `${item.text.trim().toLowerCase()}\0${[...item.event_ids].sort(compareStrings).join("\0")}`;
}

function bound(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : normalized.slice(0, limit);
}
