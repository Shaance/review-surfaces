import { isRecord } from "../core/guards";
import {
  buildNotAssessedConversationAnalysis,
  CONVERSATION_ANALYSIS_SECTIONS,
  emptyConversationAnalysisSections,
  NOT_ASSESSED_CONVERSATION_SUMMARIES,
  type ConversationAnalysis,
  type ConversationAnalysisItem,
  type ConversationAnalysisSection,
  type ConversationAnalysisStatus
} from "../contracts/conversation-review";
import type { EvidenceRef } from "../contracts/evidence";
import type { ProviderName, ReasoningProvider } from "../contracts/provider";
import { inspectAndRedactSecrets, redactSecrets as redactSecretText } from "../privacy/secrets";
import {
  MAX_CONVERSATION_EVENT_ID_CHARS,
  type SanitizedConversationEvent
} from "./analysis-prompt-context";
import { conversationEventLooksLikeGeneratedPayload } from "./generated-payload";

const MAX_SUMMARY_CHARS = 900;
const MAX_ITEM_TEXT_CHARS = 500;
const MAX_ITEMS_PER_SECTION = 12;
const MAX_CITATIONS_PER_ITEM = 6;

type SectionName = ConversationAnalysisSection;

const ANALYSIS_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", minLength: 1, maxLength: MAX_ITEM_TEXT_CHARS },
    event_ids: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CITATIONS_PER_ITEM,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: MAX_CONVERSATION_EVENT_ID_CHARS }
    }
  },
  required: ["text", "event_ids"]
} as const;

/** Strict provider-output contract. Runtime validation below repeats the trust boundary. */
export const CONVERSATION_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1, maxLength: MAX_SUMMARY_CHARS },
    ...Object.fromEntries(
      CONVERSATION_ANALYSIS_SECTIONS.map((name) => [
        name,
        {
          type: "array",
          maxItems: MAX_ITEMS_PER_SECTION,
          items: ANALYSIS_ITEM_SCHEMA
        }
      ])
    )
  },
  required: ["summary", ...CONVERSATION_ANALYSIS_SECTIONS]
} as const;

/**
 * Explicit, deterministic result for the absence of a usable conversation.
 * It deliberately says not assessed rather than implying that no intent/gaps
 * existed.
 */
export function notAssessedConversationAnalysis(
  providerName: ProviderName,
  reason: string = NOT_ASSESSED_CONVERSATION_SUMMARIES.missing_log
): ConversationAnalysis {
  if (reason === NOT_ASSESSED_CONVERSATION_SUMMARIES.missing_log) {
    return buildNotAssessedConversationAnalysis(providerName);
  }
  const summary = boundedRedacted(reason, MAX_SUMMARY_CHARS) || "Conversation intent was not assessed.";
  return emptyAnalysis("not_assessed", providerName, summary, [
    "conversation_log_missing"
  ]);
}

export function groundConversationAnalysisResult(
  result: Awaited<ReturnType<ReasoningProvider["generateStructured"]>>,
  events: SanitizedConversationEvent[],
  providerName: ProviderName,
  baseQualityFlags: string[]
): ConversationAnalysis {
  if (!result.ok) {
    const privacyBlocked = result.reason === "privacy_block";
    return degradedConversationAnalysis(providerName, privacyBlocked
      ? "Conversation analysis was blocked because the log contained high-risk secret material."
      : "Conversation analysis was unavailable from the configured provider.", [
      privacyBlocked ? "conversation_analysis_privacy_blocked" : "conversation_analysis_unavailable",
      ...baseQualityFlags
    ]);
  }
  if (!isStrictPayload(result.data)) {
    return degradedConversationAnalysis(providerName, "The provider returned an invalid conversation analysis payload.", [
      "conversation_analysis_invalid_payload",
      ...baseQualityFlags
    ]);
  }
  const payload = result.data;

  const allowedEventIds = new Set(events.map((event) => event.id));
  const eventsById = new Map(events.map((event) => [event.id, event]));
  let rejectedCitationCount = 0;
  let rejectedRoleCount = 0;
  let outputRedacted = false;
  const userEventIds = new Set(events
    .filter((event) => event.actor.toLowerCase() === "user")
    .map((event) => event.id));
  const sections = Object.fromEntries(
    CONVERSATION_ANALYSIS_SECTIONS.map((section) => {
      const sanitized = sanitizeItems(
        payload[section],
        allowedEventIds,
        sectionRequiresUserCitation(section) ? userEventIds : undefined
      );
      rejectedCitationCount += sanitized.rejectedCitations;
      outputRedacted ||= sanitized.redacted;
      return [section, sanitized.items];
    })
  ) as Record<SectionName, ConversationAnalysisItem[]>;
  for (const section of CONVERSATION_ANALYSIS_SECTIONS) {
    const sanitized = retainRoleCompatibleCitations(sections[section], section, eventsById);
    sections[section] = sanitized.items;
    rejectedRoleCount += sanitized.rejected;
  }
  const safeSummary = boundedRedactedWithSignal(payload.summary, MAX_SUMMARY_CHARS);
  outputRedacted ||= safeSummary.redacted;
  if (!safeSummary.text) {
    return degradedConversationAnalysis(providerName, "The provider returned an empty conversation summary.", [
      "conversation_analysis_invalid_payload",
      ...baseQualityFlags
    ]);
  }
  if (CONVERSATION_ANALYSIS_SECTIONS.every((section) => sections[section].length === 0)) {
    return degradedConversationAnalysis(
      providerName,
      "The provider returned no grounded conversation items; conversation intent was not assessed.",
      [
        "conversation_analysis_ungrounded",
        ...baseQualityFlags,
        ...(outputRedacted ? ["conversation_analysis_output_redacted"] : []),
        ...(rejectedCitationCount > 0 ? ["conversation_citations_rejected"] : []),
        ...(rejectedRoleCount > 0 ? ["conversation_role_citations_rejected"] : [])
      ]
    );
  }

  return {
    status: "analyzed",
    provider: providerName,
    summary: safeSummary.text,
    ...sections,
    quality_flags: [...new Set([
      ...baseQualityFlags,
      ...(outputRedacted ? ["conversation_analysis_output_redacted"] : []),
      ...(rejectedCitationCount > 0 ? ["conversation_citations_rejected"] : []),
      ...(rejectedRoleCount > 0 ? ["conversation_role_citations_rejected"] : [])
    ])]
  };
}

