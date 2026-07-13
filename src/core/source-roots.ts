import ts from "typescript";
import { compareStrings } from "./compare";
import { collectPackageManifestTargets, compilePackageTargetPathMatcher, packageManifestTargetProjectionKey, packageTargetPrefersRootSource, packageTargetSourceVariants, parseCompiledPackageTarget, parsePackageManifest } from "./package-manifest";

// review-surfaces.COLD_START.2: derive a target repository's implementation
// roots from its OWN signals instead of a hardcoded src|bin|lib list (the
// cold-start failure: got's source/ classified as "config or docs — read
// last"). Signals, in order:
//   1. tsconfig.json compilerOptions.rootDir / rootDirs / include
//   2. package.json main/module/types/bin/exports/files entry points
//   3. fallback: top-level directories whose files are majority non-test
//      TS/JS sources
// Detection reads committed files only and iterates in sorted order, so the
// result is deterministic for a given tree. The conventional roots stay as a
// generic baseline so a signal-less repository degrades to today's behavior.

export const DEFAULT_IMPLEMENTATION_ROOTS: readonly string[] = ["bin", "lib", "src"];

// Top-level directories that are never implementation roots even when an entry
// point lives there: build output, dependencies, docs, and test trees. tsconfig
// rootDir is exempt (it is authored source by definition).
const NON_ROOT_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "tmp",
  "temp",
  "vendor",
  "docs",
  "doc",
  "examples",
  "example",
  "fixtures",
  "test",
  "tests",
  "__tests__"
]);

const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[jt]sx?$/;

export interface SourceRootSignals {
  /** Committed file paths (head tree), repo-relative with forward slashes. */
  files: string[];
  /** Committed content reader for tsconfig.json / package.json. */
  read: (filePath: string) => string | undefined;
}

export interface ContractSourceProjection {
  roots: string[];
  sourcePatternsByContract: ReadonlyMap<string, readonly string[]>;
}

