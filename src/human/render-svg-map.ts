// review-surfaces.RENDER.11: deterministic inline-SVG change map for the HTML
// cockpit, rendered from the SAME change_graph model as the mermaid emitter —
// no chart or diagram library and no inlined mermaid.js. Hand-rolled layered
// layout: one column per cluster (in the model's tour-agreeing order), stable
// row order within a column, fixed viewBox, system font stack. Every coordinate
// derives from sorted input, so identical models produce byte-identical SVG.
// Every interpolated label passes through the shared redact-then-escape esc()
// helper; hover details ride on <title> elements so the map degrades gracefully
// in print. Node click filters the queue via the existing data- attribute
// pattern (data-map-file), wired by the cockpit's vanilla JS.
import { ChangeGraph, RiskLens } from "./contract";
import { esc } from "./esc";

// Same caps as the mermaid emitter (CHANGE_MAP.2): overflow is rendered as an
// explicit "+ N more files" entry, never silently dropped.
const MAX_CHANGED_NODES = 25;
const MAX_HALO_NODES = 10;

const NODE_WIDTH = 200;
const NODE_HEIGHT = 40;
const COLUMN_GAP = 60;
const ROW_GAP = 14;
const PADDING = 16;
const HEADER_HEIGHT = 22;

// Print-safe fills paired with the lens name in the node's <title> and the
// legend the cockpit renders next to the map — color never carries meaning
// alone. ONE palette shared with the mermaid emitter (change-map.ts derives
// its classDefs from it) so the two maps can never color a lens differently.
export const SVG_LENS_FILLS: Record<RiskLens, string> = {
  api_contract: "#fde2e2",
  security_privacy: "#fee2b3",
  llm_trust_boundary: "#fef9c3",
  test_evidence: "#dbeafe",
  reviewer_ux: "#ede9fe",
  cache_provenance: "#d1fae5",
  supply_chain: "#fce7f3",
  custom: "#e5e7eb"
};

export const LENS_STROKES: Record<RiskLens, string> = {
  api_contract: "#b91c1c",
  security_privacy: "#b45309",
  llm_trust_boundary: "#a16207",
  test_evidence: "#1d4ed8",
  reviewer_ux: "#6d28d9",
  cache_provenance: "#047857",
  supply_chain: "#be185d",
  custom: "#374151"
};

interface PlacedNode {
  x: number;
  y: number;
  path: string;
}

export interface RenderedSvgMap {
  svg: string;
  // Lenses that actually appear on the map, for the cockpit's text legend.
  lenses: RiskLens[];
}

