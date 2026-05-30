import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReviewPacket, PacketInputs, ReviewPacket, rewriteReviewPacket } from "../src/render/packet";

test("review-surfaces.PRIVACY.2 redacts methodology claims when rendering packet markdown", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-render-redact-"));
  const packet: ReviewPacket = {
    schema_version: "review-surfaces.packet.v1",
    manifest: {},
    intent: {
      summary: "render fixture",
      requirements: [],
      constraints: [],
      non_goals: [],
      assumptions: [],
      open_questions: [],
      sources: []
    },
    evaluation: {
      summary: "render fixture",
      results: [],
      overreach: [],
      acai_coverage: {}
    },
    architecture: {
      summary: "render fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "render fixture",
      missing_logs: false,
      considered: [],
      research: [],
      decisions: [],
      unchallenged_assumptions: [],
      skipped_checks: [],
      claims_without_evidence: ["evt_raw: SECRET_TOKEN=abc123456 tests are green"],
      verified_claims: ["evt_raw: API_KEY=abc123456 pnpm run test passed"],
      quality_flags: [],
      evidence: []
    },
    risks: {
      summary: "render fixture",
      items: [],
      test_evidence: [],
      test_gaps: [],
      review_focus: []
    }
  };

  await rewriteReviewPacket(tmp, packet);

  const markdown = fs.readFileSync(path.join(tmp, "review_packet.md"), "utf8");
  assert.doesNotMatch(markdown, /abc123456/);
  assert.match(markdown, /SECRET_TOKEN=\[REDACTED:secret\]/);
  assert.match(markdown, /API_KEY=\[REDACTED:secret\]/);
});

test("review-surfaces.PRIVACY.2 redacts and prioritizes generated handoff validation summaries", () => {
  const packet = createReviewPacket({
    collection: {
      manifest: { milestone: "M5" },
      changedFiles: []
    },
    intent: {
      summary: "render fixture",
      requirements: [],
      constraints: [],
      non_goals: [],
      assumptions: [],
      open_questions: [],
      sources: []
    },
    evaluation: {
      summary: "render fixture",
      results: [],
      overreach: [],
      acai_coverage: {}
    },
    architecture: {
      summary: "render fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "render fixture",
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
      summary: "render fixture",
      items: [],
      test_gaps: [],
      review_focus: [],
      test_evidence: [
        {
          id: "TEST-DIRECT-SECRET",
          kind: "direct",
          summary: "Command transcript captured API_KEY=abc123456 pnpm run test.",
          evidence: [{ kind: "command", command: "pnpm run test", confidence: "high" }]
        },
        ...Array.from({ length: 6 }, (_value, index) => ({
          id: `TEST-CLAIM-${index + 1}`,
          kind: "claimed" as const,
          summary: `Feedback records a passing validation command: pnpm run lint:${index + 1}`,
          evidence: [{ kind: "feedback" as const, path: ".review-surfaces/feedback/manual.yaml", confidence: "medium" as const }]
        })),
        {
          id: "TEST-FAILED-SECRET",
          kind: "missing",
          summary: "Feedback records a failing validation command: SECRET_TOKEN=abc123456 pnpm run build",
          evidence: [{ kind: "feedback", path: ".review-surfaces/feedback/manual.yaml", confidence: "medium" }]
        }
      ]
    },
    dogfood: {
      milestone: "M5",
      summary: "dogfood fixture",
      findings: []
    },
    enrichment: {
      provider: "mock",
      status: "skipped"
    },
    commands: []
  } as unknown as PacketInputs);

  assert.ok(packet.agent_handoff?.validation_evidence?.some((item) => item.includes("API_KEY=[REDACTED:secret]")));
  assert.ok(packet.agent_handoff?.failed_validation?.[0].includes("TEST-FAILED-SECRET"));
  assert.ok(packet.agent_handoff?.failed_validation?.some((item) => item.includes("SECRET_TOKEN=[REDACTED:secret]")));
  assert.ok(!packet.agent_handoff?.validation_evidence?.some((item) => item.includes("abc123456")));
  assert.ok(!packet.agent_handoff?.failed_validation?.some((item) => item.includes("abc123456")));
});

