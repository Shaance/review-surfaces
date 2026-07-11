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
  HOSTILE_CONVERSATION_RAW_CONTROLS,
  HOSTILE_CONVERSATION_NEUTRALIZED_ENTITIES,
  HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS,
  ORDINARY_CONVERSATION_VALUE,
  hostileConversationBackslashRun,
  hostileConversationControlSurvives,
  hostileConversationDisclosureClosesBeforeHeading,
  hostileConversationAnalysis,
  hostileConversationInsight,
  hostileConversationTitleClosesEmphasis
} from "./helpers/conversation-review";
import { isLocalRuntimeArtifactPath } from "./helpers/cli-repo";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");
const CHANGED = "src/render/comment.ts";
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

const PROVIDER_STAGE_PREFIX = "__review_surfaces_provider_stage__:";

function countingProviderPreload(directory: string, conversationEventId: string): string {
  const preloadPath = path.join(directory, "counting-provider.cjs");
  const providerModulePath = path.join(process.cwd(), "dist", "src", "llm", "provider.js");
  const responses: Record<string, unknown> = {
    pr_narrative: {
      summary: `${CHANGED} changed.`,
      what_changed: [{ text: `${CHANGED} changed.`, paths: [CHANGED] }],
      why_it_matters: [{ text: `Review ${CHANGED}.`, paths: [CHANGED] }],
      review_first: [{ text: `Review ${CHANGED} first.`, paths: [CHANGED] }],
      risk_narratives: []
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

test("review-surfaces.PROVIDERS.5 all --review-scope pr writes a diff-scoped pr_review_surface; mock blocks the narrative", () => {
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
    assert.match(run.stdout, /Verdict: [a-z_]+/);
    assert.match(run.stdout, /Review first: \d+ item\(s\)/);
    assert.match(run.stdout, /Blockers: \d+/);
    assert.match(run.stdout, /Suggested comments: \d+/);
    assert.match(run.stdout, /Missing evidence: \d+/);
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
    assert.match(humanMarkdown, /## Review first/);
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
      routes: "JSON sentinel review route",
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
      } else if (artifact.command === "routes") {
        human.review_routes = [
          {
            id: "ROUTE-SENTINEL",
            persona: "human_reviewer",
            title: marker,
            summary: "Focused renderer reads human_review.json.",
            is_default: true,
            is_secondary: false,
            steps: [
              {
                id: "ROUTE-SENTINEL-STEP-001",
                rank: 1,
                title: "JSON route step",
                action: marker,
                evidence: [{ kind: "unknown", confidence: "low", note: "JSON sentinel evidence." }],
                priority: "medium",
                artifact: "human_review.md",
                queue_item_ids: [],
                risk_lens_ids: [],
                question_ids: [],
                test_plan_ids: [],
                suggested_comment_ids: []
              }
            ]
          }
        ];
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
    assert.match(humanPrComment.stdout, /JSON sentinel PR comment queue/);
    assert.match(humanPrComment.stdout, /JSON sentinel PR comment draft/);
    assert.match(humanPrComment.stdout, /Full human review: `human_review\.md`/);
    assert.match(humanPrComment.stderr, /not postable/);
    assert.doesNotMatch(humanPrComment.stdout, /blocked \(`llm_unavailable`\)/);
    // review-surfaces.RENDER.8: --strict-postability re-arms the gate to a
    // non-zero (evidence-validation) exit even without --post.
    const strictPostability = runCli(tmp, ["comment", "--review-scope", "pr", "--strict-postability", "--out", ".review-surfaces"]);
    assert.equal(strictPostability.status, 4, "--strict-postability re-arms the postability gate without --post");
    assert.match(strictPostability.stderr, /not postable/);
    // review-surfaces.SCHEMA.3: a partial prior-version human_review.json (missing
    // a now-required slice such as intent_mismatch) is schema-invalid, so the PR
    // comment path no longer trusts it; it falls back to the validated PR sidecar
    // instead of degrading quietly.
    const priorIntentHuman = { ...human };
    delete priorIntentHuman.intent_mismatch;
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(priorIntentHuman, null, 2));
    const staleIntentHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleIntentHumanPrComment.status, 0, "local PR comment render without --post still succeeds (RENDER.8)");
    assert.match(staleIntentHumanPrComment.stderr, /Ignoring schema-invalid human_review\.json \([^)]*intent_mismatch[^)]*\)/);
    assert.match(staleIntentHumanPrComment.stdout, /blocked \(`llm_unavailable`\)/);
    assert.doesNotMatch(staleIntentHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    const staleHuman = {
      ...human,
      generated_from: { ...human.generated_from, base_ref: "refs/stale-base" }
    };
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(staleHuman, null, 2));
    const staleHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleHumanPrComment.status, 0, "stale human JSON should fall back to the blocked PR sidecar");
    assert.match(staleHumanPrComment.stdout, /blocked \(`llm_unavailable`\)/);
    assert.match(staleHumanPrComment.stderr, /Ignoring stale or non-PR human_review\.json/);
    assert.doesNotMatch(staleHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    const staleBaseShaHuman = {
      ...human,
      generated_from: { ...human.generated_from, base_sha: "stale-base-sha" }
    };
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(staleBaseShaHuman, null, 2));
    const staleBaseShaHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleBaseShaHumanPrComment.status, 0, "base-SHA-stale human JSON should fall back to the blocked PR sidecar");
    assert.match(staleBaseShaHumanPrComment.stdout, /blocked \(`llm_unavailable`\)/);
    assert.match(staleBaseShaHumanPrComment.stderr, /Ignoring stale or non-PR human_review\.json/);
    assert.doesNotMatch(staleBaseShaHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    const legacyNoBaseShaHuman = {
      ...human,
      generated_from: { ...human.generated_from }
    };
    delete legacyNoBaseShaHuman.generated_from.base_sha;
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(legacyNoBaseShaHuman, null, 2));
    const legacyNoBaseShaHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(legacyNoBaseShaHumanPrComment.status, 0, "legacy human JSON without base_sha should fall back when the PR surface records one");
    assert.match(legacyNoBaseShaHumanPrComment.stdout, /blocked \(`llm_unavailable`\)/);
    assert.match(legacyNoBaseShaHumanPrComment.stderr, /Ignoring stale or non-PR human_review\.json/);
    assert.doesNotMatch(legacyNoBaseShaHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "{");
    const malformedHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(malformedHumanPrComment.status, 0, "malformed optional human JSON should not block PR comment rendering");
    assert.match(malformedHumanPrComment.stdout, /blocked \(`llm_unavailable`\)/);
    assert.match(malformedHumanPrComment.stderr, /Ignoring unreadable human_review\.json/);
    assert.doesNotMatch(malformedHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    const schemaInvalidHuman = { ...human, verdict: {} };
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(schemaInvalidHuman, null, 2));
    const schemaInvalidHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(schemaInvalidHumanPrComment.status, 0, "schema-invalid optional human JSON should not block PR comment rendering");
    assert.match(schemaInvalidHumanPrComment.stdout, /blocked \(`llm_unavailable`\)/);
    assert.match(schemaInvalidHumanPrComment.stderr, /Ignoring schema-invalid human_review\.json/);
    assert.doesNotMatch(schemaInvalidHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    delete human.review_routes;
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(human, null, 2));
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "review_routes.md"), "stale route artifact");
    const staleRoutes = runCli(tmp, ["routes", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleRoutes.status, 0, staleRoutes.stderr);
    const rebuiltRouteBody = fs.readFileSync(path.join(tmp, ".review-surfaces", "review_routes.md"), "utf8");
    assert.match(rebuiltRouteBody, /^# Review Routes/);
    assert.match(rebuiltRouteBody, /Human reviewer route/);
    assert.doesNotMatch(rebuiltRouteBody, /generated before review-route support/);
    const rebuiltRoutesHuman = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    assert.ok(rebuiltRoutesHuman.review_routes.length > 0, "routes command should rebuild stale prior-v1 human_review.json");
    delete rebuiltRoutesHuman.evidence_cards;
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(rebuiltRoutesHuman, null, 2));
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "evidence_cards.md"), "stale evidence-card artifact");
    const staleEvidenceCards = runCli(tmp, ["evidence-cards", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleEvidenceCards.status, 0, staleEvidenceCards.stderr);
    const rebuiltEvidenceCardBody = fs.readFileSync(path.join(tmp, ".review-surfaces", "evidence_cards.md"), "utf8");
    assert.match(rebuiltEvidenceCardBody, /^# Evidence Cards/);
    assert.match(rebuiltEvidenceCardBody, /Evidence Card:/);
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
    assert.match(rebuiltHumanMarkdown, /## Feedback memory/);
    assert.match(rebuiltHumanMarkdown, /always_prioritize/);
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
    // Mock has no narrative -> blocked, never a whole-repo fallback.
    assert.equal(surface.status, "blocked");
    assert.equal(surface.narrative, undefined);
    assert.equal(Object.hasOwn(surface, "narrative"), false, "blocked serialized surfaces must omit undefined narrative");
    assert.equal(Object.hasOwn(surface.llm, "model"), false, "serialized llm meta must omit undefined model");
    const blockedComment = runCli(tmp, ["comment", "--mode", "pr", "--out", ".review-surfaces"]);
    assert.equal(blockedComment.status, 0, "blocked PR surfaces render a local comment without --post (RENDER.8)");
    assert.match(blockedComment.stdout, /## review-surfaces PR review/);
    assert.match(blockedComment.stdout, /\*\*Verdict:\*\*/);
    assert.match(blockedComment.stdout, /Full human review: `human_review\.md`/);
    assert.match(blockedComment.stdout, /Human review JSON: `human_review\.json`/);
    assert.match(blockedComment.stdout, /Lower-level PR facts: `pr_review_surface\.json`/);
    assert.match(blockedComment.stderr, /not postable/);
    assert.doesNotMatch(blockedComment.stdout, /\d+ satisfied, \d+ partial, \d+ missing/);
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
        "  max_review_first: 1",
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
      ["human_review:", "  max_review_first: 1"].join("\n")
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
    fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace("max_review_first: 20", "max_review_first: 1"));

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
    fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace("max_review_first: 20", "max_review_first: 1"));

    const comment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(comment.status, 0, "local PR comment render without --post succeeds after refreshing stale human JSON (RENDER.8)");
    assert.match(comment.stderr, /Refreshing stale human_review\.json/);
    assert.match(comment.stdout, /Full human review: `human_review\.md`/);
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

test("review-surfaces.CONVERSATION_REVIEW.4 PR ai-sdk identity drives sidecar reuse and transient retries", () => {
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
    assert.equal(count("pr_narrative"), 1, `expected one PR narrative call; saw ${JSON.stringify(stages)}`);
    assert.equal(count("conversation_analysis_chunk"), 0, `one-event input must not chunk; saw ${JSON.stringify(stages)}`);
    assert.equal(
      count("conversation_analysis"),
      1,
      `PR assembly analysis must be reused by human orchestration; saw ${JSON.stringify(stages)}`
    );
    assert.equal(
      count("conversation_review_insights"),
      1,
      `PR assembly reconciliation must be reused by human orchestration; saw ${JSON.stringify(stages)}`
    );
    assert.deepEqual(
      stages.filter((stage) => [
        "pr_narrative",
        "conversation_analysis_chunk",
        "conversation_analysis",
        "conversation_review_insights"
      ].includes(stage)),
      ["pr_narrative", "conversation_analysis", "conversation_review_insights"]
    );

    // Artifact assertions prove the reuse branch had populated sidecars; the
    // provider counts above are the regression guard against recomputing them.
    const surfacePath = path.join(tmp, ".review-surfaces", "pr_review_surface.json");
    const surface = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
    const human = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "utf8"));
    assert.equal(surface.status, "ready");
    assert.equal(surface.conversation_analysis.status, "analyzed");
    assert.equal(surface.conversation_analysis.provider, "ai-sdk");
    assert.equal(surface.conversation_analysis.provider, surface.llm.provider);
    assert.deepEqual(surface.review_insights, []);
    assert.deepEqual(human.conversation_analysis, surface.conversation_analysis);
    assert.deepEqual(human.review_insights, surface.review_insights);

    const successfulSurface = fs.readFileSync(surfacePath, "utf8");
    const hit = runCounted();
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /inputs unchanged \(signature match\)/);
    assert.deepEqual(countedProviderStages(hit.stderr), [], "a reusable successful PR sidecar must not call the provider");
    assert.equal(fs.readFileSync(surfacePath, "utf8"), successfulSurface);

    const retryCases = [
      { status: "degraded", flag: "conversation_analysis_unavailable" },
      { status: "analyzed", flag: "conversation_review_unavailable" }
    ] as const;
    for (const { status, flag } of retryCases) {
      const incomplete = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
      incomplete.conversation_analysis.status = status;
      incomplete.conversation_analysis.summary = `Temporary ${flag}.`;
      incomplete.conversation_analysis.quality_flags = [flag];
      incomplete.review_insights = [];
      fs.writeFileSync(surfacePath, `${JSON.stringify(incomplete, null, 2)}\n`);

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
      const refreshed = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
      assert.equal(refreshed.conversation_analysis.status, "analyzed");
      assert.equal(refreshed.conversation_analysis.provider, "ai-sdk");
      assert.equal(refreshed.conversation_analysis.provider, refreshed.llm.provider);
      assert.ok(!refreshed.conversation_analysis.quality_flags.includes(flag));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(preloadDir, { recursive: true, force: true });
  }
});

