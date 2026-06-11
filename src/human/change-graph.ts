// review-surfaces.CHANGE_MAP.1 + READING_ORDER.1: build the change-graph model
// and the guided diff tour from the SAME deterministic inputs — changed files
// (churn, status), the import graph restricted to changed files, blast-radius
// used_by facts, and the computed lens findings / review queue. No new parsing
// happens here: the import edges come from buildImportGraph() output.
import { buildImportGraph } from "../collector/import-graph";
import { compareStrings } from "../core/compare";
import {
  ChangeGraph,
  ChangeGraphEdge,
  ChangeGraphHaloNode,
  ChangeGraphNode,
  ChangeGraphNodeStatus,
  ReadingOrder,
  ReadingOrderLeg,
  ReviewQueueItem,
  RiskLens,
  RiskLensFinding,
  RISK_LENS_METADATA
} from "./contract";

export interface ChangedFileFacts {
  path: string;
  old_path?: string;
  status: string; // raw git status letter (A/M/D/R/C...)
  added: number;
  removed: number;
}

export interface ChangedImportEdge {
  importer: string;
  imported: string;
}

// Compute importer->imported edges among the changed files only, using the
// shared import-graph parser over head-side content (a deleted file has no
// head content, so it carries no outgoing edges — a documented v1 bound, same
// altitude as the import graph's alias bound).
export function computeChangedImportEdges(options: {
  changedPaths: string[];
  read: (filePath: string) => string | undefined;
  exists: (filePath: string) => boolean;
}): ChangedImportEdge[] {
  const changed = new Set(options.changedPaths);
  const graph = buildImportGraph({ files: options.changedPaths, read: options.read, exists: options.exists });
  const edges: ChangedImportEdge[] = [];
  for (const [imported, importers] of [...graph.importers.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (!changed.has(imported)) {
      continue;
    }
    for (const importer of importers) {
      if (changed.has(importer) && importer !== imported) {
        edges.push({ importer, imported });
      }
    }
  }
  return edges;
}

const MAX_HALO_PER_NODE = 2;

interface BuildSectionsInput {
  files: ChangedFileFacts[];
  edges: ChangedImportEdge[];
  // Blast-radius facts: changed path -> its bounded used_by.top importer list.
  usedBy: Array<{ path: string; top: string[] }>;
  lensFindings: RiskLensFinding[];
  reviewQueue: ReviewQueueItem[];
  // review-surfaces.ARCH_DRIFT.2: file-level edge deltas from the drift
  // detector. Added edges flip matching graph edges to kind "new"; removed
  // edges (present at base only) are appended as kind "removed" when both
  // endpoints are changed files.
  driftEdges?: {
    added: ChangedImportEdge[];
    removed: ChangedImportEdge[];
  };
}

export function buildChangeGraphSections(input: BuildSectionsInput): { change_graph: ChangeGraph; reading_order: ReadingOrder } {
  const files = [...input.files].sort((a, b) => compareStrings(a.path, b.path));
  const changedSet = new Set(files.map((file) => file.path));
  const edges = dedupeEdges(input.edges, changedSet);
  // ARCH_DRIFT.2: annotate kinds. The added set marks existing head edges as
  // new; removed base-only edges are appended (deduped against head edges).
  if (input.driftEdges) {
    const addedKeys = new Set(input.driftEdges.added.map((edge) => JSON.stringify([edge.importer, edge.imported])));
    for (const edge of edges) {
      if (addedKeys.has(JSON.stringify([edge.from, edge.to]))) {
        edge.kind = "new";
      }
    }
    const headKeys = new Set(edges.map((edge) => JSON.stringify([edge.from, edge.to])));
    for (const removed of [...input.driftEdges.removed].sort((a, b) => compareStrings(a.importer, b.importer) || compareStrings(a.imported, b.imported))) {
      const key = JSON.stringify([removed.importer, removed.imported]);
      if (changedSet.has(removed.importer) && changedSet.has(removed.imported) && removed.importer !== removed.imported && !headKeys.has(key)) {
        headKeys.add(key);
        edges.push({ from: removed.importer, to: removed.imported, kind: "removed" });
      }
    }
    edges.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));
  }
  // The tour orders by HEAD dependencies only: a removed edge is not a current
  // dependency and must not influence the topological order.
  const readingOrder = buildReadingOrder(files, edges.filter((edge) => edge.kind !== "removed"), input.reviewQueue);
  const tourIndex = new Map<string, number>();
  for (const leg of readingOrder.legs) {
    for (const step of leg.steps) {
      tourIndex.set(step.path, tourIndex.size);
    }
  }
  const lensByPath = dominantLensByPath(input.lensFindings, changedSet);

  const nodes: ChangeGraphNode[] = files.map((file) => ({
    path: file.path,
    ...(file.old_path ? { old_path: file.old_path } : {}),
    churn_added: file.added,
    churn_removed: file.removed,
    status: normalizeStatus(file.status),
    cluster: clusterOf(file.path),
    ...(lensByPath.has(file.path) ? { lens: lensByPath.get(file.path) } : {})
  }));

  // Halo: unchanged importers from blast-radius facts, first K<=2 per
  // high-blast node, exactly as the fact's bounded used_by.top stores them.
  const haloByImporter = new Map<string, Set<string>>();
  for (const fact of [...input.usedBy].sort((a, b) => compareStrings(a.path, b.path))) {
    if (!changedSet.has(fact.path)) {
      continue;
    }
    let taken = 0;
    for (const importer of fact.top) {
      if (changedSet.has(importer)) {
        continue;
      }
      if (taken >= MAX_HALO_PER_NODE) {
        break;
      }
      taken += 1;
      const imports = haloByImporter.get(importer) ?? new Set<string>();
      imports.add(fact.path);
      haloByImporter.set(importer, imports);
    }
  }
  const haloNodes: ChangeGraphHaloNode[] = [...haloByImporter.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([importer, imports]) => ({ path: importer, imports: [...imports].sort(compareStrings) }));

  // Clusters in tour-first-appearance order (CHANGE_MAP.3: the map's
  // left-to-right flow agrees with the tour's numbering).
  const clusterOrder: string[] = [];
  const clusterPaths = new Map<string, string[]>();
  const byTour = [...nodes].sort((a, b) => (tourIndex.get(a.path) ?? 0) - (tourIndex.get(b.path) ?? 0));
  for (const node of byTour) {
    if (!clusterPaths.has(node.cluster)) {
      clusterOrder.push(node.cluster);
      clusterPaths.set(node.cluster, []);
    }
  }
  for (const node of nodes) {
    clusterPaths.get(node.cluster)?.push(node.path);
  }

  return {
    change_graph: {
      nodes,
      halo_nodes: haloNodes,
      edges,
      clusters: clusterOrder.map((name) => ({ name, paths: clusterPaths.get(name) ?? [] }))
    },
    reading_order: readingOrder
  };
}

