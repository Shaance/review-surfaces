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
