import { compareStrings } from "../core/compare";
import { commandLooksLikeBroadTestCommand, commandLooksLikeFocusedTestCommand, commandLooksLikeTestCommand } from "../commands/classify";
import { stripUndefined } from "../core/guards";
import { EvidenceRef, fileEvidence, missingEvidence } from "../evidence/evidence";

import type { CollectionResult } from "../collector/collect";
import type { ChangedFile } from "../collector/git";
import type {
  PrRiskCandidate,
  PrRiskModel,
  PrRiskRule,
  PrScopeModel,
  PrScopedCoverageModel,
  ScopedChangedFile
} from "../pr/contract";
import { prRiskRulePriority } from "../pr/risk-metadata";
import type { ReviewArea } from "../review-areas/areas";
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
  // review-surfaces.COLD_START.5: spec-less repos never get asked to map files
  // to requirements; the unmapped-change rule speaks in review areas only.
  specMode?: "acai" | "none";
  scope: PrScopeModel;
  // Collection-time per-file blocked-secret findings computed from the RAW
  // diff's ADDED lines (path + line + kinds, never the secret text). Computed
  // before redaction, so a literal [REDACTED:...] placeholder typed by the
  // author can never appear here, and a deleted/rotated old secret (a removed
  // line) is never attributed to this change.
  secretFindings?: Array<{ path: string; line?: number; kinds: string[] }>;
  coverage: PrScopedCoverageModel;
  testResults?: CollectionResult["testResults"];
  commandTranscripts?: CollectionResult["commandTranscripts"];
  changedFileSources?: Record<string, ChangedFile["source"]>;
  reviewAreas?: ReviewArea[];
  config?: { largeDiffFileCap?: number; largeDiffLineCap?: number };
}

const DEFAULT_LARGE_DIFF_FILE_CAP = 40;
const DEFAULT_LARGE_DIFF_LINE_CAP = 1500;
const MAX_RULE_EVIDENCE = 12;
const MAX_PER_FILE_CANDIDATES = 12;

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

