import { REVIEW_SEVERITIES, type ReviewSeverity } from "../contracts/review";
import {
  REVIEWER_INSIGHT_CATEGORIES,
  REVIEWER_INSIGHT_EVIDENCE_STATES,
  type ReviewerInsightCategory,
  type ReviewerInsightEvidenceState
} from "../contracts/conversation-review";

export interface ConversationReviewCandidateDiffAnchor {
  path: string;
  line_kind: "add" | "delete";
  line: number;
  contains: string;
}

export interface ConversationReviewCandidateInsight {
  root_cause_key: string;
  category: ReviewerInsightCategory;
  title: string;
  summary: string;
  why_it_matters: string;
  reviewer_action: string;
  priority: ReviewSeverity;
  evidence_state: ReviewerInsightEvidenceState;
  conversation_event_ids: string[];
  paths: string[];
  requirement_ids: string[];
  risk_ids: string[];
  command_ids: string[];
  diff_anchors: ConversationReviewCandidateDiffAnchor[];
}

export const MAX_CONVERSATION_REVIEW_PROVIDER_CANDIDATES = 8;
export const MAX_CONVERSATION_REVIEW_TEXT = 700;
export const MAX_CONVERSATION_REVIEW_TITLE = 180;
export const MAX_CONVERSATION_REVIEW_ANCHORS = 12;
export const MAX_CONVERSATION_REVIEW_DIFF_LINE_TEXT = 260;

function conversationReviewStringArraySchema(): object {
  return {
    type: "array",
    maxItems: MAX_CONVERSATION_REVIEW_ANCHORS,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 300 }
  };
}

export const CONVERSATION_REVIEW_INSIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    insights: {
      type: "array",
      maxItems: MAX_CONVERSATION_REVIEW_PROVIDER_CANDIDATES,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          root_cause_key: { type: "string", minLength: 1, maxLength: 160 },
          category: { enum: REVIEWER_INSIGHT_CATEGORIES },
          title: { type: "string", minLength: 1, maxLength: MAX_CONVERSATION_REVIEW_TITLE },
          summary: { type: "string", minLength: 1, maxLength: MAX_CONVERSATION_REVIEW_TEXT },
          why_it_matters: { type: "string", minLength: 1, maxLength: MAX_CONVERSATION_REVIEW_TEXT },
          reviewer_action: { type: "string", minLength: 1, maxLength: MAX_CONVERSATION_REVIEW_TEXT },
          priority: { enum: REVIEW_SEVERITIES },
          evidence_state: { enum: REVIEWER_INSIGHT_EVIDENCE_STATES },
          conversation_event_ids: conversationReviewStringArraySchema(),
          paths: conversationReviewStringArraySchema(),
          requirement_ids: conversationReviewStringArraySchema(),
          risk_ids: conversationReviewStringArraySchema(),
          command_ids: conversationReviewStringArraySchema(),
          diff_anchors: {
            type: "array",
            maxItems: MAX_CONVERSATION_REVIEW_ANCHORS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", minLength: 1, maxLength: 300 },
                line_kind: { enum: ["add", "delete"] },
                line: { type: "integer", minimum: 1 },
                contains: { type: "string", minLength: 4, maxLength: MAX_CONVERSATION_REVIEW_DIFF_LINE_TEXT }
              },
              required: ["path", "line_kind", "line", "contains"]
            }
          }
        },
        required: [
          "root_cause_key",
          "category",
          "title",
          "summary",
          "why_it_matters",
          "reviewer_action",
          "priority",
          "evidence_state",
          "conversation_event_ids",
          "paths",
          "requirement_ids",
          "risk_ids",
          "command_ids",
          "diff_anchors"
        ]
      }
    }
  },
  required: ["insights"]
} as const;
