import { ReviewAreaConfig, ReviewSurfacesConfig, loadConfig } from "../config/config";
import { RepoIndex } from "../indexer/indexer";

export interface ReviewArea {
  id: string;
  name: string;
  groupKey: string;
  prefixes: string[];
  purpose: string;
  pattern: string;
  testKeywords: string[];
}

// "config" areas come from the consuming repo's review-surfaces.config.yaml.
// "fallback" areas are derived from the deterministic repo index clusters so
// the tool stays useful on repos that have not declared any areas.
export type ReviewAreasMode = "config" | "fallback";

export interface ReviewAreasResult {
  areas: ReviewArea[];
  mode: ReviewAreasMode;
}

export type ReviewAreaMatchPurpose = "review_surface" | "requirement_proof";

export interface ReviewAreaMatchOptions {
  purpose: ReviewAreaMatchPurpose;
}

export interface ReviewAreaPathMatch {
  areaId: string;
  groupKey: string;
  reason: "prefix" | "test_keyword";
  matched: string;
}

export interface ReviewAreaPathDiagnostic {
  path: string;
  purpose: ReviewAreaMatchPurpose;
  groups: string[];
  matches: ReviewAreaPathMatch[];
}

export interface ReviewAreaMatcher {
  groupsForPath(filePath: string, options: ReviewAreaMatchOptions): string[];
  explainPath(filePath: string, options: ReviewAreaMatchOptions): ReviewAreaPathDiagnostic;
}

interface ReviewAreaMatchContext {
  testPath: boolean;
  lowerPath?: string;
  proofTokens?: Set<string>;
}

export interface BuildReviewAreasOptions {
  config?: Pick<ReviewSurfacesConfig, "areas">;
  repoIndex?: RepoIndex;
}

/**
 * Resolve the review areas a run should use. Prefer areas declared in config.
 * When config declares none, derive neutral fallback areas from the repo index
 * clusters so diagrams/cards/grouping still work on any repository.
 */
export function buildReviewAreas(options: BuildReviewAreasOptions = {}): ReviewAreasResult {
  const configured = options.config?.areas;
  if (configured && configured.length > 0) {
    return { areas: configured.map(fromConfig), mode: "config" };
  }
  return { areas: fallbackAreasFromIndex(options.repoIndex), mode: "fallback" };
}

/**
 * Load the review areas declared in a repository's config (used by tests and
 * tooling that need this repo's own default areas without a full collection).
 */
export async function loadReviewAreas(cwd: string, configPath?: string): Promise<ReviewAreasResult> {
  const config = await loadConfig(cwd, configPath);
  return buildReviewAreas({ config });
}

export function createReviewAreaMatcher(areas: ReviewArea[]): ReviewAreaMatcher {
  return {
    groupsForPath(filePath, options) {
      return collectGroupsForPath(filePath, areas, options);
    },
    explainPath(filePath, options) {
      return explainPathForAreas(filePath, areas, options);
    }
  };
}

// Split a path into lowercased whole tokens on directory, dot, hyphen, and
// underscore boundaries so a test_keyword only matches a real path/filename
// segment (e.g. "eval" matches "tests/eval.test.ts" but NOT "tests/medieval.ts").
function pathTokens(filePath: string): Set<string> {
  return new Set(
    filePath
      .toLowerCase()
      .split(/[/.\-_]+/)
      .filter((token) => token.length > 0)
  );
}

