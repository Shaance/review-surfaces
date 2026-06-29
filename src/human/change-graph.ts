// review-surfaces.CHANGE_MAP.1 + READING_ORDER.1: build the change-graph model
// and the guided diff tour from the SAME deterministic inputs — changed files
// (churn, status), the import graph restricted to changed files, blast-radius
// used_by facts, and the computed lens findings / review queue. No new parsing
// happens here: the import edges come from buildImportGraph() output.
import { buildImportGraph } from "../collector/import-graph";
import { compareStrings } from "../core/compare";
import { clusterOfPath, DEFAULT_IMPLEMENTATION_ROOTS } from "../core/source-roots";
import {
  ChangeGraph,
  ChangeGraphCluster,
  ChangeGraphEdge,
  ChangeGraphInsightSource,
  ChangeGraphHaloNode,
  ChangeGraphNode,
  ChangeGraphNodeStatus,
  ChangeGraphOverview,
  ChangeGraphOverviewEdge,
  ChangeGraphOverviewGroup,
  ChangeGraphTopicGroup,
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

export interface ChangeGraphEdgeInsight {
  from: string;
  to: string;
  summary: string;
  detail?: string;
  source: ChangeGraphInsightSource;
}

export interface ChangeGraphTopicInsight {
  label: string;
  summary: string;
  paths: string[];
  source: ChangeGraphInsightSource;
}

export interface ChangeGraphAreaInsight {
  name: string;
  summary: string;
  detail?: string;
  topics?: ChangeGraphTopicInsight[];
  source: ChangeGraphInsightSource;
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
  edgeInsights?: ChangeGraphEdgeInsight[];
  areaInsights?: ChangeGraphAreaInsight[];
  // review-surfaces.COLD_START.2: implementation roots detected from the target
  // repo's own signals. One value feeds BOTH the clusters and the tour's file
  // categorization so map and tour stay in agreement on any layout.
  implementationRoots?: readonly string[];
}

export function buildChangeGraphSections(input: BuildSectionsInput): { change_graph: ChangeGraph; reading_order: ReadingOrder } {
  const roots = input.implementationRoots ?? DEFAULT_IMPLEMENTATION_ROOTS;
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
        edges.push(edgeWithFallback({ from: removed.importer, to: removed.imported, kind: "removed" }));
      }
    }
    edges.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));
  }
  applyEdgeInsights(edges, input.edgeInsights ?? []);
  // The tour orders by HEAD dependencies only: a removed edge is not a current
  // dependency and must not influence the topological order.
  const readingOrder = buildReadingOrder(files, edges.filter((edge) => edge.kind !== "removed"), input.reviewQueue, roots);
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
    cluster: clusterOfPath(file.path, roots),
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

  const clusters: ChangeGraphCluster[] = clusterOrder.map((name) => ({ name, paths: clusterPaths.get(name) ?? [] }));
  return {
    change_graph: {
      nodes,
      halo_nodes: haloNodes,
      edges,
      clusters,
      overview: buildOverview(nodes, clusters, edges, haloNodes, input.reviewQueue, currentPathByAliasOf(files), input.areaInsights ?? [])
    },
    reading_order: readingOrder
  };
}

