import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");
const CHANGED = "src/render/comment.ts";

// Copy the repo (minus .git/.review-surfaces/dist), init git, commit a baseline,
// then introduce ONE uncommitted change so there is a real diff to scope.
function setupChangedRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-pr-e2e-"));
  fs.cpSync(process.cwd(), tmp, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(process.cwd(), source);
      return (
        rel !== ".git" && !rel.startsWith(`.git${path.sep}`) &&
        rel !== ".review-surfaces" && !rel.startsWith(`.review-surfaces${path.sep}`) &&
        rel !== "dist" && !rel.startsWith(`dist${path.sep}`)
      );
    }
  });
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
  // One uncommitted change -> the diff scopes to the RENDER area.
  fs.appendFileSync(path.join(tmp, CHANGED), "\n// pr-surface e2e marker\n");
  return tmp;
}

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const ALL_PR = ["all", "--review-scope", "pr", "--base", "HEAD", "--head", "HEAD", "--spec", "features/review-surfaces.feature.yaml", "--out", ".review-surfaces"];

test("review-surfaces.PROVIDERS.5 all --review-scope pr writes a diff-scoped pr_review_surface; mock blocks the narrative", () => {
  const tmp = setupChangedRepo();
  try {
    const run = runCli(tmp, [...ALL_PR, "--provider", "mock"]);
    assert.equal(run.status, 0, run.stderr);
    const surface = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "pr_review_surface.json"), "utf8"));
    assert.equal(surface.mode, "pr");
    // Scoped to the actual change, NOT the whole repo.
    assert.ok(surface.scope.changed_files.some((f: { path: string }) => f.path === CHANGED), "the changed file is in scope");
    assert.ok(surface.scope.affected_requirements.length > 0, "some requirements are affected");
    assert.ok(surface.scope.affected_requirements.length < 80, "scope is a SUBSET of the spec, not all ~85 requirements");
    // A renderer-surface change yields a deterministic PR risk.
    assert.ok(surface.risks.candidates.some((c: { rule: string }) => c.rule === "comment_surface_change"));
    // Mock has no narrative -> blocked, never a whole-repo fallback.
    assert.equal(surface.status, "blocked");
    assert.equal(surface.narrative, undefined);
    assert.equal(Object.hasOwn(surface, "narrative"), false, "blocked serialized surfaces must omit undefined narrative");
    assert.equal(Object.hasOwn(surface.llm, "model"), false, "serialized llm meta must omit undefined model");
    const blockedComment = runCli(tmp, ["comment", "--mode", "pr", "--out", ".review-surfaces"]);
    assert.equal(blockedComment.status, 4, "blocked PR surfaces are not postable successful comments");
    assert.match(blockedComment.stdout, /blocked \(`llm_unavailable`\)/);
    assert.match(blockedComment.stderr, /not postable/);
    // The diagram artifact the surface advertises is actually materialized on disk.
    if (surface.diagram) {
      const diagramFile = path.join(tmp, ".review-surfaces", surface.diagram.path);
      assert.ok(fs.existsSync(diagramFile), `surface.diagram.path ${surface.diagram.path} must be written`);
      assert.equal(fs.readFileSync(diagramFile, "utf8"), surface.diagram.body);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.6 review-comment workflow uses trusted tool and credentialless subject checkouts", () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");

  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /path: tool/);
  assert.match(workflow, /fetch-depth: 1/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /path: subject/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /working-directory: tool[\s\S]*pnpm install --frozen-lockfile[\s\S]*pnpm run build/);
  assert.match(workflow, /GOOGLE_GENERATIVE_AI_API_KEY: \$\{\{ secrets\.GOOGLE_GENERATIVE_AI_API_KEY \}\}/);
  assert.match(workflow, /node \.\.\/tool\/bin\/review-surfaces\.js all[\s\S]*--review-scope pr/);
  assert.match(workflow, /--model google:gemini-2\.5-flash/);
  assert.match(workflow, /--config \.\.\/tool\/review-surfaces\.config\.yaml/);
  assert.match(workflow, /--redact-secrets true/);
  assert.match(workflow, /if node -e[\s\S]*PR review surface not postable[\s\S]*skipping sticky PR comment/);
  assert.doesNotMatch(workflow, /--surface-mode pr/);
});

test("comment --review-scope pr renders the PR surface; with an agent-file narrative it is READY and PR-specific", () => {
  const tmp = setupChangedRepo();
  try {
    // An agent-authored narrative citing the real changed path (anchor allowlisted).
    const narrative = {
      summary: "Adjusts the comment renderer.",
      what_changed: [{ text: "Tweaked the sticky comment renderer", paths: [CHANGED] }],
      why_it_matters: [{ text: "Affects reviewer-facing output", paths: [CHANGED] }],
      review_first: [{ text: "Confirm the rendered comment", paths: [CHANGED] }],
      risk_narratives: []
    };
    fs.writeFileSync(path.join(tmp, "narrative.json"), JSON.stringify(narrative));

    const allRun = runCli(tmp, [...ALL_PR, "--provider", "agent-file", "--agent-input", "narrative.json"]);
    assert.equal(allRun.status, 0, allRun.stderr);
    const surface = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "pr_review_surface.json"), "utf8"));
    assert.equal(surface.status, "ready", `expected ready, got ${surface.status}/${surface.blocked_reason}`);
    assert.ok(surface.narrative.what_changed.length > 0);

    const comment = runCli(tmp, ["comment", "--mode", "pr", "--out", ".review-surfaces"]);
    assert.equal(comment.status, 0, comment.stderr);
    assert.match(comment.stdout, /## review-surfaces PR review/);
    assert.match(comment.stdout, /### What changed/);
    assert.match(comment.stdout, new RegExp(`Tweaked the sticky comment renderer.*${CHANGED.replace(/[/.]/g, "\\$&")}`, "s"));
    assert.match(comment.stdout, /### Affected coverage/);
    // Not the whole-spec dump or boilerplate.
    assert.doesNotMatch(comment.stdout, /\d+ satisfied, \d+ partial, \d+ missing/);
    assert.doesNotMatch(comment.stdout, /Start with missing and partial requirement results/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
