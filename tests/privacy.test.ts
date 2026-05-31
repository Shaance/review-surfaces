import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectInputs } from "../src/collector/collect";
import { defaultConfig } from "../src/config/config";
import { loadPrivacyIgnore } from "../src/privacy/ignore";
import { redactSecrets } from "../src/privacy/secrets";

test("review-surfaces.COLLECTOR.6 applies .review-surfacesignore before indexing changed files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-ignore-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".review-surfacesignore"), ".env.local\n");
  fs.writeFileSync(path.join(tmp, ".env.local"), "GOOGLE_GENERATIVE_AI_API_KEY=AIzaSyFakeSecretForTestingOnly000000\n");
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  PRIVACY:
    requirements:
      3: .review-surfacesignore must exclude sensitive files deterministically.
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const result = await collectInputs({
    cwd: tmp,
    config: {
      ...defaultConfig,
      specs: ["features/**/*.feature.yaml"],
      docs: ["**/*"],
      tests: [],
      output_dir: ".review-surfaces"
    },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  assert.ok(!result.changedFiles.some((file) => file.path === ".env.local"));
  assert.ok(!result.docs.some((doc) => doc.path === ".env.local"));
  assert.deepEqual(result.privacy.ignored_changed_files, [".env.local"]);
});

test("review-surfaces.PRIVACY.2 redacts secrets from collected diff artifacts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-redact-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  PRIVACY:
    requirements:
      2: Secret scanning or redaction must run before any remote LLM call.
`
  );
  fs.writeFileSync(path.join(tmp, "public.txt"), "safe\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], {
    cwd: tmp,
    stdio: "ignore"
  });
  fs.writeFileSync(path.join(tmp, "public.txt"), "GOOGLE_GENERATIVE_AI_API_KEY=AIzaSyFakeSecretForTestingOnly000000\n");

  await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD",
    headRef: "HEAD",
    dogfood: false
  });

  const diff = fs.readFileSync(path.join(tmp, ".review-surfaces", "inputs", "diff.patch"), "utf8");
  const privacy = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "inputs", "privacy.json"), "utf8"));
  assert.doesNotMatch(diff, /AIzaSyFakeSecretForTestingOnly/);
  // The AIza value is a Google API key, so it is redacted by its PRECISE kind;
  // the generic token_assignment catch-all no longer overwrites that marker with
  // [REDACTED:secret] (the (?!\[REDACTED:) lookahead in secrets.ts).
  assert.match(diff, /GOOGLE_GENERATIVE_AI_API_KEY=\[REDACTED:google_api_key\]/);
  assert.ok(privacy.diff_redactions.length > 0);
});

test("review-surfaces.PRIVACY.3 supports gitignore-style negation for tracked examples", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-ignore-negation-"));
  fs.writeFileSync(path.join(tmp, ".review-surfacesignore"), ".env.*\n!.env.example\n");
  const ignore = await loadPrivacyIgnore(tmp, ".review-surfacesignore");

  assert.equal(ignore.isIgnored(".env.local"), true);
  assert.equal(ignore.isIgnored(".env.example"), false);
});

test("review-surfaces.PRIVACY.3 default ignore excludes local Claude state", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-ignore-claude-"));
  const ignore = await loadPrivacyIgnore(tmp, ".review-surfacesignore");

  assert.equal(ignore.isIgnored(".claude/settings.local.json"), true);
  assert.equal(ignore.isIgnored(".claude/scheduled_tasks.lock"), true);
  assert.equal(ignore.isIgnored("CLAUDE.md"), false);
});

test("review-surfaces.PRIVACY.2 blocks high-risk private key material for remote prompts", () => {
  const pemLabel = "PRIVATE KEY";
  const result = redactSecrets(`PRIVATE_KEY=-----BEGIN ${pemLabel}-----\nabc\n-----END ${pemLabel}-----`);

  assert.equal(result.blocked, true);
  assert.doesNotMatch(result.text, /BEGIN PRIVATE KEY/);
});

// R4.4: each new high-confidence provider-token pattern must BLOCK the remote
// call, remove the raw secret literal, and leave its [REDACTED:<kind>] marker.
const PROVIDER_TOKEN_CASES: Array<{ name: string; secret: string; kind: string }> = [
  { name: "AWS access key id", secret: "AKIAIOSFODNN7EXAMPLE", kind: "aws_access_key_id" },
  {
    name: "AWS secret access key assignment",
    secret: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    kind: "aws_secret"
  },
  { name: "GitHub ghp_ token", secret: `ghp_${"A".repeat(36)}`, kind: "github_token" },
  { name: "GitHub fine-grained pat", secret: `github_pat_${"A".repeat(22)}`, kind: "github_token" },
  { name: "Slack xoxb token", secret: "xoxb-1234567890-abcdefghijklmnop", kind: "slack_token" },
  { name: "OpenAI sk-proj key", secret: `sk-proj-${"a".repeat(24)}`, kind: "openai_key" },
  { name: "OpenAI sk key", secret: `sk-${"a".repeat(24)}`, kind: "openai_key" },
  { name: "Stripe live key", secret: `sk_live_${"a".repeat(24)}`, kind: "stripe_key" },
  { name: "Google OAuth token", secret: `ya29.${"a".repeat(30)}`, kind: "google_oauth_token" },
  { name: "JWT", secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", kind: "jwt" }
];

for (const testCase of PROVIDER_TOKEN_CASES) {
  test(`review-surfaces.PRIVACY.2 blocks and redacts ${testCase.name}`, () => {
    const result = redactSecrets(`leaked here: ${testCase.secret} end`);
    assert.equal(result.blocked, true, `${testCase.name} must privacy-block`);
    assert.ok(!result.text.includes(testCase.secret), `${testCase.name} raw literal must be removed`);
    // The specific kind is recorded as a blocking redaction; the generic
    // token_assignment catch-all no longer re-claims an inserted marker (lookahead).
    assert.ok(
      result.redactions.some((r) => r.kind === testCase.kind && r.blocked),
      `${testCase.name} records a blocking ${testCase.kind} redaction`
    );
  });
}

test("review-surfaces.PRIVACY.2 specific provider token wins over the generic token_assignment", () => {
  // A GitHub token inside a generic TOKEN= assignment: the github pattern
  // (specific, runs first) claims the token via its own kind and BLOCKS it. The
  // generic token_assignment catch-all must NOT re-claim the inserted marker (a
  // `(?!\[REDACTED:)` lookahead guards this), so the precise kind wins in BOTH the
  // rendered text and the redaction inventory — no clobbered label, no double-count.
  const ghToken = `ghp_${"B".repeat(36)}`;
  const result = redactSecrets(`GH_TOKEN=${ghToken}`);
  assert.equal(result.blocked, true, "the github_token redaction makes the result blocked");
  assert.ok(!result.text.includes(ghToken), "raw github token literal is removed");
  assert.match(result.text, /\[REDACTED:github_token\]/, "the precise kind wins in the visible text");
  assert.doesNotMatch(result.text, /\[REDACTED:secret\]/, "the generic token_assignment marker must NOT overwrite the specific kind");
  assert.deepEqual(
    result.redactions.map((r) => r.kind),
    ["github_token"],
    "exactly one redaction is recorded — the generic catch-all does not double-claim the marker"
  );
});

test("review-surfaces.PRIVACY.2 does not over-redact benign text without a token shape", () => {
  const benign = "The quick brown fox reviews the diff and approves the change.";
  const result = redactSecrets(benign);
  assert.equal(result.blocked, false);
  assert.equal(result.text, benign);
  assert.equal(result.redactions.length, 0);
});