function applyEdgeInsights(edges: ChangeGraphEdge[], insights: ChangeGraphEdgeInsight[]): void {
  const byKey = new Map(insights.map((insight) => [edgeKey(insight.from, insight.to), insight]));
  for (const edge of edges) {
    const insight = byKey.get(edgeKey(edge.from, edge.to));
    if (insight) {
      edge.summary = insight.summary;
      edge.detail = insight.detail;
      edge.insight_source = insight.source;
      continue;
    }
    const fallback = fallbackEdgeInsight(edge);
    edge.summary = fallback.summary;
    edge.detail = fallback.detail;
    edge.insight_source = "fallback";
  }
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function fallbackEdgeInsight(edge: Pick<ChangeGraphEdge, "from" | "to" | "kind">): { summary: string; detail: string } {
  const status = edge.kind === "existing" ? "uses" : edge.kind === "new" ? "now uses" : "stopped using";
  return {
    summary: `${shortPath(edge.from)} ${status} ${shortPath(edge.to)}`,
    detail: `${edge.from} ${edge.kind === "removed" ? "used to use" : "uses"} ${edge.to}. This is a deterministic import-graph relationship; run with a provider for a semantic explanation of why it matters.`
  };
}

// review-surfaces.MAP_SCALE.1: merge model clusters into overview groups by
// first path segment ("(root)" stays itself) — derived here, in the model,
// from the SAME clusters/nodes/edges/queue every other surface uses; renderers
// never re-cluster. Honest by construction (MAP_SCALE.3): group file counts
// sum to nodes.length and edge weights account for every inter-group model edge.
function overviewGroupOf(cluster: string): string {
  return cluster.split("/")[0];
}

function buildOverview(
  nodes: ChangeGraphNode[],
  clusters: ChangeGraphCluster[],
  edges: ChangeGraphEdge[],
  haloNodes: ChangeGraphHaloNode[],
  queue: ReviewQueueItem[],
  currentPathByAlias: Map<string, string>,
  areaInsights: ChangeGraphAreaInsight[]
): ChangeGraphOverview {
  const groupOrder: string[] = [];
  const clusterCounts = new Map<string, number>();
  for (const cluster of clusters) {
    const group = overviewGroupOf(cluster.name);
    if (!clusterCounts.has(group)) {
      groupOrder.push(group);
      clusterCounts.set(group, 0);
    }
    clusterCounts.set(group, (clusterCounts.get(group) ?? 0) + 1);
  }

  const groupByPath = new Map<string, string>();
  const nodesByGroup = new Map<string, ChangeGraphNode[]>();
  const clustersByGroup = new Map<string, ChangeGraphCluster[]>();
  const stats = new Map<string, { files: number; added: number; removed: number; lensCounts: Map<RiskLens, number>; queue: number }>();
  for (const group of groupOrder) {
    stats.set(group, { files: 0, added: 0, removed: 0, lensCounts: new Map(), queue: 0 });
    nodesByGroup.set(group, []);
    clustersByGroup.set(group, []);
  }
  for (const cluster of clusters) {
    clustersByGroup.get(overviewGroupOf(cluster.name))?.push(cluster);
  }
  for (const node of nodes) {
    const group = overviewGroupOf(node.cluster);
    groupByPath.set(node.path, group);
    nodesByGroup.get(group)?.push(node);
    const entry = stats.get(group);
    if (!entry) {
      continue;
    }
    entry.files += 1;
    entry.added += node.churn_added;
    entry.removed += node.churn_removed;
    if (node.lens) {
      entry.lensCounts.set(node.lens, (entry.lensCounts.get(node.lens) ?? 0) + 1);
    }
  }
  // Queue counts: items resolve through the rename alias map (an old-path
  // anchored item counts toward its current file's group); items that map to
  // no changed file (repo-level findings) belong to no group.
  for (const item of queue) {
    const target = currentPathByAlias.get(item.path) ?? item.path;
    const group = groupByPath.get(target);
    const entry = group ? stats.get(group) : undefined;
    if (entry) {
      entry.queue += 1;
    }
  }

  const insightByGroup = new Map(areaInsights.map((insight) => [insight.name, insight]));
  const groups: ChangeGraphOverviewGroup[] = groupOrder.map((name) => {
    const entry = stats.get(name) as { files: number; added: number; removed: number; lensCounts: Map<RiskLens, number>; queue: number };
    const lens = dominantGroupLens(entry.lensCounts);
    const groupNodes = (nodesByGroup.get(name) ?? []).sort((a, b) => compareStrings(a.path, b.path));
    const fallback = fallbackAreaSummary(name, groupNodes, entry.queue, lens);
    const insight = insightByGroup.get(name);
    const topics = topicsForGroup(name, groupNodes, clustersByGroup.get(name) ?? [], insight?.topics);
    return {
      name,
      file_count: entry.files,
      cluster_count: clusterCounts.get(name) ?? 0,
      churn_added: entry.added,
      churn_removed: entry.removed,
      summary: insight?.summary ?? fallback.summary,
      ...(insight?.detail ? { detail: insight.detail } : fallback.detail ? { detail: fallback.detail } : {}),
      insight_source: insight?.source ?? "fallback",
      queue_count: entry.queue,
      topics,
      ...(lens ? { lens } : {})
    };
  });

  // Aggregate inter-group edges: weight = underlying model edge count, flags
  // for any new/removed member. Intra-group edges are the zoom level's job
  // (MAP_SCALE.4); the honesty split is asserted in tests.
  const aggregated = new Map<string, ChangeGraphOverviewEdge>();
  for (const edge of edges) {
    const from = groupByPath.get(edge.from);
    const to = groupByPath.get(edge.to);
    if (!from || !to || from === to) {
      continue;
    }
    const key = JSON.stringify([from, to]);
    const existing = aggregated.get(key) ?? {
      from,
      to,
      weight: 0,
      has_new: false,
      has_removed: false,
      summary: usesPhrase(from, to),
      detail: "",
      insight_source: "fallback" as const
    };
    existing.weight += 1;
    existing.has_new = existing.has_new || edge.kind === "new";
    existing.has_removed = existing.has_removed || edge.kind === "removed";
    if (edge.insight_source === "provider" || !existing.detail) {
      existing.summary = `${usesPhrase(from, to)}: ${edge.summary}`;
    }
    const detail = edge.detail ?? edge.summary;
    existing.detail = existing.detail ? `${existing.detail}\n${detail}` : detail;
    existing.insight_source = existing.insight_source === "provider" || edge.insight_source === "provider" ? "provider" : "fallback";
    aggregated.set(key, existing);
  }
  const overviewEdges = [...aggregated.values()].sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));

  return { groups, halo_count: haloNodes.length, edges: overviewEdges };
}

