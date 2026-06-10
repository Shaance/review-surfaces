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
    for (const target of resolveRelativeImports(file, content, options.exists)) {
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
// `symbols` — a named import of the symbol, or a namespace import whose `ns.symbol`
// appears in the file body. Returns sorted unique paths.
export function findSymbolImporters(options: {
  graph: ImportGraph;
  modulePath: string;
  symbols: string[];
  read: (filePath: string) => string | undefined;
}): string[] {
  const readCached = (filePath: string): string | undefined =>
    options.graph.contents.get(filePath) ?? options.read(filePath);
  const importerPaths = options.graph.importers.get(options.modulePath) ?? [];
  if (importerPaths.length === 0 || options.symbols.length === 0) {
    return [];
  }
  const result: string[] = [];
  for (const importer of importerPaths) {
    const content = readCached(importer);
    if (!content) {
      continue;
    }
    const referencesSymbol = options.symbols.some((symbol) => {
      const named = new RegExp(`import\\s+(type\\s+)?\\{[^}]*\\b${escapeRegExp(symbol)}\\b[^}]*\\}`);
      if (named.test(content)) {
        return true;
      }
      const ns = content.match(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g);
      if (ns) {
        for (const decl of ns) {
          const alias = decl.replace(/import\s+\*\s+as\s+/, "");
          if (new RegExp(`\\b${escapeRegExp(alias)}\\.${escapeRegExp(symbol)}\\b`).test(content)) {
            return true;
          }
        }
      }
      return false;
    });
    if (referencesSymbol) {
      result.push(importer);
    }
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
