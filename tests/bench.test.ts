import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// review-surfaces.BENCH.1: the effectiveness benchmark is an on-demand harness (not in CI —
// it needs network to clone), so this test guards its CONTRACT rather than running it: a
// runnable harness ships, the manifest pins real cross-language cases by full SHA, and the
// hermetic `--no-conversation-discovery` flag (which keeps a run from folding the runner's
// own Claude/Codex sessions into the scorecard) is not silently dropped.
test("review-surfaces.BENCH.1 the effectiveness benchmark ships a runnable harness and a well-formed pinned manifest", () => {
  const root = process.cwd();
  const runner = path.join(root, "bench", "run.mjs");
  assert.ok(fs.existsSync(runner), "bench/run.mjs harness exists");

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "bench", "manifest.json"), "utf8"));
  assert.ok(Array.isArray(manifest.cases) && manifest.cases.length >= 5, "manifest pins a cross-language case set");

  const langs = new Set<string>();
  for (const c of manifest.cases) {
    assert.ok(c.id && c.lang && c.repo, `case ${c.id ?? "?"} has id/lang/repo`);
    assert.match(c.base, /^[0-9a-f]{40}$/, `case ${c.id} base is a full commit SHA (deterministic pin)`);
    assert.match(c.head, /^[0-9a-f]{40}$/, `case ${c.id} head is a full commit SHA (deterministic pin)`);
    assert.match(c.repo, /^https:\/\/.+\.git$/, `case ${c.id} repo is a clonable URL`);
    langs.add(c.lang);
  }
  assert.ok(langs.size >= 4, "the seed set spans multiple languages");

  const runnerSrc = fs.readFileSync(runner, "utf8");
  assert.match(runnerSrc, /--no-conversation-discovery/, "benchmark runs stay hermetic (no auto-discovery of the runner's own sessions)");
  assert.match(runnerSrc, /--config/, "benchmark forces a neutral config so a target repo's own config can't change the result");
  assert.ok(fs.existsSync(path.join(root, "bench", "neutral.config.yaml")), "the neutral benchmark config ships");
});

// review-surfaces.BENCH.2: the pinned public benchmark includes representative
// Swift/SwiftPM/iOS cases (well-formed; the on-demand runner exercises them). This
// guards the CONTRACT — the on-demand runner (network) is what actually scores the
// quality bar. Beyond "≥6 well-formed Swift pins" it asserts the manifest carries the
// shapes BENCH.2 enumerates that a structural check CAN see: the recall annotations,
// an entitlement/privacy-manifest config case, and a package requirement/pin case.
test("review-surfaces.BENCH.2 the benchmark pins Swift/SwiftPM cases", () => {
  const root = process.cwd();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "bench", "manifest.json"), "utf8"));
  type Case = { id: string; lang: string; base: string; head: string; repo: string; expected_focus?: unknown };
  const swift = (manifest.cases as Case[]).filter((c) => c.lang === "swift");
  assert.ok(swift.length >= 6, `the benchmark pins at least six Swift cases (found ${swift.length})`);
  for (const c of swift) {
    assert.match(c.base, /^[0-9a-f]{40}$/, `swift case ${c.id} base is a full commit SHA`);
    assert.match(c.head, /^[0-9a-f]{40}$/, `swift case ${c.id} head is a full commit SHA`);
    assert.match(c.repo, /^https:\/\/.+\.git$/, `swift case ${c.id} repo is clonable`);
    // Any expected_focus must be a non-empty array of path strings (the recall metric
    // ignores a malformed annotation, so a typo would silently drop coverage).
    if (c.expected_focus !== undefined) {
      assert.ok(
        Array.isArray(c.expected_focus) && c.expected_focus.length > 0 && c.expected_focus.every((p) => typeof p === "string" && p.length > 0),
        `swift case ${c.id} expected_focus is a non-empty array of paths`
      );
    }
  }

  // High expected-focus recall needs real annotation coverage: most Swift cases carry
  // expected_focus (only deliberately-broad exclusion-stress cases stay unannotated).
  const annotated = swift.filter((c) => Array.isArray(c.expected_focus) && c.expected_focus.length > 0);
  assert.ok(annotated.length >= 6, `at least six Swift cases carry expected_focus for the recall metric (found ${annotated.length})`);

  // The config/privacy shape: a Swift case whose intended focus is an Apple
  // project/config file (privacy manifest, entitlements, plist, xcconfig, or a SwiftPM
  // manifest) rather than impl source.
  const APPLE_CONFIG = /(\.xcprivacy|\.entitlements|\.plist|\.xcconfig|(^|\/)Package(@swift-[^/]+)?\.swift)$/;
  const focusPaths = (c: Case) => (Array.isArray(c.expected_focus) ? (c.expected_focus as string[]) : []);
  assert.ok(
    swift.some((c) => focusPaths(c).some((p) => APPLE_CONFIG.test(p))),
    "the Swift set includes an entitlement/privacy-manifest or SwiftPM-manifest config case (BENCH.2 config/package shape)"
  );
  // The package requirement/pin shape: a case focused on a SwiftPM manifest.
  assert.ok(
    swift.some((c) => focusPaths(c).some((p) => /(^|\/)Package(@swift-[^/]+)?\.swift$/.test(p))),
    "the Swift set includes a package requirement/pin case (BENCH.2 package shape)"
  );
  // The Swift Testing weakening shape: a case documented as exercising the weakening
  // regression class (a removed/disabled/softened @Test), focused on a Swift test file.
  assert.ok(
    swift.some((c) => /weakening/i.test((c as { id?: string; note?: string }).note ?? "") || /weakening/i.test(c.id)),
    "the Swift set includes a Swift Testing weakening case (BENCH.2 weakening shape)"
  );
});
