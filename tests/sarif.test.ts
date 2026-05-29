import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { renderSarif } from "../src/render/sarif";
import type { ReviewPacket } from "../src/render/packet";

// ---------------------------------------------------------------------------
// Phase 6b (PROVIDERS.2; M6): SARIF 2.1.0 exporter coverage. This file pins the
// SARIF mapping so a regression (inverted severity->level, dropped hypothesis
// downgrade, mismatched rules[]) FAILS the suite. It uses two complementary
// surfaces:
//   - CLI-driven (`all` then `comment --format sarif`) for end-to-end structural
//     validity, determinism, and the agent-file hypothesis guard.
//   - In-memory renderSarif() over a hand-built packet for the exact severity/
//     status mapping matrix, the empty packet, rules[] coverage, and region
//     gating, which are awkward to provoke via the deterministic mock pipeline.
// ---------------------------------------------------------------------------

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");

function setupFixture(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(process.cwd(), tmp, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(process.cwd(), source);
      return relative !== ".git"
        && !relative.startsWith(`.git${path.sep}`)
        && relative !== ".review-surfaces"
        && !relative.startsWith(`.review-surfaces${path.sep}`)
        && relative !== "dist"
        && !relative.startsWith(`dist${path.sep}`);
    }
  });
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  return tmp;
}

function runAll(cwd: string, extra: string[] = []): void {
  execFileSync(
    "node",
    [
      CLI,
      "all",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--spec",
      "features/review-surfaces.feature.yaml",
      "--provider",
      "mock",
      "--out",
      ".review-surfaces",
      ...extra
    ],
    { cwd, stdio: "ignore" }
  );
}

// `comment --format sarif` writes the SARIF JSON to stdout and the "Wrote ..."
// notice to stderr, mirroring the github format path.
function runSarif(cwd: string, extra: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, "comment", "--format", "sarif", "--out", ".review-surfaces", ...extra], {
    cwd,
    encoding: "utf8"
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const AGENT_INPUT_FIXTURE = JSON.stringify(
  {
    summary: "Synthesized intent hypothesis.",
    assumptions: ["An assumption hypothesis."],
    risk_narratives: ["A possible concurrency risk.", "A possible data-loss risk."]
  },
  null,
  2
);

const SARIF_LEVELS = new Set(["error", "warning", "note", "none"]);

interface SarifResultShape {
  ruleId: string;
  level: string;
  message: { text: string };
  locations?: Array<{
    physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number; endLine?: number } };
  }>;
}

interface SarifLogShape {
  $schema: string;
  version: string;
  runs: Array<{
    tool: { driver: { name: string; informationUri: string; rules: Array<{ id: string; name: string }> } };
    results: SarifResultShape[];
  }>;
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)].sort();
}

