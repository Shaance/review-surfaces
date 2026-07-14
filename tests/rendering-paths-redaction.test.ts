import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReviewPacket, PacketInputs, rewriteReviewPacket, ReviewPacket, writeReviewPacket } from "../src/render/packet";
import { initGitRepo, runCli } from "./helpers/cli-repo";

function readArtifact(cwd: string, file: string): string {
  return fs.readFileSync(path.join(cwd, ".review-surfaces", file), "utf8");
}

// ---------------------------------------------------------------------------
// review-surfaces.COLD_START.8: the review_packet.md footer ("Full
// machine-readable details: ...") points at the SIBLING file name
// `review_packet.json` (location-independent), regardless of --out /
// output_dir. The markdown lives next to the JSON it points at, so the footer
// never carries a directory prefix.
// ---------------------------------------------------------------------------

function packetInputs(cwd: string, outputDir: string): PacketInputs {
  return {
    collection: {
      cwd,
      outputDir,
      manifest: { milestone: "M7" },
      changedFiles: []
    },
    intent: {
      summary: "round7 fixture",
      requirements: [],
      constraints: [],
      non_goals: [],
      assumptions: [],
      open_questions: [],
      sources: []
    },
    evaluation: {
      summary: "round7 fixture",
      results: [],
      overreach: [],
      acai_coverage: {}
    },
    architecture: {
      summary: "round7 fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "round7 fixture",
      missing_logs: false,
      considered: [],
      research: [],
      decisions: [],
      unchallenged_assumptions: [],
      skipped_checks: [],
      claims_without_evidence: [],
      verified_claims: [],
      workflow_findings: [],
      quality_flags: [],
      evidence: []
    },
    risks: {
      summary: "round7 fixture",
      items: [],
      test_gaps: [],
      review_focus: [],
      test_evidence: []
    },
    enrichment: {
      provider: "mock",
      status: "skipped"
    },
    commands: []
  } as unknown as PacketInputs;
}

test("review-surfaces.COLD_START.8: the review_packet.md footer is the sibling file name for a custom output_dir", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-round7-footer-"));
  try {
    // The artifacts are written into a custom output dir nested under cwd; the
    // markdown footer must reference the SIBLING review_packet.json, with no
    // directory prefix at all.
    const outputDir = path.join(tmp, "build", "review");
    fs.mkdirSync(outputDir, { recursive: true });
    const inputs = packetInputs(tmp, outputDir);

    const packet = await writeReviewPacket(inputs);
    const markdown = fs.readFileSync(path.join(outputDir, "review_packet.md"), "utf8");

    assert.match(
      markdown,
      /Full machine-readable details: review_packet\.json/,
      `footer must point at the sibling review_packet.json, got:\n${markdown.split("\n").find((line) => line.includes("Full machine-readable")) ?? "(no footer line)"}`
    );
    assert.doesNotMatch(
      markdown,
      /Full machine-readable details: \S*\/review_packet\.json/,
      "footer must not carry a directory prefix"
    );
    // The packet object itself is unchanged shape-wise (sanity).
    assert.equal(packet.schema_version, "review-surfaces.packet.v1");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.8: the default .review-surfaces output uses the same sibling footer", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-round7-footer-default-"));
  try {
    const outputDir = path.join(tmp, ".review-surfaces");
    fs.mkdirSync(outputDir, { recursive: true });
    await writeReviewPacket(packetInputs(tmp, outputDir));
    const markdown = fs.readFileSync(path.join(outputDir, "review_packet.md"), "utf8");
    assert.match(markdown, /Full machine-readable details: review_packet\.json/);
    assert.doesNotMatch(markdown, /Full machine-readable details: \S*\/review_packet\.json/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.COLD_START.8: rewriteReviewPacket (no collection context) uses the sibling footer", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-round7-footer-rewrite-"));
  try {
    const packet = createReviewPacket(packetInputs(tmp, path.join(tmp, "build", "review")));
    await rewriteReviewPacket(tmp, packet);
    const markdown = fs.readFileSync(path.join(tmp, "review_packet.md"), "utf8");
    assert.match(markdown, /Full machine-readable details: review_packet\.json/);
    assert.doesNotMatch(markdown, /Full machine-readable details: \S*\/review_packet\.json/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING B: the standalone `methodology` stage must run the same packet-level
// enrichPacket `all`/`packet` run, so `methodology --provider agent-file`
// surfaces the agent methodology_decisions in methodology.yaml. The stage used
// to write buildEnrichedModels output directly and silently dropped them,
// breaking composed-stage parity with all/packet (same class as the round-4
// risks-stage fix). Mock stays a no-op.
// ---------------------------------------------------------------------------

function setupMethodologyRepo(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "thing.ts"), "export const thing = 1;\n");
  fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
  // The agent-file enrichment carries methodology_decisions (the packet-level
  // enrichPacket path), which the standalone methodology stage previously dropped.
  fs.writeFileSync(
    path.join(tmp, "agent-input.json"),
    JSON.stringify(
      {
        methodology_decisions: ["Chose an incremental milestone-by-milestone rollout."],
        risk_summaries: ["A possible unhandled error path in src/thing.ts."]
      },
      null,
      2
    )
  );
  initGitRepo(tmp);
  return tmp;
}