export function detectImplementationRoots(signals: SourceRootSignals): string[] {
  const roots = new Set<string>(DEFAULT_IMPLEMENTATION_ROOTS);
  const files = [...signals.files].sort(compareStrings);
  const topDirs = new Set<string>();
  for (const filePath of files) {
    const slash = filePath.indexOf("/");
    if (slash > 0) {
      topDirs.add(filePath.slice(0, slash));
    }
  }
  const addCandidate = (segment: string | undefined, exemptFromDenylist = false): void => {
    if (!segment || segment === "." || segment === ".." || segment.startsWith(".")) {
      return;
    }
    if (!exemptFromDenylist && NON_ROOT_DIRS.has(segment)) {
      return;
    }
    // Only directories that actually exist in the tree become roots.
    if (topDirs.has(segment)) {
      roots.add(segment);
    }
  };

  // Signal 1: tsconfig.json (parsed with the TS jsonc parser — tsconfig allows
  // comments and trailing commas).
  const tsconfigText = signals.read("tsconfig.json");
  if (tsconfigText !== undefined) {
    const parsed = ts.parseConfigFileTextToJson("tsconfig.json", tsconfigText).config as
      | { compilerOptions?: { rootDir?: unknown; rootDirs?: unknown }; include?: unknown }
      | undefined;
    addCandidate(topSegment(parsed?.compilerOptions?.rootDir), true);
    for (const dir of stringArray(parsed?.compilerOptions?.rootDirs)) {
      addCandidate(topSegment(dir), true);
    }
    for (const pattern of stringArray(parsed?.include)) {
      addCandidate(topSegment(pattern));
    }
  }

  // Signal 2: package.json entry points. Build-output dirs are denylisted —
  // `main: dist/index.js` must not make generated output an implementation root.
  const packageText = signals.read("package.json");
  if (packageText !== undefined) {
    const manifest = parsePackageManifest(packageText);
    if (manifest) {
      for (const { target } of collectPackageManifestTargets(manifest)) {
        addCandidate(topSegment(target));
      }
    }
  }

  // Signal 3 (fallback, always computed — it can only add roots): top-level
  // directories whose files are majority non-test TS/JS sources.
  const totals = new Map<string, { source: number; total: number }>();
  for (const filePath of files) {
    const slash = filePath.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    const top = filePath.slice(0, slash);
    const counts = totals.get(top) ?? { source: 0, total: 0 };
    counts.total += 1;
    if (SOURCE_EXTENSION.test(filePath) && !TEST_PATH.test(filePath)) {
      counts.source += 1;
    }
    totals.set(top, counts);
  }
  for (const [top, counts] of [...totals.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (counts.source > 0 && counts.source * 2 > counts.total) {
      addCandidate(top);
    }
  }

  return [...roots].sort(compareStrings);
}

/** Source roots and exact per-package-target patterns; explicit tsconfig roots win. */
export function detectContractSourceProjection(signals: SourceRootSignals): ContractSourceProjection {
  const files = [...signals.files].sort(compareStrings);
  const readCache = new Map<string, string | undefined>();
  const read = (filePath: string): string | undefined => {
    if (!readCache.has(filePath)) readCache.set(filePath, signals.read(filePath));
    return readCache.get(filePath);
  };
  const topDirs = new Set(files.flatMap((filePath) => {
    const slash = filePath.indexOf("/");
    return slash > 0 ? [filePath.slice(0, slash)] : [];
  }));
  const explicit = new Set<string>();
  const tsconfigText = read("tsconfig.json");
  if (tsconfigText !== undefined) {
    const parsed = ts.parseConfigFileTextToJson("tsconfig.json", tsconfigText).config as
      | { compilerOptions?: { rootDir?: unknown; rootDirs?: unknown }; include?: unknown }
      | undefined;
    const rootDir = topSegment(parsed?.compilerOptions?.rootDir);
    if (rootDir && (rootDir === "." || topDirs.has(rootDir))) explicit.add(rootDir);
    for (const value of stringArray(parsed?.compilerOptions?.rootDirs)) {
      const root = topSegment(value);
      if (root && (root === "." || topDirs.has(root))) explicit.add(root);
    }
    // Authored rootDir/rootDirs are the strongest signal. Only fall back to
    // include roots when neither is present, and keep test/build/doc trees out
    // so a broad tsconfig does not recreate the ambiguous multi-root fallback.
    if (explicit.size === 0) {
      for (const value of stringArray(parsed?.include)) {
        const root = topSegment(value);
        if (root && !NON_ROOT_DIRS.has(root) && (root === "." || topDirs.has(root))) explicit.add(root);
      }
    }
  }
  const packageProjection = compiledPackageSourceProjection(
    files,
    read("package.json"),
    topDirs,
    explicit.size > 0 ? explicit : undefined
  );
  if (explicit.size > 0) {
    return {
      roots: [...explicit].sort(compareStrings),
      sourcePatternsByContract: packageProjection.sourcePatternsByContract
    };
  }
  if (packageProjection.roots.length > 0) return packageProjection;
  return {
    roots: detectImplementationRoots({ files, read }).filter((root) => topDirs.has(root)),
    sourcePatternsByContract: new Map()
  };
}

/** Compatibility wrapper for consumers that only need the roots. */
export function detectContractSourceRoots(signals: SourceRootSignals): string[] {
  return detectContractSourceProjection(signals).roots;
}

function compiledPackageSourceProjection(
  files: readonly string[],
  packageText: string | undefined,
  topDirs: ReadonlySet<string>,
  allowedRoots?: ReadonlySet<string>
): ContractSourceProjection {
  const manifest = parsePackageManifest(packageText);
  if (!manifest) return { roots: [], sourcePatternsByContract: new Map() };
  const compiledTargets = collectPackageManifestTargets(manifest).flatMap((target) => {
    if (target.kind === "file") return [];
    const compiled = parseCompiledPackageTarget(target.target);
    return compiled ? [{ ...target, compiled }] : [];
  });
  if (compiledTargets.length === 0) return { roots: [], sourcePatternsByContract: new Map() };
  const eligibleRoots = new Set(allowedRoots ?? [".", ...topDirs].filter((root) => !NON_ROOT_DIRS.has(root)));
  const sourceCandidatesByRelativePath = new Map<string, Array<{ root: string; sourcePath: string }>>();
  for (const sourcePath of files) {
    if (!SOURCE_EXTENSION.test(sourcePath) || TEST_PATH.test(sourcePath)) continue;
    const candidates: Array<{ root: string; relativePath: string }> = [];
    const slash = sourcePath.indexOf("/");
    const topRoot = slash > 0 ? sourcePath.slice(0, slash) : ".";
    if (eligibleRoots.has(".") || eligibleRoots.has(topRoot)) {
      candidates.push({ root: ".", relativePath: sourcePath });
    }
    if (slash > 0) {
      if (eligibleRoots.has(topRoot)) candidates.push({ root: topRoot, relativePath: sourcePath.slice(slash + 1) });
    }
    for (const candidate of candidates) {
      const indexed = sourceCandidatesByRelativePath.get(candidate.relativePath) ?? [];
      indexed.push({ root: candidate.root, sourcePath });
      sourceCandidatesByRelativePath.set(candidate.relativePath, indexed);
    }
  }
  const roots = new Set<string>();
  const sourcePatternsByContract = new Map<string, readonly string[]>();
  for (const contractTarget of compiledTargets) {
    const { kind, field, target, compiled, consumer_path: consumerPath } = contractTarget;
    const variants = packageTargetSourceVariants(compiled.relativePath, kind === "entry" && field !== "bin");
    const preferRootSource = packageTargetPrefersRootSource({ kind, field, consumer_path: consumerPath });
    const matchingPatterns = new Set<string>();
    for (const variant of variants) {
      const matcher = compilePackageTargetPathMatcher(variant);
      const relativePaths = variant.includes("*")
        ? sourceCandidatesByRelativePath.keys()
        : [variant];
      const matchingCandidates: Array<{ root: string; sourcePath: string }> = [];
      for (const relativePath of relativePaths) {
        if (matcher(relativePath) === undefined) continue;
        for (const candidate of sourceCandidatesByRelativePath.get(relativePath) ?? []) {
          // Exclude the emitted target inside its output directory, but retain
          // a transformed sibling source such as lib/index.ts for lib/index.js.
          if (candidate.root === compiled.outputRoot && variant === compiled.relativePath) continue;
          matchingCandidates.push(candidate);
        }
      }
      const hasRootCandidate = matchingCandidates.some((candidate) => candidate.root === ".");
      const hasNestedCandidate = matchingCandidates.some((candidate) => candidate.root !== ".");
      const outputSiblingCandidates = matchingCandidates.filter((candidate) => candidate.root === compiled.outputRoot);
      const preferredCandidates = preferRootSource && hasRootCandidate
        ? matchingCandidates.filter((candidate) => candidate.root === ".")
        : outputSiblingCandidates.length > 0
          ? outputSiblingCandidates
        : !preferRootSource && hasNestedCandidate
          ? matchingCandidates.filter((candidate) => candidate.root !== ".")
          : matchingCandidates;
      for (const candidate of preferredCandidates) {
        roots.add(candidate.root);
        matchingPatterns.add(candidate.root === "." ? variant : `${candidate.root}/${variant}`);
      }
    }
    if (matchingPatterns.size > 0) {
      sourcePatternsByContract.set(packageManifestTargetProjectionKey(contractTarget), [...matchingPatterns].sort(compareStrings));
    }
  }
  return { roots: [...roots].sort(compareStrings), sourcePatternsByContract };
}

// The first path segment of an entry-point or include pattern, stopping at the
// first glob character ("source/**" -> "source", "./dist/index.js" -> "dist").
function topSegment(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const slashNormalized = value.replace(/\\/g, "/");
  if (slashNormalized === "." || slashNormalized === "./") return ".";
  const normalized = slashNormalized.replace(/^\.\//, "");
  const first = normalized.split("/")[0];
  if (first === "" || /[*?[\]{}!]/.test(first)) {
    return undefined;
  }
  return first;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

// review-surfaces.COLD_START.2: the shared cluster rule for the change map and
// the reading order — top-level directory, with files under an implementation
// root clustered by their directory directly under that root. Generalizes the
// previous src-only special case so map and tour stay in agreement on any repo.
export function clusterOfPath(filePath: string, roots: readonly string[]): string {
  const segments = filePath.split("/");
  if (segments.length === 1) {
    return "(root)";
  }
  if (roots.includes(segments[0]) && segments.length > 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0];
}
