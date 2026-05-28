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
  assert.match(diff, /\[REDACTED:secret\]/);
  assert.ok(privacy.diff_redactions.length > 0);
});

test("review-surfaces.PRIVACY.3 supports gitignore-style negation for tracked examples", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-ignore-negation-"));
  fs.writeFileSync(path.join(tmp, ".review-surfacesignore"), ".env.*\n!.env.example\n");
  const ignore = await loadPrivacyIgnore(tmp, ".review-surfacesignore");

  assert.equal(ignore.isIgnored(".env.local"), true);
  assert.equal(ignore.isIgnored(".env.example"), false);
});

test("review-surfaces.PRIVACY.2 blocks high-risk private key material for remote prompts", () => {
  const pemLabel = "PRIVATE KEY";
  const result = redactSecrets(`PRIVATE_KEY=-----BEGIN ${pemLabel}-----\nabc\n-----END ${pemLabel}-----`);

  assert.equal(result.blocked, true);
  assert.doesNotMatch(result.text, /BEGIN PRIVATE KEY/);
});
