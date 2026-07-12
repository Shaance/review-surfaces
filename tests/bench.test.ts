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
  const usefulnessCases = manifest.cases.filter((c: { usefulness?: unknown }) => c.usefulness);
  assert.ok(usefulnessCases.length > 0, "review-surfaces.REVIEWER_VALUE.10 keeps at least one curated usefulness case");
  for (const c of usefulnessCases) {
    assert.ok(Array.isArray(c.usefulness.findings), `case ${c.id} carries curated finding judgments`);
    assert.ok(typeof c.usefulness.max_first_action_line === "number", `case ${c.id} carries a first-action budget`);
    assert.ok(typeof c.usefulness.reviewer_value_rating === "number", `case ${c.id} carries an explicit human reviewer-value rating`);
  }

  const runnerSrc = fs.readFileSync(runner, "utf8");
  assert.match(runnerSrc, /--no-conversation-discovery/, "benchmark runs stay hermetic (no auto-discovery of the runner's own sessions)");
  assert.match(runnerSrc, /--config/, "benchmark forces a neutral config so a target repo's own config can't change the result");
  assert.match(runnerSrc, /scoreReviewerUsefulness/, "benchmark scores reviewer usefulness separately from structural validity");
  assert.match(runnerSrc, /first concrete action line \(worst curated case\)/, "benchmark reports its reviewer-density evidence, not only pass/fail");
  assert.match(runnerSrc, /duplicate decision roots \(curated cases\)/, "benchmark reports duplicate-root evidence");
  assert.ok(fs.existsSync(path.join(root, "bench", "neutral.config.yaml")), "the neutral benchmark config ships");
});
