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
    for (const target of targets) {
      for (const root of target.roots) {
        if (file === root || file.startsWith(`${root}/`) || file.startsWith(root.replace(/\/$/, "") + "/")) {
          return target.id;
        }
      }
    }
    return "";
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
  const truncated = swiftFiles.length > cap || options.model?.truncated === true;
  const files = swiftFiles.slice(0, cap);
  const moduleOf = moduleResolver(options.model);

  const targetNames = new Set((options.model?.targets ?? []).map((t) => t.id));
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
    const declaredTypes = new Set(extractSwiftDeclarations(content).filter((d) => TYPE_KINDS.has(d.kind)).map((d) => d.name));
    const tokens = new Set(cleaned.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
    // Visible modules: the file's own module, every module it depends on
    // (transitively), and every `import`ed name that is a project target — so a
    // test target's `@testable import App` lets it reference App's types.
    const visibleModules = new Set<string>([module, ...(depClosure.get(module) ?? [])]);
    for (const m of cleaned.matchAll(/(?:@testable\s+)?\bimport\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (targetNames.has(m[1])) {
        visibleModules.add(m[1]);
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
  for (const [file, fileInfo] of info) {
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
    precision: "unique_symbol_reference",
    truncated
  };
}
