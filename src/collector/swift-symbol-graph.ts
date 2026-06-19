// review-surfaces.BLAST_RADIUS.4 — a bounded, target-aware Swift symbol graph.
//
// Swift files in one target do not import one another by path, so the TS relative-
// import resolver cannot be extended by extension. Instead we connect a file that
// REFERENCES a type/protocol/actor/enum to the file that DECLARES it, but only
// when that declaration is UNIQUE within the relevant target/module. Ambiguous
// names (declared in >1 file of the module), and any file past the cap, produce no
// edge — a partial graph never invents a "used by 0" (goal contract D6/D10). The
// precision label `unique_symbol_reference` tells renderers this is NOT a
// compiler-grade call graph.

import { compareStrings } from "../core/compare";
import { cleanSwiftSource } from "../risks/swift-lexer";
import { extractSwiftDeclarations } from "../risks/swift-declarations";
import { AppleProjectModel } from "./apple-project/model";

export interface SwiftSymbolGraph {
  // referrer file -> sorted files it depends on (declares a unique type it uses).
  edgesByFile: Map<string, string[]>;
  // declarer file -> sorted files that reference one of its unique types.
  importersByFile: Map<string, string[]>;
  // declarer file -> unique type NAME -> sorted files referencing THAT type, so a
  // per-declaration blast radius does not attribute every type's importers to one change.
  importersByFileType: Map<string, Map<string, string[]>>;
  // type NAME -> sorted files whose tokens reference it (PascalCase only). Used for a
  // REMOVED declaration whose declarer is gone from the head tree: head can no longer
  // resolve it as a unique declarer, but unchanged files still referencing the name are
  // the broken callers.
  referrersByType: Map<string, string[]>;
  precision: "unique_symbol_reference";
  truncated: boolean;
}

export const DEFAULT_SWIFT_GRAPH_FILE_CAP = 4000;

// Type-bearing declaration kinds — the v1 graph is type/protocol/actor/enum
// oriented (typealias too, since it names a referenced type).
const TYPE_KINDS = new Set(["class", "struct", "enum", "protocol", "actor", "typealias"]);

function isSwift(path: string): boolean {
  return path.toLowerCase().endsWith(".swift");
}

// The module (target id) a file belongs to. With a project model, a file is in the
// target whose source_paths contain it or prefix its directory; ties break by
// sorted target id. Without a model (or no match), all such files share the
// implicit module "" — uniqueness is then repo-wide, which is CONSERVATIVE (it can
// only merge would-be-separate modules, never split one, so it never invents a
// cross-target edge).
function moduleResolver(model: AppleProjectModel | undefined): (file: string) => string {
  if (!model || model.targets.length === 0) {
    return () => "";
  }
  const targets = model.targets
    .map((target) => ({ id: target.id, roots: target.source_paths.slice().sort(compareStrings) }))
    .sort((a, b) => compareStrings(a.id, b.id));
  return (file: string): string => {
    // Pick the MOST SPECIFIC (longest) matching root so a file under a nested target
    // (`Sources/AppTests` inside an app rooted at `Sources`) resolves to the nested
    // target, not the parent. Ties break by sorted target id (targets are pre-sorted).
    let bestId = "";
    let bestLen = -1;
    for (const target of targets) {
      for (const root of target.roots) {
        const r = root.replace(/\/$/, "");
        if ((file === r || file.startsWith(`${r}/`)) && r.length > bestLen) {
          bestLen = r.length;
          bestId = target.id;
        }
      }
    }
    return bestId;
  };
}

