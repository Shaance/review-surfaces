import { compareStrings } from "../core/compare";
import { globToRegExp } from "../core/glob";
import { collectPackageManifestTargets, parsePackageManifest } from "../core/package-manifest";

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
  return (filePath: string): ApiContractSurface | undefined => {
    const normalized = normalizePath(filePath);
    if (isDeclarationContractPath(normalized)) return { kind: "declaration", source: normalized };
    const configuredMatch = configured.find(({ matcher }) => matcher.test(normalized));
    if (configuredMatch) return { kind: "configured", source: configuredMatch.pattern };
    let entry: typeof entries[number] | undefined;
    let capture: string | undefined;
    findEntry: for (const candidate of entries) {
      for (const pattern of candidate.patterns) {
        const result = pattern.match(normalized);
        if (result !== undefined) {
          entry = candidate;
          capture = result.capture;
          break findEntry;
        }
      }
    }
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

export interface PackageContractEntry {
  surface: ApiContractSurface;
  patterns: string[];
  priority_group?: string;
}

export function listPackageContractEntries(
  packageJson: string | undefined,
  sourceRoots: readonly string[] = []
): PackageContractEntry[] {
  const manifest = parsePackageManifest(packageJson);
  if (!manifest) return [];
  return packageContractEntries(manifest, sourceRoots).map(({ kind, source, identity, patterns, priority_group }) => ({
    surface: { kind, source, identity },
    patterns,
    ...(priority_group ? { priority_group } : {})
  }));
}

function packageContractEntries(manifest: Record<string, unknown>, sourceRoots: readonly string[]): Array<{
  kind: "package_export" | "package_entry";
  source: string;
  identity: string;
  patterns: string[];
  priority_group?: string;
}> {
  const entries: Array<{ kind: "package_export" | "package_entry"; source: string; identity: string; patterns: string[]; priority_group?: string }> = [];
  for (const { kind, field, target, identity, priority_group } of collectPackageManifestTargets(manifest)) {
    if (kind === "file") continue;
    entries.push({
      kind: kind === "export" ? "package_export" : "package_entry",
      source: `package.json#${field}:${target}`,
      identity,
      patterns: sourcePathPatterns(target, sourceRoots),
      ...(priority_group ? { priority_group } : {})
    });
  }
  return entries;
}

function sourcePathPatterns(target: string, sourceRoots: readonly string[]): string[] {
  const normalized = normalizePath(target);
  const roots = [...new Set(sourceRoots.map(normalizePath))].sort(compareStrings);
  const buildMatch = /^(dist|build|out|lib)\/(.+)$/u.exec(normalized);
  const candidates = new Set<string>();
  if (!buildMatch) {
    candidates.add(normalized);
  } else if (roots.length === 1) {
    const entryRelative = buildMatch[2];
    candidates.add(entryRelative.startsWith(`${roots[0]}/`) ? entryRelative : `${roots[0]}/${entryRelative}`);
  } else if (roots.includes(buildMatch[1])) {
    // A build-looking prefix is still source when repository evidence names it
    // as an implementation root. Never project it across multiple roots.
    candidates.add(normalized);
  }
  for (const value of [...candidates]) {
    if (/\.(mjs|cjs|js)$/u.test(value)) {
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

// Node package export `*` captures may contain `/`, and repeated stars in a
// target all receive the same capture. Compile once per manifest entry and use
// a named backreference so following digits cannot become numeric references.
function compilePackagePathMatcher(pattern: string): (value: string) => { capture?: string } | undefined {
  const parts = pattern.split("*");
  if (parts.length < 2) return (value) => value === pattern ? {} : undefined;
  const tail = escapeRegExp(parts[1]) + parts.slice(2).map((part) => `\\k<binding>${escapeRegExp(part)}`).join("");
  const expression = new RegExp(`^${escapeRegExp(parts[0])}(?<binding>.*?)${tail}$`, "u");
  return (value) => {
    const capture = expression.exec(value)?.groups?.binding;
    return capture === undefined ? undefined : { capture };
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}