test("review-surfaces.CLI.7 handoff commands capture validation transcripts", () => {
  const packet = createReviewPacket({
    collection: {
      manifest: { milestone: "M5" },
      changedFiles: []
    },
    intent: {
      summary: "render fixture",
      requirements: [],
      constraints: [],
      non_goals: [],
      assumptions: [],
      open_questions: [],
      sources: []
    },
    evaluation: {
      summary: "render fixture",
      results: [],
      overreach: [],
      acai_coverage: {}
    },
    architecture: {
      summary: "render fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "render fixture",
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
      summary: "render fixture",
      items: [],
      test_gaps: [],
      review_focus: [],
      test_evidence: []
    },
    dogfood: {
      milestone: "M5",
      summary: "dogfood fixture",
      findings: []
    },
    enrichment: {
      provider: "mock",
      status: "skipped"
    },
    commands: []
  } as unknown as PacketInputs);

  assert.deepEqual(packet.agent_handoff?.commands_to_run?.slice(0, 3), [
    "node bin/review-surfaces.js run --id CMD-PNPM-BUILD --command-transcripts .review-surfaces/commands -- pnpm run build",
    "node bin/review-surfaces.js run --id CMD-PNPM-LINT --command-transcripts .review-surfaces/commands -- pnpm run lint",
    "node bin/review-surfaces.js run --id CMD-PNPM-TEST --command-transcripts .review-surfaces/commands -- pnpm run test"
  ]);
  assert.ok(!packet.agent_handoff?.commands_to_run?.some((command) => command.startsWith("pnpm run review-surfaces -- run")));
  assert.ok(packet.agent_handoff?.commands_to_run?.includes(
    "node bin/review-surfaces.js all --base origin/main --head HEAD --spec features/review-surfaces.feature.yaml --dogfood --provider mock --out .review-surfaces"
  ));
  assert.ok(packet.agent_handoff?.commands_to_run?.includes("node bin/review-surfaces.js validate .review-surfaces"));
});

test("review-surfaces.DOGFOOD.5 marks truncated implemented changes in generated handoff", () => {
  const packet = createReviewPacket({
    collection: {
      manifest: { milestone: "M5" },
      changedFiles: Array.from({ length: 14 }, (_value, index) => ({
        status: "M",
        path: `src/changed-${index + 1}.ts`,
        source: "diff"
      }))
    },
    intent: {
      summary: "render fixture",
      requirements: [],
      constraints: [],
      non_goals: [],
      assumptions: [],
      open_questions: [],
      sources: []
    },
    evaluation: {
      summary: "render fixture",
      results: [],
      overreach: [],
      acai_coverage: {}
    },
    architecture: {
      summary: "render fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "render fixture",
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
      summary: "render fixture",
      items: [],
      test_gaps: [],
      review_focus: [],
      test_evidence: []
    },
    dogfood: {
      milestone: "M5",
      summary: "dogfood fixture",
      findings: []
    },
    enrichment: {
      provider: "mock",
      status: "skipped"
    },
    commands: []
  } as unknown as PacketInputs);

  assert.equal(packet.agent_handoff?.implemented_changes?.length, 13);
  assert.ok(packet.agent_handoff?.implemented_changes?.includes("... 2 more changed file(s) in .review-surfaces/inputs/changed_files.json"));
});

