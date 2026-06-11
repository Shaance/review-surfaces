// review-surfaces.CHANGE_MAP.2: the focused mermaid emitter over the
// change_graph model — one `flowchart LR`, a subgraph per cluster (in the
// model's tour-agreeing cluster order), a classDef per lens, dashed halo nodes
// from blast-radius facts, and HARD CAPS rendered honestly: overflow becomes an
// explicit "+ N more files" node per cluster, never silent truncation. The map
// carries NO spec/requirement anchors (CHANGE_MAP.3) — trust lives in the
// underlying facts (every edge cites the import graph, every halo node a
// blast-radius fact).
import { ChangeGraph, RiskLens } from "../human/contract";
import { diagramLabel } from "./diagrams";
import { LENS_STROKES, SVG_LENS_FILLS } from "../human/render-svg-map";

const MAX_CHANGED_NODES = 25;
const MAX_HALO_NODES = 10;

// Print-safe, color-not-alone palette: each lens also carries its name in the
// node label via the class name legend below the map on rendered surfaces.
// Derived from the SAME palette the SVG cockpit map uses (RENDER.11), so the
// two renderers can never color a lens differently.
function lensClassDef(lens: RiskLens): string {
  return `fill:${SVG_LENS_FILLS[lens]},stroke:${LENS_STROKES[lens]}`;
}

export function renderChangeMapMermaid(graph: ChangeGraph): string | undefined {
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

  for (const lens of [...usedLenses].sort()) {
    lines.push(`  classDef lens_${lens} ${lensClassDef(lens)}`);
  }
  if (halo.length > 0) {
    const ids = halo.map((_, index) => `h${index}`).concat(haloOverflow > 0 ? ["halo_more"] : []);
    lines.push(`  classDef halo stroke-dasharray: 5 5,fill:#f9fafb,stroke:#6b7280`);
    lines.push(`  class ${ids.join(",")} halo`);
  }
  return lines.join("\n");
}
