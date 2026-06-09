import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { validateJsonSchema } from "../src/schema/json-schema";
import { HUMAN_STANDALONE_ARTIFACTS } from "../src/human/render";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");
const CHANGED = "src/render/comment.ts";
const HUMAN_REVIEW_SCHEMA = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));

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
    const human = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    const humanMarkdown = fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.md"), "utf8");
    assert.equal(validateJsonSchema(HUMAN_REVIEW_SCHEMA, human).valid, true);
    assert.equal(human.mode, "pr");
    const changedQueueItem = human.review_queue.find((item: { path: string }) => item.path === CHANGED);
    assert.ok(changedQueueItem, "human review queue should include the changed renderer file");
    assert.match(changedQueueItem.hunk_header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    assert.ok(changedQueueItem.line_start > 0, "human review queue should include a diff-derived line anchor");
    assert.match(humanMarkdown, /^# Human Review/);
    assert.match(humanMarkdown, /## Verdict/);
    assert.match(humanMarkdown, /## Review first/);
    for (const artifact of HUMAN_STANDALONE_ARTIFACTS) {
      const body = fs.readFileSync(path.join(tmp, ".review-surfaces", artifact.artifact), "utf8");
      assert.match(
        body,
        new RegExp(`^${artifact.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        `${artifact.artifact} should be rendered from human_review.json`
      );
    }
    const markerByCommand: Record<string, string> = {
      queue: "JSON sentinel queue title",
      comments: "JSON sentinel suggested comment",
      trust: "JSON sentinel trust summary",
      "test-plan": "JSON sentinel test plan"
    };
    for (const artifact of HUMAN_STANDALONE_ARTIFACTS) {
      const marker = markerByCommand[artifact.command];
      if (artifact.command === "queue") {
        human.review_queue[0].title = marker;
      } else if (artifact.command === "comments") {
        human.suggested_comments[0] = {
          id: "SC-SENTINEL",
          severity: "clarifying",
          body: marker,
          evidence: [{ kind: "unknown", confidence: "low", note: "JSON sentinel evidence." }],
          risk_ids: [],
          requirement_ids: [],
          confidence: "low",
          ready_to_post: true
        };
      } else if (artifact.command === "trust") {
        human.trust_audit.confidence_summary = marker;
      } else if (artifact.command === "test-plan") {
        human.test_plan[0] = {
          id: "TEST-SENTINEL",
          kind: "automatic",
          priority: "recommended",
          scenario: marker,
          expected_result: "Focused renderer reads human_review.json.",
          maps_to_requirements: [],
          maps_to_risks: [],
          evidence_gap: "JSON sentinel evidence gap."
        };
      }
      fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(human, null, 2));
      const target = path.join(tmp, ".review-surfaces", artifact.artifact);
      fs.writeFileSync(target, "stale artifact");
      const subcommand = runCli(tmp, [artifact.command, "--review-scope", "pr", "--out", ".review-surfaces"]);
      assert.equal(subcommand.status, 0, subcommand.stderr);
      assert.match(subcommand.stdout, new RegExp(`${artifact.label}: \\.review-surfaces/`));
      const focusedBody = fs.readFileSync(target, "utf8");
      assert.match(focusedBody, new RegExp(`^${artifact.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(focusedBody, new RegExp(marker));
    }
    fs.writeFileSync(
      path.join(tmp, ".review-surfaces", "inputs", "feedback.index.json"),
      JSON.stringify(
        {
          schema_version: "review-surfaces.feedback.index.v1",
          feedback: [
            {
              path: ".review-surfaces/feedback/memory.yaml",
              schema_version: "review-surfaces.feedback.v1",
              author: "local",
              head_sha: surface.scope.head_sha,
              findings: [],
              validation: {
                passed: [],
                failed: [],
                notes: ["Manual check recorded: Confirm rendered comment was inspected."]
              },
              false_positives: [],
              false_negatives: [],
              team_policy: [
                {
                  id: "POLICY-RENDER-001",
                  path_pattern: CHANGED,
                  required_manual_check: "Confirm rendered comment was inspected.",
                  evidence: [
                    {
                      kind: "feedback",
                      path: ".review-surfaces/feedback/memory.yaml",
                      event_id: "POLICY-RENDER-001",
                      note: "Feedback team policy POLICY-RENDER-001.",
                      confidence: "high",
                      validation_status: "valid"
                    }
                  ]
                }
              ],
              reviewer_preferences: [
                {
                  key: "always_prioritize",
                  value: [CHANGED],
                  evidence: [
                    {
                      kind: "feedback",
                      path: ".review-surfaces/feedback/memory.yaml",
                      event_id: "reviewer_preference:1",
                      note: "Feedback reviewer preference always_prioritize.",
                      confidence: "high",
                      validation_status: "valid"
                    }
                  ]
                }
              ]
            }
          ]
        },
        null,
        2
      )
    );
    const humanRebuild = runCli(tmp, ["human", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(humanRebuild.status, 0, humanRebuild.stderr);
    const rebuiltHuman = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    const rebuiltHumanMarkdown = fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.md"), "utf8");
    assert.equal(validateJsonSchema(HUMAN_REVIEW_SCHEMA, rebuiltHuman).valid, true);
    assert.equal(rebuiltHuman.feedback_effects.some((effect: { kind: string; action: string; paths: string[] }) => effect.kind === "reviewer_preference" && effect.paths.includes(CHANGED)), true);
    assert.equal(rebuiltHuman.feedback_effects.some((effect: { kind: string; action: string }) => effect.kind === "team_policy" && effect.action.startsWith("Manual check recorded:")), true);
    assert.equal(rebuiltHuman.blockers.some((blocker: { id: string }) => blocker.id === "BLOCK-FEEDBACK-001"), false);
    assert.match(rebuiltHumanMarkdown, /## Feedback memory/);
    assert.match(rebuiltHumanMarkdown, /always_prioritize/);
    fs.writeFileSync(
      path.join(tmp, ".review-surfaces", "inputs", "feedback.index.json"),
      JSON.stringify({ schema_version: "review-surfaces.feedback.index.v1", feedback: {} }, null, 2)
    );
    const malformedFeedbackRebuild = runCli(tmp, ["human", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(malformedFeedbackRebuild.status, 0, malformedFeedbackRebuild.stderr);
    assert.match(malformedFeedbackRebuild.stderr, /ignored malformed feedback memory index/);
    fs.writeFileSync(
      path.join(tmp, ".review-surfaces", "inputs", "feedback.index.json"),
      JSON.stringify(
        {
          schema_version: "review-surfaces.feedback.index.v1",
          feedback: [
            null,
            {
              path: ".review-surfaces/feedback/bad-memory.yaml",
              schema_version: "review-surfaces.feedback.v1",
              author: "local",
              findings: [],
              validation: { passed: [], failed: [], notes: [] },
              false_positives: {},
              false_negatives: [],
              team_policy: [],
              reviewer_preferences: []
            }
          ]
        },
        null,
        2
      )
    );
    const malformedEntryRebuild = runCli(tmp, ["human", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(malformedEntryRebuild.status, 0, malformedEntryRebuild.stderr);
    assert.match(malformedEntryRebuild.stderr, /ignored malformed feedback memory entry/);
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

test("review-surfaces.PROVIDERS.6 PR comment workflow is base-controlled and uses trusted tool checkouts", () => {
  const ciWorkflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
  const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "pr-review-comment.yml"), "utf8");

  assert.doesNotMatch(ciWorkflow, /GOOGLE_GENERATIVE_AI_API_KEY/);
  assert.doesNotMatch(ciWorkflow, /--provider ai-sdk/);
  assert.match(ciWorkflow, /LLM-backed PR comments run from the base-controlled pr-review-comment workflow/);
  assert.match(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /\n  pull_request:/);
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
  assert.match(workflow, /--config "\$GITHUB_WORKSPACE\/tool\/review-surfaces\.config\.yaml"/);
  assert.match(workflow, /--redact-secrets true/);
  assert.match(workflow, /if node -e[\s\S]*s\.llm\?\.provider!=="ai-sdk"[\s\S]*skipping sticky PR comment/);
  assert.doesNotMatch(workflow, /--surface-mode pr/);
});

test("comment --review-scope pr renders agent-file narratives locally but does not mark them postable", () => {
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
    assert.equal(comment.status, 4, "agent-file PR narratives render locally but cannot satisfy the sticky-post gate");
    assert.match(comment.stdout, /## review-surfaces PR review/);
    assert.match(comment.stdout, /### What changed/);
    assert.match(comment.stdout, new RegExp(`Tweaked the sticky comment renderer.*${CHANGED.replace(/[/.]/g, "\\$&")}`, "s"));
    assert.match(comment.stdout, /### Affected coverage/);
    assert.match(comment.stderr, /not postable \(applied\/agent-file\)/);
    // Not the whole-spec dump or boilerplate.
    assert.doesNotMatch(comment.stdout, /\d+ satisfied, \d+ partial, \d+ missing/);
    assert.doesNotMatch(comment.stdout, /Start with missing and partial requirement results/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("human --review-scope pr ignores stale pr_review_surface sidecars", () => {
  const tmp = setupChangedRepo();
  try {
    const run = runCli(tmp, [...ALL_PR, "--provider", "mock"]);
    assert.equal(run.status, 0, run.stderr);

    const surfacePath = path.join(tmp, ".review-surfaces", "pr_review_surface.json");
    const staleSurface = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
    staleSurface.scope.head_sha = "stale-head-sha";
    fs.writeFileSync(surfacePath, JSON.stringify(staleSurface, null, 2));

    const humanRun = runCli(tmp, ["human", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(humanRun.status, 0, humanRun.stderr);
    assert.match(humanRun.stderr, /Ignoring stale pr_review_surface\.json/);

    const human = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    assert.equal(validateJsonSchema(HUMAN_REVIEW_SCHEMA, human).valid, true);
    assert.equal(human.mode, "repo");
    assert.equal(Object.hasOwn(human.generated_from, "pr_surface_path"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