// FIX 3 fixture: a packet with zero LLM contributions (a pure mock run). The
// evaluation result carries only deterministic evidence (no llm_proposed flag)
// and the requirement is not llm_derived.
function mockPacketInputs(): PacketInputs {
  return {
    collection: { manifest: {}, changedFiles: [] },
    intent: {
      summary: "render fixture",
      requirements: [
        {
          id: "REQ-1",
          acai_id: "example.SRC.1",
          requirement: "The source module exports the marker.",
          source_refs: [],
          constraints: [],
          assumptions: [],
          open_questions: [],
          confidence: "high"
        }
      ],
      constraints: [],
      non_goals: [],
      assumptions: [],
      open_questions: [],
      sources: []
    },
    evaluation: {
      summary: "render fixture",
      results: [
        {
          requirement_id: "REQ-1",
          acai_id: "example.SRC.1",
          status: "satisfied",
          summary: "deterministic evidence found",
          evidence: [{ kind: "file", path: "src/module.ts", confidence: "high" }],
          missing_evidence: [],
          confidence: "high"
        }
      ],
      overreach: [],
      acai_coverage: {}
    },
    architecture: {
      summary: "render fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "render fixture",
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
      summary: "render fixture",
      items: [],
      test_gaps: [],
      review_focus: [],
      test_evidence: []
    },
    enrichment: { provider: "mock", status: "skipped" },
    commands: []
  } as unknown as PacketInputs;
}

