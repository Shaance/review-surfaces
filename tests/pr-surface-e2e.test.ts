import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { validateJsonSchema } from "../src/schema/json-schema";
import { HUMAN_STANDALONE_ARTIFACTS } from "../src/human/render";
import { ExitCodes } from "../src/core/exit-codes";
import {
  HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS,
  hostileConversationBackslashRun,
  hostileConversationDisclosureClosesBeforeHeading,
  hostileConversationAnalysis,
  hostileConversationInsight,
  hostileConversationTitleClosesEmphasis
} from "./helpers/conversation-review";
import { isLocalRuntimeArtifactPath } from "./helpers/cli-repo";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");
const CHANGED = "src/render/sticky-summary.ts";
const HUMAN_REVIEW_SCHEMA = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));

// Copy the repo (minus .git/.review-surfaces/dist), init git, commit a baseline,
// then introduce ONE uncommitted change so there is a real diff to scope.
function setupChangedRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-pr-e2e-"));
  fs.cpSync(process.cwd(), tmp, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(process.cwd(), source);
      return (
        rel !== ".git" && !rel.startsWith(`.git${path.sep}`) &&
        !isLocalRuntimeArtifactPath(rel) &&
        rel !== ".review-surfaces" && !rel.startsWith(`.review-surfaces${path.sep}`) &&
        rel !== "dist" && !rel.startsWith(`dist${path.sep}`)
      );
    }
  });
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
  // One uncommitted change -> the diff scopes to the RENDER area.
  fs.appendFileSync(path.join(tmp, CHANGED), "\n// pr-surface e2e marker\n");
  return tmp;
}

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function assertInlineApprovalBrief(cwd: string, comment: string): void {
  const human = JSON.parse(fs.readFileSync(path.join(cwd, ".review-surfaces", "human_review.json"), "utf8"));
  const count = human.decision_projection.findings.length;
  const heading = count === 1 ? "Approval decision" : count > 1 ? `Approval decisions (${count})` : "Approval decisions";
  assert.ok(comment.includes(`### ${heading}`), `sticky should render the adaptive ${heading} heading`);
  assert.equal(
    comment.match(/^\d+\. \*\*/gm)?.length ?? 0,
    count,
    "every independent approval decision should be visible in the sticky"
  );
  assert.doesNotMatch(comment, /exceeds GitHub's physical comment limit/);
}

const PROVIDER_STAGE_PREFIX = "__review_surfaces_provider_stage__:";

function countingProviderPreload(directory: string, conversationEventId: string): string {
  const preloadPath = path.join(directory, "counting-provider.cjs");
  const providerModulePath = path.join(process.cwd(), "dist", "src", "llm", "provider.js");
  const responses: Record<string, unknown> = {
    human_narrative: {
      claims: [{ text: `${CHANGED} changes the reviewer-facing brief.`, paths: [CHANGED] }]
    },
    conversation_analysis: {
      summary: "The user asked to preserve the reviewer-facing renderer behavior.",
      intent: [{ text: "Preserve the reviewer-facing renderer behavior.", event_ids: [conversationEventId] }],
      refinements: [],
      decisions: [],
      constraints: [],
      non_goals: [],
      rejected_alternatives: [],
      claims: [],
      validation_claims: [],
      known_gaps: []
    },
    conversation_review_insights: { insights: [] }
  };
  const preload = [
    '"use strict";',
    `const providerModule = require(${JSON.stringify(providerModulePath)});`,
    "const originalProviderFor = providerModule.providerFor;",
    `const responses = ${JSON.stringify(responses)};`,
    "const countingProvider = {",
    '  name: "ai-sdk",',
    "  async generateStructured(stage) {",
    `    process.stderr.write(${JSON.stringify(PROVIDER_STAGE_PREFIX)} + stage + "\\n");`,
    "    if (Object.prototype.hasOwnProperty.call(responses, stage)) {",
    "      return { ok: true, data: responses[stage] };",
    "    }",
    '    return { ok: false, reason: "test_no_contribution" };',
    "  }",
    "};",
    "providerModule.providerFor = (name, options) =>",
    '  name === "ai-sdk" ? countingProvider : originalProviderFor(name, options);',
    ""
  ].join("\n");
  fs.writeFileSync(preloadPath, preload);
  return preloadPath;
}

function countedProviderStages(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith(PROVIDER_STAGE_PREFIX))
    .map((line) => line.slice(PROVIDER_STAGE_PREFIX.length));
}

const ALL_PR = ["all", "--review-scope", "pr", "--base", "HEAD", "--head", "HEAD", "--spec", "features/review-surfaces.feature.yaml", "--out", ".review-surfaces"];

