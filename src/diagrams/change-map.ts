// review-surfaces.CHANGE_MAP.2: the focused mermaid emitter over the
// change_graph model — one `flowchart LR`, a subgraph per cluster (in the
// model's tour-agreeing cluster order), a classDef per lens, and HARD CAPS rendered honestly: overflow becomes an
// explicit "+ N more files" node per cluster, never silent truncation. The map
// carries NO spec/requirement anchors (CHANGE_MAP.3) — trust lives in the
// underlying facts (every rendered edge cites the import graph).
import { ChangeGraph, ChangeGraphOverview, RiskLens } from "../human/contract";
import { DetailStub } from "../human/change-graph";
import { diagramLabel } from "./diagrams";
import { LENS_STROKES, SVG_LENS_FILLS } from "../human/render-svg-map";
// review-surfaces.MAP_SCALE.2: caps come from the ONE legibility-budget module
// — the same constants the SVG emitter and the budget decision use.
import { MAX_CHANGED_NODES } from "../human/legibility-budget";

// Print-safe, color-not-alone palette: each lens also carries its name in the
// node label via the class name legend below the map on rendered surfaces.
// Derived from the SAME palette the SVG cockpit map uses (RENDER.11), so the
// two renderers can never color a lens differently.
function lensClassDef(lens: RiskLens): string {
  return `fill:${SVG_LENS_FILLS[lens]},stroke:${LENS_STROKES[lens]}`;
}

export interface RenderChangeMapMermaidOptions {
  // review-surfaces.MAP_SCALE.4: detail-view cross-group stubs. Generic fallback
  // stubs stay suppressed, but provider-backed summaries are useful enough to
  // preserve in human_review.md detail blocks.
  stubs?: DetailStub[];
}

export function renderChangeMapMermaid(graph: ChangeGraph, options: RenderChangeMapMermaidOptions = {}): string | undefined {
  if (graph.nodes.length === 0) {
    return undefined;
  }
  const lines: string[] = ["flowchart LR"];
  const nodeIds = new Map<string, string>();
  const usedLenses = new Set<RiskLens>();
  const nodeByPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const visibleEntries = visibleClusterPaths(graph.clusters, nodeByPath);

  for (const [clusterIndex, cluster] of graph.clusters.entries()) {
    lines.push(`  subgraph c${clusterIndex}["${diagramLabel(cluster.name)}"]`);
    const entry = visibleEntries[clusterIndex];
    for (const filePath of entry.visible) {
      const node = nodeByPath.get(filePath);
      if (!node) {
        continue;
      }
      const id = `n${nodeIds.size}`;
      nodeIds.set(node.path, id);
      const churn = `+${node.churn_added}/-${node.churn_removed}`;
      const marker = node.status === "deleted" ? " deleted" : node.status === "added" ? " new" : node.status === "renamed" ? " renamed" : "";
      lines.push(`    ${id}["${diagramLabel(node.path)}<br/>${churn}${marker}"]`);
      if (node.lens) {
        usedLenses.add(node.lens);
        lines.push(`    class ${id} lens_${node.lens}`);
      }
    }
    if (entry.overflow > 0) {
      // Caps are rendered, never silent.
      lines.push(`    c${clusterIndex}_more["+ ${entry.overflow} more files"]`);
    }
    lines.push("  end");
  }

  // Model edges are importer -> imported (CHANGE_MAP.1); draw them reversed
  // (dependency -> dependent) so left-to-right agrees with the tour.
  for (const edge of graph.edges) {
    if (!shouldRenderFileRelationship(edge)) {
      continue;
    }
    const from = nodeIds.get(edge.to);
    const to = nodeIds.get(edge.from);
    if (!from || !to) {
      continue;
    }
    const arrow = edge.kind === "removed" ? "-.->" : edge.kind === "new" ? "==>" : "-->";
    const label = edge.summary ? `|"${diagramLabel(edge.summary)}"|` : "";
    lines.push(`  ${from} ${arrow}${label} ${to}`);
  }
  const providerStubs = (options.stubs ?? []).filter((stub) => stub.insight_source === "provider");
  if (providerStubs.length > 0) {
    lines.push(`  subgraph stubs["related areas"]`);
    for (const [index, stub] of providerStubs.entries()) {
      const direction = stub.direction === "out" ? "to" : "from";
      lines.push(`    s${index}["${diagramLabel(`${direction} ${stub.other}: ${stub.summary}`)}"]`);
    }
    lines.push("  end");
  }
  for (const lens of [...usedLenses].sort()) {
    lines.push(`  classDef lens_${lens} ${lensClassDef(lens)}`);
  }
  return lines.join("\n");
}

