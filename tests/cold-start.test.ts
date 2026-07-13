// review-surfaces.COLD_START.1-3 — cold-start correctness on a stranger's
// repository. Every test reproduces a failure from the 2026-06-11 cold-start
// evidence log (docs/history/OPEN_SOURCE_UPLIFT_GOAL.md): a shallow clone of
// sindresorhus/got with no Acai specs and no config.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { computeSemanticChangeFacts, SemanticDiffSources } from "../src/risks/semantic-diff";
import { clusterOfPath, detectContractSourceProjection, detectContractSourceRoots, detectImplementationRoots } from "../src/core/source-roots";
import { classifyApiContractSurface } from "../src/risks/contract-surface";
import { buildChangeGraphSections } from "../src/human/change-graph";
import { createEvalFixture } from "./helpers/eval-fixture";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");

// ---------------------------------------------------------------------------
// review-surfaces.COLD_START.1 — `validate` resolves bundled schemas from the
// package root, never the user's CWD (the cold-start ENOENT:
// .../got/schemas/review_packet.schema.json).
// ---------------------------------------------------------------------------

test("review-surfaces.COLD_START.1 validate --surface all succeeds from a CWD outside the repo", () => {
  const fixture = createEvalFixture("cold-start-validate");
  const strangerCwd = fs.mkdtempSync(path.join(os.tmpdir(), "rs-stranger-cwd-"));
  try {
    fixture.write("src/calc.ts", "export function add(left: number, right: number): number {\n  return left + right + 0;\n}\n");
    fixture.commit("touch calc");
    fixture.run();
    const artifacts = path.join(fixture.dir, ".rs");
    // The regression: a temp CWD with NO schemas/ directory anywhere above it.
    const result = spawnSync("node", [CLI, "validate", artifacts, "--surface", "all"], {
      cwd: strangerCwd,
      encoding: "utf8"
    });
    assert.equal(
      result.status,
      0,
      `validate must pass from a foreign CWD; stdout=${result.stdout} stderr=${result.stderr}`
    );
    assert.match(result.stdout, /Validated/, "validate reports what it validated");
  } finally {
    fixture.cleanup();
    fs.rmSync(strangerCwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// review-surfaces.COLD_START.2 — implementation roots derive from the target
// repo's own signals; got's source/ must classify as implementation.
// ---------------------------------------------------------------------------

test("review-surfaces.COLD_START.2 detects implementation roots from tsconfig, package.json, and majority fallback", () => {
  // got-reduced: tsconfig includes source/, package.json points at dist build
  // output, and source/ holds the .ts files.
  const files = [
    "package.json",
    "tsconfig.json",
    "source/core/index.ts",
    "source/core/options.ts",
    "source/index.ts",
    "test/http.ts",
    "documentation/quick-start.md"
  ];
  const contents: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { outDir: "dist" }, include: ["source"] }),
    "package.json": JSON.stringify({ main: "dist/source/index.js", files: ["dist/source"] })
  };
  const roots = detectImplementationRoots({ files, read: (filePath) => contents[filePath] });
  assert.ok(roots.includes("source"), `source/ must be an implementation root; got ${JSON.stringify(roots)}`);
  assert.ok(!roots.includes("dist"), "build output must never become an implementation root");
  assert.ok(!roots.includes("test"), "test trees must never become an implementation root");
  assert.ok(!roots.includes("documentation"), "docs dirs must not qualify via the majority fallback");
  assert.deepEqual(
    detectContractSourceRoots({ files, read: (filePath) => contents[filePath] }),
    ["source"],
    "explicit tsconfig source roots avoid ambiguous package-target fan-out"
  );

  // Majority fallback alone (no tsconfig/package signals): a packages-style
  // top-level dir of mostly .ts files qualifies; a docs dir does not.
  const fallbackRoots = detectImplementationRoots({
    files: ["core/a.ts", "core/b.ts", "core/README.md", "docs/x.md"],
    read: () => undefined
  });
  assert.ok(fallbackRoots.includes("core"), "majority non-test source dir qualifies via fallback");
  assert.ok(!fallbackRoots.includes("docs"));

  // The shared cluster rule subclusters under a detected root.
  assert.equal(clusterOfPath("source/core/index.ts", ["source"]), "source/core");
  assert.equal(clusterOfPath("README.md", ["source"]), "(root)");
});

test("review-surfaces.REVIEWER_VALUE.11 preserves a root-level contract source sentinel", () => {
  const files = ["package.json", "tsconfig.json", "index.ts", "README.md"];
  for (const rootDir of [".", "./"]) {
    const contents: Record<string, string> = {
      "tsconfig.json": JSON.stringify({ compilerOptions: { rootDir } }),
      "package.json": JSON.stringify({ main: "dist/index.js" })
    };
    assert.deepEqual(
      detectContractSourceRoots({ files, read: (filePath) => contents[filePath] }),
      ["."],
      `rootDir ${JSON.stringify(rootDir)} keeps the root-level contract source`
    );
    assert.ok(
      !detectImplementationRoots({ files, read: (filePath) => contents[filePath] }).includes("."),
      "the contract-only root sentinel never becomes a change-map implementation root"
    );
  }
});

test("review-surfaces.REVIEWER_VALUE.11 infers a root-level source behind compiled package output", () => {
  for (const outputRoot of ["dist", "lib"] as const) {
    const files = ["package.json", "index.ts", `${outputRoot}/index.js`, "src/browser.ts", "src/cli.ts", "src/index.ts", "src/types.ts", "README.md"];
    const contents: Record<string, string> = {
      "package.json": JSON.stringify({
        main: `${outputRoot}/index.js`,
        module: `${outputRoot}/browser.js`,
        types: `${outputRoot}/types.d.ts`,
        bin: { cli: `${outputRoot}/cli.js` }
      })
    };
    const projection = detectContractSourceProjection({ files, read: (filePath) => contents[filePath] });
    const options = { packageJson: contents["package.json"], sourceRoots: projection.roots, packageSourcePatterns: projection.sourcePatternsByContract };
    assert.deepEqual(projection.roots, [".", "src"], `mixed ${outputRoot} entries retain every evidence-backed source root`);
    assert.equal(classifyApiContractSurface("index.ts", options)?.kind, "package_entry");
    assert.equal(classifyApiContractSurface("src/browser.ts", options)?.kind, "package_entry");
    assert.equal(classifyApiContractSurface("src/cli.ts", options)?.kind, "package_entry");
    assert.equal(classifyApiContractSurface("src/types.ts", options)?.kind, "package_entry");
    assert.equal(classifyApiContractSurface("src/index.ts", options), undefined, "the root main entry does not fan out to a nested namesake");
  }

  const conditionalFiles = ["package.json", "index.mts", "src/browser.cts"];
  const conditionalPackage = JSON.stringify({
    exports: { ".": { import: "./dist/index.mjs", require: "./dist/browser.cjs" } }
  });
  const conditionalProjection = detectContractSourceProjection({
    files: conditionalFiles,
    read: (filePath) => filePath === "package.json" ? conditionalPackage : undefined
  });
  const conditionalOptions = { packageJson: conditionalPackage, sourceRoots: conditionalProjection.roots, packageSourcePatterns: conditionalProjection.sourcePatternsByContract };
  assert.deepEqual(conditionalProjection.roots, [".", "src"]);
  assert.equal(classifyApiContractSurface("index.mts", conditionalOptions)?.kind, "package_export");
  assert.equal(classifyApiContractSurface("src/browser.cts", conditionalOptions)?.kind, "package_export");

  const wildcardPackage = JSON.stringify({ exports: { ".": "./dist/index.js", "./*": "./dist/*.js" } });
  const wildcardProjection = detectContractSourceProjection({
    files: ["package.json", "index.ts", "src/feature.ts"],
    read: (filePath) => filePath === "package.json" ? wildcardPackage : undefined
  });
  const wildcardOptions = { packageJson: wildcardPackage, sourceRoots: wildcardProjection.roots, packageSourcePatterns: wildcardProjection.sourcePatternsByContract };
  assert.deepEqual(wildcardProjection.roots, [".", "src"]);
  assert.equal(classifyApiContractSurface("index.ts", wildcardOptions)?.identity, "export:.");
  assert.equal(classifyApiContractSurface("src/feature.ts", wildcardOptions)?.binding, "export:./feature");

  const sharedTargetPackage = JSON.stringify({ exports: { ".": "./dist/index.js", "./alias": "./dist/index.js" } });
  const sharedTargetProjection = detectContractSourceProjection({
    files: ["package.json", "index.ts", "src/index.ts"],
    read: (filePath) => filePath === "package.json" ? sharedTargetPackage : undefined
  });
  const sharedTargetOptions = {
    packageJson: sharedTargetPackage,
    sourceRoots: sharedTargetProjection.roots,
    packageSourcePatterns: sharedTargetProjection.sourcePatternsByContract
  };
  assert.equal(classifyApiContractSurface("index.ts", sharedTargetOptions)?.identity, "export:.");
  assert.equal(classifyApiContractSurface("src/index.ts", sharedTargetOptions)?.identity, "export:./alias");

  const directLibPackage = JSON.stringify({ main: "lib/index.js" });
  const directLibProjection = detectContractSourceProjection({
    files: ["package.json", "lib/index.js", "lib/index.ts", "src/index.ts"],
    read: (filePath) => filePath === "package.json" ? directLibPackage : undefined
  });
  const directLibOptions = {
    packageJson: directLibPackage,
    sourceRoots: directLibProjection.roots,
    packageSourcePatterns: directLibProjection.sourcePatternsByContract
  };
  assert.deepEqual(directLibProjection.roots, ["lib"]);
  assert.equal(classifyApiContractSurface("lib/index.ts", directLibOptions)?.kind, "package_entry");
  assert.equal(classifyApiContractSurface("src/index.ts", directLibOptions), undefined);
  assert.equal(classifyApiContractSurface("lib/index.js", directLibOptions), undefined);
});

test("review-surfaces.REVIEWER_VALUE.11 prefers explicit tsconfig include roots over committed package output", () => {
  const files = ["package.json", "tsconfig.json", "lib/index.js", "src/index.ts", "tests/index.test.ts"];
  const contents: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ include: ["src", "tests"] }),
    "package.json": JSON.stringify({ main: "lib/index.js" })
  };
  assert.deepEqual(
    detectContractSourceRoots({ files, read: (filePath) => contents[filePath] }),
    ["src"],
    "an explicit source include projects package output without admitting generated or test roots"
  );
});