function dedupeEdges(edges: ChangedImportEdge[], changed: Set<string>): ChangeGraphEdge[] {
  const seen = new Set<string>();
  const result: ChangeGraphEdge[] = [];
  for (const edge of edges) {
    if (!changed.has(edge.importer) || !changed.has(edge.imported) || edge.importer === edge.imported) {
      continue;
    }
    // Unambiguous tuple key: a single-space join collides for paths containing
    // spaces ("a b"+"c" vs "a"+"b c") and would silently drop a real edge.
    const key = JSON.stringify([edge.imported, edge.importer]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // Contract direction (CHANGE_MAP.1): from = importer, to = imported.
    result.push({ from: edge.importer, to: edge.imported, kind: "existing" });
  }
  return result.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));
}

function normalizeStatus(raw: string): ChangeGraphNodeStatus {
  const letter = (raw || "M").toUpperCase()[0];
  // Porcelain "??" (untracked working-tree file) and copies are add-like.
  if (letter === "A" || letter === "?" || letter === "C") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R") return "renamed";
  return "modified";
}

function clusterOf(filePath: string): string {
  const segments = filePath.split("/");
  if (segments.length === 1) {
    return "(root)";
  }
  if (segments[0] === "src" && segments.length > 2) {
    return `src/${segments[1]}`;
  }
  return segments[0];
}

