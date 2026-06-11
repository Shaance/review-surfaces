import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config/config";
import { parseAcaiSpec } from "../src/acai/acai";
import { validateJsonFile } from "../src/schema/json-schema";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");
const SOURCE_SCHEMA = path.join(process.cwd(), "schemas", "review_packet.schema.json");

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeRepo(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  spawnSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "fixture@example.com"], { cwd: tmp, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Fixture"], { cwd: tmp, stdio: "ignore" });
  return tmp;
}

function findFeatureSpec(repo: string): string {
  const featuresDir = path.join(repo, "features");
  const entries = fs.readdirSync(featuresDir).filter((name) => name.endsWith(".feature.yaml"));
  assert.ok(entries.length >= 1, "expected at least one feature spec");
  return path.join("features", entries[0]);
}

test("review-surfaces.BOOTSTRAP.5 init scaffolds every target into a fresh repo", async () => {
  const repo = makeRepo("review-surfaces-init-fresh-");
  const result = runCli(repo, ["init"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /review-surfaces init/);

  // (1) config exists and loads.
  const configPath = path.join(repo, "review-surfaces.config.yaml");
  assert.ok(fs.existsSync(configPath));
  const config = await loadConfig(repo, "review-surfaces.config.yaml");
  assert.equal(config.schema_version, "review-surfaces.config.v1");
  assert.equal(config.output_dir, ".review-surfaces");
  // Phase 1 derived clustering: no injected areas block.
  assert.equal(config.areas, undefined);
  const configText = fs.readFileSync(configPath, "utf8");
  assert.doesNotMatch(configText, /^areas:/m);

  // (2) schema is the real packet schema this tool uses (byte-identical).
  const schemaPath = path.join(repo, "schemas", "review_packet.schema.json");
  assert.ok(fs.existsSync(schemaPath));
  assert.equal(fs.readFileSync(schemaPath, "utf8"), fs.readFileSync(SOURCE_SCHEMA, "utf8"));

  // (3) ignore file carries the default privacy patterns.
  const ignoreText = fs.readFileSync(path.join(repo, ".review-surfacesignore"), "utf8");
  assert.match(ignoreText, /^\.env$/m);
  assert.match(ignoreText, /^!\.env\.example$/m);
  assert.match(ignoreText, /^\.claude\/$/m);

  // (4) feature spec parses to at least one ACID.
  const specRel = findFeatureSpec(repo);
  const indexed = await parseAcaiSpec(repo, specRel);
  assert.ok(indexed.requirements.length >= 1);
  // ACIDs must match the EvidenceRef acai_id pattern (lowercase feature segment).
  const acidPattern = /^[a-z0-9_-]+\.[A-Z0-9_]+\.[0-9]+(-[0-9]+)?$/;
  for (const requirement of indexed.requirements) {
    assert.match(requirement.acai_id, acidPattern);
  }

  // (5) usage skill is present and non-empty.
  const skillPath = path.join(repo, ".agents", "skills", "review-surfaces-usage", "SKILL.md");
  assert.ok(fs.existsSync(skillPath));
  assert.match(fs.readFileSync(skillPath, "utf8"), /name: review-surfaces-usage/);

  // (6) AGENTS.md is created and points at the feature spec + local workflow.
  const agentsText = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
  assert.match(agentsText, /local-first human review decision cockpit/);
  assert.doesNotMatch(agentsText, /review packet compiler/);
  assert.match(agentsText, /features\/\*\*\/\*\.feature\.yaml/);
  assert.match(agentsText, /review-surfaces validate/);

  fs.rmSync(repo, { recursive: true, force: true });
});

test("review-surfaces.BOOTSTRAP.5 init is idempotent and never clobbers without --force", () => {
  const repo = makeRepo("review-surfaces-init-idempotent-");
  assert.equal(runCli(repo, ["init"]).status, 0);

  // Capture content of every generated target after the first run.
  const targets = [
    "review-surfaces.config.yaml",
    path.join("schemas", "review_packet.schema.json"),
    ".review-surfacesignore",
    path.join(".agents", "skills", "review-surfaces-usage", "SKILL.md"),
    "AGENTS.md",
    findFeatureSpec(repo)
  ];
  const before = new Map(targets.map((rel) => [rel, fs.readFileSync(path.join(repo, rel), "utf8")]));

  const second = runCli(repo, ["init"]);
  assert.equal(second.status, 0, second.stderr);
  // No created/overwritten lines on the second run.
  assert.doesNotMatch(second.stdout, /\bcreated\b/);
  assert.doesNotMatch(second.stdout, /\boverwritten\b/);
  assert.match(second.stdout, /exists\s+review-surfaces\.config\.yaml/);
  assert.match(second.stdout, /found\s+features\//);

  // Content is byte-for-byte unchanged.
  for (const [rel, original] of before) {
    assert.equal(fs.readFileSync(path.join(repo, rel), "utf8"), original, `content of ${rel} changed`);
  }

  fs.rmSync(repo, { recursive: true, force: true });
});

test("review-surfaces.BOOTSTRAP.5 init preserves user AGENTS.md and feature spec; --force regenerates generated targets", () => {
  const repo = makeRepo("review-surfaces-init-preserve-");
  fs.mkdirSync(path.join(repo, "features"), { recursive: true });
  const ownAgents = "MY OWN AGENTS FILE\n";
  const ownSpec = "feature:\n  name: my-app\ncomponents:\n  CORE:\n    requirements:\n      1: do the thing\n";
  fs.writeFileSync(path.join(repo, "AGENTS.md"), ownAgents);
  fs.writeFileSync(path.join(repo, "features", "my-app.feature.yaml"), ownSpec);

  const first = runCli(repo, ["init"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /exists\s+AGENTS\.md/);
  assert.match(first.stdout, /found\s+features\/my-app\.feature\.yaml/);

  // User-owned files are untouched.
  assert.equal(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), ownAgents);
  assert.equal(fs.readFileSync(path.join(repo, "features", "my-app.feature.yaml"), "utf8"), ownSpec);

  // Capture a generated target before forcing.
  const configPath = path.join(repo, "review-surfaces.config.yaml");
  const configBefore = fs.readFileSync(configPath, "utf8");
  // Mutate it so we can prove --force rewrites it.
  fs.writeFileSync(configPath, "# user tampered\n");

  const forced = runCli(repo, ["init", "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  // --force overwrites the regenerable config back to the canonical content.
  assert.match(forced.stdout, /overwritten\s+review-surfaces\.config\.yaml/);
  assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);

  // --force still must NOT mutate user-owned AGENTS.md or pre-existing specs.
  assert.match(forced.stdout, /exists\s+AGENTS\.md/);
  assert.match(forced.stdout, /found\s+features\/my-app\.feature\.yaml/);
  assert.equal(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), ownAgents);
  assert.equal(fs.readFileSync(path.join(repo, "features", "my-app.feature.yaml"), "utf8"), ownSpec);

  fs.rmSync(repo, { recursive: true, force: true });
});

test("review-surfaces bootstrap validate-only exits 0; --strict exits 10 on missing scaffold", () => {
  const repo = makeRepo("review-surfaces-bootstrap-strict-");

  // Empty repo: validate-only reports missing but exits 0 by default.
  const lenient = runCli(repo, ["bootstrap"]);
  assert.equal(lenient.status, 0, lenient.stderr);
  assert.match(lenient.stdout, /missing\s+review-surfaces\.config\.yaml/);

  // --strict on a missing scaffold fails the quality gate (exit 10).
  const strict = runCli(repo, ["bootstrap", "--strict"]);
  assert.equal(strict.status, 10);
  assert.match(strict.stderr, /quality gate failed/i);

  // After init, both lenient and strict bootstrap pass.
  assert.equal(runCli(repo, ["init"]).status, 0);
  const lenientAfter = runCli(repo, ["bootstrap"]);
  assert.equal(lenientAfter.status, 0, lenientAfter.stderr);
  const strictAfter = runCli(repo, ["bootstrap", "--strict"]);
  assert.equal(strictAfter.status, 0, strictAfter.stderr);
  assert.match(strictAfter.stdout, /exists\s+review-surfaces\.config\.yaml/);

  fs.rmSync(repo, { recursive: true, force: true });
});

test("review-surfaces.QUALITY.3 fresh-repo E2E: init then all then validate against scaffolded schema", async () => {
  const repo = makeRepo("review-surfaces-init-e2e-");

  // 1. Scaffold the repo from scratch.
  assert.equal(runCli(repo, ["init"]).status, 0);

  // 2. Make a real change and commit so the diff range has content.
  fs.writeFileSync(path.join(repo, "app.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "scaffold"], { cwd: repo, stdio: "ignore" });
  fs.appendFileSync(path.join(repo, "app.js"), "\nexport function sub(a, b) {\n  return a - b;\n}\n");

  // 3. Run the full local pipeline with the offline mock provider.
  const all = runCli(repo, [
    "all",
    "--provider",
    "mock",
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--out",
    ".review-surfaces"
  ]);
  assert.equal(all.status, 0, all.stderr);

  // 4. The produced packet exists and validates against the SCAFFOLDED schema.
  const packetPath = path.join(repo, ".review-surfaces", "review_packet.json");
  assert.ok(fs.existsSync(packetPath));
  const validation = await validateJsonFile(
    path.join(repo, "schemas", "review_packet.schema.json"),
    packetPath
  );
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));

  // 5. The CLI validate command also succeeds offline against the scaffold.
  const validate = runCli(repo, ["validate", ".review-surfaces"]);
  assert.equal(validate.status, 0, validate.stderr);
  // review-surfaces.COLD_START.1: the default validate uses the BUNDLED schema
  // (package root), never a CWD-relative lookup.
  assert.match(validate.stdout, /Validated .* against the bundled schemas\/review_packet\.schema\.json/);

  fs.rmSync(repo, { recursive: true, force: true });
});
