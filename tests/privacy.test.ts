import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectInputs } from "../src/collector/collect";
import { defaultConfig } from "../src/config/config";
import { loadPrivacyIgnore, loadPrivacyIgnoreSync } from "../src/privacy/ignore";
import {
  BLOCKED_REDACTION_KINDS,
  containsBlockingSecretMaterial,
  inspectAndRedactSecrets,
  redactSecrets,
  StreamingBlockingSecretDetector
} from "../src/privacy/secrets";
import { filterIgnoredDiff } from "../src/privacy/diff";
import { pemBoundaryFixture } from "./helpers/secret-fixtures";

const AWS_ACCESS_KEY_ID_FIXTURE = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const AWS_SECRET_VALUE_FIXTURE = ["wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "EXAMPLEKEY"].join("");
const AWS_SECRET_ASSIGNMENT_FIXTURE = `AWS_SECRET_ACCESS_KEY=${AWS_SECRET_VALUE_FIXTURE}`;
const SLACK_BOT_TOKEN_FIXTURE = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
const SLACK_SESSION_TOKEN_FIXTURE = ["xoxs", "1234567890", "abcdefghijklmnop"].join("-");
const JWT_FIXTURE = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  "signature"
].join(".");

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

test("review-surfaces.PRIVACY.3 built-in secret-file ignores are case-insensitive", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-ignore-case-"));
  fs.writeFileSync(path.join(tmp, ".review-surfacesignore"), "README.MD\n");
  const asyncRules = await loadPrivacyIgnore(tmp, ".review-surfacesignore");
  const syncRules = loadPrivacyIgnoreSync(tmp);

  for (const rules of [asyncRules, syncRules]) {
    assert.equal(rules.isIgnored(".ENV.PROD"), true);
    assert.equal(rules.isIgnored("secrets/PROD.PEM"), true);
    assert.equal(rules.isIgnored("keys/ID_RSA"), true);
    assert.equal(rules.isIgnored(".ENV.EXAMPLE"), true, "the built-in .env.example negation stays exact/case-sensitive");
    assert.equal(rules.isIgnored(".env.example"), false, "the exact built-in example remains allowed");
    assert.equal(rules.isIgnored("certs/CERT.P12"), true);
    assert.equal(rules.isIgnored("keys/AuthKey_123ABC.P8"), true);
    assert.equal(rules.isIgnored("profiles/App.mobileprovision"), true);
    assert.equal(rules.isIgnored("login.KEYCHAIN-DB"), true);
    assert.equal(rules.isIgnored("DerivedData/Build/Intermediates.noindex/app.o"), true);
    assert.equal(rules.isIgnored("packages/app/.swiftpm/configuration/registries.json"), true);
    assert.equal(rules.isIgnored("packages/app/.build/debug/module.o"), true);
    assert.equal(rules.isIgnored("App.xcodeproj/xcuserdata/me.xcuserdatad/xcschemes/scheme.xcscheme"), true);
    assert.equal(rules.isIgnored("App.xcworkspace/xcuserdata/me.xcuserdatad/UserInterfaceState.xcuserstate"), true);
    assert.equal(rules.isIgnored("readme.md"), false, "user ignore patterns stay case-sensitive");
  }
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

test("review-surfaces.PRIVACY.2 canonical redaction fails closed on an unmatched private-key opener", () => {
  const result = redactSecrets(`safe prefix ${pemBoundaryFixture("RSA PRIVATE KEY", "BEGIN")}\nMII-UNTERMINATED-KEY`);

  assert.equal(result.blocked, true);
  assert.equal(result.text, "safe prefix [REDACTED:private_key]");
  assert.doesNotMatch(result.text, /BEGIN RSA PRIVATE KEY|MII-UNTERMINATED/);
});

test("review-surfaces.PRIVACY.2 scan-only detection covers raw, persisted, and partial blocked material", () => {
  const githubToken = `ghp_${"Z".repeat(36)}`;
  assert.equal(containsBlockingSecretMaterial(githubToken), true);
  assert.equal(containsBlockingSecretMaterial("[REDACTED:github_token]"), true);
  assert.equal(containsBlockingSecretMaterial(`${pemBoundaryFixture("PRIVATE KEY", "BEGIN")}\npartial`), true);
  assert.equal(containsBlockingSecretMaterial("ordinary review output"), false);

  const persisted = inspectAndRedactSecrets("safe prefix [REDACTED:github_token]");
  assert.equal(persisted.blocked, true);
  assert.equal(persisted.redactions.length, 0);
});

test("review-surfaces.PRIVACY.2 streaming detection survives arbitrarily long fragmented token bodies", () => {
  const jwtDetector = new StreamingBlockingSecretDetector();
  for (const fragment of ["eyJ", "a".repeat(5000), ".", "b".repeat(5000), "."]) {
    assert.equal(jwtDetector.write(fragment), false);
  }
  assert.equal(jwtDetector.write("c"), false, "a chunk edge is not the canonical trailing boundary");
  assert.equal(jwtDetector.blockedSecretSeen(), true, "a word-ending JWT blocks when the stream is finalized");

  const tokenDetector = new StreamingBlockingSecretDetector();
  const token = `ghp_${"Z".repeat(2000)}`;
  for (const character of token) {
    tokenDetector.write(character);
  }
  assert.equal(tokenDetector.blockedSecretSeen(), true, "one-character token fragments must retain prefix state");
});

test("review-surfaces.PRIVACY.2 streaming detection recognizes a fragmented PEM opener", () => {
  const detector = new StreamingBlockingSecretDetector();
  for (const fragment of ["---", "--BE", "GIN RSA ", "PRIVATE ", "KEY--", "---"]) {
    detector.write(fragment);
  }
  assert.equal(detector.blockedSecretSeen(), true);
});

test("review-surfaces.PRIVACY.2 specialized streaming states survive unbounded PEM labels and AWS whitespace", () => {
  const pemDetector = new StreamingBlockingSecretDetector();
  for (const fragment of ["-----BEGIN ", "A".repeat(5000), " PRIVATE KEY", "-----"]) {
    pemDetector.write(fragment);
  }
  assert.equal(pemDetector.blockedSecretSeen(), true, "PEM label can exceed the bounded overlap");

  const awsDetector = new StreamingBlockingSecretDetector();
  for (const fragment of [
    "AWS_SECRET_ACCESS_KEY",
    " ".repeat(5000),
    "=",
    " ".repeat(5000),
    AWS_SECRET_VALUE_FIXTURE
  ]) {
    awsDetector.write(fragment);
  }
  assert.equal(awsDetector.blockedSecretSeen(), true, "AWS assignment whitespace can exceed the overlap");
});

const STREAMING_BLOCKED_KIND_CASES: Array<{ name: string; kind: string; material: string }> = [
  { name: "private key", kind: "private_key", material: `${pemBoundaryFixture("RSA PRIVATE KEY", "BEGIN")}\nMII-UNTERMINATED` },
  { name: "AWS access key id", kind: "aws_access_key_id", material: AWS_ACCESS_KEY_ID_FIXTURE },
  {
    name: "AWS secret",
    kind: "aws_secret",
    material: AWS_SECRET_ASSIGNMENT_FIXTURE
  },
  { name: "GitHub classic token", kind: "github_token", material: `ghp_${"A".repeat(36)}` },
  { name: "GitHub fine-grained token", kind: "github_token", material: `github_pat_${"A".repeat(22)}` },
  { name: "Slack bot token", kind: "slack_token", material: SLACK_BOT_TOKEN_FIXTURE },
  { name: "Slack session token", kind: "slack_token", material: SLACK_SESSION_TOKEN_FIXTURE },
  { name: "OpenAI project key", kind: "openai_key", material: `sk-proj-${"a".repeat(24)}` },
  { name: "OpenAI legacy key", kind: "openai_key", material: `sk-${"a".repeat(24)}` },
  { name: "Stripe secret key", kind: "stripe_key", material: `sk_live_${"a".repeat(24)}` },
  { name: "Stripe restricted key", kind: "stripe_key", material: `rk_live_${"a".repeat(24)}` },
  { name: "Google OAuth token", kind: "google_oauth_token", material: `ya29.${"a".repeat(30)}` },
  {
    name: "JWT",
    kind: "jwt",
    material: JWT_FIXTURE
  },
  { name: "Google API key", kind: "google_api_key", material: `AIza${"a".repeat(30)}` }
];

test("review-surfaces.PRIVACY.2 representative streaming cases cover every blocked secret kind", () => {
  assert.deepEqual(
    [...new Set(STREAMING_BLOCKED_KIND_CASES.map((testCase) => testCase.kind))].sort(),
    [...BLOCKED_REDACTION_KINDS].sort()
  );
});

for (const testCase of STREAMING_BLOCKED_KIND_CASES) {
  test(`review-surfaces.PRIVACY.2 streaming detection has every split-boundary parity for ${testCase.name}`, () => {
    const material = `safe ${testCase.material} tail`;
    assert.equal(containsBlockingSecretMaterial(material), true, "canonical direct detection blocks");
    for (let split = 1; split < material.length; split += 1) {
      const detector = new StreamingBlockingSecretDetector();
      detector.write(material.slice(0, split));
      detector.write(material.slice(split));
      assert.equal(detector.blockedSecretSeen(), true, `missed split at ${split}`);
    }

    const oneCharacterDetector = new StreamingBlockingSecretDetector();
    for (const character of material) {
      oneCharacterDetector.write(character);
    }
    assert.equal(oneCharacterDetector.blockedSecretSeen(), true, "missed one-character fragmentation");
  });
}

test("review-surfaces.PRIVACY.2 persisted blocked markers have every split-boundary parity", () => {
  for (const kind of BLOCKED_REDACTION_KINDS) {
    const marker = `[REDACTED:${kind}]`;
    for (let split = 1; split < marker.length; split += 1) {
      const detector = new StreamingBlockingSecretDetector();
      detector.write(marker.slice(0, split));
      detector.write(marker.slice(split));
      assert.equal(detector.blockedSecretSeen(), true, `${kind} marker missed split at ${split}`);
    }
  }
});

test("review-surfaces.PRIVACY.2 streaming detection leaves long secret-free output unblocked", () => {
  const detector = new StreamingBlockingSecretDetector();
  const chunk = "ordinary build output 1234567890\n".repeat(4096);
  for (let index = 0; index < 40; index += 1) {
    assert.equal(detector.write(chunk), false);
  }
  assert.equal(detector.blockedSecretSeen(), false);
});

test("review-surfaces.PRIVACY.2 streaming detection waits for canonical trailing boundaries", () => {
  const nearMisses = [
    `AKIA${"A".repeat(16)}Q`,
    `ghp_${"A".repeat(36)}_`,
    `xoxb-${"A".repeat(10)}_`,
    `sk_live_${"A".repeat(20)}_`
  ];

  for (const material of nearMisses) {
    assert.equal(containsBlockingSecretMaterial(material), false, `${material.slice(0, 8)} is a canonical near miss`);
    for (let split = 1; split < material.length; split += 1) {
      const detector = new StreamingBlockingSecretDetector();
      assert.equal(detector.write(material.slice(0, split)), false);
      assert.equal(detector.write(material.slice(split)), false);
      assert.equal(detector.blockedSecretSeen(), false, `false positive at split ${split}`);
    }
  }

  const delayedBoundary = new StreamingBlockingSecretDetector();
  assert.equal(delayedBoundary.write(`AKIA${"A".repeat(16)}`), false, "a chunk edge is not a stream boundary");
  assert.equal(delayedBoundary.write("Q"), false);
  assert.equal(delayedBoundary.blockedSecretSeen(), false);

  const trueEnd = new StreamingBlockingSecretDetector();
  assert.equal(trueEnd.write(`AKIA${"A".repeat(16)}`), false);
  assert.equal(trueEnd.blockedSecretSeen(), true, "stream finalization supplies the real trailing boundary");
});

test("review-surfaces.PRIVACY.2 JWT streaming detection matches canonical trailing-boundary near misses", () => {
  const nearMisses = ["eyJa.b.-!", "eyJa.b.-", "xeyJa.b.c"];
  for (const material of nearMisses) {
    assert.equal(containsBlockingSecretMaterial(material), false, `${material} is a canonical near miss`);
    for (let split = 1; split < material.length; split += 1) {
      const detector = new StreamingBlockingSecretDetector();
      assert.equal(detector.write(material.slice(0, split)), false);
      assert.equal(detector.write(material.slice(split)), false);
      assert.equal(detector.blockedSecretSeen(), false, `${material} false-positive at split ${split}`);
    }
  }

  const trueEnd = new StreamingBlockingSecretDetector();
  assert.equal(trueEnd.write(["eyJa", "b", "c"].join(".")), false);
  assert.equal(trueEnd.blockedSecretSeen(), true);
});

// R4.4: each new high-confidence provider-token pattern must BLOCK the remote
// call, remove the raw secret literal, and leave its [REDACTED:<kind>] marker.
const PROVIDER_TOKEN_CASES: Array<{ name: string; secret: string; kind: string }> = [
  { name: "AWS access key id", secret: AWS_ACCESS_KEY_ID_FIXTURE, kind: "aws_access_key_id" },
  {
    name: "AWS secret access key assignment",
    secret: AWS_SECRET_ASSIGNMENT_FIXTURE,
    kind: "aws_secret"
  },
  { name: "GitHub ghp_ token", secret: `ghp_${"A".repeat(36)}`, kind: "github_token" },
  { name: "GitHub fine-grained pat", secret: `github_pat_${"A".repeat(22)}`, kind: "github_token" },
  { name: "Slack xoxb token", secret: SLACK_BOT_TOKEN_FIXTURE, kind: "slack_token" },
  { name: "OpenAI sk-proj key", secret: `sk-proj-${"a".repeat(24)}`, kind: "openai_key" },
  { name: "OpenAI sk key", secret: `sk-${"a".repeat(24)}`, kind: "openai_key" },
  { name: "Stripe live key", secret: `sk_live_${"a".repeat(24)}`, kind: "stripe_key" },
  { name: "Google OAuth token", secret: `ya29.${"a".repeat(30)}`, kind: "google_oauth_token" },
  { name: "JWT", secret: `${JWT_FIXTURE.slice(0, JWT_FIXTURE.lastIndexOf("."))}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`, kind: "jwt" },
  // review-surfaces.PRIVACY.6: google_api_key was the lone blocked:false provider
  // pattern; it now joins the blocked set like every other provider token.
  { name: "Google API key", secret: `AIzaSy${"a".repeat(30)}`, kind: "google_api_key" }
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

test("review-surfaces.PRIVACY.6 a Google API key now hard-blocks a remote call", () => {
  // Was the only provider-credential pattern with blocked:false, so an AIza key
  // in a diff/prompt was text-redacted but did NOT raise the remote-block signal
  // (and it is the default provider's own key shape).
  const result = redactSecrets("GOOGLE_GENERATIVE_AI_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv");
  assert.equal(result.blocked, true, "an AIza key must set the remote-block signal");
  assert.ok(
    result.redactions.some((r) => r.kind === "google_api_key" && r.blocked),
    "the google_api_key redaction is recorded as blocking"
  );
  assert.doesNotMatch(result.text, /AIzaSyA1234567890/);
});

test("review-surfaces.PRIVACY.6 filterIgnoredDiff fails closed on a git-quoted ignored path", () => {
  // The previous greedy regex did not match git's QUOTED header form for a
  // non-ASCII path, and a non-match KEPT the section — leaking the ignored
  // file's added secret line into diff.patch. Git emits `secret café.env` as the
  // octal-escaped, quoted `"a/secret caf\303\251.env"`.
  const diff = [
    'diff --git "a/secret caf\\303\\251.env" "b/secret caf\\303\\251.env"',
    "new file mode 100644",
    "--- /dev/null",
    '+++ "b/secret caf\\303\\251.env"',
    "@@ -0,0 +1 @@",
    "+API_TOKEN=supersecretvalue123",
    "diff --git a/public.txt b/public.txt",
    "index e69de29..0cfbf08 100644",
    "--- a/public.txt",
    "+++ b/public.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n");
  // isIgnored matches the DECODED real path, exactly as the privacy ignore list does.
  const filtered = filterIgnoredDiff(diff, (p) => p === "secret café.env");

  assert.doesNotMatch(filtered, /supersecretvalue123/, "the ignored file's secret must be dropped, not leaked");
  assert.doesNotMatch(filtered, /secret caf/, "the ignored file's section is dropped entirely");
  assert.match(filtered, /public\.txt/, "the non-ignored file is still kept");
  assert.match(filtered, /\+new/, "the non-ignored file's diff body survives");
});

test("review-surfaces.PRIVACY.6 filterIgnoredDiff fails closed on an ignored path containing ' b/'", () => {
  // A real path can itself contain the substring " b/", e.g. "logs b/app.env".
  // Git's unquoted header `diff --git a/logs b/app.env b/logs b/app.env` is then
  // ambiguous to a first/last separator split; the UNAMBIGUOUS `--- a/`/`+++ b/`
  // body lines carry the full path, so the ignored file is still dropped.
  const diff = [
    "diff --git a/logs b/app.env b/logs b/app.env",
    "--- a/logs b/app.env",
    "+++ b/logs b/app.env",
    "@@ -0,0 +1 @@",
    "+API_TOKEN=leakythroughspacepath123",
    "diff --git a/keep.ts b/keep.ts",
    "--- a/keep.ts",
    "+++ b/keep.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b"
  ].join("\n");
  const filtered = filterIgnoredDiff(diff, (p) => p === "logs b/app.env");
  assert.doesNotMatch(filtered, /leakythroughspacepath123/, "the ignored ' b/'-containing file must be dropped, not leaked");
  assert.match(filtered, /keep\.ts/, "the non-ignored file is still kept");
});

test("review-surfaces.PRIVACY.6 filterIgnoredDiff keeps a normal non-ignored file and drops an ignored one", () => {
  const diff = [
    "diff --git a/keep.ts b/keep.ts",
    "--- a/keep.ts",
    "+++ b/keep.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/.env.local b/.env.local",
    "--- a/.env.local",
    "+++ b/.env.local",
    "@@ -0,0 +1 @@",
    "+TOKEN=keepmesecret999"
  ].join("\n");
  const filtered = filterIgnoredDiff(diff, (p) => p === ".env.local");
  assert.match(filtered, /keep\.ts/);
  assert.doesNotMatch(filtered, /keepmesecret999/);
});

test("review-surfaces.PRIVACY.6 filterIgnoredDiff fails closed on a quoted header with an embedded quote", () => {
  // Git quotes a name containing a double quote as `"a/foo\"bar.env"`; the header
  // parser can stop at the escaped quote, but the decoded `+++ b/` body line
  // recovers the real path, so the ignored file is still dropped (not leaked).
  const diff = [
    'diff --git "a/foo\\"bar.env" "b/foo\\"bar.env"',
    "new file mode 100644",
    "--- /dev/null",
    '+++ "b/foo\\"bar.env"',
    "@@ -0,0 +1 @@",
    "+API_TOKEN=quoteinpathleak456"
  ].join("\n");
  const filtered = filterIgnoredDiff(diff, (p) => p === 'foo"bar.env');
  assert.doesNotMatch(filtered, /quoteinpathleak456/, "an ignored file whose name contains a quote must be dropped");
});

test("review-surfaces.PRIVACY.6 filterIgnoredDiff fails closed on a quoted header with no body path", () => {
  // A quoted-name binary section has no `---`/`+++` paths to decode, so the
  // header alone cannot be trusted — drop it rather than risk a leak.
  const diff = [
    'diff --git "a/sec\\303\\251t.env" "b/sec\\303\\251t.env"',
    'Binary files "a/sec\\303\\251t.env" and "b/sec\\303\\251t.env" differ'
  ].join("\n");
  const filtered = filterIgnoredDiff(diff, () => false);
  assert.equal(filtered, "", "an unreadable quoted-binary section fails closed");
});

test("review-surfaces.PRIVACY.6 filterIgnoredDiff does not drop a real file whose hunk content looks like a path line", () => {
  // Only the section HEADER (before the first @@) carries path metadata. A
  // non-ignored file that ADDS a line of text reading "++ b/.env.local" renders
  // as "+++ b/.env.local" in the body; that must NOT be parsed as a path and drop
  // the real file (the round-1 fix walked every line and over-dropped).
  const diff = [
    "diff --git a/keep.md b/keep.md",
    "--- a/keep.md",
    "+++ b/keep.md",
    "@@ -1,2 +1,4 @@",
    " # docs",
    "+example diff line: +++ b/.env.local",
    "+another example: --- a/.env.local",
    " end"
  ].join("\n");
  const filtered = filterIgnoredDiff(diff, (p) => p === ".env.local");
  assert.match(filtered, /keep\.md/, "the real non-ignored file must NOT be dropped by path-like hunk content");
  assert.match(filtered, /example diff line/, "the hunk body survives");
});

test("review-surfaces.PRIVACY.6 filterIgnoredDiff drops an ignored quoted-name pure rename", () => {
  // A pure rename of a quoted-name ignored file has `rename from`/`rename to`
  // lines and no ---/+++ paths; the quoted operands must be decoded to match.
  const diff = [
    'diff --git "a/old\\"name.env" "b/new\\"name.env"',
    "similarity index 100%",
    'rename from "old\\"name.env"',
    'rename to "new\\"name.env"'
  ].join("\n");
  const filtered = filterIgnoredDiff(diff, (p) => p === 'new"name.env' || p === 'old"name.env');
  assert.equal(filtered, "", "the ignored quoted-name rename section must be dropped");
});