// Dominant lens per path: the lens whose metadata rank is lowest (most
// important) among findings citing the path; ties broken by finding id.
function dominantLensByPath(findings: RiskLensFinding[], changed: Set<string>): Map<string, RiskLens> {
  const best = new Map<string, { lens: RiskLens; rank: number; id: string }>();
  for (const finding of [...findings].sort((a, b) => compareStrings(a.id, b.id))) {
    const rank = RISK_LENS_METADATA[finding.lens]?.rank ?? Number.MAX_SAFE_INTEGER;
    for (const filePath of finding.paths) {
      if (!changed.has(filePath)) {
        continue;
      }
      const current = best.get(filePath);
      if (!current || rank < current.rank || (rank === current.rank && compareStrings(finding.id, current.id) < 0)) {
        best.set(filePath, { lens: finding.lens, rank, id: finding.id });
      }
    }
  }
  return new Map([...best.entries()].map(([filePath, entry]) => [filePath, entry.lens]));
}

// ---------------------------------------------------------------------------
// Reading order (READING_ORDER.1): condense the changed-file import graph into
// strongly connected components, topologically sort dependencies-first with a
// deterministic alphabetical frontier, then group consecutive same-category
// units into legs. Cycles collapse into one read-together leg.

type LegCategory = "contracts" | "implementation" | "tests" | "config";

const LEG_TITLES: Record<LegCategory, string> = {
  contracts: "Contracts and schemas",
  implementation: "Implementation",
  tests: "Tests",
  config: "Config and docs"
};

function categoryOf(filePath: string): LegCategory {
  const top = filePath.split("/")[0];
  if (top === "schemas" || top === "features" || filePath.endsWith(".schema.json")) {
    return "contracts";
  }
  // Test classification first: a co-located src/foo.test.ts is a test, not
  // implementation — otherwise the tour breaks "tests after code".
  if (top === "tests" || top === "test" || /\.(test|spec)\.[jt]sx?$/.test(filePath)) {
    return "tests";
  }
  if (top === "src" || top === "bin" || top === "lib") {
    return "implementation";
  }
  return "config";
}

function buildReadingOrder(files: ChangedFileFacts[], edges: ChangeGraphEdge[], queue: ReviewQueueItem[]): ReadingOrder {
  if (files.length === 0) {
    return { legs: [] };
  }
  const paths = files.map((file) => file.path);
  const components = stronglyConnectedComponents(paths, edges);
  const componentOf = new Map<string, number>();
  components.forEach((members, index) => {
    for (const member of members) {
      componentOf.set(member, index);
    }
  });

  // Condensation edges: dependency component -> dependent component. Model
  // edges are importer -> imported (CHANGE_MAP.1), so the dependency side of
  // the topo edge is edge.to and the dependent side edge.from.
  const out = new Map<number, Set<number>>();
  const indegree = new Map<number, number>();
  components.forEach((_, index) => indegree.set(index, 0));
  for (const edge of edges) {
    const from = componentOf.get(edge.to);
    const to = componentOf.get(edge.from);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    const targets = out.get(from) ?? new Set<number>();
    if (!targets.has(to)) {
      targets.add(to);
      out.set(from, targets);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }
  }

  // Kahn with a deterministic frontier: where the import graph imposes no
  // constraint, category priority breaks ties (contracts -> implementation ->
  // tests -> config/docs, the brainstorm's leg order), then alphabetical. The
  // result stays total, deterministic, and dependencies-first.
  const CATEGORY_PRIORITY: Record<LegCategory, number> = { contracts: 0, implementation: 1, tests: 2, config: 3 };
  const frontierKey = (index: number): string => `${CATEGORY_PRIORITY[categoryOf(components[index][0])]} ${components[index][0]}`;
  const frontier = components
    .map((_, index) => index)
    .filter((index) => (indegree.get(index) ?? 0) === 0);
  const ordered: number[] = [];
  while (frontier.length > 0) {
    frontier.sort((a, b) => compareStrings(frontierKey(a), frontierKey(b)));
    const next = frontier.shift() as number;
    ordered.push(next);
    for (const target of [...(out.get(next) ?? [])].sort((a, b) => a - b)) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        frontier.push(target);
      }
    }
  }

  const importerCount = new Map<string, number>();
  const dependencyCount = new Map<string, number>();
  for (const edge of edges) {
    // edge.to is the imported file (gains an importer); edge.from the importer
    // (gains a dependency).
    importerCount.set(edge.to, (importerCount.get(edge.to) ?? 0) + 1);
    dependencyCount.set(edge.from, (dependencyCount.get(edge.from) ?? 0) + 1);
  }
  // Queue cross-links: a rename-source-anchored item carries the OLD path, but
  // the tour step is emitted for the current path — map old_path back so the
  // cross-link survives renames.
  const currentPathByAlias = new Map<string, string>();
  for (const file of files) {
    if (file.old_path) {
      currentPathByAlias.set(file.old_path, file.path);
    }
  }
  // A current path that collides with another file's old_path wins.
  for (const file of files) {
    currentPathByAlias.set(file.path, file.path);
  }
  const queueRefs = new Map<string, string[]>();
  for (const item of [...queue].sort((a, b) => a.rank - b.rank)) {
    const target = currentPathByAlias.get(item.path) ?? item.path;
    const refs = queueRefs.get(target) ?? [];
    refs.push(item.id);
    queueRefs.set(target, refs);
  }
  const statusByPath = new Map(files.map((file) => [file.path, normalizeStatus(file.status)]));

  const legs: ReadingOrderLeg[] = [];
  for (const componentIndex of ordered) {
    const members = components[componentIndex];
    if (members.length > 1) {
      // A real import cycle: one read-together leg, alphabetical inside.
      legs.push({
        title: "Import cycle — read together",
        read_together: true,
        steps: members.map((member) => ({
          path: member,
          why: `forms an import cycle with ${members.length - 1} other changed file(s)`,
          queue_refs: queueRefs.get(member) ?? []
        }))
      });
      continue;
    }
    const member = members[0];
    const category = categoryOf(member);
    const why = deriveWhy(member, category, statusByPath.get(member) ?? "modified", importerCount.get(member) ?? 0, dependencyCount.get(member) ?? 0);
    const step = { path: member, why, queue_refs: queueRefs.get(member) ?? [] };
    const last = legs[legs.length - 1];
    if (last && !last.read_together && last.title === LEG_TITLES[category]) {
      last.steps.push(step);
    } else {
      legs.push({ title: LEG_TITLES[category], read_together: false, steps: [step] });
    }
  }
  return { legs };
}

