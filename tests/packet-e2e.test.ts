import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateJsonFile } from "../src/schema/json-schema";

test("CLI dogfood-style run writes valid packet, diagrams, dogfood, and handoff", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-e2e-"));
  fs.cpSync(process.cwd(), tmp, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.includes(`${path.sep}dist${path.sep}`)
  });
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  execFileSync(
    "node",
    [
      path.join(process.cwd(), "dist", "src", "cli", "index.js"),
      "dogfood",
      "--provider",
      "mock",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--spec",
      "features/review-surfaces.feature.yaml",
      "--out",
      ".review-surfaces"
    ],
    { cwd: tmp, stdio: "ignore" }
  );

  const result = await validateJsonFile(
    path.join(tmp, "schemas", "review_packet.schema.json"),
    path.join(tmp, ".review-surfaces", "review_packet.json")
  );

  assert.equal(result.valid, true);
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "diagrams", "pipeline.mmd")));
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "dogfood.yaml")));
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "agent_handoff.md")));
});

test("CLI uses configured provider when no provider flag is passed", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-config-provider-"));
  fs.cpSync(process.cwd(), tmp, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.includes(`${path.sep}dist${path.sep}`)
  });
  fs.writeFileSync(
    path.join(tmp, "review-surfaces.config.yaml"),
    `schema_version: review-surfaces.config.v1
output_dir: .review-surfaces
specs:
  - features/review-surfaces.feature.yaml
docs:
  - AGENTS.md
tests:
  - tests/**/*.test.ts
llm:
  provider: agent-file
  model: null
`
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  execFileSync(
    "node",
    [
      path.join(process.cwd(), "dist", "src", "cli", "index.js"),
      "dogfood",
      "--base",
      "HEAD",
      "--head",
      "HEAD"
    ],
    { cwd: tmp, stdio: "ignore" }
  );

  const packet = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), "utf8"));
  assert.match(packet.agent_handoff.summary, /provider=agent-file\/skipped/);
});
