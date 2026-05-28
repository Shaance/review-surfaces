import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateJsonFile } from "../src/schema/json-schema";

function copyRepoFixture(targetDir: string): void {
  fs.cpSync(process.cwd(), targetDir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(process.cwd(), source);
      return relative !== ".git"
        && !relative.startsWith(`.git${path.sep}`)
        && relative !== "dist"
        && !relative.startsWith(`dist${path.sep}`);
    }
  });
}

test("CLI dogfood-style run writes valid packet, diagrams, dogfood, and handoff", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-e2e-"));
  copyRepoFixture(tmp);
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "feedback"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".review-surfaces", "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "feedback", "e2e.yaml"),
    `schema_version: review-surfaces.feedback.v1
author: codex-test
packet_path: .review-surfaces/review_packet.json
findings:
  - id: FB-E2E-001
    category: evidence_quality
    severity: high
    affected_section: risks.test_evidence
    finding: review-surfaces.RISK.2 needs locally recorded validation evidence.
    desired_change: Render feedback validation commands in review_packet.md.
validation:
  passed:
    - pnpm run test
`
  );
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "commands", "local.json"),
    JSON.stringify({
      commands: [{ id: "CMD-E2E-001", command: "pnpm run test", exit_code: 0, stdout: "tests passed" }]
    })
  );
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
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "inputs", "commands.json")));

  const packet = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), "utf8"));
  const packetMarkdown = fs.readFileSync(path.join(tmp, ".review-surfaces", "review_packet.md"), "utf8");
  assert.ok(packet.dogfood.findings.some((finding: { finding: string }) => finding.finding.includes("FB-E2E-001")));
  assert.ok(packet.risks.test_evidence.some((evidence: { kind: string; summary: string }) => evidence.kind === "direct" && evidence.summary.includes("CMD-E2E-001")));
  assert.ok(!packet.risks.test_evidence.some((evidence: { id: string; kind: string; summary: string }) => evidence.id.startsWith("TEST-FB-") && evidence.summary.includes("pnpm run test")));
  assert.match(packetMarkdown, /Validation evidence:/);
});

test("CLI uses configured provider when no provider flag is passed", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-config-provider-"));
  copyRepoFixture(tmp);
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