/** Convert validated event citations to the repository's common evidence shape. */
export function conversationAnalysisEvidence(item: ConversationAnalysisItem): EvidenceRef[] {
  return item.event_ids.map((eventId) => ({
    kind: "conversation",
    event_id: eventId,
    note: "LLM-proposed conversation interpretation; the event citation was validated.",
    confidence: "low",
    validation_status: "valid",
    llm_proposed: true
  }));
}

export function degradedConversationAnalysis(
  providerName: ProviderName,
  summary: string,
  qualityFlags: string[]
): ConversationAnalysis {
  return emptyAnalysis("degraded", providerName, summary, qualityFlags);
}

function emptyAnalysis(
  status: ConversationAnalysisStatus,
  providerName: ProviderName,
  summary: string,
  qualityFlags: string[]
): ConversationAnalysis {
  return {
    status,
    provider: providerName,
    summary,
    ...emptyConversationAnalysisSections(),
    quality_flags: [...new Set(qualityFlags)]
  };
}

function isStrictPayload(value: unknown): value is Record<SectionName, unknown[]> & { summary: string } {
  if (!isRecord(value) || typeof value.summary !== "string" || value.summary.length === 0 || value.summary.length > MAX_SUMMARY_CHARS) {
    return false;
  }
  const allowedKeys = new Set<string>(["summary", ...CONVERSATION_ANALYSIS_SECTIONS]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return false;
  }
  for (const section of CONVERSATION_ANALYSIS_SECTIONS) {
    const entries = value[section];
    if (!Array.isArray(entries) || entries.length > MAX_ITEMS_PER_SECTION) {
      return false;
    }
    for (const entry of entries) {
      if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "text" && key !== "event_ids")) {
        return false;
      }
      if (typeof entry.text !== "string" || entry.text.length === 0 || entry.text.length > MAX_ITEM_TEXT_CHARS) {
        return false;
      }
      if (!Array.isArray(entry.event_ids) || entry.event_ids.length === 0 || entry.event_ids.length > MAX_CITATIONS_PER_ITEM) {
        return false;
      }
      if (entry.event_ids.some((eventId) =>
        typeof eventId !== "string" ||
        eventId.length === 0 ||
        eventId.length > MAX_CONVERSATION_EVENT_ID_CHARS
      )) {
        return false;
      }
      if (new Set(entry.event_ids).size !== entry.event_ids.length) {
        return false;
      }
    }
  }
  return true;
}

