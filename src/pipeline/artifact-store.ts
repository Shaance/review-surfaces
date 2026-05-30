import {
  ArtifactSignatures,
  PROVENANCE_ARTIFACTS,
  readArtifactSignatures,
  stampArtifactSignatures
} from "../collector/artifact-provenance";
import { CollectionResult } from "../collector/collect";
import { DogfoodModel } from "../dogfood/dogfood";
import { EvaluationModel } from "../evaluation/evaluate";
import { IntentModel } from "../intent/intent";
import { MethodologyModel } from "../methodology/methodology";
import { RisksModel } from "../risks/risks";
import { loadDogfood, loadEvaluation, loadIntent, loadMethodology, loadRisks } from "../render/load";

export interface PipelineArtifactStoreOptions {
  outputDir: string;
  currentSignature?: string;
  artifactSignatures?: ArtifactSignatures;
}

export class PipelineArtifactStore {
  private artifactSignatures: ArtifactSignatures | undefined;

  constructor(private readonly options: PipelineArtifactStoreOptions) {
    this.artifactSignatures = options.artifactSignatures;
  }

  producingSignature(artifactFile: string): string | undefined {
    return this.signatures()[artifactFile];
  }

  // A prior-stage artifact is only safe to load when its own producing signature
  // equals the current collection signature. The top-level manifest signature is
  // not enough: collect can refresh manifest.json while leaving older artifacts in
  // place, and their carried-forward producing signatures are the stale signal.
  isCurrent(artifactFile: string): boolean {
    return (
      typeof this.options.currentSignature === "string" &&
      this.producingSignature(artifactFile) === this.options.currentSignature
    );
  }

  loadCurrentIntent(): IntentModel | null {
    return this.isCurrent(PROVENANCE_ARTIFACTS.intent) ? loadIntent(this.options.outputDir) : null;
  }

  loadCurrentEvaluation(): EvaluationModel | null {
    return this.isCurrent(PROVENANCE_ARTIFACTS.evaluation) ? loadEvaluation(this.options.outputDir) : null;
  }

  loadCurrentMethodology(): MethodologyModel | null {
    return this.isCurrent(PROVENANCE_ARTIFACTS.methodology) ? loadMethodology(this.options.outputDir) : null;
  }

  loadCurrentRisks(): RisksModel | null {
    return this.isCurrent(PROVENANCE_ARTIFACTS.risks) ? loadRisks(this.options.outputDir) : null;
  }

  loadCurrentDogfood(): DogfoodModel | null {
    return this.isCurrent(PROVENANCE_ARTIFACTS.dogfood) ? loadDogfood(this.options.outputDir) : null;
  }

  async stamp(artifactFiles: string[]): Promise<void> {
    await stampArtifactSignatures(this.options.outputDir, artifactFiles, this.options.currentSignature);
    this.artifactSignatures = undefined;
  }

  async stampPacketArtifacts(options: { includeDogfood: boolean }): Promise<void> {
    await this.stamp([
      PROVENANCE_ARTIFACTS.intent,
      PROVENANCE_ARTIFACTS.evaluation,
      PROVENANCE_ARTIFACTS.methodology,
      PROVENANCE_ARTIFACTS.risks,
      PROVENANCE_ARTIFACTS.packet,
      ...(options.includeDogfood ? [PROVENANCE_ARTIFACTS.dogfood] : [])
    ]);
  }

  private signatures(): ArtifactSignatures {
    if (this.artifactSignatures === undefined) {
      this.artifactSignatures = readArtifactSignatures(this.options.outputDir);
    }
    return this.artifactSignatures;
  }
}

export function createPipelineArtifactStore(options: PipelineArtifactStoreOptions): PipelineArtifactStore {
  return new PipelineArtifactStore(options);
}

export function createPipelineArtifactStoreForCollection(collection: CollectionResult): PipelineArtifactStore {
  return createPipelineArtifactStore({
    outputDir: collection.outputDir,
    currentSignature: collection.manifest.signature
  });
}

export function artifactSignaturesFromManifest(manifest: unknown): ArtifactSignatures {
  const map =
    manifest && typeof manifest === "object" && "artifact_signatures" in manifest
      ? (manifest as { artifact_signatures?: unknown }).artifact_signatures
      : undefined;
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
}
