// review-surfaces.CHANGE_MAP.2 / MAP_SCALE.2: the cockpit's one change-map
// budget. A visual that cannot render legibly must summarize, never shrink,
// and changed-file overflow stays explicit. Unchanged-file halo facts remain
// available in the JSON model but deliberately stay out of the visual map.
import { ChangeGraph } from "./contract";

// Hard caps for the HTML/SVG supporting map: overflow is rendered explicitly,
// never silently dropped.
export const MAX_CHANGED_NODES = 25;

// File-level SVG layout constants (RENDER.11). They live here so the natural
// width the budget reasons about and the width the renderer draws can never
// drift apart.
export const SVG_NODE_WIDTH = 200;
export const SVG_NODE_HEIGHT = 40;
export const SVG_COLUMN_GAP = 60;
export const SVG_ROW_GAP = 14;
export const SVG_PADDING = 16;
export const SVG_HEADER_HEIGHT = 50;

// The cockpit renders the map inside a ~980px column.
export const COCKPIT_WIDTH_PX = 980;

export type ChangeMapLevel = "file" | "overview";

// The overview leads when the file-level map would hide changed files behind
// overflow nodes. The SVG detail map wraps columns into bounded bands.
export function changeMapLeadLevel(graph: ChangeGraph): ChangeMapLevel {
  if (graph.nodes.length === 0) {
    return "file";
  }
  if (graph.nodes.length > MAX_CHANGED_NODES) {
    return "overview";
  }
  return "file";
}