export function buildPrRiskCandidates(input: BuildPrRiskInput): PrRiskModel {
  const drafts: DraftCandidate[] = [];

  pushCoverageRegression(drafts, input);
  pushUntestedChangedImpl(drafts, input);
  pushUnmappedChange(drafts, input);
  pushPrivacySensitiveChange(drafts, input);
  pushSecretInDiff(drafts, input);
  pushCommentSurfaceChange(drafts, input);
  pushCiSecretBoundaryChange(drafts, input);
  pushSchemaContractChange(drafts, input);
  pushDeletedOrRenamedSurface(drafts, input);
  pushFailedOrSkippedTest(drafts, input);
  pushLargeDiff(drafts, input);

  drafts.sort(
    (left, right) =>
      prRiskRulePriority(left.rule) - prRiskRulePriority(right.rule) ||
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
  const displayedIds = ids.slice(0, MAX_RULE_EVIDENCE);
  const omittedIds = ids.length - displayedIds.length;
  drafts.push({
    rule: "coverage_regression",
    category: "testing",
    severity: "high",
    summary: `Coverage regressed for ${ordered.length} requirement(s): ${displayedIds.join(", ")}${omittedIds > 0 ? `, ... ${omittedIds} more` : ""}.`,
    evidence: ordered.flatMap((delta) => {
      const realRefs = [...delta.missing_evidence, ...delta.head_evidence].filter((ref) => ref.path !== undefined).slice(0, 2);
      if (realRefs.length > 0) {
        return realRefs;
      }
      // No path-bearing evidence: anchor by requirement acai_id only — never the
      // requirement title, which is not a path.
      const acaiId = delta.acai_id ?? delta.requirement_id;
      return [{ kind: "spec" as const, acai_id: acaiId, note: `Coverage regressed (${delta.base_status} -> ${delta.head_status}).`, confidence: "high" as const, validation_status: "valid" as const }];
    }).slice(0, MAX_RULE_EVIDENCE),
    suggested_checks: [
      "Restore or add tests for the regressed requirement(s) before merge.",
      "Confirm the coverage delta is intended and not an accidental test deletion."
    ],
    sortPath: ids[0] ?? ""
  });
}

// --- Rule: secret_in_diff (security, critical) ------------------------------
// Consumes the collection-time raw-diff scan (path + first line + pattern
// kinds). The summary cites the file and pattern KIND only — the secret text
// never enters any artifact.
function pushSecretInDiff(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  for (const finding of input.secretFindings ?? []) {
    const kindList = finding.kinds.join(", ");
    drafts.push({
      rule: "secret_in_diff",
      category: "security",
      severity: "critical",
      summary: `Added line(s) in ${finding.path} match high-confidence secret pattern(s): ${kindList}. The committed value must be treated as leaked.`,
      evidence: [
        stripUndefined({
          kind: "file" as const,
          path: finding.path,
          line_start: finding.line,
          note: `Added line matches secret pattern(s): ${kindList}.`,
          confidence: "high" as const
        }) as EvidenceRef
      ],
      suggested_checks: [
        "Remove the secret from the change and rotate the credential — committed secrets must be treated as compromised.",
        "Move the value to an environment variable or secret store before merge."
      ],
      sortPath: finding.path
    });
  }
}

// --- Rule: untested_changed_impl (testing, medium) -------------------------
// An implementation-role changed file whose review area has no changed test file
// and no current-head command transcript in scope. Cites the impl file. One
// candidate per such file (id/path ordered).
function pushUntestedChangedImpl(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const changed = input.scope.changed_files;
  const validation = buildImplementationValidationIndex(input);
  const untested = changed
    .filter((file) => file.role === "implementation" && !hasImplementationValidation(file, validation))
    .sort((left, right) => compareStrings(left.path, right.path));
  for (const file of untested.slice(0, MAX_PER_FILE_CANDIDATES)) {
    drafts.push({
      rule: "untested_changed_impl",
      category: "testing",
      severity: "medium",
      summary: `Implementation file ${file.path} changed with no changed test or current-head command transcript in its review area.`,
      evidence: [
        fileEvidence(file.path, "Changed implementation file; no co-changed test or current-head passing test transcript mapped to its area."),
        missingEvidence(`No changed test or current-head passing test transcript mapped to ${areaListForMessage(file)}.`)
      ],
      suggested_checks: [
        `Add or update a test covering the change to ${file.path}.`,
        "Record a current-head focused or broad test transcript if existing tests exercise the new behavior."
      ],
      sortPath: file.path
    });
  }
  if (untested.length > MAX_PER_FILE_CANDIDATES) {
    const omitted = untested.length - MAX_PER_FILE_CANDIDATES;
    const firstOmitted = untested[MAX_PER_FILE_CANDIDATES];
    drafts.push({
      rule: "untested_changed_impl",
      category: "testing",
      severity: "medium",
      summary: `${omitted} additional implementation file(s) changed with no changed test or current-head command transcript in their review area.`,
      evidence: evidenceForPaths(
        untested.slice(MAX_PER_FILE_CANDIDATES).map((file) => file.path),
        "Additional implementation file without changed test or current-head command transcript."
      ),
      suggested_checks: [
        "Add or update tests for the additional untested implementation changes.",
        "Record current-head focused or broad test transcripts if existing tests exercise the new behavior."
      ],
      sortPath: firstOmitted?.path ?? ""
    });
  }
}

interface ImplementationValidationIndex {
  changedTestAreas: Set<string>;
  workingTreeChangedTestAreas: Set<string>;
  focusedTranscriptAreas: Set<string>;
  hasBroadCurrentHeadTestTranscript: boolean;
  sourceByPath: Record<string, ChangedFile["source"]>;
}

function buildImplementationValidationIndex(input: BuildPrRiskInput): ImplementationValidationIndex {
  const sourceByPath = input.changedFileSources ?? {};
  const changedTestAreas = new Set<string>();
  const workingTreeChangedTestAreas = new Set<string>();
  for (const file of input.scope.changed_files) {
    if (file.role !== "test") {
      continue;
    }
    for (const area of file.areas) {
      changedTestAreas.add(area);
      if (changedFileSourceFromMap(file, sourceByPath) !== "diff") {
        workingTreeChangedTestAreas.add(area);
      }
    }
  }

  const allAreas = uniqueAreas(input.scope.changed_files);
  const keywordByArea = areaKeywordIndex(allAreas, input.reviewAreas ?? []);

  const focusedTranscriptAreas = new Set<string>();
  let hasBroadCurrentHeadTestTranscript = false;
  for (const transcript of input.commandTranscripts ?? []) {
    if (!currentHeadPassingTestTranscript(transcript, input.scope.head_sha)) {
      continue;
    }
    if (commandLooksLikeBroadTestCommand(transcript.command)) {
      hasBroadCurrentHeadTestTranscript = true;
      continue;
    }
    if (!commandLooksLikeFocusedTestCommand(transcript.command)) {
      continue;
    }
    for (const area of matchingAreasForText(transcript.command, keywordByArea)) {
      focusedTranscriptAreas.add(area);
    }
  }

  return {
    changedTestAreas,
    workingTreeChangedTestAreas,
    focusedTranscriptAreas,
    hasBroadCurrentHeadTestTranscript,
    sourceByPath
  };
}

function currentHeadPassingTestTranscript(
  transcript: NonNullable<BuildPrRiskInput["commandTranscripts"]>[number],
  headSha: string
): boolean {
  return (
    headSha !== "unknown" &&
    transcript.head_sha === headSha &&
    transcript.status === "passed" &&
    transcript.exit_code === 0 &&
    commandLooksLikeTestCommand(transcript.command)
  );
}

// An impl file is "tested" when it has no area at all (cannot judge), when at
// least one of its areas has a changed test or current-head focused transcript,
// or when a broad current-head test transcript proves the committed suite ran
// after the change.
function hasImplementationValidation(file: ScopedChangedFile, validation: ImplementationValidationIndex): boolean {
  if (file.areas.length === 0) {
    // No mapped area: not attributable to an untested area gap here.
    return true;
  }
  const source = changedFileSource(file, validation);
  if (file.areas.some((area) => validation.changedTestAreas.has(area))) {
    return source === "diff" || file.areas.some((area) => validation.workingTreeChangedTestAreas.has(area));
  }
  if (source !== "diff") {
    return false;
  }
  if (validation.hasBroadCurrentHeadTestTranscript) {
    return true;
  }
  return file.areas.some((area) => validation.focusedTranscriptAreas.has(area));
}

function changedFileSource(file: ScopedChangedFile, validation: ImplementationValidationIndex): ChangedFile["source"] {
  return changedFileSourceFromMap(file, validation.sourceByPath);
}

function changedFileSourceFromMap(file: ScopedChangedFile, sourceByPath: Record<string, ChangedFile["source"]>): ChangedFile["source"] {
  return sourceByPath[file.path] ?? "diff";
}

function uniqueAreas(files: ScopedChangedFile[]): string[] {
  return [...new Set(files.flatMap((file) => file.areas))].sort(compareStrings);
}

function matchingAreasForText(text: string, keywordByArea: Map<string, string[]>): string[] {
  const tokens = tokenizeSearchText(text);
  return [...keywordByArea.entries()]
    .filter(([, keywords]) => keywords.some((keyword) => keywordMatchesTokens(keyword, tokens)))
    .map(([area]) => area);
}

function areaKeywordIndex(areas: string[], reviewAreas: ReviewArea[]): Map<string, string[]> {
  return new Map(
    areas.map((area) => [
      area,
      areaKeywords(area, reviewAreas)
        .map(normalizeSearchText)
        .filter((keyword) => keyword.length > 0)
    ])
  );
}

function areaKeywords(area: string, reviewAreas: ReviewArea[]): string[] {
  const keywords = new Set<string>([area]);
  for (const reviewArea of reviewAreas) {
    if (reviewArea.groupKey !== area) {
      continue;
    }
    keywords.add(reviewArea.id);
    keywords.add(reviewArea.name);
    for (const prefix of reviewArea.prefixes) {
      keywords.add(prefix);
    }
    for (const keyword of reviewArea.testKeywords) {
      keywords.add(keyword);
    }
  }
  return [...keywords];
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenizeSearchText(value: string): Set<string> {
  return new Set(normalizeSearchText(value).split(" ").filter(Boolean));
}

function keywordMatchesTokens(keyword: string, tokens: Set<string>): boolean {
  const keywordTokens = keyword.split(" ").filter(Boolean);
  return keywordTokens.length > 0 && keywordTokens.every((token) => tokenMatches(token, tokens));
}

function tokenMatches(token: string, tokens: Set<string>): boolean {
  if (tokens.has(token)) {
    return true;
  }
  if (token.length <= 3) {
    return false;
  }
  if (token.endsWith("s")) {
    return tokens.has(token.slice(0, -1));
  }
  return tokens.has(`${token}s`);
}

function areaListForMessage(file: ScopedChangedFile): string {
  return file.areas.length > 0 ? file.areas.join(", ") : "an unmapped review area";
}

// --- Rule: unmapped_change (workflow, low) ---------------------------------
// scope.out_of_scope_changed_files is non-empty. Cites those files.
function pushUnmappedChange(drafts: DraftCandidate[], input: BuildPrRiskInput): void {
  const files = input.scope.out_of_scope_changed_files;
  if (files.length === 0) {
    return;
  }
  const ordered = [...files].sort((left, right) => compareStrings(left.path, right.path));
  const specless = input.specMode === "none";
  drafts.push({
    rule: "unmapped_change",
    category: "workflow",
    severity: "low",
    summary: specless
      ? `${ordered.length} changed file(s) did not map to any review area.`
      : `${ordered.length} changed file(s) did not map to any review area or requirement.`,
    evidence: ordered
      .slice(0, MAX_RULE_EVIDENCE)
      .map((file) => fileEvidence(file.path, `Out-of-scope changed file (${file.reason}).`)),
    suggested_checks: specless
      ? ["Confirm the unmapped change is intended and not missing a review-area mapping."]
      : [
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
    evidence: evidenceForPaths(matched, "Privacy-sensitive changed file."),
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
    evidence: evidenceForPaths(matched, "Review comment surface changed file."),
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
    evidence: evidenceForPaths(matched, "CI / secret-boundary changed file."),
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
    evidence: evidenceForPaths(matched, "Schema / contract changed file."),
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
    evidence: affected
      .slice(0, MAX_RULE_EVIDENCE)
      .map((file) => fileEvidence(file.path, `${file.status.startsWith("D") ? "Deleted" : "Renamed"} ${file.role} surface.`)),
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

function evidenceForPaths(paths: string[], note: string): EvidenceRef[] {
  return paths.slice(0, MAX_RULE_EVIDENCE).map((path) => fileEvidence(path, note));
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
