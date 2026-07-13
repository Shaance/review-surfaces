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
  assert.match(String(runStep.run), /--artifact-url "\$RS_ARTIFACT_URL"/);
});

// review-surfaces.ACTION_IO.1: the action declares an outputs block a consuming
// workflow can branch on, populated from the deterministic run-summary via
// $GITHUB_OUTPUT. The privacy-INDEPENDENT counts come from a renderer-only step
// (no recompute, no network); gate-code is the exception (Codex finding 1) — it
// comes from the GENERATION step that ran the real gate over the live provider +
// collection, because a renderer cannot observe a privacy block (the packet
// records neither the block nor the run's provider).
test("review-surfaces.ACTION_IO.1 the action declares outputs populated from the packet via $GITHUB_OUTPUT", () => {
  const action = readYaml("action.yml");
  assert.ok(action.outputs, "action.yml must declare a top-level outputs block");
  for (const output of ["gate-code", "missing-count", "invalid-count", "risk-count", "artifact-name", "comment-path"]) {
    assert.ok(action.outputs[output], `outputs.${output} must be declared`);
    // Each output is wired to a step's output (composite outputs use ${{ steps... }}).
    assert.match(String(action.outputs[output].value), /\$\{\{\s*steps\./, `outputs.${output} must read a step output`);
  }
  const steps: any[] = action.runs.steps;
  const summaryStep = steps.find((s) => s.id === "summary");
  assert.ok(summaryStep, "the summary step (id: summary) exists");
  assert.match(String(summaryStep.run), /GITHUB_OUTPUT/, "the summary step writes to $GITHUB_OUTPUT");
  // It derives the privacy-independent machine values from the deterministic JSON
  // projection — a RENDERER over the local packet, never a recompute or a network call.
  assert.match(String(summaryStep.run), /comment --format json/);
  assert.match(String(summaryStep.run), /missing-count=/);
  // Codex finding 1: gate-code is NOT re-projected by the renderer (it would report
  // a clean local-mock context and miss a privacy block). It is sourced from the
  // GENERATION step, which ran the real gate over the live provider + collection.
  assert.equal(
    String(action.outputs["gate-code"].value).includes("steps.generate."),
    true,
    "outputs.gate-code must read the generation step's real gate code, not the renderer-only summary step"
  );
  const generateStep = steps.find((s) => s.id === "generate");
  assert.ok(generateStep, "the generation step (id: generate) exists");
  // The generation step runs `all --json` and writes the real gate_code to $GITHUB_OUTPUT.
  assert.match(String(generateStep.run), /node "\$RS_BIN" all[\s\S]*--json/, "the generation step passes --json so the run summary carries the real gate_code");
  assert.match(String(generateStep.run), /gate-code=/, "the generation step writes gate-code to $GITHUB_OUTPUT");
  assert.match(String(generateStep.run), /GITHUB_OUTPUT/);
});

// review-surfaces.ACTION_IO.2: the action appends the rendered review summary to
// $GITHUB_STEP_SUMMARY (best-effort) so the verdict shows in the run UI even on
// fork PRs where the comment is never posted.
test("review-surfaces.ACTION_IO.2 the action appends the verdict to $GITHUB_STEP_SUMMARY best-effort", () => {
  const action = readYaml("action.yml");
  const steps: any[] = action.runs.steps;
  const summaryStep = steps.find((s) => s.id === "summary" && typeof s.run === "string" && s.run.includes("GITHUB_STEP_SUMMARY"));
  assert.ok(summaryStep, "the summary step appends to $GITHUB_STEP_SUMMARY");
  // It writes the rendered comment.md (trimmed) into the run summary.
  assert.match(String(summaryStep.run), /comment\.md|comment_path/);
  assert.match(String(summaryStep.run), />> "\$GITHUB_STEP_SUMMARY"/);
  // Best-effort: the step never fails the action (set +e / exit 0).
  assert.match(String(summaryStep.run), /set \+e/);
  assert.match(String(summaryStep.run), /exit 0/);
});

// review-surfaces.ACTION_IO.3: a top-level branding block makes the reusable
// action Marketplace-publishable.
test("review-surfaces.ACTION_IO.3 the action carries a Marketplace branding block", () => {
  const action = readYaml("action.yml");
  assert.ok(action.branding, "action.yml must carry a top-level branding block");
  assert.ok(typeof action.branding.icon === "string" && action.branding.icon.length > 0, "branding.icon must be set");
  assert.ok(typeof action.branding.color === "string" && action.branding.color.length > 0, "branding.color must be set");
  // GitHub restricts branding.color to a fixed palette.
  const allowedColors = ["white", "yellow", "blue", "green", "orange", "red", "purple", "gray-dark"];
  assert.ok(allowedColors.includes(action.branding.color), `branding.color "${action.branding.color}" must be a valid Marketplace color`);
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