function sanitizeItems(
  value: unknown[],
  allowedEventIds: Set<string>,
  preferredEventIds?: Set<string>
): { items: ConversationAnalysisItem[]; rejectedCitations: number; redacted: boolean } {
  const items: ConversationAnalysisItem[] = [];
  const itemIndexByText = new Map<string, number>();
  let rejectedCitations = 0;
  let redacted = false;
  for (const raw of value.slice(0, MAX_ITEMS_PER_SECTION)) {
    // isStrictPayload has already checked this exact shape.
    const record = raw as { text: string; event_ids: string[] };
    const safeText = boundedRedactedWithSignal(record.text, MAX_ITEM_TEXT_CHARS);
    redacted ||= safeText.redacted;
    const eventIds: string[] = [];
    for (const rawId of record.event_ids.slice(0, MAX_CITATIONS_PER_ITEM)) {
      const safeId = safeExactEventId(rawId);
      redacted ||= safeId.redacted;
      if (allowedEventIds.has(safeId.text) && !eventIds.includes(safeId.text)) {
        eventIds.push(safeId.text);
      } else {
        rejectedCitations += 1;
      }
    }
    if (!safeText.text || eventIds.length === 0) {
      continue;
    }
    const key = safeText.text.toLowerCase();
    const existingIndex = itemIndexByText.get(key);
    if (existingIndex !== undefined) {
      const existing = items[existingIndex];
      existing.event_ids = prioritizeCitations(
        [...existing.event_ids, ...eventIds],
        preferredEventIds
      );
      continue;
    }
    itemIndexByText.set(key, items.length);
    items.push({
      text: safeText.text,
      event_ids: prioritizeCitations(eventIds, preferredEventIds)
    });
  }
  return { items, rejectedCitations, redacted };
}

function prioritizeCitations(values: string[], preferred?: Set<string>): string[] {
  const uniqueValues = [...new Set(values)];
  if (!preferred) {
    return uniqueValues.slice(0, MAX_CITATIONS_PER_ITEM);
  }
  return [
    ...uniqueValues.filter((eventId) => preferred.has(eventId)),
    ...uniqueValues.filter((eventId) => !preferred.has(eventId))
  ].slice(0, MAX_CITATIONS_PER_ITEM);
}

function sectionRequiresUserCitation(section: SectionName): boolean {
  return section === "intent" ||
    section === "refinements" ||
    section === "constraints" ||
    section === "non_goals" ||
    section === "rejected_alternatives";
}

function retainRoleCompatibleCitations(
  items: ConversationAnalysisItem[],
  section: SectionName,
  eventsById: ReadonlyMap<string, SanitizedConversationEvent>
): { items: ConversationAnalysisItem[]; rejected: number } {
  let rejected = 0;
  const compatible = items.flatMap((item) => {
    const eventIds = item.event_ids.filter((eventId) => {
      const event = eventsById.get(eventId);
      const eligible = event !== undefined && citationRoleIsCompatible(section, event);
      if (!eligible) rejected += 1;
      return eligible;
    });
    if (sectionRequiresUserCitation(section) && !eventIds.some((eventId) =>
      eventsById.get(eventId)?.actor.trim().toLowerCase() === "user"
    )) {
      rejected += eventIds.length > 0 ? 1 : 0;
      return [];
    }
    return eventIds.length > 0 ? [{ ...item, event_ids: eventIds }] : [];
  });
  return { items: compatible, rejected };
}

function citationRoleIsCompatible(
  section: SectionName,
  event: SanitizedConversationEvent
): boolean {
  const actor = event.actor.trim().toLowerCase();
  const kind = event.kind.trim().toLowerCase();
  const natural = kind !== "tool_call" && kind !== "custom_tool_call" &&
    kind !== "tool_result" && kind !== "custom_tool_call_output" &&
    kind !== "function_call" && kind !== "function_call_output";
  if (!natural || conversationEventLooksLikeGeneratedPayload(event.summary)) return false;
  if (sectionRequiresUserCitation(section)) {
    return actor === "user" ||
      (section === "rejected_alternatives" && (actor === "assistant" || actor === "agent"));
  }
  if (section === "claims" || section === "validation_claims") {
    return actor === "assistant" || actor === "agent";
  }
  return actor === "user" || actor === "assistant" || actor === "agent";
}

interface SafeCitation {
  text: string;
  redacted: boolean;
}

function safeExactEventId(value: string): SafeCitation {
  const result = inspectAndRedactSecrets(value);
  const normalized = result.text.replace(/\s+/g, " ").trim();
  const exact = normalized === value && normalized.length <= MAX_CONVERSATION_EVENT_ID_CHARS;
  return {
    text: exact ? normalized : "",
    redacted: result.redactions.length > 0
  };
}

function boundedRedacted(value: string, limit: number): string {
  return boundedRedactedWithSignal(value, limit).text;
}

function boundedRedactedWithSignal(value: string, limit: number): { text: string; redacted: boolean } {
  const result = redactSecretText(value);
  return {
    text: bound(result.text.replace(/\s+/g, " ").trim(), limit),
    redacted: result.redactions.length > 0
  };
}

function bound(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}
