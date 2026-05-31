import { compareStrings } from "../core/compare";
import { stripUndefined } from "../core/guards";
import { EvidenceRef, fileEvidence, missingEvidence } from "../evidence/evidence";
import type { CollectionResult } from "../collector/collect";
import type {
  PrRiskCandidate,
  PrRiskModel,
  PrRiskRule,
  PrScopeModel,
  PrScopedCoverageModel,
  ScopedChangedFile,
  StructuredDiff
} from "../pr/contract";
import { PR_RISK_RULES } from "../pr/contract";
import type { PacketRiskCategory, PacketSeverity } from "../schema/review-packet-contract";

// ---------------------------------------------------------------------------
// Deterministic PR risk candidates (review-surfaces.pr_surface.v1 / RISK.*).
//
// A diff-scoped companion to the whole-repo risk register: every candidate here
// is produced purely from PR FACTS (scope, coverage delta, structured diff,
// optional parsed test totals). Each rule fires ONLY when its trigger is present,
// cites the concrete changed file paths / requirement ids that justify it, and
// never restates whole-spec partial counts. Output is byte-stable: candidates are
// emitted in PR_RISK_RULES priority order, ties broken by path via compareStrings,
// and ids are assigned LAST as zero-padded PR-RISK-00N. No clocks, no randomness.
// ---------------------------------------------------------------------------

export interface BuildPrRiskInput {
  scope: PrScopeModel;
  coverage: PrScopedCoverageModel;
  diff: StructuredDiff;
  testResults?: CollectionResult["testResults"];
  config?: { largeDiffFileCap?: number; largeDiffLineCap?: number };
}

const DEFAULT_LARGE_DIFF_FILE_CAP = 40;
const DEFAULT_LARGE_DIFF_LINE_CAP = 1500;

// A pre-id candidate carries its sort key (rule priority + path) so the final
// PR-RISK-00N numbering follows the documented order without re-sorting evidence.
interface DraftCandidate {
  rule: PrRiskRule;
  category: PacketRiskCategory;
  severity: PacketSeverity;
  summary: string;
  evidence: EvidenceRef[];
  suggested_checks: string[];
  // Lowest changed path the candidate cites, used only as a deterministic
  // tie-breaker between two candidates of the SAME rule. Empty string sorts first.
  sortPath: string;
}

// Priority index of a rule in the locked PR_RISK_RULES order. Drives both the
// emit order and the id numbering, so the contract's declared order is the single
// source of truth (no parallel hand-maintained priority list to drift).
const RULE_PRIORITY = new Map<PrRiskRule, number>(PR_RISK_RULES.map((rule, index) => [rule, index]));

export function buildPrRiskCandidates(input: BuildPrRiskInput): PrRiskModel {
  const drafts: DraftCandidate[] = [];

  pushCoverageRegression(drafts, input);
  pushUntestedChangedImpl(drafts, input);
  pushUnmappedChange(drafts, input);
  pushPrivacySensitiveChange(drafts, input);
  pushCommentSurfaceChange(drafts, input);
  pushCiSecretBoundaryChange(drafts, input);
  pushSchemaContractChange(drafts, input);
  pushDeletedOrRenamedSurface(drafts, input);
  pushFailedOrSkippedTest(drafts, input);
  pushLargeDiff(drafts, input);

  drafts.sort(
    (left, right) =>
      (RULE_PRIORITY.get(left.rule) ?? 0) - (RULE_PRIORITY.get(right.rule) ?? 0) ||
      compareStrings(left.sortPath, right.sortPath)
  );

  const candidates: PrRiskCandidate[] = drafts.map((draft, index) =>
    stripUndefined({
      id: `PR-RISK-${String(index + 1).padStart(3, "0")}`,
      rule: draft.rule,
      category: draft.category,
      severity: draft.severity,
      summary: draft.summary,
      evidence: draft.evidence,
      suggested_checks: draft.suggested_checks
    })
  );

  return { summary: summarize(candidates), candidates };
}

