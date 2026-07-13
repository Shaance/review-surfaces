import { compareStrings } from "../core/compare";
import { globToRegExp } from "../core/glob";
import { collectPackageExportConditionExclusions, collectPackageExportExclusions, collectPackageManifestTargets, compilePackageTargetPathMatcher, packageExportSubpathIdentity, packageManifestTargetProjectionKey, packageTargetPrefersRootSource, packageTargetSourceVariants, parseCompiledPackageTarget, parsePackageManifest } from "../core/package-manifest";

export type ApiContractSurfaceKind = "declaration" | "package_export" | "package_entry" | "configured";

export interface ApiContractSurface {
  kind: ApiContractSurfaceKind;
  source: string;
  /** Stable package export/entry slot; absent for path-only contracts. */
  identity?: string;
  /** Concrete wildcard binding (for example export:./foo from export:./*). */
  binding?: string;
}

export interface ApiContractClassifierOptions {
  packageJson?: string;
  configuredPaths?: readonly string[];
  sourceRoots?: readonly string[];
  packageSourcePatterns?: ReadonlyMap<string, readonly string[]>;
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
  options: ApiContractClassifierOptions = {}
): ApiContractSurface | undefined {
  return createApiContractSurfaceClassifier(options)(filePath);
}

export function createApiContractSurfaceClassifier(
  options: ApiContractClassifierOptions = {}
): (filePath: string) => ApiContractSurface | undefined {
  const configured = [...(options.configuredPaths ?? [])]
    .sort(compareStrings)
    .map((pattern) => ({ pattern, matcher: globToRegExp(pattern) }));
  const manifest = parsePackageManifest(options.packageJson);
  const entries = manifest ? selectEffectiveEntries(
    packageContractEntries(manifest, options.sourceRoots ?? ["src"], options.packageSourcePatterns),
    (entry) => entry.identity
  ).map((entry) => ({
    ...entry,
    patterns: entry.patterns.map((pattern) => ({ pattern, match: compilePackageTargetPathMatcher(pattern) }))
  })) : [];
  const exclusions = manifest ? collectPackageExportExclusions(manifest).map((pattern) => ({
    pattern,
    match: compilePackageTargetPathMatcher(pattern)
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
  return selectEffectiveEntries(packageContractEntries(manifest, []), (entry) => entry.identity)
    .map(({ kind, source, identity }) => ({ kind, source, identity }));
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

export interface PackageConditionalContractExclusion extends PackageContractExclusion {
  priority_group: string;
}

export function listPackageConditionalContractExclusions(
  packageJson: string | undefined
): PackageConditionalContractExclusion[] {
  const manifest = parsePackageManifest(packageJson);
  if (!manifest) return [];
  return collectPackageExportConditionExclusions(manifest).map(({ identity, consumer_path, priority_group }) => ({
    consumer_path,
    priority_group,
    surface: {
      kind: "package_export",
      source: `package.json#exports:${consumer_path}:${identity}:null`,
      identity
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
  sourceRoots: readonly string[] = [],
  packageSourcePatterns?: ReadonlyMap<string, readonly string[]>
): PackageContractEntry[] {
  const manifest = parsePackageManifest(packageJson);
  if (!manifest) return [];
  return packageContractEntries(manifest, sourceRoots, packageSourcePatterns).map(({ kind, source, identity, patterns, priority_group, consumer_path }) => ({
    surface: { kind, source, identity },
    patterns,
    ...(priority_group ? { priority_group } : {}),
    ...(consumer_path ? { consumer_path } : {})
  }));
}

/** Keep the selected fallback per consumer identity while preserving all non-fallback entries. */
export function selectEffectivePackageContractEntries(
  entries: readonly PackageContractEntry[]
): PackageContractEntry[] {
  return selectEffectiveEntries(entries, (entry) => entry.surface.identity);
}

function selectEffectiveEntries<T extends { priority_group?: string }>(
  entries: readonly T[],
  identityOf: (entry: T) => string | undefined
): T[] {
  const selectedFallbacks = new Set<string>();
  return entries.filter((entry) => {
    const identity = identityOf(entry);
    if (!entry.priority_group || !identity) return true;
    if (selectedFallbacks.has(identity)) return false;
    selectedFallbacks.add(identity);
    return true;
  });
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

function packageContractEntries(
  manifest: Record<string, unknown>,
  sourceRoots: readonly string[],
  packageSourcePatterns?: ReadonlyMap<string, readonly string[]>
): Array<{
  kind: "package_export" | "package_entry";
  source: string;
  identity: string;
  patterns: string[];
  priority_group?: string;
  consumer_path?: string;
}> {
  const entries: Array<{ kind: "package_export" | "package_entry"; source: string; identity: string; patterns: string[]; priority_group?: string; consumer_path?: string }> = [];
  for (const contractTarget of collectPackageManifestTargets(manifest)) {
    const { kind, field, target, identity, priority_group, consumer_path } = contractTarget;
    if (kind === "file") continue;
    entries.push({
      kind: kind === "export" ? "package_export" : "package_entry",
      source: `package.json#${field}:${target}`,
      identity,
      patterns: sourcePathPatterns(
        target,
        sourceRoots,
        kind === "entry" && field !== "bin",
        packageTargetPrefersRootSource({ kind, field, consumer_path }),
        identity,
        packageSourcePatterns
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
  probeExtensionlessLegacyEntry: boolean,
  preferRootSource: boolean,
  identity: string,
  packageSourcePatterns?: ReadonlyMap<string, readonly string[]>
): string[] {
  const normalized = normalizePath(target);
  const roots = [...new Set(sourceRoots.map(normalizePath))].sort(compareStrings);
  const compiledTarget = parseCompiledPackageTarget(normalized);
  const candidates = new Set<string>();
  const detectedPatterns = packageSourcePatterns?.get(packageManifestTargetProjectionKey({ identity, target }));
  if (detectedPatterns) {
    for (const pattern of detectedPatterns) candidates.add(pattern);
  } else if (!compiledTarget) {
    candidates.add(normalized);
  } else if (roots.length === 1) {
    const entryRelative = compiledTarget.relativePath;
    const root = roots[0];
    candidates.add(root === "."
      ? entryRelative
      : entryRelative.startsWith(`${root}/`) ? entryRelative : `${root}/${entryRelative}`);
  } else if (roots.includes(".")) {
    const entryRelative = compiledTarget.relativePath;
    const projectionRoots = preferRootSource ? ["."] : roots.filter((root) => root !== ".");
    for (const root of projectionRoots) {
      candidates.add(root === "."
        ? entryRelative
        : entryRelative.startsWith(`${root}/`) ? entryRelative : `${root}/${entryRelative}`);
    }
  }
  return [...new Set([...candidates].flatMap((value) =>
    packageTargetSourceVariants(value, probeExtensionlessLegacyEntry)
  ))].sort(compareStrings);
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
  if (!target.includes("*")) return compilePackageTargetPathMatcher(cover)(target) !== undefined;
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
  const leftMatch = compilePackageTargetPathMatcher(left);
  const rightMatch = compilePackageTargetPathMatcher(right);
  for (let overlap = 0; overlap <= overlapLimit; overlap += 1) {
    if (!prefix.endsWith(suffix.slice(0, overlap))) continue;
    const exact = `${prefix}${suffix.slice(overlap)}`;
    if (leftMatch(exact) !== undefined && rightMatch(exact) !== undefined) regions.add(exact);
  }
  return [...regions];
}
