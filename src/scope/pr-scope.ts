import { CollectionResult } from "../collector/collect";
import { compareStrings } from "../core/compare";
import { ACID_PATTERN, groupFromAcid } from "../evaluation/evidence-rules";
import { IntentModel, IntentRequirement } from "../intent/intent";
import { createReviewAreaMatcher, ReviewArea } from "../review-areas/areas";
import {
  ChangedFileRole,
  PrAffectedArea,
  PrAffectedRequirement,
  PrOutOfScopeChangedFile,
  PrScopeConfidence,
  PrScopeModel,
  PrScopeReason,
  PrScopeRule,
  ScopedChangedFile,
  StructuredDiff,
  StructuredDiffFile
} from "../pr/contract";

// ---------------------------------------------------------------------------
// PR diff-scoping core (review-surfaces.pr_surface.v1 / scope section).
//
// Maps a structured diff + the whole-repo intent/evaluation models onto the
// subset of requirements and review areas a PR actually touches. Pure and
// deterministic: every list is sorted with compareStrings on a stable key,
// reasons are deduped, and undefined fields are omitted from emitted objects so
// the output is byte-stable.
// ---------------------------------------------------------------------------

export interface BuildPrScopeInput {
  collection: CollectionResult;
  intent: IntentModel;
  reviewAreas: ReviewArea[];
  diff: StructuredDiff;
}

// A line range derived from a requirement's spec source_ref evidence, used by the
// spec_block_changed rule to test hunk overlap against the requirement's spec.
interface SpecSourceRange {
  path: string;
  line_start?: number;
  line_end?: number;
}

