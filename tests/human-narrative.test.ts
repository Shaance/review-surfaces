import test from "node:test";
import assert from "node:assert/strict";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { buildChangeNarrative, buildNarrativeAllowlist } from "../src/human/narrative";
import { buildHumanReview } from "../src/human/human-review";
import { renderHumanReviewMarkdown } from "../src/human/render";
import { renderHumanReviewHtml } from "../src/human/render-html";
import type { ReasoningProvider, StructuredResult } from "../src/llm/provider";
import type { ReviewPacket } from "../src/render/packet";
import type { ChangeNarrative } from "../src/human/contract";
import { minimalReviewPacket } from "./helpers/review-packet";

// ---------------------------------------------------------------------------
// review-surfaces.NARRATIVE.1-5 — grounded change narrative with per-claim trust.
// ---------------------------------------------------------------------------

// A packet whose evaluation cites two ACIDs (the anchor allowlist), plus a
// diff that changes one real file.
function narrativeFacts(): { packet: ReviewPacket; diff: ReturnType<typeof parseStructuredDiff> } {
  const packet = minimalReviewPacket() as unknown as ReviewPacket;
  packet.evaluation.results = [
    {
      requirement_id: "REQ-1",
      acai_id: "review-surfaces.NARRATIVE.1",
      status: "missing",
      summary: "Narrative not implemented.",
      evidence: [],
      missing_evidence: [],
      review_focus: "",
      confidence: "medium"
    },
    {
      requirement_id: "REQ-2",
      acai_id: "review-surfaces.NARRATIVE.2",
      status: "partial",
      summary: "Anchor validation partial.",
      evidence: [],
      missing_evidence: [],
      review_focus: "",
      confidence: "medium"
    }
  ];
  const diff = parseStructuredDiff(
    ["diff --git a/src/real.ts b/src/real.ts", "--- a/src/real.ts", "+++ b/src/real.ts", "@@ -1,1 +1,1 @@", "-const a = 0;", "+const a = 1;", ""].join("\n")
  );
  return { packet, diff };
}

function stubProvider(data: unknown): ReasoningProvider {
  return {
    name: "agent-file",
    async generateStructured(): Promise<StructuredResult> {
      return { ok: true, data };
    }
  };
}

