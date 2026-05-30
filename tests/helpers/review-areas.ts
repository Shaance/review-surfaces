import { buildReviewAreas, ReviewArea } from "../../src/review-areas/areas";
import { loadConfig } from "../../src/config/config";

/**
 * Load this repository's own review areas from review-surfaces.config.yaml so
 * tests can exercise path->group mapping without hardcoding the area list.
 */
export async function defaultReviewSurfacesAreas(): Promise<ReviewArea[]> {
  const config = await loadConfig(process.cwd());
  return buildReviewAreas({ config }).areas;
}