function fallbackAreaSummary(
  name: string,
  nodes: ChangeGraphNode[],
  queueCount: number,
  lens: RiskLens | undefined
): { summary: string; detail?: string } {
  const fileCount = nodes.length;
  const added = nodes.reduce((sum, node) => sum + node.churn_added, 0);
  const removed = nodes.reduce((sum, node) => sum + node.churn_removed, 0);
  const deleted = nodes.filter((node) => node.status === "deleted").length;
  const addedFiles = nodes.filter((node) => node.status === "added").length;
  const lensLabel = lens ? shortLensLabel(lens) : undefined;
  const action =
    deleted > fileCount / 2
      ? `mostly removes ${areaNoun(name)}`
      : addedFiles > fileCount / 2
        ? `mostly adds ${areaNoun(name)}`
        : removed > added * 3 && removed > 100
          ? `mostly trims ${areaNoun(name)}`
          : added > removed * 3 && added > 100
            ? `mostly expands ${areaNoun(name)}`
            : `updates ${areaNoun(name)}`;
  const queue = queueCount > 0 ? `; ${queueCount} review-queue item${queueCount === 1 ? "" : "s"}` : "";
  const lensText = lensLabel ? `; ${lensLabel} focus` : "";
  return {
    summary: `${capitalize(action)} across ${fileCount} file${fileCount === 1 ? "" : "s"}${queue}${lensText}.`,
    detail: `Churn: +${added}/-${removed}. ${deleted} deleted file${deleted === 1 ? "" : "s"}, ${addedFiles} added file${addedFiles === 1 ? "" : "s"}.`
  };
}

function topicsForGroup(
  name: string,
  nodes: ChangeGraphNode[],
  clusters: ChangeGraphCluster[],
  providerTopics: ChangeGraphTopicInsight[] | undefined
): ChangeGraphTopicGroup[] {
  const allPaths = new Set(nodes.map((node) => node.path));
  const assigned = new Set<string>();
  const topics: ChangeGraphTopicGroup[] = [];
  for (const topic of providerTopics ?? []) {
    const paths = uniqueSorted(topic.paths.filter((filePath) => allPaths.has(filePath) && !assigned.has(filePath)));
    if (paths.length === 0) {
      continue;
    }
    paths.forEach((filePath) => assigned.add(filePath));
    topics.push({
      label: topic.label,
      summary: topic.summary,
      paths,
      insight_source: topic.source
    });
  }
  const remaining = nodes.filter((node) => !assigned.has(node.path));
  for (const topic of fallbackTopicsForGroup(name, remaining, clusters, assigned)) {
    const existing = topics.find((candidate) => candidate.label === topic.label);
    if (existing) {
      existing.paths = uniqueSorted([...existing.paths, ...topic.paths]);
      continue;
    }
    topics.push(topic);
  }
  return topics;
}

function fallbackTopicsForGroup(
  group: string,
  nodes: ChangeGraphNode[],
  clusters: ChangeGraphCluster[],
  alreadyAssigned: Set<string>
): ChangeGraphTopicGroup[] {
  if (nodes.length === 0) {
    return [];
  }
  if (group === "tests") {
    return topicGroupsFromBuckets(nodes, (pathName) => testTopicForPath(pathName));
  }
  if (group === "docs") {
    return [{
      label: "Documentation updates",
      summary: summarizeTopic("Documentation updates", nodes.map((node) => node.path)),
      paths: nodes.map((node) => node.path).sort(compareStrings),
      insight_source: "fallback"
    }];
  }
  if (group === "(root)") {
    return topicGroupsFromBuckets(nodes, () => "Repository metadata");
  }
  const clusterByPath = new Map<string, string>();
  for (const cluster of clusters) {
    for (const filePath of cluster.paths) {
      if (!alreadyAssigned.has(filePath)) {
        clusterByPath.set(filePath, topicLabelFromCluster(cluster.name));
      }
    }
  }
  return topicGroupsFromBuckets(nodes, (pathName) => clusterByPath.get(pathName) ?? topicLabelFromPath(pathName));
}

