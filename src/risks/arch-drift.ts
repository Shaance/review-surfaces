// review-surfaces.ARCH_DRIFT.1-3: deterministic architecture-drift facts. For
// each changed/deleted file, parse the BASE content with the same import
// extraction the import graph already uses, diff the resolved import sets, and
// aggregate to module altitude (top-level directory, with src/ files grouped by
// their directory under src/) — a new file-level edge is noise, a new
// MODULE-boundary edge is signal. Follows the semantic-diff detector shape.
//
// Bounds, documented like the import graph's own (BLAST_RADIUS.1):
// - Only relative imports resolve; path-alias/bare specifiers are skipped by
//   the shared resolver, so they count as UNKNOWN — never as added or removed.
// - Rename detection is respected: a moved file re-creating its old edges from
//   the new path is not drift (the base side is read at the rename SOURCE).
// - Cycle detection searches the full HEAD module graph when the caller
//   supplies whole-tree edge keys (the CLI does), so a new edge whose return
//   path lives in unchanged code still reports; without them it falls back to
//   changed-file edges only. Pre-existing cycles are out of scope either way.
import { resolveRelativeImports } from "../collector/import-graph";

export type ArchDriftKind = "module_edge_added" | "module_edge_removed" | "import_cycle_created";

export interface ArchDriftFact {
  kind: ArchDriftKind;
  from_module: string;
  to_module: string;
  // The changed file(s) whose import sets produced the fact — the citing evidence.
  files: string[];
  detail: string;
  // For import_cycle_created: the module cycle, starting at from_module.
  cycle?: string[];
}

export interface ArchDriftFileEdges {
  added: Array<{ importer: string; imported: string }>;
  removed: Array<{ importer: string; imported: string }>;
}

export interface ArchDriftResult {
  facts: ArchDriftFact[];
  // File-level edge deltas for the change-graph renderers (ARCH_DRIFT.2):
  // kind "new"/"removed" on matching change_graph edges.
  file_edges: ArchDriftFileEdges;
}

export interface ComputeArchDriftInput {
  changedFiles: Array<{ path: string; old_path?: string; status: string }>;
  readBase: (filePath: string) => string | undefined;
  readHead: (filePath: string) => string | undefined;
  existsBase: (filePath: string) => boolean;
  existsHead: (filePath: string) => boolean;
  // Module-edge sets over the WHOLE base/head trees (JSON.stringify([from, to])
  // keys), so a "new" module edge is judged against EVERY base import — not
  // just the changed files' own (the same file can already import the target
  // module elsewhere, or an unchanged file can carry the edge). Absent, novelty
  // falls back to the changed files' base imports (a weaker, documented bound).
  baseModuleEdgeKeys?: Set<string>;
  headModuleEdgeKeys?: Set<string>;
}

export function moduleOf(filePath: string): string {
  const segments = filePath.split("/");
  if (segments.length === 1) {
    return "(root)";
  }
  if (segments[0] === "src" && segments.length > 2) {
    return `src/${segments[1]}`;
  }
  return segments[0];
}