test("review-surfaces.REVIEWER_VALUE.11 retains package projection across broad tsconfig includes", () => {
  const contents: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ include: ["src/**", "scripts/**"] }),
    "package.json": JSON.stringify({ main: "dist/index.js" })
  };
  const projection = detectContractSourceProjection({
    files: ["package.json", "tsconfig.json", "dist/index.js", "src/index.ts", "scripts/build.ts"],
    read: (filePath) => contents[filePath]
  });
  const options = {
    packageJson: contents["package.json"],
    sourceRoots: projection.roots,
    packageSourcePatterns: projection.sourcePatternsByContract
  };
  assert.deepEqual(projection.roots, ["scripts", "src"]);
  assert.equal(classifyApiContractSurface("src/index.ts", options)?.kind, "package_entry");
  assert.equal(classifyApiContractSurface("scripts/build.ts", options), undefined);

  const excludedContents: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ include: ["src/**"] }),
    "package.json": JSON.stringify({ main: "dist/tools/index.js" })
  };
  const excludedProjection = detectContractSourceProjection({
    files: ["package.json", "tsconfig.json", "dist/tools/index.js", "src/other.ts", "tools/index.ts"],
    read: (filePath) => excludedContents[filePath]
  });
  assert.equal(classifyApiContractSurface("tools/index.ts", {
    packageJson: excludedContents["package.json"],
    sourceRoots: excludedProjection.roots,
    packageSourcePatterns: excludedProjection.sourcePatternsByContract
  }), undefined, "package projection cannot escape explicit tsconfig roots");
});

