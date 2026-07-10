import { parseStructuredDiff } from "../../src/collector/diff-hunks";
import type {
  ConversationAnalysis,
  ReviewerInsight
} from "../../src/contracts/conversation-review";
import type { ConversationEvent } from "../../src/conversation/events";
import type { ReasoningProvider, StructuredResult } from "../../src/llm/provider";

export const ORDINARY_CONVERSATION_VALUE = "Ordinary reviewer value stays readable.";

export const HOSTILE_CONVERSATION_BARE_HTTPS = "https://bare-link.attacker.invalid/review";
export const HOSTILE_CONVERSATION_BARE_HTTP = "http://http-link.attacker.invalid/review";
export const HOSTILE_CONVERSATION_BARE_FTP = "ftp://ftp-link.attacker.invalid/review";
export const HOSTILE_CONVERSATION_MAILTO = "mailto:mailto-reviewer@attacker.invalid";
export const HOSTILE_CONVERSATION_UPPERCASE_SCHEME = "HTTPS://uppercase-link.attacker.invalid/review";
export const HOSTILE_CONVERSATION_BARE_WWW = "www.bare-link.attacker.invalid/review";
export const HOSTILE_CONVERSATION_EMAIL = "reviewer@attacker.invalid";
export const HOSTILE_CONVERSATION_MENTION = "@hostile-review-team";

export const HOSTILE_CONVERSATION_NEUTRALIZED_ENTITIES = [
  "https&#58;//bare-link.attacker.invalid/review",
  "http&#58;//http-link.attacker.invalid/review",
  "ftp&#58;//ftp-link.attacker.invalid/review",
  "mailto&#58;mailto-reviewer&#64;attacker.invalid",
  "HTTPS&#58;//uppercase-link.attacker.invalid/review",
  "www&#46;bare-link.attacker.invalid/review",
  "reviewer&#64;attacker.invalid",
  "&#64;hostile-review-team"
] as const;

export const HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS = [
  "HOSTILE_SUMMARY_TRAILING_BACKSLASH",
  "HOSTILE_CONTEXT_TRAILING_BACKSLASH",
  "HOSTILE_TITLE_TRAILING_BACKSLASH",
  "HOSTILE_INSIGHT_SUMMARY_TRAILING_BACKSLASH",
  "HOSTILE_WHY_TRAILING_BACKSLASH",
  "HOSTILE_ACTION_TRAILING_BACKSLASH"
] as const;

export const HOSTILE_CONVERSATION_RAW_CONTROLS = [
  "<!--HOSTILE_SUMMARY-->",
  '<details data-hostile="context">',
  "[hostile-summary-link](https://attacker.invalid/summary)",
  "# HOSTILE_CONTEXT_HEADING",
  "[hostile-title-link](https://attacker.invalid/title)",
  "**HOSTILE_INSIGHT_BOLD**",
  "[hostile-why-link](https://attacker.invalid/why)",
  "![hostile-action-image](https://attacker.invalid/action.png)",
  "</details><!--HOSTILE_ACTION-->",
  "`HOSTILE_INLINE_CODE`",
  "| HOSTILE_PIPE |",
  "~~HOSTILE_STRIKE~~",
  HOSTILE_CONVERSATION_BARE_HTTPS,
  HOSTILE_CONVERSATION_BARE_HTTP,
  HOSTILE_CONVERSATION_BARE_FTP,
  HOSTILE_CONVERSATION_MAILTO,
  HOSTILE_CONVERSATION_UPPERCASE_SCHEME,
  HOSTILE_CONVERSATION_BARE_WWW,
  HOSTILE_CONVERSATION_EMAIL,
  HOSTILE_CONVERSATION_MENTION
] as const;