export function buildPrScope(input: BuildPrScopeInput): PrScopeModel {
  const { collection, intent, reviewAreas, diff } = input;
  const matcher = createReviewAreaMatcher(reviewAreas);

  // Index the structured diff by path so per-file hunk scans are O(1) lookups.
  const diffByPath = new Map<string, StructuredDiffFile>();
  for (const file of diff.files) {
    diffByPath.set(file.path, file);
  }

  // --- changed_files -------------------------------------------------------
  const changedFiles: ScopedChangedFile[] = collection.changedFiles.map((changedFile) => {
    const areas = matcher
      .groupsForPath(changedFile.path, { purpose: "review_surface" })
      .slice()
      .sort(compareStrings);
    const diffFile = diffByPath.get(changedFile.path);
    const counts = lineCounts(diffFile);
    const scoped: ScopedChangedFile = {
      path: changedFile.path,
      status: changedFile.status,
      areas,
      role: classifyRole(changedFile.path, areas)
    };
    // Carry the rename source so the persisted surface / prompt / deleted_or_renamed
    // risk can show what the file was renamed FROM, not just the new path.
    if (diffFile?.old_path !== undefined) {
      scoped.old_path = diffFile.old_path;
    }
    if (counts.added !== undefined) {
      scoped.added_lines = counts.added;
    }
    if (counts.deleted !== undefined) {
      scoped.deleted_lines = counts.deleted;
    }
    return scoped;
  });
  changedFiles.sort((left, right) => compareStrings(left.path, right.path));

  // --- affected_areas ------------------------------------------------------
  const areaAccumulator = new Map<
    string,
    { group_key: string; name: string; area_ids: Set<string>; changed_files: Set<string> }
  >();
  for (const changedFile of changedFiles) {
    for (const groupKey of changedFile.areas) {
      const entry = areaAccumulator.get(groupKey) ?? {
        group_key: groupKey,
        name: areaName(reviewAreas, groupKey),
        area_ids: new Set<string>(),
        changed_files: new Set<string>()
      };
      for (const area of reviewAreas) {
        if (area.groupKey === groupKey) {
          entry.area_ids.add(area.id);
        }
      }
      entry.changed_files.add(changedFile.path);
      areaAccumulator.set(groupKey, entry);
    }
  }
  const affectedAreas: PrAffectedArea[] = [...areaAccumulator.values()]
    .map((entry) => ({
      group_key: entry.group_key,
      area_ids: [...entry.area_ids].sort(compareStrings),
      name: entry.name,
      changed_files: [...entry.changed_files].sort(compareStrings)
    }))
    .sort((left, right) => compareStrings(left.group_key, right.group_key));

  // --- affected_requirements ----------------------------------------------
  // Precompute the set of group_keys touched by changed files, split into TEST
  // groups and "mapped" groups (any non-test, non-generated changed file with an
  // area — implementation, config, doc, ci, spec, …). A mapped config/doc/schema
  // file (e.g. schemas/review_packet.schema.json or review-surfaces.config.yaml)
  // usually carries no ACID literal, so without this its requirement group would
  // never enter scope and the surface would show the changed area/risk while
  // reporting zero affected requirements. These power the medium-confidence
  // "changed_path/test group" rules.
  const mappedGroups = new Set<string>();
  const testGroups = new Set<string>();
  for (const changedFile of changedFiles) {
    if (changedFile.role === "test") {
      for (const group of changedFile.areas) {
        testGroups.add(group);
      }
    } else if (changedFile.role !== "generated") {
      for (const group of changedFile.areas) {
        mappedGroups.add(group);
      }
    }
  }

  const affectedRequirements: PrAffectedRequirement[] = [];
  const acidHits = buildAcidHitIndex(changedFiles, diffByPath);
  const firstMappedByGroup = firstFilesByGroup(changedFiles, (file) => file.role !== "test" && file.role !== "generated");
  const firstTestByGroup = firstFilesByGroup(changedFiles, (file) => file.role === "test");
  for (const requirement of intent.requirements) {
    const reasons = scopeReasonsForRequirement(requirement, {
      changedFiles,
      diffByPath,
      mappedGroups,
      testGroups,
      acidHits,
      firstMappedByGroup,
      firstTestByGroup
    });
    if (reasons.length === 0) {
      continue;
    }
    const groupKey = requirementGroupKey(requirement);
    const affected: PrAffectedRequirement = {
      requirement_id: requirement.id,
      reasons
    };
    if (requirement.acai_id !== undefined) {
      affected.acai_id = requirement.acai_id;
    }
    if (requirement.title !== undefined) {
      affected.title = requirement.title;
    }
    if (groupKey !== undefined) {
      affected.group_key = groupKey;
    }
    affectedRequirements.push(affected);
  }
  affectedRequirements.sort((left, right) => compareStrings(left.requirement_id, right.requirement_id));

  // --- out_of_scope_changed_files -----------------------------------------
  const outOfScope: PrOutOfScopeChangedFile[] = changedFiles
    .filter((changedFile) => changedFile.areas.length === 0)
    .map((changedFile) => ({
      path: changedFile.path,
      status: changedFile.status,
      reason: changedFile.role === "generated" ? ("generated" as const) : ("unmapped" as const)
    }))
    .sort((left, right) => compareStrings(left.path, right.path));

  const model: PrScopeModel = {
    base_ref: collection.git.base_ref,
    head_ref: collection.git.head_ref,
    head_sha: collection.git.head_sha,
    diff_source: collection.diff_source,
    changed_files: changedFiles,
    affected_areas: affectedAreas,
    affected_requirements: affectedRequirements,
    out_of_scope_changed_files: outOfScope
  };
  if (collection.git.base_sha !== undefined) {
    model.base_sha = collection.git.base_sha;
  }
  return model;
}

// --- role classification ---------------------------------------------------

export function classifyRole(filePath: string, areas: string[]): ChangedFileRole {
  if (isGeneratedPath(filePath)) {
    return "generated";
  }
  if (filePath.startsWith(".github/")) {
    return "ci";
  }
  if (isTestPath(filePath)) {
    return "test";
  }
  if (isSpecPath(filePath)) {
    return "spec";
  }
  if (isDocPath(filePath)) {
    return "doc";
  }
  if (isConfigPath(filePath)) {
    return "config";
  }
  if (areas.length > 0) {
    return "implementation";
  }
  return "unknown";
}

