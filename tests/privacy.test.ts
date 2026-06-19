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
import { filterIgnoredDiff } from "../src/privacy/diff";

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

test("review-surfaces.PRIVACY.8 default ignore drops every Apple signing artifact + build cache the classifier marks private", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-ignore-apple-"));
  const ignore = await loadPrivacyIgnore(tmp, ".review-surfacesignore");

  // Signing/provisioning material: the default list must cover the same extensions
  // src/collector/source-kind.ts treats as signing artifacts, so nothing it marks
  // private is persisted in changed_files / diff.patch.
  for (const p of [
    "App/App.mobileprovision",
    "Dev.provisionprofile",
    "secrets/cert.p12",
    "secrets/AuthKey_ABC123.p8",
    "ci.cer",
    "MyCert.certSigningRequest",
    "login.keychain",
    "ci.keychain-db"
  ]) {
    assert.equal(ignore.isIgnored(p), true, `${p} should be ignored by default`);
  }
  // Apple-specific build/package caches join DerivedData/.build as never-persisted
  // generated state.
  for (const p of [
    ".swiftpm/configuration/registries.json",
    "DerivedData/App/Build/x.o",
    ".build/release/App"
  ]) {
    assert.equal(ignore.isIgnored(p), true, `${p} should be ignored by default`);
  }
  // The cache DIRECTORY path itself is ignored too, so the file walk skips it
  // instead of descending and ignoring each child afterward.
  for (const dir of [".swiftpm", "DerivedData", ".build", "App.xcodeproj/project.xcworkspace/xcuserdata"]) {
    assert.equal(ignore.isIgnored(dir), true, `${dir} directory path should be ignored for walk-skip`);
  }
  // `SourcePackages/` is NOT privacy-dropped — the name is too generic to drop
  // unconditionally without breaking "inert on non-Swift repos". It only ranks as
  // generated; Xcode's managed copy lives under the dropped DerivedData.
  assert.equal(ignore.isIgnored("SourcePackages/checkouts/Dep/Sources/Dep.swift"), false);
  // Case-insensitive at the boundary: the classifier lowercases basenames, so an
  // uppercase-extension signing file must be dropped too on a case-sensitive checkout.
  for (const p of ["CI.CER", "secrets/Cert.P12", "Foo.CERTSIGNINGREQUEST", "Login.KeyChain"]) {
    assert.equal(ignore.isIgnored(p), true, `${p} should be ignored case-insensitively`);
  }
  // Reviewable project/config TEXT stays available to detectors (not privacy-dropped).
  assert.equal(ignore.isIgnored("App/Info.plist"), false);
  assert.equal(ignore.isIgnored("App/App.entitlements"), false);
});

test("review-surfaces.PRIVACY.8 case-insensitive DROP rules never reopen a case-variant secret via a negated allowlist", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-ignore-negation-case-"));
  const ignore = await loadPrivacyIgnore(tmp, ".review-surfacesignore");
  // The exact allowlisted example is re-included...
  assert.equal(ignore.isIgnored(".env.example"), false);
  // ...but a case-variant must stay IGNORED: the negation is case-sensitive so it
  // cannot reopen `.env.EXAMPLE`, which the case-insensitive `.env.*` drop still catches.
  assert.equal(ignore.isIgnored(".env.EXAMPLE"), true);
  assert.equal(ignore.isIgnored(".env.Local"), true);
});

test("review-surfaces.PRIVACY.8 case-folding applies to the Apple defaults only — user ignore rules stay case-sensitive", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-ignore-userscope-"));
  fs.writeFileSync(path.join(tmp, ".review-surfacesignore"), "docs/generated/**\n");
  const ignore = await loadPrivacyIgnore(tmp, ".review-surfacesignore");
  // The user rule keeps gitignore-standard case-sensitivity: the exact case drops...
  assert.equal(ignore.isIgnored("docs/generated/api.md"), true);
  // ...but a case-variant is NOT dropped (reviewable files don't silently vanish).
  assert.equal(ignore.isIgnored("Docs/Generated/api.md"), false);
  // The built-in Apple signing default still case-folds.
  assert.equal(ignore.isIgnored("CI.CER"), true);
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
  { name: "JWT", secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", kind: "jwt" },
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

test("review-surfaces.PRIVACY.8 redacts a service plist API key + blocks remote, excludes signing/DerivedData artifacts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-ios-privacy-"));
  fs.mkdirSync(path.join(tmp, "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "App"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "DerivedData", "App"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "features", "example.feature.yaml"),
    `feature:
  name: example
components:
  PRIVACY:
    requirements:
      8: Apple signing/user-state artifacts must be excluded while service plist text is redacted before persist.
`
  );
  fs.writeFileSync(path.join(tmp, "App", "placeholder.swift"), "let x = 1\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], {
    cwd: tmp,
    stdio: "ignore"
  });

  // A reviewable service plist carrying an API key: STAYS collected but is redacted.
  fs.writeFileSync(
    path.join(tmp, "App", "GoogleService-Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      "  <key>API_KEY</key>",
      "  <string>AIzaSyFakeSecretForTestingOnly000000</string>",
      "</dict></plist>",
      ""
    ].join("\n")
  );
  // Signing material + build cache: excluded by default before any persist.
  fs.writeFileSync(path.join(tmp, "App", "App.mobileprovision"), "binary-ish provisioning blob SECRETPROVISION\n");
  fs.writeFileSync(path.join(tmp, "DerivedData", "App", "build.log"), "absolute-cache-output SECRETDERIVED\n");
  // Commit the additions so they appear in the base..head diff (untracked files
  // are not shown by `git diff`); the ignore filter still drops the signing/cache
  // sections before persist.
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "add ios artifacts"], {
    cwd: tmp,
    stdio: "ignore"
  });

  const result = await collectInputs({
    cwd: tmp,
    config: { ...defaultConfig, specs: ["features/**/*.feature.yaml"], docs: [], tests: [], output_dir: ".review-surfaces" },
    baseRef: "HEAD~1",
    headRef: "HEAD",
    dogfood: false
  });

  const diff = fs.readFileSync(path.join(tmp, ".review-surfaces", "inputs", "diff.patch"), "utf8");
  // The service plist API key is redacted in the persisted diff and raises the block.
  assert.doesNotMatch(diff, /AIzaSyFakeSecretForTestingOnly/);
  assert.match(diff, /\[REDACTED:google_api_key\]/);
  assert.equal(result.privacy.remote_provider_blocked, true, "a blocked secret in a service plist must set the remote block");
  // The service plist itself stays reviewable (collected, classified config).
  assert.ok(result.changedFiles.some((file) => file.path === "App/GoogleService-Info.plist"));

  // Signing material and DerivedData are excluded BEFORE persist — never in the diff.
  assert.doesNotMatch(diff, /SECRETPROVISION/);
  assert.doesNotMatch(diff, /SECRETDERIVED/);
  assert.ok(!result.changedFiles.some((file) => file.path === "App/App.mobileprovision"));
  assert.ok(!result.changedFiles.some((file) => file.path.startsWith("DerivedData/")));
  assert.ok(result.privacy.ignored_changed_files.includes("App/App.mobileprovision"));
});
