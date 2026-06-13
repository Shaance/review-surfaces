// review-surfaces.RANKING.1: a one-pass import resolver used to map a changed
// test file to the in-repo modules it imports, so the queue can tell whether a
// changed implementation path has a focused test changed alongside it. It parses
// with the same ts.createSourceFile approach the semantic-diff surface uses (a
// runtime dependency since the TS AST extractor), resolves only RELATIVE
// specifiers with simple suffix rules, and skips bare specifiers and path
// aliases (a documented v1 bound — the same altitude as the regex-era bounds).
//
// BLAST_RADIUS.1: buildImportGraph extends the forward resolver into a reverse
// (module -> importers) graph over the indexed source files, bounded by a file
// cap so a silently partial graph can never present "used by 0" as fact.
import path from "node:path";
import ts from "typescript";

// Resolve the relative import / re-export / require / dynamic-import specifiers
// of one source file to repo-relative module paths that actually exist. `exists`
// answers whether a repo-relative path is a real file (the caller supplies a
// filesystem or index-backed check). Returns a sorted, de-duplicated list.
export function resolveRelativeImports(
  sourcePath: string,
  content: string,
  exists: (repoRelativePath: string) => boolean
): string[] {
  const source = ts.createSourceFile(sourcePath, content, ts.ScriptTarget.Latest, false);
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        specifiers.add(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const fromDir = path.posix.dirname(toPosix(sourcePath));
  const targets = new Set<string>();
  for (const specifier of specifiers) {
    // Skip bare specifiers (node_modules) and path aliases — only same-repo
    // relative imports map a test to its subject.
    if (!specifier.startsWith(".")) {
      continue;
    }
    const resolved = resolveSpecifier(fromDir, specifier, exists);
    if (resolved) {
      targets.add(resolved);
    }
  }
  return [...targets].sort();
}

function resolveSpecifier(fromDir: string, specifier: string, exists: (p: string) => boolean): string | undefined {
  const exact = normalize(path.posix.join(fromDir, specifier));
  // An import naming an existing JS file is that file — only fall back to the
  // "./x.js means ./x.ts" TS convention when the exact target does not exist.
  if (/\.(js|jsx|mjs|cjs)$/i.test(exact) && exists(exact)) {
    return exact;
  }
  const base = exact.replace(/\.(js|jsx|mjs|cjs)$/i, "");
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function normalize(p: string): string {
  return path.posix.normalize(p).replace(/^\.\//, "").replace(/^\/+/, "");
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface ImportGraph {
  // repo-relative module path -> sorted importer file paths.
  importers: Map<string, string[]>;
  // True when the file cap stopped the build before every file was parsed.
  truncated: boolean;
  // File contents read during the build, so findSymbolImporters does not re-read
  // every importer from disk/git.
  contents: Map<string, string>;
}

export const DEFAULT_IMPORT_GRAPH_FILE_CAP = 4000;

// review-surfaces.PERF.1: wrap an existence probe in a per-build memo so each
// distinct repo-relative path triggers at most ONE underlying lookup for the
// life of the build. resolveSpecifier probes up to ~7 candidate paths PER
// specifier and the same paths recur across every importing file, while in real
// runs `exists` is wired to a per-call `git cat-file` spawn — without this the
// graph spawned 6322 cat-files (21.7x redundancy) on a 256-file repo. Pure and
// output-identical: the memo returns the exact boolean the probe would have.
function memoizeExists(exists: (repoRelativePath: string) => boolean): (repoRelativePath: string) => boolean {
  const cache = new Map<string, boolean>();
  return (repoRelativePath: string): boolean => {
    const cached = cache.get(repoRelativePath);
    if (cached !== undefined) {
      return cached;
    }
    const result = exists(repoRelativePath);
    cache.set(repoRelativePath, result);
    return result;
  };
}

// Build a one-pass reverse import graph over the given source files. `read`
// returns a file's content (worktree or committed blob); contents are cached on
// the graph so symbol lookups never re-read importers.
export function buildImportGraph(options: {
  files: string[];
  read: (filePath: string) => string | undefined;
  exists: (filePath: string) => boolean;
  fileCap?: number;
}): ImportGraph {
  const cap = options.fileCap ?? DEFAULT_IMPORT_GRAPH_FILE_CAP;
  // review-surfaces.PERF.1: one memo shared by every resolveRelativeImports call
  // in this build, so a path probed across many files hits the cache once.
  const exists = memoizeExists(options.exists);
  const sources = options.files.filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(file)).sort();
  const truncated = sources.length > cap;
  const importersByModule = new Map<string, Set<string>>();
  const contents = new Map<string, string>();
  for (const file of sources.slice(0, cap)) {
    const content = options.read(file);
    if (!content) {
      continue;
    }
    contents.set(file, content);
    for (const target of resolveRelativeImports(file, content, exists)) {
      let bucket = importersByModule.get(target);
      if (!bucket) {
        bucket = new Set();
        importersByModule.set(target, bucket);
      }
      bucket.add(file);
    }
  }
  const importers = new Map<string, string[]>();
  for (const [module, bucket] of importersByModule) {
    importers.set(module, [...bucket].sort());
  }
  return { importers, truncated, contents };
}

// BLAST_RADIUS.2: the importers of `modulePath` that actually reference one of
// `symbols` THROUGH that module — a named import of the symbol from a specifier
// resolving to the module, or a namespace import of the module whose
// `ns.symbol` appears in the body. An identically-named symbol imported from a
// DIFFERENT module never counts. Returns sorted unique paths.
// Matches import declarations AND re-export barrels (`export { x } from "..."`).
// Captures: 1 = default binding, 2 = namespace alias, 3 = named list, 4 = spec.
const IMPORT_DECL = /(?:import|export)\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g;

export function findSymbolImporters(options: {
  graph: ImportGraph;
  modulePath: string;
  symbols: string[];
  read: (filePath: string) => string | undefined;
  exists?: (filePath: string) => boolean;
}): string[] {
  const importerPaths = options.graph.importers.get(options.modulePath) ?? [];
  if (importerPaths.length === 0 || options.symbols.length === 0) {
    return [];
  }
  // review-surfaces.PERF.1: memoize the existence probe here too — resolveSpecifier
  // re-probes the same candidate paths across every importer, and the default
  // probe is a contents-map lookup while an injected one may spawn per call.
  const exists = memoizeExists(options.exists ?? ((filePath: string) => options.graph.contents.has(filePath)));
  const readCached = (filePath: string): string | undefined =>
    options.graph.contents.get(filePath) ?? options.read(filePath);
  const symbolSet = new Set(options.symbols);
  const result: string[] = [];
  for (const importer of importerPaths) {
    const content = readCached(importer);
    if (!content) {
      continue;
    }
    const fromDir = path.posix.dirname(toPosix(importer));
    let references = false;
    for (const decl of content.matchAll(IMPORT_DECL)) {
      const [, defaultBinding, nsAlias, named, specifier] = decl;
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolveSpecifier(fromDir, specifier, exists);
      if (resolved !== options.modulePath) {
        continue;
      }
      // `import Foo from "./module"` consumes the default export.
      if (defaultBinding && symbolSet.has("default")) {
        references = true;
        break;
      }
      if (named && named.split(",").some((entry) => symbolSet.has(entry.replace(/\s+as\s+.*/, "").replace(/^type\s+/, "").trim()))) {
        references = true;
        break;
      }
      if (nsAlias) {
        const used = [...symbolSet].some((symbol) => new RegExp(`\\b${escapeRegExp(nsAlias)}\\.${escapeRegExp(symbol)}\\b`).test(content));
        if (used) {
          references = true;
          break;
        }
      }
    }
    if (references) {
      result.push(importer);
    }
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