function isTestPath(filePath: string): boolean {
  return filePath.startsWith("tests/") || /\.test\.[^./]+$/.test(filePath) || /\.spec\.[^./]+$/.test(filePath);
}

function isSpecPath(filePath: string): boolean {
  return filePath.startsWith("features/") && filePath.endsWith(".feature.yaml");
}

function isDocPath(filePath: string): boolean {
  return filePath.startsWith("docs/") || filePath.endsWith(".md");
}

function isConfigPath(filePath: string): boolean {
  const base = baseName(filePath);
  return (
    filePath.endsWith(".yaml") ||
    filePath.endsWith(".yml") ||
    filePath.endsWith(".json") ||
    base === "tsconfig.json" ||
    base.startsWith("tsconfig.")
  );
}

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json"
]);

function isGeneratedPath(filePath: string): boolean {
  return filePath.startsWith("dist/") || filePath.includes("/dist/") || LOCKFILES.has(baseName(filePath));
}

// --- scope rules -----------------------------------------------------------

interface ScopeContext {
  changedFiles: ScopedChangedFile[];
  diffByPath: Map<string, StructuredDiffFile>;
  // Groups touched by any non-test, non-generated mapped changed file.
  mappedGroups: Set<string>;
  testGroups: Set<string>;
  acidHits: Map<string, AcidHit[]>;
  firstMappedByGroup: Map<string, string>;
  firstTestByGroup: Map<string, string>;
}

interface AcidHit {
  path: string;
  role: ChangedFileRole;
  line?: number;
}

function scopeReasonsForRequirement(requirement: IntentRequirement, context: ScopeContext): PrScopeReason[] {
  const reasons: PrScopeReason[] = [];
  const acaiId = requirement.acai_id;
  const groupKey = requirementGroupKey(requirement);

  // exact_acid_in_diff (high) and changed_test_exact_acid (high): scan diff
  // lines (add/delete only) of changed files for the literal acai_id.
  if (acaiId) {
    for (const hit of context.acidHits.get(acaiId) ?? []) {
      const isTest = hit.role === "test";
      reasons.push(
        scopeReason(isTest ? "changed_test_exact_acid" : "exact_acid_in_diff", "high", {
          path: hit.path,
          line_start: hit.line,
          line_end: hit.line,
          note: `Changed ${isTest ? "test" : "file"} diff line references ${acaiId}.`
        })
      );
    }
  }

  // spec_block_changed (high): a changed spec file hunk overlaps the
  // requirement's spec source_ref line range for that spec path.
  for (const range of specSourceRanges(requirement)) {
    const diffFile = context.diffByPath.get(range.path);
    if (!diffFile || !isSpecPath(range.path)) {
      continue;
    }
    const overlap = firstHunkOverlap(diffFile, range);
    if (overlap) {
      reasons.push(
        scopeReason("spec_block_changed", "high", {
          path: range.path,
          line_start: overlap.line_start,
          line_end: overlap.line_end,
          note: `Changed spec hunk overlaps the requirement's source block.`
        })
      );
    }
  }

  // changed_path_requirement_group (medium): a changed non-test mapped file (impl,
  // config, doc, ci, spec, …) maps to the requirement's group_key.
  if (groupKey && context.mappedGroups.has(groupKey)) {
    const file = context.firstMappedByGroup.get(groupKey);
    reasons.push(
      scopeReason("changed_path_requirement_group", "medium", {
        path: file,
        note: `Changed file maps to requirement group ${groupKey}.`
      })
    );
  }

  // changed_test_group (medium): a changed test file maps to the group_key.
  if (groupKey && context.testGroups.has(groupKey)) {
    const file = context.firstTestByGroup.get(groupKey);
    reasons.push(
      scopeReason("changed_test_group", "medium", {
        path: file,
        note: `Changed test file maps to requirement group ${groupKey}.`
      })
    );
  }

  return dedupeReasons(reasons);
}

