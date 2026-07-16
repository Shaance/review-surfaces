// review-surfaces.CHANGE_MAP.2 / RENDER.11: deterministic, dark-mode-readable
// inline-SVG change map for the HTML cockpit, rendered directly from the shared
// change_graph model. No chart or diagram library and no inlined mermaid.js.
// Hand-rolled layout:
// one column per cluster (in the model's tour-agreeing order), stable row
// order within a column, fixed viewBox, system font stack. Columns wrap into
// bands and long stacks split into continuation slots (MAP_SCALE.5) so no
// rendered map ever exceeds the cockpit width budget — height grows, width
// never. Every coordinate derives from sorted input, so identical models
// produce byte-identical SVG.
// Every interpolated label passes through the shared redact-then-escape esc()
// helper; hover details ride on <title> elements so the map degrades gracefully
// in print. Node click filters the queue via the existing data- attribute
// pattern (data-map-file), wired by the cockpit's vanilla JS.
import { ChangeGraph, ChangeGraphOverview, RiskLens, RISK_LENS_METADATA } from "./contract";
import { compareStrings } from "../core/compare";
import { esc } from "./esc";
// review-surfaces.MAP_SCALE.2: caps and layout constants live in the ONE
// legibility-budget module so the natural width the budget reasons about and
// the width this renderer draws can never drift apart.
import {
  COCKPIT_WIDTH_PX,
  MAX_CHANGED_NODES,
  SVG_COLUMN_GAP as COLUMN_GAP,
  SVG_HEADER_HEIGHT as HEADER_HEIGHT,
  SVG_NODE_HEIGHT as NODE_HEIGHT,
  SVG_NODE_WIDTH as NODE_WIDTH,
  SVG_PADDING as PADDING,
  SVG_ROW_GAP as ROW_GAP
} from "./legibility-budget";
import { DetailStub } from "./change-graph";

// Print-safe fills paired with the lens name in the node's <title> and the
// legend the cockpit renders next to the map — color never carries meaning
// alone. One palette shared by overview and detail renderers
// its classDefs from it) so the two maps can never color a lens differently.
export const SVG_LENS_FILLS: Record<RiskLens, string> = {
  api_contract: "#f3ede6",
  security_privacy: "#f3ede6",
  llm_trust_boundary: "#ebeae5",
  test_evidence: "#e3ebf3",
  reviewer_ux: "#e6e5e0",
  cache_provenance: "#e4efe8",
  supply_chain: "#f1e6ea",
  architecture: "#f3ede6",
  custom: "#ebeae5"
};

export const LENS_STROKES: Record<RiskLens, string> = {
  api_contract: "#cf2d56",
  security_privacy: "#c08532",
  llm_trust_boundary: "#c08532",
  test_evidence: "#3a6a9f",
  reviewer_ux: "#6049b3",
  cache_provenance: "#1f8a65",
  supply_chain: "#aa52a2",
  architecture: "#f54e00",
  custom: "#6f6a60"
};

const MAP_TEXT = "#26251e";
const MAP_STRONG = "#050503";
const MAP_MUTED = "#6f6a60";
const MAP_CARD = "#f2f1ed";
const MAP_CARD_ALT = "#ebeae5";
const MAP_LINE = "#d9d5cf";
const MAP_LINE_STRONG = "#aaa49a";

export interface RenderedSvgMap {
  svg: string;
  // Lenses that actually appear on the map, for the cockpit's text legend.
  lenses: RiskLens[];
}

// One column slot in the wrapped layout: a header plus stacked cells. Long
// file stacks split into continuation slots (MAP_SCALE.5) so height stays
// usable while WIDTH never exceeds the budget.
interface ColumnSlot {
  header: string;
  summary?: string;
  dashedHeader: boolean;
  cells: ColumnCell[];
}

type ColumnCell =
  | { kind: "node"; node: ChangeGraph["nodes"][number] }
  | { kind: "overflow"; count: number };

interface PlacedNode {
  x: number;
  y: number;
  path: string;
}

interface VisibleClusterNodes {
  cluster: ChangeGraph["clusters"][number];
  visible: ChangeGraph["nodes"][number][];
  overflow: number;
}

// Stacks taller than this wrap into a continuation column slot.
const MAX_STACK_ROWS = 12;
// Vertical gap between wrapped bands of columns.
const BAND_GAP = 26;
const RELATION_LANE_TOP_GAP = 16;
const RELATION_LANE_GAP = 28;
const MAX_RENDERED_RELATIONSHIPS = 4;
// Columns per band: as many as the width budget allows, never fewer than one.
const COLUMNS_PER_BAND = Math.max(1, Math.floor((COCKPIT_WIDTH_PX - 2 * PADDING + COLUMN_GAP) / (NODE_WIDTH + COLUMN_GAP)));

