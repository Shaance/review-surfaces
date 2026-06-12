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
  // npm always bundles README.md; its relative screenshot links must resolve
  // inside the tarball too.
  assert.ok(manifest.files?.includes("docs/images"), "README screenshots ship in the package");
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

// review-surfaces.DISTRIBUTION.5-8 — pre-publish polish uplift Phase 3
// (docs/history/POLISH_UPLIFT_GOAL.md, 2026-06-12 legibility evidence-log
// failures 5-6: no pre-install preview beyond three PNGs, no CHANGELOG, docs/
// mixing internal proposals with user-facing docs, cockpit invisible on the
// quickstart path).

test("review-surfaces.DISTRIBUTION.5 docs/example/ holds the committed sample packet with a framing README and a main-README link", () => {
  for (const artifact of ["human_review.md", "human_review.html", "comment.md", "README.md"]) {
    assert.ok(fs.existsSync(path.join(root, "docs", "example", artifact)), `docs/example/${artifact} exists`);
  }
  const framing = read("docs/example/README.md");
  // The framing README states the exact generating commands: the pinned got
  // commit, the frozen clock, and all three render commands.
  assert.match(framing, /a5b76bffb33d5fa8b0d1393cce410b88e7c2b848/);
  assert.match(framing, /--now 2026-06-12T00:00:00Z/);
  assert.match(framing, /review-surfaces all --provider mock --base 'HEAD~3' --head HEAD/);
  assert.match(framing, /human --format html/);
  assert.match(framing, /comment --format sticky/);
  // The artifacts are the spec-less cold-start output, redaction verified: no
  // local usernames or machine paths leak into the committed files.
  for (const artifact of ["human_review.md", "human_review.html", "comment.md"]) {
    const content = read(path.join("docs", "example", artifact));
    assert.doesNotMatch(content, /\/Users\/|\/home\/|\/tmp\//, `${artifact} carries no local machine paths`);
    // Spec-less: no Acai-shaped REVIEW output. The cockpit's inline script
    // legitimately carries ACID-annotated code comments, so strip it first.
    const reviewOutput = content.replace(/<script>[\s\S]*?<\/script>/g, "");
    assert.doesNotMatch(reviewOutput, /review-surfaces\.[A-Z_]+\.\d/, `${artifact} is spec-less (no Acai-shaped output)`);
  }
  // The main README invites the stranger to read a packet before installing,
  // and the linked example ships INSIDE the npm tarball so the link resolves
  // for installed users too.
  assert.match(read("README.md"), /docs\/example\/README\.md/);
  const exampleManifest = JSON.parse(read("package.json")) as { files?: string[] };
  assert.ok(exampleManifest.files?.includes("docs/example"), "docs/example ships in the package");
});

test("review-surfaces.DISTRIBUTION.6 the README change-map screenshot shows the overview and the copy describes overview and zoom", () => {
  const readme = read("README.md");
  // The copy describes both levels and the summarize-never-shrink behavior.
  assert.match(readme, /overview/i);
  assert.match(readme, /zoom/i);
  assert.match(readme, /legibility budget/);
  assert.match(readme, /change-map\.png/);
  assert.match(readme, /cockpit\.png/);
  // The committed map screenshot is no longer the 4680x768 ribbon that
  // demonstrated the scaling bug: its aspect ratio is README-legible.
  const png = fs.readFileSync(path.join(root, "docs", "images", "change-map.png"));
  assert.equal(png.readUInt32BE(12), 0x49484452, "PNG IHDR present");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.ok(width <= 2200, `change-map.png width ${width} renders legibly in the README column`);
  assert.ok(width / height <= 3, `change-map.png aspect ${width}x${height} is not a ribbon`);
});

test("review-surfaces.DISTRIBUTION.7 the all terminal summary ends with the HTML cockpit pointer", () => {
  // The pointer is its own helper so every summary path can end on it. `all`
  // writes human_review.html DIRECTLY from the model it just built, so the
  // pointer carries no follow-up command whose flags (provider, scope,
  // budget, config, out) could rebuild a different cockpit — it only says
  // where to look.
  const cli = read("src/cli/index.ts");
  const pointer = cli.split("function printCockpitPointer")[1].split("\n}")[0];
  assert.match(pointer, /HTML cockpit: open/);
  assert.match(pointer, /human_review\.html/);
  assert.doesNotMatch(pointer, /npx|--out|--config/);
  // In the all command the ordering is: human-review summary leads
  // (HUMAN_REVIEW.15), then the artifacts line, then gate messages, then the
  // cockpit pointer LAST — the run genuinely ends on it even when a gate
  // warning or strict failure prints.
  const runAll = cli.split("async function runAll")[1].split("\nasync function ")[0];
  // `all` renders the cockpit itself on the main path; the cache-hit helper
  // does the same.
  assert.ok(runAll.includes("renderHumanReviewHtml("), "all writes human_review.html directly");
  assert.ok(cli.split("async function writeAndMaybeSummarizeHumanReviewFromArtifacts")[1].split("\nasync function ")[0].includes("renderHumanReviewHtml("), "the cache-hit path writes the cockpit too");
  const summaryCallIndex = runAll.indexOf("printHumanReviewTerminalSummary(");
  const artifactsLogIndex = runAll.indexOf("Wrote review-surfaces artifacts to");
  const lastGateIndex = runAll.lastIndexOf("applyGate(");
  const lastPointerIndex = runAll.lastIndexOf("printCockpitPointer(");
  assert.ok(summaryCallIndex >= 0 && artifactsLogIndex >= 0 && lastGateIndex >= 0 && lastPointerIndex >= 0);
  assert.ok(summaryCallIndex < artifactsLogIndex, "the human-review summary leads the artifact-status line");
  assert.ok(lastGateIndex < lastPointerIndex, "the cockpit pointer prints after gate messages");
  // Every applyGate in runAll is followed by a pointer print (cache-hit paths
  // end on the pointer too).
  const gateCount = [...runAll.matchAll(/applyGate\(/g)].length;
  const pointerCount = [...runAll.matchAll(/printCockpitPointer\(/g)].length;
  assert.ok(pointerCount >= gateCount, "each gated exit path ends on the cockpit pointer");
});

test("review-surfaces.DISTRIBUTION.8 CHANGELOG.md exists and the remaining internal proposals moved to docs/history/", () => {
  const changelog = read("CHANGELOG.md");
  assert.match(changelog, /## 0\.2\.0/);
  // The manifest version matches the changelog's intended first publish, so
  // the owner's manual `npm publish` ships the documented version.
  const versionManifest = JSON.parse(read("package.json")) as { version?: string };
  assert.ok(changelog.includes(`## ${versionManifest.version} `), "package.json version heads the changelog's unreleased section");
  assert.match(changelog, /## 0\.1\.0/);
  // The condensed history names all five uplifts.
  for (const marker of ["MVP", "Human review uplift", "Next-value uplift", "Visual value uplift", "Open-source readiness uplift"]) {
    assert.ok(changelog.includes(marker), `CHANGELOG covers "${marker}"`);
  }
  assert.match(changelog, /owner('|’)s\s+(single\s+)?manual\s+step/i);
  // The changelog ships in the npm tarball (npm does not auto-include it).
  const changelogManifest = JSON.parse(read("package.json")) as { files?: string[] };
  assert.ok(changelogManifest.files?.includes("CHANGELOG.md"), "CHANGELOG.md ships in the package");
  // docs/ no longer mixes internal proposals with user-facing docs.
  const docsEntries = fs.readdirSync(path.join(root, "docs"));
  assert.ok(!docsEntries.some((entry) => entry.includes("proposal")), "no proposal docs left at docs/ top level");
  for (const moved of [
    "human-first-review-surfaces-comprehensive-feature-proposal.md",
    "human-review-value-uplift-proposal.md",
    "POLISH_UPLIFT_GOAL.md"
  ]) {
    assert.ok(fs.existsSync(path.join(root, "docs", "history", moved)), `docs/history/${moved} exists`);
  }
  // The history README indexes the polish goal file; inbound references point
  // at the new locations.
  assert.match(read("docs/history/README.md"), /POLISH_UPLIFT_GOAL\.md/);
  assert.ok(read("review-surfaces.config.yaml").includes("docs/history/POLISH_UPLIFT_GOAL.md"));
  assert.ok(!read("review-surfaces.config.yaml").includes("docs/human-first-review-surfaces"), "config points at docs/history for the cockpit proposal");
  assert.ok(read("features/review-surfaces.feature.yaml").includes("docs/history/POLISH_UPLIFT_GOAL.md"));
});