// targetId -> the set of target ids it depends on, transitively (excluding self).
function transitiveDeps(model: AppleProjectModel | undefined): Map<string, Set<string>> {
  const direct = new Map<string, string[]>();
  for (const target of model?.targets ?? []) {
    direct.set(target.id, target.dependency_target_ids);
  }
  const closure = new Map<string, Set<string>>();
  for (const id of direct.keys()) {
    const seen = new Set<string>();
    const stack = [...(direct.get(id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      for (const dep of direct.get(next) ?? []) {
        stack.push(dep);
      }
    }
    closure.set(id, seen);
  }
  return closure;
}

export function buildSwiftSymbolGraph(options: {
  files: string[];
  read: (filePath: string) => string | undefined;
  model?: AppleProjectModel;
  fileCap?: number;
}): SwiftSymbolGraph {
  const cap = options.fileCap ?? DEFAULT_SWIFT_GRAPH_FILE_CAP;
  const swiftFiles = options.files.filter(isSwift).sort(compareStrings);
  // When the FILE CAP is exceeded, uniqueness is computed over only the retained slice,
  // so a duplicate type beyond the cap could make a "unique" reference actually
  // ambiguous in the full module — that makes edges unsound, so we suppress them (and
  // carry the truncated flag) rather than emit a possibly-false attribution. A merely
  // model-truncated graph keeps its CONSERVATIVE repo-wide uniqueness edges.
  const fileCapExceeded = swiftFiles.length > cap;
  const truncated = fileCapExceeded || options.model?.truncated === true;
  const files = swiftFiles.slice(0, cap);
  const moduleOf = moduleResolver(options.model);

  const targetNames = new Set((options.model?.targets ?? []).map((t) => t.id));
  // The dependency closure VALIDATES an import (a file may only `import` a module its
  // target actually depends on); it does NOT, by itself, put another module's
  // declarations in scope — Swift requires an explicit `import`.
  const depClosure = transitiveDeps(options.model);

  // Per file: its module, the type names it declares, the identifier tokens it
  // contains (for reference scanning), and the module names it imports.
  interface FileInfo {
    module: string;
    tokens: Set<string>;
    visibleModules: Set<string>;
  }
  const info = new Map<string, FileInfo>();
  // module -> typeName -> set of declaring files.
  const declarersByModuleType = new Map<string, Map<string, Set<string>>>();

  for (const file of files) {
    const content = options.read(file);
    if (content === undefined) {
      continue;
    }
    const module = moduleOf(file);
    const cleaned = cleanSwiftSource(content);
    // Only NON-file-private types can be referenced from another file, so file-private /
    // private types must not enter the cross-file declarer index (a same-name token in
    // another file would otherwise become a false edge to this file).
    const declaredTypes = new Set(
      extractSwiftDeclarations(content)
        .filter((d) => TYPE_KINDS.has(d.kind) && d.visibility !== "private" && d.visibility !== "fileprivate")
        .map((d) => d.name)
    );
    // Reference tokens must EXCLUDE the module names on `import` lines: a test that only
    // `@testable import App` must not be read as referencing a type named `App` (a common
    // SwiftUI `@main struct App`). Import lines still feed module visibility below.
    const referenceText = cleaned.replace(/^[ \t]*(?:@testable[ \t]+)?import[ \t]+.*$/gm, "");
    const tokens = new Set(referenceText.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
    // Visible modules: the file's own module, plus every `import`ed name that is a project
    // target (a Swift target dependency does NOT put another module in scope without an
    // explicit `import` — so a dependency is visible only when actually imported, and the
    // dep closure just validates the import is a declared dependency).
    const ownDeps = depClosure.get(module);
    const modeled = module !== "";
    const visibleModules = new Set<string>([module]);
    for (const m of cleaned.matchAll(/(?:@testable\s+)?\bimport\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const imported = m[1];
      if (!targetNames.has(imported)) {
        continue;
      }
      // A MODELED file (resolved to a target) may only see a target it actually depends
      // on (or itself) — the model says other targets are unrelated. An UNMODELED file
      // (no matched target -> module "") stays permissive: honor any import of a known
      // target, since we lack the dependency data to validate it.
      if (!modeled || imported === module || (ownDeps?.has(imported) ?? false)) {
        visibleModules.add(imported);
      }
    }
    info.set(file, { module, tokens, visibleModules });
    let byType = declarersByModuleType.get(module);
    if (!byType) {
      byType = new Map();
      declarersByModuleType.set(module, byType);
    }
    for (const typeName of declaredTypes) {
      let set = byType.get(typeName);
      if (!set) {
        set = new Set();
        byType.set(typeName, set);
      }
      set.add(file);
    }
  }

  const edgesByFile = new Map<string, string[]>();
  const importersByFile = new Map<string, Set<string>>();
  // declarer file -> type name -> referrer files (for per-declaration blast radius).
  const importersByFileType = new Map<string, Map<string, Set<string>>>();
  // PascalCase token -> files referencing it (for removed-declaration blast radius).
  const referrersByType = new Map<string, Set<string>>();
  for (const [file, fileInfo] of truncated ? [] : info) {
    for (const token of fileInfo.tokens) {
      if (!/^[A-Z]/.test(token)) {
        continue; // Swift types are PascalCase; bound the index to type-like names.
      }
      let refs = referrersByType.get(token);
      if (!refs) {
        refs = new Set();
        referrersByType.set(token, refs);
      }
      refs.add(file);
    }
  }
  // Emit edges ONLY from a sound graph. Truncation (file cap exceeded OR a partial
  // project model) makes uniqueness/module membership unreliable, so a partial graph
  // emits no edges and carries the truncated flag instead of a possibly-false claim.
  for (const [file, fileInfo] of truncated ? [] : info) {
    const deps = new Set<string>();
    for (const token of fileInfo.tokens) {
      // Collect declaring files of `token` across every VISIBLE module; emit an
      // edge only when the union is exactly one file (≠ self). Ambiguity across
      // visible modules omits the edge (goal contract D6/D10).
      const declarers = new Set<string>();
      for (const module of fileInfo.visibleModules) {
        const declarer = declarersByModuleType.get(module)?.get(token);
        if (declarer) {
          for (const d of declarer) {
            declarers.add(d);
          }
        }
      }
      if (declarers.size === 1) {
        const only = [...declarers][0];
        if (only !== file) {
          deps.add(only);
          // Record the referrer against the SPECIFIC type `token` it referenced.
          let byType = importersByFileType.get(only);
          if (!byType) {
            byType = new Map();
            importersByFileType.set(only, byType);
          }
          let typeRefs = byType.get(token);
          if (!typeRefs) {
            typeRefs = new Set();
            byType.set(token, typeRefs);
          }
          typeRefs.add(file);
        }
      }
    }
    if (deps.size > 0) {
      edgesByFile.set(file, [...deps].sort(compareStrings));
      for (const declarer of deps) {
        let importers = importersByFile.get(declarer);
        if (!importers) {
          importers = new Set();
          importersByFile.set(declarer, importers);
        }
        importers.add(file);
      }
    }
  }

  return {
    edgesByFile,
    importersByFile: new Map([...importersByFile].map(([k, v]) => [k, [...v].sort(compareStrings)])),
    importersByFileType: new Map(
      [...importersByFileType].map(([file, byType]) => [file, new Map([...byType].map(([t, refs]) => [t, [...refs].sort(compareStrings)]))])
    ),
    referrersByType: new Map([...referrersByType].map(([t, refs]) => [t, [...refs].sort(compareStrings)])),
    precision: "unique_symbol_reference",
    truncated
  };
}
