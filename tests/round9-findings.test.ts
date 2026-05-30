import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { comparePackets, loadPreviousPacket } from "../src/dogfood/compare";
import { EvaluationModel } from "../src/evaluation/evaluate";
import { RisksModel } from "../src/risks/risks";

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

function writePacketFile(json: unknown): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-round9-prev-"));
  const packetPath = path.join(tmp, "review_packet.json");
  fs.writeFileSync(packetPath, JSON.stringify(json));
  return packetPath;
}

function currentEvaluation(): EvaluationModel {
  return {
    summary: "current",
    results: [
      { requirement_id: "R1", acai_id: "review-surfaces.A.1", status: "satisfied", summary: "now satisfied", evidence: [], missing_evidence: [], review_focus: "", confidence: "high" },
      { requirement_id: "R2", acai_id: "review-surfaces.B.2", status: "partial", summary: "now partial", evidence: [], missing_evidence: [], review_focus: "", confidence: "medium" }
    ],
    overreach: [],
    acai_coverage: {}
  };
}

function currentRisks(): Pick<RisksModel, "items"> {
  return {
    items: [
      { id: "RISK-001", category: "security", severity: "high", summary: "Brand new risk" }
    ]
  };
}

// ---------------------------------------------------------------------------
// FINDING A: isReviewPacketShape must require the structural fields
// UNCONDITIONALLY. A parseable-but-truncated/corrupt baseline that carries ONLY
// schema_version (no evaluation/risks) used to pass on schema_version alone;
// normalizeEvaluation(undefined)/normalizeRisks(undefined) then coerced it into
// an EMPTY baseline and the dogfood comparison falsely reported every current
// requirement as improved-from-missing and every current risk as new against a
// phantom baseline. Such a file must now be a clean no-op (return null), exactly
// like the absent/array/non-packet cases. PARITY: a genuine handwritten packet
// WITHOUT schema_version but WITH proper evaluation.results / risks.items is
// still accepted.
// ---------------------------------------------------------------------------

test("FINDING A: a schema_version-only/truncated packet is a clean no-op (not all-improvements)", () => {
  // A truncated/corrupt baseline that carries ONLY schema_version.
  const truncatedPath = writePacketFile({ schema_version: "review-surfaces.packet.v1" });
  try {
    // The loader must treat it as an unreadable baseline (no-op), NOT coerce it
    // into a phantom empty baseline.
    assert.equal(
      loadPreviousPacket(truncatedPath),
      null,
      "a schema_version-only packet (no evaluation/risks) must return null"
    );

    // Control: an EXPLICIT empty (but structurally valid) packet DOES load and, as
    // a phantom empty baseline, fabricates improvements. The truncated path must
    // never produce a comparison like this.
    const phantomPath = writePacketFile({
      schema_version: "review-surfaces.packet.v1",
      evaluation: { summary: "", results: [], overreach: [], acai_coverage: {} },
      risks: { summary: "", items: [] }
    });
    const phantom = loadPreviousPacket(phantomPath);
    assert.ok(phantom, "an explicitly-empty but structurally-valid packet still loads (control)");
    const fabricated = comparePackets(phantom!, { evaluation: currentEvaluation(), risks: currentRisks() });
    assert.ok(
      fabricated.status_changes.length > 0 && fabricated.new_risks.length > 0,
      "the empty phantom baseline DOES fabricate improvements/new risks (control)"
    );
    // The truncated baseline must NOT fabricate any of that: it is a hard no-op.
    assert.equal(loadPreviousPacket(truncatedPath), null);
  } finally {
    fs.rmSync(path.dirname(truncatedPath), { recursive: true, force: true });
  }
});