test("a no-diff PR emits no sticky and removes a stale local comment artifact", () => {
  const tmp = setupChangedRepo();
  try {
    execFileSync("git", ["checkout", "--", CHANGED], { cwd: tmp, stdio: "ignore" });
    const generated = runCli(tmp, [...ALL_PR, "--provider", "mock"]);
    assert.equal(generated.status, 0, generated.stderr);
    const surface = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "pr_review_surface.json"), "utf8"));
    assert.equal(surface.status, "blocked");
    assert.equal(surface.blocked_reason, "no_diff");

    const commentPath = path.join(tmp, ".review-surfaces", "comment.md");
    fs.writeFileSync(commentPath, "stale sticky");
    const comment = runCli(tmp, ["comment", "--review-scope", "pr", "--format", "sticky", "--out", ".review-surfaces"]);
    assert.equal(comment.status, 0, comment.stderr);
    assert.equal(comment.stdout, "");
    assert.match(comment.stderr, /no sticky was generated/);
    assert.equal(fs.existsSync(commentPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("all --review-scope pr writes a deterministic, LLM-optional reviewer surface", () => {
  const tmp = setupChangedRepo();
  try {
    const run = runCli(tmp, [...ALL_PR, "--provider", "mock"]);
    assert.equal(run.status, 0, run.stderr);
    // review-surfaces.HUMAN_REVIEW.15: `all` should point reviewers at the
    // human cockpit summary rather than making agent handoff the default path.
    assert.match(run.stdout, /Wrote review-surfaces artifacts to \.review-surfaces/);
    assert.match(run.stdout, /Human review: \.review-surfaces\/human_review\.md/);
    assert.ok(
      run.stdout.indexOf("Human review: .review-surfaces/human_review.md") < run.stdout.indexOf("Wrote review-surfaces artifacts to .review-surfaces"),
      "the human review entrypoint should be printed before secondary artifact status"
    );
    assert.match(run.stdout, /Change purpose: /);
    assert.match(run.stdout, /Verdict: [a-z_]+/);
    assert.match(run.stdout, /Approval decisions: \d+/);
    assert.doesNotMatch(run.stdout, /agent_handoff\.md/);
    const surface = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "pr_review_surface.json"), "utf8"));
    const human = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    const humanMarkdown = fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.md"), "utf8");
    assert.equal(validateJsonSchema(HUMAN_REVIEW_SCHEMA, human).valid, true);
    assert.equal(human.mode, "pr");
    assert.equal(human.generated_from.base_sha, surface.scope.base_sha);
    const changedQueueItem = human.review_queue.find((item: { path: string }) => item.path === CHANGED);
    assert.ok(changedQueueItem, "human review queue should include the changed renderer file");
    assert.match(changedQueueItem.hunk_header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    assert.ok(changedQueueItem.line_start > 0, "human review queue should include a diff-derived line anchor");
    assert.match(humanMarkdown, /^# Human Review/);
    assert.match(humanMarkdown, /## Verdict/);
    assert.match(humanMarkdown, /## Approval decisions/);
    for (const artifact of HUMAN_STANDALONE_ARTIFACTS) {
      const body = fs.readFileSync(path.join(tmp, ".review-surfaces", artifact.artifact), "utf8");
      assert.match(
        body,
        new RegExp(`^${artifact.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        `${artifact.artifact} should be rendered from human_review.json`
      );
    }
    const markerByCommand: Record<string, string> = {
      queue: "JSON sentinel queue title",
      comments: "JSON sentinel suggested comment",
      trust: "JSON sentinel trust summary",
      "risk-lenses": "JSON sentinel risk lens",
      "intent-mismatch": "JSON sentinel intent mismatch",
      "evidence-cards": "JSON sentinel evidence card",
      "since-last-review": "JSON sentinel since last review",
      "test-plan": "JSON sentinel test plan"
    };
    for (const artifact of HUMAN_STANDALONE_ARTIFACTS) {
      const marker = markerByCommand[artifact.command];
      if (artifact.command === "queue") {
        human.review_queue[0].title = marker;
      } else if (artifact.command === "comments") {
        human.suggested_comments[0] = {
          id: "SC-SENTINEL",
          severity: "clarifying",
          body: marker,
          evidence: [{ kind: "unknown", confidence: "low", note: "JSON sentinel evidence." }],
          risk_ids: [],
          requirement_ids: [],
          confidence: "low",
          ready_to_post: true
        };
      } else if (artifact.command === "trust") {
        human.trust_audit.confidence_summary = marker;
      } else if (artifact.command === "risk-lenses") {
        human.risk_lens_findings = [
          {
            id: "LENS-SENTINEL",
            lens: "custom",
            severity: "low",
            summary: marker,
            reviewer_action: "Focused renderer reads human_review.json.",
            evidence: [{ kind: "unknown", confidence: "low", note: "JSON sentinel evidence." }],
            suggested_tests: [],
            suggested_comments: [],
            risk_ids: [],
            requirement_ids: [],
            paths: [],
            confidence: "low"
          }
        ];
      } else if (artifact.command === "intent-mismatch") {
        human.intent_mismatch = {
          expected_by_spec: [
            {
              id: "INTENT-SENTINEL",
              summary: marker,
              evidence: [{ kind: "unknown", confidence: "low", note: "JSON sentinel evidence." }],
              requirement_ids: [],
              paths: [],
              confidence: "low"
            }
          ],
          observed_in_diff: [],
          possible_mismatches: [],
          possible_overreach: [],
          missing_intent: []
        };
      } else if (artifact.command === "evidence-cards") {
        human.evidence_cards = [
          {
            id: "CARD-SENTINEL",
            title: marker,
            status: "missing_evidence",
            summary: marker,
            direct_evidence: [{ kind: "file", path: "src/sentinel.ts", confidence: "medium", validation_status: "not_checked" }],
            missing_evidence: [{ kind: "unknown", confidence: "unknown", validation_status: "unknown", note: "JSON sentinel missing evidence." }],
            invalid_evidence: [],
            why_it_matters: "Focused renderer reads human_review.json.",
            reviewer_action: marker,
            source_ids: ["CARD-SENTINEL"],
            risk_ids: [],
            requirement_ids: [],
            confidence: "medium",
            priority: "medium"
          }
        ];
      } else if (artifact.command === "since-last-review") {
        human.since_last_review = {
          previous_packet_path: ".review-surfaces-prev/review_packet.json",
          improved: [
            {
              id: "SLR-SENTINEL",
              category: "requirement",
              summary: marker,
              evidence: [{ kind: "unknown", confidence: "low", note: "JSON sentinel evidence." }]
            }
          ],
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
      } else if (artifact.command === "test-plan") {
        human.test_plan[0] = {
          id: "TEST-SENTINEL",
          kind: "automatic",
          priority: "recommended",
          scenario: marker,
          expected_result: "Focused renderer reads human_review.json.",
          maps_to_requirements: [],
          maps_to_risks: [],
          evidence_gap: "JSON sentinel evidence gap."
        };
      }
      fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(human, null, 2));
      const target = path.join(tmp, ".review-surfaces", artifact.artifact);
      fs.writeFileSync(target, "stale artifact");
      const subcommand = runCli(tmp, [artifact.command, "--review-scope", "pr", "--out", ".review-surfaces"]);
      assert.equal(subcommand.status, 0, subcommand.stderr);
      assert.match(subcommand.stdout, new RegExp(`${artifact.label}: \\.review-surfaces/`));
      const focusedBody = fs.readFileSync(target, "utf8");
      assert.match(focusedBody, new RegExp(`^${artifact.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(focusedBody, new RegExp(marker));
    }
    human.review_queue[0].title = "JSON sentinel PR comment queue";
    human.suggested_comments[0] = {
      id: "SC-PR-COMMENT-SENTINEL",
      severity: "clarifying",
      path: CHANGED,
      body: "JSON sentinel PR comment draft",
      evidence: [{ kind: "unknown", confidence: "low", note: "JSON sentinel comment evidence." }],
      risk_ids: [],
      requirement_ids: [],
      confidence: "low",
      ready_to_post: true
    };
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(human, null, 2));
    const humanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    // review-surfaces.RENDER.8: a local render without --post writes the comment
    // and exits 0; the not-postable warning is still printed.
    assert.equal(humanPrComment.status, 0, "local PR comment render without --post succeeds (RENDER.8)");
    assert.doesNotMatch(humanPrComment.stdout, /JSON sentinel PR comment queue/, "a queue item already projected into decision findings is not repeated under Review first");
    assert.doesNotMatch(humanPrComment.stdout, /JSON sentinel PR comment draft/, "draft comments stay in supporting artifacts");
    assertInlineApprovalBrief(tmp, humanPrComment.stdout);
    assert.doesNotMatch(humanPrComment.stderr, /not postable/);
    // Provider availability is not a postability gate; strict mode still runs
    // the actual redaction/truth checks and succeeds for this clean brief.
    const strictPostability = runCli(tmp, ["comment", "--review-scope", "pr", "--strict-postability", "--out", ".review-surfaces"]);
    assert.equal(strictPostability.status, 0);
    assert.doesNotMatch(strictPostability.stderr, /not postable/);
    // A PR comment has one product path: a current, schema-valid human brief.
    // Stale or malformed briefs fail closed instead of replacing the decision
    // surface with a marker-bearing sidecar diagnostic.
    const priorIntentHuman = { ...human };
    delete priorIntentHuman.intent_mismatch;
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(priorIntentHuman, null, 2));
    const staleIntentHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleIntentHumanPrComment.status, ExitCodes.schemaValidationFailed);
    assert.match(staleIntentHumanPrComment.stderr, /Human reviewer brief failed schema validation.*intent_mismatch/);
    assert.equal(staleIntentHumanPrComment.stdout, "");
    assert.doesNotMatch(staleIntentHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    const staleHuman = {
      ...human,
      generated_from: { ...human.generated_from, base_ref: "refs/stale-base" }
    };
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(staleHuman, null, 2));
    const staleHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleHumanPrComment.status, ExitCodes.usageError);
    assert.equal(staleHumanPrComment.stdout, "");
    assert.match(staleHumanPrComment.stderr, /Human reviewer brief is stale or belongs to a different scope/);
    assert.doesNotMatch(staleHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    const staleBaseShaHuman = {
      ...human,
      generated_from: { ...human.generated_from, base_sha: "stale-base-sha" }
    };
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(staleBaseShaHuman, null, 2));
    const staleBaseShaHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleBaseShaHumanPrComment.status, ExitCodes.usageError);
    assert.equal(staleBaseShaHumanPrComment.stdout, "");
    assert.match(staleBaseShaHumanPrComment.stderr, /Human reviewer brief is stale or belongs to a different scope/);
    assert.doesNotMatch(staleBaseShaHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    const surfacePath = path.join(tmp, ".review-surfaces", "pr_review_surface.json");
    const sameHeadChangedSurface = structuredClone(surface);
    sameHeadChangedSurface.change_context = {
      title: "Same head, newly clarified author purpose",
      description: "The sidecar changed after the human brief was generated.",
      source: "cli",
      redaction_blocked: false
    };
    fs.writeFileSync(surfacePath, JSON.stringify(sameHeadChangedSurface, null, 2));
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(human, null, 2));
    const staleSameHeadHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleSameHeadHumanPrComment.status, ExitCodes.usageError);
    assert.equal(staleSameHeadHumanPrComment.stdout, "");
    assert.match(staleSameHeadHumanPrComment.stderr, /Human reviewer brief is stale or belongs to a different scope/);
    assert.doesNotMatch(staleSameHeadHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    fs.writeFileSync(surfacePath, JSON.stringify(surface, null, 2));
    const sameHeadChangedRiskSurface = structuredClone(surface);
    sameHeadChangedRiskSurface.risks = {
      ...sameHeadChangedRiskSurface.risks,
      summary: "Same head, changed decision inputs.",
      candidates: []
    };
    fs.writeFileSync(surfacePath, JSON.stringify(sameHeadChangedRiskSurface, null, 2));
    const staleSameHeadRiskHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleSameHeadRiskHumanPrComment.status, ExitCodes.usageError);
    assert.equal(staleSameHeadRiskHumanPrComment.stdout, "");
    assert.match(staleSameHeadRiskHumanPrComment.stderr, /Human reviewer brief is stale or belongs to a different scope/);
    assert.doesNotMatch(staleSameHeadRiskHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    fs.writeFileSync(surfacePath, JSON.stringify(surface, null, 2));
    const legacyNoBaseShaHuman = {
      ...human,
      generated_from: { ...human.generated_from }
    };
    delete legacyNoBaseShaHuman.generated_from.base_sha;
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(legacyNoBaseShaHuman, null, 2));
    const legacyNoBaseShaHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(legacyNoBaseShaHumanPrComment.status, ExitCodes.usageError);
    assert.equal(legacyNoBaseShaHumanPrComment.stdout, "");
    assert.match(legacyNoBaseShaHumanPrComment.stderr, /Human reviewer brief is stale or belongs to a different scope/);
    assert.doesNotMatch(legacyNoBaseShaHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "{");
    const malformedHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(malformedHumanPrComment.status, ExitCodes.schemaValidationFailed);
    assert.equal(malformedHumanPrComment.stdout, "");
    assert.match(malformedHumanPrComment.stderr, /Human reviewer brief is unreadable/);
    assert.doesNotMatch(malformedHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    const schemaInvalidHuman = { ...human, verdict: {} };
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(schemaInvalidHuman, null, 2));
    const schemaInvalidHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(schemaInvalidHumanPrComment.status, ExitCodes.schemaValidationFailed);
    assert.equal(schemaInvalidHumanPrComment.stdout, "");
    assert.match(schemaInvalidHumanPrComment.stderr, /Human reviewer brief failed schema validation/);
    assert.doesNotMatch(schemaInvalidHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    delete human.evidence_cards;
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(human, null, 2));
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "evidence_cards.md"), "stale evidence-card artifact");
    const staleEvidenceCards = runCli(tmp, ["evidence-cards", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleEvidenceCards.status, 0, staleEvidenceCards.stderr);
    const rebuiltEvidenceCardBody = fs.readFileSync(path.join(tmp, ".review-surfaces", "evidence_cards.md"), "utf8");
    assert.match(rebuiltEvidenceCardBody, /^# Evidence Cards/);
    assert.match(rebuiltEvidenceCardBody, /\(`CARD-\d+`\)/, "rebuilt artifact should contain current evidence-card rows");
    assert.doesNotMatch(rebuiltEvidenceCardBody, /generated before evidence-card support/);
    const rebuiltEvidenceCardsHuman = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    assert.ok(rebuiltEvidenceCardsHuman.evidence_cards.length > 0, "evidence-cards command should rebuild stale prior-v1 human_review.json");
    delete rebuiltEvidenceCardsHuman.intent_mismatch;
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(rebuiltEvidenceCardsHuman, null, 2));
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "intent_mismatch.md"), "stale intent-mismatch artifact");
    const staleIntentMismatch = runCli(tmp, ["intent-mismatch", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleIntentMismatch.status, 0, staleIntentMismatch.stderr);
    const rebuiltIntentMismatchBody = fs.readFileSync(path.join(tmp, ".review-surfaces", "intent_mismatch.md"), "utf8");
    assert.match(rebuiltIntentMismatchBody, /^# Intent Mismatch/);
    assert.match(rebuiltIntentMismatchBody, /## Expected by spec/);
    assert.doesNotMatch(rebuiltIntentMismatchBody, /stale intent-mismatch artifact/);
    const rebuiltIntentMismatchHuman = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    assert.ok(rebuiltIntentMismatchHuman.intent_mismatch, "intent-mismatch command should rebuild stale prior-v1 human_review.json");
    fs.writeFileSync(
      path.join(tmp, ".review-surfaces", "inputs", "feedback.index.json"),
      JSON.stringify(
        {
          schema_version: "review-surfaces.feedback.index.v1",
          feedback: [
            {
              path: ".review-surfaces/feedback/memory.yaml",
              schema_version: "review-surfaces.feedback.v1",
              author: "local",
              head_sha: surface.scope.head_sha,
              findings: [],
              validation: {
                passed: [],
                failed: [],
                notes: ["Manual check recorded: Confirm rendered comment was inspected."]
              },
              false_positives: [],
              false_negatives: [],
              team_policy: [
                {
                  id: "POLICY-RENDER-001",
                  path_pattern: CHANGED,
                  required_manual_check: "Confirm rendered comment was inspected.",
                  evidence: [
                    {
                      kind: "feedback",
                      path: ".review-surfaces/feedback/memory.yaml",
                      event_id: "POLICY-RENDER-001",
                      note: "Feedback team policy POLICY-RENDER-001.",
                      confidence: "high",
                      validation_status: "valid"
                    }
                  ]
                }
              ],
              reviewer_preferences: [
                {
                  key: "always_prioritize",
                  value: [CHANGED],
                  evidence: [
                    {
                      kind: "feedback",
                      path: ".review-surfaces/feedback/memory.yaml",
                      event_id: "reviewer_preference:1",
                      note: "Feedback reviewer preference always_prioritize.",
                      confidence: "high",
                      validation_status: "valid"
                    }
                  ]
                }
              ]
            }
          ]
        },
        null,
        2
      )
    );
    const humanRebuild = runCli(tmp, ["human", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(humanRebuild.status, 0, humanRebuild.stderr);
    const rebuiltHuman = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    const rebuiltHumanMarkdown = fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.md"), "utf8");
    assert.equal(validateJsonSchema(HUMAN_REVIEW_SCHEMA, rebuiltHuman).valid, true);
    assert.equal(rebuiltHuman.feedback_effects.some((effect: { kind: string; action: string; paths: string[] }) => effect.kind === "reviewer_preference" && effect.paths.includes(CHANGED)), true);
    assert.equal(rebuiltHuman.feedback_effects.some((effect: { kind: string; action: string }) => effect.kind === "team_policy" && effect.action.startsWith("Manual check recorded:")), true);
    assert.equal(rebuiltHuman.blockers.some((blocker: { id: string }) => blocker.id === "BLOCK-FEEDBACK-001"), false);
    assert.equal(
      rebuiltHuman.review_queue.some((item: { title: string; path: string }) => item.path === CHANGED && item.title === "Reviewer-preferred review focus"),
      true,
      "feedback memory should influence the supporting review order"
    );
    assert.doesNotMatch(
      rebuiltHumanMarkdown,
      /## Feedback memory|always_prioritize/,
      "the compact reviewer brief should not expose internal feedback configuration"
    );
    fs.writeFileSync(
      path.join(tmp, ".review-surfaces", "inputs", "feedback.index.json"),
      JSON.stringify(
        {
          schema_version: "review-surfaces.feedback.index.v1",
          feedback: [
            {
              path: ".review-surfaces/feedback/policy.yaml",
              schema_version: "review-surfaces.feedback.v1",
              author: "local",
              head_sha: surface.scope.head_sha,
              findings: [],
              validation: {
                passed: [],
                failed: [],
                notes: []
              },
              false_positives: [],
              false_negatives: [],
              team_policy: [
                {
                  id: "POLICY-RENDER-LEGACY-001",
                  path_pattern: CHANGED,
                  required_manual_check: "Confirm rendered comment was inspected.",
                  evidence: [
                    {
                      kind: "feedback",
                      path: ".review-surfaces/feedback/policy.yaml",
                      event_id: "POLICY-RENDER-LEGACY-001",
                      note: "Feedback team policy POLICY-RENDER-LEGACY-001.",
                      confidence: "high",
                      validation_status: "valid"
                    }
                  ]
                }
              ],
              reviewer_preferences: []
            },
            {
              path: ".review-surfaces/feedback/legacy-manual.yaml",
              schema_version: "review-surfaces.feedback.v1",
              author: "local",
              head_sha: surface.scope.head_sha,
              findings: [],
              validation: {
                passed: [],
                failed: [],
                notes: ["Manual check recorded: Confirm rendered comment was inspected."]
              }
            }
          ]
        },
        null,
        2
      )
    );
    const legacyFeedbackRebuild = runCli(tmp, ["human", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(legacyFeedbackRebuild.status, 0, legacyFeedbackRebuild.stderr);
    const legacyHuman = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    assert.equal(legacyHuman.feedback_effects.some((effect: { kind: string; action: string }) => effect.kind === "team_policy" && effect.action.startsWith("Manual check recorded:")), true);
    assert.equal(legacyHuman.blockers.some((blocker: { id: string }) => blocker.id === "BLOCK-FEEDBACK-001"), false);
    fs.writeFileSync(
      path.join(tmp, ".review-surfaces", "inputs", "feedback.index.json"),
      JSON.stringify(
        {
          schema_version: "review-surfaces.feedback.index.v1",
          feedback: [
            {
              path: ".review-surfaces/feedback/partial-policy.yaml",
              schema_version: "review-surfaces.feedback.v1",
              author: "local",
              findings: [],
              validation: {
                passed: [],
                failed: [],
                notes: []
              },
              false_positives: [
                {
                  rule: "comment_surface_change"
                }
              ],
              false_negatives: [],
              team_policy: [],
              reviewer_preferences: []
            }
          ]
        },
        null,
        2
      )
    );
    const partialPolicyRebuild = runCli(tmp, ["human", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(partialPolicyRebuild.status, 0, partialPolicyRebuild.stderr);
    fs.writeFileSync(
      path.join(tmp, ".review-surfaces", "inputs", "feedback.index.json"),
      JSON.stringify({ schema_version: "review-surfaces.feedback.index.v1", feedback: {} }, null, 2)
    );
    const malformedFeedbackRebuild = runCli(tmp, ["human", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(malformedFeedbackRebuild.status, 0, malformedFeedbackRebuild.stderr);
    assert.match(malformedFeedbackRebuild.stderr, /ignored malformed feedback memory index/);
    fs.writeFileSync(
      path.join(tmp, ".review-surfaces", "inputs", "feedback.index.json"),
      JSON.stringify(
        {
          schema_version: "review-surfaces.feedback.index.v1",
          feedback: [
            null,
            {
              path: ".review-surfaces/feedback/bad-memory.yaml",
              schema_version: "review-surfaces.feedback.v1",
              author: "local",
              findings: [],
              validation: { passed: [], failed: [], notes: [] },
              false_positives: {},
              false_negatives: [],
              team_policy: [],
              reviewer_preferences: []
            }
          ]
        },
        null,
        2
      )
    );
    const malformedEntryRebuild = runCli(tmp, ["human", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(malformedEntryRebuild.status, 0, malformedEntryRebuild.stderr);
    assert.match(malformedEntryRebuild.stderr, /ignored malformed feedback memory entry/);
    assert.equal(surface.mode, "pr");
    // Scoped to the actual change, NOT the whole repo.
    assert.ok(surface.scope.changed_files.some((f: { path: string }) => f.path === CHANGED), "the changed file is in scope");
    assert.ok(surface.scope.affected_requirements.length > 0, "some requirements are affected");
    assert.ok(surface.scope.affected_requirements.length < 80, "scope is a SUBSET of the spec, not all ~85 requirements");
    // A renderer-surface change yields a deterministic PR risk.
    assert.ok(surface.risks.candidates.some((c: { rule: string }) => c.rule === "comment_surface_change"));
    // Deterministic facts are ready and postable without sidecar prose.
    assert.equal(surface.status, "ready");
    const deterministicComment = runCli(tmp, ["comment", "--mode", "pr", "--out", ".review-surfaces"]);
    assert.equal(deterministicComment.status, 0);
    assert.match(deterministicComment.stdout, /## review-surfaces/);
    assert.match(deterministicComment.stdout, /### Change purpose/);
    assertInlineApprovalBrief(tmp, deterministicComment.stdout);
    assert.doesNotMatch(deterministicComment.stderr, /not postable/);
    assert.doesNotMatch(deterministicComment.stdout, /\d+ satisfied, \d+ partial, \d+ missing/);
    // The diagram artifact the surface advertises is actually materialized on disk.
    if (surface.diagram) {
      const diagramFile = path.join(tmp, ".review-surfaces", surface.diagram.path);
      assert.ok(fs.existsSync(diagramFile), `surface.diagram.path ${surface.diagram.path} must be written`);
      assert.equal(fs.readFileSync(diagramFile, "utf8"), surface.diagram.body);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.5 PR risks use current-head command transcripts from assembly", () => {
  const tmp = setupChangedRepo();
  try {
    fs.appendFileSync(path.join(tmp, "src", "pipeline", "pr-surface.ts"), "\n// command transcript PR risk marker\n");
    execFileSync("git", ["add", CHANGED, "src/pipeline/pr-surface.ts"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "subject"], { cwd: tmp, stdio: "ignore" });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
    fs.mkdirSync(path.join(tmp, ".review-surfaces", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".review-surfaces", "commands", "current-head-test.json"),
      JSON.stringify({
        schema_version: "review-surfaces.command_transcripts.v1",
        commands: [
          {
            id: "CMD-CURRENT-HEAD-TEST",
            command: "pnpm run test",
            status: "passed",
            exit_code: 0,
            head_sha: headSha,
            truncated: false
          }
        ]
      })
    );

    const run = runCli(tmp, [
      "all",
      "--review-scope",
      "pr",
      "--base",
      "HEAD~1",
      "--head",
      "HEAD",
      "--spec",
      "features/review-surfaces.feature.yaml",
      "--out",
      ".review-surfaces",
      "--provider",
      "mock"
    ]);
    assert.equal(run.status, 0, run.stderr);
    const surface = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "pr_review_surface.json"), "utf8"));
    assert.equal(
      surface.risks.candidates.some(
        (candidate: { rule: string; evidence: Array<{ path?: string }> }) =>
          candidate.rule === "untested_changed_impl" &&
          candidate.evidence.some((ref) => ref.path === "src/pipeline/pr-surface.ts")
      ),
      false,
      "current-head broad test transcript should prevent a stale untested implementation risk for the PR-surface pipeline"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.HUMAN_REVIEW.16 all applies human_review config caps to generated JSON", () => {
  const tmp = setupChangedRepo();
  try {
    fs.writeFileSync(
      path.join(tmp, "human-review-caps.yaml"),
      [
        "human_review:",
        "  max_supporting_queue: 1",
        "  max_suggested_comments: 1",
        "  max_questions: 1"
      ].join("\n")
    );
    const run = runCli(tmp, [...ALL_PR, "--provider", "mock", "--config", "human-review-caps.yaml"]);
    assert.equal(run.status, 0, run.stderr);
    const human = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));

    assert.equal(validateJsonSchema(HUMAN_REVIEW_SCHEMA, human).valid, true);
    assert.ok(human.review_queue.length <= 1);
    assert.ok(human.suggested_comments.length <= 1);
    assert.ok(human.questions.length <= 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.HUMAN_REVIEW.16 all honors human_review enabled and default entrypoint controls", () => {
  const disabled = setupChangedRepo();
  const quiet = setupChangedRepo();
  try {
    fs.writeFileSync(path.join(disabled, "human-review-disabled.yaml"), ["human_review:", "  enabled: false"].join("\n"));
    fs.mkdirSync(path.join(disabled, ".review-surfaces"), { recursive: true });
    fs.writeFileSync(path.join(disabled, ".review-surfaces", "human_review.json"), "{}");
    fs.writeFileSync(path.join(disabled, ".review-surfaces", "human_review.md"), "# stale\n");
    const disabledRun = runCli(disabled, [...ALL_PR, "--provider", "mock", "--config", "human-review-disabled.yaml"]);
    assert.equal(disabledRun.status, 0, disabledRun.stderr);
    assert.doesNotMatch(disabledRun.stdout, /Human review:/);
    assert.equal(fs.existsSync(path.join(disabled, ".review-surfaces", "human_review.json")), false);
    assert.equal(fs.existsSync(path.join(disabled, ".review-surfaces", "human_review.md")), false);
    fs.writeFileSync(path.join(disabled, ".review-surfaces", "human_review.json"), "{}");
    fs.writeFileSync(path.join(disabled, ".review-surfaces", "human_review.md"), "# stale\n");
    const disabledHuman = runCli(disabled, ["human", "--review-scope", "pr", "--out", ".review-surfaces", "--config", "human-review-disabled.yaml"]);
    assert.equal(disabledHuman.status, 0, disabledHuman.stderr);
    assert.match(disabledHuman.stdout, /Human review disabled by config/);
    assert.equal(fs.existsSync(path.join(disabled, ".review-surfaces", "human_review.json")), false);
    assert.equal(fs.existsSync(path.join(disabled, ".review-surfaces", "human_review.md")), false);

    fs.writeFileSync(path.join(quiet, "human-review-secondary.yaml"), ["human_review:", "  default_entrypoint: false"].join("\n"));
    const quietRun = runCli(quiet, [...ALL_PR, "--provider", "mock", "--config", "human-review-secondary.yaml"]);
    assert.equal(quietRun.status, 0, quietRun.stderr);
    assert.doesNotMatch(quietRun.stdout, /Human review:/);
    assert.match(quietRun.stdout, /Wrote review-surfaces artifacts to \.review-surfaces/);
    assert.equal(fs.existsSync(path.join(quiet, ".review-surfaces", "human_review.json")), true);
    assert.equal(fs.existsSync(path.join(quiet, ".review-surfaces", "human_review.md")), true);
  } finally {
    fs.rmSync(disabled, { recursive: true, force: true });
    fs.rmSync(quiet, { recursive: true, force: true });
  }
});

test("review-surfaces.HUMAN_REVIEW.16 focused human artifacts rebuild when explicit config is supplied", () => {
  const tmp = setupChangedRepo();
  try {
    const first = runCli(tmp, [...ALL_PR, "--provider", "mock"]);
    assert.equal(first.status, 0, first.stderr);
    const humanPath = path.join(tmp, ".review-surfaces", "human_review.json");
    const human = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    assert.ok(human.review_queue.length > 0, "fixture should generate at least one review queue item");
    human.review_queue = [
      { ...human.review_queue[0], id: "REVIEW-STALE-001", rank: 1, title: "STALE SENTINEL QUEUE ITEM" },
      { ...human.review_queue[0], id: "REVIEW-STALE-002", rank: 2, title: "STALE SENTINEL QUEUE ITEM 2" }
    ];
    fs.writeFileSync(humanPath, `${JSON.stringify(human, null, 2)}\n`);
    fs.writeFileSync(
      path.join(tmp, "human-review-caps.yaml"),
      ["human_review:", "  max_supporting_queue: 1"].join("\n")
    );

    const queue = runCli(tmp, ["queue", "--review-scope", "pr", "--out", ".review-surfaces", "--config", "human-review-caps.yaml"]);
    assert.equal(queue.status, 0, queue.stderr);
    const rebuiltHuman = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    const queueMarkdown = fs.readFileSync(path.join(tmp, ".review-surfaces", "review_queue.md"), "utf8");
    assert.ok(rebuiltHuman.review_queue.length <= 1);
    assert.doesNotMatch(queueMarkdown, /STALE SENTINEL QUEUE ITEM/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a current schema-valid model with no evidence cards is reused without a no-op rebuild", () => {
  const tmp = setupChangedRepo();
  try {
    const first = runCli(tmp, [...ALL_PR, "--provider", "mock"]);
    assert.equal(first.status, 0, first.stderr);
    const humanPath = path.join(tmp, ".review-surfaces", "human_review.json");
    const human = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    human.evidence_cards = [];
    human.review_queue[0].title = "VALID EMPTY-CARDS SENTINEL";
    fs.writeFileSync(humanPath, `${JSON.stringify(human, null, 2)}\n`);

    const focused = runCli(tmp, ["evidence-cards", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(focused.status, 0, focused.stderr);
    assert.doesNotMatch(focused.stderr, /Refreshing stale human_review\.json/);
    assert.match(fs.readFileSync(path.join(tmp, ".review-surfaces", "evidence_cards.md"), "utf8"), /No evidence cards were generated/);
    const reused = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    assert.equal(reused.review_queue[0].title, "VALID EMPTY-CARDS SENTINEL");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.HUMAN_REVIEW.16 focused human artifacts rebuild when the default config changes", () => {
  const tmp = setupChangedRepo();
  try {
    const first = runCli(tmp, [...ALL_PR, "--provider", "mock"]);
    assert.equal(first.status, 0, first.stderr);
    const humanPath = path.join(tmp, ".review-surfaces", "human_review.json");
    const human = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    assert.equal(typeof human.generated_from.human_review_config_signature, "string");
    assert.ok(human.review_queue.length > 0, "fixture should generate at least one review queue item");
    human.review_queue = [
      { ...human.review_queue[0], id: "REVIEW-STALE-001", rank: 1, title: "DEFAULT CONFIG STALE SENTINEL" },
      { ...human.review_queue[0], id: "REVIEW-STALE-002", rank: 2, title: "DEFAULT CONFIG STALE SENTINEL 2" }
    ];
    fs.writeFileSync(humanPath, `${JSON.stringify(human, null, 2)}\n`);
    const configPath = path.join(tmp, "review-surfaces.config.yaml");
    fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace("max_supporting_queue: 20", "max_supporting_queue: 1"));

    const queue = runCli(tmp, ["queue", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(queue.status, 0, queue.stderr);
    const rebuiltHuman = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    const queueMarkdown = fs.readFileSync(path.join(tmp, ".review-surfaces", "review_queue.md"), "utf8");
    assert.ok(rebuiltHuman.review_queue.length <= 1);
    assert.doesNotMatch(queueMarkdown, /DEFAULT CONFIG STALE SENTINEL/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.HUMAN_REVIEW.16 PR comments rebuild human artifacts when the default config changes", () => {
  const tmp = setupChangedRepo();
  try {
    const first = runCli(tmp, [...ALL_PR, "--provider", "mock"]);
    assert.equal(first.status, 0, first.stderr);
    const humanPath = path.join(tmp, ".review-surfaces", "human_review.json");
    const human = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    assert.equal(typeof human.generated_from.human_review_config_signature, "string");
    assert.ok(human.review_queue.length > 0, "fixture should generate at least one review queue item");
    human.review_queue = [
      { ...human.review_queue[0], id: "REVIEW-STALE-PR-COMMENT-001", rank: 1, title: "PR COMMENT STALE SENTINEL" },
      { ...human.review_queue[0], id: "REVIEW-STALE-PR-COMMENT-002", rank: 2, title: "PR COMMENT STALE SENTINEL 2" }
    ];
    fs.writeFileSync(humanPath, `${JSON.stringify(human, null, 2)}\n`);
    const configPath = path.join(tmp, "review-surfaces.config.yaml");
    fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace("max_supporting_queue: 20", "max_supporting_queue: 1"));

    const comment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(comment.status, 0, "local PR comment render without --post succeeds after refreshing stale human JSON (RENDER.8)");
    assert.match(comment.stderr, /Refreshing stale human_review\.json/);
    assertInlineApprovalBrief(tmp, comment.stdout);
    assert.doesNotMatch(comment.stdout, /PR COMMENT STALE SENTINEL/);
    const rebuiltHuman = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    assert.ok(rebuiltHuman.review_queue.length <= 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.PROVIDERS.6 PR comment workflow is base-controlled and uses trusted tool checkouts", () => {
  const ciWorkflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
  const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "pr-review-comment.yml"), "utf8");

  assert.doesNotMatch(ciWorkflow, /GOOGLE_GENERATIVE_AI_API_KEY/);
  assert.doesNotMatch(ciWorkflow, /--provider ai-sdk/);
  assert.match(ciWorkflow, /LLM-backed PR comments run from the base-controlled pr-review-comment workflow/);
  assert.match(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /\n  pull_request:/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /path: tool/);
  assert.match(workflow, /fetch-depth: 1/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /path: subject/);
  assert.match(workflow, /persist-credentials: false/);
  // review-surfaces.PR_SURFACE.1: the build + secret-bearing generation moved into
  // the trusted composite action (./tool), which this base-controlled workflow
  // consumes. The boundary is intact: the action builds and runs from
  // github.action_path (the base-ref tool checkout), never from PR code.
  assert.match(workflow, /uses: \.\/tool/);
  assert.match(workflow, /model: google:gemini-2\.5-flash/);
  // The LLM key only flows to same-repo PRs (forks get mock + an empty key).
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository[\s\S]*secrets\.GOOGLE_GENERATIVE_AI_API_KEY/
  );
  const action = fs.readFileSync(path.join(process.cwd(), "action.yml"), "utf8");
  assert.match(action, /working-directory: \$\{\{ github\.action_path \}\}[\s\S]*pnpm install --frozen-lockfile[\s\S]*pnpm run build/);
  assert.match(action, /node "\$RS_BIN" all[\s\S]*--review-scope pr/);
  assert.match(action, /--config "\$RS_CONFIG"/);
  assert.match(action, /--redact-secrets true/);
  assert.doesNotMatch(workflow, /--surface-mode pr/);
});

test("review-surfaces.CONVERSATION_REVIEW.4 PR optional enrichment is cached on the human artifact and retries transient failures", () => {
  const tmp = setupChangedRepo();
  const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-counting-provider-"));
  try {
    const conversationEventId = "user-final";
    fs.writeFileSync(
      path.join(tmp, "conversation.jsonl"),
      `${JSON.stringify({
        id: conversationEventId,
        actor: "user",
        kind: "message",
        summary: "Preserve the reviewer-facing renderer behavior.",
        raw_index: 0
      })}\n`
    );
    const preload = countingProviderPreload(preloadDir, conversationEventId);
    const args = [
      "--require",
      preload,
      CLI,
      ...ALL_PR,
      "--cache",
      "--provider",
      "ai-sdk",
      "--conversation",
      "conversation.jsonl",
      "--conversation-format",
      "normalized",
      "--no-conversation-discovery"
    ];
    const runCounted = () => spawnSync("node", args, { cwd: tmp, encoding: "utf8" });
    const run = runCounted();

    assert.equal(run.status, 0, run.stderr);
    const stages = countedProviderStages(run.stderr);
    const count = (stage: string): number => stages.filter((candidate) => candidate === stage).length;
    assert.equal(count("human_narrative"), 1, `expected one optional human narrative call; saw ${JSON.stringify(stages)}`);
    assert.equal(count("conversation_analysis_chunk"), 0, `one-event input must not chunk; saw ${JSON.stringify(stages)}`);
    assert.equal(
      count("conversation_analysis"),
      1,
      `optional conversation analysis should run once; saw ${JSON.stringify(stages)}`
    );
    assert.equal(
      count("conversation_review_insights"),
      1,
      `optional conversation reconciliation should run once; saw ${JSON.stringify(stages)}`
    );
    assert.deepEqual(
      stages.filter((stage) => [
        "human_narrative",
        "conversation_analysis_chunk",
        "conversation_analysis",
        "conversation_review_insights"
      ].includes(stage)),
      ["human_narrative", "conversation_analysis", "conversation_review_insights"]
    );

    // The sidecar remains deterministic; optional conversation value belongs to
    // the human artifact and is reused from there on a same-input cache hit.
    const surfacePath = path.join(tmp, ".review-surfaces", "pr_review_surface.json");
    const humanPath = path.join(tmp, ".review-surfaces", "human_review.json");
    const surface = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
    const human = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    assert.equal(surface.status, "ready");
    assert.equal(human.conversation_analysis.status, "analyzed");
    assert.equal(human.conversation_analysis.provider, "ai-sdk");

    const successfulSurface = fs.readFileSync(surfacePath, "utf8");
    const hit = runCounted();
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /inputs unchanged \(signature match\)/);
    assert.deepEqual(countedProviderStages(hit.stderr), [], "a reusable successful human artifact must not call the provider");
    assert.equal(fs.readFileSync(surfacePath, "utf8"), successfulSurface);

    const retryCases = [
      { status: "degraded", flag: "conversation_analysis_unavailable" },
      { status: "analyzed", flag: "conversation_review_unavailable" }
    ] as const;
    for (const { status, flag } of retryCases) {
      const incomplete = JSON.parse(fs.readFileSync(humanPath, "utf8"));
      incomplete.conversation_analysis.status = status;
      incomplete.conversation_analysis.summary = `Temporary ${flag}.`;
      incomplete.conversation_analysis.quality_flags = [flag];
      incomplete.review_insights = [];
      fs.writeFileSync(humanPath, `${JSON.stringify(incomplete, null, 2)}\n`);

      const retry = runCounted();
      assert.equal(retry.status, 0, retry.stderr);
      assert.doesNotMatch(retry.stdout, /inputs unchanged \(signature match\)/);
      const retryStages = countedProviderStages(retry.stderr);
      assert.equal(
        retryStages.filter((stage) => stage === "conversation_analysis").length,
        1,
        `${flag} must rerun PR conversation analysis; saw ${JSON.stringify(retryStages)}`
      );
      assert.equal(
        retryStages.filter((stage) => stage === "conversation_review_insights").length,
        1,
        `${flag} must rerun PR conversation reconciliation; saw ${JSON.stringify(retryStages)}`
      );
      const refreshed = JSON.parse(fs.readFileSync(humanPath, "utf8"));
      assert.equal(refreshed.conversation_analysis.status, "analyzed");
      assert.equal(refreshed.conversation_analysis.provider, "ai-sdk");
      assert.ok(!refreshed.conversation_analysis.quality_flags.includes(flag));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(preloadDir, { recursive: true, force: true });
  }
});

test("review-surfaces.PR_SURFACE.4 excluded conversation markers do not block or leak through PR comments", () => {
  const tmp = setupChangedRepo();
  const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-marker-provider-"));
  try {
    const conversationEventId = "user-final";
    fs.writeFileSync(
      path.join(tmp, "conversation.jsonl"),
      `${JSON.stringify({
        id: conversationEventId,
        actor: "user",
        kind: "message",
        summary: "Preserve the reviewer-facing renderer behavior.",
        raw_index: 0
      })}\n`
    );
    const preload = countingProviderPreload(preloadDir, conversationEventId);
    const prime = spawnSync("node", [
      "--require",
      preload,
      CLI,
      ...ALL_PR,
      "--provider",
      "ai-sdk",
      "--conversation",
      "conversation.jsonl",
      "--conversation-format",
      "normalized",
      "--no-conversation-discovery"
    ], { cwd: tmp, encoding: "utf8" });
    assert.equal(prime.status, 0, prime.stderr);

    const marker = "[REDACTED:github_token]";
    const humanPath = path.join(tmp, ".review-surfaces", "human_review.json");
    const human = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    human.conversation_analysis.summary = `Provider output included ${marker}.`;
    human.conversation_analysis.quality_flags = ["conversation_analysis_output_redacted"];
    fs.writeFileSync(humanPath, `${JSON.stringify(human, null, 2)}\n`);

    const sticky = runCli(tmp, [
      "comment",
      "--format",
      "sticky",
      "--review-scope",
      "pr",
      "--strict-postability",
      "--out",
      ".review-surfaces"
    ]);
    assert.equal(sticky.status, ExitCodes.success, sticky.stderr);
    assert.doesNotMatch(sticky.stdout, /\[REDACTED:github_token\]/);

    const prComment = runCli(tmp, [
      "comment",
      "--review-scope",
      "pr",
      "--strict-postability",
      "--out",
      ".review-surfaces"
    ]);
    assert.equal(prComment.status, ExitCodes.success, prComment.stderr);
    assert.doesNotMatch(prComment.stdout, /\[REDACTED:github_token\]/);

    // Removing the canonical brief fails closed; the sidecar cannot replace it
    // with a second marker-bearing product surface.
    fs.rmSync(path.join(tmp, ".review-surfaces", "human_review.json"));
    const fallbackComment = runCli(tmp, [
      "comment",
      "--review-scope",
      "pr",
      "--strict-postability",
      "--out",
      ".review-surfaces"
    ]);
    assert.equal(fallbackComment.status, ExitCodes.usageError, fallbackComment.stderr);
    assert.equal(fallbackComment.stdout, "");
    assert.match(fallbackComment.stderr, /No human reviewer brief found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(preloadDir, { recursive: true, force: true });
  }
});

test("review-surfaces.PR_SURFACE.4 a sidecar cannot replace a missing human reviewer brief", () => {
  const tmp = setupChangedRepo();
  try {
    const prime = runCli(tmp, ALL_PR);
    assert.equal(prime.status, 0, prime.stderr);
    fs.rmSync(path.join(tmp, ".review-surfaces", "human_review.json"));

    const comment = runCli(tmp, [
      "comment",
      "--review-scope",
      "pr",
      "--strict-postability",
      "--out",
      ".review-surfaces"
    ]);

    assert.equal(comment.status, ExitCodes.usageError, comment.stderr);
    assert.equal(comment.stdout, "");
    assert.match(comment.stderr, /No human reviewer brief found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("comment --review-scope pr posts the deterministic brief without provider enrichment", () => {
  const tmp = setupChangedRepo();
  try {
    const allRun = runCli(tmp, [...ALL_PR, "--provider", "mock"]);
    assert.equal(allRun.status, 0, allRun.stderr);
    const surface = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "pr_review_surface.json"), "utf8"));
    assert.equal(surface.status, "ready", `expected ready, got ${surface.status}/${surface.blocked_reason}`);

    const comment = runCli(tmp, ["comment", "--mode", "pr", "--out", ".review-surfaces"]);
    assert.equal(comment.status, 0);
    assert.match(comment.stdout, /## review-surfaces/);
    assert.match(comment.stdout, /### Change purpose/);
    assert.match(comment.stdout, /### Approval decision/);
    assertInlineApprovalBrief(tmp, comment.stdout);
    assert.doesNotMatch(comment.stderr, /not postable/);
    // Not the whole-spec dump or boilerplate.
    assert.doesNotMatch(comment.stdout, /\d+ satisfied, \d+ partial, \d+ missing/);
    assert.doesNotMatch(comment.stdout, /Start with missing and partial requirement results/);
    assert.doesNotMatch(comment.stdout, /### Affected coverage/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.4 repo review wires deterministic packet risks and survives human rebuild", () => {
  const tmp = setupChangedRepo();
  try {
    const conversationEventId = "repo-user-final";
    const insightTitle = "Repo conversation insight survives rebuild";
    const riskFixtureSpec = "features/repo-risk-fixture.feature.yaml";
    fs.writeFileSync(path.join(tmp, riskFixtureSpec), [
      "feature:",
      "  name: repo-risk-fixture",
      "  product: review-surfaces",
      "  version: 0.0.1",
      "  draft: true",
      "components:",
      "  UNRELATED:",
      "    name: Unrelated fixture component",
      "    requirements:",
      "      1:",
      "        requirement: The fixture intentionally leaves renderer changes unmapped.",
      ""
    ].join("\n"));
    const repoArgs = [
      "all",
      "--review-scope",
      "repo",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--spec",
      riskFixtureSpec,
      "--out",
      ".review-surfaces",
      "--conversation",
      "conversation.jsonl",
      "--conversation-format",
      "normalized",
      "--no-conversation-discovery"
    ];
    fs.writeFileSync(
      path.join(tmp, "conversation.jsonl"),
      `${JSON.stringify({
        id: conversationEventId,
        actor: "user",
        kind: "message",
        summary: "Keep the reviewer-facing marker and explain why it matters."
      })}\n`
    );

    const prime = runCli(tmp, [...repoArgs, "--provider", "mock"]);
    assert.equal(prime.status, 0, prime.stderr);
    const primePacket = JSON.parse(fs.readFileSync(
      path.join(tmp, ".review-surfaces", "review_packet.json"),
      "utf8"
    ));
    const deterministicRisk = primePacket.risks.items.find((risk: {
      id: string;
      evidence?: Array<{ path?: string; llm_proposed?: boolean }>;
    }) => {
      const refs = risk.evidence ?? [];
      return refs.some((ref) => ref.path === CHANGED) &&
        !(refs.length > 0 && refs.every((ref) => ref.llm_proposed === true));
    });
    assert.ok(
      deterministicRisk,
      `repo fixture should produce a deterministic packet risk anchored to ${CHANGED}`
    );

    fs.writeFileSync(
      path.join(tmp, "agent-stages.json"),
      JSON.stringify({
        stages: {
          conversation_analysis: {
            summary: "The final request preserves the reviewer-facing marker.",
            intent: [{
              text: "Keep the reviewer-facing marker and explain its value.",
              event_ids: [conversationEventId]
            }],
            refinements: [],
            decisions: [],
            constraints: [],
            non_goals: [],
            rejected_alternatives: [],
            claims: [],
            validation_claims: [],
            known_gaps: []
          },
          conversation_review_insights: {
            insights: [{
              root_cause_key: "repo-conversation-durability",
              category: "intent_mismatch",
              title: insightTitle,
              summary: "The changed renderer should retain the requested reviewer-facing behavior.",
              why_it_matters: "Losing this context would make a later artifact rebuild less useful to the reviewer.",
              reviewer_action: "Confirm the renderer change still communicates the requested value.",
              priority: "high",
              evidence_state: "contradicted",
              conversation_event_ids: [conversationEventId],
              paths: [CHANGED],
              requirement_ids: [],
              risk_ids: [deterministicRisk.id],
              command_ids: [],
              diff_anchors: []
            }]
          }
        }
      })
    );

    const allRun = runCli(tmp, [
      ...repoArgs,
      "--provider",
      "agent-file",
      "--agent-input",
      "agent-stages.json"
    ]);
    assert.equal(allRun.status, 0, allRun.stderr);

    const humanPath = path.join(tmp, ".review-surfaces", "human_review.json");
    const packetPath = path.join(tmp, ".review-surfaces", "review_packet.json");
    const before = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
    assert.equal(before.mode, "repo");
    assert.equal(before.conversation_analysis.status, "analyzed");
    assert.equal(before.review_insights[0]?.title, insightTitle);
    assert.equal(before.review_insights[0]?.evidence_state, "contradicted");
    assert.equal(before.review_insights[0]?.basis, "validated_anchors");
    assert.deepEqual(
      before.review_insights[0]?.risk_ids,
      [deterministicRisk.id],
      "repo conversation reconciliation should receive deterministic packet risk ids"
    );
    assert.equal(before.generated_from.packet_signature, packet.manifest.signature);

    const humanRun = runCli(tmp, ["human", "--review-scope", "repo", "--out", ".review-surfaces"]);
    assert.equal(humanRun.status, 0, humanRun.stderr);

    const after = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    assert.equal(validateJsonSchema(HUMAN_REVIEW_SCHEMA, after).valid, true);
    assert.deepEqual(after.conversation_analysis, before.conversation_analysis);
    assert.deepEqual(after.review_insights, before.review_insights);
    assert.equal(after.generated_from.packet_signature, packet.manifest.signature);

    // The signature can also match a PR-mode human artifact because PR runs use
    // the same whole-repo packet. Repo rebuilds must not import PR-sidecar
    // conversation conclusions merely because head/signature happen to match.
    const crossScopeSentinel = "PR-scoped conversation value must not enter repo mode";
    after.mode = "pr";
    after.review_insights[0].title = crossScopeSentinel;
    fs.writeFileSync(humanPath, JSON.stringify(after, null, 2));

    const crossScopeRun = runCli(tmp, ["human", "--review-scope", "repo", "--out", ".review-surfaces"]);
    assert.equal(crossScopeRun.status, 0, crossScopeRun.stderr);
    const crossScopeRebuild = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    assert.equal(crossScopeRebuild.mode, "repo");
    assert.equal(crossScopeRebuild.conversation_analysis.status, "not_assessed");
    assert.equal(crossScopeRebuild.review_insights.length, 0);
    assert.doesNotMatch(JSON.stringify(crossScopeRebuild), new RegExp(crossScopeSentinel));

    const staleSignatureSentinel = "Stale-signature conversation value must not survive";
    after.mode = "repo";
    after.generated_from.packet_signature = "stale-packet-signature";
    after.review_insights[0].title = staleSignatureSentinel;
    fs.writeFileSync(humanPath, JSON.stringify(after, null, 2));

    const staleSignatureRun = runCli(tmp, ["human", "--review-scope", "repo", "--out", ".review-surfaces"]);
    assert.equal(staleSignatureRun.status, 0, staleSignatureRun.stderr);
    const staleSignatureRebuild = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    assert.equal(staleSignatureRebuild.conversation_analysis.status, "not_assessed");
    assert.equal(staleSignatureRebuild.review_insights.length, 0);
    assert.doesNotMatch(JSON.stringify(staleSignatureRebuild), new RegExp(staleSignatureSentinel));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("all --review-scope pr --cache reuses a ready PR surface while keeping human review PR-scoped", () => {
  const tmp = setupChangedRepo();
  try {
    const prime = runCli(tmp, [...ALL_PR, "--cache", "--provider", "mock"]);
    assert.equal(prime.status, 0, prime.stderr);
    const surface = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "pr_review_surface.json"), "utf8"));
    assert.equal(surface.status, "ready");

    const hit = runCli(tmp, [...ALL_PR, "--cache", "--provider", "mock"]);
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /inputs unchanged \(signature match\)/);
    assert.doesNotMatch(hit.stdout, /Wrote review-surfaces artifacts to \.review-surfaces/);

    const human = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    assert.equal(human.mode, "pr");
    assert.equal(human.generated_from.pr_surface_path, "pr_review_surface.json");
    assert.equal(human.generated_from.base_sha, surface.scope.base_sha);
    assert.equal(human.generated_from.head_sha, surface.scope.head_sha);
    const changedQueueItem = human.review_queue.find((item: { path: string }) => item.path === CHANGED);
    assert.ok(changedQueueItem, "cache-hit human review should still be built from the PR surface and diff");
    assert.match(changedQueueItem.hunk_header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    assert.ok(changedQueueItem.line_start > 0, "cache-hit human review should preserve diff-derived hunk anchors");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.4 repo cache reuses a successful ai-sdk conversation review", () => {
  const tmp = setupChangedRepo();
  try {
    fs.writeFileSync(
      path.join(tmp, "conversation.jsonl"),
      `${JSON.stringify({ id: "user-1", actor: "user", kind: "message", summary: "Keep the renderer behavior.", raw_index: 0 })}\n`
    );
    const args = [
      "all",
      "--review-scope",
      "repo",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--spec",
      "features/review-surfaces.feature.yaml",
      "--out",
      ".review-surfaces",
      "--cache",
      "--provider",
      "ai-sdk",
      "--conversation",
      "conversation.jsonl",
      "--conversation-format",
      "normalized",
      "--no-conversation-discovery"
    ];
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete env.OPENAI_API_KEY;
    const runWithoutCredentials = (): { status: number | null; stdout: string; stderr: string } => {
      const result = spawnSync("node", [CLI, ...args], { cwd: tmp, encoding: "utf8", env });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };

    const prime = runWithoutCredentials();
    assert.equal(prime.status, 0, prime.stderr);

    const humanPath = path.join(tmp, ".review-surfaces", "human_review.json");
    const successful = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    successful.conversation_analysis.status = "analyzed";
    successful.conversation_analysis.summary = "The final request keeps the renderer behavior.";
    successful.conversation_analysis.intent = [{
      text: "Keep the renderer behavior.",
      event_ids: ["user-1"]
    }];
    successful.conversation_analysis.quality_flags = [];
    successful.review_insights = [];
    successful.decision_projection.active_intent = {
      summary: "Reviewer goal: Keep the renderer behavior.",
      source: "conversation_advisory",
      redaction_blocked: false,
      requirement_ids: [],
      event_ids: ["user-1"]
    };
    assert.equal(validateJsonSchema(HUMAN_REVIEW_SCHEMA, successful).valid, true);
    fs.writeFileSync(humanPath, `${JSON.stringify(successful, null, 2)}\n`);
    const before = fs.readFileSync(humanPath, "utf8");

    const hit = runWithoutCredentials();

    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /inputs unchanged \(signature match\)/);
    assert.equal(fs.readFileSync(humanPath, "utf8"), before);
    const reused = JSON.parse(before);
    assert.equal(reused.conversation_analysis.provider, "ai-sdk");
    assert.equal(reused.conversation_analysis.status, "analyzed");
    assert.deepEqual(reused.conversation_analysis.quality_flags, []);
    assert.deepEqual(reused.conversation_analysis.intent[0].event_ids, ["user-1"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.4 repo cache retries incomplete remote conversation results", () => {
  const tmp = setupChangedRepo();
  try {
    fs.writeFileSync(
      path.join(tmp, "conversation.jsonl"),
      `${JSON.stringify({ id: "user-1", actor: "user", kind: "message", summary: "Keep the renderer behavior.", raw_index: 0 })}\n`
    );
    const args = [
      "all",
      "--review-scope",
      "repo",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--spec",
      "features/review-surfaces.feature.yaml",
      "--out",
      ".review-surfaces",
      "--cache",
      "--provider",
      "ai-sdk",
      "--conversation",
      "conversation.jsonl",
      "--conversation-format",
      "normalized",
      "--no-conversation-discovery"
    ];
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete env.OPENAI_API_KEY;
    const runWithoutCredentials = (): { status: number | null; stdout: string; stderr: string } => {
      const result = spawnSync("node", [CLI, ...args], { cwd: tmp, encoding: "utf8", env });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const prime = runWithoutCredentials();
    assert.equal(prime.status, 0, prime.stderr);

    const humanPath = path.join(tmp, ".review-surfaces", "human_review.json");
    const unavailable = JSON.parse(fs.readFileSync(humanPath, "utf8"));
    assert.equal(unavailable.conversation_analysis.status, "analyzed");
    assert.ok(unavailable.conversation_analysis.quality_flags.includes("conversation_analysis_unavailable"));
    assert.ok(unavailable.conversation_analysis.quality_flags.includes("conversation_enrichment_unavailable"));

    const retryCases = [
      { status: "degraded", flag: "conversation_analysis_unavailable" },
      { status: "analyzed", flag: "conversation_enrichment_unavailable" },
      { status: "analyzed", flag: "conversation_review_unavailable" },
      { status: "analyzed", flag: "conversation_analysis_partial" },
      { status: "analyzed", flag: "conversation_review_invalid_payload" }
    ] as const;

    for (const { status, flag } of retryCases) {
      const cached = JSON.parse(fs.readFileSync(humanPath, "utf8"));
      const sentinel = `Cache sentinel for ${flag}.`;
      cached.conversation_analysis.status = status;
      cached.conversation_analysis.summary = sentinel;
      cached.conversation_analysis.intent = status === "analyzed"
        ? [{ text: "Keep the renderer behavior.", event_ids: ["user-1"] }]
        : [];
      cached.conversation_analysis.quality_flags = [flag];
      cached.review_insights = [];
      assert.equal(
        validateJsonSchema(HUMAN_REVIEW_SCHEMA, cached).valid,
        true,
        `${flag} fixture must be schema-valid so only retry policy can cause the miss`
      );
      fs.writeFileSync(humanPath, `${JSON.stringify(cached, null, 2)}\n`);

      const retry = runWithoutCredentials();

      assert.equal(retry.status, 0, retry.stderr);
      assert.doesNotMatch(retry.stdout, /inputs unchanged \(signature match\)/, `${flag} must bypass cache reuse`);
      const regenerated = JSON.parse(fs.readFileSync(humanPath, "utf8"));
      assert.equal(regenerated.conversation_analysis.status, "analyzed");
      assert.ok(regenerated.conversation_analysis.quality_flags.includes("conversation_analysis_unavailable"));
      assert.ok(regenerated.conversation_analysis.quality_flags.includes("conversation_enrichment_unavailable"));
      assert.notEqual(
        regenerated.conversation_analysis.summary,
        sentinel,
        `${flag} must trigger regeneration rather than silent cached reuse`
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("human --review-scope pr ignores stale pr_review_surface sidecars", () => {
  const tmp = setupChangedRepo();
  try {
    const run = runCli(tmp, [...ALL_PR, "--provider", "mock"]);
    assert.equal(run.status, 0, run.stderr);

    const surfacePath = path.join(tmp, ".review-surfaces", "pr_review_surface.json");
    const staleSurface = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
    staleSurface.scope.head_sha = "stale-head-sha";
    fs.writeFileSync(surfacePath, JSON.stringify(staleSurface, null, 2));

    const humanRun = runCli(tmp, ["human", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(humanRun.status, 0, humanRun.stderr);
    assert.match(humanRun.stderr, /Ignoring stale pr_review_surface\.json/);

    const human = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    assert.equal(validateJsonSchema(HUMAN_REVIEW_SCHEMA, human).valid, true);
    assert.equal(human.mode, "repo");
    assert.equal(Object.hasOwn(human.generated_from, "pr_surface_path"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
