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

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const INDEX_SOURCE_SUFFIXES = SOURCE_EXTENSIONS.map((extension) => `/index${extension}`);

function isSourcePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// Resolve the relative import / re-export / require / dynamic-import specifiers
// of one source file to repo-relative module paths that actually exist. `exists`
// answers whether a repo-relative path is a real file (the caller supplies a
// filesystem or index-backed check). Returns a sorted, de-duplicated list.
export function resolveRelativeImports(
  sourcePath: string,
  content: string,
  exists: (repoRelativePath: string) => boolean,
  fallbackExists?: (repoRelativePath: string) => boolean
): string[] {
  return resolveImports(sourcePath, content, exists, fallbackExists);
}

function resolveImports(
  sourcePath: string,
  content: string,
  exists: (repoRelativePath: string) => boolean,
  fallbackExists?: (repoRelativePath: string) => boolean
): string[] {
  const source = ts.createSourceFile(sourcePath, content, ts.ScriptTarget.Latest, false);
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      specifiers.add(node.moduleReference.expression.text);
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
  return [...new Set([...specifiers]
    // Bare specifiers and path aliases are outside the bounded local graph.
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolveSpecifierWithFallback(fromDir, specifier, exists, fallbackExists))
    .filter((target): target is string => Boolean(target)))].sort();
}

// Architecture-cycle claims are runtime claims, so resolve the emitted module
// using the reviewed tree's compiler options. This respects type erasure and
// `verbatimModuleSyntax` instead of guessing from source syntax alone.
export function resolveRuntimeRelativeImports(
  sourcePath: string,
  content: string,
  exists: (repoRelativePath: string) => boolean,
  compilerOptions: ts.CompilerOptions = {}
): string[] {
  if (!isSourcePath(sourcePath) || /\.d\.(?:ts|mts|cts)$/i.test(sourcePath)) {
    return [];
  }
  const emitted = ts.transpileModule(content, {
    fileName: sourcePath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Node16,
      jsx: ts.JsxEmit.ReactJSX,
      ...compilerOptions
    },
    reportDiagnostics: false
  }).outputText;
  return resolveImports(sourcePath, emitted, exists);
}

function resolveSpecifier(fromDir: string, specifier: string, exists: (p: string) => boolean): string | undefined {
  const exact = normalize(path.posix.join(fromDir, specifier));
  const explicitJsSuffix = exact.match(/\.(js|jsx|mjs|cjs)$/i)?.[1]?.toLowerCase();
  // An import naming an existing JS file is that file — only fall back to the
  // "./x.js means ./x.ts" TS convention when the exact target does not exist.
  if (/\.(js|jsx|mjs|cjs)$/i.test(exact) && exists(exact)) {
    return exact;
  }
  const base = exact.replace(/\.(js|jsx|mjs|cjs)$/i, "");
  const mappedExtensions = explicitJsSuffix === "mjs" ? [".mts"]
    : explicitJsSuffix === "cjs" ? [".cts"]
      : explicitJsSuffix === "jsx" ? [".tsx"]
        : explicitJsSuffix === "js" ? [".ts", ".tsx"]
          : undefined;
  const candidates = mappedExtensions
    ? mappedExtensions.map((extension) => `${base}${extension}`)
    : [
        base,
        ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
        ...INDEX_SOURCE_SUFFIXES.map((suffix) => `${base}${suffix}`)
      ];
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
  // repo-relative importer path -> sorted imported module paths. This forward
  // view lets architecture drift prove a concrete file return path instead of
  // inferring a cycle from unrelated directory-aggregate edges.
  dependencies: Map<string, string[]>;
  // True when the file cap stopped the build before every file was parsed.
  truncated: boolean;
  // File contents read during the build, so findSymbolImporters does not re-read
  // every importer from disk/git.
  contents: Map<string, string>;
}

export const DEFAULT_IMPORT_GRAPH_FILE_CAP = 4000;