// The why line is derived, never freeform (READING_ORDER.1).
function deriveWhy(filePath: string, category: LegCategory, status: ChangeGraphNodeStatus, importers: number, dependencies: number): string {
  if (status === "deleted") {
    return "deleted — review what replaced its role";
  }
  if (category === "tests") {
    return dependencies > 0 ? `test — read after the ${dependencies} changed file(s) it imports` : "test — read after the code it covers";
  }
  if (category === "config") {
    return "config or docs — read last";
  }
  if (importers > 0) {
    return `imported by ${importers} changed file(s)`;
  }
  if (dependencies > 0) {
    return `imports ${dependencies} changed file(s); read after its dependencies`;
  }
  return "no import relation among changed files";
}

// Iterative Tarjan over the changed-file graph. Components are returned with
// members sorted alphabetically; component list order is irrelevant (the topo
// pass orders them).
function stronglyConnectedComponents(paths: string[], edges: ChangeGraphEdge[]): string[][] {
  const sorted = [...paths].sort((a, b) => compareStrings(a, b));
  const adjacency = new Map<string, string[]>();
  for (const node of sorted) {
    adjacency.set(node, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }
  for (const list of adjacency.values()) {
    list.sort((a, b) => compareStrings(a, b));
  }

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of sorted) {
    if (index.has(root)) {
      continue;
    }
    // Explicit work stack: [node, child pointer]
    const work: Array<[string, number]> = [[root, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [node, pointer] = frame;
      if (pointer === 0) {
        index.set(node, counter);
        lowlink.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
      }
      const neighbors = adjacency.get(node) ?? [];
      if (pointer < neighbors.length) {
        frame[1] += 1;
        const neighbor = neighbors[pointer];
        if (!index.has(neighbor)) {
          work.push([neighbor, 0]);
        } else if (onStack.has(neighbor)) {
          lowlink.set(node, Math.min(lowlink.get(node) as number, index.get(neighbor) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowlink.set(parent[0], Math.min(lowlink.get(parent[0]) as number, lowlink.get(node) as number));
      }
      if (lowlink.get(node) === index.get(node)) {
        const members: string[] = [];
        for (;;) {
          const member = stack.pop() as string;
          onStack.delete(member);
          members.push(member);
          if (member === node) {
            break;
          }
        }
        components.push(members.sort((a, b) => compareStrings(a, b)));
      }
    }
  }
  return components;
}