function scopeReason(
  rule: PrScopeRule,
  confidence: PrScopeConfidence,
  options: { path?: string; line_start?: number; line_end?: number; note?: string }
): PrScopeReason {
  const reason: PrScopeReason = { rule, confidence };
  if (options.path !== undefined) {
    reason.path = options.path;
  }
  if (options.line_start !== undefined) {
    reason.line_start = options.line_start;
  }
  if (options.line_end !== undefined) {
    reason.line_end = options.line_end;
  }
  if (options.note !== undefined) {
    reason.note = options.note;
  }
  return reason;
}

// Stable, ordered de-dupe over the identifying fields of a reason. Sorted by
// rule then path then line range so a requirement's reasons are byte-stable
// regardless of the order rules fired.
function dedupeReasons(reasons: PrScopeReason[]): PrScopeReason[] {
  const seen = new Set<string>();
  const result: PrScopeReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.rule}:${reason.path ?? ""}:${reason.line_start ?? ""}:${reason.line_end ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(reason);
  }
  return result.sort(
    (left, right) =>
      compareStrings(left.rule, right.rule) ||
      compareStrings(left.path ?? "", right.path ?? "") ||
      (left.line_start ?? 0) - (right.line_start ?? 0)
  );
}

// --- diff helpers ----------------------------------------------------------

function lineCounts(diffFile: StructuredDiffFile | undefined): { added?: number; deleted?: number } {
  if (!diffFile) {
    return {};
  }
  let added = 0;
  let deleted = 0;
  for (const hunk of diffFile.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        added += 1;
      } else if (line.kind === "delete") {
        deleted += 1;
      }
    }
  }
  return { added, deleted };
}

// First CHANGED diff line (add/delete only — never unchanged context) whose text
// contains the acai_id, with its best available line number (new_line preferred,
// else old_line). Context lines are excluded so a small edit NEAR an existing
// `review-surfaces.X.Y` comment cannot pull an unrelated requirement into scope at
// high confidence: the ACID-bearing line itself must have been added or deleted.
// Deterministic: hunks and lines are scanned in file order.
function buildAcidHitIndex(
  changedFiles: ScopedChangedFile[],
  diffByPath: Map<string, StructuredDiffFile>
): Map<string, AcidHit[]> {
  const hits = new Map<string, AcidHit[]>();
  const seenByFile = new Set<string>();
  const acidPattern = new RegExp(ACID_PATTERN.source, "g");
  for (const changedFile of changedFiles) {
    const diffFile = diffByPath.get(changedFile.path);
    if (!diffFile) {
      continue;
    }
    for (const hunk of diffFile.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "context") {
          continue;
        }
        acidPattern.lastIndex = 0;
        for (const match of line.text.matchAll(acidPattern)) {
          const acid = match[0];
          if (!isWholeAcidToken(line.text, match.index ?? 0, acid)) {
            continue;
          }
          const key = `${acid}:${changedFile.path}`;
          if (seenByFile.has(key)) {
            continue;
          }
          seenByFile.add(key);
          const lineNumber = line.new_line ?? line.old_line;
          const entry = hits.get(acid) ?? [];
          entry.push({
            path: changedFile.path,
            role: changedFile.role,
            ...(lineNumber !== undefined ? { line: lineNumber } : {})
          });
          hits.set(acid, entry);
        }
      }
    }
  }
  return hits;
}

// ACID tokens are made of [A-Za-z0-9_.-]; a match requires a non-ACID char (or
// string edge) on both sides. The shared ACID_PATTERN finds candidate tokens, but
// this boundary check prevents `review-surfaces.CLI.1beta` from scoping CLI.1.
function isAcidChar(ch: string): boolean {
  return ch !== "" && /[A-Za-z0-9_.-]/.test(ch);
}

