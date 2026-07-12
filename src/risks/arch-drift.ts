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
// - Cycle detection searches the full HEAD concrete runtime file graph when the caller
//   supplies whole-tree edge keys (the CLI does), so a new edge whose return
//   path lives in unchanged code still reports; without them it falls back to
//   changed-file edges only. Pre-existing cycles are out of scope either way.
import { resolveRuntimeRelativeImports } from "../collector/import-graph";
import { clusterOfPath, DEFAULT_IMPLEMENTATION_ROOTS } from "../core/source-roots";

export type ArchDriftKind = "module_edge_added" | "module_edge_removed" | "import_cycle_created";

export interface ArchDriftFact {
  kind: ArchDriftKind;
  from_module: string;
  to_module: string;
  // The changed file(s) whose import sets produced the fact — the citing evidence.
  files: string[];
  detail: string;
  // For import_cycle_created: the proven runtime file chain, with the first
  // file repeated at the end to make closure explicit.
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
  resolveBaseImports?: typeof resolveRuntimeRelativeImports;
  resolveHeadImports?: typeof resolveRuntimeRelativeImports;
  // Module-edge sets over the WHOLE base/head trees (JSON.stringify([from, to])
  // keys), so a "new" module edge is judged against EVERY base import — not
  // just the changed files' own (the same file can already import the target
  // module elsewhere, or an unchanged file can carry the edge). Absent, novelty
  // falls back to the changed files' base imports (a weaker, documented bound).
  baseModuleEdgeKeys?: Set<string>;
  headModuleEdgeKeys?: Set<string>;
  // Whole-head runtime file graph (importer -> imported files). When present,
  // every cycle must be reproduced on this graph; directory aggregates alone
  // are never sufficient proof.
  baseFileDependencies?: Map<string, string[]>;
  headFileDependencies?: Map<string, string[]>;
  // review-surfaces.COLD_START.2: detected implementation roots so module
  // altitude agrees with the change-map clusters on any repository layout.
  implementationRoots?: readonly string[];
  // Cheap preflight for callers deciding whether whole-tree graphs are needed.
  // Skips module novelty and cycle analysis after exact changed-file deltas.
  fileEdgesOnly?: boolean;
}

// Module altitude = the shared cluster rule (source-roots.ts) so drift facts
// and the change map can never disagree on module names.
export function moduleOf(filePath: string, roots: readonly string[] = DEFAULT_IMPLEMENTATION_ROOTS): string {
  return clusterOfPath(filePath, roots);
}

