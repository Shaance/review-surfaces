import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = process.cwd();

function readYaml(relativePath: string): any {
  return parseYaml(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function rawFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("review-surfaces.PR_SURFACE.1 the composite action runs the PR pipeline with a zero-secret mock default and is a renderer over local artifacts", () => {
  const action = readYaml("action.yml");
  assert.equal(action.runs.using, "composite");
  // Zero-secret default so a consuming repo gets full value with no credentials.
  assert.equal(action.inputs.provider.default, "mock");
  // Inputs the goal requires: provider, base/head, output dir, comment top-N.
  for (const input of ["provider", "base-ref", "head-ref", "output-dir", "comment-top-n", "pr-number"]) {
    assert.ok(action.inputs[input], `action input ${input} present`);
  }
  const steps: any[] = action.runs.steps;
  const runStep = steps.find((s) => typeof s.run === "string" && s.run.includes('node "$RS_BIN" all'));
  assert.ok(runStep, "a step runs the pipeline");
  // It calls the same CLI commands a local user runs (never a separate analysis path).
  assert.match(runStep.run, /node "\$RS_BIN" all \\/);
  assert.match(runStep.run, /--review-scope pr/);
  // The sticky is rendered from human_review.json via the deterministic format.
  assert.match(runStep.run, /node "\$RS_BIN" comment \\/);
  assert.match(runStep.run, /--format sticky/);
  // review-surfaces.PR_SURFACE.4: --strict-postability makes a blocked (secret)
  // body a non-zero exit, so the action fails before upload/post — never posting it.
  assert.match(runStep.run, /--strict-postability/);
  // Caller inputs flow through env, never interpolated into the shell (injection).
  assert.doesNotMatch(runStep.run, /\$\{\{ inputs\.(head-ref|base-ref|model|provider) \}\}/);
  assert.match(runStep.run, /--head "\$RS_HEAD"/);
});

test("review-surfaces.PR_SURFACE.3 the action uploads the full packet under a stable PR-keyed name and forks upload but skip posting", () => {
  const action = readYaml("action.yml");
  const steps: any[] = action.runs.steps;
  const upload = steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/upload-artifact"));
  assert.ok(upload, "uploads a workflow artifact");
  assert.equal(upload.with.name, "review-surfaces-pr-${{ inputs.pr-number }}");
  assert.match(String(upload.with.path), /inputs\.output-dir/);
  // The posting step is gated so fork PRs (post=false) upload only, never post.
  const postStep = steps.find((s) => typeof s.if === "string" && s.if.includes("inputs.post"));
  assert.ok(postStep, "posting is gated on the post input");
  // upload happens before the gated post (forks reach upload, stop before post).
  assert.ok(steps.indexOf(upload) < steps.indexOf(postStep), "upload precedes the gated post");
});

test("review-surfaces.PR_SURFACE.4 the action posts only the sticky comment.md (marker-checked); suggested comments stay drafts", () => {
  const action = readYaml("action.yml");
  const steps: any[] = action.runs.steps;
  const postStep = steps.find((s) => typeof s.if === "string" && s.if.includes("inputs.post"));
  assert.match(String(postStep.run), /review-surfaces:sticky/);
  assert.match(String(postStep.env.BODY), /comment\.md/);
  // It never posts the suggested-comments artifact.
  assert.doesNotMatch(String(postStep.run), /suggested_comments\.md|pending_review\.json/);
});

test("review-surfaces.PR_SURFACE.5 recovery pins to the last POSTED sticky's run via its fingerprint, first-review on miss", () => {
  const action = readYaml("action.yml");
  const steps: any[] = action.runs.steps;
  const prior = steps.find((s) => typeof s.run === "string" && s.run.includes("review-surfaces:fingerprint"));
  assert.ok(prior, "a step reads the prior sticky's fingerprint");
  // It extracts run=<id> from the last posted sticky and downloads THAT run's artifact.
  assert.match(String(prior.run), /run=\[0-9\]\+/);
  assert.match(String(prior.run), /actions\/runs\/\$prior_run\/artifacts/);
  // A missing sticky / fingerprint / expired artifact is the first-review case.
  assert.match(String(prior.run), /first review/i);
  // The generation wires the recovered packet as --previous-packet and records
  // this run's id in the new sticky's fingerprint.
  const runStep = steps.find((s) => typeof s.run === "string" && s.run.includes("--previous-packet"));
  assert.ok(runStep, "the prior packet is wired as --previous-packet");
  assert.match(String(runStep.run), /--run-id "\$GITHUB_RUN_ID"/);
});

test("review-surfaces.PR_SURFACE.1 the repo workflow is a same-repo-only thin consumer that preserves the PROVIDERS.6 secret boundary", () => {
  const workflow = readYaml(".github/workflows/pr-review-comment.yml");
  const job = workflow.jobs["review-comment"];
  // PROVIDERS.6: base-controlled pull_request_target with a trusted tool checkout
  // at base.sha against a credentialless PR subject checkout.
  assert.ok(workflow.on.pull_request_target, "base-controlled trigger preserved");
  const raw = rawFile(".github/workflows/pr-review-comment.yml");
  assert.match(raw, /pull_request\.base\.sha/);
  assert.match(raw, /pull_request\.head\.sha/);
  assert.match(raw, /persist-credentials: false/);
  // Thin consumer: it uses the local composite action rather than inlining steps.
  assert.ok(job.steps.some((s: any) => s.uses === "./tool"), "workflow consumes the ./tool composite action");
  // The secret-bearing job is gated to same-repo PRs; forks never reach it.
  assert.match(String(job.if), /head\.repo\.full_name == github\.repository/);

  // Fork PRs are served by the ci pull_request smoke job (mock, post=false), so
  // they upload the artifact without the secret-bearing pull_request_target path.
  const ci = readYaml(".github/workflows/ci.yml");
  const smoke = ci.jobs["pr-surface-smoke"];
  assert.ok(smoke, "ci has the pr-surface-smoke job");
  const smokeStep = smoke.steps.find((s: any) => s.uses === "./");
  assert.equal(smokeStep.with.provider, "mock");
  assert.equal(String(smokeStep.with.post), "false");
});
