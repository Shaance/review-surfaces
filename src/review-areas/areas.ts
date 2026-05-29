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

export function groupsForReviewPath(filePath: string, areas: ReviewArea[]): string[] {
  const groups = areas
    .filter((area) => area.prefixes.some((prefix) => matchesPrefix(filePath, prefix)))
    .map((area) => area.groupKey);

  if (filePath.startsWith("tests/")) {
    for (const area of areas) {
      if (area.testKeywords.some((keyword) => filePath.toLowerCase().includes(keyword))) {
        groups.push(area.groupKey);
      }
    }
  }

  return [...new Set(groups)];
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

export function matchesReviewPrefix(filePath: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => matchesPrefix(filePath, prefix));
}

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

function matchesPrefix(filePath: string, prefix: string): boolean {
  if (prefix === ROOT_PREFIX) {
    // Root cluster: match only files that live at the repository root, i.e. with
    // no directory separator. Avoids over-matching nested files like src/index.ts.
    return !filePath.includes("/");
  }
  return filePath === prefix || filePath.startsWith(prefix) || filePath.includes(prefix);
}
