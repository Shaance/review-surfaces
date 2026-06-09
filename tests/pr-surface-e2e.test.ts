import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { validateJsonSchema } from "../src/schema/json-schema";
import { HUMAN_STANDALONE_ARTIFACTS } from "../src/human/render";

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
    assert.equal(humanPrComment.status, 4, "mock PR surfaces still fail the postability gate");
    assert.match(humanPrComment.stdout, /JSON sentinel PR comment queue/);
    assert.match(humanPrComment.stdout, /JSON sentinel PR comment draft/);
    assert.match(humanPrComment.stdout, /Full human review: `\.review-surfaces\/human_review\.md`/);
    assert.match(humanPrComment.stderr, /not postable/);
    assert.doesNotMatch(humanPrComment.stdout, /blocked \(`llm_unavailable`\)/);
    const staleHuman = {
      ...human,
      generated_from: { ...human.generated_from, base_ref: "refs/stale-base" }
    };
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(staleHuman, null, 2));
    const staleHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(staleHumanPrComment.status, 4, "stale human JSON should fall back to the blocked PR sidecar");
    assert.match(staleHumanPrComment.stdout, /blocked \(`llm_unavailable`\)/);
    assert.match(staleHumanPrComment.stderr, /Ignoring stale or non-PR human_review\.json/);
    assert.doesNotMatch(staleHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), "{");
    const malformedHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(malformedHumanPrComment.status, 4, "malformed optional human JSON should not block PR comment rendering");
    assert.match(malformedHumanPrComment.stdout, /blocked \(`llm_unavailable`\)/);
    assert.match(malformedHumanPrComment.stderr, /Ignoring unreadable human_review\.json/);
    assert.doesNotMatch(malformedHumanPrComment.stdout, /JSON sentinel PR comment queue/);
    const schemaInvalidHuman = { ...human, verdict: {} };
    fs.writeFileSync(path.join(tmp, ".review-surfaces", "human_review.json"), JSON.stringify(schemaInvalidHuman, null, 2));
    const schemaInvalidHumanPrComment = runCli(tmp, ["comment", "--review-scope", "pr", "--out", ".review-surfaces"]);
    assert.equal(schemaInvalidHumanPrComment.status, 4, "schema-invalid optional human JSON should not block PR comment rendering");
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
    assert.equal(blockedComment.status, 4, "blocked PR surfaces are not postable successful comments");
    assert.match(blockedComment.stdout, /## review-surfaces PR review/);
    assert.match(blockedComment.stdout, /\*\*Verdict:\*\*/);
    assert.match(blockedComment.stdout, /Full human review: `\.review-surfaces\/human_review\.md`/);
    assert.match(blockedComment.stdout, /Human review JSON: `\.review-surfaces\/human_review\.json`/);
    assert.match(blockedComment.stdout, /Lower-level PR facts: `\.review-surfaces\/pr_review_surface\.json`/);
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
    assert.equal(comment.status, 4, "mock PR surfaces still fail the postability gate");
    assert.match(comment.stderr, /Refreshing stale human_review\.json/);
    assert.match(comment.stdout, /Full human review: `\.review-surfaces\/human_review\.md`/);
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
  assert.match(workflow, /working-directory: tool[\s\S]*pnpm install --frozen-lockfile[\s\S]*pnpm run build/);
  assert.match(workflow, /GOOGLE_GENERATIVE_AI_API_KEY: \$\{\{ secrets\.GOOGLE_GENERATIVE_AI_API_KEY \}\}/);
  assert.match(workflow, /node \.\.\/tool\/bin\/review-surfaces\.js all[\s\S]*--review-scope pr/);
  assert.match(workflow, /--model google:gemini-2\.5-flash/);
  assert.match(workflow, /--config "\$GITHUB_WORKSPACE\/tool\/review-surfaces\.config\.yaml"/);
  assert.match(workflow, /--redact-secrets true/);
  assert.match(workflow, /if node -e[\s\S]*s\.llm\?\.provider!=="ai-sdk"[\s\S]*skipping sticky PR comment/);
  assert.doesNotMatch(workflow, /--surface-mode pr/);
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
    assert.equal(comment.status, 4, "agent-file PR narratives render locally but cannot satisfy the sticky-post gate");
    assert.match(comment.stdout, /## review-surfaces PR review/);
    assert.match(comment.stdout, /\*\*Verdict:\*\*/);
    assert.match(comment.stdout, /### Review first/);
    assert.match(comment.stdout, /Full human review: `\.review-surfaces\/human_review\.md`/);
    assert.match(comment.stdout, /Human review JSON: `\.review-surfaces\/human_review\.json`/);
    assert.match(comment.stdout, /Lower-level PR facts: `\.review-surfaces\/pr_review_surface\.json`/);
    assert.match(comment.stderr, /not postable \(applied\/agent-file\)/);
    // Not the whole-spec dump or boilerplate.
    assert.doesNotMatch(comment.stdout, /\d+ satisfied, \d+ partial, \d+ missing/);
    assert.doesNotMatch(comment.stdout, /Start with missing and partial requirement results/);
    assert.doesNotMatch(comment.stdout, /### Affected coverage/);
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
