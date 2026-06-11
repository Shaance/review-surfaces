import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { renderHumanReviewHtml } from "../src/human/render-html";
import { buildHumanReview } from "../src/human/human-review";
import { minimalReviewPacket } from "./helpers/review-packet";
import type { ReviewPacket } from "../src/render/packet";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");

function runScoreboard(dir: string, args: string[] = []): { status: number; stderr: string } {
  try {
    const stderr = execFileSync("node", [CLI, "scoreboard", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stderr };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { status: failure.status ?? 1, stderr: failure.stderr ?? "" };
  }
}

test("review-surfaces.EVAL_HARNESS.6 the README scoreboard block regenerates idempotently inside markers and --check fails when stale", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-scoreboard-"));
  try {
    fs.mkdirSync(path.join(dir, ".review-surfaces"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".review-surfaces", "eval_scoreboard.json"),
      JSON.stringify({ schema_version: "review-surfaces.eval_scoreboard.v1", top_n: 10, classes: { api_break: { passed: 1, total: 1 }, weakened_test: { passed: 1, total: 1 } } })
    );
    fs.writeFileSync(path.join(dir, "README.md"), "# Fixture\n\nIntro text.\n");
    // First run appends the marker block.
    assert.equal(runScoreboard(dir).status, 0);
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    assert.match(readme, /<!-- review-surfaces:eval-scoreboard -->/);
    assert.match(readme, /\*\*2\/2\*\* seeded case\(s\) across 2 fact class\(es\) in the top 10/);
    assert.match(readme, /\| api_break \| 1\/1 \|/);
    // Idempotent: a second run changes nothing.
    assert.equal(runScoreboard(dir).status, 0);
    assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), readme);
    assert.equal(runScoreboard(dir, ["--check"]).status, 0);
    // Hand-editing inside the markers makes --check fail loudly.
    fs.writeFileSync(path.join(dir, "README.md"), readme.replace("**2/2**", "**99/2**"));
    const stale = runScoreboard(dir, ["--check"]);
    assert.equal(stale.status, 10);
    assert.match(stale.stderr, /stale/);
    // Regeneration repairs it (idempotent upsert between the markers).
    assert.equal(runScoreboard(dir).status, 0);
    assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), readme);
    // No scoreboard file -> nothing to assert; exit 0.
    fs.rmSync(path.join(dir, ".review-surfaces", "eval_scoreboard.json"));
    assert.equal(runScoreboard(dir, ["--check"]).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review-surfaces.EVAL_HARNESS.6 the cockpit footer cites the eval score from the model", () => {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  const model = buildHumanReview({
    packet,
    evalScoreboard: { top_n: 10, classes: [{ name: "api_break", passed: 1, total: 1 }, { name: "weakened_test", passed: 1, total: 1 }] }
  });
  const html = renderHumanReviewHtml(model, {});
  assert.match(html, /Eval scoreboard: 2\/2 seeded regression case\(s\) across 2 fact class\(es\) ranked in the top 10/);
  // Without a scoreboard the footer is absent — never a fabricated score.
  const bare = buildHumanReview({ packet });
  assert.doesNotMatch(renderHumanReviewHtml(bare, {}), /Eval scoreboard:/);
});
