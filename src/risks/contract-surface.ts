import { compareStrings } from "../core/compare";
import { globToRegExp } from "../core/glob";
import { collectPackageExportExclusions, collectPackageManifestTargets, packageExportSubpathIdentity, parsePackageManifest } from "../core/package-manifest";

export type ApiContractSurfaceKind = "declaration" | "package_export" | "package_entry" | "configured";

export interface ApiContractSurface {
  kind: ApiContractSurfaceKind;
  source: string;
  /** Stable package export/entry slot; absent for path-only contracts. */
  identity?: string;
  /** Concrete wildcard binding (for example export:./foo from export:./*). */
  binding?: string;
}

/** Conservative path-only classification for persisted and declaration contracts. */
export function isExplicitContractSurfacePath(filePath: string): boolean {
  const normalized = filePath.replace(/^\.\//, "").toLowerCase();
  const name = normalized.split("/").pop() ?? normalized;
  return isDeclarationContractPath(normalized) ||
    /(^|\/)schemas?\//.test(normalized) ||
    (normalized.endsWith(".json") && /schema/i.test(name));
}

/**
 * Classify a TypeScript module as an explicit consumer contract. Ordinary
 * `export` syntax and in-repo importers are deliberately absent from this rule:
 * they describe module structure, not an externally supported surface.
 */
export function classifyApiContractSurface(
  filePath: string,
  options: { packageJson?: string; configuredPaths?: readonly string[]; sourceRoots?: readonly string[] } = {}
): ApiContractSurface | undefined {
  return createApiContractSurfaceClassifier(options)(filePath);
}

export function createApiContractSurfaceClassifier(
  options: { packageJson?: string; configuredPaths?: readonly string[]; sourceRoots?: readonly string[] } = {}
): (filePath: string) => ApiContractSurface | undefined {
  const configured = [...(options.configuredPaths ?? [])]
    .sort(compareStrings)
    .map((pattern) => ({ pattern, matcher: globToRegExp(pattern) }));
  const manifest = parsePackageManifest(options.packageJson);
  const entries = manifest ? packageContractEntries(manifest, options.sourceRoots ?? ["src"]).map((entry) => ({
    ...entry,
    patterns: entry.patterns.map((pattern) => ({ pattern, match: compilePackagePathMatcher(pattern) }))
  })) : [];
  const exclusions = manifest ? collectPackageExportExclusions(manifest).map((pattern) => ({
    pattern,
    match: compilePackagePathMatcher(pattern)
  })) : [];
  return (filePath: string): ApiContractSurface | undefined => {
    const normalized = normalizePath(filePath);
    if (isDeclarationContractPath(normalized)) return { kind: "declaration", source: normalized };
    const configuredMatch = configured.find(({ matcher }) => matcher.test(normalized));
    if (configuredMatch) return { kind: "configured", source: configuredMatch.pattern };
    const matches: Array<{ entry: typeof entries[number]; capture?: string; consumerPath?: string }> = [];
    for (const candidate of entries) {
      for (const pattern of candidate.patterns) {
        const result = pattern.match(normalized);
        if (result !== undefined) {
          matches.push({
            entry: candidate,
            ...(result.capture !== undefined ? { capture: result.capture } : {}),
            ...(candidate.consumer_path ? { consumerPath: candidate.consumer_path.replaceAll("*", result.capture ?? "") } : {})
          });
          break;
        }
      }
    }
    matches.sort((a, b) => comparePackagePatternSpecificity(b.entry.consumer_path, a.entry.consumer_path));
    const selected = matches.find(({ entry, consumerPath }) => !consumerPath || !exclusions.some((exclusion) =>
      exclusion.match(consumerPath) !== undefined && comparePackagePatternSpecificity(exclusion.pattern, entry.consumer_path) >= 0
    ));
    const entry = selected?.entry;
    const capture = selected?.capture;
    const binding = entry?.identity.includes("*") && capture !== undefined
      ? entry.identity.replaceAll("*", capture)
      : undefined;
    return entry ? {
      kind: entry.kind,
      source: entry.source,
      identity: entry.identity,
      ...(binding ? { binding } : {})
    } : undefined;
  };
}

function isDeclarationContractPath(normalizedPath: string): boolean {
  return /\.d\.(?:ts|mts|cts)$/u.test(normalizedPath);
}

export function isPersistedSchemaPath(filePath: string): boolean {
  const normalized = filePath.replace(/^\.\//, "").toLowerCase();
  const name = normalized.split("/").pop() ?? normalized;
  return /(^|\/)schemas?\//.test(normalized) ||
    (normalized.endsWith(".json") && /schema/i.test(name));
}

export function listPackageContractSurfaces(packageJson: string | undefined): ApiContractSurface[] {
  const manifest = parsePackageManifest(packageJson);
  if (!manifest) return [];
  return packageContractEntries(manifest, []).map(({ kind, source, identity }) => ({ kind, source, identity }));
}

export interface PackageContractExclusion {
  surface: ApiContractSurface;
  consumer_path: string;
}

export function listPackageContractExclusions(packageJson: string | undefined): PackageContractExclusion[] {
  const manifest = parsePackageManifest(packageJson);
  if (!manifest) return [];
  return collectPackageExportExclusions(manifest).map((consumerPath) => ({
    consumer_path: consumerPath,
    surface: {
      kind: "package_export",
      source: `package.json#exports:${consumerPath}:null`,
      identity: packageExportSubpathIdentity(consumerPath)
    }
  }));
}

export interface PackageContractEntry {
  surface: ApiContractSurface;
  patterns: string[];
  priority_group?: string;
  consumer_path?: string;
}

export function listPackageContractEntries(
  packageJson: string | undefined,
  sourceRoots: readonly string[] = []
): PackageContractEntry[] {
  const manifest = parsePackageManifest(packageJson);
  if (!manifest) return [];
  return packageContractEntries(manifest, sourceRoots).map(({ kind, source, identity, patterns, priority_group, consumer_path }) => ({
    surface: { kind, source, identity },
    patterns,
    ...(priority_group ? { priority_group } : {}),
    ...(consumer_path ? { consumer_path } : {})
  }));
}

/** True only when a newly added exclusion subtracts an effective base export. */
export function packageExclusionRemovesContract(
  baseEntries: readonly PackageContractEntry[],
  headEntries: readonly PackageContractEntry[],
  exclusionPattern: string,
  baseExclusionPatterns: readonly string[] = []
): boolean {
  const basePatterns = baseEntries.map((entry) => entry.consumer_path).filter((value): value is string => Boolean(value));
  const headPatterns = headEntries.map((entry) => entry.consumer_path).filter((value): value is string => Boolean(value));
  return basePatterns.some((basePattern) => {
    // Compare the exact region jointly selected by the old positive export and
    // the new exclusion, including crossing wildcard prefix/suffix patterns.
    const removedRegions = packagePatternIntersections(basePattern, exclusionPattern);
    return removedRegions.some((removedRegion) => {
      // A base exclusion with at least the positive export's precedence means
      // this region was already private. A narrower positive is evaluated as
      // its own basePattern and can still prove that the region was public.
      const alreadyExcluded = baseExclusionPatterns.some((baseExclusion) =>
        comparePackagePatternSpecificity(baseExclusion, basePattern) >= 0 &&
        packagePatternCovers(baseExclusion, removedRegion)
      );
      if (alreadyExcluded) return false;
      return !headPatterns.some((headPattern) =>
        comparePackagePatternSpecificity(headPattern, exclusionPattern) > 0 &&
        packagePatternCovers(headPattern, removedRegion)
      );
    });
  });
}

function packageContractEntries(manifest: Record<string, unknown>, sourceRoots: readonly string[]): Array<{
  kind: "package_export" | "package_entry";
  source: string;
  identity: string;
  patterns: string[];
  priority_group?: string;
  consumer_path?: string;
}> {
  const entries: Array<{ kind: "package_export" | "package_entry"; source: string; identity: string; patterns: string[]; priority_group?: string; consumer_path?: string }> = [];
  for (const { kind, field, target, identity, priority_group, consumer_path } of collectPackageManifestTargets(manifest)) {
    if (kind === "file") continue;
    entries.push({
      kind: kind === "export" ? "package_export" : "package_entry",
      source: `package.json#${field}:${target}`,
      identity,
      patterns: sourcePathPatterns(
        target,
        sourceRoots,
        kind === "entry" && field !== "bin"
      ),
      ...(priority_group ? { priority_group } : {}),
      ...(consumer_path ? { consumer_path } : {})
    });
  }
  return entries;
}

function sourcePathPatterns(
  target: string,
  sourceRoots: readonly string[],
  probeExtensionlessLegacyEntry: boolean
): string[] {
  const normalized = normalizePath(target);
  const roots = [...new Set(sourceRoots.map(normalizePath))].sort(compareStrings);
  const buildMatch = /^(dist|build|out|lib)\/(.+)$/u.exec(normalized);
  const candidates = new Set<string>();
  if (!buildMatch) {
    candidates.add(normalized);
  } else if (roots.length === 1) {
    const entryRelative = buildMatch[2];
    candidates.add(roots[0] === "."
      ? entryRelative
      : entryRelative.startsWith(`${roots[0]}/`) ? entryRelative : `${roots[0]}/${entryRelative}`);
  } else if (roots.includes(buildMatch[1])) {
    // A build-looking prefix is still source when repository evidence names it
    // as an implementation root. Never project it across multiple roots.
    candidates.add(normalized);
  }
  for (const value of [...candidates]) {
    // Legacy package fields commonly omit the compiled extension. `exports`
    // targets are exact Node resolution targets, so never invent extension
    // candidates for an extensionless export (a false public contract).
    if (probeExtensionlessLegacyEntry && !value.includes("*") && !/\.[^/]+$/u.test(value)) {
      for (const extension of ["ts", "tsx", "mts", "cts"]) candidates.add(`${value}.${extension}`);
    }
    if (/\.jsx$/u.test(value)) {
      candidates.add(`${value.slice(0, -4)}.tsx`);
    } else if (/\.(mjs|cjs|js)$/u.test(value)) {
      const stem = value.replace(/\.(mjs|cjs|js)$/u, "");
      for (const extension of ["ts", "tsx", "mts", "cts"]) candidates.add(`${stem}.${extension}`);
    }
    if (/\.d\.(mts|cts|ts)$/u.test(value)) {
      const stem = value.replace(/\.d\.(mts|cts|ts)$/u, "");
      for (const extension of ["ts", "tsx", "mts", "cts"]) candidates.add(`${stem}.${extension}`);
    }
  }
  return [...candidates].filter(Boolean).sort(compareStrings);
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function comparePackagePatternSpecificity(left: string | undefined, right: string | undefined): number {
  const score = (pattern: string | undefined): [number, number, number] => {
    if (!pattern) return [0, 0, 0];
    const wildcard = pattern.indexOf("*");
    return [wildcard < 0 ? 1 : 0, wildcard < 0 ? pattern.length : wildcard, pattern.replaceAll("*", "").length];
  };
  const a = score(left);
  const b = score(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function packagePatternCovers(cover: string, target: string): boolean {
  if (!target.includes("*")) return compilePackagePathMatcher(cover)(target) !== undefined;
  if (!cover.includes("*")) return false;
  const [coverPrefix, ...coverTail] = cover.split("*");
  const [targetPrefix, ...targetTail] = target.split("*");
  const coverSuffix = coverTail.join("*");
  const targetSuffix = targetTail.join("*");
  return targetPrefix.startsWith(coverPrefix) && targetSuffix.endsWith(coverSuffix);
}

function packagePatternIntersections(left: string, right: string): string[] {
  if (packagePatternCovers(left, right)) return [right];
  if (packagePatternCovers(right, left)) return [left];
  if (!left.includes("*") || !right.includes("*")) return [];
  const [leftPrefix, ...leftTail] = left.split("*");
  const [rightPrefix, ...rightTail] = right.split("*");
  if (!leftPrefix.startsWith(rightPrefix) && !rightPrefix.startsWith(leftPrefix)) return [];
  const leftSuffix = leftTail.join("*");
  const rightSuffix = rightTail.join("*");
  if (!leftSuffix.endsWith(rightSuffix) && !rightSuffix.endsWith(leftSuffix)) return [];
  const prefix = leftPrefix.length >= rightPrefix.length ? leftPrefix : rightPrefix;
  const suffix = leftSuffix.length >= rightSuffix.length ? leftSuffix : rightSuffix;
  const regions = new Set<string>([`${prefix}*${suffix}`]);
  // Wildcard captures are non-empty. Prefix/suffix boundaries (including
  // overlaps) are separate exact regions that the wildcard intersection does
  // not cover, so retain every boundary spelling accepted by both inputs.
  const overlapLimit = Math.min(prefix.length, suffix.length);
  const leftMatch = compilePackagePathMatcher(left);
  const rightMatch = compilePackagePathMatcher(right);
  for (let overlap = 0; overlap <= overlapLimit; overlap += 1) {
    if (!prefix.endsWith(suffix.slice(0, overlap))) continue;
    const exact = `${prefix}${suffix.slice(overlap)}`;
    if (leftMatch(exact) !== undefined && rightMatch(exact) !== undefined) regions.add(exact);
  }
  return [...regions];
}

// Node package export `*` captures may contain `/`, and repeated stars in a
// target all receive the same capture. Compile once per manifest entry and use
// a named backreference so following digits cannot become numeric references.
function compilePackagePathMatcher(pattern: string): (value: string) => { capture?: string } | undefined {
  const parts = pattern.split("*");
  if (parts.length < 2) return (value) => value === pattern ? {} : undefined;
  const tail = escapeRegExp(parts[1]) + parts.slice(2).map((part) => `\\k<binding>${escapeRegExp(part)}`).join("");
  const expression = new RegExp(`^${escapeRegExp(parts[0])}(?<binding>.+?)${tail}$`, "u");
  return (value) => {
    const capture = expression.exec(value)?.groups?.binding;
    return capture === undefined ? undefined : { capture };
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}
