// review-surfaces.MAP_SCALE.2: the ONE legibility-budget module. Every map
// surface (cockpit SVG, markdown mermaid, sticky comment) asks this module
// which level of the change map leads; renderers must not carry private size
// thresholds. The standing rule (docs/history/POLISH_UPLIFT_GOAL.md): a visual that cannot
// render legibly must SUMMARIZE, never shrink — scale-to-fit below ~90% of
// natural size is a rendering bug, and overflow stays explicit.
import { ChangeGraph } from "./contract";

// Hard caps shared by BOTH change-map emitters (CHANGE_MAP.2): overflow is
// rendered as an explicit "+ N more files" entry, never silently dropped.
export const MAX_CHANGED_NODES = 25;
export const MAX_HALO_NODES = 10;

// File-level SVG layout constants (RENDER.11). They live here so the natural
// width the budget reasons about and the width the renderer draws can never
// drift apart.
export const SVG_NODE_WIDTH = 200;
export const SVG_NODE_HEIGHT = 40;
export const SVG_COLUMN_GAP = 60;
export const SVG_ROW_GAP = 14;
export const SVG_PADDING = 16;
export const SVG_HEADER_HEIGHT = 50;

// The cockpit renders the map inside a ~980px column; an SVG whose natural
// width exceeds COCKPIT_WIDTH_PX / MIN_FULL_SIZE_SCALE would display below
// ~90% of natural size — the summarize-never-shrink line.
export const COCKPIT_WIDTH_PX = 980;
export const MIN_FULL_SIZE_SCALE = 0.9;

// Natural width of the file-level layered SVG for a given column count —
// the exact formula renderChangeMapSvg draws with.
export function svgNaturalWidth(columnCount: number): number {
  return 2 * SVG_PADDING + columnCount * SVG_NODE_WIDTH + Math.max(0, columnCount - 1) * SVG_COLUMN_GAP;
}

// Columns the file-level map needs: one per changed-file cluster. Blast-radius
// facts stay in the model and risk surfaces, but they no longer add a human-map
// column because that made the zoom view read like it had orphan links.
export function fileLevelColumnCount(graph: ChangeGraph): number {
  return graph.clusters.length;
}

export type ChangeMapLevel = "file" | "overview";
export type ChangeMapSurface = "svg" | "mermaid";

// The single per-surface decision (MAP_SCALE.2): the overview leads when the
// file-level map cannot render legibly at full size on that surface. The node
// cap hiding changed files behind "+ N more" texts forces the overview
// everywhere (an over-capped map is neither an overview nor a detail view —
// evidence-log failure 2). Width forces it only on mermaid surfaces: the
// cockpit SVG wraps columns into bands (MAP_SCALE.5) so its width never
// exceeds the budget, while a mermaid flowchart cannot wrap and GitHub
// scales it down linearly.
export function changeMapLeadLevel(graph: ChangeGraph, surface: ChangeMapSurface): ChangeMapLevel {
  if (graph.nodes.length === 0) {
    return "file";
  }
  if (graph.nodes.length > MAX_CHANGED_NODES) {
    return "overview";
  }
  if (surface === "mermaid" && svgNaturalWidth(fileLevelColumnCount(graph)) > COCKPIT_WIDTH_PX / MIN_FULL_SIZE_SCALE) {
    return "overview";
  }
  return "file";
}