test("FINDING B: `methodology --provider agent-file` surfaces agent methodology_decisions", () => {
  const tmp = setupMethodologyRepo("review-surfaces-round7-methodology-");
  try {
    const run = runCli(tmp, ["methodology", "--base", "HEAD", "--head", "HEAD", "--provider", "agent-file", "--agent-input", "agent-input.json"]);
    assert.equal(run.status, 0, run.stderr);

    const methodology = readArtifact(tmp, "methodology.yaml");
    assert.match(
      methodology,
      /Chose an incremental milestone-by-milestone rollout\./,
      "the agent methodology_decision must be surfaced in methodology.yaml (enrichPacket parity with all/packet)"
    );

    // PER-STAGE ISOLATION: the methodology stage must not leak any other stage's
    // owned artifacts (mirrors the round-4 risks-stage isolation guard).
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "diagrams")),
      false,
      "the methodology stage must NOT leak a diagrams/ directory it does not own"
    );
    for (const leaked of ["evaluation.yaml", "risks.yaml", "intent.yaml", "architecture.md", "review_packet.json"]) {
      assert.equal(
        fs.existsSync(path.join(tmp, ".review-surfaces", leaked)),
        false,
        `methodology must not leak ${leaked}`
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING B (parity): standalone `methodology --provider agent-file` matches `all` for methodology_decisions", () => {
  const allRepo = setupMethodologyRepo("review-surfaces-round7-methodology-all-");
  const stageRepo = setupMethodologyRepo("review-surfaces-round7-methodology-stage-");
  try {
    assert.equal(
      runCli(allRepo, ["all", "--base", "HEAD", "--head", "HEAD", "--provider", "agent-file", "--agent-input", "agent-input.json"]).status,
      0
    );
    assert.equal(
      runCli(stageRepo, ["methodology", "--base", "HEAD", "--head", "HEAD", "--provider", "agent-file", "--agent-input", "agent-input.json"]).status,
      0
    );
    // The composed-stage methodology.yaml must carry the SAME agent decision the
    // monolith `all` lands on methodology.
    const fromAll = readArtifact(allRepo, "methodology.yaml");
    const fromStage = readArtifact(stageRepo, "methodology.yaml");
    assert.match(fromAll, /Chose an incremental milestone-by-milestone rollout\./);
    assert.equal(fromStage, fromAll, "methodology.yaml from the standalone stage must equal the `all` artifact");
  } finally {
    fs.rmSync(allRepo, { recursive: true, force: true });
    fs.rmSync(stageRepo, { recursive: true, force: true });
  }
});

test("FINDING B (mock no-op): `methodology --provider mock` writes only methodology.yaml", () => {
  const tmp = setupMethodologyRepo("review-surfaces-round7-methodology-mock-");
  try {
    const run = runCli(tmp, ["methodology", "--base", "HEAD", "--head", "HEAD", "--provider", "mock"]);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fs.existsSync(path.join(tmp, ".review-surfaces", "methodology.yaml")), "methodology.yaml must exist");
    // mock enrichPacket is not_requested (no-op): no diagrams/ leak, no other artifacts.
    assert.equal(fs.existsSync(path.join(tmp, ".review-surfaces", "diagrams")), false, "mock must not leak diagrams/");
    for (const leaked of ["evaluation.yaml", "risks.yaml", "intent.yaml", "architecture.md", "review_packet.json"]) {
      assert.equal(fs.existsSync(path.join(tmp, ".review-surfaces", leaked)), false, `methodology must not leak ${leaked}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
