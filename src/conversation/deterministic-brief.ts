import type {
  ConversationAnalysis,
  ConversationAnalysisItem,
  ConversationValidationObservation
} from "../contracts/conversation-review";
import type { ProviderName } from "../contracts/provider";
import {
  commandLooksLikeLocalValidationCommand,
  stripTrailingValidationOutcome,
  validationOutcomeIsHypothetical,
  validationTextHasOutcome,
  validationTextMentionsTooling,
  type CommandRule
} from "../core/command-classify";
import { commandSegments, statusBearingCommandSegments } from "../core/command-segments";
import { compareStrings } from "../core/compare";
import type { SanitizedConversationEvent } from "./analysis-prompt-context";
import { conversationEventLooksLikeGeneratedPayload, conversationReviewerText } from "./generated-payload";

const MAX_ITEMS = 12;
const MAX_TEXT = 500;
const MAX_SUMMARY = 900;

const CORRECTION = /^(?:no\b|actually\b|correction\b|instead\b|change\b|final correction\b|(?:that|this)(?:'s| is) wrong\b|you missed\b)|\b(?:rather than|not that|supersedes?)\b/i;
const CONSTRAINT = /\b(?:must|must not|need to|required|only|without|preserve|keep|do not|don't|never)\b/i;
const NON_GOAL = /^(?:do not|don't)\b|\b(?:non[- ]goal|out of scope|not in scope|no need to|do not include|don't include|exclude from scope|skip (?:support for|adding))\b/i;
const AGENT_CLAIM = /\b(?:i|we)\s+(?:added|changed|chose|completed|created|fixed|implemented|kept|preserved|removed|updated|used|wired)\b/i;
const SUBJECTLESS_AGENT_CLAIM = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*{1,2}|_{1,2})?(?:added|changed|chose|completed|created|fixed|implemented|kept|preserved|removed|updated|used|wired)(?:\*{1,2}|_{1,2})?(?=\s|[.:,;!?]|$)/i;
export function buildDeterministicConversationBrief(
  events: readonly SanitizedConversationEvent[],
  provider: ProviderName,
  qualityFlags: readonly string[] = [],
  commandRules: readonly CommandRule[] = []
): ConversationAnalysis {
  const ordered = [...events].sort((left, right) =>
    left.raw_index - right.raw_index || compareStrings(left.id, right.id)
  );
  const userEvents = uniqueUserMessages(ordered.filter(isEligibleUserMessage));
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
    const text = conversationReviewerText(event.summary).trim();
    if (index === 0) intent.push(item);
    if (index > 0 && CORRECTION.test(text)) intent.push(item);
    if (index > 0 && (CORRECTION.test(text) || CONSTRAINT.test(text) || looksLikeDirective(text))) refinements.push(item);
    if (CONSTRAINT.test(text)) constraints.push(item);
    if (NON_GOAL.test(text)) nonGoals.push(item);
  }
  for (const event of assistantEvents) {
    const text = conversationReviewerText(event.summary).trim();
    if (validationTextHasOutcome(text) && !validationOutcomeIsHypothetical(text) &&
      looksLikeValidationClaim(text, commandRules)) {
      validationClaims.push(itemFromEvent(event));
    }
    if (AGENT_CLAIM.test(text) || SUBJECTLESS_AGENT_CLAIM.test(text)) {
      claims.push(itemFromEvent(event));
    }
  }
  for (const event of ordered) {
    const observation = validationObservation(event, commandRules);
    if (observation) observations.push(observation);
  }

  const originalIntent = intent[0];
  const latestIntent = refinements.at(-1) ?? intent.at(-1);
  const hasDeterministicContent = intent.length > 0 || refinements.length > 0 ||
    constraints.length > 0 || nonGoals.length > 0 || claims.length > 0 ||
    validationClaims.length > 0 || observations.length > 0;
  const summary = originalIntent
    ? latestIntent && latestIntent.text !== originalIntent.text
      ? `Stated goal: ${bound(originalIntent.text, 420)} Latest refinement: ${bound(latestIntent.text, 240)}`
      : `Stated goal: ${bound(originalIntent.text, 600)}`
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

function looksLikeDirective(text: string): boolean {
  const normalized = text.trim();
  if (/^(?:i authorize\b|yes,?\s+let's\b|let's\b|go ahead\b|make sure\b|ensure\b)/i.test(normalized)) return true;
  const action = "(?:use|update|fix|add|remove|run|open|merge|keep|work on|audit|review|build|change)";
  return normalized.split(/[.;]\s+/).some((clause) =>
    new RegExp(`^(?:also\\s+|please\\s+)?${action}\\b`, "i").test(clause) ||
    new RegExp(`^(?:can|could|would)\\s+you\\s+${action}\\b`, "i").test(clause)
  );
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
    conversationReviewerText(event.summary).trim().length > 0;
}

/**
 * Codex desktop can expose one user turn twice: once as an app envelope and
 * once as the canonical user message, with attachment events between them.
 * The reviewer needs one interpretation of that turn, not transport-shaped
 * repetition. Collapse only adjacent copies: the same instruction may be
 * legitimately reasserted after an intervening correction.
 */
function uniqueUserMessages(events: readonly SanitizedConversationEvent[]): SanitizedConversationEvent[] {
  const unique: SanitizedConversationEvent[] = [];
  let previousKey = "";
  for (const event of events) {
    const key = conversationReviewerText(event.summary).replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || key === previousKey) continue;
    unique.push(event);
    previousKey = key;
  }
  return unique;
}

function isEligibleAssistantMessage(event: SanitizedConversationEvent): boolean {
  const actor = event.actor.trim().toLowerCase();
  return (actor === "assistant" || actor === "agent") && isNaturalLanguageEvent(event) &&
    conversationReviewerText(event.summary).trim().length > 0;
}

function isNaturalLanguageEvent(event: SanitizedConversationEvent): boolean {
  const kind = event.kind.trim().toLowerCase();
  const text = conversationReviewerText(event.summary);
  return kind !== "tool_call" && kind !== "custom_tool_call" &&
    kind !== "tool_result" && kind !== "custom_tool_call_output" &&
    kind !== "function_call" && kind !== "function_call_output" &&
    !conversationEventLooksLikeGeneratedPayload(text);
}

function validationObservation(
  event: SanitizedConversationEvent,
  commandRules: readonly CommandRule[]
): ConversationValidationObservation | undefined {
  const actor = event.actor.trim().toLowerCase();
  const kind = event.kind.trim().toLowerCase();
  if (actor !== "tool" || (kind !== "tool_result" && kind !== "custom_tool_call_output" && kind !== "function_call_output")) {
    return undefined;
  }
  if (!event.result_status) return undefined;
  if (!event.command || !statusBearingCommandSegments(event.command, event.result_status).some((segment) =>
    commandLooksLikeLocalValidationCommand(segment, commandRules)
  )) return undefined;
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
  return { text: bound(conversationReviewerText(event.summary), MAX_TEXT), event_ids: [event.id] };
}

function looksLikeValidationClaim(text: string, commandRules: readonly CommandRule[]): boolean {
  if (validationTextMentionsTooling(text)) return true;
  return validationClaimCommandCandidates(text).some((candidate) =>
    looksLikeValidationCommand(candidate, commandRules)
  );
}

function validationClaimCommandCandidates(text: string): string[] {
  const plain = text.replace(/`([^`\n]+)`/g, "$1").trim();
  const withoutOutcome = stripTrailingValidationOutcome(plain
    .replace(/^\s*(?:verified|validated)(?:\s+by)?(?:\s+running)?\s*:?\s*/i, ""));
  const withoutNarration = withoutOutcome
    .replace(/^\s*(?:[-*]\s*)?(?:(?:i|we)\s+)?(?:ran|run|executed|invoked)\s+/i, "")
    .replace(/\s+and\s+(?:it|they|the\s+(?:command|suite))\s*$/i, "")
    .replace(/[,:;.!?]+\s*$/, "")
    .trim();
  return [...new Set([withoutNarration, withoutOutcome, plain].filter(Boolean))];
}

function looksLikeValidationCommand(command: string, commandRules: readonly CommandRule[]): boolean {
  return commandSegments(command).some((segment) =>
    commandLooksLikeLocalValidationCommand(segment.trim(), commandRules)
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
  const result = cap(baseline);
  if (result.length >= MAX_ITEMS) return result;
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
  // The cited local sequence remains authoritative and first because reviewer
  // projections intentionally treat intent[0] as the stated user goal.
  return [...baseline, ...additions];
}

function itemKey(item: ConversationAnalysisItem): string {
  return `${item.text.trim().toLowerCase()}\0${[...item.event_ids].sort(compareStrings).join("\0")}`;
}

function bound(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  const candidate = normalized.slice(0, Math.max(1, limit - 1));
  const wordBoundary = candidate.lastIndexOf(" ");
  return `${wordBoundary >= Math.floor(limit * 0.6) ? candidate.slice(0, wordBoundary) : candidate}…`;
}
