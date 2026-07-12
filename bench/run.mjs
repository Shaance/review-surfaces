#!/usr/bin/env node
// review-surfaces real-world effectiveness benchmark (review-surfaces.BENCH.1).
//
// Runs the FULL `all` pipeline (mock provider) over a set of PINNED real PR-shaped diffs
// across languages and scores the review surface against the failure modes the tool is
// meant to avoid. This is NOT the CI gate (which is a fast seeded empty-diff self-dogfood,
// blind to whether a surface produces *sensible* output) — it is the live-output check the
// dogfood discipline calls for, run on demand: `node bench/run.mjs`.
//
// Each case pins a public repo + base/head SHAs (deterministic given the SHAs). Repos are
// cloned on demand into a gitignored cache, so the only requirements are network + a built
// checkout. Metrics are mostly OBJECTIVE (no per-PR annotation needed); `expected_focus`
// is optional and only adds the top-5 recall metric for cases that carry it.
//
// Metrics (aggregate):
//   empty_queue_rate    — substantive code diffs that produced 0 review-first items (LOWER is better; target 0)
//   false_blocker_rate  — spec-less runs that fabricated a blocker (LOWER is better; target 0)
//   top_is_code_rate    — cases whose #1 review-focus item is a code/impl file (HIGHER is better)
//   irrelevant_top_rate — cases with a doc/generated/binary file in the top 5 (LOWER is better; target 0)
//   focus_recall@5      — mean over annotated cases of |expected_focus ∩ top5| / |expected_focus| (HIGHER is better)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(BENCH_DIR);
const CACHE_DIR = process.env.BENCH_CACHE ?? path.join(BENCH_DIR, ".cache");
const CLI = path.join(REPO_ROOT, "bin", "review-surfaces.js");
const MANIFEST = path.join(BENCH_DIR, "manifest.json");
const NEUTRAL_CONFIG = path.join(BENCH_DIR, "neutral.config.yaml");

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|m)$/i;
const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|txt|org)$/i;
const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|(^|[._-])(test|spec)[._.-]|_test\.|(?:Test|Spec)\.[^.]+$/;
const LOCK_NAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json", "cargo.lock",
  "go.sum", "poetry.lock", "composer.lock", "uv.lock", "gemfile.lock", "pipfile.lock"
]);
const BINARY_EXT = /\.(png|jpe?g|gif|svg|ico|webp|pdf|zip|tar|gz|jar|war|exe|dll|so|dylib|class|wasm|woff2?|ttf|min\.js|min\.css|map|snap)$/i;
// A human does not read these on a cold start; a lock/binary leaking into the top-5 is the
// same "irrelevant top item" failure as a doc/generated file (Codex BENCH.1).
const IRRELEVANT_ROLES = new Set(["doc", "generated", "artifact"]);

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// Clone exactly the two pinned commits (shallow) into the cache, once per repo+base+head.
// The key includes BOTH pins so changing a case's base re-clones instead of reusing a clone
// that lacks the new base; a cached dir is reused only after revalidating that both pinned
// commits are present, so an interrupted earlier clone is rebuilt, not trusted (Codex BENCH.1).
function ensureRepo(repoUrl, base, head) {
  const key = `${repoUrl.replace(/[^a-z0-9]+/gi, "-")}-${base.slice(0, 12)}-${head.slice(0, 12)}`;
  const dir = path.join(CACHE_DIR, key);
  if (fs.existsSync(path.join(dir, ".git"))) {
    try {
      sh("git", ["cat-file", "-e", `${head}^{commit}`], dir);
      sh("git", ["cat-file", "-e", `${base}^{commit}`], dir);
      return dir; // complete cache — both pins present.
    } catch {
      fs.rmSync(dir, { recursive: true, force: true }); // partial/interrupted clone — rebuild.
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  sh("git", ["init", "-q"], dir);
  sh("git", ["remote", "add", "origin", repoUrl], dir);
  sh("git", ["fetch", "-q", "--depth", "1", "origin", head], dir);
  try {
    sh("git", ["fetch", "-q", "--depth", "1", "origin", base], dir);
  } catch {
    // base may already be reachable from head's history; deepening below recovers it.
  }
  // Deepen head's history until a real merge base with base exists, so a multi-commit
  // PR-shaped range (head more than a few commits past base) still has a common ancestor
  // and `base..head` is computed correctly, not from a broken shallow boundary (Codex BENCH.1).
  let depth = 1;
  for (let i = 0; i < 10; i += 1) {
    try {
      sh("git", ["merge-base", base, head], dir);
      break;
    } catch {
      depth += 50;
      try {
        sh("git", ["fetch", "-q", "--depth", String(depth), "origin", head], dir);
        sh("git", ["fetch", "-q", "--depth", String(depth), "origin", base], dir);
      } catch {
        break; // remote can't deepen further; proceed with what we have.
      }
    }
  }
  sh("git", ["checkout", "-q", head], dir);
  return dir;
}

function classify(p) {
  const base = (p.split("/").pop() ?? p).toLowerCase();
  if (LOCK_NAMES.has(base) || BINARY_EXT.test(base)) return "artifact";
  if (TEST_RE.test(p)) return "test";
  if (DOC_EXT.test(p)) return "doc";
  if (/(^|\/)(generated|dist|build|vendor|node_modules|target)\//i.test(p)) return "generated";
  if (CODE_EXT.test(p)) return "code";
  return "other";
}

function scoreCase(c, model, markdown, scoreReviewerUsefulness) {
  const queue = model.review_queue ?? [];
  const blockers = model.blockers ?? [];
  const top5 = queue.slice(0, 5).map((q) => q.path).filter(Boolean);
  const topRole = queue.length > 0 ? classify(queue[0].path ?? "") : null;
  const irrelevantTop = top5.some((p) => IRRELEVANT_ROLES.has(classify(p)));
  const substantiveCase = c.substantive !== false;
  const blockerEligible = c.expect_no_blockers !== false;
  const emptyQueue = substantiveCase && queue.length === 0;
  const falseBlocker = blockerEligible && blockers.length > 0;
  let focusRecall = null;
  if (Array.isArray(c.expected_focus) && c.expected_focus.length > 0) {
    const hit = c.expected_focus.filter((f) => top5.includes(f)).length;
    focusRecall = hit / c.expected_focus.length;
  }
  const usefulness = scoreReviewerUsefulness(model, markdown, c.usefulness);
  return { id: c.id, lang: c.lang, queue_size: queue.length, blockers: blockers.length, top: queue[0]?.path ?? null, topRole, top5, substantiveCase, blockerEligible, emptyQueue, falseBlocker, irrelevantTop, focusRecall, usefulness, hasUsefulnessExpectations: Boolean(c.usefulness) };
}

function pct(n, d) {
  return d === 0 ? "n/a" : `${Math.round((100 * n) / d)}% (${n}/${d})`;
}

async function main() {
  if (!fs.existsSync(CLI)) {
    console.error(`bench: ${CLI} not found — run \`pnpm run build\` first.`);
    process.exit(2);
  }
  const scorerUrl = pathToFileURL(path.join(REPO_ROOT, "dist", "src", "bench", "usefulness.js")).href;
  const { scoreReviewerUsefulness } = await import(scorerUrl);
  const cases = JSON.parse(fs.readFileSync(MANIFEST, "utf8")).cases;
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rs-bench-out-"));
  const results = [];
  for (const c of cases) {
    process.stderr.write(`bench: ${c.id} (${c.lang}) ... `);
    try {
      const repoDir = ensureRepo(c.repo, c.base, c.head);
      const out = path.join(outRoot, c.id);
      // --no-conversation-discovery keeps the run hermetic: without it `all` would
      // auto-discover the BENCHMARK RUNNER's own Claude/Codex sessions and fold a
      // machine-specific transcript into the result, making the scorecard nondeterministic
      // and polluted by the runner's environment (Codex BENCH.1).
      // --config forces the benchmark's neutral config (spec-less, defaults) so a target
      // repo's own review-surfaces.config.yaml / feature spec can't change the result, and
      // --no-conversation-discovery keeps the run from folding the runner's own sessions in.
      sh("node", [CLI, "all", "--provider", "mock", "--config", NEUTRAL_CONFIG, "--no-conversation-discovery", "--base", c.base, "--head", c.head, "--out", out], repoDir);
      const model = JSON.parse(fs.readFileSync(path.join(out, "human_review.json"), "utf8"));
      const markdown = fs.readFileSync(path.join(out, "human_review.md"), "utf8");
      const r = scoreCase(c, model, markdown, scoreReviewerUsefulness);
      results.push(r);
      process.stderr.write(`queue=${r.queue_size} blockers=${r.blockers} top=${r.topRole ?? "-"}\n`);
    } catch (err) {
      process.stderr.write(`ERROR ${(err && err.message ? err.message : String(err)).split("\n")[0]}\n`);
      results.push({ id: c.id, lang: c.lang, error: true });
    }
  }

  const ok = results.filter((r) => !r.error);
  const erroredN = results.filter((r) => r.error).length;
  // Each rate's denominator is the cases ELIGIBLE for that metric, not all cases — a
  // `substantive:false` or `expect_no_blockers:false` case must not dilute the rate (Codex BENCH.1).
  const substantive = ok.filter((r) => r.substantiveCase);
  const blockerEligible = ok.filter((r) => r.blockerEligible);
  const annotated = ok.filter((r) => r.focusRecall !== null && r.focusRecall !== undefined);
  const emptyN = substantive.filter((r) => r.emptyQueue).length;
  const blockerN = blockerEligible.filter((r) => r.falseBlocker).length;
  const codeTopN = ok.filter((r) => r.topRole === "code").length;
  const irrelevantN = ok.filter((r) => r.irrelevantTop).length;
  const recallMean = annotated.length ? annotated.reduce((s, r) => s + r.focusRecall, 0) / annotated.length : null;
  const usefulnessCases = ok.filter((r) => r.hasUsefulnessExpectations);
  const judgedFindings = usefulnessCases.reduce((sum, r) => sum + r.usefulness.judged_findings, 0);
  const actionableFindings = usefulnessCases.reduce((sum, r) => sum + r.usefulness.actionable_findings, 0);
  const missingActionableFindings = usefulnessCases.reduce((sum, r) => sum + r.usefulness.missing_actionable_findings, 0);
  const judgedComments = usefulnessCases.reduce((sum, r) => sum + r.usefulness.judged_comments, 0);
  const postableComments = usefulnessCases.reduce((sum, r) => sum + r.usefulness.postable_comments, 0);
  const missingPostableComments = usefulnessCases.reduce((sum, r) => sum + r.usefulness.missing_postable_comments, 0);
  const usefulnessFailureN = usefulnessCases.filter((r) => r.usefulness.failures.length > 0).length;
  const ratings = usefulnessCases.map((r) => r.usefulness.reviewer_value_rating).filter((value) => value !== null && value !== undefined);
  const ratingMean = ratings.length > 0 ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null;
  const firstActionLines = usefulnessCases.map((r) => r.usefulness.first_action_line).filter((value) => value !== null);
  const primarySurfaceLines = usefulnessCases.map((r) => r.usefulness.primary_surface_lines).filter((value) => value !== null);
  const duplicateRoots = usefulnessCases.reduce((sum, r) => sum + r.usefulness.duplicate_root_causes, 0);

  const lines = [];
  lines.push("# review-surfaces effectiveness scorecard");
  lines.push("");
  lines.push(`Cases run: **${ok.length}/${results.length}**${erroredN ? ` (**${erroredN} errored**)` : ""} (mock provider, full \`all\` pipeline over pinned real diffs).`);
  lines.push("");
  lines.push("| Metric | Result | Target |");
  lines.push("|---|---|---|");
  lines.push(`| empty-queue rate (substantive diffs) | ${pct(emptyN, substantive.length)} | 0% |`);
  lines.push(`| false-blocker rate (spec-less) | ${pct(blockerN, blockerEligible.length)} | 0% |`);
  lines.push(`| top item is code/impl | ${pct(codeTopN, ok.length)} | high |`);
  lines.push(`| irrelevant (doc/generated/lock/binary) in top-5 | ${pct(irrelevantN, ok.length)} | 0% |`);
  lines.push(`| focus recall@5 (annotated) | ${recallMean === null ? "n/a" : `${Math.round(100 * recallMean)}%`} | high |`);
  lines.push(`| curated finding precision | ${judgedFindings === 0 ? "n/a" : pct(actionableFindings, judgedFindings)} | high |`);
  lines.push(`| curated suggested-comment precision | ${judgedComments === 0 ? "n/a" : pct(postableComments, judgedComments)} | high |`);
  lines.push(`| curated actionable finding recall | ${pct(actionableFindings, actionableFindings + missingActionableFindings)} | 100% |`);
  lines.push(`| curated postable-comment recall | ${pct(postableComments, postableComments + missingPostableComments)} | 100% |`);
  lines.push(`| first concrete action line (worst curated case) | ${firstActionLines.length > 0 ? Math.max(...firstActionLines) : "n/a"} | within case budget |`);
  lines.push(`| primary surface line (worst curated case) | ${primarySurfaceLines.length > 0 ? Math.max(...primarySurfaceLines) : "n/a"} | within case budget |`);
  lines.push(`| duplicate decision roots (curated cases) | ${duplicateRoots} | 0 |`);
  lines.push(`| usefulness cases failing density/actionability gates | ${usefulnessFailureN}/${usefulnessCases.length} | 0 |`);
  lines.push(`| manual reviewer-value rating | ${ratingMean === null ? "n/a" : `${ratingMean.toFixed(1)}/5 (${ratings.length} rated)`} | ≥4/5 |`);
  lines.push("");
  lines.push("## Per-case");
  lines.push("");
  lines.push("| id | lang | queue | blockers | top item | top role | empty? | false-blocker? | recall@5 | usefulness |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.id} | ${r.lang} | — | — | _error_ | — | — | — | — | — |`);
      continue;
    }
    lines.push(
      `| ${r.id} | ${r.lang} | ${r.queue_size} | ${r.blockers} | \`${r.top ?? "—"}\` | ${r.topRole ?? "—"} | ${r.emptyQueue ? "**YES**" : "no"} | ${r.falseBlocker ? "**YES**" : "no"} | ${r.focusRecall === null || r.focusRecall === undefined ? "—" : `${Math.round(100 * r.focusRecall)}%`} | ${r.hasUsefulnessExpectations ? `${r.usefulness.failures.length === 0 ? "pass" : `**FAIL (${r.usefulness.failures.length})**`} · action ${r.usefulness.first_action_line ?? "—"} · primary ${r.usefulness.primary_surface_lines ?? "—"} · dup ${r.usefulness.duplicate_root_causes}` : "—"} |`
    );
  }
  lines.push("");
  const scorecard = lines.join("\n") + "\n";
  fs.writeFileSync(path.join(BENCH_DIR, "SCORECARD.md"), scorecard);
  fs.rmSync(outRoot, { recursive: true, force: true });
  process.stdout.write(scorecard);
  // Non-zero exit if a core failure mode is present OR any case errored — a benchmark that
  // silently skips a case it could not run (missing dist/, clone failure, CLI crash) would
  // over-report coverage (Codex BENCH.1).
  if (emptyN > 0 || blockerN > 0 || usefulnessFailureN > 0 || erroredN > 0) {
    process.stderr.write(`\nbench: FAIL — ${erroredN} errored, ${emptyN} empty-queue, ${blockerN} false-blocker, ${usefulnessFailureN} reviewer-usefulness case(s).\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
