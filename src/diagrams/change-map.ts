// review-surfaces.CHANGE_MAP.2: the focused mermaid emitter over the
// change_graph model — one `flowchart LR`, a subgraph per cluster (in the
// model's tour-agreeing cluster order), a classDef per lens, dashed halo nodes
// from blast-radius facts, and HARD CAPS rendered honestly: overflow becomes an
// explicit "+ N more files" node per cluster, never silent truncation. The map
// carries NO spec/requirement anchors (CHANGE_MAP.3) — trust lives in the
// underlying facts (every edge cites the import graph, every halo node a
// blast-radius fact).
import { ChangeGraph, ChangeGraphOverview, RiskLens } from "../human/contract";
import { DetailStub } from "../human/change-graph";
import { diagramLabel } from "./diagrams";
import { LENS_STROKES, SVG_LENS_FILLS } from "../human/render-svg-map";
// review-surfaces.MAP_SCALE.2: caps come from the ONE legibility-budget module
// — the same constants the SVG emitter and the budget decision use.
import { MAX_CHANGED_NODES, MAX_HALO_NODES } from "../human/legibility-budget";

// Print-safe, color-not-alone palette: each lens also carries its name in the
// node label via the class name legend below the map on rendered surfaces.
// Derived from the SAME palette the SVG cockpit map uses (RENDER.11), so the
// two renderers can never color a lens differently.
function lensClassDef(lens: RiskLens): string {
  return `fill:${SVG_LENS_FILLS[lens]},stroke:${LENS_STROKES[lens]}`;
}

export interface RenderChangeMapMermaidOptions {
  // review-surfaces.MAP_SCALE.4: cross-group edges of a detail view rendered
  // as an explicit dashed stub subgraph ("→ src/render ×3").
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
  let rendered = 0;

  for (const [clusterIndex, cluster] of graph.clusters.entries()) {
    lines.push(`  subgraph c${clusterIndex}["${diagramLabel(cluster.name)}"]`);
    let overflow = 0;
    for (const filePath of cluster.paths) {
      const node = nodeByPath.get(filePath);
      if (!node) {
        continue;
      }
      if (rendered >= MAX_CHANGED_NODES) {
        overflow += 1;
        continue;
      }
      const id = `n${nodeIds.size}`;
      nodeIds.set(node.path, id);
      rendered += 1;
      const churn = `+${node.churn_added}/-${node.churn_removed}`;
      const marker = node.status === "deleted" ? " deleted" : node.status === "added" ? " new" : node.status === "renamed" ? " renamed" : "";
      lines.push(`    ${id}["${diagramLabel(node.path)}<br/>${churn}${marker}"]`);
      if (node.lens) {
        usedLenses.add(node.lens);
        lines.push(`    class ${id} lens_${node.lens}`);
      }
    }
    if (overflow > 0) {
      // Caps are rendered, never silent.
      lines.push(`    c${clusterIndex}_more["+ ${overflow} more files"]`);
    }
    lines.push("  end");
  }

  // Halo: top unchanged importers (dashed), capped with an explicit overflow node.
  const halo = graph.halo_nodes.slice(0, MAX_HALO_NODES);
  const haloOverflow = graph.halo_nodes.length - halo.length;
  if (halo.length > 0) {
    lines.push(`  subgraph halo["blast radius (unchanged importers)"]`);
    for (const [index, node] of halo.entries()) {
      lines.push(`    h${index}["${diagramLabel(node.path)}"]`);
    }
    if (haloOverflow > 0) {
      lines.push(`    halo_more["+ ${haloOverflow} more files"]`);
    }
    lines.push("  end");
  }

