import test from "node:test";
import assert from "node:assert/strict";
import { buildPrNarrative, BuildPrNarrativeInput } from "../src/llm/pr-narrative";
import { ReasoningProvider, StructuredResult } from "../src/llm/provider";
import { PrRiskModel, PrScopeModel, PrScopedCoverageModel, StructuredDiff } from "../src/pr/contract";

// A non-mock provider that returns whatever StructuredResult the test supplies,
// mirroring how the agent-file provider hands back a raw (schema-unbound) object.
function fakeProvider(result: StructuredResult): ReasoningProvider {
  return {
    name: "agent-file",
    async generateStructured(): Promise<StructuredResult> {
      return result;
    }
  };
}

function scope(): PrScopeModel {
  return {
    base_ref: "origin/main",
    head_ref: "HEAD",
    head_sha: "head",
    diff_source: "range",
    changed_files: [{ path: "src/cli/index.ts", status: "M", areas: ["CLI"], role: "implementation" }],
    affected_areas: [{ group_key: "CLI", area_ids: ["CLI"], name: "CLI", changed_files: ["src/cli/index.ts"] }],
    affected_requirements: [{ requirement_id: "x.CLI.1", acai_id: "x.CLI.1", title: "CLI", group_key: "CLI", reasons: [] }],
    out_of_scope_changed_files: []
  };
}

function coverage(): PrScopedCoverageModel {
  return {
    base_available: false,
    summary: "1 in scope",
    in_scope_count: 1,
    deltas: [],
    counts: { improved: 0, regressed: 0, unchanged: 0, new_requirement: 0, removed_requirement: 0, newly_in_scope: 1 }
  };
}

function risks(): PrRiskModel {
  return {
    summary: "1 risk",
    candidates: [
      { id: "PR-RISK-001", rule: "untested_changed_impl", category: "testing", severity: "medium", summary: "x", evidence: [], suggested_checks: [] }
    ]
  };
}

function inputWith(result: StructuredResult): BuildPrNarrativeInput {
  return {
    provider: fakeProvider(result),
    providerName: "agent-file",
    repo: "acme/widgets",
    scope: scope(),
    coverage: coverage(),
    risks: risks(),
    diff: { files: [] } as StructuredDiff,
    redactSecrets: true,
    remotePrivacyBlocked: false
  };
}

test("an item that smuggles a NON-STRING anchor is dropped (not silently repaired to its valid anchors)", async () => {
  const result = await buildPrNarrative(
    inputWith({
      ok: true,
      data: {
        summary: "s",
        what_changed: [
          { text: "bad — has a fabricated non-string anchor", paths: [123, "src/cli/index.ts"] },
          { text: "good", paths: ["src/cli/index.ts"] }
        ],
        why_it_matters: [],
        review_first: [],
        risk_narratives: []
      }
    })
  );
  assert.ok(result.narrative, "narrative built (a valid item survives)");
  assert.equal(result.narrative?.what_changed.length, 1, "the non-string-anchor item is dropped");
  assert.equal(result.narrative?.what_changed[0].text, "good");
});

test("diagram_caption from the LLM is never persisted (un-anchored free text is not part of the narrative)", async () => {
  const result = await buildPrNarrative(
    inputWith({
      ok: true,
      data: {
        summary: "s",
        what_changed: [{ text: "valid", paths: ["src/cli/index.ts"] }],
        why_it_matters: [],
        review_first: [],
        risk_narratives: [],
        diagram_caption: "impacts src/not-in-diff.ts per OFF.99"
      }
    })
  );
  assert.ok(result.narrative);
  assert.ok(!("diagram_caption" in (result.narrative as object)), "diagram_caption must not be persisted");
});

test("a summary citing a FABRICATED path is replaced by a deterministic summary (anchored-or-dropped)", async () => {
  const result = await buildPrNarrative(
    inputWith({
      ok: true,
      data: {
        summary: "Refactors src/totally/made-up.ts and review-surfaces.GHOST.9 across the codebase.",
        what_changed: [{ text: "valid", paths: ["src/cli/index.ts"] }],
        why_it_matters: [],
        review_first: [],
        risk_narratives: []
      }
    })
  );
  assert.ok(result.narrative);
  // The fabricated path/ACID must not survive in the most prominent field.
  assert.doesNotMatch(result.narrative!.summary, /made-up\.ts|GHOST/);
  // Replaced by the deterministic scope summary.
  assert.match(result.narrative!.summary, /changed file\(s\).*affected requirement\(s\)/);
});

test("a summary that cites ONLY allowlisted anchors is kept verbatim", async () => {
  const result = await buildPrNarrative(
    inputWith({
      ok: true,
      data: {
        summary: "Touches src/cli/index.ts for x.CLI.1.",
        what_changed: [{ text: "valid", paths: ["src/cli/index.ts"] }],
        why_it_matters: [],
        review_first: [],
        risk_narratives: []
      }
    })
  );
  assert.ok(result.narrative);
  assert.match(result.narrative!.summary, /Touches src\/cli\/index\.ts for x\.CLI\.1\./);
});

test("a risk_narrative whose TEXT cites a fabricated path is dropped (a valid risk_id does not license fabrication)", async () => {
  const result = await buildPrNarrative(
    inputWith({
      ok: true,
      data: {
        summary: "x",
        what_changed: [{ text: "valid", paths: ["src/cli/index.ts"] }],
        why_it_matters: [],
        review_first: [],
        risk_narratives: [
          { risk_id: "PR-RISK-001", text: "Also audit src/secret/backdoor.ts for leaks." }, // fabricated path
          { risk_id: "PR-RISK-001", text: "Confirm the changed surface is safe." } // clean
        ]
      }
    })
  );
  assert.ok(result.narrative);
  assert.equal(result.narrative!.risk_narratives.length, 1, "the fabricated-path narrative is dropped");
  assert.match(result.narrative!.risk_narratives[0].text, /Confirm the changed surface is safe/);
});

test("an item whose TEXT cites a fabricated ACID is dropped even when its anchors are valid", async () => {
  const result = await buildPrNarrative(
    inputWith({
      ok: true,
      data: {
        summary: "x",
        what_changed: [
          { text: "Implements review-surfaces.GHOST.9 here.", paths: ["src/cli/index.ts"] }, // fabricated ACID in text
          { text: "Touches the CLI.", paths: ["src/cli/index.ts"] } // clean
        ],
        why_it_matters: [],
        review_first: [],
        risk_narratives: []
      }
    })
  );
  assert.ok(result.narrative);
  assert.equal(result.narrative!.what_changed.length, 1);
  assert.match(result.narrative!.what_changed[0].text, /Touches the CLI/);
});

test("a runtime ai_sdk_error blocks with reason llm_failed and meta.status failed (key was present)", async () => {
  const result = await buildPrNarrative(inputWith({ ok: false, reason: "ai_sdk_error: request timed out" }));
  assert.equal(result.narrative, undefined);
  assert.equal(result.blocked_reason, "llm_failed");
  assert.equal(result.meta.status, "failed");
  assert.deepEqual(result.meta.validation_errors, ["ai_sdk_error: request timed out"]);
});

test("a missing-credential skip blocks with reason llm_unavailable and meta.status blocked", async () => {
  const result = await buildPrNarrative(inputWith({ ok: false, reason: "missing_google_api_key" }));
  assert.equal(result.narrative, undefined);
  assert.equal(result.blocked_reason, "llm_unavailable");
  assert.equal(result.meta.status, "blocked");
});