// A true directory prefix (startsWith with a trailing "/"), an exact path match,
// or the repository-root sentinel. Never an arbitrary substring match. A config
// prefix like "package.json" with no trailing slash is treated as an exact path
// (file) prefix, matching only that file or paths nested beneath it.
function matchesStrictPrefix(filePath: string, prefix: string): boolean {
  if (prefix === ROOT_PREFIX) {
    return !filePath.includes("/");
  }
  if (prefix.endsWith("/")) {
    return filePath === prefix.slice(0, -1) || filePath.startsWith(prefix);
  }
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

export function isLaterProviderGroup(groupKey: string): boolean {
  return groupKey === "PROVIDERS";
}

// Sentinel prefix representing the repository root in fallback areas. A real
// directory prefix always ends with "/", and config prefixes never use this
// exact token, so it cannot collide with a normal path prefix. matchesPrefix
// treats it as "this file lives at the repo root" (no directory separator),
// which is precise: it matches `index.ts` but not `src/index.ts`.
export const ROOT_PREFIX = ".";

function fromConfig(area: ReviewAreaConfig): ReviewArea {
  return {
    id: area.id,
    name: area.name,
    groupKey: area.group_key,
    prefixes: area.prefixes,
    purpose: area.purpose,
    pattern: area.pattern,
    testKeywords: area.test_keywords
  };
}

/**
 * Derive neutral review areas from the deterministic repo index clusters.
 * Each cluster becomes one review-sized area. Group keys are derived from the
 * cluster id so structural mapping stays stable across runs.
 */
function fallbackAreasFromIndex(repoIndex?: RepoIndex): ReviewArea[] {
  const clusters = repoIndex?.clusters ?? [];
  return clusters.map((cluster) => ({
    id: cluster.id,
    name: cluster.label,
    groupKey: clusterGroupKey(cluster.id),
    prefixes: cluster.dirs.map((dir) => (dir === "." || dir === "(root)" ? ROOT_PREFIX : `${dir}/`)),
    purpose: `Changed ${cluster.language} files clustered under ${cluster.label}.`,
    pattern: "structural cluster",
    testKeywords: []
  }));
}

// "cluster:src/api" -> "CLUSTER:SRC/API". Deterministic and never collides with
// Acai-style group keys, which come from spec component names.
function clusterGroupKey(clusterId: string): string {
  return clusterId.toUpperCase();
}

function explainPathForAreas(
  filePath: string,
  areas: ReviewArea[],
  options: ReviewAreaMatchOptions
): ReviewAreaPathDiagnostic {
  const matches: ReviewAreaPathMatch[] = [];
  const groups: string[] = [];
  const context = createMatchContext(filePath, options);
  for (const area of areas) {
    for (const prefix of area.prefixes) {
      if (matchesPrefixForPurpose(filePath, prefix, options.purpose)) {
        matches.push({ areaId: area.id, groupKey: area.groupKey, reason: "prefix", matched: prefix });
        addUnique(groups, area.groupKey);
      }
    }
    if (context.testPath) {
      for (const keyword of area.testKeywords) {
        if (matchesTestKeywordForPurpose(filePath, keyword, options.purpose, context)) {
          matches.push({ areaId: area.id, groupKey: area.groupKey, reason: "test_keyword", matched: keyword });
          addUnique(groups, area.groupKey);
        }
      }
    }
  }
  return {
    path: filePath,
    purpose: options.purpose,
    groups,
    matches
  };
}

function collectGroupsForPath(filePath: string, areas: ReviewArea[], options: ReviewAreaMatchOptions): string[] {
  const groups: string[] = [];
  const context = createMatchContext(filePath, options);
  for (const area of areas) {
    if (areaMatchesPathForPurpose(filePath, area, options, context)) {
      addUnique(groups, area.groupKey);
    }
  }
  return groups;
}

function areaMatchesPathForPurpose(
  filePath: string,
  area: ReviewArea,
  options: ReviewAreaMatchOptions,
  context: ReviewAreaMatchContext
): boolean {
  if (area.prefixes.some((prefix) => matchesPrefixForPurpose(filePath, prefix, options.purpose))) {
    return true;
  }
  return (
    context.testPath &&
    area.testKeywords.some((keyword) => matchesTestKeywordForPurpose(filePath, keyword, options.purpose, context))
  );
}

function createMatchContext(filePath: string, options: ReviewAreaMatchOptions): ReviewAreaMatchContext {
  const testPath = filePath.startsWith("tests/");
  return {
    testPath,
    lowerPath: testPath ? filePath.toLowerCase() : undefined,
    proofTokens: testPath && options.purpose === "requirement_proof" ? pathTokens(filePath) : undefined
  };
}

function matchesPrefixForPurpose(filePath: string, prefix: string, purpose: ReviewAreaMatchPurpose): boolean {
  return purpose === "requirement_proof" ? matchesStrictPrefix(filePath, prefix) : matchesPrefix(filePath, prefix);
}

function matchesTestKeywordForPurpose(
  filePath: string,
  keyword: string,
  purpose: ReviewAreaMatchPurpose,
  context: ReviewAreaMatchContext
): boolean {
  if (purpose === "requirement_proof") {
    const normalized = keyword.toLowerCase();
    return (context.proofTokens ?? pathTokens(filePath)).has(normalized);
  }
  return (context.lowerPath ?? filePath.toLowerCase()).includes(keyword);
}

function addUnique(groups: string[], group: string): void {
  if (!groups.includes(group)) {
    groups.push(group);
  }
}

function matchesPrefix(filePath: string, prefix: string): boolean {
  if (prefix === ROOT_PREFIX) {
    // Root cluster: match only files that live at the repository root, i.e. with
    // no directory separator. Avoids over-matching nested files like src/index.ts.
    return !filePath.includes("/");
  }
  return filePath === prefix || filePath.startsWith(prefix) || filePath.includes(prefix);
}