// --- Rule: coverage_regression (testing, high) -----------------------------
// Any requirement whose scoped coverage delta is "regressed". Cites the
// requirement's REAL evidence refs (head/missing evidence carry actual file
// paths), so the risk anchors to a clickable source and the change diagram can
// wire it to a real file. Falls back to an acai_id-only spec ref (no fabricated
// path) when the delta carries no path-bearing evidence.
function pushCoverageRegression(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const regressed = input.coverage.deltas.filter((delta) => delta.delta === "regressed");
  if (regressed.length === 0) {
    return;
  }
  const ordered = [...regressed].sort((left, right) =>
    compareStrings(left.requirement_id, right.requirement_id)
  );
  const ids = ordered.map((delta) => delta.requirement_id);
  drafts.push({
    rule: "coverage_regression",
    category: "testing",
    severity: "high",
    summary: `Coverage regressed for ${ordered.length} requirement(s): ${ids.join(", ")}.`,
    evidence: ordered.flatMap((delta) => {
      const realRefs = [...delta.missing_evidence, ...delta.head_evidence].filter((ref) => ref.path !== undefined).slice(0, 2);
      if (realRefs.length > 0) {
        return realRefs;
      }
      // No path-bearing evidence: anchor by requirement acai_id only — never the
      // requirement title, which is not a path.
      const acaiId = delta.acai_id ?? delta.requirement_id;
      return [{ kind: "spec" as const, acai_id: acaiId, note: `Coverage regressed (${delta.base_status} -> ${delta.head_status}).`, confidence: "high" as const, validation_status: "valid" as const }];
    }),
    suggested_checks: [
      "Restore or add tests for the regressed requirement(s) before merge.",
      "Confirm the coverage delta is intended and not an accidental test deletion."
    ],
    sortPath: ids[0] ?? ""
  });
}

// --- Rule: untested_changed_impl (testing, medium) -------------------------
// An implementation-role changed file whose review area has NO changed test file
// in scope. Cites the impl file. One candidate per such file (id/path ordered).
function pushUntestedChangedImpl(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const changed = input.scope.changed_files;
  // Areas that received at least one changed TEST file in this PR.
  const testedAreas = new Set<string>();
  for (const file of changed) {
    if (file.role === "test") {
      for (const area of file.areas) {
        testedAreas.add(area);
      }
    }
  }
  const untested = changed
    .filter((file) => file.role === "implementation" && !hasTestedArea(file, testedAreas))
    .sort((left, right) => compareStrings(left.path, right.path));
  for (const file of untested) {
    drafts.push({
      rule: "untested_changed_impl",
      category: "testing",
      severity: "medium",
      summary: `Implementation file ${file.path} changed with no changed test in its review area.`,
      evidence: [fileEvidence(file.path, "Changed implementation file; no co-changed test in its area.")],
      suggested_checks: [
        `Add or update a test covering the change to ${file.path}.`,
        "Confirm existing tests exercise the new behavior."
      ],
      sortPath: file.path
    });
  }
}

// An impl file is "tested" when it has no area at all (cannot judge), or when at
// least one of its areas saw a changed test. A file with areas but none tested is
// the untested case.
function hasTestedArea(file: ScopedChangedFile, testedAreas: Set<string>): boolean {
  if (file.areas.length === 0) {
    // No mapped area: not attributable to an untested area gap here.
    return true;
  }
  return file.areas.some((area) => testedAreas.has(area));
}

// --- Rule: unmapped_change (workflow, low) ---------------------------------
// scope.out_of_scope_changed_files is non-empty. Cites those files.
function pushUnmappedChange(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const files = input.scope.out_of_scope_changed_files;
  if (files.length === 0) {
    return;
  }
  const ordered = [...files].sort((left, right) => compareStrings(left.path, right.path));
  drafts.push({
    rule: "unmapped_change",
    category: "workflow",
    severity: "low",
    summary: `${ordered.length} changed file(s) did not map to any review area or requirement.`,
    evidence: ordered.map((file) => fileEvidence(file.path, `Out-of-scope changed file (${file.reason}).`)),
    suggested_checks: [
      "Confirm the unmapped change is intended and not missing a review-area mapping.",
      "Map the file to an area/requirement if it carries reviewable behavior."
    ],
    sortPath: ordered[0]?.path ?? ""
  });
}

// --- Rule: privacy_sensitive_change (privacy, high) ------------------------
// A changed file path matches src/privacy/, secrets, token, redact, or provider.
function pushPrivacySensitiveChange(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const matched = matchingChangedPaths(input, (path) => {
    const lower = path.toLowerCase();
    return (
      lower.includes("src/privacy/") ||
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("redact") ||
      lower.includes("provider")
    );
  });
  if (matched.length === 0) {
    return;
  }
  drafts.push({
    rule: "privacy_sensitive_change",
    category: "privacy",
    severity: "high",
    summary: `${matched.length} changed file(s) touch privacy-sensitive surfaces (secrets/tokens/redaction/providers).`,
    evidence: matched.map((path) => fileEvidence(path, "Privacy-sensitive changed file.")),
    suggested_checks: [
      "Verify no secrets, tokens, or unredacted sensitive data are introduced.",
      "Confirm redaction and provider-boundary handling still holds."
    ],
    sortPath: matched[0] ?? ""
  });
}

