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
import { ChangeGraph, ChangeGraphOverview, RiskLens, RISK_LENS_METADATA } from "./contract";
import { esc } from "./esc";
// review-surfaces.MAP_SCALE.2: caps and layout constants live in the ONE
// legibility-budget module so the natural width the budget reasons about and
// the width this renderer draws can never drift apart.
import {
  COCKPIT_WIDTH_PX,
  MAX_CHANGED_NODES,
  MAX_HALO_NODES,
  SVG_COLUMN_GAP as COLUMN_GAP,
  SVG_HEADER_HEIGHT as HEADER_HEIGHT,
  SVG_NODE_HEIGHT as NODE_HEIGHT,
  SVG_NODE_WIDTH as NODE_WIDTH,
  SVG_PADDING as PADDING,
  SVG_ROW_GAP as ROW_GAP,
  svgNaturalWidth
} from "./legibility-budget";

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
  architecture: "#ffe4d6",
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
  architecture: "#c2410c",
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

  const width = svgNaturalWidth(columnCount);
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

// ---------------------------------------------------------------------------
// review-surfaces.MAP_SCALE.2: the overview-level SVG — one card per group in
// model order, laid out as a wrapped grid that fits the cockpit width budget
// BY CONSTRUCTION (height grows, width never), plus the single dashed halo
// card and weighted inter-group edges. Same deterministic, hand-rolled,
// dependency-free approach as the file-level map; every label goes through
// esc(); group cards carry data-map-group for the Phase 2 zoom interaction.

const GROUP_WIDTH = 220;
const GROUP_HEIGHT = 64;
const GROUP_GAP_X = 44;
const GROUP_GAP_Y = 40;

interface PlacedGroup {
  x: number;
  y: number;
}

export function renderChangeMapOverviewSvg(overview: ChangeGraphOverview): RenderedSvgMap | undefined {
  if (overview.groups.length === 0) {
    return undefined;
  }
  // Wrapped grid: as many cards per row as the width budget allows, never fewer
  // than one. Natural width therefore never exceeds COCKPIT_WIDTH_PX.
  const perRow = Math.max(1, Math.floor((COCKPIT_WIDTH_PX - 2 * PADDING + GROUP_GAP_X) / (GROUP_WIDTH + GROUP_GAP_X)));
  const cards = overview.groups.length + (overview.halo_count > 0 ? 1 : 0);
  const columns = Math.min(perRow, cards);
  const rows = Math.ceil(cards / perRow);
  const width = 2 * PADDING + columns * GROUP_WIDTH + (columns - 1) * GROUP_GAP_X;
  const height = 2 * PADDING + rows * GROUP_HEIGHT + (rows - 1) * GROUP_GAP_Y;

  const placed = new Map<string, PlacedGroup>();
  const usedLenses = new Set<RiskLens>();
  const parts: string[] = [];
  for (const [index, group] of overview.groups.entries()) {
    const x = PADDING + (index % perRow) * (GROUP_WIDTH + GROUP_GAP_X);
    const y = PADDING + Math.floor(index / perRow) * (GROUP_HEIGHT + GROUP_GAP_Y);
    placed.set(group.name, { x, y });
    if (group.lens) {
      usedLenses.add(group.lens);
    }
    const fill = group.lens ? SVG_LENS_FILLS[group.lens] : "#ffffff";
    const lensLabel = group.lens ? RISK_LENS_METADATA[group.lens]?.label ?? group.lens : undefined;
    const detail =
      `${group.name}\n${group.file_count} file(s) in ${group.cluster_count} cluster(s)\n` +
      `+${group.churn_added}/-${group.churn_removed} · ${group.queue_count} review queue item(s)` +
      (lensLabel ? `\ndominant lens: ${lensLabel}` : "");
    parts.push(
      `<g data-map-group="${esc(group.name)}">` +
        `<rect x="${x}" y="${y}" width="${GROUP_WIDTH}" height="${GROUP_HEIGHT}" rx="8" fill="${fill}" stroke="#6b7280"/>` +
        `<text x="${x + 10}" y="${y + 18}" font-size="12" font-weight="600">${esc(truncateLabel(group.name))}</text>` +
        `<text x="${x + 10}" y="${y + 36}" font-size="10" fill="#444">${esc(group.file_count)} file(s) · ${esc(group.cluster_count)} cluster(s)</text>` +
        `<text x="${x + 10}" y="${y + 52}" font-size="10" fill="#666">+${esc(group.churn_added)}/-${esc(group.churn_removed)}${group.queue_count > 0 ? ` · queue ${esc(group.queue_count)}` : ""}</text>` +
        `<title>${esc(detail)}</title>` +
        `</g>`
    );
  }
  if (overview.halo_count > 0) {
    const index = overview.groups.length;
    const x = PADDING + (index % perRow) * (GROUP_WIDTH + GROUP_GAP_X);
    const y = PADDING + Math.floor(index / perRow) * (GROUP_HEIGHT + GROUP_GAP_Y);
    parts.push(
      `<g>` +
        `<rect x="${x}" y="${y}" width="${GROUP_WIDTH}" height="${GROUP_HEIGHT}" rx="8" fill="#f9fafb" stroke="#6b7280" stroke-dasharray="5 5"/>` +
        `<text x="${x + 10}" y="${y + 26}" font-size="12" font-weight="600" fill="#444">blast radius</text>` +
        `<text x="${x + 10}" y="${y + 44}" font-size="10" fill="#666">${esc(overview.halo_count)} unchanged importer(s)</text>` +
        `<title>${esc(`${overview.halo_count} unchanged importer(s) of changed files`)}</title>` +
        `</g>`
    );
  }

  // Edges: model direction is importer-group -> imported-group; draw
  // dependency -> dependent like the file-level map. Weight rides on a small
  // midpoint label; new/removed flags color the stroke.
  const edgeParts: string[] = [];
  for (const edge of overview.edges) {
    const from = placed.get(edge.to);
    const to = placed.get(edge.from);
    if (!from || !to) {
      continue;
    }
    const x1 = from.x + GROUP_WIDTH;
    const y1 = from.y + GROUP_HEIGHT / 2;
    const x2 = to.x;
    const y2 = to.y + GROUP_HEIGHT / 2;
    const mid = (x1 + x2) / 2;
    const stroke = edge.has_new || edge.has_removed ? "#b00020" : "#9ca3af";
    const dash = edge.has_removed && !edge.has_new ? ` stroke-dasharray="4 4"` : "";
    // Discrete stroke steps (no float math in attributes): heavier aggregate
    // edges read as heavier lines.
    const strokeWidth = edge.weight >= 8 ? 3 : edge.weight >= 4 ? 2.4 : edge.weight >= 2 ? 1.8 : 1.2;
    edgeParts.push(
      `<path d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${dash} marker-end="url(#map-arrow)"/>` +
        `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" font-size="9" fill="#666" text-anchor="middle">×${esc(edge.weight)}${edge.has_new ? " new" : ""}${edge.has_removed ? " removed" : ""}</text>`
    );
  }

  const svg =
    `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Change map overview" ` +
    `style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:${width}px">` +
    `<defs><marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9ca3af"/></marker></defs>` +
    edgeParts.join("") +
    parts.join("") +
    `</svg>`;
  return { svg, lenses: [...usedLenses].sort() };
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
