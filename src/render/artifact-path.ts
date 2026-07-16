import path from "node:path";

/** Resolve review_packet.json under an artifact directory or from an explicit JSON path. */
export function resolvePacketPath(cwd: string, outDir?: string): string {
  const base = path.resolve(cwd, outDir ?? ".review-surfaces");
  return base.endsWith(".json") ? base : path.join(base, "review_packet.json");
}