test("review-surfaces.PR_SURFACE.4 persisted conversation redaction markers fail strict postability for both PR comment renderers", () => {
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
    for (const artifactName of ["pr_review_surface.json", "human_review.json"]) {
      const artifactPath = path.join(tmp, ".review-surfaces", artifactName);
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      artifact.conversation_analysis.summary = `Provider output included ${marker}.`;
      artifact.conversation_analysis.quality_flags = ["conversation_analysis_output_redacted"];
      fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    }

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
    assert.equal(sticky.status, ExitCodes.privacyBlocked, sticky.stderr);
    assert.match(sticky.stdout, /\[REDACTED:github_token\]/);
    assert.match(sticky.stderr, /Sticky comment blocked: redaction flagged a high-confidence secret/);

    const prComment = runCli(tmp, [
      "comment",
      "--review-scope",
      "pr",
      "--strict-postability",
      "--out",
      ".review-surfaces"
    ]);
    assert.equal(prComment.status, ExitCodes.privacyBlocked, prComment.stderr);
    assert.match(prComment.stdout, /\[REDACTED:github_token\]/);
    assert.match(prComment.stderr, /PR comment render blocked a high-confidence secret/);

    // Force the low-level pr_review_surface.json renderer. Its public renderer
    // returns markdown only, so the CLI's final inspectAndRedactSecrets pass is
    // the sole surviving block signal for an already-persisted marker.
    fs.rmSync(path.join(tmp, ".review-surfaces", "human_review.json"));
    const fallbackComment = runCli(tmp, [
      "comment",
      "--review-scope",
      "pr",
      "--strict-postability",
      "--out",
      ".review-surfaces"
    ]);
    assert.equal(fallbackComment.status, ExitCodes.privacyBlocked, fallbackComment.stderr);
    assert.match(fallbackComment.stdout, /### What changed/);
    assert.match(fallbackComment.stdout, /\[REDACTED:github_token\]/);
    assert.match(fallbackComment.stderr, /PR comment render blocked a high-confidence secret/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(preloadDir, { recursive: true, force: true });
  }
});

test("review-surfaces.PR_SURFACE.4 strict low-level PR fallback neutralizes hostile conversation markup without privacy-blocking", () => {
  const tmp = setupChangedRepo();
  const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-hostile-markdown-provider-"));
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

    const surfacePath = path.join(tmp, ".review-surfaces", "pr_review_surface.json");
    const surface = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
    surface.conversation_analysis = hostileConversationAnalysis();
    surface.review_insights = [hostileConversationInsight()];
    fs.writeFileSync(surfacePath, `${JSON.stringify(surface, null, 2)}\n`);
    fs.rmSync(path.join(tmp, ".review-surfaces", "human_review.json"));

    const comment = runCli(tmp, [
      "comment",
      "--review-scope",
      "pr",
      "--strict-postability",
      "--out",
      ".review-surfaces"
    ]);

    assert.equal(comment.status, ExitCodes.success, comment.stderr);
    for (const rawControl of HOSTILE_CONVERSATION_RAW_CONTROLS) {
      assert.equal(hostileConversationControlSurvives(comment.stdout, rawControl), false, `raw provider control survived: ${rawControl}`);
    }
    for (const entity of HOSTILE_CONVERSATION_NEUTRALIZED_ENTITIES) {
      assert.ok(comment.stdout.includes(entity), `neutralized provider text must remain readable: ${entity}`);
    }
    for (const marker of HOSTILE_CONVERSATION_TRAILING_BACKSLASH_MARKERS) {
      assert.equal(
        hostileConversationBackslashRun(comment.stdout, marker),
        2,
        `provider trailing backslash must be doubled at ${marker}`
      );
    }
    assert.equal(hostileConversationTitleClosesEmphasis(comment.stdout), true, "renderer-owned title emphasis must close after the neutralized backslash");
    assert.equal(
      hostileConversationDisclosureClosesBeforeHeading(comment.stdout, "### What changed"),
      true,
      "strict fallback conversation details must close before the next deterministic section"
    );
    assert.match(comment.stdout, new RegExp(ORDINARY_CONVERSATION_VALUE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(comment.stdout, /\n### What changed\n/);
    assert.match(comment.stdout, /### PR risks/);
    assert.doesNotMatch(comment.stderr, /blocked a high-confidence secret/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(preloadDir, { recursive: true, force: true });
  }
});

test("comment --review-scope pr renders agent-file narratives locally but does not mark them postable", () => {
  const tmp = setupChangedRepo();
  try {
    // An agent-authored narrative citing the real changed path (anchor allowlisted).
    const narrative = {
      summary: "Adjusts the comment renderer.",
      what_changed: [{ text: "Tweaked the sticky comment renderer", paths: [CHANGED] }],
      why_it_matters: [{ text: "Affects reviewer-facing output", paths: [CHANGED] }],
      review_first: [{ text: "Confirm the rendered comment", paths: [CHANGED] }],
      risk_narratives: []
    };
    fs.writeFileSync(path.join(tmp, "narrative.json"), JSON.stringify(narrative));

    const allRun = runCli(tmp, [...ALL_PR, "--provider", "agent-file", "--agent-input", "narrative.json"]);
    assert.equal(allRun.status, 0, allRun.stderr);
    const surface = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "pr_review_surface.json"), "utf8"));
    assert.equal(surface.status, "ready", `expected ready, got ${surface.status}/${surface.blocked_reason}`);
    assert.ok(surface.narrative.what_changed.length > 0);

    const comment = runCli(tmp, ["comment", "--mode", "pr", "--out", ".review-surfaces"]);
    assert.equal(comment.status, 0, "agent-file PR narratives render locally without --post and exit 0 (RENDER.8); still not postable");
    assert.match(comment.stdout, /## review-surfaces PR review/);
    assert.match(comment.stdout, /\*\*Verdict:\*\*/);
    assert.match(comment.stdout, /### Review first/);
    assert.match(comment.stdout, /Full human review: `human_review\.md`/);
    assert.match(comment.stdout, /Human review JSON: `human_review\.json`/);
    assert.match(comment.stdout, /Lower-level PR facts: `pr_review_surface\.json`/);
    assert.match(comment.stderr, /not postable \(applied\/agent-file\)/);
    // Not the whole-spec dump or boilerplate.
    assert.doesNotMatch(comment.stdout, /\d+ satisfied, \d+ partial, \d+ missing/);
    assert.doesNotMatch(comment.stdout, /Start with missing and partial requirement results/);
    assert.doesNotMatch(comment.stdout, /### Affected coverage/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.4 PR comment rejects a same-head stale human artifact and preserves sidecar conversation value", () => {
  const tmp = setupChangedRepo();
  try {
    const narrative = {
      summary: "Adjusts the comment renderer.",
      what_changed: [{ text: "Tweaked the sticky comment renderer", paths: [CHANGED] }],
      why_it_matters: [{ text: "Affects reviewer-facing output", paths: [CHANGED] }],
      review_first: [{ text: "Confirm the rendered comment", paths: [CHANGED] }],
      risk_narratives: []
    };
    fs.writeFileSync(path.join(tmp, "narrative.json"), JSON.stringify(narrative));
    const prime = runCli(tmp, [...ALL_PR, "--provider", "agent-file", "--agent-input", "narrative.json"]);
    assert.equal(prime.status, 0, prime.stderr);

    const surfacePath = path.join(tmp, ".review-surfaces", "pr_review_surface.json");
    const surface = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
    surface.conversation_analysis = {
      status: "analyzed",
      provider: "agent-file",
      summary: "The final request preserves the sticky marker.",
      intent: [{ text: "Preserve the sticky marker.", event_ids: ["evt-final"] }],
      refinements: [],
      decisions: [],
      constraints: [],
      non_goals: [],
      rejected_alternatives: [],
      claims: [],
      validation_claims: [],
      known_gaps: [],
      quality_flags: []
    };
    surface.review_insights = [{
      id: "CONV-INSIGHT-001",
      category: "intent_mismatch",
      title: "Same-head conversation insight refreshed",
      summary: "The new sidecar carries updated conversation context.",
      why_it_matters: "A stale human artifact would hide the latest reviewer guidance.",
      reviewer_action: "Review the updated conversation finding.",
      priority: "high",
      evidence_state: "unverified",
      basis: "ai_reconciliation",
      conversation_event_ids: ["evt-final"],
      paths: [CHANGED],
      requirement_ids: [],
      risk_ids: [],
      command_ids: [],
      evidence: [{ kind: "conversation", event_id: "evt-final", confidence: "low", validation_status: "valid", llm_proposed: true }]
    }];
    fs.writeFileSync(surfacePath, JSON.stringify(surface, null, 2));

    const comment = runCli(tmp, ["comment", "--mode", "pr", "--out", ".review-surfaces"]);

    assert.equal(comment.status, 0, comment.stderr);
    assert.match(comment.stderr, /Ignoring stale or non-PR human_review\.json/);
    assert.match(comment.stdout, /Same-head conversation insight refreshed/);
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
    const narrative = {
      summary: "Adjusts the comment renderer.",
      what_changed: [{ text: "Tweaked the sticky comment renderer", paths: [CHANGED] }],
      why_it_matters: [{ text: "Affects reviewer-facing output", paths: [CHANGED] }],
      review_first: [{ text: "Confirm the rendered comment", paths: [CHANGED] }],
      risk_narratives: []
    };
    fs.writeFileSync(path.join(tmp, "narrative.json"), JSON.stringify(narrative));

    const prime = runCli(tmp, [...ALL_PR, "--cache", "--provider", "agent-file", "--agent-input", "narrative.json"]);
    assert.equal(prime.status, 0, prime.stderr);
    const surface = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "pr_review_surface.json"), "utf8"));
    assert.equal(surface.status, "ready");

    const hit = runCli(tmp, [...ALL_PR, "--cache", "--provider", "agent-file", "--agent-input", "narrative.json"]);
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

test("review-surfaces.CONVERSATION_REVIEW.4 cache does not reuse a legacy PR sidecar missing conversation fields", () => {
  const tmp = setupChangedRepo();
  try {
    const narrative = {
      summary: "Adjusts the comment renderer.",
      what_changed: [{ text: "Tweaked the sticky comment renderer", paths: [CHANGED] }],
      why_it_matters: [{ text: "Affects reviewer-facing output", paths: [CHANGED] }],
      review_first: [{ text: "Confirm the rendered comment", paths: [CHANGED] }],
      risk_narratives: []
    };
    fs.writeFileSync(path.join(tmp, "narrative.json"), JSON.stringify(narrative));
    const args = [...ALL_PR, "--cache", "--provider", "agent-file", "--agent-input", "narrative.json"];
    const prime = runCli(tmp, args);
    assert.equal(prime.status, 0, prime.stderr);

    const surfacePath = path.join(tmp, ".review-surfaces", "pr_review_surface.json");
    const legacy = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
    delete legacy.conversation_analysis;
    delete legacy.review_insights;
    fs.writeFileSync(surfacePath, JSON.stringify(legacy, null, 2));

    const rerun = runCli(tmp, args);

    assert.equal(rerun.status, 0, rerun.stderr);
    assert.doesNotMatch(rerun.stdout, /inputs unchanged \(signature match\)/);
    const refreshed = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
    assert.ok(refreshed.conversation_analysis);
    assert.ok(Array.isArray(refreshed.review_insights));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("review-surfaces.CONVERSATION_REVIEW.4 cache reuses a deterministic agent-file conversation result", () => {
  const tmp = setupChangedRepo();
  try {
    const narrative = {
      summary: "Adjusts the comment renderer.",
      what_changed: [{ text: "Tweaked the sticky comment renderer", paths: [CHANGED] }],
      why_it_matters: [{ text: "Affects reviewer-facing output", paths: [CHANGED] }],
      review_first: [{ text: "Confirm the rendered comment", paths: [CHANGED] }],
      risk_narratives: []
    };
    fs.writeFileSync(path.join(tmp, "narrative.json"), JSON.stringify(narrative));
    const args = [...ALL_PR, "--cache", "--provider", "agent-file", "--agent-input", "narrative.json"];
    const prime = runCli(tmp, args);
    assert.equal(prime.status, 0, prime.stderr);

    const surfacePath = path.join(tmp, ".review-surfaces", "pr_review_surface.json");
    const degraded = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
    degraded.conversation_analysis.status = "degraded";
    degraded.conversation_analysis.summary = "Temporary provider failure.";
    degraded.conversation_analysis.quality_flags = ["conversation_analysis_unavailable"];
    fs.writeFileSync(surfacePath, JSON.stringify(degraded, null, 2));

    const rerun = runCli(tmp, args);

    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /inputs unchanged \(signature match\)/);
    const reused = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
    assert.equal(reused.conversation_analysis.status, "degraded");
    assert.ok(reused.conversation_analysis.quality_flags.includes("conversation_analysis_unavailable"));
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
      summary: "Keep the renderer behavior.",
      source: "conversation_advisory",
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
    assert.equal(unavailable.conversation_analysis.status, "degraded");
    assert.ok(unavailable.conversation_analysis.quality_flags.includes("conversation_analysis_unavailable"));

    const retryCases = [
      { status: "degraded", flag: "conversation_analysis_unavailable" },
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
      assert.equal(regenerated.conversation_analysis.status, "degraded");
      assert.ok(regenerated.conversation_analysis.quality_flags.includes("conversation_analysis_unavailable"));
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
