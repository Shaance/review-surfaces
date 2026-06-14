import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../core/files";

/**
 * Round 8 (FINDING B + FINDING C) — per-artifact provenance.
 *
 * The freshness check used to rely on the SHARED manifest.json `signature`: a
 * stage like `collect`/`intent` rewrites manifest.json to the CURRENT signature
 * while leaving older evaluation.yaml/risks.yaml/review_packet.json in place. A
 * later `all --cache` or `packet` then saw a matching top-level signature and
 * reused STALE coverage/risks.
 *
 * The fix records a PRODUCING signature PER ARTIFACT in
 * `manifest.artifact_signatures` (a map of artifact file name -> the collection
 * signature it was produced from). Reuse of an artifact is gated on its OWN
 * recorded producing signature equaling the current collection signature, not on
 * the latest manifest signature.
 *
 * Lifecycle:
 *   - `collect` carries the prior map forward VERBATIM when it rewrites
 *     manifest.json (so stale entries survive as the staleness signal) — see
 *     readArtifactSignatures used by collectInputs.
 *   - each stage stamps the artifacts it (re)writes this run with the current
 *     signature via stampArtifactSignatures, so only freshly-produced artifacts
 *     advance to the current signature.
 *
 * Determinism / byte-stability: the map maps file names to the DETERMINISTIC
 * collection signature, so two identical-input runs produce an identical map.
 * It lives in manifest.json (which already varies by created_at and is never
 * byte-stable across non-frozen runs), so it never perturbs the byte-stable
 * YAML/JSON stage artifacts. The keys are sorted on write so the manifest stays
 * byte-identical across two frozen-clock identical-input runs.
 */

// Artifact file names that carry a producing signature. These are the prior-stage
// artifacts whose reuse (compose / cache) must be gated on provenance.
export const PROVENANCE_ARTIFACTS = {
  intent: "intent.yaml",
  evaluation: "evaluation.yaml",
  methodology: "methodology.yaml",
  risks: "risks.yaml",
  dogfood: "dogfood.yaml",
  packet: "review_packet.json"
} as const;

export type ArtifactSignatures = Record<string, string>;

function manifestPath(outputDir: string): string {
  return path.join(outputDir, "manifest.json");
}

/**
 * Read the `artifact_signatures` map from the manifest at outputDir. Any
 * read/parse failure (no manifest, corrupt manifest, missing field) yields an
 * empty map so the caller treats every artifact as having NO recorded provenance
 * (and therefore recomputes / treats it as a cache miss).
 */
export function readArtifactSignatures(outputDir: string): ArtifactSignatures {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(outputDir), "utf8"));
    const map = parsed && typeof parsed === "object" ? parsed.artifact_signatures : undefined;
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      return {};
    }
    const result: ArtifactSignatures = {};
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Stamp the given artifact file names with `signature` in manifest.json's
 * `artifact_signatures` map, preserving every other entry and writing the keys
 * in sorted order so the manifest is byte-stable across identical-input runs.
 *
 * Called by a stage AFTER it (re)writes the artifact(s), so only freshly-produced
 * artifacts advance to the current signature; stale ones keep their old producing
 * signature until the owning stage reruns. A no-op (and never throws) when the
 * manifest is absent/corrupt, so a stage that runs without a manifest still
 * succeeds — the artifact simply has no recorded provenance.
 */
export async function stampArtifactSignatures(
  outputDir: string,
  artifactFiles: string[],
  signature: string | undefined
): Promise<void> {
  if (signature === undefined || artifactFiles.length === 0) {
    return;
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath(outputDir), "utf8"));
  } catch {
    return; // no/corrupt manifest: nothing to stamp onto.
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return;
  }
  const existing =
    manifest.artifact_signatures && typeof manifest.artifact_signatures === "object" && !Array.isArray(manifest.artifact_signatures)
      ? (manifest.artifact_signatures as Record<string, unknown>)
      : {};
  const merged: ArtifactSignatures = {};
  for (const [key, value] of Object.entries(existing)) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }
  for (const file of artifactFiles) {
    merged[file] = signature;
  }
  manifest.artifact_signatures = sortMap(merged);
  await writeJson(manifestPath(outputDir), manifest);
}

// Sort keys so the serialized manifest is byte-identical for identical input maps
// regardless of stamping order.
function sortMap(map: ArtifactSignatures): ArtifactSignatures {
  const sorted: ArtifactSignatures = {};
  for (const key of Object.keys(map).sort()) {
    sorted[key] = map[key];
  }
  return sorted;
}