export interface RenderChangeMapSvgOptions {
  // review-surfaces.MAP_SCALE.4/.7: raw cross-area import stubs stay out of the
  // SVG file map. Stub metadata stays in the JSON model, but this renderer only
  // draws relationships between exact visible files.
  stubs?: DetailStub[];
  ariaLabel?: string;
}

export function renderChangeMapSvg(graph: ChangeGraph, options: RenderChangeMapSvgOptions = {}): RenderedSvgMap | undefined {
  if (graph.nodes.length === 0) {
    return undefined;
  }
  const nodeByPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const usedLenses = new Set<RiskLens>();

  // Build column slots first (cluster columns in model order with the global
  // node cap counted in that order), splitting long stacks into continuation
  // slots; only then place slots into wrapped bands (MAP_SCALE.5: height may
  // grow, width never exceeds the budget).
  const slots: ColumnSlot[] = [];
  for (const entry of visibleClusterNodes(graph.clusters, nodeByPath)) {
    const cells: ColumnCell[] = [];
    for (const node of entry.visible) {
      if (node.lens) {
        usedLenses.add(node.lens);
      }
      cells.push({ kind: "node", node });
    }
    if (entry.overflow > 0) {
      cells.push({ kind: "overflow", count: entry.overflow });
    }
    pushSlots(slots, entry.cluster.label ?? entry.cluster.name, false, cells, entry.cluster.summary);
  }
  // Place slots into bands.
  const placed = new Map<string, PlacedNode>();
  const parts: string[] = [];
  const bandCount = Math.ceil(slots.length / COLUMNS_PER_BAND);
  let bandTop = PADDING;
  let maxRight = 0;
  for (let band = 0; band < bandCount; band += 1) {
    const bandSlots = slots.slice(band * COLUMNS_PER_BAND, (band + 1) * COLUMNS_PER_BAND);
    const bandRows = Math.max(1, ...bandSlots.map((slot) => slot.cells.length));
    for (const [slotIndex, slot] of bandSlots.entries()) {
      const x = PADDING + slotIndex * (NODE_WIDTH + COLUMN_GAP);
      maxRight = Math.max(maxRight, x + NODE_WIDTH);
      parts.push(
        `<text x="${x}" y="${bandTop + 12}" font-size="11" font-weight="600" fill="${slot.dashedHeader ? MAP_MUTED : MAP_TEXT}">${esc(slot.header)}</text>`
      );
      if (slot.summary) {
        parts.push(
          ...wrapLabel(slot.summary, 36, 2).map(
            (line, lineIndex) => `<text x="${x}" y="${bandTop + 27 + lineIndex * 11}" font-size="9" fill="${MAP_MUTED}">${esc(line)}</text>`
          )
        );
      }
      for (const [row, cell] of slot.cells.entries()) {
        const y = bandTop + HEADER_HEIGHT + row * (NODE_HEIGHT + ROW_GAP);
        parts.push(renderCell(cell, x, y, placed));
      }
    }
    bandTop += HEADER_HEIGHT + bandRows * (NODE_HEIGHT + ROW_GAP) + (band < bandCount - 1 ? BAND_GAP : 0);
  }

  let width = maxRight + PADDING;
  const allRelationships = prioritizeRelationships([
    ...buildDetailRelationships(graph, placed)
  ]);
  const relationships = allRelationships.slice(0, MAX_RENDERED_RELATIONSHIPS);
  if (relationships.length > 0) {
    const edgeParts: string[] = [];
    for (const relationship of relationships) {
      const route = routeRelationship(relationship.from, relationship.to);
      edgeParts.push(renderRelationshipLine(route, relationship.detail, relationship.kind));
    }
    parts.unshift(...edgeParts);
  }
  const height = bandTop + PADDING;
  const svg =
    `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(options.ariaLabel ?? "Change map")}" ` +
    `style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:${width}px">` +
    relationshipMarkerDefs() +
    parts.join("") +
    `</svg>`;
  return { svg, lenses: [...usedLenses].sort() };
}