// --- Rule: comment_surface_change (review_value, medium) -------------------
// review_value is not a PacketRiskCategory; map to "maintainability" for the
// schema-valid category while keeping the rule name authoritative. Matches the
// actual review-comment render surface: src/render/ (where the risk/evaluation
// summarization lives), the comment renderers, and the diagram builders. The
// bare tokens "risk"/"evaluation"/"summar" were intentionally dropped — they
// matched non-render files like src/risks/ and src/evaluation/ as false positives.
function pushCommentSurfaceChange(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const matched = matchingChangedPaths(input, (path) => {
    const lower = path.toLowerCase();
    return (
      lower.includes("src/render/") ||
      lower.includes("comment") ||
      lower.includes("diagram")
    );
  });
  if (matched.length === 0) {
    return;
  }
  drafts.push({
    rule: "comment_surface_change",
    category: "maintainability",
    severity: "medium",
    summary: `${matched.length} changed file(s) affect the review comment surface (render/comment/diagram/summarization).`,
    evidence: matched.map((path) => fileEvidence(path, "Review comment surface changed file.")),
    suggested_checks: [
      "Re-render the review comment and confirm output is correct and byte-stable.",
      "Check that the rendered surface still cites evidence faithfully."
    ],
    sortPath: matched[0] ?? ""
  });
}

// --- Rule: ci_secret_boundary_change (security, high) ----------------------
// A changed file matches .github/, src/llm/provider, post-comment, or token/api
// key handling.
function pushCiSecretBoundaryChange(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const matched = matchingChangedPaths(input, (path) => {
    const lower = path.toLowerCase();
    return (
      lower.includes(".github/") ||
      lower.includes("src/llm/provider") ||
      lower.includes("post-comment") ||
      lower.includes("postcomment") ||
      lower.includes("api-key") ||
      lower.includes("apikey") ||
      lower.includes("api_key")
    );
  });
  if (matched.length === 0) {
    return;
  }
  drafts.push({
    rule: "ci_secret_boundary_change",
    category: "security",
    severity: "high",
    summary: `${matched.length} changed file(s) touch the CI / secret boundary (workflows, provider, comment posting).`,
    evidence: matched.map((path) => fileEvidence(path, "CI / secret-boundary changed file.")),
    suggested_checks: [
      "Verify no secret/token is exposed in CI workflow or provider changes.",
      "Confirm permissions and the comment-posting boundary are unchanged or tightened."
    ],
    sortPath: matched[0] ?? ""
  });
}

// --- Rule: schema_contract_change (architecture, medium) -------------------
// "compatibility" is not a PacketRiskCategory; use "architecture". A changed file
// matches schemas/, review-packet-contract, or render/load.
function pushSchemaContractChange(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const matched = matchingChangedPaths(input, (path) => {
    const lower = path.toLowerCase();
    return (
      lower.includes("schemas/") ||
      lower.includes("review-packet-contract") ||
      lower.includes("render/load")
    );
  });
  if (matched.length === 0) {
    return;
  }
  drafts.push({
    rule: "schema_contract_change",
    category: "architecture",
    severity: "medium",
    summary: `${matched.length} changed file(s) modify a schema / contract surface (schemas, packet contract, render load).`,
    evidence: matched.map((path) => fileEvidence(path, "Schema / contract changed file.")),
    suggested_checks: [
      "Confirm the schema/contract change is backward compatible or versioned.",
      "Re-validate existing artifacts load against the changed contract."
    ],
    sortPath: matched[0] ?? ""
  });
}

