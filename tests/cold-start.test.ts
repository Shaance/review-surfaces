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
import { clusterOfPath, detectImplementationRoots } from "../src/core/source-roots";
import { buildChangeGraphSections } from "../src/human/change-graph";
import { baselineStem } from "../src/human/human-review";
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

// review-surfaces.COLLECTOR.8 / HUMAN_REVIEW.28 — cold-start impl<->test matching
// reduces the plural Swift test conventions to the implementation stem so a changed
// `Greeter.swift` is recognized as having a connected test change from
// `GreeterTests.swift` (singular Test/Spec already worked; plural was the gap).
test("review-surfaces.COLLECTOR.8 baselineStem reduces plural Swift test suffixes to the impl stem", () => {
  assert.equal(baselineStem("Sources/App/Greeter.swift"), "greeter");
  assert.equal(baselineStem("Tests/AppTests/GreeterTests.swift"), "greeter");
  assert.equal(baselineStem("UITests/LoginUITests.swift"), "login");
  assert.equal(baselineStem("SnapshotTests/ViewSnapshotTests.swift"), "view");
  assert.equal(baselineStem("Tests/WidgetTest.swift"), "widget");
  // lowercase words that merely END in "test"/"spec" keep their stem (case-sensitive guard).
  assert.equal(baselineStem("Sources/latest.swift"), "latest");
  assert.equal(baselineStem("Sources/contest.swift"), "contest");
});