export function hostileConversationControlSurvives(rendered: string, rawControl: string): boolean {
  if (rawControl.startsWith("# ")) {
    const escaped = rawControl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\\\])${escaped}`).test(rendered);
  }
  return rendered.includes(rawControl);
}

export function hostileConversationBackslashRun(
  rendered: string,
  marker: typeof HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS[number]
): number {
  const markerIndex = rendered.indexOf(marker);
  if (markerIndex < 0) {
    return -1;
  }
  const runStart = markerIndex + marker.length;
  let length = 0;
  while (rendered[runStart + length] === "\\") {
    length += 1;
  }
  return length;
}

export function hostileConversationTitleClosesEmphasis(rendered: string): boolean {
  const marker = "HOSTILE_TITLE_TRAILING_BACKSLASH";
  const markerIndex = rendered.indexOf(marker);
  if (markerIndex < 0) {
    return false;
  }
  const closingStart = markerIndex + marker.length + hostileConversationBackslashRun(rendered, marker);
  return rendered.startsWith("**", closingStart);
}

export function hostileConversationDisclosureClosesBeforeHeading(
  rendered: string,
  heading: string
): boolean {
  const summaryIndex = rendered.indexOf("<summary>Conversation context, grounding");
  const closeIndex = summaryIndex < 0 ? -1 : rendered.indexOf("\n</details>", summaryIndex);
  const headingIndex = summaryIndex < 0 ? -1 : rendered.indexOf(`\n${heading}\n`, summaryIndex);
  return summaryIndex >= 0 && closeIndex > summaryIndex && headingIndex > closeIndex;
}

export function hostileConversationAnalysis(): ConversationAnalysis {
  return {
    status: "analyzed",
    provider: "ai-sdk",
    summary: `${ORDINARY_CONVERSATION_VALUE} ${HOSTILE_CONVERSATION_RAW_CONTROLS[0]} ${HOSTILE_CONVERSATION_RAW_CONTROLS[2]} ${HOSTILE_CONVERSATION_RAW_CONTROLS[9]} ${HOSTILE_CONVERSATION_BARE_HTTPS} ${HOSTILE_CONVERSATION_BARE_HTTP} ${HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS[0]}\\`,
    intent: [{
      text: `Keep the deterministic review visible. ${HOSTILE_CONVERSATION_RAW_CONTROLS[1]} ${HOSTILE_CONVERSATION_RAW_CONTROLS[3]} ${HOSTILE_CONVERSATION_RAW_CONTROLS[10]} ${HOSTILE_CONVERSATION_BARE_WWW} ${HOSTILE_CONVERSATION_BARE_FTP} ${HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS[1]}\\`,
      event_ids: ["hostile-user-event"]
    }],
    refinements: [],
    decisions: [],
    constraints: [],
    non_goals: [],
    rejected_alternatives: [],
    claims: [],
    validation_claims: [],
    known_gaps: [],
    quality_flags: []
  };
}

export function hostileConversationInsight(path = "src/render/comment.ts"): ReviewerInsight {
  return {
    id: "CONV-HOSTILE-001",
    category: "intent_mismatch",
    title: `Hostile title ${HOSTILE_CONVERSATION_RAW_CONTROLS[4]} ${HOSTILE_CONVERSATION_MENTION} ${HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS[2]}\\`,
    summary: `Hostile summary ${HOSTILE_CONVERSATION_RAW_CONTROLS[5]} ${HOSTILE_CONVERSATION_RAW_CONTROLS[11]} ${HOSTILE_CONVERSATION_EMAIL} ${HOSTILE_CONVERSATION_UPPERCASE_SCHEME} ${HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS[3]}\\`,
    why_it_matters: `Hostile rationale ${HOSTILE_CONVERSATION_RAW_CONTROLS[6]} ${HOSTILE_CONVERSATION_MAILTO} ${HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS[4]}\\`,
    reviewer_action: `Hostile action ${HOSTILE_CONVERSATION_RAW_CONTROLS[7]} ${HOSTILE_CONVERSATION_RAW_CONTROLS[8]} ${HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS[5]}\\`,
    priority: "high",
    evidence_state: "contradicted",
    basis: "validated_anchors",
    conversation_event_ids: ["hostile-user-event"],
    paths: [path],
    requirement_ids: [],
    risk_ids: [],
    command_ids: [],
    evidence: [{
      kind: "conversation",
      event_id: "hostile-user-event",
      note: "Validated hostile-markup regression fixture citation.",
      confidence: "low",
      validation_status: "valid",
      llm_proposed: true
    }]
  };
}

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
