import { test } from "node:test";
import assert from "node:assert/strict";
import { HUMAN_REVIEW_SCHEMA_VERSION } from "../src/human/contract";
import type { HumanReviewModel, SinceLastReview } from "../src/human/contract";
import { renderStickySummary, stickyQueueItemKey } from "../src/render/sticky-summary";
import { notAssessedConversationAnalysis } from "../src/conversation/analysis";
import { hostileConversationAnalysis, hostileConversationInsight } from "./helpers/conversation-review";

function emptySince(): SinceLastReview {
  return {
    improved: [],
    regressed: [],
    new_risks: [],
    resolved_risks: [],
    new_overreach: [],
    resolved_overreach: [],
    still_open: [],
    count_deltas: {
      satisfied: { before: 0, after: 0, delta: 0 },
      partial: { before: 0, after: 0, delta: 0 },
      missing: { before: 0, after: 0, delta: 0 },
      unknown: { before: 0, after: 0, delta: 0 },
      invalid_evidence: { before: 0, after: 0, delta: 0 }
    }
  };
}

function model(overrides: Partial<HumanReviewModel> = {}): HumanReviewModel {
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    mode: "pr",
    spec_mode: "acai",
    semantic_facts: { schema_changes: [], api_changes: [], test_weakening: [] },
    change_graph: { nodes: [], halo_nodes: [], edges: [], clusters: [], overview: { groups: [], halo_count: 0, edges: [] } },
    reading_order: { legs: [] },
    verdict: { decision: "reviewable_with_attention", confidence: "medium", reasons: [] },
    decision_projection: {
      active_intent: {
        summary: "Make reviewer decisions legible before supporting diagnostics.",
        source: "pull_request",
        redaction_blocked: false,
        requirement_ids: [],
        event_ids: []
      },
      findings: [{
        id: "DECISION-001",
        root_cause: "test_integrity:src/cli/index.ts",
        title: "Untested implementation change",
        path: "src/cli/index.ts",
        priority: "high",
        reason: "Implementation file changed with no focused test.",
        reviewer_action: "Add a test covering the change.",
        evidence: [{ kind: "file", path: "src/cli/index.ts", line_start: 42, confidence: "medium" }],
        requirement_ids: [],
        risk_ids: ["PR-RISK-001"],
      }]
    },
    conversation_analysis: notAssessedConversationAnalysis("mock"),
    review_insights: [],
    review_queue: [
      {
        id: "REVIEW-001",
        rank: 1,
        title: "Untested impl change",
        path: "src/cli/index.ts",
        line_start: 42,
        reviewer_action: "Add a test covering the change.",
        reason: "Implementation file changed with no focused test.",
        evidence: [{ kind: "file", path: "src/cli/index.ts", confidence: "medium" }],
        requirement_ids: ["review-surfaces.PR_SURFACE.2"],
        risk_ids: ["PR-RISK-001"],
        ranking_reasons: ["no changed test or current-head transcript covers this file, so it ranks higher"],
        confidence: "high",
        priority: "high"
      },
      {
        id: "REVIEW-002",
        rank: 2,
        title: "Renderer change",
        path: "src/render/sticky-summary.ts",
        reviewer_action: "Re-render and confirm output is byte-stable.",
        reason: "A changed file affects the review comment surface.",
        evidence: [{ kind: "file", path: "src/render/sticky-summary.ts", confidence: "medium" }],
        requirement_ids: ["review-surfaces.PR_SURFACE.2"],
        risk_ids: ["PR-RISK-002"],
        ranking_reasons: [],
        confidence: "high",
        priority: "medium"
      }
    ],
    blockers: [],
    questions: [],
    suggested_comments: [],
    trust_audit: {
      verified_facts: [{ id: "T-1", summary: "Tests pass at head.", evidence: [] }],
      claimed_not_verified: [{ id: "T-2", claim: "Coverage is adequate.", status: "unverified", missing_evidence: "no coverage report", evidence: [] }],
      missing_evidence: [{ id: "T-3", summary: "No test for the renderer.", evidence: [] }],
      invalid_evidence: [],
      confidence_summary: "Medium confidence."
    },
    risk_lens_findings: [],
    methodology_audit: { quality_flags: [], considered: [], research: [], workflow_findings: [] },
    intent_mismatch: { expected_by_spec: [], observed_in_diff: [], possible_mismatches: [], possible_overreach: [], missing_intent: [] },
    since_last_review: emptySince(),
    coverage_evidence: { status: "no_report", files: [] },
    review_plan: { enabled: false, read: [], skim: [], defer: [] },
    evidence_cards: [],
    test_plan: [],
    skim_safe: [],
    feedback_effects: [],
    generated_from: {
      packet_path: ".review-surfaces/review_packet.json",
      pr_surface_path: ".review-surfaces/pr_review_surface.json",
      base_ref: "origin/main",
      head_ref: "HEAD",
      head_sha: "deadbeef",
      uncommitted_files: 0
    },
    ...overrides,
    rounds: overrides.rounds ?? []
  };
}