function topicGroupsFromBuckets(nodes: ChangeGraphNode[], bucketFor: (filePath: string) => string): ChangeGraphTopicGroup[] {
  const buckets = new Map<string, string[]>();
  for (const node of nodes) {
    const label = bucketFor(node.path);
    const paths = buckets.get(label) ?? [];
    paths.push(node.path);
    buckets.set(label, paths);
  }
  return [...buckets.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([label, paths]) => {
      const sortedPaths = paths.sort(compareStrings);
      return {
        label,
        summary: summarizeTopic(label, sortedPaths),
        paths: sortedPaths,
        insight_source: "fallback" as const
      };
    });
}

function testTopicForPath(filePath: string): string {
  const stem = filePath.split("/").pop()?.replace(/\.(test|spec)\.[^.]+$/, "") ?? filePath;
  if (/\b(apple|ios|swift|source-kind)\b/i.test(stem)) {
    return "Apple and Swift tests";
  }
  if (/\b(change-map|cockpit|human-density|human-value|render-html|reading-order)\b/i.test(stem)) {
    return "Cockpit and change-map tests";
  }
  if (/\b(human-review|coverage-gutter|rounds-trend)\b/i.test(stem)) {
    return "Human review model tests";
  }
  if (/\b(eval|evaluation|provider|reasoning|narrative)\b/i.test(stem)) {
    return "Provider and evaluation tests";
  }
  if (/\b(collect|config|cross-reference|privacy|pr-risks|risks|dependency|command|cli)\b/i.test(stem)) {
    return "Pipeline and risk tests";
  }
  if (/\b(comment|sticky|sarif|distribution)\b/i.test(stem)) {
    return "Comment and release tests";
  }
  if (/\b(bench|gate|schema|artifact|cache)\b/i.test(stem)) {
    return "Quality gate tests";
  }
  return "Other tests";
}

function topicLabelFromCluster(cluster: string): string {
  if (cluster === "(root)") {
    return "Repository metadata";
  }
  const tail = cluster.split("/").pop() ?? cluster;
  return `${titleize(tail)} changes`;
}

function topicLabelFromPath(filePath: string): string {
  const top = filePath.split("/")[0] || filePath;
  return `${titleize(top)} changes`;
}

function summarizeTopic(label: string, paths: string[]): string {
  const count = paths.length;
  const preview = paths.slice(0, 3).map((filePath) => filePath.split("/").pop() ?? filePath).join(", ");
  const suffix = paths.length > 3 ? `, +${paths.length - 3} more` : "";
  return `${label}: ${count} changed file${count === 1 ? "" : "s"}${preview ? ` (${preview}${suffix})` : ""}.`;
}

