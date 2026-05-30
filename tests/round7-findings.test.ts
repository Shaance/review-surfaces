import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createReviewPacket, PacketInputs, rewriteReviewPacket, ReviewPacket, writeReviewPacket } from "../src/render/packet";
import { renderComment } from "../src/render/comment";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");

function initGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd, stdio: "ignore" });
}

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args, "--out", ".review-surfaces"], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readArtifact(cwd: string, file: string): string {
  return fs.readFileSync(path.join(cwd, ".review-surfaces", file), "utf8");
}

// ---------------------------------------------------------------------------
// FINDING A: the review_packet.md footer ("Full machine-readable details: ...")
// hardcoded `.review-surfaces/review_packet.json`. For a run using
// `--out`/`output_dir` other than .review-surfaces the markdown is written into
// that dir but the footer still pointed at a stale/non-existent
// .review-surfaces path. The footer must use the EFFECTIVE (cwd-relative) output
// dir, the same helper the handoff/comment paths use. The default
// `.review-surfaces` output stays byte-identical.
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

test("FINDING A: a custom output_dir is reflected in the review_packet.md footer", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-round7-footer-"));
  try {
    // The artifacts are written into a custom output dir nested under cwd; the
    // markdown footer must reference THAT dir, not .review-surfaces.
    const outputDir = path.join(tmp, "build", "review");
    fs.mkdirSync(outputDir, { recursive: true });
    const inputs = packetInputs(tmp, outputDir);

    // writeReviewPacket is the `all`/`packet` writer path: it threads the
    // effective output dir into the footer. (rewriteReviewPacket has no
    // collection context and keeps the default .review-surfaces footer.)
    const packet = await writeReviewPacket(inputs);
    const markdown = fs.readFileSync(path.join(outputDir, "review_packet.md"), "utf8");

    assert.match(
      markdown,
      /Full machine-readable details: build\/review\/review_packet\.json/,
      `footer must point at the custom output dir, got:\n${markdown.split("\n").find((line) => line.includes("Full machine-readable")) ?? "(no footer line)"}`
    );
    assert.doesNotMatch(
      markdown,
      /Full machine-readable details: \.review-surfaces\/review_packet\.json/,
      "footer must not still hardcode .review-surfaces"
    );
    // The packet object itself is unchanged shape-wise (sanity).
    assert.equal(packet.schema_version, "review-surfaces.packet.v1");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING A: the default .review-surfaces output keeps a byte-identical footer", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-round7-footer-default-"));
  try {
    const outputDir = path.join(tmp, ".review-surfaces");
    fs.mkdirSync(outputDir, { recursive: true });
    await writeReviewPacket(packetInputs(tmp, outputDir));
    const markdown = fs.readFileSync(path.join(outputDir, "review_packet.md"), "utf8");
    assert.match(markdown, /Full machine-readable details: \.review-surfaces\/review_packet\.json/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING A: rewriteReviewPacket (no collection context) keeps the default footer", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-round7-footer-rewrite-"));
  try {
    const packet = createReviewPacket(packetInputs(tmp, path.join(tmp, "build", "review")));
    // rewriteReviewPacket has no collection, so it intentionally keeps the
    // default .review-surfaces footer (byte-identical to prior behavior).
    await rewriteReviewPacket(tmp, packet);
    const markdown = fs.readFileSync(path.join(tmp, "review_packet.md"), "utf8");
    assert.match(markdown, /Full machine-readable details: \.review-surfaces\/review_packet\.json/);
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

// ---------------------------------------------------------------------------
// FINDING C (SECRET LEAK): the comment renderer truncated/collapsed each
// interpolated free-text field to the display cap BEFORE redacting secrets. The
// private-key redactor needs the WHOLE -----BEGIN ... PRIVATE KEY----- ...
// -----END ... PRIVATE KEY----- block; a truncated block is NOT matched, so the
// first ~300 chars of the key could leak into comment.md and the posted PR
// comment. The fix redacts the FULL field FIRST, then truncates. Verify a full
// multi-line private key block is fully redacted in every free-text surface.
// ---------------------------------------------------------------------------

// A realistic, long multi-line BEGIN/END private key block. The first 300 chars
// (the display cap) must NOT survive into the rendered comment.
function fakePrivateKeyBlock(): string {
  const body = Array.from({ length: 20 }, (_unused, index) => `KEYLINE${index}aB3xQ9zPmL7wKvN2tR5yUcDfGhJkMnPqRsTuVwXyZ0123456789abcdefghij`).join("\n");
  return `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
}

function minimalPacketWithSecret(secret: string, field: "review_focus" | "risk" | "requirement" | "result"): ReviewPacket {
  const packet = {
    schema_version: "review-surfaces.packet.v1",
    manifest: { milestone: "M7" },
    intent: { summary: "round7", requirements: [] },
    evaluation: { summary: "round7", results: [], overreach: [] },
    architecture: { summary: "round7", diagrams: [], diagram_validation: [], subsystems: [] },
    methodology: { summary: "round7", missing_logs: false, decisions: [] },
    risks: {
      summary: "round7",
      items: [],
      test_evidence: [],
      test_gaps: [],
      missing_automatic_tests: [],
      missing_manual_checks: [],
      review_focus: []
    }
  } as unknown as ReviewPacket;

  if (field === "review_focus") {
    packet.risks.review_focus = [`Inspect this credential leak: ${secret}`];
  } else if (field === "risk") {
    (packet.risks.items as unknown[]).push({
      id: "RISK-LEAK",
      category: "security",
      severity: "high",
      summary: `A handler logs a credential: ${secret}`,
      evidence: [{ kind: "code", path: "src/x.ts", confidence: "high" }]
    });
  } else if (field === "requirement") {
    (packet.intent.requirements as unknown[]).push({
      id: "REQ-LEAK",
      requirement: `The service must store: ${secret}`,
      llm_derived: true
    });
  } else {
    (packet.evaluation.results as unknown[]).push({
      requirement_id: "REQ-LEAK",
      acai_id: "review-surfaces.PRIVACY.2",
      status: "missing",
      summary: `Missing handling for: ${secret}`,
      evidence: []
    });
  }
  return packet;
}

test("FINDING C: a full multi-line private key in a comment review_focus field is fully redacted (no raw key bytes, including the first 300 chars)", () => {
  const secret = fakePrivateKeyBlock();
  const comment = renderComment(minimalPacketWithSecret(secret, "review_focus"));

  // The block secret is replaced wholesale.
  assert.match(comment, /\[REDACTED:private_key\]/, "the private key block must be redacted");
  // No raw key bytes survive -- crucially NOT the first 300 chars the display cap
  // would otherwise have kept before redaction.
  assert.doesNotMatch(comment, /BEGIN RSA PRIVATE KEY/, "the BEGIN marker must not leak");
  assert.doesNotMatch(comment, /KEYLINE0/, "the first key line (within the first 300 chars) must not leak");
  assert.ok(!comment.includes(secret.slice(0, 300)), "the first 300 chars of the key must not survive truncation-before-redaction");
});

test("FINDING C: a full multi-line private key leaks in NO comment free-text surface (risk, requirement, result)", () => {
  const secret = fakePrivateKeyBlock();
  const first300 = secret.slice(0, 300);
  for (const field of ["risk", "requirement", "result"] as const) {
    const comment = renderComment(minimalPacketWithSecret(secret, field));
    assert.match(comment, /\[REDACTED:private_key\]/, `the private key must be redacted in the ${field} field`);
    assert.doesNotMatch(comment, /BEGIN RSA PRIVATE KEY/, `the BEGIN marker must not leak via the ${field} field`);
    assert.doesNotMatch(comment, /KEYLINE0/, `the first key line must not leak via the ${field} field`);
    assert.ok(!comment.includes(first300), `the first 300 chars must not survive via the ${field} field`);
  }
});

test("FINDING C: redaction-then-truncation still bounds an oversized field after a secret is replaced", () => {
  // A field that is a private key block followed by a huge tail: after the block
  // is redacted the remaining tail must still be truncated so the per-line bound
  // holds (redact-first does not disable the display cap).
  const secret = fakePrivateKeyBlock();
  const tail = "T".repeat(5000);
  const packet = minimalPacketWithSecret(`${secret} ${tail}`, "review_focus");
  const comment = renderComment(packet);
  assert.match(comment, /\[REDACTED:private_key\]/);
  // No single rendered line is unbounded despite the 5k tail.
  const longestLine = Math.max(...comment.split("\n").map((line) => line.length));
  assert.ok(longestLine < 1000, `no line should be unbounded after redact-then-truncate, longest was ${longestLine}`);
  assert.doesNotMatch(comment, /BEGIN RSA PRIVATE KEY/);
});