// --- Rule: deleted_or_renamed_surface (maintainability, low) ---------------
// scope.changed_files whose status starts with 'D' or 'R' in impl/test roles.
function pushDeletedOrRenamedSurface(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const affected = input.scope.changed_files
    .filter(
      (file) =>
        (file.role === "implementation" || file.role === "test") &&
        (file.status.startsWith("D") || file.status.startsWith("R"))
    )
    .sort((left, right) => compareStrings(left.path, right.path));
  if (affected.length === 0) {
    return;
  }
  drafts.push({
    rule: "deleted_or_renamed_surface",
    category: "maintainability",
    severity: "low",
    summary: `${affected.length} implementation/test file(s) were deleted or renamed.`,
    evidence: affected.map((file) =>
      fileEvidence(file.path, `${file.status.startsWith("D") ? "Deleted" : "Renamed"} ${file.role} surface.`)
    ),
    suggested_checks: [
      "Confirm deleted/renamed surfaces have no remaining references.",
      "Verify removed behavior was intentionally dropped and not regressed."
    ],
    sortPath: affected[0]?.path ?? ""
  });
}

// --- Rule: failed_or_skipped_test (testing, high) --------------------------
// testResults totals show failed>0 or skipped>0.
function pushFailedOrSkippedTest(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const totals = input.testResults?.totals;
  if (!totals || (totals.failed <= 0 && totals.skipped <= 0)) {
    return;
  }
  const parts: string[] = [];
  if (totals.failed > 0) {
    parts.push(`${totals.failed} failed`);
  }
  if (totals.skipped > 0) {
    parts.push(`${totals.skipped} skipped`);
  }
  drafts.push({
    rule: "failed_or_skipped_test",
    category: "testing",
    severity: "high",
    summary: `Parsed test results report ${parts.join(" and ")} test case(s).`,
    evidence: [missingEvidence(`Test totals: ${parts.join(", ")} out of ${totals.cases} case(s).`)],
    suggested_checks: [
      "Investigate and fix failing tests before merge.",
      "Confirm skipped tests are intentional, not silently disabled coverage."
    ],
    // No path to cite; sorts first within its (singleton) rule group.
    sortPath: ""
  });
}

// --- Rule: large_diff (maintainability, low) -------------------------------
// changed_files.length > fileCap OR total added+deleted lines > lineCap.
function pushLargeDiff(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const fileCap = input.config?.largeDiffFileCap ?? DEFAULT_LARGE_DIFF_FILE_CAP;
  const lineCap = input.config?.largeDiffLineCap ?? DEFAULT_LARGE_DIFF_LINE_CAP;
  const fileCount = input.scope.changed_files.length;
  const lineCount = input.scope.changed_files.reduce(
    (sum, file) => sum + (file.added_lines ?? 0) + (file.deleted_lines ?? 0),
    0
  );
  const overFiles = fileCount > fileCap;
  const overLines = lineCount > lineCap;
  if (!overFiles && !overLines) {
    return;
  }
  const reasons: string[] = [];
  if (overFiles) {
    reasons.push(`${fileCount} changed files (> ${fileCap})`);
  }
  if (overLines) {
    reasons.push(`${lineCount} changed lines (> ${lineCap})`);
  }
  drafts.push({
    rule: "large_diff",
    category: "maintainability",
    severity: "low",
    summary: `Large diff: ${reasons.join(" and ")}.`,
    evidence: [missingEvidence(`Diff size: ${fileCount} file(s), ${lineCount} added+deleted line(s).`)],
    suggested_checks: [
      "Consider splitting the change into smaller reviewable units.",
      "Allocate extra review time proportional to the diff size."
    ],
    sortPath: ""
  });
}

// Distinct changed paths (scope changed_files) whose path satisfies the predicate,
// sorted by compareStrings for deterministic ordering and evidence.
function matchingChangedPaths(input: BuildPrRiskInput, predicate: (path: string) => boolean): string[] {
  const matched = new Set<string>();
  for (const file of input.scope.changed_files) {
    if (predicate(file.path)) {
      matched.add(file.path);
    }
  }
  return [...matched].sort(compareStrings);
}

// Model-level summary: a deterministic 'summary'-level count of candidates by
// severity. Never restates whole-spec partial counts — only this PR's candidates.
function summarize(candidates: PrRiskCandidate[]): string {
  if (candidates.length === 0) {
    return "No PR risk candidates.";
  }
  const order: PacketSeverity[] = ["critical", "high", "medium", "low", "unknown"];
  const counts = new Map<PacketSeverity, number>();
  for (const candidate of candidates) {
    counts.set(candidate.severity, (counts.get(candidate.severity) ?? 0) + 1);
  }
  const parts = order
    .filter((severity) => (counts.get(severity) ?? 0) > 0)
    .map((severity) => `${counts.get(severity)} ${severity}`);
  return `${candidates.length} PR risk candidate(s): ${parts.join(", ")}.`;
}