// Allocate the visible-file cap fairly across columns/topics. A sequential cap
// starves later topics into "+ N more files" with no examples, which is exactly
// the unreadable shape MAP_SCALE.8 is meant to avoid.
function visibleClusterNodes(clusters: ChangeGraph["clusters"], nodeByPath: Map<string, ChangeGraph["nodes"][number]>): VisibleClusterNodes[] {
  const entries = clusters.map((cluster) => ({
    cluster,
    nodes: cluster.paths.map((filePath) => nodeByPath.get(filePath)).filter((node): node is ChangeGraph["nodes"][number] => Boolean(node)),
    visible: [] as ChangeGraph["nodes"][number][]
  }));
  const total = entries.reduce((sum, entry) => sum + entry.nodes.length, 0);
  if (total <= MAX_CHANGED_NODES) {
    return entries.map((entry) => ({ cluster: entry.cluster, visible: entry.nodes, overflow: 0 }));
  }

  let remaining = MAX_CHANGED_NODES;
  for (const entry of entries) {
    if (remaining <= 0) {
      break;
    }
    if (entry.nodes[0]) {
      entry.visible.push(entry.nodes[0]);
      remaining -= 1;
    }
  }
  for (let offset = 1; remaining > 0; offset += 1) {
    let added = false;
    for (const entry of entries) {
      const node = entry.nodes[offset];
      if (!node) {
        continue;
      }
      entry.visible.push(node);
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
    cluster: entry.cluster,
    visible: entry.visible,
    overflow: Math.max(0, entry.nodes.length - entry.visible.length)
  }));
}

// Split a column's cells into MAX_STACK_ROWS-tall slots; continuations carry a
// "(cont.)" header so a wrapped stack stays attributable.
function pushSlots(slots: ColumnSlot[], header: string, dashedHeader: boolean, cells: ColumnCell[], summary?: string): void {
  if (cells.length === 0) {
    slots.push({ header, ...(summary ? { summary } : {}), dashedHeader, cells: [] });
    return;
  }
  for (let start = 0; start < cells.length; start += MAX_STACK_ROWS) {
    slots.push({
      header: start === 0 ? header : `${header} (cont.)`,
      ...(start === 0 && summary ? { summary } : {}),
      dashedHeader,
      cells: cells.slice(start, start + MAX_STACK_ROWS)
    });
  }
}

function renderCell(cell: ColumnCell, x: number, y: number, placed: Map<string, PlacedNode>): string {
  if (cell.kind === "overflow") {
    return `<text x="${x + 8}" y="${y + 16}" font-size="11" fill="${MAP_MUTED}">+ ${esc(cell.count)} more files</text>`;
  }
  const node = cell.node;
  placed.set(node.path, { x, y, path: node.path });
  const fill = node.lens ? SVG_LENS_FILLS[node.lens] : MAP_CARD;
  const name = node.path.split("/").pop() ?? node.path;
  const marker = node.status === "deleted" ? "× " : node.status === "added" ? "+ " : node.status === "renamed" ? "→ " : "";
  const detail = `${node.path}\n+${node.churn_added}/-${node.churn_removed} ${node.status}${node.lens ? `\nlens: ${node.lens}` : ""}`;
  return (
    `<g data-map-file="${esc(node.path)}"${node.old_path ? ` data-map-file-old="${esc(node.old_path)}"` : ""} style="cursor:pointer">` +
    `<rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="4" fill="${fill}" stroke="${node.lens ? LENS_STROKES[node.lens] : MAP_LINE}"${node.status === "deleted" ? ` stroke-dasharray="2 2"` : ""}/>` +
    `<text x="${x + 8}" y="${y + 17}" font-size="12" fill="${MAP_STRONG}">${esc(marker)}${esc(truncateLabel(name))}</text>` +
    `<text x="${x + 8}" y="${y + 32}" font-size="10" fill="${MAP_MUTED}">+${esc(node.churn_added)}/-${esc(node.churn_removed)}${node.lens ? ` · ${esc(node.lens)}` : ""}</text>` +
    `<title>${esc(detail)}</title>` +
    `</g>`
  );
}

function buildDetailRelationships(
  graph: ChangeGraph,
  placed: Map<string, PlacedNode>
): Array<{ from: PlacedNode; to: PlacedNode; summary: string; detail: string; kind: ChangeGraph["edges"][number]["kind"]; source: "fallback" | "provider" }> {
  const relationships: Array<{ from: PlacedNode; to: PlacedNode; summary: string; detail: string; kind: ChangeGraph["edges"][number]["kind"]; source: "fallback" | "provider" }> = [];
  for (const edge of graph.edges) {
    if (!shouldRenderFileRelationship(edge)) {
      continue;
    }
    // Model edges are importer -> imported. The visual map draws dependency ->
    // dependent to match the reading order and Mermaid emitter.
    const from = placed.get(edge.to);
    const to = placed.get(edge.from);
    if (!from || !to) {
      continue;
    }
    relationships.push({
      from,
      to,
      kind: edge.kind,
      summary: edge.summary,
      detail: edge.detail ? `${edge.summary}\n${edge.detail}` : edge.summary,
      source: edge.insight_source
    });
  }
  return relationships;
}