test("review-surfaces.PROVIDERS.2 sarif export is structurally valid SARIF 2.1.0", () => {
  const tmp = setupFixture("review-surfaces-sarif-");
  try {
    runAll(tmp);
    const result = runSarif(tmp);
    assert.equal(result.status, 0, result.stderr);

    const log = JSON.parse(result.stdout) as SarifLogShape;
    assert.equal(log.version, "2.1.0");
    assert.equal(typeof log.$schema, "string");
    assert.match(log.$schema, /sarif-schema-2\.1\.0\.json$/);
    assert.equal(log.runs.length, 1);
    assert.equal(log.runs[0].tool.driver.name, "review-surfaces");

    // Every result has the required ruleId/level/message.text with a valid level.
    for (const item of log.runs[0].results) {
      assert.equal(typeof item.ruleId, "string");
      assert.ok(item.ruleId.length > 0, "ruleId must be non-empty");
      assert.ok(SARIF_LEVELS.has(item.level), `unexpected SARIF level: ${item.level}`);
      assert.equal(typeof item.message.text, "string");
    }

    // The SARIF file is written under --out and equals stdout.
    const sarifPath = path.join(tmp, ".review-surfaces", "review.sarif");
    assert.ok(fs.existsSync(sarifPath), "review.sarif should be written under --out");
    assert.equal(fs.readFileSync(sarifPath, "utf8"), result.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.2 sarif rules[] cover exactly the distinct result ruleIds", () => {
  const tmp = setupFixture("review-surfaces-sarif-rules-");
  try {
    runAll(tmp);
    const result = runSarif(tmp);
    assert.equal(result.status, 0, result.stderr);

    const log = JSON.parse(result.stdout) as SarifLogShape;
    const usedRuleIds = distinct(log.runs[0].results.map((item) => item.ruleId));
    const declaredRuleIds = distinct(log.runs[0].tool.driver.rules.map((rule) => rule.id));
    assert.deepEqual(declaredRuleIds, usedRuleIds, "declared rules[] must equal the distinct set of result ruleIds");
    // name mirrors id for each rule (stable descriptor).
    for (const rule of log.runs[0].tool.driver.rules) {
      assert.equal(rule.name, rule.id);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.EVIDENCE.6 sarif keeps every LLM/agent hypothesis at level note", () => {
  const tmp = setupFixture("review-surfaces-sarif-hyp-");
  try {
    fs.writeFileSync(path.join(tmp, "agent-input.json"), AGENT_INPUT_FIXTURE);
    // Offline agent-file provider contributes bounded hypotheses (no network).
    runAll(tmp, ["--provider", "agent-file", "--agent-input", "agent-input.json"]);
    const result = runSarif(tmp);
    assert.equal(result.status, 0, result.stderr);

    const log = JSON.parse(result.stdout) as SarifLogShape;
    const hypotheses = log.runs[0].results.filter((item) => item.ruleId === "llm_hypothesis");
    assert.ok(hypotheses.length > 0, "agent-file run should surface LLM hypotheses in SARIF");
    for (const item of hypotheses) {
      assert.equal(item.level, "note", "LLM hypotheses must ALWAYS be note, never error/warning");
      assert.match(item.message.text, /HYPOTHESIS \(NOT proof; verify\)/);
    }
    // No result riding on LLM-proposed material may be emitted at error/warning.
    const elevatedHypotheses = log.runs[0].results.filter(
      (item) => item.ruleId === "llm_hypothesis" && item.level !== "note"
    );
    assert.equal(elevatedHypotheses.length, 0, "a hypothesis must never masquerade as error/warning proof");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.2 sarif render is byte-deterministic across two renders", () => {
  const tmp = setupFixture("review-surfaces-sarif-det-");
  try {
    runAll(tmp);
    const first = runSarif(tmp);
    const firstArtifact = fs.readFileSync(path.join(tmp, ".review-surfaces", "review.sarif"), "utf8");
    const second = runSarif(tmp);
    const secondArtifact = fs.readFileSync(path.join(tmp, ".review-surfaces", "review.sarif"), "utf8");

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout, "two SARIF renders of the same packet must be byte-identical");
    assert.equal(firstArtifact, secondArtifact, "the written SARIF artifact must be byte-stable across renders");
    assert.equal(first.stdout, firstArtifact, "stdout and the written SARIF artifact must match");
    // POSIX-friendly trailing newline.
    assert.ok(first.stdout.endsWith("\n"), "SARIF output should end with a trailing newline");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.2 sarif missing packet is a clean usage error pointing at `all`", () => {
  const tmp = setupFixture("review-surfaces-sarif-missing-");
  try {
    // No `all` run: review_packet.json is absent. sarif must NOT recompute.
    assert.equal(fs.existsSync(path.join(tmp, ".review-surfaces", "review_packet.json")), false);
    const result = runSarif(tmp);
    assert.equal(result.status, 2, "absent packet must exit with the usage error code");
    assert.match(result.stderr, /No review packet JSON found/);
    assert.match(result.stderr, /review-surfaces all/);
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "review.sarif")),
      false,
      "no review.sarif should be written when the packet is absent"
    );
    assert.equal(
      fs.existsSync(path.join(tmp, ".review-surfaces", "review_packet.json")),
      false,
      "sarif must never recompute review_packet.json"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// In-memory mapping matrix over renderSarif(). The fields renderSarif reads are
// risks.items, evaluation.results, and intent.requirements; this packet exercises
// every mapping edge precisely. We cast through unknown because renderSarif only
// touches the fields set below (the full ReviewPacket has many unrelated nested
// shapes that do not affect SARIF output).
// ---------------------------------------------------------------------------

function packetFor(parts: {
  risks?: unknown[];
  results?: unknown[];
  requirements?: unknown[];
}): ReviewPacket {
  return {
    risks: { items: parts.risks ?? [] },
    evaluation: { results: parts.results ?? [] },
    intent: { requirements: parts.requirements ?? [] }
  } as unknown as ReviewPacket;
}

test("review-surfaces.PROVIDERS.2 severity maps to SARIF level (critical/high=error, medium=warning, low/unknown=note)", () => {
  const log = renderSarif(
    packetFor({
      risks: [
        { id: "R-CRIT", category: "security", severity: "critical", summary: "critical risk", evidence: [] },
        { id: "R-HIGH", category: "correctness", severity: "high", summary: "high risk", evidence: [] },
        { id: "R-MED", category: "testing", severity: "medium", summary: "medium risk", evidence: [] },
        { id: "R-LOW", category: "release", severity: "low", summary: "low risk", evidence: [] },
        { id: "R-UNK", category: "workflow", severity: "unknown", summary: "unknown risk", evidence: [] }
      ]
    })
  ) as unknown as SarifLogShape;

  const byMessage = new Map(log.runs[0].results.map((item) => [item.message.text.split(":")[0], item.level]));
  assert.equal(byMessage.get("R-CRIT"), "error");
  assert.equal(byMessage.get("R-HIGH"), "error");
  assert.equal(byMessage.get("R-MED"), "warning");
  assert.equal(byMessage.get("R-LOW"), "note");
  assert.equal(byMessage.get("R-UNK"), "note");
  // ruleId is the risk category, not the severity.
  const crit = log.runs[0].results.find((item) => item.message.text.startsWith("R-CRIT"));
  assert.equal(crit?.ruleId, "security");
});

test("review-surfaces.PROVIDERS.2 requirement status maps (invalid_evidence=error, missing=warning, others omitted)", () => {
  const log = renderSarif(
    packetFor({
      results: [
        { requirement_id: "REQ-INV", acai_id: "x.A.1", status: "invalid_evidence", summary: "claimed but invalid", evidence: [], missing_evidence: [] },
        { requirement_id: "REQ-MISS", acai_id: "x.A.2", status: "missing", summary: "no evidence", evidence: [], missing_evidence: [] },
        { requirement_id: "REQ-SAT", acai_id: "x.A.3", status: "satisfied", summary: "proven", evidence: [], missing_evidence: [] },
        { requirement_id: "REQ-PART", acai_id: "x.A.4", status: "partial", summary: "weak", evidence: [], missing_evidence: [] },
        { requirement_id: "REQ-UNK", acai_id: "x.A.5", status: "unknown", summary: "unclear", evidence: [], missing_evidence: [] }
      ]
    })
  ) as unknown as SarifLogShape;

  const invalid = log.runs[0].results.find((item) => item.ruleId === "invalid_evidence");
  assert.ok(invalid, "invalid_evidence requirement should emit a result");
  assert.equal(invalid?.level, "error");

  const missing = log.runs[0].results.find((item) => item.ruleId === "missing_requirement");
  assert.ok(missing, "missing requirement should emit a result");
  assert.equal(missing?.level, "warning");

  // satisfied/partial/unknown are NOT emitted to SARIF.
  assert.equal(
    log.runs[0].results.some((item) => item.message.text.startsWith("x.A.3")),
    false
  );
  assert.equal(
    log.runs[0].results.some((item) => item.message.text.startsWith("x.A.4")),
    false
  );
  assert.equal(
    log.runs[0].results.some((item) => item.message.text.startsWith("x.A.5")),
    false
  );
});

test("review-surfaces.EVIDENCE.6 a hypothesis-only risk is downgraded to note even when severity is critical", () => {
  const log = renderSarif(
    packetFor({
      risks: [
        {
          id: "LLM-RISK-001",
          category: "security",
          // Deliberately CRITICAL: if the isHypothesisOnly downgrade were dropped,
          // this would (wrongly) emit at error level.
          severity: "critical",
          summary: "LLM-proposed: a possible data-loss risk.",
          evidence: [{ kind: "unknown", note: "LLM-proposed.", confidence: "low", validation_status: "unknown", llm_proposed: true }]
        }
      ]
    })
  ) as unknown as SarifLogShape;

  const results = log.runs[0].results;
  // The risk must NOT appear as a deterministic security/error result...
  assert.equal(
    results.some((item) => item.ruleId === "security"),
    false,
    "a hypothesis-only risk must never emit at its real severity rule/level"
  );
  // ...it must appear ONLY as an llm_hypothesis note.
  const hyp = results.filter((item) => item.ruleId === "llm_hypothesis");
  assert.equal(hyp.length, 1);
  assert.equal(hyp[0].level, "note");
  assert.match(hyp[0].message.text, /HYPOTHESIS \(NOT proof; verify\)/);
  // No result anywhere rides at error/warning for this packet.
  assert.equal(results.every((item) => item.level === "note"), true);
});

test("review-surfaces.PROVIDERS.2 empty packet still yields valid SARIF with empty results and rules", () => {
  const log = renderSarif(packetFor({})) as unknown as SarifLogShape;
  assert.equal(log.version, "2.1.0");
  assert.equal(typeof log.$schema, "string");
  assert.equal(log.runs[0].tool.driver.name, "review-surfaces");
  assert.deepEqual(log.runs[0].results, []);
  assert.deepEqual(log.runs[0].tool.driver.rules, []);
});

test("review-surfaces.PROVIDERS.2 emitted regions are 1-based with endLine>=startLine and bad lines are dropped", () => {
  const log = renderSarif(
    packetFor({
      risks: [
        {
          id: "R-LOC",
          category: "correctness",
          severity: "high",
          summary: "located risk",
          evidence: [
            { kind: "file", path: "src/a.ts", line_start: 10, line_end: 20, confidence: "medium" },
            // Bad line numbers: zero/negative startLine must NOT produce a region.
            { kind: "file", path: "src/b.ts", line_start: 0, confidence: "medium" },
            // endLine < startLine must be dropped, leaving only startLine.
            { kind: "file", path: "src/c.ts", line_start: 5, line_end: 2, confidence: "medium" }
          ]
        }
      ]
    })
  ) as unknown as SarifLogShape;

  const located = log.runs[0].results.find((item) => item.ruleId === "correctness");
  assert.ok(located?.locations && located.locations.length > 0, "located risk should carry locations");
  for (const location of located!.locations!) {
    const region = location.physicalLocation.region;
    if (region) {
      assert.ok(region.startLine >= 1, `startLine must be >=1, got ${region.startLine}`);
      if (typeof region.endLine === "number") {
        assert.ok(region.endLine >= region.startLine, "endLine must be >= startLine");
      }
    }
  }
  // a.ts: full region; b.ts: no region (bad start); c.ts: startLine only (bad end).
  const byUri = new Map(located!.locations!.map((loc) => [loc.physicalLocation.artifactLocation.uri, loc.physicalLocation.region]));
  assert.deepEqual(byUri.get("src/a.ts"), { startLine: 10, endLine: 20 });
  assert.equal(byUri.get("src/b.ts"), undefined);
  assert.deepEqual(byUri.get("src/c.ts"), { startLine: 5 });
});
