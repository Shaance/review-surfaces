// review-surfaces.DISTRIBUTION.1-4 — distribution and repository hygiene
// (open-source uplift Phase 3; docs/history/OPEN_SOURCE_UPLIFT_GOAL.md closes
// cold-start failure 5: publish-ready but unpublished, no LICENSE, README
// assumed Acai conventions and showed none of the shipped visuals).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), "utf8");

test("review-surfaces.DISTRIBUTION.1 LICENSE (MIT) and CONTRIBUTING.md exist with the required content", () => {
  const license = read("LICENSE");
  assert.match(license, /^MIT License/, "LICENSE is MIT");
  assert.match(license, /Copyright \(c\)/);

  const contributing = read("CONTRIBUTING.md");
  for (const required of ["pnpm install", "local-gate", "local-review", "PR expectations"]) {
    assert.ok(contributing.includes(required), `CONTRIBUTING.md covers "${required}"`);
  }

  // The package manifest is publish-consistent with the LICENSE file.
  const manifest = JSON.parse(read("package.json")) as { license?: string; files?: string[]; private?: boolean };
  assert.equal(manifest.license, "MIT");
  assert.notEqual(manifest.private, true, "package must stay publishable");
  assert.ok(manifest.files?.includes("schemas"), "bundled schemas ship in the package");
});

test("review-surfaces.DISTRIBUTION.2 internal process docs live under docs/history/ with a framing README", () => {
  const movedDocs = [
    "CODEX_GOAL.md",
    "HUMAN_REVIEW_UPLIFT_GOAL.md",
    "NEXT_VALUE_UPLIFT_GOAL.md",
    "VISUAL_VALUE_UPLIFT_GOAL.md",
    "OPEN_SOURCE_UPLIFT_GOAL.md",
    "README.bootstrap.md",
    "next-value-brainstorm-2026-06.md",
    "visual-value-brainstorm-2026-06.md"
  ];
  for (const doc of movedDocs) {
    assert.ok(fs.existsSync(path.join(root, "docs", "history", doc)), `docs/history/${doc} exists`);
    assert.ok(!fs.existsSync(path.join(root, doc)), `${doc} no longer sits at the repository root`);
  }
  const framing = read("docs/history/README.md");
  assert.match(framing, /built by .*agents/i, "the framing README tells the built-by-agents story");
  assert.match(framing, /reviewed with itself/i);

  // Inbound references point at the new location.
  assert.ok(read("review-surfaces.config.yaml").includes("docs/history/OPEN_SOURCE_UPLIFT_GOAL.md"));
  assert.ok(read("features/review-surfaces.feature.yaml").includes("docs/history/OPEN_SOURCE_UPLIFT_GOAL.md"));
  assert.ok(!read("src/config/config.ts").includes("README.bootstrap.md"), "the scaffolded default config drops the moved bootstrap README");
});

test("review-surfaces.DISTRIBUTION.3 README is written for a stranger's first five minutes", () => {
  const readme = read("README.md");

  // Leads with the three trust questions, before anything Acai-shaped.
  const firstScreen = readme.slice(0, 1500);
  assert.match(firstScreen, /Did the agent overreach/i);
  assert.match(firstScreen, /weaken tests/i);
  assert.match(firstScreen, /claim things it didn'?t do/i);

  // An npx quickstart that works on a spec-less repo (no --spec flag in it).
  const quickstart = readme.slice(readme.indexOf("## Quickstart"), readme.indexOf("## What you get"));
  assert.match(quickstart, /npx review-surfaces all --base origin\/main --head HEAD/);
  assert.ok(!quickstart.includes("--spec"), "the quickstart must not require a spec");

  // A what-you-get tour with screenshots from a real run, and the images exist.
  for (const image of ["docs/images/cockpit.png", "docs/images/change-map.png", "docs/images/sticky-comment.png"]) {
    assert.ok(readme.includes(image), `README embeds ${image}`);
    assert.ok(fs.statSync(path.join(root, image)).size > 10_000, `${image} is a real screenshot`);
  }

  // An explicit scope statement: TS/JS-first deep analysis, language-agnostic
  // coverage (lcov) and test-weakening.
  assert.match(readme, /TypeScript\/JavaScript-first/i);
  assert.match(readme, /lcov/);
  assert.match(readme, /[Tt]est-weakening/);

  // Acai specs are the optional power-user layer, not the prerequisite.
  const acaiIndex = readme.indexOf("Acai-style feature specs");
  assert.ok(acaiIndex > readme.indexOf("## Quickstart"), "specs are introduced after the zero-config quickstart");
  assert.match(readme.replace(/\s+/g, " "), /spec-less repos are a first-class path/i);
});

test("review-surfaces.DISTRIBUTION.4 the local gate includes the pnpm pack smoke test; publish stays manual", () => {
  const gate = read("scripts/local-gate.sh");
  assert.match(gate, /pnpm pack --pack-destination/, "the gate packs the tarball");
  assert.match(gate, /pnpm add .*tgz|pnpm add "\.\/\$\(basename/, "the gate installs the packed tarball");
  assert.match(gate, /review-surfaces" all --provider mock/, "the installed binary runs a real pipeline outside the repo");
  assert.match(gate, /validate \.rs --surface all/, "the installed binary validates from outside the repo");
  // npm publish is the owner's manual step — prepared, never run by the gate.
  assert.ok(!gate.includes("npm publish") && !gate.includes("pnpm publish"), "the gate never publishes");
  const manifest = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  assert.equal(manifest.scripts?.prepublishOnly, "pnpm run build", "publish remains prepared via prepublishOnly");
  // prepack guarantees the tarball carries dist/ even from a clean checkout
  // (pnpm pack / npm pack run prepack; prepublishOnly only runs on publish).
  assert.equal(manifest.scripts?.prepack, "pnpm run build", "pack always builds first");
  assert.match(gate, /rm -rf dist\n/, "the smoke packs from a clean dist");
});