export function computeArchDriftFacts(input: ComputeArchDriftInput): ArchDriftResult {
  const empty: ArchDriftResult = { facts: [], file_edges: { added: [], removed: [] } };
  const files = [...input.changedFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (files.length === 0) {
    return empty;
  }

  const addedFileEdges: Array<{ importer: string; imported: string }> = [];
  const removedFileEdges: Array<{ importer: string; imported: string }> = [];
  // Module-edge aggregation: edge key -> contributing files.
  const addedModuleEdges = new Map<string, Set<string>>();
  const removedModuleEdges = new Map<string, Set<string>>();
  // Head-side module edges contributed by changed files (cycle detection input).
  const headModuleEdges = new Map<string, Set<string>>();
  // Base-side module edges from the changed files (novelty fallback set).
  const changedBaseKeys = new Set<string>();

  for (const file of files) {
    const status = (file.status || "M").toUpperCase()[0];
    // Base identity: the rename source ONLY for true renames (a moved file
    // re-creating its old edges is NOT drift — same resolved targets). A COPY
    // is an additional importer: comparing it against its source would
    // suppress the genuinely new edges it introduces, so copies (like
    // additions and untracked files) get an empty base side.
    const basePath = status === "R" ? file.old_path ?? file.path : status === "A" || status === "?" || status === "C" ? undefined : file.path;
    const headPath = status === "D" ? undefined : file.path;

    const baseImports = basePath
      ? new Set(resolveRelativeImports(basePath, input.readBase(basePath) ?? "", input.existsBase))
      : new Set<string>();
    const headImports = headPath
      ? new Set(resolveRelativeImports(headPath, input.readHead(headPath) ?? "", input.existsHead))
      : new Set<string>();

    const headModule = moduleOf(file.path);
    for (const imported of headImports) {
      const target = moduleOf(imported);
      if (target !== headModule) {
        const targets = headModuleEdges.get(headModule) ?? new Set<string>();
        targets.add(target);
        headModuleEdges.set(headModule, targets);
      }
    }
    // Base-side module edges from the changed files — the novelty fallback
    // when no full-tree set is supplied (computed here, not in a second pass).
    const baseModuleForKeys = moduleOf(basePath ?? file.path);
    for (const imported of baseImports) {
      const toModule = moduleOf(imported);
      if (toModule !== baseModuleForKeys) {
        changedBaseKeys.add(JSON.stringify([baseModuleForKeys, toModule]));
      }
    }

    // File-level set difference on resolved targets (rename-safe: both sides
    // are RESOLVED repo-relative module paths, so a pure move keeps them equal).
    for (const imported of headImports) {
      if (!baseImports.has(imported)) {
        addedFileEdges.push({ importer: file.path, imported });
        recordModuleDelta(addedModuleEdges, headModule, moduleOf(imported), file.path);
      }
    }
    const baseModule = moduleOf(basePath ?? file.path);
    for (const imported of baseImports) {
      if (!headImports.has(imported)) {
        removedFileEdges.push({ importer: file.path, imported });
        recordModuleDelta(removedModuleEdges, baseModule, moduleOf(imported), file.path);
      }
    }
  }

  // Module-edge NOVELTY: a fact fires only when the module edge is absent from
  // the base tree's edges (full-tree set when provided, else the changed files'
  // own base edges). Symmetrically, "removed" requires absence at head.
  const baseKeys = input.baseModuleEdgeKeys ?? changedBaseKeys;
  const headKeys = input.headModuleEdgeKeys ?? new Set([...headModuleEdges.entries()].flatMap(([from, targets]) => [...targets].map((to) => JSON.stringify([from, to]))));

  const facts: ArchDriftFact[] = [];
  for (const [key, contributors] of [...addedModuleEdges.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (baseKeys.has(key)) {
      continue;
    }
    const [from, to] = JSON.parse(key) as [string, string];
    facts.push({
      kind: "module_edge_added",
      from_module: from,
      to_module: to,
      files: [...contributors].sort(),
      detail: `new dependency edge: ${from} -> ${to} — no import between these modules existed at the base`
    });
  }
  for (const [key, contributors] of [...removedModuleEdges.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (headKeys.has(key)) {
      continue;
    }
    const [from, to] = JSON.parse(key) as [string, string];
    facts.push({
      kind: "module_edge_removed",
      from_module: from,
      to_module: to,
      files: [...contributors].sort(),
      detail: `removed dependency edge: ${from} -> ${to} — the base imported across this module boundary`
    });
  }

  // Cycle creation: does any ADDED module edge close a cycle in the HEAD
  // module graph? The full-tree head edge set is used when available, so a new
  // A -> B edge whose return path B -> A lives in UNCHANGED code still reports;
  // without the full set the search falls back to changed-file edges (bound).
  const cycleEdges = new Map<string, Set<string>>(headModuleEdges);
  if (input.headModuleEdgeKeys) {
    for (const key of input.headModuleEdgeKeys) {
      const [from, to] = JSON.parse(key) as [string, string];
      const targets = cycleEdges.get(from) ?? new Set<string>();
      targets.add(to);
      cycleEdges.set(from, targets);
    }
  }
  for (const fact of facts.filter((candidate) => candidate.kind === "module_edge_added")) {
    const cycle = findCycle(fact.to_module, fact.from_module, cycleEdges);
    if (cycle) {
      facts.push({
        kind: "import_cycle_created",
        from_module: fact.from_module,
        to_module: fact.to_module,
        files: fact.files,
        detail: `import cycle created: ${[fact.from_module, ...cycle].join(" -> ")}`,
        cycle: [fact.from_module, ...cycle]
      });
    }
  }

  return { facts, file_edges: { added: addedFileEdges, removed: removedFileEdges } };
}

function recordModuleDelta(map: Map<string, Set<string>>, from: string, to: string, file: string): void {
  if (from === to) {
    return;
  }
  const key = JSON.stringify([from, to]);
  const contributors = map.get(key) ?? new Set<string>();
  contributors.add(file);
  map.set(key, contributors);
}

// BFS path target..->..origin over the module edge map; returns the path
// (including target and origin) when the added edge origin->target closes a
// cycle, else undefined. Deterministic: neighbors visited in sorted order.
function findCycle(start: string, goal: string, edges: Map<string, Set<string>>): string[] | undefined {
  const queue: string[][] = [[start]];
  const seen = new Set<string>([start]);
  while (queue.length > 0) {
    const path = queue.shift() as string[];
    const node = path[path.length - 1];
    if (node === goal) {
      return path;
    }
    for (const next of [...(edges.get(node) ?? [])].sort()) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push([...path, next]);
      }
    }
  }
  return undefined;
}