function stickyInsight(index: number): NonNullable<HumanReviewModel["review_insights"]>[number] {
  return {
    id: `CONV-${index}`,
    category: "validation_gap",
    title: `Reviewer insight ${index}`,
    summary: `Claim ${index} is not established by the captured validation.`,
    why_it_matters: "The conversation promises stronger behavior than the evidence proves.",
    reviewer_action: `Inspect validation path ${index}.`,
    priority: index === 1 ? "high" : "medium",
    evidence_state: index === 1 ? "contradicted" : "unverified",
    basis: index === 1 ? "validated_anchors" : "ai_reconciliation",
    conversation_event_ids: [`evt-${index}`],
    paths: [`src/validation-${index}.ts`],
    requirement_ids: [],
    risk_ids: [],
    command_ids: [],
    evidence: []
  };
}

test("the primary sticky excludes conversation machinery when the reviewer brief already has a purpose", () => {
  const review = model({
    conversation_analysis: {
      ...notAssessedConversationAnalysis("ai-sdk"),
      status: "analyzed",
      summary: "The final request prioritizes evidence-backed reviewer value.",
      intent: [{ text: "Keep the reviewer summary compact.", event_ids: ["evt-goal"] }],
      refinements: [{ text: "Keep every finding accessible.", event_ids: ["evt-refinement"] }],
      quality_flags: ["conversation_review_commands_truncated"]
    },
    review_insights: [1, 2, 3, 4].map(stickyInsight)
  });
  const { markdown } = renderStickySummary(review);
  assert.match(markdown, /### Change purpose/);
  assert.match(markdown, /Make reviewer decisions legible/);
  assert.doesNotMatch(markdown, /Conversation-aware insights|Reviewer insight|Command transcript context/);
});

test("review-surfaces.PR_SURFACE.4 hostile conversation content is absent from the primary sticky", () => {
  const { markdown, blocked } = renderStickySummary(model({
    conversation_analysis: hostileConversationAnalysis(),
    review_insights: [hostileConversationInsight("src/cli/index.ts")]
  }));

  assert.doesNotMatch(markdown, /HOSTILE|attacker\.invalid|ordinary conversation value/i);
  assert.match(markdown, /### Change purpose/);
  assert.match(markdown, /### Approval decision/);
  assert.match(markdown, /<!-- review-surfaces:fingerprint head=deadbeef/);
  assert.equal(blocked, false);
});

test("review-surfaces.PR_SURFACE.4 excluded conversation text cannot leak through the sticky", () => {
  const leak = "ghp_" + "c".repeat(36);
  const review = model({
    conversation_analysis: {
      ...notAssessedConversationAnalysis("ai-sdk"),
      status: "analyzed",
      summary: `Conversation synopsis contained ${leak}.`,
      quality_flags: []
    }
  });

  const { markdown, blocked } = renderStickySummary(review);
  assert.doesNotMatch(markdown, /ghp_c{36}/);
  assert.doesNotMatch(markdown, /\[REDACTED:github_token\]/);
  assert.equal(blocked, false);
});

test("review-surfaces.PR_SURFACE.4 an excluded conversation redaction marker does not create a sticky blocker", () => {
  const review = model({
    conversation_analysis: {
      ...notAssessedConversationAnalysis("ai-sdk"),
      status: "analyzed",
      summary: "Provider output included [REDACTED:github_token].",
      intent: [{ text: "Preserve the reviewer-facing behavior.", event_ids: ["evt-final"] }],
      quality_flags: ["conversation_analysis_output_redacted"]
    }
  });

  const { markdown, blocked } = renderStickySummary(review);

  assert.doesNotMatch(markdown, /\[REDACTED:github_token\]/);
  assert.equal(blocked, false);
});

test("empty conversation boilerplate is omitted and the working-tree warning stays below the verdict", () => {
  const review = model();
  review.generated_from.uncommitted_files = 2;
  const { markdown } = renderStickySummary(review);
  assert.match(markdown, /includes 2 uncommitted file\(s\)/);
  assert.doesNotMatch(markdown, /### Conversation-aware insights/);
  assert.ok(markdown.indexOf("includes 2 uncommitted file(s)") < markdown.indexOf("### Change purpose"));
});

test("degraded conversation analysis remains supporting detail rather than primary sticky copy", () => {
  const review = model({
    conversation_analysis: {
      ...notAssessedConversationAnalysis("ai-sdk"),
      status: "degraded",
      summary: "Provider reconciliation failed; only partial context is available.",
      quality_flags: ["conversation_analysis_unavailable"]
    }
  });
  const { markdown } = renderStickySummary(review);
  assert.doesNotMatch(markdown, /Conversation-aware insights|Provider reconciliation failed|Degraded — incomplete/);
});

test("review-surfaces.PR_SURFACE.2 sticky renders the adaptive reviewer brief and artifact link", () => {
  const { markdown, blocked } = renderStickySummary(model(), { artifactName: "review-surfaces-pr-7" });
  assert.equal(blocked, false);
  // Marker is the first line so the workflow upsert can find the sticky.
  assert.equal(markdown.split("\n")[0], "<!-- review-surfaces:sticky -->");
  assert.match(markdown, /## review-surfaces/);
  assert.match(markdown, /\*\*Reviewable with attention\.\*\*/);
  assert.match(markdown, /### Change purpose/);
  assert.match(markdown, /### Approval decision/);
  assert.match(markdown, /Untested implementation change/);
  assert.match(markdown, /Review: Add a test covering the change\./);
  assert.match(markdown, /Evidence: `src\/cli\/index\.ts:42`/);
  assert.doesNotMatch(markdown, /### Review first|### Trust|Change map|Start reading here|Review rounds/);
  assert.match(markdown, /open the \*\*review-surfaces-pr-7\*\* workflow artifact/);
});

test("sticky links directly to the workflow run when an artifact URL is available", () => {
  const { markdown } = renderStickySummary(model(), {
    artifactName: "review-surfaces-pr-7",
    artifactUrl: "https://github.com/Shaance/review-surfaces/actions/runs/7"
  });
  assert.match(markdown, /\[\*\*review-surfaces-pr-7\*\*\]\(https:\/\/github\.com\/Shaance\/review-surfaces\/actions\/runs\/7\)/);
});

test("needs-author-clarification renders the concrete author action beside the verdict", () => {
  const { markdown } = renderStickySummary(model({
    verdict: {
      decision: "needs_author_clarification",
      confidence: "medium",
      reasons: [{
        id: "VERDICT-1",
        severity: "medium",
        summary: "Validation evidence is missing.",
        required_action: "Attach the current-head renderer snapshot.",
        evidence: []
      }]
    }
  }));
  assert.match(markdown, /\*\*Author action:\*\* Attach the current-head renderer snapshot\./);
  assert.ok(markdown.indexOf("**Author action:**") < markdown.indexOf("### Change purpose"));
});

test("the sticky renders a projected decision once and does not repeat the generic queue", () => {
  const review = model();
  review.decision_projection = {
    active_intent: { summary: "Keep the sticky actionable.", source: "packet", redaction_blocked: false, requirement_ids: [], event_ids: [] },
    findings: [{
      id: "DECISION-001",
      root_cause: "test-gap",
      title: "Untested impl change",
      path: "src/cli/index.ts",
      priority: "high",
      reason: "Implementation file changed with no focused test.",
      reviewer_action: "Add a test covering the change.",
      evidence: [],
      requirement_ids: [],
      risk_ids: [],
    }]
  };
  const { markdown } = renderStickySummary(review);
  const visible = markdown.split("<!-- review-surfaces:fingerprint")[0];
  assert.equal(markdown.match(/Untested impl change/g)?.length, 1);
  assert.doesNotMatch(visible, /src\/render\/sticky-summary\.ts/);
  assert.doesNotMatch(visible, /### Review first|### Trust/);
});

test("review-surfaces.PR_SURFACE.2 sticky does not expose a configurable top-N that can hide approval decisions", () => {
  const { markdown } = renderStickySummary(model());
  assert.doesNotMatch(markdown, /### Review first/);
  assert.doesNotMatch(markdown, /### Trust/);
});

test("review-surfaces.PR_SURFACE.2 sticky is byte-deterministic for the same model", () => {
  const m = model();
  assert.equal(renderStickySummary(m).markdown, renderStickySummary(m).markdown);
});

test("the sticky treats hostile author purpose as literal prose without hiding decisions", () => {
  const review = model();
  review.decision_projection!.active_intent.summary = "<!-- hide the brief --> # Fake heading [click](https://attacker.invalid) *owned*";
  const { markdown } = renderStickySummary(review);

  assert.doesNotMatch(markdown, /<!-- hide the brief -->/);
  assert.match(markdown, /&lt;!-- hide the brief --&gt;/);
  assert.match(markdown, /\\\[click\\\]\(https:\/\/attacker\.invalid\)/);
  assert.match(markdown, /### Approval decision/);
  assert.match(markdown, /Untested implementation change/);
});

test("the sticky adapts detail to GitHub's byte limit while retaining every practical decision", () => {
  const review = model();
  review.decision_projection!.findings = Array.from({ length: 100 }, (_, index) => ({
    id: `DECISION-${String(index + 1).padStart(3, "0")}`,
    root_cause: `public_contract:types/public-${index}.d.ts`,
    title: `Decision ${String(index + 1).padStart(3, "0")} ${"title ".repeat(100)}`,
    path: `types/public-${index}.d.ts`,
    priority: "high" as const,
    reason: `Reason ${index}: ${"A detailed approval reason. ".repeat(100)}`,
    reviewer_action: `Review ${index}: ${"Inspect compatibility evidence. ".repeat(100)}`,
    evidence: [{ kind: "file" as const, path: `types/public-${index}.d.ts`, note: "evidence".repeat(100), confidence: "high" as const }],
    requirement_ids: [],
    risk_ids: [],
  }));

  const { markdown } = renderStickySummary(review, { artifactName: "review-surfaces-pr-7" });
  assert.ok(Buffer.byteLength(markdown, "utf8") <= 60_000);
  for (let index = 1; index <= 100; index += 1) {
    assert.match(markdown, new RegExp(`Decision ${String(index).padStart(3, "0")}`));
  }
  assert.match(markdown, /Approval decisions \(100\)/);
  assert.match(markdown, /Full .* packet/);
});

test("the sticky explicitly redirects when an actionable decision brief exceeds GitHub's byte limit", () => {
  const review = model();
  review.decision_projection.findings = Array.from({ length: 200 }, (_, index) => ({
    id: `DECISION-${String(index + 1).padStart(3, "0")}`,
    root_cause: `public_contract:types/public-${index}.d.ts`,
    title: `Decision ${String(index + 1).padStart(3, "0")} ${"title ".repeat(100)}`,
    path: `types/public-${index}.d.ts`,
    priority: "high" as const,
    reason: `Reason ${index}: ${"A detailed approval reason. ".repeat(100)}`,
    reviewer_action: `Review ${index}: ${"Inspect compatibility evidence. ".repeat(100)}`,
    evidence: [{ kind: "file" as const, path: `types/public-${index}.d.ts`, note: "evidence".repeat(100), confidence: "high" as const }],
    requirement_ids: [],
    risk_ids: [],
  }));

  const { markdown } = renderStickySummary(review, { artifactName: "review-surfaces-pr-7" });
  assert.ok(Buffer.byteLength(markdown, "utf8") <= 60_000);
  assert.match(markdown, /Approval brief exceeds GitHub's physical comment limit/);
  assert.match(markdown, /200 independent approval decisions were preserved/);
  assert.match(markdown, /actionable one-line-per-decision brief exceeds GitHub's comment size limit/);
  assert.match(markdown, /review-surfaces-pr-7/);
  assert.match(markdown, /\*\*Author action:\*\*/);
  assert.doesNotMatch(markdown, /Decision 001/);
});

test("the sticky stops reading decision rows once both detail modes exceed the byte budget", () => {
  const review = model();
  review.decision_projection.findings = Array.from({ length: 201 }, (_, index) => ({
    id: `DECISION-${String(index + 1).padStart(3, "0")}`,
    root_cause: `public_contract:types/public-${index}.d.ts`,
    title: `Decision ${String(index + 1).padStart(3, "0")} ${"title ".repeat(100)}`,
    path: `types/public-${index}.d.ts`,
    priority: "high" as const,
    reason: `Reason ${index}: ${"A detailed approval reason. ".repeat(100)}`,
    reviewer_action: `Review ${index}: ${"Inspect compatibility evidence. ".repeat(100)}`,
    evidence: [{ kind: "file" as const, path: `types/public-${index}.d.ts`, confidence: "high" as const }],
    requirement_ids: [],
    risk_ids: []
  }));
  Object.defineProperty(review.decision_projection.findings, 200, {
    configurable: true,
    get: () => {
      throw new Error("renderer read beyond the proven GitHub byte budget");
    }
  });

  const { markdown } = renderStickySummary(review, { artifactName: "review-surfaces-pr-7" });
  assert.match(markdown, /201 independent approval decisions were preserved/);
  assert.ok(Buffer.byteLength(markdown, "utf8") <= 60_000);
});

test("review-surfaces.PR_SURFACE.4 sticky redacts secrets and blocks posting when a high-confidence secret survives", () => {
  const leak = "ghp_" + "a".repeat(36);
  const review = model();
  review.decision_projection!.active_intent.summary = `Token committed: ${leak}`;
  const { markdown, blocked } = renderStickySummary(review);
  // Redaction ran before the body left the renderer; the raw token never appears.
  assert.doesNotMatch(markdown, /ghp_a{36}/);
  assert.match(markdown, /\\\[REDACTED:github\\_token\\\]/);
  // The block gate trips so the caller refuses to post.
  assert.equal(blocked, true);
});

test("review-surfaces.PR_SURFACE.4 a clean model is not blocked", () => {
  assert.equal(renderStickySummary(model()).blocked, false);
});

test("review-surfaces.PR_SURFACE.5 sticky keeps purpose and decisions before the since-last-review delta", () => {
  const since: SinceLastReview = {
    ...emptySince(),
    previous_packet_path: ".rs-prev/review_packet.json",
    resolved_risks: [{ id: "S-1", category: "risk", summary: "Reviewer decision risk resolved", decision_refs: ["PR-RISK-001"], evidence: [] }],
    regressed: [{ id: "S-2", category: "requirement", summary: "RENDER.3 regressed to partial", evidence: [] }],
    new_risks: [{ id: "S-3", category: "risk", summary: "New reviewer-surface risk", decision_refs: ["PR-RISK-001"], evidence: [] }]
  };
  const { markdown } = renderStickySummary(model({ since_last_review: since }));
  const purposeIdx = markdown.indexOf("### Change purpose");
  const deltaIdx = markdown.indexOf("### Since your last review");
  assert.ok(deltaIdx > -1, "delta section present");
  assert.doesNotMatch(markdown, /### Conversation-aware insights/);
  assert.ok(purposeIdx > -1 && purposeIdx < deltaIdx, "orientation stays before the delta");
  assert.match(markdown, /✅ Resolved risks: Reviewer decision risk resolved/);
  assert.doesNotMatch(markdown, /RENDER\.3 regressed to partial/);
  assert.match(markdown, /🆕 New risks: New reviewer-surface risk/);
  assert.doesNotMatch(markdown, /<summary>Full review|### Review first|### Trust/);
});

test("review-surfaces.PR_SURFACE.5 delta correlation is exact rather than an ordinal id substring", () => {
  const since: SinceLastReview = {
    ...emptySince(),
    previous_packet_path: ".rs-prev/review_packet.json",
    new_risks: [{
      id: "SLR-NEW-RISK-PR-RISK-001",
      category: "risk",
      summary: "Unrelated ordinal-looking risk",
      evidence: []
    }]
  };
  const unrelated = renderStickySummary(model({ since_last_review: since })).markdown;
  assert.doesNotMatch(unrelated, /### Since your last review|Unrelated ordinal-looking risk/);

  since.new_risks[0].decision_refs = ["PR-RISK-001"];
  const correlated = renderStickySummary(model({ since_last_review: since })).markdown;
  assert.match(correlated, /### Since your last review/);
  assert.match(correlated, /Unrelated ordinal-looking risk/);
});

test("review-surfaces.PR_SURFACE.5 a first review shows the reviewer brief with no delta section", () => {
  const { markdown } = renderStickySummary(model());
  assert.doesNotMatch(markdown, /### Since your last review/);
  assert.doesNotMatch(markdown, /<summary>Full review/);
  assert.match(markdown, /### Change purpose/);
  assert.match(markdown, /### Approval decision/);
});

test("review-surfaces.PR_SURFACE.5 an unchanged comparison stays out of the primary brief", () => {
  const since: SinceLastReview = { ...emptySince(), previous_packet_path: ".rs-prev/review_packet.json" };
  const { markdown } = renderStickySummary(model({ since_last_review: since }));
  assert.doesNotMatch(markdown, /No requirement or risk changes since the last review/);
  assert.doesNotMatch(markdown, /### Since your last review/);
  assert.doesNotMatch(markdown, /<summary>Full review|### Review first|### Trust/);
});

test("review-surfaces.PR_SURFACE.5 the fingerprint records the run id so the next run can recover this run's artifact", () => {
  const { markdown } = renderStickySummary(model(), { runId: "987654" });
  assert.match(markdown, /<!-- review-surfaces:fingerprint head=deadbeef run=987654 queue=[a-f0-9]{20} -->/);
  // Omitted when no run id is supplied (local renders).
  assert.doesNotMatch(renderStickySummary(model()).markdown, /run=/);
});

test("review-surfaces.PR_SURFACE.4 a high-confidence secret in the change purpose trips the block gate", () => {
  const leak = "ghp_" + "b".repeat(36);
  const review = model();
  review.decision_projection!.active_intent.summary = `Rotate ${leak}`;
  const { markdown, blocked } = renderStickySummary(review);
  assert.doesNotMatch(markdown, /ghp_b{36}/);
  assert.equal(blocked, true);
});

test("review-surfaces.PR_SURFACE.5 unrelated overreach churn stays supporting", () => {
  const since: SinceLastReview = {
    ...emptySince(),
    previous_packet_path: ".rs-prev/review_packet.json",
    new_overreach: [{ id: "S-OR", category: "overreach", summary: "src/new.ts changed with no mapped intent", evidence: [] }]
  };
  const { markdown } = renderStickySummary(model({ since_last_review: since }));
  assert.doesNotMatch(markdown, /### Since your last review/);
  assert.doesNotMatch(markdown, /src\/new\.ts changed with no mapped intent/);
});

test("review-surfaces.PR_SURFACE.5 related overreach churn does not duplicate an admitted decision", () => {
  const since: SinceLastReview = {
    ...emptySince(),
    previous_packet_path: ".rs-prev/review_packet.json",
    new_overreach: [{
      id: "S-OR",
      category: "overreach",
      summary: "src/cli/index.ts changed with no mapped intent",
      path: "src/cli/index.ts",
      evidence: []
    }]
  };
  const { markdown } = renderStickySummary(model({ since_last_review: since }));
  assert.match(markdown, /### Approval decision/);
  assert.doesNotMatch(markdown, /### Since your last review/);
  assert.doesNotMatch(markdown, /src\/cli\/index\.ts changed with no mapped intent/);
});

test("review-surfaces.PR_SURFACE.5 the fingerprint sanitizes keys so a path with --> cannot close the HTML comment", () => {
  const m = model();
  m.review_queue[0].path = "src/evil-->inject.ts";
  const { markdown } = renderStickySummary(m);
  const fingerprint = markdown.split("\n").find((line) => line.includes("review-surfaces:fingerprint")) ?? "";
  // The only `-->` left is the comment terminator; the key's `-->` is neutralized.
  assert.equal(fingerprint.match(/-->/g)?.length, 1);
  assert.ok(fingerprint.endsWith("-->"));
  assert.doesNotMatch(fingerprint, /evil-->inject/);
});

test("review-surfaces.PR_SURFACE.5 the in-comment fingerprint pins the head and a bounded queue identity", () => {
  const { markdown } = renderStickySummary(model());
  assert.match(markdown, /<!-- review-surfaces:fingerprint head=deadbeef queue=[a-f0-9]{20} -->/);
  // Stable key uses rule id + path + anchor.
  assert.equal(stickyQueueItemKey(model().review_queue[0]), "PR-RISK-001:src/cli/index.ts:42");
  const fingerprint = markdown.split("\n").find((line) => line.includes("review-surfaces:fingerprint")) ?? "";
  assert.doesNotMatch(fingerprint, /src\/cli\/index\.ts/);
});

test("the physical GitHub-size fallback cannot be defeated by hostile queue fingerprints", () => {
  const review = model();
  review.review_queue = Array.from({ length: 100 }, (_, index) => ({
    ...review.review_queue[0],
    id: `REVIEW-${index}`,
    path: `src/${"oversized-".repeat(10_000)}${index}.ts`,
    hunk_header: `@@ ${"header-".repeat(10_000)} @@`
  }));
  const { markdown } = renderStickySummary(review, { runId: "9".repeat(10_000) });
  assert.ok(Buffer.byteLength(markdown, "utf8") <= 60_000);
  assert.match(markdown, /queue=[a-f0-9]{20}/);
  assert.doesNotMatch(markdown, /oversized-oversized/);
});
