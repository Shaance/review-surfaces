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
        && relative !== path.join(".review-surfaces", "commands")
        && !relative.startsWith(`${path.join(".review-surfaces", "commands")}${path.sep}`)
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
    - "pnpm run test:coverage"
    - pnpm run lint
`
  );
  fs.writeFileSync(
    path.join(tmp, ".review-surfaces", "commands", "local.json"),
    JSON.stringify({
      commands: [
        { id: "CMD-E2E-001", command: "pnpm run test", exit_code: 0, stdout: "tests passed" },
        { id: "CMD-E2E-UNKNOWN", command: "pnpm run build", status: "unknown", stdout: "build started" }
      ]
    })
  );
  fs.writeFileSync(
    path.join(tmp, "conversation.md"),
    [
      "assistant: pnpm run test passed before packet generation.",
      "assistant: tests are green without a command reference.",
      "assistant: Decision: keep review-surfaces local-first for M5."
    ].join("\n")
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
      "--conversation",
      "conversation.md",
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
  assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "inputs", "conversation.normalized.jsonl")));

  const packet = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), "utf8"));
  const packetMarkdown = fs.readFileSync(path.join(tmp, ".review-surfaces", "review_packet.md"), "utf8");
  const architectureMarkdown = fs.readFileSync(path.join(tmp, ".review-surfaces", "architecture.md"), "utf8");
  assert.ok(packet.architecture.diagram_validation.every((result: { status: string }) => result.status === "valid"));
  assert.match(architectureMarkdown, /Diagram validation/);
  assert.ok(packet.dogfood.findings.some((finding: { finding: string }) => finding.finding.includes("FB-E2E-001")));
  assert.ok(packet.risks.test_evidence.some((evidence: { kind: string; summary: string }) => evidence.kind === "direct" && evidence.summary.includes("CMD-E2E-001")));
  assert.ok(!packet.risks.test_evidence.some((evidence: { id: string; kind: string; summary: string }) => evidence.id.startsWith("TEST-FB-") && evidence.summary === "Feedback records a passing validation command: pnpm run test"));
  assert.ok(packet.methodology.verified_claims.some((claim: string) => claim.includes("pnpm run test passed")));
  assert.ok(packet.methodology.claims_without_evidence.some((claim: string) => claim.includes("tests are green")));
  assert.ok(packet.risks.review_focus.some((focus: string) => focus.includes("methodology claims without command evidence")));
  assert.ok(packet.agent_handoff.validation_evidence.some((evidence: string) => evidence.includes("CMD-E2E-001")));
  assert.ok(packet.agent_handoff.failed_validation.some((evidence: string) => evidence.includes("[claimed]") && evidence.includes("pnpm run test:coverage")));
  assert.ok(packet.agent_handoff.failed_validation.some((evidence: string) => evidence.includes("[indirect]") && evidence.includes("pnpm run lint")));
  assert.ok(packet.agent_handoff.failed_validation.some((evidence: string) => evidence.includes("[unknown]") && evidence.includes("CMD-E2E-UNKNOWN")));
  assert.ok(!packet.agent_handoff.validation_evidence.some((evidence: string) => evidence.includes("pnpm run lint")));
  assert.ok(!packet.agent_handoff.failed_validation.some((evidence: string) => evidence.includes("review-surfaces dogfood") || evidence.includes("review-surfaces all")));
  assert.ok(packet.agent_handoff.methodology_flags.includes("claims_without_evidence"));
  assert.match(packetMarkdown, /Validation evidence:/);
  assert.match(packetMarkdown, /Claims needing evidence:/);
});

test("review-surfaces.CLI.6 dogfood --previous-packet writes a comparison and stays schema-valid", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-prev-packet-"));
  copyRepoFixture(tmp);
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

  const cli = path.join(process.cwd(), "dist", "src", "cli", "index.js");
  const baseArgs = [
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
  ];

  // First run produces a packet we will later compare against.
  execFileSync("node", [cli, ...baseArgs], { cwd: tmp, stdio: "ignore" });
  const previousDir = path.join(tmp, ".review-surfaces-prev");
  fs.cpSync(path.join(tmp, ".review-surfaces"), previousDir, { recursive: true });

  // Second run compares against the directory holding the previous packet.
  execFileSync("node", [cli, ...baseArgs, "--previous-packet", ".review-surfaces-prev"], { cwd: tmp, stdio: "ignore" });

  const result = await validateJsonFile(
    path.join(tmp, "schemas", "review_packet.schema.json"),
    path.join(tmp, ".review-surfaces", "review_packet.json")
  );
  assert.equal(result.valid, true, JSON.stringify(result.issues));

  const packet = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), "utf8"));
  assert.equal(packet.dogfood.previous_packet_path, path.join(".review-surfaces-prev", "review_packet.json"));
  assert.ok(packet.dogfood.comparison, "comparison should be present");
  assert.ok(Array.isArray(packet.dogfood.comparison.status_changes));
  assert.ok(packet.dogfood.comparison.count_deltas);

  const handoff = fs.readFileSync(path.join(tmp, ".review-surfaces", "agent_handoff.md"), "utf8");
  assert.match(handoff, /## Changes Since Last Packet/);
  assert.match(handoff, /Compared against/);

  // Absent --previous-packet target is a clean no-op: no comparison, still valid.
  execFileSync("node", [cli, ...baseArgs, "--previous-packet", ".does-not-exist"], { cwd: tmp, stdio: "ignore" });
  const noopPacket = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), "utf8"));
  assert.equal(noopPacket.dogfood.comparison, undefined);
  assert.equal(noopPacket.dogfood.previous_packet_path, path.join(".does-not-exist", "review_packet.json"));
  const noopResult = await validateJsonFile(
    path.join(tmp, "schemas", "review_packet.schema.json"),
    path.join(tmp, ".review-surfaces", "review_packet.json")
  );
  assert.equal(noopResult.valid, true, JSON.stringify(noopResult.issues));
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