export function importGraphWouldTruncate(
  files: readonly string[],
  fileCap = DEFAULT_IMPORT_GRAPH_FILE_CAP
): boolean {
  let count = 0;
  for (const file of files) {
    if (isSourcePath(file) && ++count > fileCap) return true;
  }
  return false;
}

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
  resolveImports?: (
    sourcePath: string,
    content: string,
    exists: (repoRelativePath: string) => boolean
  ) => string[];
  retainContents?: boolean;
}): ImportGraph {
  const cap = options.fileCap ?? DEFAULT_IMPORT_GRAPH_FILE_CAP;
  // review-surfaces.PERF.1: one memo shared by every resolveRelativeImports call
  // in this build, so a path probed across many files hits the cache once.
  const exists = memoizeExists(options.exists);
  const sources = options.files.filter(isSourcePath).sort();
  const truncated = sources.length > cap;
  const importersByModule = new Map<string, Set<string>>();
  const dependencies = new Map<string, string[]>();
  const contents = new Map<string, string>();
  for (const file of sources.slice(0, cap)) {
    const content = options.read(file);
    if (!content) {
      continue;
    }
    if (options.retainContents !== false) contents.set(file, content);
    const targets = (options.resolveImports ?? resolveRelativeImports)(file, content, exists);
    dependencies.set(file, targets);
    for (const target of targets) {
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
  return { importers, dependencies, truncated, contents };
}

// BLAST_RADIUS.2: the importers of `modulePath` that actually reference one of
// `symbols` THROUGH that module — a named import of the symbol from a specifier
// resolving to the module, or a namespace import of the module whose
// `ns.symbol` appears in the body. An identically-named symbol imported from a
// DIFFERENT module never counts. Returns sorted unique paths.
interface ImporterSyntax {
  source: ts.SourceFile;
  qualifiedReferences?: Set<string>;
}

const importerSyntaxByGraph = new WeakMap<ImportGraph, Map<string, ImporterSyntax>>();

function importerSyntax(graph: ImportGraph, filePath: string, content: string): ImporterSyntax {
  let syntaxCache = importerSyntaxByGraph.get(graph);
  if (!syntaxCache) {
    syntaxCache = new Map();
    importerSyntaxByGraph.set(graph, syntaxCache);
  }
  let syntax = syntaxCache.get(filePath);
  if (!syntax) {
    syntax = { source: ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false) };
    syntaxCache.set(filePath, syntax);
  }
  return syntax;
}

interface SymbolReferenceOptions {
  graph: ImportGraph;
  modulePath: string;
  symbols: string[];
  read: (filePath: string) => string | undefined;
  exists?: (filePath: string) => boolean;
  fallbackExists?: (filePath: string) => boolean;
  includeReexporters?: boolean;
  stopAtReexporter?: (filePath: string) => boolean;
}

export function findSymbolImporters(options: SymbolReferenceOptions): string[] {
  return findSymbolReferences({ ...options, includeReexporters: false }).importers;
}

export function findSymbolReferences(options: SymbolReferenceOptions): {
  importers: string[];
  reexporters: string[];
  matchedReexporter?: string;
} {
  if (options.symbols.length === 0) return { importers: [], reexporters: [] };
  const exists = memoizeExists(options.exists ?? ((filePath: string) => options.graph.contents.has(filePath)));
  const importers = new Set<string>();
  const reexporters = new Set<string>();
  let matchedReexporter: string | undefined;
  const queue = [{ modulePath: options.modulePath, symbols: [...options.symbols].sort() }];
  let cursor = 0;
  const enqueued = new Set([`${options.modulePath}\0${queue[0].symbols.join("\0")}`]);
  while (cursor < queue.length) {
    const current = queue[cursor++];
    for (const importer of options.graph.importers.get(current.modulePath) ?? []) {
      const content = options.graph.contents.get(importer) ?? options.read(importer);
      if (!content) continue;
      const analysis = analyzeSymbolReferences(
        importerSyntax(options.graph, importer, content),
        current.modulePath,
        current.symbols,
        path.posix.dirname(toPosix(importer)),
        exists,
        options.fallbackExists
      );
      const exportedSymbols = analysis.reexported;
      if (current.modulePath === options.modulePath && (analysis.references || exportedSymbols.length > 0)) {
        importers.add(importer);
      }
      if (exportedSymbols.length === 0 || options.includeReexporters === false) continue;
      reexporters.add(importer);
      if (!matchedReexporter && options.stopAtReexporter?.(importer)) matchedReexporter = importer;
      const stateKey = `${importer}\0${exportedSymbols.join("\0")}`;
      if (!enqueued.has(stateKey)) {
        enqueued.add(stateKey);
        queue.push({ modulePath: importer, symbols: exportedSymbols });
      }
    }
    if (matchedReexporter) {
      return {
        importers: [...importers].sort(),
        reexporters: [...reexporters].sort(),
        matchedReexporter
      };
    }
  }
  return { importers: [...importers].sort(), reexporters: [...reexporters].sort() };
}

function analyzeSymbolReferences(
  syntax: ImporterSyntax,
  modulePath: string,
  symbols: readonly string[],
  fromDir: string,
  exists: (filePath: string) => boolean,
  fallbackExists?: (filePath: string) => boolean
): { references: boolean; reexported: string[] } {
  const symbolPaths = symbols.map((symbol) =>
    (symbol.startsWith("namespace:") ? symbol.slice("namespace:".length) : symbol).split(".").filter(Boolean)
  );
  const roots = new Set(symbolPaths.map((parts) => parts[0]).filter(Boolean));
  const pathsByRoot = new Map<string, string[][]>();
  for (const parts of symbolPaths) {
    const root = parts[0];
    if (!root) continue;
    const paths = pathsByRoot.get(root) ?? [];
    paths.push(parts);
    pathsByRoot.set(root, paths);
  }
  const localBindings = new Set<string>();
  const exported = new Set<string>();
  let references = false;
  const resolvesModule = (specifier: string): boolean => specifier.startsWith(".") &&
    resolveSpecifierWithFallback(fromDir, specifier, exists, fallbackExists) === modulePath;
  const qualifiedReferences = (): Set<string> => {
    syntax.qualifiedReferences ??= collectQualifiedReferenceKeys(syntax.source);
    return syntax.qualifiedReferences;
  };
  // Imports are collected first because module binding order is not semantic.
  for (const statement of syntax.source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesModule(statement.moduleSpecifier.text)) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name && roots.has("default")) {
        localBindings.add(clause.name.text);
        references = true;
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          const matchingPaths = pathsByRoot.get(imported);
          if (!matchingPaths) continue;
          localBindings.add(element.name.text);
          if (matchingPaths.some((parts) => parts.length === 1) || matchingPaths.some((parts) =>
            qualifiedReferences().has([element.name.text, ...parts.slice(1)].join(".")))) {
            references = true;
          }
        }
      } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        const namespaceName = clause.namedBindings.name.text;
        localBindings.add(namespaceName);
        if (symbolPaths.some((parts) => qualifiedReferences().has([namespaceName, ...parts].join(".")))) {
          references = true;
        }
      }
    } else if (ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteral(statement.moduleReference.expression) &&
      resolvesModule(statement.moduleReference.expression.text)) {
      localBindings.add(statement.name.text);
      if (roots.has("export=") || symbolPaths.some((parts) =>
        qualifiedReferences().has([statement.name.text, ...parts].join(".")))) {
        references = true;
      }
    }
  }
  for (const statement of syntax.source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        if (!resolvesModule(statement.moduleSpecifier.text)) continue;
        if (!statement.exportClause) {
          for (const root of roots) if (root !== "default") exported.add(root);
        } else if (ts.isNamespaceExport(statement.exportClause)) {
          exported.add(statement.exportClause.name.text);
        } else {
          for (const element of statement.exportClause.elements) {
            if (roots.has((element.propertyName ?? element.name).text)) exported.add(element.name.text);
          }
        }
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (localBindings.has((element.propertyName ?? element.name).text)) exported.add(element.name.text);
        }
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression) && localBindings.has(statement.expression.text)) {
      exported.add(statement.isExportEquals ? "export=" : "default");
    }
  }
  return { references, reexported: [...exported].sort() };
}

function collectQualifiedReferenceKeys(source: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  const parts = (node: ts.Node): string[] | undefined => {
    if (ts.isIdentifier(node)) return [node.text];
    if (ts.isPropertyAccessExpression(node)) {
      const prefix = parts(node.expression);
      return prefix ? [...prefix, node.name.text] : undefined;
    }
    if (ts.isQualifiedName(node)) {
      const prefix = parts(node.left);
      return prefix ? [...prefix, node.right.text] : undefined;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isQualifiedName(node)) {
      const pathParts = parts(node);
      if (pathParts) keys.add(pathParts.join("."));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}

function resolveSpecifierWithFallback(
  fromDir: string,
  specifier: string,
  exists: (path: string) => boolean,
  fallbackExists?: (path: string) => boolean
): string | undefined {
  return resolveSpecifier(fromDir, specifier, exists) ??
    (fallbackExists ? resolveSpecifier(fromDir, specifier, fallbackExists) : undefined);
}
