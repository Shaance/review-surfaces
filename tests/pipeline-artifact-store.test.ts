import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVENANCE_ARTIFACTS } from "../src/collector/artifact-provenance";
import { CollectionResult } from "../src/collector/collect";
import { IntentModel } from "../src/intent/intent";
import { createPipelineArtifactStoreForCollection } from "../src/pipeline/artifact-store";
import { writeIntentArtifact } from "../src/render/packet";

function collection(outputDir: string, signature: string): CollectionResult {
  return {
    outputDir,
    manifest: { signature }
  } as unknown as CollectionResult;
}

const intent: IntentModel = {
  summary: "store fixture",
  requirements: [],
  constraints: [],
  non_goals: [],
  assumptions: [],
  open_questions: [],
  sources: []
};

test("pipeline artifact store gates artifact loads on per-artifact producing signatures", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-artifact-store-"));
  try {
    fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({ signature: "sig-a" }, null, 2));
    await writeIntentArtifact(tmp, intent);

    const currentStore = createPipelineArtifactStoreForCollection(collection(tmp, "sig-a"));
    assert.equal(currentStore.loadCurrentIntent(), null, "unstamped artifacts are not current");

    await currentStore.stamp([PROVENANCE_ARTIFACTS.intent]);
    assert.deepEqual(currentStore.loadCurrentIntent(), intent, "stamped artifacts load while the signature matches");
    assert.equal(currentStore.isCurrent(PROVENANCE_ARTIFACTS.evaluation), false, "unstamped sibling artifacts stay stale");

    const staleStore = createPipelineArtifactStoreForCollection(collection(tmp, "sig-b"));
    assert.equal(staleStore.loadCurrentIntent(), null, "artifacts with an old producing signature do not load");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pipeline artifact store stamps the shared packet artifact set consistently", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-artifact-store-packet-"));
  try {
    fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({ signature: "sig-packet" }, null, 2));
    const store = createPipelineArtifactStoreForCollection(collection(tmp, "sig-packet"));

    await store.stampPacketArtifacts({ includeDogfood: true });

    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8")) as {
      artifact_signatures: Record<string, string>;
    };
    for (const artifact of [
      PROVENANCE_ARTIFACTS.intent,
      PROVENANCE_ARTIFACTS.evaluation,
      PROVENANCE_ARTIFACTS.methodology,
      PROVENANCE_ARTIFACTS.risks,
      PROVENANCE_ARTIFACTS.packet,
      PROVENANCE_ARTIFACTS.dogfood
    ]) {
      assert.equal(manifest.artifact_signatures[artifact], "sig-packet");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
