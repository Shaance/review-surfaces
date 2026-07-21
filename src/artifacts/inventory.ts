import { AGREEMENT_AUDIT_ARTIFACT_NAMES } from "./agreement-audit";

// Top-level files emitted by review-surfaces, plus deprecated names retained for
// self-input exclusion. Keep collection exclusion and conversation-payload
// detection on the same inventory so a current or stale generated artifact cannot
// silently become review input or methodology evidence.
export const REVIEW_SURFACES_ROOT_ARTIFACT_FILES = new Set([
  "manifest.json",
  "review_packet.json",
  "review_packet.md",
  "intent.yaml",
  "evaluation.yaml",
  "methodology.yaml",
  "risks.yaml",
  "architecture.md",
  "dogfood.yaml",
  "agent_handoff.md",
  "human_review.json",
  "human_review.md",
  "human_review.html",
  "review_queue.md",
  "review_routes.md",
  "suggested_comments.md",
  "trust_audit.md",
  "risk_lenses.md",
  "intent_mismatch.md",
  "evidence_cards.md",
  "since_last_review.md",
  "test_plan.md",
  "comment.md",
  "review.sarif",
  "pending_review.json",
  "pr_review_surface.json",
  "eval_scoreboard.json",
  ...AGREEMENT_AUDIT_ARTIFACT_NAMES
]);

const REVIEW_SURFACES_ARTIFACT_NAME_PATTERN = new RegExp(
  [...REVIEW_SURFACES_ROOT_ARTIFACT_FILES]
    .sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")
);

export function findReviewSurfacesArtifactName(value: string): { name: string; index: number } | undefined {
  const match = REVIEW_SURFACES_ARTIFACT_NAME_PATTERN.exec(value);
  return match ? { name: match[0], index: match.index } : undefined;
}
