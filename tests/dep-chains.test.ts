import test from "node:test";
import assert from "node:assert/strict";
import { computeDependencyFacts } from "../src/risks/dependency-facts";
import { buildHumanReview } from "../src/human/human-review";
import { renderDependencyTreeText } from "../src/diagrams/dep-tree";
import { renderStickySummary } from "../src/render/sticky-summary";
import { renderRiskLensesMarkdown } from "../src/human/render";
import { minimalReviewPacket } from "./helpers/review-packet";
import type { ReviewPacket } from "../src/render/packet";

const HEAD_MANIFEST = JSON.stringify({ dependencies: { "left-pad": "^1.0.0" } });

const BASE_LOCK = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/left-pad": { version: "1.0.0" } } });
const HEAD_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "node_modules/left-pad": { version: "1.1.0", dependencies: { minimist: "^1.2.0" } },
    "node_modules/minimist": { version: "1.2.8", hasInstallScript: true }
  }
});

function factsFor(headLock: string, headManifest: string | undefined = HEAD_MANIFEST) {
  return computeDependencyFacts({
    changedFiles: [{ path: "package-lock.json" }],
    readBase: (filePath) => (filePath === "package-lock.json" ? BASE_LOCK : undefined),
    readHead: (filePath) => (filePath === "package-lock.json" ? headLock : filePath === "package.json" ? headManifest : undefined)
  });
}

test("review-surfaces.DEP_FACTS.4 new transitives are attributed to the direct dependency that pulled them via lockfile dependency edges", () => {
  const facts = factsFor(HEAD_LOCK);
  const transitive = facts.find((fact) => fact.kind === "transitive_added" && fact.package === "minimist");
  assert.equal(transitive?.via, "left-pad");
  // A lockfile whose edges cannot be resolved yields UNATTRIBUTED facts —
  // the honest flat output, never a guessed attribution.
  const noEdges = JSON.stringify({
    lockfileVersion: 3,
    packages: { "node_modules/left-pad": { version: "1.1.0" }, "node_modules/minimist": { version: "1.2.8" } }
  });
  const flat = factsFor(noEdges);
  const flatTransitive = flat.find((fact) => fact.kind === "transitive_added" && fact.package === "minimist");
  assert.equal(flatTransitive?.via, undefined);
  // Without a readable head manifest there are no direct roots: unattributed.
  const noManifest = factsFor(HEAD_LOCK, undefined);
  assert.equal(noManifest.find((fact) => fact.package === "minimist")?.via, undefined);
});

test("review-surfaces.DEP_FACTS.4 pnpm lockfile dependency edges attribute transitives too", () => {
  const basePnpm = `lockfileVersion: '9.0'\npackages:\n  left-pad@1.0.0: {}\n`;
  // v9 shape: edges live under snapshots:, packages: holds metadata only.
  const headPnpm = `lockfileVersion: '9.0'\npackages:\n  left-pad@1.1.0: {}\n  minimist@1.2.8:\n    requiresBuild: true\nsnapshots:\n  left-pad@1.1.0:\n    dependencies:\n      minimist: 1.2.8\n  minimist@1.2.8: {}\n`;
  const facts = computeDependencyFacts({
    changedFiles: [{ path: "pnpm-lock.yaml" }],
    readBase: (filePath) => (filePath === "pnpm-lock.yaml" ? basePnpm : undefined),
    readHead: (filePath) => (filePath === "pnpm-lock.yaml" ? headPnpm : filePath === "package.json" ? HEAD_MANIFEST : undefined)
  });
  const transitive = facts.find((fact) => fact.kind === "transitive_added" && fact.package === "minimist");
  assert.equal(transitive?.via, "left-pad");
});

test("review-surfaces.RENDER.13 attributed chains render in supporting artifacts and stay out of the reviewer brief", () => {
  const packet = { ...(minimalReviewPacket() as unknown as Record<string, unknown>) } as unknown as ReviewPacket;
  const facts = factsFor(HEAD_LOCK);
  const model = buildHumanReview({ packet, dependencyFacts: facts });
  // The model carries the chain with the install-script flag.
  assert.equal(model.dependency_chains?.length, 1);
  assert.equal(model.dependency_chains?.[0].via, "left-pad");
  assert.deepEqual(model.dependency_chains?.[0].transitives, [{ package: "minimist", install_scripts: true }]);
  // Indented text tree on the supply-chain lens surface.
  const lensMd = renderRiskLensesMarkdown(model);
  assert.match(lensMd, /## Dependency chains/);
  assert.match(lensMd, /left-pad \(direct, package-lock\.json\)/);
  assert.match(lensMd, /└─ minimist ⚠ install scripts/);
  // General dependency diagrams do not occupy the GitHub reviewer brief.
  const sticky = renderStickySummary(model).markdown;
  assert.doesNotMatch(sticky, /Dependency chains|flowchart TD|minimist — install scripts/);
  // Flat fallback: unresolvable edges -> no chains, no tree sections.
  const flatModel = buildHumanReview({
    packet,
    dependencyFacts: factsFor(JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/minimist": { version: "1.2.8" } } }))
  });
  assert.equal(flatModel.dependency_chains, undefined);
  assert.doesNotMatch(renderRiskLensesMarkdown(flatModel), /## Dependency chains/);
  assert.doesNotMatch(renderStickySummary(flatModel).markdown, /Dependency chains/);
  assert.deepEqual(renderDependencyTreeText(model.dependency_chains ?? []), [
    "left-pad (direct, package-lock.json)",
    "  └─ minimist ⚠ install scripts"
  ]);
});
