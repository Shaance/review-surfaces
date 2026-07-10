import { parseStructuredDiff } from "../../src/collector/diff-hunks";
import type { ConversationEvent } from "../../src/conversation/events";
import type { ReasoningProvider, StructuredResult } from "../../src/llm/provider";

export const EVENTS: ConversationEvent[] = [
  {
    id: "user-initial",
    actor: "user",
    kind: "message",
    summary: "Keep the retry behavior while simplifying the implementation.",
    raw_index: 0
  },
  {
    id: "assistant-proposal",
    actor: "assistant",
    kind: "message",
    summary: "I can remove the legacy retry branch.",
    raw_index: 1
  },
  {
    id: "user-final",
    actor: "user",
    kind: "message",
    summary: "Do not remove retries; preserve the behavior and simplify around it.",
    raw_index: 2
  }
];

export function analysisPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "The final intent is to simplify without removing retry behavior.",
    intent: [{ text: "Simplify the implementation while keeping retries.", event_ids: ["user-initial"] }],
    refinements: [{ text: "The later user message explicitly preserves retries.", event_ids: ["user-final"] }],
    decisions: [],
    constraints: [{ text: "Retry behavior must remain.", event_ids: ["user-final"] }],
    non_goals: [],
    rejected_alternatives: [
      { text: "Removing the retry branch was superseded by the final user instruction.", event_ids: ["assistant-proposal", "user-final"] }
    ],
    claims: [],
    validation_claims: [],
    known_gaps: [],
    ...overrides
  };
}

interface CandidateOverrides {
  root_cause_key?: string;
  category?: string;
  title?: string;
  summary?: string;
  why_it_matters?: string;
  reviewer_action?: string;
  priority?: string;
  evidence_state?: string;
  conversation_event_ids?: string[];
  paths?: string[];
  requirement_ids?: string[];
  risk_ids?: string[];
  command_ids?: string[];
  diff_anchors?: Array<{ path: string; line_kind: "add" | "delete"; line: number; contains: string }>;
}

export function candidate(overrides: CandidateOverrides = {}): Record<string, unknown> {
  return {
    root_cause_key: "retry-removal",
    category: "intent_mismatch",
    title: "Retry behavior was removed after the user preserved it",
    summary: "The final conversation intent preserves retries, but the reviewed diff deletes the retry branch.",
    why_it_matters: "Requests may now fail without the fallback the user explicitly retained.",
    reviewer_action: "Confirm the deletion is intentional or restore equivalent retry behavior.",
    priority: "high",
    evidence_state: "contradicted",
    conversation_event_ids: ["user-final"],
    paths: ["src/retry.ts"],
    requirement_ids: [],
    risk_ids: [],
    command_ids: [],
    diff_anchors: [],
    ...overrides
  };
}

export function stageProvider(
  insights: Record<string, unknown>[],
  analysis: Record<string, unknown> = analysisPayload()
): { provider: ReasoningProvider; stages: string[]; prompts: Map<string, string> } {
  const stages: string[] = [];
  const prompts = new Map<string, string>();
  const provider: ReasoningProvider = {
    name: "ai-sdk",
    async generateStructured(stage, prompt): Promise<StructuredResult> {
      stages.push(stage);
      prompts.set(stage, prompt);
      if (stage === "conversation_analysis") {
        return { ok: true, data: analysis };
      }
      if (stage === "conversation_review_insights") {
        return { ok: true, data: { insights } };
      }
      return { ok: false, reason: `unexpected_stage:${stage}` };
    }
  };
  return { provider, stages, prompts };
}

export function retryDeletionDiff(): ReturnType<typeof parseStructuredDiff> {
  return parseStructuredDiff([
    "diff --git a/src/retry.ts b/src/retry.ts",
    "index 1111111..2222222 100644",
    "--- a/src/retry.ts",
    "+++ b/src/retry.ts",
    "@@ -10,2 +10,1 @@ export async function request() {",
    "-  return retryWithBackoff(send);",
    "+  return send();"
  ].join("\n"));
}
