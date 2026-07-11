import {
  CONVERSATION_ANALYSIS_SECTIONS,
  type ConversationAnalysis
} from "../contracts/conversation-review";
import type { ProviderName, ReasoningProvider } from "../contracts/provider";
import {
  ANALYSIS_CHUNK_SIZE,
  buildConversationAnalysisChunkPrompt,
  buildConversationAnalysisPrompt,
  buildConversationAnalysisReducerPrompt,
  chunkConversationAnalysisEvents,
  prepareConversationEvents
} from "./analysis-prompt-context";
import {
  CONVERSATION_ANALYSIS_SCHEMA,
  groundConversationAnalysisResult,
  notAssessedConversationAnalysis
} from "./analysis-result-grounding";
import type { ConversationEvent } from "./events";
import {
  buildDeterministicConversationBrief,
  mergeConversationAnalysis
} from "./deterministic-brief";

export { CONVERSATION_ANALYSIS_STATUSES } from "../contracts/conversation-review";
export type {
  ConversationAnalysis,
  ConversationAnalysisItem,
  ConversationAnalysisStatus
} from "../contracts/conversation-review";
export {
  compareConversationEvents,
  conversationEventOrderIsMonotonic
} from "./analysis-prompt-context";
export {
  CONVERSATION_ANALYSIS_SCHEMA,
  conversationAnalysisEvidence,
  notAssessedConversationAnalysis
} from "./analysis-result-grounding";

export interface AnalyzeConversationInput {
  provider: ReasoningProvider;
  providerName: ProviderName;
  events?: ConversationEvent[];
  redactSecrets?: boolean;
  remotePrivacyBlocked?: boolean;
}

/**
 * Extract a grounded, conversation-first model. Provider prose is always
 * redacted and bounded before it can enter an artifact. Unknown/fabricated
 * event ids are removed; an item left without a real citation is dropped.
 */
export async function analyzeConversation(input: AnalyzeConversationInput): Promise<ConversationAnalysis> {
  if (!input.events || input.events.length === 0) {
    return notAssessedConversationAnalysis(input.providerName);
  }
  const totalEventCount = input.events.length;

  const safe = prepareConversationEvents(input.events);
  if (safe.events.length === 0) {
    return notAssessedConversationAnalysis(
      input.providerName,
      "The conversation log contained no usable events; conversation intent was not assessed."
    );
  }

  const providerOptions = {
    redactSecrets: input.redactSecrets ?? true,
    remotePrivacyBlocked: input.remotePrivacyBlocked === true || safe.blocked
  };
  const baseQualityFlags = [
    ...(safe.truncated ? ["conversation_input_truncated"] : []),
    ...(safe.redacted ? ["conversation_input_redacted"] : [])
  ];
  const baseline = buildDeterministicConversationBrief(
    safe.events,
    input.providerName,
    baseQualityFlags
  );
  if (input.providerName === "mock") {
    return {
      ...baseline,
      quality_flags: [...baseline.quality_flags, "conversation_enrichment_not_requested"]
    };
  }

  if (safe.events.length <= ANALYSIS_CHUNK_SIZE) {
    const result = await input.provider.generateStructured(
      "conversation_analysis",
      buildConversationAnalysisPrompt(safe.events, totalEventCount, safe.truncated),
      CONVERSATION_ANALYSIS_SCHEMA,
      providerOptions
    );
    return mergeConversationAnalysis(
      baseline,
      groundConversationAnalysisResult(result, safe.events, input.providerName, baseQualityFlags)
    );
  }

  // Long conversations are read in chronological windows, then reduced in a
  // second pass. This preserves the causal sequence (especially late user
  // corrections) instead of salience-shuffling isolated turns.
  const chunks = chunkConversationAnalysisEvents(safe.events, ANALYSIS_CHUNK_SIZE);
  const partials: ConversationAnalysis[] = [];
  const successfulEventIds = new Set<string>();
  const chunkQualityFlags = new Set<string>();
  let failedChunks = 0;
  let privacyBlockedChunks = 0;
  const chunkResults = await Promise.all(chunks.map((chunk, index) =>
    input.provider.generateStructured(
      "conversation_analysis_chunk",
      buildConversationAnalysisChunkPrompt(
        chunk,
        index + 1,
        chunks.length,
        totalEventCount,
        safe.truncated
      ),
      CONVERSATION_ANALYSIS_SCHEMA,
      providerOptions
    )
  ));
  for (const [index, result] of chunkResults.entries()) {
    const chunk = chunks[index];
    if (!result.ok && result.reason === "privacy_block") {
      privacyBlockedChunks += 1;
    }
    const partial = groundConversationAnalysisResult(result, chunk, input.providerName, []);
    if (partial.status === "analyzed") {
      partials.push(partial);
      partial.quality_flags.forEach((flag) => chunkQualityFlags.add(flag));
      for (const section of CONVERSATION_ANALYSIS_SECTIONS) {
        for (const item of partial[section]) {
          for (const eventId of item.event_ids) {
            successfulEventIds.add(eventId);
          }
        }
      }
    } else {
      failedChunks += 1;
    }
  }
  if (partials.length === 0) {
    const privacyBlocked = privacyBlockedChunks === chunks.length;
    return mergeConversationAnalysis(baseline, {
      ...baseline,
      status: "degraded",
      summary: privacyBlocked
        ? "Conversation analysis enrichment was blocked because the log contained high-risk secret material."
        : "Conversation analysis enrichment was unavailable from the configured provider.",
      intent: [],
      refinements: [],
      decisions: [],
      constraints: [],
      non_goals: [],
      rejected_alternatives: [],
      claims: [],
      validation_claims: [],
      validation_observations: [],
      known_gaps: [],
      quality_flags: [
        privacyBlocked ? "conversation_analysis_privacy_blocked" : "conversation_analysis_unavailable",
        ...baseQualityFlags
      ]
    });
  }

  const reducerEvents = safe.events.filter((event) => successfulEventIds.has(event.id));
  const reduced = await input.provider.generateStructured(
    "conversation_analysis",
    buildConversationAnalysisReducerPrompt(
      partials,
      reducerEvents,
      CONVERSATION_ANALYSIS_SECTIONS,
      totalEventCount,
      safe.truncated
    ),
    CONVERSATION_ANALYSIS_SCHEMA,
    providerOptions
  );
  return mergeConversationAnalysis(
    baseline,
    groundConversationAnalysisResult(reduced, reducerEvents, input.providerName, [
      ...baseQualityFlags,
      ...chunkQualityFlags,
      ...(failedChunks > 0 ? ["conversation_analysis_partial"] : [])
    ])
  );
}
