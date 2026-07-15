import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

const ROOT = process.cwd();

function readYaml(relativePath: string): any {
  return parseYaml(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function rawFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function outputBoundaryScript(): string {
  const action = readYaml("action.yml");
  const steps: any[] = action.runs.steps;
  const runStep = steps.find((step) => typeof step.run === "string" && step.run.includes('node "$RS_BIN" all'));
  const run = String(runStep?.run ?? "");
  const start = run.indexOf('subject_root="$(pwd -P)"');
  const marker = "# Output boundary validated.";
  const end = run.indexOf(marker, start);
  assert.ok(start >= 0 && end > start, "the executable output-boundary prologue exists");
  return `set -euo pipefail\n${run.slice(start, end + marker.length)}\n`;
}

function runOutputBoundary(subject: string, rawOutput: string): { status: number | null; stdout: string; stderr: string } {
  const script = path.join(path.dirname(subject), "output-boundary.sh");
  const githubOutput = path.join(path.dirname(subject), `github-output-${Math.random()}`);
  fs.writeFileSync(script, outputBoundaryScript(), { mode: 0o700 });
  const result = spawnSync("bash", [script], {
    cwd: subject,
    encoding: "utf8",
    env: { ...process.env, RS_OUT: rawOutput, GITHUB_OUTPUT: githubOutput }
  });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

test("review-surfaces.PR_SURFACE.1 the composite action runs the PR pipeline with a zero-secret mock default and is a renderer over local artifacts", () => {
  const action = readYaml("action.yml");
  assert.equal(action.runs.using, "composite");
  // Zero-secret default so a consuming repo gets full value with no credentials.
  assert.equal(action.inputs.provider.default, "mock");
  // The action carries author context instead of a UI cap that can hide decisions.
  for (const input of ["provider", "base-ref", "head-ref", "change-title", "change-description", "output-dir", "pr-number"]) {
    assert.ok(action.inputs[input], `action input ${input} present`);
  }
  assert.equal(action.inputs["change-title"].default, "", "event expressions belong in the caller workflow, not action metadata defaults");
  assert.equal(action.inputs["change-description"].default, "", "event expressions belong in the caller workflow, not action metadata defaults");
  assert.equal(action.inputs.repository.default, "", "repository context is resolved in executable steps, not action metadata defaults");
  const steps: any[] = action.runs.steps;
  const runStep = steps.find((s) => typeof s.run === "string" && s.run.includes('node "$RS_BIN" all'));
  assert.ok(runStep, "a step runs the pipeline");
  // It calls the same CLI commands a local user runs (never a separate analysis path).
  assert.match(runStep.run, /node "\$RS_BIN" all \\/);
  assert.match(runStep.run, /--review-scope pr/);
  // A prior artifact is comparison input on a changed head and a cache seed on
  // the exact same head. The seed must replace its old commands with the
  // current-head evidence staged by the workflow before installing $RS_OUT.
  assert.match(runStep.run, /current_head=.*git rev-parse --verify "\$\{RS_HEAD\}\^\{commit\}"/);
  assert.match(runStep.run, /prior_head=.*\.manifest\.head_sha/);
  assert.match(runStep.run, /"\$prior_head" = "\$current_head"/);
  assert.match(runStep.run, /rm -rf -- "\$seed_out\/commands"/);
  assert.match(runStep.run, /cp -a "\$RS_OUT\/commands\/\." "\$current_commands\/"/);
  assert.match(runStep.run, /cp -a "\$current_commands\/\." "\$seed_out\/commands\/"/);
  assert.ok(
    runStep.run.indexOf('cp -a "$current_commands/." "$seed_out/commands/"') < runStep.run.indexOf('mv "$seed_out" "$RS_OUT"'),
    "current command evidence is restored into the seed before it becomes the live output"
  );
  assert.match(runStep.run, /--cache/);
  // The sticky is rendered from human_review.json via the deterministic format.
  assert.match(runStep.run, /node "\$RS_BIN" comment \\/);
  assert.match(runStep.run, /--format sticky/);
  assert.match(runStep.run, /comment \\[^]*--config "\$RS_CONFIG"/);
  // review-surfaces.PR_SURFACE.4: --strict-postability makes a blocked (secret)
  // body a non-zero exit, so the action fails before upload/post — never posting it.
  assert.match(runStep.run, /--strict-postability/);
  // Caller inputs flow through env, never interpolated into the shell (injection).
  assert.doesNotMatch(runStep.run, /\$\{\{ inputs\.(head-ref|base-ref|model|provider) \}\}/);
  assert.match(runStep.run, /--head "\$RS_HEAD"/);
  assert.match(runStep.run, /--change-title "\$RS_CHANGE_TITLE"/);
  assert.match(runStep.run, /--change-description "\$RS_CHANGE_DESCRIPTION"/);
  assert.doesNotMatch(runStep.run, /comment-top-n/);
  const workflow = readYaml(".github/workflows/pr-review-comment.yml");
  const localActionStep = Object.values(workflow.jobs)
    .flatMap((job: any) => job.steps ?? [])
    .find((step: any) => step.uses === "./tool");
  assert.ok(localActionStep, "the repo workflow invokes the local composite action");
  assert.equal(localActionStep.with["change-title"], "${{ github.event.pull_request.title }}");
  assert.equal(localActionStep.with["change-description"], "${{ github.event.pull_request.body }}");
  assert.doesNotMatch(JSON.stringify(localActionStep.with), /comment-top-n/);
});

test("review-surfaces.PR_SURFACE.3 the action uploads the full packet under a stable PR-keyed name and forks upload but skip posting", () => {
  const action = readYaml("action.yml");
  const steps: any[] = action.runs.steps;
  const upload = steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/upload-artifact"));
  assert.ok(upload, "uploads a workflow artifact");
  assert.equal(upload.with.name, "review-surfaces-pr-${{ inputs.pr-number }}");
  assert.match(String(upload.with.path), /steps\.generate\.outputs\.safe-output-dir/);
  // The posting step is gated so fork PRs (post=false) upload only, never post.
  const postStep = steps.find((s) => typeof s.if === "string" && s.if.includes("inputs.post"));
  assert.ok(postStep, "posting is gated on the post input");
  assert.match(String(postStep.if), /always\(\)/, "privacy-blocked generation still reconciles an older sticky");
  // upload happens before the gated post (forks reach upload, stop before post).
  assert.ok(steps.indexOf(upload) < steps.indexOf(postStep), "upload precedes the gated post");
});

test("review-surfaces.PR_SURFACE.4 the action delegates exact-head sticky reconciliation to the shared trusted client", () => {
  const action = readYaml("action.yml");
  const steps: any[] = action.runs.steps;
  const postStep = steps.find((s) => typeof s.if === "string" && s.if.includes("inputs.post"));
  assert.match(String(postStep.if), /always\(\)/);
  assert.match(String(postStep.env.RS_BIN), /bin\/review-surfaces\.js/);
  assert.equal(postStep.env.GH_REPO, "${{ inputs.repository || github.repository }}");
  assert.equal(postStep.env.GH_PR_NUMBER, "${{ inputs.pr-number }}");
  assert.match(String(postStep.run), /node "\$RS_BIN" comment/);
  assert.match(String(postStep.run), /--review-scope pr/);
  assert.match(String(postStep.run), /--format sticky/);
  assert.match(String(postStep.run), /--post/);
  assert.match(String(postStep.run), /--out "\$RS_OUT"/);
  assert.doesNotMatch(String(postStep.run), /gh api|gh pr comment|--method (?:PATCH|DELETE)/);
  assert.doesNotMatch(String(postStep.run), /suggested_comments\.md|pending_review\.json/);
});

test("review-surfaces.PR_SURFACE.5 recovery pins to the last POSTED sticky's run via its fingerprint, first-review on miss", () => {
  const action = readYaml("action.yml");
  const steps: any[] = action.runs.steps;
  const prior = steps.find((s) => typeof s.run === "string" && s.run.includes('node "$RS_STICKY"'));
  assert.ok(prior, "a step reads the prior owned sticky through the shared client");
  assert.match(String(prior.env.RS_STICKY), /bin\/review-surfaces-sticky\.js/);
  assert.match(String(prior.run), /\.head_sha/);
  assert.match(String(prior.run), /\.run_id/);
  assert.match(String(prior.run), /packet_head.*prior_head/s);
  assert.match(String(prior.run), /actions\/runs\/\$prior_run\/artifacts/);
  assert.doesNotMatch(String(prior.run), /gh api user|\.user\.login|startswith\(\$marker/);
  // A missing sticky / fingerprint / expired artifact is the first-review case.
  assert.match(String(prior.run), /first review/i);
  // The generation wires the recovered packet as --previous-packet and records
  // this run's id in the new sticky's fingerprint.
  const runStep = steps.find((s) => typeof s.run === "string" && s.run.includes("--previous-packet"));
  assert.ok(runStep, "the prior packet is wired as --previous-packet");
  assert.match(String(runStep.run), /--run-id "\$GITHUB_RUN_ID"/);
  assert.match(String(runStep.run), /--artifact-url "\$RS_ARTIFACT_URL"/);
});

test("review-surfaces.PR_SURFACE.5 same-head cache reuse does not become a previous-review comparison or clobber current command evidence", () => {
  const action = readYaml("action.yml");
  const steps: any[] = action.runs.steps;
  const runStep = steps.find((s) => typeof s.run === "string" && s.run.includes('node "$RS_BIN" all'));
  const run = String(runStep?.run ?? "");
  const sameHeadBranch = run.slice(run.indexOf('if [[ "$prior_head"'), run.indexOf('elif [[ "$prior_head"'));
  const changedHeadBranch = run.slice(run.indexOf('elif [[ "$prior_head"'), run.indexOf('model_flag=()'));

  assert.ok(sameHeadBranch.length > 0, "the exact-head cache branch exists");
  assert.doesNotMatch(sameHeadBranch, /prev_flag=\(--previous-packet/, "same-head cache reuse is not comparison input");
  assert.match(changedHeadBranch, /prev_flag=\(--previous-packet "\$PREVIOUS_PACKET"\)/);
  assert.doesNotMatch(changedHeadBranch, /cp -a|mv "\$seed_out"/, "a changed head never receives the old cache");
  assert.match(sameHeadBranch, /commands_present=false/);
  assert.match(sameHeadBranch, /\[ -d "\$RS_OUT\/commands" \]/);
  assert.match(sameHeadBranch, /rm -rf -- "\$seed_out\/commands"/);
  assert.match(sameHeadBranch, /preserved current command evidence/);
  assert.match(run, /Prior artifact is missing or invalid; treating this as a first review/);
});

test("review-surfaces.PR_SURFACE.5 executes the output boundary before the same-head cache may replace a directory", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-output-boundary-"));
  const subject = path.join(temp, "subject");
  fs.mkdirSync(subject);
  try {
    const safe = runOutputBoundary(subject, ".review-surfaces/nested");
    assert.equal(safe.status, 0, safe.stderr);

    const safeDotPrefix = runOutputBoundary(subject, "./.review-surfaces");
    assert.equal(safeDotPrefix.status, 0, safeDotPrefix.stderr);

    const safeAbsolute = runOutputBoundary(subject, path.join(fs.realpathSync(subject), "artifacts"));
    assert.equal(safeAbsolute.status, 0, safeAbsolute.stderr);

    const traversal = runOutputBoundary(subject, "../tool");
    assert.notEqual(traversal.status, 0, "parent traversal must be rejected");

    const outside = runOutputBoundary(subject, path.join(temp, "outside"));
    assert.notEqual(outside.status, 0, "an absolute path outside the subject must be rejected");

    fs.mkdirSync(path.join(subject, "real"));
    fs.symlinkSync("real", path.join(subject, "linked"), "dir");
    const symlinkedParent = runOutputBoundary(subject, "linked/output");
    assert.notEqual(symlinkedParent.status, 0, "a symlinked output parent must be rejected");

    fs.writeFileSync(path.join(subject, "file-parent"), "not a directory");
    const regularFileParent = runOutputBoundary(subject, "file-parent/output");
    assert.notEqual(regularFileParent.status, 0, "a non-directory output parent must be rejected");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
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
  assert.ok(workflow.on.pull_request_target.types.includes("edited"), "PR title/body edits refresh the author-provided purpose at the same head");
  assert.equal(job.concurrency.group, "review-surfaces-pr-${{ github.event.pull_request.number }}");
  assert.equal(job.concurrency["cancel-in-progress"], true, "a newer title/body/head event cancels a stale generation run");
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
  const reviewHeadRef = "${{ env.REVIEW_HEAD_SHA }}";
  assert.equal(ci.env.REVIEW_HEAD_SHA, "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}");
  const buildCheckout = ci.jobs["build-test"].steps.find((s: any) => s.uses === "actions/checkout@v4");
  assert.equal(buildCheckout.with.ref, reviewHeadRef, "build-test stamps evidence for the real PR head, not GitHub's synthetic merge commit");
  const localeCheckout = ci.jobs["locale-invariance"].steps.find((s: any) => s.uses === "actions/checkout@v4");
  assert.equal(localeCheckout.with.ref, "${{ github.sha }}", "a required check still validates GitHub's synthetic merge result");
  const smoke = ci.jobs["pr-surface-smoke"];
  assert.ok(smoke, "ci has the pr-surface-smoke job");
  assert.equal(smoke.needs, "build-test", "the preview waits for exact-head command evidence instead of inventing untested decisions");
  const smokeCheckout = smoke.steps.find((s: any) => s.uses === "actions/checkout@v4");
  assert.equal(smokeCheckout.with.ref, reviewHeadRef, "the preview checks out the PR head, never the synthetic merge commit");
  const evidenceDownload = smoke.steps.find((s: any) => s.uses === "actions/download-artifact@v4");
  assert.equal(evidenceDownload.with.name, `command-evidence-${reviewHeadRef}`);
  assert.equal(evidenceDownload.with.path, ".review-surfaces/commands");
  const smokeStep = smoke.steps.find((s: any) => s.uses === "./");
  assert.equal(smokeStep.with.provider, "mock");
  assert.equal(String(smokeStep.with.post), "false");
  assert.equal(smokeStep.with["head-ref"], reviewHeadRef);
  const smokeAssertion = smoke.steps.find((s: any) => s.name === "Assert the sticky comment rendered");
  assert.match(smokeAssertion.run, /review-surfaces:fingerprint head=\$EXPECTED_HEAD/);
  assert.match(smokeAssertion.run, /\.generated_from\.head_sha/);
  assert.match(smokeAssertion.run, /ci-typecheck/);
  assert.match(smokeAssertion.run, /ci-tests/);
  assert.match(smokeAssertion.run, /\.head_sha == \$head/);
});