export function computeArchDriftFacts(input: ComputeArchDriftInput): ArchDriftResult {
  const empty: ArchDriftResult = { facts: [], file_edges: { added: [], removed: [] } };
  const modOf = (filePath: string): string => moduleOf(filePath, input.implementationRoots);
  const files = [...input.changedFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const baseIdentityByHead = new Map(files
    .filter((file) => (file.status || "M").toUpperCase()[0] === "R" && file.old_path)
    .map((file) => [file.path, file.old_path as string]));
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
  const changedHeadDependencies = new Map<string, string[]>();
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
      ? new Set((input.resolveBaseImports ?? resolveRuntimeRelativeImports)(basePath, input.readBase(basePath) ?? "", input.existsBase))
      : new Set<string>();
    const headImports = headPath
      ? new Set((input.resolveHeadImports ?? resolveRuntimeRelativeImports)(headPath, input.readHead(headPath) ?? "", input.existsHead))
      : new Set<string>();
    const headImportsByBaseIdentity = new Map([...headImports].map((imported) => [
      baseIdentityByHead.get(imported) ?? imported,
      imported
    ]));

    if (headPath) {
      changedHeadDependencies.set(headPath, [...headImports].sort());
    }

    const headModule = modOf(file.path);
    for (const imported of headImports) {
      const target = modOf(imported);
      if (target !== headModule) {
        const targets = headModuleEdges.get(headModule) ?? new Set<string>();
        targets.add(target);
        headModuleEdges.set(headModule, targets);
      }
    }
    // Base-side module edges from the changed files — the novelty fallback
    // when no full-tree set is supplied (computed here, not in a second pass).
    const baseModuleForKeys = modOf(basePath ?? file.path);
    for (const imported of baseImports) {
      const toModule = modOf(imported);
      if (toModule !== baseModuleForKeys) {
        changedBaseKeys.add(JSON.stringify([baseModuleForKeys, toModule]));
      }
    }

    // File-level set difference on resolved targets. Translate renamed HEAD
    // targets to their BASE identity so a pure target move is not a new edge.
    for (const imported of headImports) {
      const baseIdentity = baseIdentityByHead.get(imported) ?? imported;
      if (!baseImports.has(baseIdentity)) {
        addedFileEdges.push({ importer: file.path, imported });
        recordModuleDelta(addedModuleEdges, headModule, modOf(imported), file.path);
      }
    }
    const baseModule = modOf(basePath ?? file.path);
    for (const imported of baseImports) {
      if (!headImportsByBaseIdentity.has(imported)) {
        removedFileEdges.push({ importer: file.path, imported });
        recordModuleDelta(removedModuleEdges, baseModule, modOf(imported), file.path);
      }
    }
  }

  if (input.fileEdgesOnly) {
    return { facts: [], file_edges: { added: addedFileEdges, removed: removedFileEdges } };
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

  // Cycle creation is a FILE-graph claim. A directory-level A -> B plus an
  // unrelated B -> A edge is not a cycle unless the imported file can reach
  // the importer. Search every newly added runtime edge (not merely novel
  // module edges), then canonicalize rotations so one cycle occupies one slot.
  const cycleEdges = input.headFileDependencies ?? changedHeadDependencies;
  const componentByFile = stronglyConnectedComponents(cycleEdges);
  const cycleCandidates = addedFileEdges.filter((edge) =>
    componentByFile.get(edge.imported) === componentByFile.get(edge.importer)
  );
  if (cycleCandidates.length === 0) {
    return { facts, file_edges: { added: addedFileEdges, removed: removedFileEdges } };
  }
  const baseComponentByFile = input.baseFileDependencies
    ? stronglyConnectedComponents(input.baseFileDependencies)
    : undefined;
  const reverseCycleEdges = reverseEdges(cycleEdges);
  const cycles = new Map<string, ArchDriftFact>();
  let currentImporter = "";
  let currentPaths = new Map<string, string>();
  for (const edge of cycleCandidates) {
    const baseImporter = baseIdentityByHead.get(edge.importer) ?? edge.importer;
    const baseImported = baseIdentityByHead.get(edge.imported) ?? edge.imported;
    const baseImporterComponent = baseComponentByFile?.get(baseImporter);
    const baseAlreadyCyclic = baseImporter === baseImported
      ? input.baseFileDependencies?.get(baseImporter)?.includes(baseImported) === true
      : baseImporterComponent !== undefined &&
        baseComponentByFile?.get(baseImported) === baseImporterComponent;
    if (baseAlreadyCyclic) continue;
    if (edge.importer !== currentImporter) {
      currentImporter = edge.importer;
      currentPaths = pathsToGoal(edge.importer, reverseCycleEdges);
    }
    const returnPath = reconstructPath(edge.imported, edge.importer, currentPaths);
    if (!returnPath) continue;
    const chain = [edge.importer, ...returnPath];
    const canonical = canonicalCycle(chain);
    const key = JSON.stringify(canonical);
    const existing = cycles.get(key);
    if (existing) {
      existing.files = [...new Set([...existing.files, edge.importer])].sort();
      continue;
    }
    cycles.set(key, {
      kind: "import_cycle_created",
      from_module: modOf(canonical[0]),
      to_module: modOf(canonical[1]),
      files: [edge.importer],
      detail: `runtime import cycle created: ${canonical.join(" -> ")}`,
      cycle: canonical
    });
  }
  facts.push(...[...cycles.values()].sort((a, b) => (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0)));

  return { facts, file_edges: { added: addedFileEdges, removed: removedFileEdges } };
}

function stronglyConnectedComponents(edges: Map<string, string[]>): Map<string, number> {
  const nodes = new Set<string>();
  for (const [from, targets] of edges) {
    nodes.add(from);
    for (const target of targets) nodes.add(target);
  }
  const indexByNode = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const componentByNode = new Map<string, number>();
  let nextIndex = 0;
  let nextComponent = 0;
  const visit = (node: string): void => {
    indexByNode.set(node, nextIndex);
    lowLink.set(node, nextIndex++);
    stack.push(node);
    onStack.add(node);
    for (const target of edges.get(node) ?? []) {
      if (!indexByNode.has(target)) {
        visit(target);
        lowLink.set(node, Math.min(lowLink.get(node) as number, lowLink.get(target) as number));
      } else if (onStack.has(target)) {
        lowLink.set(node, Math.min(lowLink.get(node) as number, indexByNode.get(target) as number));
      }
    }
    if (lowLink.get(node) !== indexByNode.get(node)) return;
    while (stack.length > 0) {
      const member = stack.pop() as string;
      onStack.delete(member);
      componentByNode.set(member, nextComponent);
      if (member === node) break;
    }
    nextComponent += 1;
  };
  for (const node of [...nodes].sort()) if (!indexByNode.has(node)) visit(node);
  return componentByNode;
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

// BFS path target..->..origin over the concrete file edge map; returns the path
// (including target and origin) when the added edge origin->target closes a
// cycle, else undefined. Deterministic: neighbors visited in sorted order.
function reverseEdges(edges: Map<string, string[]>): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [from, targets] of edges) {
    for (const target of targets) {
      const predecessors = reverse.get(target) ?? [];
      predecessors.push(from);
      reverse.set(target, predecessors);
    }
  }
  for (const predecessors of reverse.values()) predecessors.sort();
  return reverse;
}

function pathsToGoal(goal: string, reverse: Map<string, string[]>): Map<string, string> {
  const queue: string[] = [goal];
  const nextHop = new Map<string, string>();
  const seen = new Set<string>([goal]);
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    for (const predecessor of reverse.get(node) ?? []) {
      if (!seen.has(predecessor)) {
        seen.add(predecessor);
        nextHop.set(predecessor, node);
        queue.push(predecessor);
      }
    }
  }
  return nextHop;
}

function reconstructPath(start: string, goal: string, nextHop: Map<string, string>): string[] | undefined {
  const path = [start];
  while (path[path.length - 1] !== goal) {
    const next = nextHop.get(path[path.length - 1]);
    if (!next) return undefined;
    path.push(next);
  }
  return path;
}

// Rotate a directed closed chain to its lexicographically smallest start. Do
// not reverse it: direction is part of the runtime dependency fact.
function canonicalCycle(chain: string[]): string[] {
  const nodes = chain.slice(0, -1);
  let start = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    if (nodes[index] < nodes[start]) start = index;
  }
  const canonical = [...nodes.slice(start), ...nodes.slice(0, start)];
  return [...canonical, canonical[0]];
}