function shouldRenderFileRelationship(edge: ChangeGraph["edges"][number]): boolean {
  return edge.insight_source === "provider" || edge.kind === "new" || edge.kind === "removed";
}

function prioritizeRelationships<T extends { source: "fallback" | "provider"; kind?: ChangeGraph["edges"][number]["kind"]; summary: string }>(relationships: T[]): T[] {
  return [...relationships].sort((a, b) => {
    const sourceRank = (b.source === "provider" ? 1 : 0) - (a.source === "provider" ? 1 : 0);
    if (sourceRank !== 0) return sourceRank;
    const kindRank = relationshipKindRank(a.kind) - relationshipKindRank(b.kind);
    if (kindRank !== 0) return kindRank;
    return compareStrings(a.summary, b.summary);
  });
}

function relationshipKindRank(kind: ChangeGraph["edges"][number]["kind"] | undefined): number {
  if (kind === "new") return 0;
  if (kind === "removed") return 1;
  if (kind === "existing") return 2;
  return 3;
}

function routeRelationship(from: PlacedNode, to: PlacedNode): Array<{ x: number; y: number }> {
  const sameColumn = from.x === to.x;
  if (sameColumn) {
    const routeLeft = from.x - COLUMN_GAP / 2 >= PADDING / 2;
    const laneX = routeLeft ? from.x - COLUMN_GAP / 2 : from.x + NODE_WIDTH + PADDING / 2;
    const start = {
      x: routeLeft ? from.x : from.x + NODE_WIDTH,
      y: from.y + NODE_HEIGHT / 2
    };
    const end = {
      x: routeLeft ? to.x : to.x + NODE_WIDTH,
      y: to.y + NODE_HEIGHT / 2
    };
    return [
      start,
      { x: laneX, y: start.y },
      { x: laneX, y: end.y },
      end
    ];
  }
  const fromLeft = to.x < from.x;
  const start = {
    x: fromLeft ? from.x : from.x + NODE_WIDTH,
    y: from.y + NODE_HEIGHT / 2
  };
  const end = {
    x: fromLeft || sameColumn ? to.x + NODE_WIDTH : to.x,
    y: to.y + NODE_HEIGHT / 2
  };
  if (start.y === end.y) {
    const localLaneY = start.y - NODE_HEIGHT / 2 - ROW_GAP / 2;
    const sourceLaneX = fromLeft ? from.x - COLUMN_GAP / 2 : from.x + NODE_WIDTH + COLUMN_GAP / 2;
    const targetLaneX = fromLeft ? to.x + NODE_WIDTH + COLUMN_GAP / 2 : to.x - COLUMN_GAP / 2;
    return [
      start,
      { x: sourceLaneX, y: start.y },
      { x: sourceLaneX, y: localLaneY },
      { x: targetLaneX, y: localLaneY },
      { x: targetLaneX, y: end.y },
      end
    ];
  }
  const direction = end.y > start.y ? 1 : -1;
  const localLaneY = start.y + direction * (NODE_HEIGHT / 2 + ROW_GAP / 2);
  const sourceLaneX = fromLeft ? from.x - COLUMN_GAP / 2 : from.x + NODE_WIDTH + COLUMN_GAP / 2;
  const targetLaneX = fromLeft ? to.x + NODE_WIDTH + COLUMN_GAP / 2 : to.x - COLUMN_GAP / 2;
  return [
    start,
    { x: sourceLaneX, y: start.y },
    { x: sourceLaneX, y: localLaneY },
    { x: targetLaneX, y: localLaneY },
    { x: targetLaneX, y: end.y },
    end
  ];
}