function shouldRenderFileRelationship(edge: ChangeGraph["edges"][number]): boolean {
  return edge.insight_source === "provider" || edge.kind === "new" || edge.kind === "removed";
}

function visibleClusterPaths(
  clusters: ChangeGraph["clusters"],
  nodeByPath: Map<string, ChangeGraph["nodes"][number]>
): Array<{ visible: string[]; overflow: number }> {
  const entries = clusters.map((cluster) => ({
    paths: cluster.paths.filter((filePath) => nodeByPath.has(filePath)),
    visible: [] as string[]
  }));
  const total = entries.reduce((sum, entry) => sum + entry.paths.length, 0);
  if (total <= MAX_CHANGED_NODES) {
    return entries.map((entry) => ({ visible: entry.paths, overflow: 0 }));
  }

  let remaining = MAX_CHANGED_NODES;
  for (const entry of entries) {
    if (remaining <= 0) {
      break;
    }
    if (entry.paths[0]) {
      entry.visible.push(entry.paths[0]);
      remaining -= 1;
    }
  }
  for (let offset = 1; remaining > 0; offset += 1) {
    let added = false;
    for (const entry of entries) {
      const filePath = entry.paths[offset];
      if (!filePath) {
        continue;
      }
      entry.visible.push(filePath);
      remaining -= 1;
      added = true;
      if (remaining <= 0) {
        break;
      }
    }
    if (!added) {
      break;
    }
  }

  return entries.map((entry) => ({
    visible: entry.visible,
    overflow: Math.max(0, entry.paths.length - entry.visible.length)
  }));
}

// review-surfaces.MAP_SCALE.2: the overview-level mermaid — one node per group
// (file/cluster/churn counts in the label, dominant-lens classDef), and
// provider-backed inter-group edges when they are not generic test-to-source
// imports. Same model the SVG overview draws; no renderer-local
// clustering or thresholds.
export function renderChangeMapOverviewMermaid(overview: ChangeGraphOverview): string | undefined {
  if (overview.groups.length === 0) {
    return undefined;
  }
  const lines: string[] = ["flowchart LR"];
  const idByGroup = new Map<string, string>();
  const usedLenses = new Set<RiskLens>();
  for (const [index, group] of overview.groups.entries()) {
    const id = `g${index}`;
    idByGroup.set(group.name, id);
    const queue = group.queue_count > 0 ? ` · queue ${group.queue_count}` : "";
    const topicCount = group.topics?.length ?? group.cluster_count;
    lines.push(
      `  ${id}["${diagramLabel(group.name)}<br/>${diagramLabel(group.summary)}<br/>${group.file_count} file(s) · ${topicCount} topic(s)<br/>+${group.churn_added}/-${group.churn_removed}${queue}"]`
    );
    if (group.lens) {
      usedLenses.add(group.lens);
      lines.push(`  class ${id} lens_${group.lens}`);
    }
  }
  // Model edges are importer-group -> imported-group; draw reversed
  // (dependency -> dependent) to agree with the tour, like the file level.
  for (const edge of overview.edges) {
    if (!shouldRenderOverviewRelationship(edge)) {
      continue;
    }
    const from = idByGroup.get(edge.to);
    const to = idByGroup.get(edge.from);
    if (!from || !to) {
      continue;
    }
    const arrow = edge.has_new ? "==>" : edge.has_removed ? "-.->" : "-->";
    lines.push(`  ${from} ${arrow}|"${diagramLabel(edge.summary)}"| ${to}`);
  }
  for (const lens of [...usedLenses].sort()) {
    lines.push(`  classDef lens_${lens} ${lensClassDef(lens)}`);
  }
  return lines.join("\n");
}

function shouldRenderOverviewRelationship(edge: ChangeGraphOverview["edges"][number]): boolean {
  if (edge.insight_source !== "provider") {
    return false;
  }
  return edge.from !== "tests" && edge.to !== "tests";
}