test("review-surfaces.COLD_START.2 reading order classifies a detected root as implementation, in agreement with the clusters", () => {
  const sections = buildChangeGraphSections({
    files: [
      { path: "source/core/index.ts", status: "M", added: 10, removed: 2 },
      { path: "README.md", status: "M", added: 1, removed: 0 }
    ],
    edges: [],
    usedBy: [],
    lensFindings: [],
    reviewQueue: [],
    implementationRoots: ["source"]
  });
  const implementationLeg = sections.reading_order.legs.find((leg) => leg.steps.some((step) => step.path === "source/core/index.ts"));
  assert.ok(implementationLeg, "source file appears in the tour");
  assert.equal(implementationLeg?.title, "Implementation", "source/ classifies as implementation, not config/docs");
  const node = sections.change_graph.nodes.find((candidate) => candidate.path === "source/core/index.ts");
  assert.equal(node?.cluster, "source/core", "the change-map cluster uses the same detected root");
});

test("review-surfaces.COLD_START.2 end-to-end: a source/-rooted repo gets implementation reading order from committed signals", () => {
  const fixture = createEvalFixture("cold-start-roots");
  try {
    fixture.write("tsconfig.json", JSON.stringify({ include: ["source"] }));
    fixture.write("source/core/engine.ts", "export function run(): number {\n  return 1;\n}\n");
    fixture.commit("add source tree");
    const human = fixture.run();
    const leg = human.reading_order.legs.find((candidate) => candidate.steps.some((step) => step.path === "source/core/engine.ts"));
    assert.ok(leg, "the new source file is in the tour");
    assert.equal(leg?.title, "Implementation", "detected source/ root classifies as implementation end-to-end");
  } finally {
    fixture.cleanup();
  }
});