export function renderChangeMapSvg(graph: ChangeGraph): RenderedSvgMap | undefined {
  if (graph.nodes.length === 0) {
    return undefined;
  }
  const nodeByPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const usedLenses = new Set<RiskLens>();
  const placed = new Map<string, PlacedNode>();
  const parts: string[] = [];

  // Columns: one per cluster in model order; a trailing dashed column for the
  // halo. Each column renders a header and stacked node rects.
  const halo = graph.halo_nodes.slice(0, MAX_HALO_NODES);
  const haloOverflow = graph.halo_nodes.length - halo.length;
  const columnCount = graph.clusters.length + (halo.length > 0 ? 1 : 0);
  let rendered = 0;
  let maxRows = 0;

  for (const [columnIndex, cluster] of graph.clusters.entries()) {
    const x = PADDING + columnIndex * (NODE_WIDTH + COLUMN_GAP);
    let row = 0;
    const cells: string[] = [];
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
      rendered += 1;
      const y = PADDING + HEADER_HEIGHT + row * (NODE_HEIGHT + ROW_GAP);
      placed.set(node.path, { x, y, path: node.path });
      if (node.lens) {
        usedLenses.add(node.lens);
      }
      const fill = node.lens ? SVG_LENS_FILLS[node.lens] : "#ffffff";
      const name = node.path.split("/").pop() ?? node.path;
      const marker = node.status === "deleted" ? "× " : node.status === "added" ? "+ " : node.status === "renamed" ? "→ " : "";
      const detail = `${node.path}\n+${node.churn_added}/-${node.churn_removed} ${node.status}${node.lens ? `\nlens: ${node.lens}` : ""}`;
      cells.push(
        `<g data-map-file="${esc(node.path)}"${node.old_path ? ` data-map-file-old="${esc(node.old_path)}"` : ""} style="cursor:pointer">` +
          `<rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="6" fill="${fill}" stroke="#6b7280"${node.status === "deleted" ? ` stroke-dasharray="2 2"` : ""}/>` +
          `<text x="${x + 8}" y="${y + 17}" font-size="12">${esc(marker)}${esc(truncateLabel(name))}</text>` +
          `<text x="${x + 8}" y="${y + 32}" font-size="10" fill="#666">+${esc(node.churn_added)}/-${esc(node.churn_removed)}${node.lens ? ` · ${esc(node.lens)}` : ""}</text>` +
          `<title>${esc(detail)}</title>` +
          `</g>`
      );
      row += 1;
    }
    if (overflow > 0) {
      const y = PADDING + HEADER_HEIGHT + row * (NODE_HEIGHT + ROW_GAP);
      cells.push(
        `<text x="${x + 8}" y="${y + 16}" font-size="11" fill="#666">+ ${esc(overflow)} more files</text>`
      );
      row += 1;
    }
    maxRows = Math.max(maxRows, row);
    parts.push(`<text x="${x}" y="${PADDING + 12}" font-size="11" font-weight="600" fill="#444">${esc(cluster.name)}</text>`);
    parts.push(...cells);
  }

  if (halo.length > 0) {
    const x = PADDING + graph.clusters.length * (NODE_WIDTH + COLUMN_GAP);
    parts.push(`<text x="${x}" y="${PADDING + 12}" font-size="11" font-weight="600" fill="#444">blast radius (unchanged)</text>`);
    let row = 0;
    for (const node of halo) {
      const y = PADDING + HEADER_HEIGHT + row * (NODE_HEIGHT + ROW_GAP);
      placed.set(`halo:${node.path}`, { x, y, path: node.path });
      parts.push(
        `<g>` +
          `<rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="6" fill="#f9fafb" stroke="#6b7280" stroke-dasharray="5 5"/>` +
          `<text x="${x + 8}" y="${y + 24}" font-size="11" fill="#444">${esc(truncateLabel(node.path.split("/").pop() ?? node.path))}</text>` +
          `<title>${esc(`${node.path}\nunchanged importer of: ${node.imports.join(", ")}`)}</title>` +
          `</g>`
      );
      row += 1;
    }
    if (haloOverflow > 0) {
      const y = PADDING + HEADER_HEIGHT + row * (NODE_HEIGHT + ROW_GAP);
      parts.push(`<text x="${x + 8}" y="${y + 16}" font-size="11" fill="#666">+ ${esc(haloOverflow)} more files</text>`);
      row += 1;
    }
    maxRows = Math.max(maxRows, row);
  }

  // Edges: model edges are importer -> imported; draw dependency -> dependent
  // (right edge of the imported node to the left edge of the importer) so the
  // flow agrees with the tour. Cubic curves; deterministic order (model order).
  const edgeParts: string[] = [];
  for (const edge of graph.edges) {
    const from = placed.get(edge.to);
    const to = placed.get(edge.from);
    if (!from || !to) {
      continue;
    }
    edgeParts.push(curve(from, to, edge.kind === "removed" ? "#b00020" : edge.kind === "new" ? "#b00020" : "#9ca3af", edge.kind));
  }
  for (const node of halo) {
    const target = placed.get(`halo:${node.path}`);
    if (!target) {
      continue;
    }
    for (const imported of node.imports) {
      const source = placed.get(imported);
      if (source) {
        edgeParts.push(curve(source, target, "#9ca3af", "halo"));
      }
    }
  }

  const width = 2 * PADDING + columnCount * NODE_WIDTH + Math.max(0, columnCount - 1) * COLUMN_GAP;
  const height = 2 * PADDING + HEADER_HEIGHT + Math.max(1, maxRows) * (NODE_HEIGHT + ROW_GAP);
  const svg =
    `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Change map" ` +
    `style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:${width}px">` +
    `<defs><marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9ca3af"/></marker></defs>` +
    edgeParts.join("") +
    parts.join("") +
    `</svg>`;
  return { svg, lenses: [...usedLenses].sort() };
}

function truncateLabel(name: string): string {
  return name.length <= 26 ? name : `${name.slice(0, 23)}...`;
}

function curve(from: PlacedNode, to: PlacedNode, stroke: string, kind: string): string {
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  const mid = (x1 + x2) / 2;
  const dash = kind === "halo" || kind === "removed" ? ` stroke-dasharray="4 4"` : "";
  return `<path d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="1.2"${dash} marker-end="url(#map-arrow)"/>`;
}