function areaNoun(name: string): string {
  if (name === "tests") return "test coverage";
  if (name === "docs") return "documentation";
  if (name === "src") return "implementation code";
  if (name === "schemas") return "schema contracts";
  if (name === "features") return "feature spec";
  if (name === ".github") return "CI workflow config";
  if (name === "(root)") return "repository metadata";
  return name;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function titleize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

// ---------------------------------------------------------------------------
// review-surfaces.MAP_SCALE.4: per-group detail views — the zoom level. Each
// overview group expands to its model clusters and files VERBATIM (the same
// clusters the queue and tour reference, so map/tour agreement holds), its
// intra-group edges, its cross-group edges aggregated into explicit stub
// ports, and its share of the halo. Derived HERE in the model layer from the
// same change_graph both emitters consume — never renderer-local. Every
// changed file appears in exactly one detail view because clusters partition
// nodes and groups partition clusters.

export interface DetailStub {
  // The other group on this edge bundle.
  other: string;
  // "out": this group's files are the dependency (the arrow leaves this group
  // toward the dependent group). "in": this group's files import the other
  // group's files (the arrow enters this group).
  direction: "out" | "in";
  weight: number;
  has_new: boolean;
  has_removed: boolean;
  summary: string;
  detail?: string;
  insight_source: ChangeGraphInsightSource;
}

export interface GroupDetailView {
  group: string;
  clusters: ChangeGraphCluster[];
  topics: ChangeGraphTopicGroup[];
  edges: ChangeGraphEdge[];
  stubs: DetailStub[];
  halo_nodes: ChangeGraphHaloNode[];
}

export function buildGroupDetailViews(graph: ChangeGraph): GroupDetailView[] {
  const groupByPath = new Map(graph.nodes.map((node) => [node.path, overviewGroupOf(node.cluster)]));
  const views = new Map<string, GroupDetailView>();
  for (const group of graph.overview.groups) {
    views.set(group.name, { group: group.name, clusters: [], topics: group.topics ?? [], edges: [], stubs: [], halo_nodes: [] });
  }
  for (const cluster of graph.clusters) {
    views.get(overviewGroupOf(cluster.name))?.clusters.push(cluster);
  }
  const stubKeys = new Map<string, Map<string, DetailStub>>();
  for (const edge of graph.edges) {
    const fromGroup = groupByPath.get(edge.from);
    const toGroup = groupByPath.get(edge.to);
    if (!fromGroup || !toGroup) {
      continue;
    }
    if (fromGroup === toGroup) {
      views.get(fromGroup)?.edges.push(edge);
      continue;
    }
    // Cross-group: one stub on each side. The imported side (the dependency)
    // sends the arrow out toward the dependent importer group.
    addStub(stubKeys, toGroup, fromGroup, "out", edge);
    addStub(stubKeys, fromGroup, toGroup, "in", edge);
  }
  for (const [group, stubs] of stubKeys) {
    const view = views.get(group);
    if (view) {
      view.stubs = [...stubs.values()].sort((a, b) => compareStrings(a.other, b.other) || compareStrings(a.direction, b.direction));
    }
  }
  // Halo share: an unchanged importer appears in every group view that owns at
  // least one of the changed files it imports, with imports restricted to that
  // group's files (its citing facts inside the view).
  for (const halo of graph.halo_nodes) {
    const importsByGroup = new Map<string, string[]>();
    for (const imported of halo.imports) {
      const group = groupByPath.get(imported);
      if (!group) {
        continue;
      }
      const list = importsByGroup.get(group) ?? [];
      list.push(imported);
      importsByGroup.set(group, list);
    }
    for (const [group, imports] of importsByGroup) {
      views.get(group)?.halo_nodes.push({ path: halo.path, imports });
    }
  }
  return graph.overview.groups.map((group) => views.get(group.name) as GroupDetailView);
}

// A detail view rendered AS a change graph: the group's nodes, clusters,
// intra-group edges, and halo share, so both emitters reuse the file-level
// renderer (per-view node cap and explicit overflow included) with the stub
// ports passed alongside. The empty overview is renderer input only.
export function detailViewSubGraph(graph: ChangeGraph, view: GroupDetailView): ChangeGraph {
  const paths = new Set<string>();
  for (const cluster of view.clusters) {
    for (const clusterPath of cluster.paths) {
      paths.add(clusterPath);
    }
  }
  return {
    nodes: graph.nodes.filter((node) => paths.has(node.path)),
    halo_nodes: view.halo_nodes,
    edges: view.edges,
    clusters: detailClusters(view),
    overview: { groups: [], halo_count: 0, edges: [] }
  };
}

function detailClusters(view: GroupDetailView): ChangeGraphCluster[] {
  if (view.topics.length === 0) {
    return view.clusters;
  }
  return view.topics.map((topic) => ({
    name: topic.label,
    label: topic.label,
    summary: topic.summary,
    insight_source: topic.insight_source,
    paths: topic.paths
  }));
}

function addStub(
  stubKeys: Map<string, Map<string, DetailStub>>,
  group: string,
  other: string,
  direction: "out" | "in",
  edge: ChangeGraphEdge
): void {
  const byKey = stubKeys.get(group) ?? new Map<string, DetailStub>();
  stubKeys.set(group, byKey);
  const key = `${direction} ${other}`;
  const stub = byKey.get(key) ?? {
    other,
    direction,
    weight: 0,
    has_new: false,
    has_removed: false,
    summary: direction === "out" ? usesPhrase(other, group) : usesPhrase(group, other),
    detail: "",
    insight_source: "fallback" as const
  };
  stub.weight += 1;
  stub.has_new = stub.has_new || edge.kind === "new";
  stub.has_removed = stub.has_removed || edge.kind === "removed";
  if (edge.insight_source === "provider" || !stub.detail) {
    stub.summary = direction === "out"
      ? `${usesPhrase(other, group)}: ${edge.summary}`
      : `${usesPhrase(group, other)}: ${edge.summary}`;
  }
  const detail = edge.detail ?? edge.summary;
  stub.detail = stub.detail ? `${stub.detail}\n${detail}` : detail;
  stub.insight_source = stub.insight_source === "provider" || edge.insight_source === "provider" ? "provider" : "fallback";
  byKey.set(key, stub);
}

// Most frequent node lens in the group; ties broken by lens rank, then name.
function dominantGroupLens(counts: Map<RiskLens, number>): RiskLens | undefined {
  let best: { lens: RiskLens; count: number; rank: number } | undefined;
  for (const [lens, count] of [...counts.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    const rank = RISK_LENS_METADATA[lens]?.rank ?? Number.MAX_SAFE_INTEGER;
    if (!best || count > best.count || (count === best.count && rank < best.rank)) {
      best = { lens, count, rank };
    }
  }
  return best?.lens;
}

function shortPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  return parts.length <= 2 ? filePath : `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function usesPhrase(subject: string, object: string): string {
  return `${subject} ${subject.endsWith("s") ? "use" : "uses"} ${object}`;
}

function shortLensLabel(lens: RiskLens): string {
  switch (lens) {
    case "api_contract":
      return "API contract";
    case "security_privacy":
      return "security/privacy";
    case "llm_trust_boundary":
      return "LLM trust";
    case "test_evidence":
      return "test evidence";
    case "reviewer_ux":
      return "reviewer UX";
    case "cache_provenance":
      return "cache/provenance";
    case "supply_chain":
      return "supply chain";
    case "architecture":
      return "architecture";
    case "custom":
      return "custom";
  }
}

// Rename alias map (old path -> current path); a current path that collides
// with another file's old_path wins. Shared shape with the tour's queue
// cross-link resolution so overview queue counts agree with queue_refs.
function currentPathByAliasOf(files: ChangedFileFacts[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    if (file.old_path) {
      map.set(file.old_path, file.path);
    }
  }
  for (const file of files) {
    map.set(file.path, file.path);
  }
  return map;
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
    result.push(edgeWithFallback({ from: edge.importer, to: edge.imported, kind: "existing" }));
  }
  return result.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));
}

function edgeWithFallback(edge: Pick<ChangeGraphEdge, "from" | "to" | "kind">): ChangeGraphEdge {
  const fallback = fallbackEdgeInsight(edge);
  return {
    ...edge,
    summary: fallback.summary,
    detail: fallback.detail,
    insight_source: "fallback"
  };
}

function normalizeStatus(raw: string): ChangeGraphNodeStatus {
  const letter = (raw || "M").toUpperCase()[0];
  // Porcelain "??" (untracked working-tree file) and copies are add-like.
  if (letter === "A" || letter === "?" || letter === "C") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R") return "renamed";
  return "modified";
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

// review-surfaces.COLD_START.2: implementation roots come from the target
// repo's own signals (tsconfig/package.json/majority fallback), not a
// hardcoded src|bin|lib list — got's source/core/index.ts must read as
// implementation, not "config or docs — read last".
function categoryOf(filePath: string, roots: readonly string[]): LegCategory {
  const top = filePath.split("/")[0];
  if (top === "schemas" || top === "features" || filePath.endsWith(".schema.json")) {
    return "contracts";
  }
  // Test classification first: a co-located src/foo.test.ts is a test, not
  // implementation — otherwise the tour breaks "tests after code".
  if (top === "tests" || top === "test" || /\.(test|spec)\.[jt]sx?$/.test(filePath)) {
    return "tests";
  }
  if (roots.includes(top)) {
    return "implementation";
  }
  return "config";
}

function buildReadingOrder(files: ChangedFileFacts[], edges: ChangeGraphEdge[], queue: ReviewQueueItem[], roots: readonly string[]): ReadingOrder {
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
  const frontierKey = (index: number): string => `${CATEGORY_PRIORITY[categoryOf(components[index][0], roots)]} ${components[index][0]}`;
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
  const currentPathByAlias = currentPathByAliasOf(files);
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
    const category = categoryOf(member, roots);
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
  const sorted = [...paths].sort(compareStrings);
  const adjacency = new Map<string, string[]>();
  for (const node of sorted) {
    adjacency.set(node, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }
  for (const list of adjacency.values()) {
    list.sort(compareStrings);
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
        components.push(members.sort(compareStrings));
      }
    }
  }
  return components;
}