test("review-surfaces.REVIEWER_VALUE.11 untracked source roots participate in worktree contract classification", () => {
  const fixture = createEvalFixture("untracked-contract-root");
  try {
    fixture.write("package.json", JSON.stringify({ main: "dist/index.js" }));
    fixture.write("tsconfig.json", JSON.stringify({ compilerOptions: { rootDir: "source" } }));
    fixture.write("source/index.ts", "export const value: number = 1;\n");
    const model = fixture.run();
    const change = model.semantic_facts.api_changes.find((entry) => entry.path === "source/index.ts");
    assert.equal(change?.contract_surface?.kind, "package_entry");
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// review-surfaces.COLD_START.3 — the exported-API differ ignores trivia. The
// got case, reduced: two TSDoc lines added inside an exported type were
// reported as a signature change and became the #1 review item.
// ---------------------------------------------------------------------------

function sources(diffText: string, base: Record<string, string>, head: Record<string, string>): SemanticDiffSources {
  return {
    diff: parseStructuredDiff(diffText),
    readBase: (filePath) => base[filePath],
    readHead: (filePath) => head[filePath]
  };
}

function tsDiff(filePath: string): string {
  return [`diff --git a/${filePath} b/${filePath}`, `--- a/${filePath}`, `+++ b/${filePath}`, "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n");
}

test("review-surfaces.COLD_START.3 a doc-comment-only edit inside an exported type is NOT a signature change", () => {
  const filePath = "source/core/options.ts";
  const before = `export interface PaginationOptions {
  transform?: (response: unknown) => unknown[];
  countLimit?: number;
}
`;
  const after = `export interface PaginationOptions {
  /**
  All errors will be collected.
  */
  transform?: (response: unknown) => unknown[];
  // trailing-style note
  countLimit?: number;
}
`;
  const facts = computeSemanticChangeFacts(sources(tsDiff(filePath), { [filePath]: before }, { [filePath]: after }));
  assert.equal(facts.api_changes.length, 0, `comment-only edit must produce no API fact; got ${JSON.stringify(facts.api_changes)}`);
});

test("review-surfaces.COLD_START.3 a real member change is still a signature change after comment stripping", () => {
  const filePath = "src/options.ts";
  const before = "export interface Options {\n  retries: number;\n}\n";
  const after = "export interface Options {\n  /** now a string */\n  retries: string;\n}\n";
  const facts = computeSemanticChangeFacts(sources(tsDiff(filePath), { [filePath]: before }, { [filePath]: after }));
  assert.equal(facts.api_changes.length, 1, "a real type change must still be detected");
  assert.equal(facts.api_changes[0].signatures_changed[0]?.name, "Options");
  // The rendered from/to strings are comment-stripped so the human-facing fact
  // never quotes trivia as the change.
  assert.ok(!facts.api_changes[0].signatures_changed[0]?.to.includes("now a string"));
});

test("review-surfaces.COLD_START.3 seeded eval fixture: doc-comment-only edit ranks no API finding", () => {
  const fixture = createEvalFixture("cold-start-trivia");
  try {
    fixture.write(
      "src/options.ts",
      `export interface Options {
  /**
  How many times to retry on failure.
  */
  retries: number;
  timeout?: number;
}
`
    );
    fixture.commit("document the retries option");
    const human = fixture.run();
    const apiItems = human.review_queue.filter(
      (item) => item.path === "src/options.ts" && /signature|exported api/i.test(`${item.title} ${item.reason}`)
    );
    assert.deepEqual(apiItems, [], "no exported-API queue item may cite the doc-comment-only file");
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// review-surfaces.COLD_START.4/.5 — spec-less mode: when zero Acai spec
// requirements are indexed the packet stops speaking Acai (the got cold-start:
// OVERREACH-001..003 covered 100% of the diff and review actions said "map the
// changed file to an Acai requirement").
// ---------------------------------------------------------------------------

test("review-surfaces.COLD_START.4 spec_mode derives deterministically from zero indexed spec requirements", () => {
  const specless = createEvalFixture("cold-start-specless-flag", { spec: false });
  try {
    specless.write("src/calc.ts", "export function add(left: number, right: number): number {\n  return right + left;\n}\n");
    specless.commit("reorder");
    const human = specless.run();
    assert.equal(human.spec_mode, "none", "zero indexed spec requirements => spec_mode none");
    const packet = JSON.parse(fs.readFileSync(path.join(specless.dir, ".rs", "review_packet.json"), "utf8")) as {
      intent: { spec_mode?: string };
    };
    assert.equal(packet.intent.spec_mode, "none", "the flag is schema-visible on the packet intent");
  } finally {
    specless.cleanup();
  }

  const withSpec = createEvalFixture("cold-start-acai-flag");
  try {
    withSpec.write("src/calc.ts", "export function add(left: number, right: number): number {\n  return right + left;\n}\n");
    withSpec.commit("reorder");
    assert.equal(withSpec.run().spec_mode, "acai", "indexed spec requirements => spec_mode acai");
  } finally {
    withSpec.cleanup();
  }
});

test("review-surfaces.COLD_START.5 spec-less mode suppresses Acai-shaped noise but keeps the deterministic value", () => {
  const fixture = createEvalFixture("cold-start-specless", { spec: false });
  try {
    // Several changed clusters — exactly the shape that drowned got in
    // per-cluster overreach findings.
    fixture.write("src/calc.ts", "export function add(left: number, right: number): number {\n  return right + left;\n}\n");
    fixture.write("src/util.ts", "export function double(value: number): number {\n  return value + value;\n}\n");
    fixture.write("docs/notes.md", "# notes\n");
    fixture.commit("spec-less change");
    const human = fixture.run();
    const packet = JSON.parse(fs.readFileSync(path.join(fixture.dir, ".rs", "review_packet.json"), "utf8")) as {
      evaluation: { overreach: unknown[]; summary: string };
    };

    // Suppressed: overreach findings, spec-coupled mismatch items, spec-shaped
    // queue actions and questions.
    assert.deepEqual(packet.evaluation.overreach, [], "no per-cluster overreach findings in spec-less mode");
    assert.ok(
      !/satisfied|overreach item/.test(packet.evaluation.summary),
      "the evaluation summary never renders zero-count requirement statuses in spec-less mode"
    );
    assert.deepEqual(human.intent_mismatch.possible_overreach, []);
    assert.deepEqual(human.intent_mismatch.missing_intent, []);
    assert.equal(
      human.intent_mismatch.spec_note,
      "No requirement spec configured — intent checks are limited to docs and constraints."
    );
    const allText = JSON.stringify([human.review_queue, human.questions, human.suggested_comments]);
    assert.ok(!/map the changed file to an Acai requirement/i.test(allText), "no Acai-mapping actions");
    assert.ok(!/resolve this intent gap/i.test(allText), "no per-file intent-gap questions");
    assert.ok(!/requirement result\(s\)/.test(human.summary), "the summary never advertises 0 requirement result(s)");

    // The single honest open question survives (src/intent/intent.ts).
    const packetIntent = JSON.parse(fs.readFileSync(path.join(fixture.dir, ".rs", "review_packet.json"), "utf8")) as {
      intent: { open_questions: string[] };
    };
    assert.ok(
      packetIntent.intent.open_questions.some((question) => question.includes("No Acai requirements were indexed")),
      "the honest single question remains the only spec-shaped output"
    );

    // NOT changed in none mode: the no-spec value proposition.
    assert.ok(human.reading_order.legs.length > 0, "reading order still renders");
    assert.ok(human.change_graph.nodes.length > 0, "change map still renders");
    assert.ok(human.trust_audit, "trust audit still renders");
    assert.ok(Array.isArray(human.semantic_facts.api_changes), "semantic facts still computed");
  } finally {
    fixture.cleanup();
  }
});
