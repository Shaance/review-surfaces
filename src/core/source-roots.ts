import ts from "typescript";
import { compareStrings } from "./compare";

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

export function detectImplementationRoots(signals: SourceRootSignals): string[] {
  const roots = new Set<string>(DEFAULT_IMPLEMENTATION_ROOTS);
  const files = [...signals.files].sort((a, b) => compareStrings(a, b));
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
    let manifest: Record<string, unknown> | undefined;
    try {
      manifest = JSON.parse(packageText) as Record<string, unknown>;
    } catch {
      manifest = undefined;
    }
    if (manifest) {
      for (const field of ["main", "module", "types", "typings"]) {
        if (typeof manifest[field] === "string") {
          addCandidate(topSegment(manifest[field] as string));
        }
      }
      const bin = manifest.bin;
      for (const entry of typeof bin === "string" ? [bin] : Object.values(bin && typeof bin === "object" ? bin : {})) {
        if (typeof entry === "string") {
          addCandidate(topSegment(entry));
        }
      }
      for (const value of collectStrings(manifest.exports)) {
        addCandidate(topSegment(value));
      }
      for (const value of stringArray(manifest.files)) {
        addCandidate(topSegment(value));
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

  return [...roots].sort((a, b) => compareStrings(a, b));
}

// The first path segment of an entry-point or include pattern, stopping at the
// first glob character ("source/**" -> "source", "./dist/index.js" -> "dist").
function topSegment(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const first = normalized.split("/")[0];
  if (first === "" || /[*?[\]{}!]/.test(first)) {
    return undefined;
  }
  return first;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

// All string leaves of a package.json `exports` value (string, array, or
// arbitrarily nested condition objects), in deterministic key order.
function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStrings(entry));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort((a, b) => compareStrings(a, b))
      .flatMap((key) => collectStrings((value as Record<string, unknown>)[key]));
  }
  return [];
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