// review-surfaces.NARRATIVE.2/.3 (acceptance): an agent-file narrative with one
// valid-anchor claim and one bogus-path claim marks the first verified and
// DEMOTES the second to claimed with the invalid anchor surfaced.
test("review-surfaces.NARRATIVE.2 demotes (not drops) a claim with a bogus anchor", async () => {
  const { packet, diff } = narrativeFacts();
  const provider = stubProvider({
    claims: [
      { text: "Changes the real implementation file.", paths: ["src/real.ts"], requirement_ids: ["review-surfaces.NARRATIVE.1"] },
      { text: "Also edits a file that does not exist.", paths: ["src/fabricated.ts"] }
    ]
  });
  const narrative = await buildChangeNarrative({
    provider,
    providerName: "agent-file",
    packet,
    diff,
    headSha: "head123",
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.ok(narrative, "usable provider claims produce a narrative");
  assert.equal(narrative.source, "provider");
  assert.equal(narrative.claims.length, 2, "both claims are kept; the bogus one is demoted, not dropped");
  assert.equal(narrative.claims[0].trust, "verified");
  assert.ok(narrative.claims[0].anchors.some((ref) => ref.path === "src/real.ts"));
  assert.equal(narrative.claims[1].trust, "claimed");
  assert.deepEqual(narrative.claims[1].invalid_anchors, ["src/fabricated.ts"]);

  // The supporting HTML shows ✓ and ~ markers and lists the invalid anchor;
  // compact Markdown delegates narrative detail to supporting artifacts.
  const model = buildHumanReview({ packet, diff, narrative });
  const html = renderHumanReviewHtml(model);
  assert.match(html, /✓ Changes the real implementation file\./);
  assert.match(html, /~ Also edits a file that does not exist\./);
  assert.match(html, /unverified anchor\(s\): <code>src\/fabricated\.ts<\/code>/);
  assert.doesNotMatch(renderHumanReviewMarkdown(model), /## Change narrative|fabricated\.ts/);
});

// review-surfaces.NARRATIVE.3: the rendered narrative marks the trust state of
// each claim (verified vs claimed) so a reviewer sees at a glance which
// sentences are evidence-backed.
test("review-surfaces.NARRATIVE.3 marks the trust state of every claim", () => {
  const narrative: ChangeNarrative = {
    source: "provider",
    provider: "agent-file",
    validated_at_head: "head123",
    claims: [
      { id: "NARR-001", text: "A verified claim.", trust: "verified", anchors: [{ kind: "file", path: "src/real.ts", confidence: "high", validation_status: "valid" }], invalid_anchors: [] },
      { id: "NARR-002", text: "A claimed claim.", trust: "claimed", anchors: [], invalid_anchors: ["src/fake.ts"] }
    ]
  };
  const { packet, diff } = narrativeFacts();
  const html = renderHumanReviewHtml(buildHumanReview({ packet, diff, narrative }));
  // The verified claim is marked ✓ and the claimed claim ~ — distinct markers.
  assert.match(html, /<li>✓ A verified claim\./, "verified claims get the ✓ marker");
  assert.match(html, /<li>~ A claimed claim\./, "claimed claims get the ~ marker");
  assert.match(html, /✓ anchored .*~ claimed/, "the legend explains anchor validation without claiming independent proof");
});

// review-surfaces.NARRATIVE.2: a fabricated CMD- transcript id in the PROSE
// demotes the claim even when it also cites a valid path anchor.
test("review-surfaces.NARRATIVE.2 fabricated command id in prose demotes the claim", async () => {
  const { packet, diff } = narrativeFacts();
  const narrative = await buildChangeNarrative({
    provider: stubProvider({ claims: [{ text: "Runs CMD-FABRICATED-TEST to validate src/real.ts.", paths: ["src/real.ts"] }] }),
    providerName: "agent-file",
    packet,
    diff,
    headSha: "head123",
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.ok(narrative, "usable provider claims produce a narrative");
  assert.equal(narrative.claims[0].trust, "claimed", "a fabricated CMD- in prose demotes the claim");
  assert.ok(narrative.claims[0].invalid_anchors.includes("CMD-FABRICATED-TEST"));
});

// review-surfaces.NARRATIVE.2: a command transcript recorded under
// risks.test_evidence is a valid anchor (its CMD- id is allowlisted).
test("review-surfaces.NARRATIVE.2 allowlists command transcripts from test evidence", async () => {
  const { packet, diff } = narrativeFacts();
  packet.risks.test_evidence = [
    { id: "CMD-PNPM-TEST", kind: "direct", summary: "pnpm run test passed.", evidence: [{ kind: "command", command: "pnpm run test", event_id: "CMD-PNPM-TEST", confidence: "high", validation_status: "valid" }] }
  ] as ReviewPacket["risks"]["test_evidence"];
  const narrative = await buildChangeNarrative({
    provider: stubProvider({ claims: [{ text: "Validated by the recorded test transcript.", command_ids: ["CMD-PNPM-TEST"] }] }),
    providerName: "agent-file",
    packet,
    diff,
    headSha: "head123",
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.ok(narrative, "usable provider claims produce a narrative");
  assert.equal(narrative.claims[0].trust, "verified", "a CMD- id from test_evidence is a valid anchor");
  assert.ok(narrative.claims[0].anchors.some((ref) => ref.command === "CMD-PNPM-TEST"));
});

// review-surfaces.NARRATIVE.2: a non-CMD test-evidence row id (e.g. a parsed
// TEST-RESULT-001) is also a valid command anchor.
test("review-surfaces.NARRATIVE.2 allowlists non-CMD test-evidence row ids", async () => {
  const { packet, diff } = narrativeFacts();
  packet.risks.test_evidence = [
    { id: "TEST-RESULT-001", kind: "direct", summary: "Parsed passing test case.", evidence: [{ kind: "test", test_name: "passes", confidence: "high", validation_status: "valid" }] }
  ] as ReviewPacket["risks"]["test_evidence"];
  const narrative = await buildChangeNarrative({
    provider: stubProvider({ claims: [{ text: "Backed by a parsed test case.", command_ids: ["TEST-RESULT-001"] }] }),
    providerName: "agent-file",
    packet,
    diff,
    headSha: "head123",
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.ok(narrative, "usable provider claims produce a narrative");
  assert.equal(narrative.claims[0].trust, "verified", "a real test-evidence row id is a valid anchor");
});

// review-surfaces.NARRATIVE.2: an unproven test-evidence row (claimed/missing/
// unknown) is NOT a verified command anchor.
test("review-surfaces.NARRATIVE.2 unproven test-evidence ids do not verify a claim", async () => {
  const { packet, diff } = narrativeFacts();
  packet.risks.test_evidence = [
    { id: "CMD-FLAKY-TEST", kind: "claimed", summary: "Claimed-only validation.", evidence: [] }
  ] as ReviewPacket["risks"]["test_evidence"];
  const narrative = await buildChangeNarrative({
    provider: stubProvider({ claims: [{ text: "Backed by a claimed-only transcript.", command_ids: ["CMD-FLAKY-TEST"] }] }),
    providerName: "agent-file",
    packet,
    diff,
    headSha: "head123",
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.ok(narrative, "usable provider claims produce a narrative");
  assert.equal(narrative.claims[0].trust, "claimed", "an unproven test-evidence id must not become a verified anchor");
  assert.ok(narrative.claims[0].invalid_anchors.includes("CMD-FLAKY-TEST"));
});

// review-surfaces.NARRATIVE.2: a fabricated non-CMD test id mentioned only in
// prose demotes the claim.
test("review-surfaces.NARRATIVE.2 fabricated non-CMD test id in prose demotes the claim", async () => {
  const { packet, diff } = narrativeFacts();
  const narrative = await buildChangeNarrative({
    provider: stubProvider({ claims: [{ text: "Validated by TEST-RESULT-999 against src/real.ts.", paths: ["src/real.ts"] }] }),
    providerName: "agent-file",
    packet,
    diff,
    headSha: "head123",
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.ok(narrative, "usable provider claims produce a narrative");
  assert.equal(narrative.claims[0].trust, "claimed", "a fabricated TEST-* id in prose demotes the claim");
  assert.ok(narrative.claims[0].invalid_anchors.includes("TEST-RESULT-999"));
});

// review-surfaces.NARRATIVE.2: a secret-looking invalid anchor is redacted, not
// stored verbatim.
test("review-surfaces.NARRATIVE.2 redacts secret-looking invalid anchors", async () => {
  const { packet, diff } = narrativeFacts();
  const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const narrative = await buildChangeNarrative({
    provider: stubProvider({ claims: [{ text: "Cites a token path.", paths: [token] }] }),
    providerName: "agent-file",
    packet,
    diff,
    headSha: "head123",
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.ok(narrative, "usable provider claims produce a narrative");
  assert.ok(!narrative.claims[0].invalid_anchors.includes(token), "the raw secret must not be stored");
  assert.ok(narrative.claims[0].invalid_anchors.some((v) => v.includes("REDACTED")), "the invalid anchor is redacted");
});

// review-surfaces.NARRATIVE.2: a fabricated NUMERIC transcript id (CMD-001) in
// prose demotes the claim.
test("review-surfaces.NARRATIVE.2 fabricated numeric command id in prose demotes the claim", async () => {
  const { packet, diff } = narrativeFacts();
  const narrative = await buildChangeNarrative({
    provider: stubProvider({ claims: [{ text: "Validated by CMD-001 against src/real.ts.", paths: ["src/real.ts"] }] }),
    providerName: "agent-file",
    packet,
    diff,
    headSha: "head123",
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.ok(narrative, "usable provider claims produce a narrative");
  assert.equal(narrative.claims[0].trust, "claimed", "a fabricated numeric CMD-001 in prose demotes the claim");
  assert.ok(narrative.claims[0].invalid_anchors.includes("CMD-001"));
});

// review-surfaces.NARRATIVE.2: a command id recorded in risk/evaluation evidence
// that is NOT validation_status "valid" (e.g. a failed transcript) is not an
// allowlisted command anchor.
test("review-surfaces.NARRATIVE.2 restricts command anchors to proven (valid) evidence", () => {
  const { packet, diff } = narrativeFacts();
  packet.risks.items = [
    { evidence: [{ kind: "command", command: "CMD-FAILED-001", confidence: "low", validation_status: "not_checked" }] }
  ] as unknown as ReviewPacket["risks"]["items"];
  const allowlist = buildNarrativeAllowlist({ packet, diff, headSha: "head123" });
  assert.ok(!allowlist.commandIds.has("CMD-FAILED-001"), "an unproven command ref must not be an anchor");
});

// review-surfaces.NARRATIVE.2: a feedback-only test-evidence row (no transcript /
// parsed-test ref) is not a verified command anchor.
test("review-surfaces.NARRATIVE.2 excludes feedback-only rows from command anchors", () => {
  const { packet, diff } = narrativeFacts();
  packet.risks.test_evidence = [
    { id: "TEST-FB-001", kind: "indirect", summary: "Feedback records a passing command.", evidence: [{ kind: "feedback", path: "feedback/x.yaml", confidence: "low", validation_status: "not_checked" }] }
  ] as ReviewPacket["risks"]["test_evidence"];
  const allowlist = buildNarrativeAllowlist({ packet, diff, headSha: "head123" });
  assert.ok(!allowlist.commandIds.has("TEST-FB-001"), "a feedback-only row id must not be a command anchor");
});

// review-surfaces.NARRATIVE.2: a malformed structured anchor (a non-string
// element in an unvalidated agent payload) demotes the claim.
test("review-surfaces.NARRATIVE.2 demotes a claim with a malformed structured anchor", async () => {
  const { packet, diff } = narrativeFacts();
  const narrative = await buildChangeNarrative({
    // 123 is a non-string element a schema-unvalidated agent-file payload can carry.
    provider: stubProvider({ claims: [{ text: "Edits the real file.", paths: ["src/real.ts", 123] }] }),
    providerName: "agent-file",
    packet,
    diff,
    headSha: "head123",
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.ok(narrative, "usable provider claims produce a narrative");
  assert.equal(narrative.claims[0].trust, "claimed", "a malformed anchor element must demote the claim");
  assert.ok(narrative.claims[0].invalid_anchors.some((v) => /malformed/.test(v)));
});

// review-surfaces.NARRATIVE.2: a FAILED command transcript (valid command ref but
// row kind "missing") is not a verified command anchor.
test("review-surfaces.NARRATIVE.2 excludes failed transcript rows from command anchors", () => {
  const { packet, diff } = narrativeFacts();
  packet.risks.test_evidence = [
    { id: "TEST-TR-001", kind: "missing", summary: "pnpm run test failed.", evidence: [{ kind: "command", command: "pnpm run test", event_id: "CMD-FAILED-1", confidence: "high", validation_status: "valid" }] }
  ] as ReviewPacket["risks"]["test_evidence"];
  const allowlist = buildNarrativeAllowlist({ packet, diff, headSha: "head123" });
  assert.ok(!allowlist.commandIds.has("TEST-TR-001"), "a failed (missing-kind) transcript row must not be an anchor");
  assert.ok(!allowlist.commandIds.has("CMD-FAILED-1"));
});

// review-surfaces.NARRATIVE.2: a custom transcript id (not CMD-/TEST-shaped) is
// preserved in the allowlist from event_id.
test("review-surfaces.NARRATIVE.2 allowlists custom transcript event ids", () => {
  const { packet, diff } = narrativeFacts();
  packet.risks.test_evidence = [
    { id: "TEST-TR-001", kind: "direct", summary: "Smoke transcript.", evidence: [{ kind: "command", command: "pnpm smoke", event_id: "smoke_1", confidence: "high", validation_status: "valid" }] }
  ] as ReviewPacket["risks"]["test_evidence"];
  const allowlist = buildNarrativeAllowlist({ packet, diff, headSha: "head123" });
  assert.ok(allowlist.commandIds.has("smoke_1"), "a custom transcript event id must be allowlisted");
});

// review-surfaces.NARRATIVE.4: the narrative never alters the verdict.
test("review-surfaces.NARRATIVE.4 narrative does not change the verdict", () => {
  const { packet, diff } = narrativeFacts();
  const withoutNarrative = buildHumanReview({ packet, diff });
  const tamperingNarrative: ChangeNarrative = {
    source: "provider",
    provider: "agent-file",
    validated_at_head: "head123",
    claims: [
      { id: "NARR-001", text: "Everything is perfectly safe to merge.", trust: "claimed", anchors: [], invalid_anchors: [] }
    ]
  };
  const withNarrative = buildHumanReview({ packet, diff, narrative: tamperingNarrative });
  assert.deepEqual(withNarrative.verdict, withoutNarrative.verdict, "the verdict must be identical regardless of narrative");
  assert.deepEqual(withNarrative.blockers, withoutNarrative.blockers, "blockers must be unchanged");
});

// review-surfaces.NARRATIVE.5: unavailable provider prose is omitted without
// weakening or failing the deterministic reviewer brief.
test("review-surfaces.NARRATIVE.5 unavailable provider prose is omitted", async () => {
  const { packet, diff } = narrativeFacts();
  const mockProvider: ReasoningProvider = {
    name: "mock",
    async generateStructured(): Promise<StructuredResult> {
      return { ok: false, reason: "mock_no_enrichment" };
    }
  };
  const mockNarrative = await buildChangeNarrative({
    provider: mockProvider,
    providerName: "mock",
    packet,
    diff,
    headSha: "head123",
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.equal(mockNarrative, undefined, "mock mode does not synthesize aggregate prose");

  const rejecting: ReasoningProvider = {
    name: "agent-file",
    async generateStructured(): Promise<StructuredResult> {
      return { ok: false, reason: "agent_input_not_found" };
    }
  };
  const rejectedNarrative = await buildChangeNarrative({
    provider: rejecting,
    providerName: "agent-file",
    packet,
    diff,
    headSha: "head123",
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.equal(rejectedNarrative, undefined, "rejected provider output is omitted");
});

// review-surfaces.NARRATIVE.1: the section is capped to max_claims.
test("review-surfaces.NARRATIVE.1 caps the rendered claims at max_claims", async () => {
  const { packet, diff } = narrativeFacts();
  const claims = Array.from({ length: 12 }, (_unused, i) => ({
    text: `Claim ${i + 1} about the change.`,
    paths: ["src/real.ts"]
  }));
  const narrative = await buildChangeNarrative({
    provider: stubProvider({ claims }),
    providerName: "agent-file",
    packet,
    diff,
    headSha: "head123",
    maxClaims: 3,
    redactSecrets: true,
    remotePrivacyBlocked: false
  });
  assert.ok(narrative, "usable provider claims produce a narrative");
  assert.equal(narrative.claims.length, 3, "claims are capped at max_claims");
});

// review-surfaces.NARRATIVE.5: the model and Markdown omit the optional section
// when no validated provider prose exists.
test("review-surfaces.NARRATIVE.5 buildHumanReview omits absent narrative", () => {
  const { packet, diff } = narrativeFacts();
  const model = buildHumanReview({ packet, diff });
  assert.equal(model.narrative, undefined);
  assert.doesNotMatch(renderHumanReviewMarkdown(model), /## Change narrative/);
});