test("FINDING A: a packet missing ONLY evaluation OR ONLY risks is rejected (both structural fields required)", () => {
  // schema_version present + evaluation present but NO risks: still incomplete.
  const noRisksPath = writePacketFile({
    schema_version: "review-surfaces.packet.v1",
    evaluation: { summary: "p", results: [], overreach: [], acai_coverage: {} }
  });
  // schema_version present + risks present but NO evaluation: still incomplete.
  const noEvalPath = writePacketFile({
    schema_version: "review-surfaces.packet.v1",
    risks: { summary: "p", items: [] }
  });
  try {
    assert.equal(loadPreviousPacket(noRisksPath), null, "schema_version + evaluation but no risks must be a no-op");
    assert.equal(loadPreviousPacket(noEvalPath), null, "schema_version + risks but no evaluation must be a no-op");
  } finally {
    fs.rmSync(path.dirname(noRisksPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(noEvalPath), { recursive: true, force: true });
  }
});

test("FINDING A (parity): a full valid packet loads and compares, WITH or WITHOUT schema_version", () => {
  const full = {
    evaluation: {
      summary: "previous",
      results: [
        { requirement_id: "R1", acai_id: "review-surfaces.A.1", status: "missing", summary: "was missing" },
        { requirement_id: "R2", acai_id: "review-surfaces.B.2", status: "partial", summary: "was partial" }
      ],
      overreach: [],
      acai_coverage: {}
    },
    risks: {
      summary: "previous risks",
      items: [{ id: "RISK-001", category: "testing", severity: "medium", summary: "Goes away" }]
    }
  };

  // With schema_version.
  const withVersionPath = writePacketFile({ schema_version: "review-surfaces.packet.v1", ...full });
  // WITHOUT schema_version: the round-3 handwritten-packet parity must hold.
  const withoutVersionPath = writePacketFile(full);
  try {
    const withVersion = loadPreviousPacket(withVersionPath);
    const withoutVersion = loadPreviousPacket(withoutVersionPath);
    assert.ok(withVersion, "a full packet WITH schema_version must load");
    assert.ok(withoutVersion, "a full handwritten packet WITHOUT schema_version must still load (round-3 parity)");
    assert.equal(withVersion!.evaluation.results.length, 2);
    assert.equal(withoutVersion!.evaluation.results.length, 2);

    // It compares against a real baseline: R1 missing -> satisfied is improved,
    // R2 partial -> partial is unchanged (omitted), the testing risk resolves.
    const comparison = comparePackets(withoutVersion!, { evaluation: currentEvaluation(), risks: currentRisks() });
    const improved = comparison.status_changes.find((change) => change.acai_id === "review-surfaces.A.1");
    assert.equal(improved?.direction, "improved");
    assert.deepEqual(comparison.resolved_risks, ["testing: Goes away"]);
    assert.deepEqual(comparison.new_risks, ["security: Brand new risk"]);
  } finally {
    fs.rmSync(path.dirname(withVersionPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(withoutVersionPath), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING A (end-to-end): a `dogfood --previous-packet <truncated>` run must be
// a CLEAN no-op comparison: agent_handoff.md must note the baseline was
// absent/unreadable rather than fabricating "everything improved/new".
// ---------------------------------------------------------------------------

function setupDogfoodRepo(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "thing.ts"), "export const thing = 1;\n");
  fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\nprev/\n");
  initGitRepo(tmp);
  return tmp;
}

test("FINDING A (e2e): dogfood --previous-packet at a truncated packet is a no-op comparison", () => {
  const tmp = setupDogfoodRepo("review-surfaces-round9-dogfood-trunc-");
  try {
    // A truncated baseline: parseable but missing evaluation/risks.
    const prevDir = path.join(tmp, "prev");
    fs.mkdirSync(prevDir, { recursive: true });
    fs.writeFileSync(path.join(prevDir, "review_packet.json"), JSON.stringify({ schema_version: "review-surfaces.packet.v1" }));

    const run = runCli(tmp, ["dogfood", "--base", "HEAD", "--head", "HEAD", "--provider", "mock", "--previous-packet", "prev"]);
    assert.equal(run.status, 0, run.stderr);

    const handoff = readArtifact(tmp, "agent_handoff.md");
    // The comparison must be skipped (baseline unreadable), NOT a fabricated diff.
    assert.match(
      handoff,
      /was absent or unreadable; no comparison computed/,
      "a truncated baseline must yield the skipped-comparison note, not a fabricated diff"
    );
    // And it must NOT have fabricated "improved from missing" lines against a phantom.
    assert.doesNotMatch(handoff, /missing -> satisfied \(improved\)/, "no phantom improvements may be reported");
    assert.doesNotMatch(handoff, /^New risk:/m, "no phantom new risks may be reported");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING B: the standalone `handoff` stage must run the SAME packet-level
// enrichPacket the monolithic `all`/`packet` run does BEFORE writing
// agent_handoff.md, so `handoff --provider agent-file --agent-input ...` in a
// FRESH output dir surfaces the agent risk_summaries (as AI-RISK items in
// open_risks). It previously computed plain risks and never enriched, dropping
// them (same parity class as the round-4 standalone-risks and round-7
// standalone-methodology fixes). Mock stays a strict byte-stable no-op, and
// per-stage isolation holds (only agent_handoff.md, no diagrams/, no other
// owned artifacts).
// ---------------------------------------------------------------------------

function setupHandoffRepo(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "thing.ts"), "export const thing = 1;\n");
  fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
  fs.writeFileSync(
    path.join(tmp, "agent-input.json"),
    JSON.stringify(
      {
        risk_summaries: ["A possible unhandled error path in src/thing.ts."],
        review_focus: ["Look closely at the thing module."],
        methodology_decisions: ["Chose an incremental milestone-by-milestone rollout."]
      },
      null,
      2
    )
  );
  initGitRepo(tmp);
  return tmp;
}

const AGENT_RISK_LINE = /AI\/agent hypothesis: A possible unhandled error path in src\/thing\.ts\./;

test("FINDING B: standalone `handoff --provider agent-file` surfaces agent risk_summaries in agent_handoff.md", () => {
  const tmp = setupHandoffRepo("review-surfaces-round9-handoff-agent-");
  try {
    // FRESH output dir (no prior artifacts): the stage must compute AND enrich.
    const run = runCli(tmp, ["handoff", "--base", "HEAD", "--head", "HEAD", "--provider", "agent-file", "--agent-input", "agent-input.json"]);
    assert.equal(run.status, 0, run.stderr);

    const handoff = readArtifact(tmp, "agent_handoff.md");
    assert.match(
      handoff,
      AGENT_RISK_LINE,
      "the agent risk_summary must surface as an AI-RISK open-risk in agent_handoff.md (enrichPacket parity with all/packet)"
    );

    // PER-STAGE ISOLATION: handoff writes ONLY agent_handoff.md.
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "diagrams")),
      false,
      "handoff must NOT leak a diagrams/ directory it does not own"
    );
    for (const leaked of ["evaluation.yaml", "risks.yaml", "intent.yaml", "methodology.yaml", "architecture.md", "review_packet.json"]) {
      assert.equal(
        fs.existsSync(path.join(tmp, ".review-surfaces", leaked)),
        false,
        `handoff must not stamp/write ${leaked}`
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FINDING B (parity): standalone `handoff --provider agent-file` matches `all` for the agent risk_summary in agent_handoff.md", () => {
  const allRepo = setupHandoffRepo("review-surfaces-round9-handoff-all-");
  const stageRepo = setupHandoffRepo("review-surfaces-round9-handoff-stage-");
  try {
    // `all --dogfood` writes agent_handoff.md and runs the packet-level enrichment.
    assert.equal(
      runCli(allRepo, ["all", "--base", "HEAD", "--head", "HEAD", "--dogfood", "--provider", "agent-file", "--agent-input", "agent-input.json"]).status,
      0
    );
    assert.equal(
      runCli(stageRepo, ["handoff", "--base", "HEAD", "--head", "HEAD", "--provider", "agent-file", "--agent-input", "agent-input.json"]).status,
      0
    );

    const fromAll = readArtifact(allRepo, "agent_handoff.md");
    const fromStage = readArtifact(stageRepo, "agent_handoff.md");
    // Both surfaces must carry the SAME agent risk_summary the monolith lands.
    assert.match(fromAll, AGENT_RISK_LINE, "the `all` handoff must surface the agent risk_summary");
    assert.match(fromStage, AGENT_RISK_LINE, "the standalone handoff must surface the SAME agent risk_summary");
  } finally {
    fs.rmSync(allRepo, { recursive: true, force: true });
    fs.rmSync(stageRepo, { recursive: true, force: true });
  }
});

test("FINDING B (mock no-op): standalone `handoff --provider mock` is byte-stable and writes only agent_handoff.md", () => {
  const first = setupHandoffRepo("review-surfaces-round9-handoff-mock-1-");
  const second = setupHandoffRepo("review-surfaces-round9-handoff-mock-2-");
  try {
    assert.equal(runCli(first, ["handoff", "--base", "HEAD", "--head", "HEAD", "--provider", "mock"]).status, 0);
    assert.equal(runCli(second, ["handoff", "--base", "HEAD", "--head", "HEAD", "--provider", "mock"]).status, 0);

    const a = readArtifact(first, "agent_handoff.md");
    const b = readArtifact(second, "agent_handoff.md");
    // Mock enrichPacket is a strict no-op: the handoff is byte-identical across runs.
    assert.equal(a, b, "a mock handoff must be byte-stable across runs (enrichPacket no-op)");
    // Mock must NOT have appended any agent hypothesis (no agent-input was used).
    assert.doesNotMatch(a, /AI\/agent hypothesis:/, "mock handoff must carry no AI/agent hypotheses");

    // PER-STAGE ISOLATION under mock too: only agent_handoff.md, no diagrams/.
    assert.equal(fs.existsSync(path.join(first, ".review-surfaces", "diagrams")), false, "mock handoff must not leak diagrams/");
    for (const leaked of ["evaluation.yaml", "risks.yaml", "intent.yaml", "methodology.yaml", "architecture.md", "review_packet.json"]) {
      assert.equal(
        fs.existsSync(path.join(first, ".review-surfaces", leaked)),
        false,
        `mock handoff must not write ${leaked}`
      );
    }
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});