// FIX 3: a pure mock run (zero LLM contributions) must NOT render the
// "LLM/agent hypotheses" header nor any "LLM-proposed" appendix line, so a naive
// grep for "LLM-proposed" finds nothing misleading.
test("review-surfaces.EVIDENCE.6 mock packet omits LLM hypotheses UI when there are no LLM contributions", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-render-mock-llm-"));
  try {
    await rewriteReviewPacket(tmp, createReviewPacket(mockPacketInputs()));
    const markdown = fs.readFileSync(path.join(tmp, "review_packet.md"), "utf8");
    assert.doesNotMatch(markdown, /LLM\/agent hypotheses/, "mock packet must not render the hypotheses header");
    assert.doesNotMatch(markdown, /LLM-proposed/, "mock packet must not render any LLM-proposed text");

    // The JSON must still carry zero LLM flags (unchanged contract).
    const packet = JSON.parse(fs.readFileSync(path.join(tmp, "review_packet.json"), "utf8"));
    assert.equal(packet.intent.requirements.filter((r: { llm_derived?: boolean }) => r.llm_derived).length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// #4/#5 fixture: a packet whose evaluation results are generated so the count
// can cross the compact group-rollup threshold. Each result carries an Acai id
// (so it has a group_key) and a deterministic status spread across groups.
function packetWithRequirementResults(count: number): ReviewPacket {
  const groups = ["INTENT", "EVAL", "RISK"];
  const results = Array.from({ length: count }, (_value, index) => {
    const group = groups[index % groups.length];
    const status = index % 4 === 0 ? "satisfied" : index % 4 === 1 ? "partial" : index % 4 === 2 ? "missing" : "unknown";
    return {
      requirement_id: `REQ-${String(index + 1).padStart(3, "0")}`,
      acai_id: `example.${group}.${index + 1}`,
      status,
      summary: `result ${index + 1}`,
      ...(status === "partial" ? { partial_reason: "impl_no_test" as const } : {}),
      evidence: [],
      missing_evidence: [],
      review_focus: "focus",
      confidence: "medium" as const
    };
  });
  return {
    schema_version: "review-surfaces.packet.v1",
    manifest: {},
    intent: {
      summary: "rollup fixture",
      requirements: [],
      constraints: [],
      non_goals: [],
      assumptions: [],
      open_questions: [],
      sources: []
    },
    evaluation: {
      summary: "rollup fixture",
      results: results as unknown as ReviewPacket["evaluation"]["results"],
      overreach: [],
      acai_coverage: {}
    },
    architecture: {
      summary: "rollup fixture",
      diagrams: [],
      diagram_validation: [],
      subsystems: [],
      open_questions: []
    },
    methodology: {
      summary: "rollup fixture",
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
      summary: "rollup fixture",
      items: [],
      test_evidence: [],
      test_gaps: [],
      missing_automatic_tests: [],
      missing_manual_checks: [],
      review_focus: []
    }
  };
}

// #5: the full per-requirement coverage list surfaces the structured
// partial_reason inline. #4: below the compact threshold the full list (not
// group rollups) is rendered.
test("review-surfaces.RENDER.1 small spec renders full per-requirement coverage with partial_reason", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-render-full-list-"));
  try {
    await rewriteReviewPacket(tmp, packetWithRequirementResults(8));
    const markdown = fs.readFileSync(path.join(tmp, "review_packet.md"), "utf8");
    assert.doesNotMatch(markdown, /Group rollups/, "small spec must not switch to group rollups");
    assert.match(markdown, /partial \[impl_no_test\]/, "partial lines must surface the structured partial_reason");
    // The full list shows an individual unsatisfied requirement id.
    assert.match(markdown, /REQ-002 \(example\.EVAL\.2\): partial \[impl_no_test\]/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// #4: past the compact threshold the requirement-coverage section renders one
// group rollup line per Acai group with per-status counts plus a short "worst N"
// detail list, instead of the full per-requirement list. Deterministic.
test("review-surfaces.RENDER.2 large spec renders compact group rollups with worst-N detail", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-render-rollups-"));
  try {
    const packet = packetWithRequirementResults(60);
    await rewriteReviewPacket(tmp, packet);
    const markdown = fs.readFileSync(path.join(tmp, "review_packet.md"), "utf8");

    assert.match(markdown, /Group rollups \(60 requirements across 3 group\(s\)/);
    // One rollup line per group with per-status counts.
    assert.match(markdown, /- EVAL: \d+ requirement\(s\) — satisfied \d+, partial \d+, missing \d+, unknown \d+, invalid \d+/);
    assert.match(markdown, /- INTENT: \d+ requirement\(s\) —/);
    assert.match(markdown, /- RISK: \d+ requirement\(s\) —/);
    // Groups are listed in deterministic (alphabetical) order.
    assert.ok(markdown.indexOf("- EVAL:") < markdown.indexOf("- INTENT:"));
    assert.ok(markdown.indexOf("- INTENT:") < markdown.indexOf("- RISK:"));
    // The full per-requirement list is NOT inlined: a deep requirement id stays
    // in the JSON, not the markdown coverage section.
    assert.doesNotMatch(markdown, /REQ-058/);
    // A short "worst N" detail list is still present. It is ranked by severity
    // (invalid_evidence > missing > unknown > partial), so the most actionable
    // statuses surface first.
    assert.match(markdown, /Worst 10 requirement\(s\):/);
    const worstBlock = markdown.slice(markdown.indexOf("Worst 10 requirement(s):"));
    assert.match(worstBlock, /: missing - /, "worst-N detail leads with the most severe unsatisfied statuses");
    assert.match(worstBlock, /\.\.\. \d+ more unsatisfied requirement\(s\) in review_packet\.json/);

    // Re-rendering the same packet is byte-identical (deterministic).
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-render-rollups-2-"));
    try {
      await rewriteReviewPacket(second, packet);
      assert.equal(fs.readFileSync(path.join(second, "review_packet.md"), "utf8"), markdown);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// FIX 3: with a stub provider contribution (an llm_proposed evidence ref) the
// hypotheses header and the LLM-proposed appendix line DO appear.
test("review-surfaces.EVIDENCE.6 packet renders LLM hypotheses UI when a contribution is present", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-render-llm-present-"));
  try {
    const inputs = mockPacketInputs();
    // Inject a stub provider contribution: a proposed (non-authoritative)
    // evidence ref on the evaluation result.
    (inputs.evaluation.results[0].evidence as unknown[]).push({
      kind: "file",
      path: "src/module.ts",
      confidence: "low",
      validation_status: "not_checked",
      llm_proposed: true
    });
    await rewriteReviewPacket(tmp, createReviewPacket(inputs));
    const markdown = fs.readFileSync(path.join(tmp, "review_packet.md"), "utf8");
    assert.match(markdown, /LLM\/agent hypotheses/, "header must appear when an LLM contribution exists");
    assert.match(markdown, /LLM-proposed \(non-authoritative\) requirements: 0/, "appendix line must appear (count may be 0 for evidence-only contributions)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
