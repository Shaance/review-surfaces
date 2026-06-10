// review-surfaces.RANKING.1: a one-pass import resolver used to map a changed
// test file to the in-repo modules it imports, so the queue can tell whether a
// changed implementation path has a focused test changed alongside it. It parses
// with the same ts.createSourceFile approach the semantic-diff surface uses (a
// runtime dependency since the TS AST extractor), resolves only RELATIVE
// specifiers with simple suffix rules, and skips bare specifiers and path
// aliases (a documented v1 bound — the same altitude as the regex-era bounds).
//
// Phase 4 blast-radius (BLAST_RADIUS.1) is expected to extend this into a full
// reverse-import graph; for now it exposes just the forward resolver.
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
  // TS sources frequently import "./x.js" to mean the sibling "./x.ts"; drop a
  // trailing .js/.jsx/.mjs/.cjs before probing source extensions.
  const base = normalize(path.posix.join(fromDir, specifier)).replace(/\.(js|jsx|mjs|cjs)$/i, "");
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
