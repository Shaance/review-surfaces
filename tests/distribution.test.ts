// review-surfaces.DISTRIBUTION.1-4 — distribution and repository hygiene
// (open-source uplift Phase 3; docs/history/OPEN_SOURCE_UPLIFT_GOAL.md closes
// cold-start failure 5: publish-ready but unpublished, no LICENSE, README
// assumed Acai conventions and showed none of the shipped visuals).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { initGitRepo, runCli } from "./helpers/cli-repo";

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
  // DISTRIBUTION.11 made the README's screenshot links absolute (npm renders
  // them from GitHub), so the ~550 KB of PNGs no longer pad the tarball; the
  // 32 KB read-before-install example packet still ships.
  assert.ok(!manifest.files?.includes("docs/images"), "screenshots are linked absolutely, not shipped");
  assert.ok(manifest.files?.includes("docs/example"), "the example packet ships in the package");
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

  // Leads with the adaptive decision brief, before anything Acai-shaped.
  const firstScreen = readme.slice(0, 1500);
  assert.match(firstScreen, /What is the author trying to change/i);
  assert.match(firstScreen, /Which independent decisions could change approval/i);
  assert.match(firstScreen, /What evidence supports each decision/i);
  assert.match(firstScreen, /There is no universal word\s+or item cap/i);
  assert.doesNotMatch(firstScreen, /Did the agent overreach|Did it weaken tests|Did it claim things it didn't do/i);

  // An npx quickstart that works on a spec-less repo (no --spec flag in it).
  const quickstart = readme.slice(readme.indexOf("## Quickstart"), readme.indexOf("## What you get"));
  assert.match(quickstart, /npx review-surfaces all/);
  assert.ok(!quickstart.includes("--spec"), "the quickstart must not require a spec");

  // A real packet is available before install; stale screenshots are not used as
  // a substitute for the actual current artifacts.
  assert.match(readme, /https:\/\/github\.com\/Shaance\/review-surfaces\/blob\/main\/docs\/example\/README\.md/);

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
  assert.match(gate, /pnpm run test[^]*pnpm pack --config\.ignore-scripts=true --pack-destination/, "the gate packages the exact clean dist produced by the full test run without a redundant lifecycle build");
  assert.match(gate, /pnpm add .*tgz|pnpm add "\.\/\$\(basename/, "the gate installs the packed tarball");
  assert.match(gate, /pnpm add [^\n]*--prefer-offline/, "the tarball smoke reuses cached packages without pretending registry metadata is always cached");
  assert.match(
    gate,
    /review-surfaces" all --provider mock --no-conversation-discovery/,
    "the installed binary runs a hermetic pipeline outside the repo"
  );
  assert.match(gate, /validate \.rs --surface all/, "the installed binary validates from outside the repo");
  // npm publish is the owner's manual step — prepared, never run by the gate.
  assert.ok(!gate.includes("npm publish") && !gate.includes("pnpm publish"), "the gate never publishes");
  const manifest = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  // DISTRIBUTION.12 upgraded prepublishOnly from a bare build to the full gate.
  assert.equal(manifest.scripts?.prepublishOnly, "pnpm run local-gate", "publish remains prepared via prepublishOnly");
  // prepack guarantees the tarball carries dist/ even from a clean checkout
  // (pnpm pack / npm pack run prepack; prepublishOnly only runs on publish).
  assert.equal(manifest.scripts?.prepack, "pnpm run build", "pack always builds first");
  assert.doesNotMatch(gate, /rm -rf dist\npnpm run build\npnpm pack/, "the smoke does not replace the tested dist with an untested second build");

  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-pnpm-pack-"));
  try {
    const packed = spawnSync("pnpm", ["pack", "--config.ignore-scripts=true", "--pack-destination", packDir], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(packed.status, 0, `the lifecycle-suppressed pnpm pack command must execute:\n${packed.stderr}`);
    assert.equal(fs.readdirSync(packDir).some((name) => name.endsWith(".tgz")), true, "the supported pack command writes a tarball");
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
});

// review-surfaces.DISTRIBUTION.5-8 — pre-publish polish uplift Phase 3
// (docs/history/POLISH_UPLIFT_GOAL.md, 2026-06-12 legibility evidence-log
// failures 5-6: no pre-install preview beyond three PNGs, no CHANGELOG, docs/
// mixing internal proposals with user-facing docs, cockpit invisible on the
// quickstart path).

test("review-surfaces.DISTRIBUTION.5 docs/example/ holds the committed sample packet with a framing README and a main-README link", () => {
  for (const artifact of [
    "human_review.md", "human_review.html", "human_review.json", "comment.md", "README.md",
    "review_queue.md", "suggested_comments.md", "trust_audit.md", "risk_lenses.md",
    "intent_mismatch.md", "evidence_cards.md", "since_last_review.md", "test_plan.md"
  ]) {
    assert.ok(fs.existsSync(path.join(root, "docs", "example", artifact)), `docs/example/${artifact} exists`);
  }
  const framing = read("docs/example/README.md");
  // The framing README states the exact generating commands: the pinned got
  // commit, the frozen clock, and all three render commands.
  assert.match(framing, /a5b76bffb33d5fa8b0d1393cce410b88e7c2b848/);
  assert.match(framing, /--now 2026-06-12T00:00:00Z/);
  assert.match(framing, /review-surfaces all --provider mock --base 'HEAD~3' --head HEAD/);
  assert.match(framing, /review-surfaces human .*--format html/);
  assert.match(framing, /review-surfaces comment .*--format sticky/);
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
  const brief = read(path.join("docs", "example", "human_review.md"));
  for (const match of brief.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    assert.ok(fs.existsSync(path.join(root, "docs", "example", match[1]!)), `example brief link resolves: ${match[1]}`);
  }
  // The main README invites the stranger to read a packet before installing,
  // and the linked example ships INSIDE the npm tarball so the link resolves
  // for installed users too.
  assert.match(read("README.md"), /docs\/example\/README\.md/);
  const exampleManifest = JSON.parse(read("package.json")) as { files?: string[] };
  assert.ok(exampleManifest.files?.includes("docs/example"), "docs/example ships in the package");
});

test("review-surfaces.DISTRIBUTION.6 the README and screenshot tooling expose only current human surfaces", () => {
  const readme = read("README.md");
  const tour = readme.slice(readme.indexOf("## What you get"), readme.indexOf("## Scope:"));
  assert.doesNotMatch(tour, /change map/i);
  assert.match(readme, /machine-readable change graph/i);
  assert.match(readme, /human\s+surfaces do not .* redundant map/i);
  const screenshots = read("scripts/readme-screenshots.mjs");
  assert.match(screenshots, /\["cockpit", "sticky-comment"\]/);
  assert.doesNotMatch(screenshots, /change-map|inline SVG change map|map-detail/);
  assert.equal(fs.existsSync(path.join(root, "docs", "images", "change-map.png")), false);
  assert.equal(fs.existsSync(path.join(root, "docs", "images", "change-map-detail.png")), false);
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
  // In the all command the ordering is: the shared cockpit writer renders HTML
  // and prints the human-review summary, then the artifacts line, then gate
  // messages, then the cockpit pointer LAST — the run genuinely ends on it even
  // when a gate warning or strict failure prints.
  //
  // Keeping rendering and summarization in one shared helper prevents normal,
  // cache-hit, and optional-enrichment-refresh paths from drifting apart.
  const cockpitWriter = cli.split("async function writeHumanReviewCockpitAndMaybeSummarize")[1].split("\nfunction ")[0];
  assert.ok(cockpitWriter.includes("renderHumanReviewHtml("), "the shared writer renders human_review.html");
  assert.ok(cockpitWriter.includes("printHumanReviewTerminalSummary("), "the shared writer prints the terminal summary");
  // In the all command the ordering is: shared writer first
  // (HUMAN_REVIEW.15), then the artifacts line, then gate messages, then the
  // cockpit pointer LAST — the run genuinely ends on it even when a gate
  // warning or strict failure prints.
  const runAll = cli.split("async function runAll")[1].split("\nasync function ")[0];
  assert.ok(runAll.includes("writeHumanReviewCockpitAndMaybeSummarize("), "all uses the shared cockpit writer");
  assert.ok(
    cli.split("async function writeAndMaybeSummarizeHumanReviewFromArtifacts")[1].split("\nasync function ")[0]
      .includes("writeHumanReviewCockpitAndMaybeSummarize("),
    "the cache-hit path uses the shared cockpit writer too"
  );
  const cockpitCallIndex = runAll.indexOf("writeHumanReviewCockpitAndMaybeSummarize(");
  const artifactsLogIndex = runAll.indexOf("Wrote review-surfaces artifacts to");
  const lastGateIndex = runAll.lastIndexOf("applyGate(");
  const lastPointerIndex = runAll.lastIndexOf("printCockpitPointer(");
  assert.ok(cockpitCallIndex >= 0 && artifactsLogIndex >= 0 && lastGateIndex >= 0 && lastPointerIndex >= 0);
  assert.ok(cockpitCallIndex < artifactsLogIndex, "the human-review summary leads the artifact-status line");
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

// review-surfaces.DISTRIBUTION.9-13 — release quick-wins uplift Phase 2
// (docs/history/QUICK_WINS_UPLIFT_GOAL.md, 2026-06-12 quick-wins evidence-log
// items 4-8): the package's first touch — version flag, Node floor guard,
// npm-page rendering, publish safety, artifact-dir hygiene.

test("review-surfaces.DISTRIBUTION.9 --version and the version command print the help header line and exit 0", () => {
  const cli = path.join(root, "dist", "src", "cli", "index.js");
  const manifest = JSON.parse(read("package.json")) as { version?: string };
  for (const args of [["--version"], ["version"]]) {
    const result = spawnSync("node", [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `${args.join(" ")} must exit 0:\n${result.stderr}`);
    assert.equal(
      result.stdout.trim(),
      `review-surfaces ${manifest.version}`,
      `${args.join(" ")} must print exactly the help header line`
    );
  }
  // The same VERSION constant feeds the help header, so the existing
  // version-sync tests keep the flag, help, src/core/version.ts, and
  // package.json from ever disagreeing.
  const help = spawnSync("node", [cli, "--help"], { encoding: "utf8" });
  assert.ok(help.stdout.startsWith(`review-surfaces ${manifest.version}`), "help header carries the same version");
});

test("review-surfaces.DISTRIBUTION.10 the bin shim guards the Node floor with one actionable line", () => {
  const shim = read("bin/review-surfaces.js");
  const manifest = JSON.parse(read("package.json")) as { engines?: { node?: string } };
  const floorMatch = /([0-9]+)/.exec(manifest.engines?.node ?? "");
  assert.ok(floorMatch, "package.json declares a Node engines floor");
  const floor = floorMatch![1];
  // The guard checks the runtime version before spawning dist, names the SAME
  // floor as engines (a bump must touch both or this fails), and exits 1.
  assert.ok(shim.includes("process.versions.node"), "the shim reads the runtime Node version");
  assert.match(shim, new RegExp(`REQUIRED_NODE_MAJOR = ${floor}\\b`), "the shim's floor matches package.json engines");
  assert.match(shim, /requires Node(\.js)? >= /, "the guard message is actionable");
  // The shim must stay parseable by OLD Node to deliver that message: plain
  // CJS, no optional chaining or nullish coalescing at the top level of the
  // guard path before main() can bail out.
  const guardSection = shim.slice(0, shim.indexOf("async function main"));
  assert.ok(!guardSection.includes("?."), "no optional chaining before the guard");
});

test("review-surfaces.DISTRIBUTION.11 the README renders on the npm page: absolute links and sidebar metadata", () => {
  const readme = read("README.md");
  // No repo-relative links: npmjs.com (and registry mirrors) do not reliably
  // rewrite them, so images and doc links must be absolute.
  assert.doesNotMatch(readme, /\]\(docs\//, "no relative ](docs/... links");
  assert.doesNotMatch(readme, /\]\(\.\//, "no relative ](./... links");
  const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  for (const image of images) {
    assert.match(image, /^https:\/\//, `README image must use an absolute URL on npm: ${image}`);
  }
  const manifest = JSON.parse(read("package.json")) as { homepage?: string; bugs?: { url?: string } };
  assert.match(manifest.homepage ?? "", /^https:\/\/github\.com\/Shaance\/review-surfaces/, "homepage set for the npm sidebar");
  assert.match(manifest.bugs?.url ?? "", /\/issues$/, "bugs URL set for the npm sidebar");
});

test("review-surfaces.DISTRIBUTION.12 prepublishOnly runs the full local gate; publish itself stays manual", () => {
  const manifest = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  assert.equal(
    manifest.scripts?.prepublishOnly,
    "pnpm run local-gate",
    "the owner's single manual npm publish must be unable to ship a red gate"
  );
  // No script automates the publish itself.
  for (const [name, body] of Object.entries(manifest.scripts ?? {})) {
    assert.ok(!/npm publish|pnpm publish/.test(body), `script "${name}" must not automate npm publish`);
  }
  const changelog = read("CHANGELOG.md");
  assert.match(changelog, /prepublishOnly|publish runs the (full )?(local )?gate/i, "CHANGELOG notes that publish runs the gate");
});

test("review-surfaces.DISTRIBUTION.13 a first run hints once (stderr) to gitignore the artifact dir; ignored or tracked dirs stay silent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-ignore-hint-"));
  try {
    fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
    initGitRepo(tmp);
    // Case 1: not ignored, not tracked -> exactly one stderr hint; stdout clean.
    const first = runCli(tmp, ["all", "--provider", "mock"]);
    assert.equal(first.status, 0, first.stderr);
    const hints = first.stderr.split("\n").filter((line) => line.includes("add .review-surfaces/ to .gitignore"));
    assert.equal(hints.length, 1, `exactly one hint on stderr:\n${first.stderr}`);
    assert.ok(!first.stdout.includes(".gitignore"), "the hint stays off stdout (ordering contracts)");

    // Case 2: ignored -> silent.
    fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
    const ignored = runCli(tmp, ["all", "--provider", "mock"]);
    assert.equal(ignored.status, 0, ignored.stderr);
    assert.ok(!ignored.stderr.includes(".gitignore"), `no hint when the dir is ignored:\n${ignored.stderr}`);

    // Case 3: tracked (a repo that commits artifacts on purpose, like this
    // one) -> silent.
    fs.rmSync(path.join(tmp, ".gitignore"));
    fs.mkdirSync(path.join(tmp, ".review-surfaces"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "agent_handoff.md"), "kept\n");
    execFileSync("git", ["add", ".review-surfaces/agent_handoff.md", "."], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "track artifacts"], { cwd: tmp, stdio: "ignore" });
    const tracked = runCli(tmp, ["all", "--provider", "mock"]);
    assert.equal(tracked.status, 0, tracked.stderr);
    assert.ok(!tracked.stderr.includes(".gitignore"), `no hint when artifacts are tracked:\n${tracked.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// review-surfaces.DISTRIBUTION.14-15 — ci-trust uplift Phase 7
// (docs/history/CI_TRUST_UPLIFT_GOAL.md): the tarball shipped 1.6 MB / 87
// compiled test files the runtime never loads, and the README sells the action
// and --strict for CI without a usage snippet or an exit-code table.

test("review-surfaces.DISTRIBUTION.14 the pack allowlist ships runtime files only, never compiled tests", () => {
  // The load-bearing check runs the REAL pack manifest — npm's packlist applies
  // rules beyond package.json `files`, so inspecting `files` alone can miss what
  // actually ships. `--ignore-scripts` is required: it skips the `prepack` build
  // so this test does NOT rebuild/clobber `dist` while sibling tests read it (the
  // repo hit exactly that race before). `npm pack --json` returns an array whose
  // first entry has a `files[].path` list of every tarball member.
  const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-npm-cache-"));
  let raw = "";
  try {
    raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCache }
    });
  } finally {
    fs.rmSync(npmCache, { recursive: true, force: true });
  }
  let packed: Array<{ files?: Array<{ path?: string }> }>;
  try {
    packed = JSON.parse(raw) as Array<{ files?: Array<{ path?: string }> }>;
  } catch (error) {
    assert.fail(`npm pack did not emit parseable JSON: ${(error as Error).message}\n${raw.slice(0, 400)}`);
  }
  const packedPaths = (packed[0]?.files ?? [])
    .map((entry) => entry.path ?? "")
    .filter((p) => p.length > 0);
  assert.ok(packedPaths.length > 0, "the pack manifest lists tarball members");
  assert.ok(
    !packedPaths.some((p) => p.startsWith("dist/tests")),
    `the tarball must not ship compiled tests; found ${JSON.stringify(packedPaths.filter((p) => p.startsWith("dist/tests")))}`
  );
  assert.ok(
    packedPaths.some((p) => p.startsWith("dist/src/")),
    "the tarball ships the compiled runtime under dist/src"
  );
  assert.ok(
    packedPaths.includes("dist/bin/privacy-runtime.js"),
    "the tarball ships the shared privacy runtime used by compiled code"
  );
  assert.ok(
    packedPaths.includes("dist/bin/bounded-stream-capture.js"),
    "the tarball ships the shared bounded stream capture used by compiled code"
  );

  // Belt and suspenders: the structural allowlist matches the manifest — no bare
  // `dist` entry (which would carry dist/tests), and dist is scoped to runtime files.
  const manifest = JSON.parse(read("package.json")) as { files?: string[]; bin?: Record<string, string> };
  const files = manifest.files ?? [];
  assert.ok(!files.includes("dist"), "the bare `dist` entry (which would carry dist/tests) is gone");
  assert.ok(files.includes("dist/src"), "the package ships the compiled runtime under dist/src");
  assert.ok(
    files.includes("dist/bin/privacy-runtime.js"),
    "the package ships the compiled shared privacy runtime"
  );
  assert.ok(
    files.includes("dist/bin/bounded-stream-capture.js"),
    "the package ships the compiled shared bounded stream capture"
  );
  assert.ok(
    files.every((entry) =>
      !entry.startsWith("dist") ||
      entry.startsWith("dist/src") ||
      entry === "dist/bin/privacy-runtime.js" ||
      entry === "dist/bin/bounded-stream-capture.js"
    ),
    `no files entry may include dist/tests; got ${JSON.stringify(files)}`
  );
  // The bin's runtime path is covered by a files glob, so an install can run it.
  const binPath = manifest.bin?.["review-surfaces"] ?? "";
  assert.match(binPath, /bin\/review-surfaces\.js$/, "bin points at the shim under bin/");
  const shim = read("bin/review-surfaces.js");
  assert.match(shim, /dist\/src\/cli\/index\.js/, "the shim spawns the compiled entry under dist/src");
  assert.ok(
    files.some((entry) => entry === "bin" || entry === "bin/review-surfaces.js"),
    "the bin shim ships in the package"
  );
  assert.ok(
    files.some((entry) => entry === "dist/src" || entry === "dist/src/cli/index.js"),
    "the bin's runtime entry (dist/src/cli/index.js) is covered by a files glob"
  );
});

test("review-surfaces.DISTRIBUTION.15 the README documents CI consumption: an action snippet and an exit-code table", () => {
  const readme = read("README.md");
  // (a) A copy-pasteable GitHub Action `uses:` snippet pinning this repo's
  // action, with the required pr-number input, plus a link to the worked
  // example workflow.
  assert.match(readme, /uses:\s*Shaance\/review-surfaces@/, "a `uses:` snippet pins the reusable action");
  assert.match(readme, /pr-number:/, "the snippet wires the required pr-number input");
  assert.match(
    readme,
    /github\.com\/Shaance\/review-surfaces\/blob\/main\/\.github\/workflows\/pr-review-comment\.yml/,
    "links the worked example workflow (absolute GitHub blob URL)"
  );
  // (a.0) pr-review-comment.yml is THIS repo's own dogfood workflow: it runs the
  // in-repo composite action via `uses: ./tool`, so an external consumer copying
  // it verbatim would run their own checkout, not the published action. The
  // README must frame that file as a wiring REFERENCE (not a copy-as-is) and
  // tell consumers to use the published `Shaance/review-surfaces@<sha>` ref —
  // e.g. by noting the `./tool` swap. Match on stable substrings.
  assert.match(readme, /\.\/tool/, "the README names the in-repo `./tool` ref the consumer must swap out");
  assert.match(
    readme,
    /swap\s+`?uses:\s*\.\/tool`?\s+for\s+`?uses:\s*Shaance\/review-surfaces@/i,
    "the README tells consumers to swap `./tool` for the published `Shaance/review-surfaces@<sha>` ref"
  );
  assert.doesNotMatch(
    readme,
    /\*\*Copy\s*\n?\[`?\.github\/workflows\/pr-review-comment\.yml/,
    "the README does not instruct copying pr-review-comment.yml verbatim (it uses ./tool)"
  );
  // (a.1) Supply-chain hardening: the secret-bearing action must be pinned to a
  // FULL 40-char commit SHA — the only immutable ref. A release tag (`@v<semver>`)
  // can be moved or deleted and `@main` is mutable; a later push to either could
  // redirect the write token / LLM key. Assert the `uses: Shaance/...@` ref is a
  // 40-hex SHA, and that it points at neither a `@v` tag nor the `@main` branch.
  assert.match(
    readme,
    /uses:\s*Shaance\/review-surfaces@[0-9a-f]{40}\b/,
    "the secret-bearing action is pinned to a full 40-char commit SHA (the only immutable ref)"
  );
  assert.doesNotMatch(
    readme,
    /uses:\s*Shaance\/review-surfaces@v\d/,
    "the action is not pinned to a movable @v<semver> tag"
  );
  assert.doesNotMatch(
    readme,
    /uses:\s*Shaance\/review-surfaces@main\b/,
    "the action is not pinned to the mutable @main branch"
  );
  // (a.1.1) The composite action defaults `spec` to THIS repo's own spec, so a
  // consumer copying the snippet must point it at their own spec. The snippet
  // must therefore show the feature-spec glob (or a spec note) so a consumer's
  // `features/<x>.feature.yaml` is actually indexed.
  assert.match(
    readme,
    /spec:\s*features\/\*\*\/\*\.feature\.yaml/,
    "the snippet shows the `features/**` spec glob so the consumer's own spec is indexed"
  );
  // (a.2) The README must keep the `actions: read` permission documented (the
  // worked workflow grants it): the prior-sticky artifact lookup that drives the
  // since-last-review delta needs it, or the API call is denied and the delta
  // silently vanishes.
  assert.match(readme, /actions:\s*read/, "the README documents the `actions: read` permission for the prior-sticky lookup");
  // (a.3) `--fail-on` now ships (Phase 3): the README must document the risk-
  // severity gate so a CI author knows code 10 can fire on a high/critical risk,
  // not only on missing requirements. Assert the flag and the risk gate are
  // documented in the exit-code section.
  assert.match(readme, /--fail-on/, "the README documents the --fail-on risk-severity gate");
  // (b) An exit-code table sourced from src/core/exit-codes.ts mapping each
  // code to its meaning. The table must carry the non-trivial codes with copy
  // a CI author can branch on, and the meanings must match the source: code 4 is
  // the evidence-validation failure, code 10 is the quality-gate (missing
  // requirements) failure — these must not be conflated.
  const exitTable = readme.slice(readme.indexOf("### Exit codes"));
  assert.ok(exitTable.length > 0, "the README has an Exit codes section");
  for (const [code, keyword] of [
    ["3", /[Ss]chema/],
    ["4", /[Ee]vidence/],
    ["5", /[Pp]rivacy/],
    ["10", /[Gg]ate/]
  ] as const) {
    assert.match(exitTable, new RegExp(`\\|\\s*\`?${code}\`?\\s*\\|`), `the table lists exit code ${code}`);
    assert.match(exitTable, keyword, `exit code ${code}'s meaning is documented`);
  }
  assert.match(exitTable, /\|\s*`?2`?\s*\|/, "the table lists the usage-error code 2");
  assert.match(exitTable, /\|\s*`?0`?\s*\|/, "the table lists the success code 0");
  // (b.1) Code 4's row is evidence validation; code 10's row is the quality gate.
  // Phase 3 ships `--fail-on`, so code 10 now documents BOTH arms: the
  // missing-requirement budget AND the risk-severity (`--fail-on`) threshold. The
  // row must still NOT conflate itself with evidence validation (a separate code).
  const rowFor = (code: string) =>
    (exitTable.match(new RegExp(`\\|\\s*\`?${code}\`?\\s*\\|([^\\n]*)\\|`)) ?? [, ""])[1] ?? "";
  assert.match(rowFor("4"), /[Ee]vidence/, "code 4's row is the evidence-validation failure");
  assert.match(rowFor("10"), /[Gg]ate/, "code 10's row is the quality-gate failure");
  assert.match(rowFor("10"), /missing/i, "code 10's row documents the missing-requirements arm");
  assert.match(rowFor("10"), /--fail-on|risk/i, "code 10's row also documents the --fail-on risk-severity threshold");
  assert.doesNotMatch(rowFor("10"), /[Ee]vidence/, "code 10's row does not conflate itself with evidence validation");
  // The risk gate must be documented in the exit-code section's prose too, so a CI
  // author sees BOTH arms of the quality gate (the missing budget and --fail-on).
  assert.match(exitTable, /--fail-on/, "the exit-code section documents the --fail-on risk-severity gate");
  // The table mirrors src/core/exit-codes.ts — every named non-runtime code is
  // documented, so the doc cannot silently drift from the source.
  const exitSource = read("src/core/exit-codes.ts");
  for (const code of [0, 2, 3, 4, 5, 10]) {
    assert.match(exitSource, new RegExp(`:\\s*${code}\\b`), `exit-codes.ts defines code ${code}`);
  }
});