function routeOverviewRelationship(from: PlacedNode, to: PlacedNode, laneY: number, routeRight: number): Array<{ x: number; y: number }> {
  const sameColumn = from.x === to.x;
  const fromLeft = to.x < from.x;
  const start = {
    x: fromLeft ? from.x : from.x + GROUP_WIDTH,
    y: from.y + GROUP_HEIGHT / 2
  };
  const end = {
    x: fromLeft || sameColumn ? to.x + GROUP_WIDTH : to.x,
    y: to.y + GROUP_HEIGHT / 2
  };
  const sourceLaneX = sameColumn ? routeRight : fromLeft ? from.x - GROUP_GAP_X / 2 : from.x + GROUP_WIDTH + GROUP_GAP_X / 2;
  const targetLaneX = sameColumn ? routeRight : fromLeft ? to.x + GROUP_WIDTH + GROUP_GAP_X / 2 : to.x - GROUP_GAP_X / 2;
  return [
    start,
    { x: sourceLaneX, y: start.y },
    { x: sourceLaneX, y: laneY },
    { x: targetLaneX, y: laneY },
    { x: targetLaneX, y: end.y },
    end
  ];
}

function renderRelationshipLine(points: Array<{ x: number; y: number }>, detail: string, kind?: ChangeGraph["edges"][number]["kind"]): string {
  const stroke = kind === "removed" ? MAP_LINE_STRONG : "#8d877d";
  const dash = kind === "removed" ? ` stroke-dasharray="4 4"` : "";
  const pointList = points.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    `<g>` +
    `<polyline points="${pointList}" fill="none" stroke="${stroke}" stroke-width="1.3"${dash} marker-end="url(#map-arrow)"/>` +
    `<title>${esc(detail)}</title>` +
    `</g>`
  );
}