  // Model edges are importer -> imported (CHANGE_MAP.1); draw them reversed
  // (dependency -> dependent) so left-to-right agrees with the tour.
  for (const edge of graph.edges) {
    const from = nodeIds.get(edge.to);
    const to = nodeIds.get(edge.from);
    if (!from || !to) {
      continue;
    }
    const arrow = edge.kind === "removed" ? "-. removed .->" : edge.kind === "new" ? "==>" : "-->";
    lines.push(`  ${from} ${arrow} ${to}`);
  }
  for (const [index, node] of halo.entries()) {
    for (const imported of node.imports) {
      const from = nodeIds.get(imported);
      if (from) {
        lines.push(`  ${from} -.-> h${index}`);
      }
    }
  }

  // review-surfaces.MAP_SCALE.4: stub ports — the detail view's cross-group
  // edges, aggregated and explicit, never silently dropped.
  if (options.stubs && options.stubs.length > 0) {
    lines.push(`  subgraph stubs["cross-group"]`);
    for (const [index, stub] of options.stubs.entries()) {
      const label = stub.direction === "out" ? `→ ${stub.other} ×${stub.weight}` : `${stub.other} → ×${stub.weight}`;
      const flags = `${stub.has_new ? " · new" : ""}${stub.has_removed ? " · removed" : ""}`;
      lines.push(`    st${index}["${diagramLabel(label)}${flags ? `<br/>${diagramLabel(flags.trim())}` : ""}"]`);
    }
    lines.push("  end");
  }
  for (const lens of [...usedLenses].sort()) {
    lines.push(`  classDef lens_${lens} ${lensClassDef(lens)}`);
  }
  if (halo.length > 0) {
    const ids = halo.map((_, index) => `h${index}`).concat(haloOverflow > 0 ? ["halo_more"] : []);
    lines.push(`  classDef halo stroke-dasharray: 5 5,fill:#f9fafb,stroke:#6b7280`);
    lines.push(`  class ${ids.join(",")} halo`);
  }
  if (options.stubs && options.stubs.length > 0) {
    lines.push(`  classDef stub stroke-dasharray: 3 3,fill:#ffffff,stroke:#6b7280`);
    lines.push(`  class ${options.stubs.map((_, index) => `st${index}`).join(",")} stub`);
  }
  return lines.join("\n");
}

// review-surfaces.MAP_SCALE.2: the overview-level mermaid — one node per group
// (file/cluster/churn counts in the label, dominant-lens classDef), the single
// dashed halo node, and weighted inter-group edges (label carries ×weight plus
// new/removed flags). Same model the SVG overview draws; no renderer-local
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
    lines.push(
      `  ${id}["${diagramLabel(group.name)}<br/>${group.file_count} file(s) · ${group.cluster_count} cluster(s)<br/>+${group.churn_added}/-${group.churn_removed}${queue}"]`
    );
    if (group.lens) {
      usedLenses.add(group.lens);
      lines.push(`  class ${id} lens_${group.lens}`);
    }
  }
  if (overview.halo_count > 0) {
    lines.push(`  halo["blast radius<br/>${overview.halo_count} unchanged importer(s)"]`);
  }
  // Model edges are importer-group -> imported-group; draw reversed
  // (dependency -> dependent) to agree with the tour, like the file level.
  for (const edge of overview.edges) {
    const from = idByGroup.get(edge.to);
    const to = idByGroup.get(edge.from);
    if (!from || !to) {
      continue;
    }
    const flags = `${edge.has_new ? " · new" : ""}${edge.has_removed ? " · removed" : ""}`;
    const arrow = edge.has_new ? "==>" : edge.has_removed ? "-.->" : "-->";
    lines.push(`  ${from} ${arrow}|"×${edge.weight}${flags}"| ${to}`);
  }
  for (const lens of [...usedLenses].sort()) {
    lines.push(`  classDef lens_${lens} ${lensClassDef(lens)}`);
  }
  if (overview.halo_count > 0) {
    lines.push(`  classDef halo stroke-dasharray: 5 5,fill:#f9fafb,stroke:#6b7280`);
    lines.push(`  class halo halo`);
  }
  return lines.join("\n");
}