function isWholeAcidToken(text: string, index: number, acid: string): boolean {
  const before = index > 0 ? text[index - 1] : "";
  const after = index + acid.length < text.length ? text[index + acid.length] : "";
  return !isAcidChar(before) && !isAcidChar(after);
}

// First hunk whose changed line span overlaps the requirement's source line
// range. Hunk span is taken from new_start/new_lines (the head-side span).
function firstHunkOverlap(diffFile: StructuredDiffFile, range: SpecSourceRange): { line_start: number; line_end: number } | undefined {
  // Whole-file spec reference (no line numbers — spec evidence routinely omits
  // them): treat ANY changed hunk in this spec file as touching the requirement's
  // source block. Defaulting end to line 1 here would only ever match a hunk that
  // edits line 1, silently dropping the rule for edits anywhere else in the spec.
  if (range.line_start === undefined && range.line_end === undefined) {
    const hunk = diffFile.hunks[0];
    if (!hunk) {
      return undefined;
    }
    return { line_start: hunk.new_start, line_end: hunk.new_start + Math.max(hunk.new_lines, 1) - 1 };
  }
  const start = range.line_start ?? 1;
  const end = range.line_end ?? start;
  for (const hunk of diffFile.hunks) {
    const hunkStart = hunk.new_start;
    const hunkEnd = hunk.new_start + Math.max(hunk.new_lines, 1) - 1;
    if (hunkStart <= end && hunkEnd >= start) {
      return { line_start: Math.max(hunkStart, start), line_end: Math.min(hunkEnd, end) };
    }
  }
  return undefined;
}

function firstFilesByGroup(
  changedFiles: ScopedChangedFile[],
  predicate: (file: ScopedChangedFile) => boolean
): Map<string, string> {
  const result = new Map<string, string>();
  for (const changedFile of changedFiles) {
    if (!predicate(changedFile)) {
      continue;
    }
    for (const groupKey of changedFile.areas) {
      if (!result.has(groupKey)) {
        result.set(groupKey, changedFile.path);
      }
    }
  }
  return result;
}

// --- requirement metadata helpers ------------------------------------------

// Derive a requirement's group_key from the acai_id middle segment
// (review-surfaces.PRIVACY.2 -> PRIVACY). LLM-derived requirements never carry
// an acai_id, so they have no deterministic group_key here.
function requirementGroupKey(requirement: IntentRequirement): string | undefined {
  return groupFromAcid(requirement.acai_id);
}

// Extract (path, line range) tuples from a requirement's spec source_refs. The
// path is the source_ref.ref; line ranges come from the attached spec evidence
// (line_start/line_end), which may be absent for whole-file references.
function specSourceRanges(requirement: IntentRequirement): SpecSourceRange[] {
  const ranges: SpecSourceRange[] = [];
  for (const sourceRef of requirement.source_refs) {
    if (sourceRef.kind !== "spec") {
      continue;
    }
    const evidences = sourceRef.evidence ?? [];
    if (evidences.length === 0) {
      ranges.push({ path: sourceRef.ref });
      continue;
    }
    for (const evidence of evidences) {
      const range: SpecSourceRange = { path: evidence.path ?? sourceRef.ref };
      if (evidence.line_start !== undefined) {
        range.line_start = evidence.line_start;
      }
      if (evidence.line_end !== undefined) {
        range.line_end = evidence.line_end;
      }
      ranges.push(range);
    }
  }
  return ranges;
}

// --- misc helpers ----------------------------------------------------------

function areaName(areas: ReviewArea[], groupKey: string): string {
  const match = areas.find((area) => area.groupKey === groupKey);
  return match ? match.name : groupKey;
}

function baseName(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index >= 0 ? filePath.slice(index + 1) : filePath;
}