function relationshipMarkerDefs(): string {
  return (
    `<defs>` +
    `<marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
    `<polygon points="0,0 10,5 0,10" fill="#8d877d"/>` +
    `</marker>` +
    `</defs>`
  );
}

function truncateLabel(name: string, maxLength = 26): string {
  return name.length <= maxLength ? name : `${name.slice(0, Math.max(0, maxLength - 3))}...`;
}

function wrapLabel(text: string, maxLength: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let consumed = 0;
  for (const word of words) {
    const boundedWord = truncateLabel(word, maxLength);
    const current = lines[lines.length - 1] ?? "";
    const candidate = current ? `${current} ${word}` : word;
    if (current === "") {
      if (lines.length === 0) {
        lines.push(boundedWord);
      } else {
        lines[lines.length - 1] = boundedWord;
      }
      consumed += 1;
      continue;
    }
    if (candidate.length <= maxLength) {
      lines[lines.length - 1] = candidate;
      consumed += 1;
      continue;
    }
    if (lines.length >= maxLines) {
      break;
    }
    lines.push(boundedWord);
    consumed += 1;
  }
  if (lines.length === 0) {
    return [""];
  }
  if (consumed < words.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length <= Math.max(0, maxLength - 3) ? `${last}...` : truncateLabel(last, maxLength);
  }
  return lines.slice(0, maxLines);
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

// ---------------------------------------------------------------------------
// review-surfaces.MAP_SCALE.2: the overview-level SVG — one card per group in
// model order, laid out as a wrapped grid that fits the cockpit width budget
// BY CONSTRUCTION (height grows, width never), plus high-value cross-area
// relationship routes when provider text makes them review-worthy. Same deterministic,
// hand-rolled, dependency-free approach as the file-level map; every label goes
// through esc(); group cards carry data-map-group for the Phase 2 zoom
// interaction.

const GROUP_WIDTH = 220;
const GROUP_HEIGHT = 108;
const GROUP_GAP_X = 44;
const GROUP_GAP_Y = 40;
const OVERVIEW_EDGE_TOP_GAP = 26;
const OVERVIEW_EDGE_HEADER_HEIGHT = 18;
const OVERVIEW_EDGE_HEIGHT = 30;
const OVERVIEW_EDGE_GAP = 8;

export function renderChangeMapOverviewSvg(overview: ChangeGraphOverview): RenderedSvgMap | undefined {
  if (overview.groups.length === 0) {
    return undefined;
  }
  // Wrapped grid: as many cards per row as the width budget allows, never fewer
  // than one. Natural width therefore never exceeds COCKPIT_WIDTH_PX.
  const perRow = Math.max(1, Math.floor((COCKPIT_WIDTH_PX - 2 * PADDING + GROUP_GAP_X) / (GROUP_WIDTH + GROUP_GAP_X)));
  const cards = overview.groups.length;
  const columns = Math.min(perRow, cards);
  const rows = Math.ceil(cards / perRow);
  let width = 2 * PADDING + columns * GROUP_WIDTH + (columns - 1) * GROUP_GAP_X;
  const gridHeight = rows * GROUP_HEIGHT + (rows - 1) * GROUP_GAP_Y;
  let height = 2 * PADDING + gridHeight;

  const usedLenses = new Set<RiskLens>();
  const parts: string[] = [];
  const placedGroups = new Map<string, PlacedNode>();
  for (const [index, group] of overview.groups.entries()) {
    const x = PADDING + (index % perRow) * (GROUP_WIDTH + GROUP_GAP_X);
    const y = PADDING + Math.floor(index / perRow) * (GROUP_HEIGHT + GROUP_GAP_Y);
    placedGroups.set(group.name, { x, y, path: group.name });
    if (group.lens) {
      usedLenses.add(group.lens);
    }
    const lensLabel = group.lens ? RISK_LENS_METADATA[group.lens]?.label ?? group.lens : undefined;
    const lensTag = group.lens ? shortLensLabel(group.lens) : undefined;
    const accent = group.lens ? SVG_LENS_FILLS[group.lens] : MAP_CARD_ALT;
    const topicCount = group.topics?.length ?? group.cluster_count;
    const detail =
      `${group.name}\n${group.summary}\n${group.file_count} file(s) in ${topicCount} topic(s)\n` +
      `+${group.churn_added}/-${group.churn_removed} · ${group.queue_count} review queue item(s)` +
      (lensLabel ? `\ndominant lens: ${lensLabel}` : "");
    const metrics =
      `+${group.churn_added}/-${group.churn_removed}${group.queue_count > 0 ? ` · queue ${group.queue_count}` : ""}` +
      (lensTag ? ` · ${lensTag}` : "");
    const summaryLines = wrapLabel(group.summary, 38, 2);
    parts.push(
      `<g data-map-group="${esc(group.name)}" style="cursor:pointer">` +
        `<rect x="${x}" y="${y}" width="${GROUP_WIDTH}" height="${GROUP_HEIGHT}" rx="4" fill="${MAP_CARD}" stroke="${MAP_LINE}"/>` +
        (group.lens ? `<rect x="${x}" y="${y}" width="6" height="${GROUP_HEIGHT}" rx="3" fill="${accent}" stroke="none"/>` : "") +
        `<text x="${x + 14}" y="${y + 20}" font-size="12" font-weight="600" fill="${MAP_STRONG}">${esc(truncateLabel(group.name))}</text>` +
        summaryLines.map((line, lineIndex) => `<text x="${x + 14}" y="${y + 39 + lineIndex * 13}" font-size="10" fill="${MAP_TEXT}">${esc(line)}</text>`).join("") +
        `<text x="${x + 14}" y="${y + 72}" font-size="10" fill="${MAP_MUTED}">${esc(group.file_count)} file(s) · ${esc(topicCount)} topic(s)</text>` +
        `<text x="${x + 14}" y="${y + 90}" font-size="10" fill="${MAP_MUTED}">${esc(truncateLabel(metrics, 40))}</text>` +
        `<title>${esc(detail)}</title>` +
        `</g>`
    );
  }
  const overviewRelationships = overview.edges.filter(shouldRenderOverviewRelationship);
  if (overviewRelationships.length > 0) {
    const routeRight = width - PADDING / 2;
    width = Math.max(width, routeRight + PADDING);
    const laneTop = PADDING + gridHeight + RELATION_LANE_TOP_GAP;
    const edgeParts: string[] = [];
    for (const [index, edge] of overviewRelationships.entries()) {
      const from = placedGroups.get(edge.to);
      const to = placedGroups.get(edge.from);
      if (!from || !to) {
        continue;
      }
      const laneY = laneTop + index * RELATION_LANE_GAP;
      const route = routeOverviewRelationship(from, to, laneY, routeRight);
      const kind = edge.has_removed ? "removed" : undefined;
      const detail = edge.detail ?? edge.summary;
      edgeParts.push(renderRelationshipLine(route, detail, kind));
    }
    parts.unshift(...edgeParts);
    height = laneTop + Math.max(0, overviewRelationships.length - 1) * RELATION_LANE_GAP + RELATION_LANE_TOP_GAP + PADDING;
  }

  const svg =
    `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Change map overview" ` +
    `style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:${width}px">` +
    relationshipMarkerDefs() +
    parts.join("") +
    `</svg>`;
  return { svg, lenses: [...usedLenses].sort() };
}

function shouldRenderOverviewRelationship(edge: ChangeGraphOverview["edges"][number]): boolean {
  if (edge.insight_source !== "provider") {
    return false;
  }
  return edge.from !== "tests" && edge.to !== "tests";
}
