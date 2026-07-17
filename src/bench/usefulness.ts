export interface UsefulnessJudgment {
  path: string;
  title?: string;
  body_contains?: string;
  actionable: boolean;
}

export interface ReviewerUsefulnessExpectations {
  findings?: UsefulnessJudgment[];
  comments?: UsefulnessJudgment[];
  max_first_action_line?: number;
  max_primary_surface_lines?: number;
  max_duplicate_root_causes?: number;
  reviewer_value_rating?: number;
  minimum_reviewer_value_rating?: number;
}

interface QueueLike { path?: string; title?: string }
interface CommentLike { path?: string; title?: string; body?: string }
interface DecisionLike { root_cause?: string }
interface HumanReviewLike {
  review_queue?: QueueLike[];
  suggested_comments?: CommentLike[];
  decision_projection?: { findings?: DecisionLike[] };
}

export interface ReviewerUsefulnessScore {
  judged_findings: number;
  actionable_findings: number;
  mechanical_findings: number;
  missing_actionable_findings: number;
  finding_precision: number | null;
  judged_comments: number;
  postable_comments: number;
  mechanical_comments: number;
  missing_postable_comments: number;
  comment_precision: number | null;
  duplicate_root_causes: number;
  first_action_line: number | null;
  primary_surface_lines: number | null;
  reviewer_value_rating: number | null;
  failures: string[];
}

export function scoreReviewerUsefulness(
  model: HumanReviewLike,
  markdown: string,
  expectations: ReviewerUsefulnessExpectations = {}
): ReviewerUsefulnessScore {
  const findingEvaluation = evaluateJudgments(model.review_queue ?? [], expectations.findings ?? []);
  const commentEvaluation = evaluateJudgments(model.suggested_comments ?? [], expectations.comments ?? []);
  const findingMatches = findingEvaluation.matches;
  const commentMatches = commentEvaluation.matches;
  const actionableFindings = findingMatches.filter((entry) => entry.actionable).length;
  const mechanicalFindings = findingMatches.length - actionableFindings;
  const postableComments = commentMatches.filter((entry) => entry.actionable).length;
  const mechanicalComments = commentMatches.length - postableComments;
  const roots = (model.decision_projection?.findings ?? [])
    .map((finding) => finding.root_cause)
    .filter((root): root is string => Boolean(root));
  const duplicateRootCauses = roots.length - new Set(roots).size;
  const markdownLines = markdown.split("\n");
  const firstActionLine = lineOfFirstAction(markdownLines);
  const primarySurfaceLines = lineOfFirstSupportingSection(markdownLines);
  const rawRating = finiteNumber(expectations.reviewer_value_rating);
  const rating = rawRating !== null && rawRating >= 1 && rawRating <= 5 ? rawRating : null;
  const failures: string[] = [];
  if (mechanicalFindings > 0) failures.push(`${mechanicalFindings} curated mechanical finding(s) reached the review queue`);
  if (findingEvaluation.missingActionable > 0) failures.push(`${findingEvaluation.missingActionable} curated actionable finding(s) were missing from the review queue`);
  if (mechanicalComments > 0) failures.push(`${mechanicalComments} curated non-postable comment(s) were suggested`);
  if (commentEvaluation.missingActionable > 0) failures.push(`${commentEvaluation.missingActionable} curated postable comment(s) were missing`);
  if (expectations.max_duplicate_root_causes !== undefined && duplicateRootCauses > expectations.max_duplicate_root_causes) {
    failures.push(`${duplicateRootCauses} duplicate decision root cause(s)`);
  }
  if (expectations.max_first_action_line !== undefined && (firstActionLine === null || firstActionLine > expectations.max_first_action_line)) {
    failures.push(`first concrete action line ${firstActionLine ?? "missing"} exceeds ${expectations.max_first_action_line}`);
  }
  if (expectations.max_primary_surface_lines !== undefined && (primarySurfaceLines === null || primarySurfaceLines > expectations.max_primary_surface_lines)) {
    failures.push(`primary surface line ${primarySurfaceLines ?? "missing"} exceeds ${expectations.max_primary_surface_lines}`);
  }
  if (rawRating !== null && rating === null) failures.push(`manual reviewer-value rating ${rawRating} is outside the 1–5 range`);
  if (expectations.minimum_reviewer_value_rating !== undefined && (rating === null || rating < expectations.minimum_reviewer_value_rating)) {
    failures.push(`manual reviewer-value rating ${rating ?? "missing"} is below ${expectations.minimum_reviewer_value_rating}`);
  }
  return {
    judged_findings: findingMatches.length,
    actionable_findings: actionableFindings,
    mechanical_findings: mechanicalFindings,
    missing_actionable_findings: findingEvaluation.missingActionable,
    finding_precision: ratio(actionableFindings, findingMatches.length),
    judged_comments: commentMatches.length,
    postable_comments: postableComments,
    mechanical_comments: mechanicalComments,
    missing_postable_comments: commentEvaluation.missingActionable,
    comment_precision: ratio(postableComments, commentMatches.length),
    duplicate_root_causes: duplicateRootCauses,
    first_action_line: firstActionLine,
    primary_surface_lines: primarySurfaceLines,
    reviewer_value_rating: rating,
    failures
  };
}

function evaluateJudgments(
  actual: Array<QueueLike | CommentLike>,
  judgments: UsefulnessJudgment[]
): { matches: UsefulnessJudgment[]; missingActionable: number } {
  const available = new Set(judgments.map((_, index) => index));
  const matches: UsefulnessJudgment[] = [];
  for (const item of actual) {
    const matchIndex = judgments.findIndex((judgment, index) => available.has(index) &&
      judgment.path === (item.path ?? "") &&
      (judgment.title === undefined || judgment.title === item.title) &&
      (judgment.body_contains === undefined || ("body" in item && item.body?.includes(judgment.body_contains)))
    );
    if (matchIndex >= 0) {
      available.delete(matchIndex);
      matches.push(judgments[matchIndex]);
    }
  }
  return {
    matches,
    missingActionable: [...available].filter((index) => judgments[index].actionable).length
  };
}

function lineOfFirstAction(lines: readonly string[]): number | null {
  const index = lines.findIndex((line) => /^\s*(?:-\s+)?(?:Action|Review):/u.test(line));
  return index < 0 ? null : index + 1;
}

function lineOfFirstSupportingSection(lines: readonly string[]): number | null {
  const index = lines.findIndex((line) => line === "## Supporting review queue" || line === "## Reading order");
  return index < 0 ? null : index + 1;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
