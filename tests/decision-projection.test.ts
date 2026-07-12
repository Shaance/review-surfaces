import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ConversationAnalysis } from "../src/contracts/conversation-review";
import { fileEvidence, missingEvidence } from "../src/evidence/evidence";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { buildHumanReview } from "../src/human/human-review";
import { buildDecisionProjection } from "../src/human/decision-projection";
import { buildDecisionScope } from "../src/human/decision-admission";
import { validateJsonSchema } from "../src/schema/json-schema";
import type { SemanticChangeFacts } from "../src/risks/semantic-diff";
import { decisionPacket as packet, decisionRisk as risk, decisionSurface as surface, emptyDecisionSemanticFacts as emptySemanticFacts, requirement } from "./helpers/decision-projection";

test("review-surfaces.REVIEWER_VALUE.6 merges detector manifestations by root without merging independent roots", () => {
  const path = "schemas/public.schema.json";
  const pr = surface(path ? [path] : [], [
    risk("PR-RISK-SCHEMA", "schema_contract_change", path, "medium"),
    risk("PR-RISK-SECRET", "secret_in_diff", path, "critical")
  ]);
  const semanticFacts: SemanticChangeFacts = {
    ...emptySemanticFacts,
    schema_changes: [{
      path,
      properties_added: [],
      properties_removed: ["legacy"],
      required_added: [],
      required_removed: [],
      type_changes: [],
      enum_changes: []
    }]
  };
  const model = buildHumanReview({ packet: packet(), prSurface: pr, semanticFacts });
  const findings = model.decision_projection?.findings ?? [];
  const schemaFindings = findings.filter((finding) => finding.root_cause === `persisted_contract:${path}`);
  assert.equal(schemaFindings.length, 1, "schema blocker, PR risk, and semantic queue row must share one slot");
  assert.ok(schemaFindings[0].source_queue_ids.length >= 2, "merged root must retain contributing queue rows");
  assert.ok(findings.some((finding) => finding.root_cause === `secret_boundary:${path}`), "independent secret root on the same path must remain separate");
});

test("review-surfaces.REVIEWER_VALUE.6 admits explicit contracts but keeps internal exports supporting", () => {
  const internalPath = "src/human/private-helper.ts";
  const publicPath = "types/public.d.ts";
  const packagePath = "src/public-entry.ts";
  const internalCliPath = "src/cli/private-helper.ts";
  const binPath = "bin/review-surfaces.js";
  const semanticFacts: SemanticChangeFacts = {
    ...emptySemanticFacts,
    api_changes: [internalPath, publicPath, packagePath, internalCliPath, binPath].map((path) => ({
      path,
      exports_added: [],
      exports_removed: ["removedExport"],
      signatures_changed: [],
      ...(path === packagePath ? { contract_surface: { kind: "package_export" as const, source: "package.json#exports:./dist/src/public-entry.js" } } : {})
    }))
  };
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface([internalPath, publicPath, packagePath, internalCliPath, binPath], [
      risk("PR-RISK-INTERNAL-CONTRACT", "schema_contract_change", internalPath),
      risk("PR-RISK-INTERNAL-DELETE", "deleted_or_renamed_surface", internalPath, "low"),
      risk("PR-RISK-PUBLIC-DELETE", "deleted_or_renamed_surface", publicPath, "low")
    ]),
    semanticFacts
  });
  const findings = model.decision_projection?.findings ?? [];
  assert.ok(findings.some((finding) => finding.root_cause === `public_contract:${publicPath}`));
  assert.ok(findings.some((finding) => finding.root_cause === `public_contract:${packagePath}`));
  assert.ok(!findings.some((finding) => finding.path === binPath));
  assert.ok(!findings.some((finding) => finding.path === internalPath));
  assert.ok(!findings.some((finding) => finding.path === internalCliPath));
  assert.ok(model.semantic_facts.api_changes.some((change) => change.path === internalPath), "internal fact remains in supporting ledger");
});

test("review-surfaces.REVIEWER_VALUE.11 keeps internal importers as supporting evidence", () => {
  const internalPath = "src/internal/helper.ts";
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface([internalPath]),
    semanticFacts: {
      ...emptySemanticFacts,
      api_changes: [{
        path: internalPath,
        exports_added: [],
        exports_removed: ["legacyHelper"],
        signatures_changed: [],
        used_by: { count: 2, top: ["src/a.ts", "src/b.ts"] }
      }]
    }
  });

  assert.ok(!model.review_queue.some((item) => item.title === "Exported API surface change" && item.path === internalPath));
  assert.ok(!model.decision_projection?.findings.some((finding) => finding.path === internalPath));
  assert.equal(model.semantic_facts.api_changes[0].used_by?.count, 2, "importers remain available in the supporting semantic ledger");
});

test("review-surfaces.REVIEWER_VALUE.11 a truncated importer graph cannot promote an internal export", () => {
  const internalPath = "src/internal/helper.ts";
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface([internalPath]),
    semanticFacts: {
      ...emptySemanticFacts,
      api_changes: [{
        path: internalPath,
        exports_added: [],
        exports_removed: ["legacyHelper"],
        signatures_changed: [],
        used_by: { count: 0, top: [], truncated: true }
      }]
    }
  });

  assert.ok(!model.review_queue.some((item) => item.title === "Exported API surface change" && item.path === internalPath));
  assert.ok(!model.decision_projection?.findings.some((finding) => finding.path === internalPath));
  assert.equal(model.semantic_facts.api_changes[0].used_by?.truncated, true);
});

test("review-surfaces.REVIEWER_VALUE.6 public deletion manifestations share one high-priority root", () => {
  const publicPath = "types/public.d.ts";
  const deletionRisk = risk("PR-RISK-DELETE", "deleted_or_renamed_surface", publicPath, "low");
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface([publicPath], [deletionRisk]),
    semanticFacts: {
      ...emptySemanticFacts,
      api_changes: [{ path: publicPath, exports_added: [], exports_removed: ["PublicType"], signatures_changed: [] }]
    }
  });
  const roots = model.decision_projection?.findings.filter((finding) => finding.root_cause === `public_contract:${publicPath}`) ?? [];
  assert.equal(roots.length, 1);
  assert.equal(roots[0].priority, "high");
  assert.equal(model.verdict.decision, "reviewable_with_attention");
});

test("review-surfaces.REVIEWER_VALUE.6 a renamed declaration contract keeps one old-path root", () => {
  const oldPath = "types/public.d.ts";
  const newPath = "src/public.ts";
  const pr = surface([newPath], [risk("PR-RISK-RENAME", "deleted_or_renamed_surface", oldPath, "low")]);
  pr.scope.changed_files[0].old_path = oldPath;
  pr.scope.changed_files[0].status = "R";
  const model = buildHumanReview({
    packet: packet(),
    prSurface: pr,
    semanticFacts: {
      ...emptySemanticFacts,
      api_changes: [{
        path: newPath,
        renamed_from: oldPath,
        contract_removed: true,
        contract_surface: { kind: "declaration", source: oldPath },
        exports_added: [],
        exports_removed: [],
        signatures_changed: []
      }]
    }
  });
  const roots = model.decision_projection?.findings.filter((finding) => finding.root_cause === `public_contract:${oldPath}`) ?? [];
  assert.equal(roots.length, 1);
});

test("review-surfaces.REVIEWER_VALUE.6 internal contract heuristics cannot change the verdict", () => {
  const internalPath = "src/render/load.ts";
  const baseline = buildHumanReview({ packet: packet(), prSurface: surface([internalPath]) });
  const withMechanicalRisk = buildHumanReview({
    packet: packet(),
    prSurface: surface([internalPath], [risk("PR-RISK-INTERNAL", "schema_contract_change", internalPath)]),
    semanticFacts: {
      ...emptySemanticFacts,
      api_changes: [{ path: internalPath, exports_added: [], exports_removed: ["internal"], signatures_changed: [] }]
    }
  });
  assert.equal(withMechanicalRisk.verdict.decision, baseline.verdict.decision);
  assert.deepEqual(withMechanicalRisk.decision_projection?.findings, baseline.decision_projection?.findings);
});

test("review-surfaces.REVIEWER_VALUE.6 ordinary import edges remain supporting context", () => {
  const importer = "src/a.ts";
  const imported = "src/b.ts";
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface([importer, imported]),
    changedImportEdges: [{ importer, imported }]
  });
  assert.ok(model.change_graph.edges.some((edge) => edge.from === importer && edge.to === imported));
  assert.ok(!model.decision_projection?.findings.some((finding) => finding.root_cause.includes("architecture")));
});

test("review-surfaces.REVIEWER_VALUE.6 merged root evidence stays within the strict schema bound", () => {
  const contractPath = "schemas/public.schema.json";
  const schemaRisk = risk("PR-RISK-SCHEMA", "schema_contract_change", contractPath);
  schemaRisk.evidence = Array.from({ length: 8 }, (_, index) =>
    fileEvidence(contractPath, `Independent contract evidence ${index}.`)
  );
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface([contractPath], [schemaRisk]),
    semanticFacts: {
      ...emptySemanticFacts,
      schema_changes: [{
        path: contractPath,
        properties_added: [],
        properties_removed: ["legacy"],
        required_added: [],
        required_removed: [],
        type_changes: [],
        enum_changes: []
      }]
    }
  });
  const finding = model.decision_projection?.findings.find((item) => item.root_cause === `persisted_contract:${contractPath}`);
  assert.equal(finding?.evidence.length, 6);
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));
  assert.equal(validateJsonSchema(schema, model).valid, true);
});

test("review-surfaces.REVIEWER_VALUE.4 projection arrays stay within the strict schema bounds", () => {
  const value = packet();
  value.intent.requirements = Array.from({ length: 20 }, (_, index) => requirement(`REQ-${index}`));
  const pr = surface(["src/reviewer.ts"]);
  pr.scope.affected_requirements = value.intent.requirements.map((entry) => ({
    requirement_id: entry.id,
    acai_id: entry.acai_id,
    reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "src/reviewer.ts" }]
  }));
  const model = buildHumanReview({ packet: value, prSurface: pr });
  assert.equal(model.decision_projection?.active_intent.requirement_ids.length, 24);
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));
  assert.equal(validateJsonSchema(schema, model).valid, true);
});

test("review-surfaces.REVIEWER_VALUE.4 bounds decision prose from schema-valid packet inputs", () => {
  const value = packet();
  const long = "x".repeat(20_000);
  value.intent.summary = long;
  value.risks.test_evidence = [{
    id: "TEST-SKIPPED",
    kind: "missing",
    summary: `Validation skipped ${long}`,
    evidence: [{ kind: "command", command: "pnpm test", sha: "head", confidence: "high", validation_status: "not_checked" }]
  }];
  const model = buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"], [], false) });
  assert.equal(model.decision_projection?.active_intent.summary.length, 2000);
  assert.equal(model.decision_projection?.findings[0].reason.length, 2000);
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));
  assert.equal(validateJsonSchema(schema, model).valid, true);

  const longPath = `types/${"p".repeat(1_100)}.d.ts`;
  const longRisk = risk("PR-RISK-LONG", "secret_in_diff", longPath, "critical");
  longRisk.summary = long;
  longRisk.suggested_checks = [long];
  const pr = surface([longPath], [longRisk], false);
  const projection = buildDecisionProjection({
    packet: value,
    prSurface: pr,
    scope: buildDecisionScope({ packet: value, prSurface: pr }),
    reviewQueue: [],
    blockers: [{
      id: "BLOCK-PR-RISK-LONG",
      severity: "critical",
      summary: long,
      evidence: longRisk.evidence,
      required_action: long
    }],
    semanticFacts: emptySemanticFacts
  });
  assert.equal(projection.findings[0].title.length, 500);
  assert.equal(projection.findings[0].root_cause.length, 500);
  assert.equal(projection.findings[0].path?.length, 1000);
  assert.equal(projection.findings[0].reviewer_action.length, 2000);

  const overlongId = "i".repeat(1_200);
  const idsPacket = packet();
  idsPacket.intent.requirements[0].id = overlongId;
  idsPacket.intent.requirements[0].acai_id = overlongId;
  const idsPr = surface(["schemas/ids.schema.json"], [], false);
  idsPr.scope.affected_requirements = [{
    requirement_id: overlongId,
    acai_id: overlongId,
    reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "schemas/ids.schema.json" }]
  }];
  const idsProjection = buildDecisionProjection({
    packet: idsPacket,
    prSurface: idsPr,
    conversationAnalysis: {
      status: "analyzed", provider: "agent-file", summary: "x",
      intent: [{ text: "Intent", event_ids: [overlongId] }], refinements: [], decisions: [], constraints: [], non_goals: [], rejected_alternatives: [],
      claims: [], validation_claims: [], known_gaps: [], quality_flags: []
    },
    scope: buildDecisionScope({ packet: idsPacket, prSurface: idsPr }),
    reviewQueue: [{
      id: overlongId,
      rank: 1,
      path: "schemas/ids.schema.json",
      title: "Breaking schema",
      priority: "high",
      reason: "Breaking schema",
      reviewer_action: "Review it.",
      evidence: [fileEvidence("schemas/ids.schema.json")],
      requirement_ids: [overlongId],
      risk_ids: [overlongId],
      confidence: "high",
      ranking_reasons: []
    }],
    blockers: [],
    semanticFacts: {
      ...emptySemanticFacts,
      schema_changes: [{ path: "schemas/ids.schema.json", properties_added: [], properties_removed: ["x"], required_added: [], required_removed: [], type_changes: [], enum_changes: [] }]
    }
  });
  assert.ok(idsProjection.active_intent.requirement_ids.every((id) => id.length === 1000));
  assert.ok(idsProjection.findings[0].requirement_ids.every((id) => id.length === 1000));
  assert.ok(idsProjection.findings[0].risk_ids.every((id) => id.length === 1000));
  assert.ok(idsProjection.findings[0].source_queue_ids.every((id) => id.length === 1000));
  const advisoryPr = surface(["src/reviewer.ts"], [], false);
  const eventProjection = buildDecisionProjection({
    packet: idsPacket,
    prSurface: advisoryPr,
    conversationAnalysis: {
      status: "analyzed", provider: "agent-file", summary: "x",
      intent: [{ text: "Intent", event_ids: [overlongId] }], refinements: [], decisions: [], constraints: [], non_goals: [], rejected_alternatives: [],
      claims: [], validation_claims: [], known_gaps: [], quality_flags: []
    },
    scope: buildDecisionScope({ packet: idsPacket, prSurface: advisoryPr }),
    reviewQueue: [], blockers: [], semanticFacts: emptySemanticFacts
  });
  assert.equal(eventProjection.active_intent.event_ids[0].length, 1000);
  const idsModel = buildHumanReview({ packet: idsPacket, prSurface: idsPr });
  idsModel.decision_projection = idsProjection;
  assert.equal(validateJsonSchema(schema, idsModel).valid, true);
});

test("review-surfaces.REVIEWER_VALUE.8 bounds the complete single-requirement intent summary", () => {
  const value = packet();
  const longId = `review-surfaces.${"LONG".repeat(800)}`;
  value.intent.requirements = [{ ...requirement("REQ-LONG"), id: longId, acai_id: longId }];
  const model = buildHumanReview({ packet: value });
  assert.ok((model.decision_projection?.active_intent.summary.length ?? 0) <= 2000);
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));
  assert.equal(validateJsonSchema(schema, model).valid, true);
});

test("review-surfaces.REVIEWER_VALUE.12 deduplicates before the stable three-finding cap", () => {
  const contractPath = "schemas/public.schema.json";
  const paths = [contractPath, ...Array.from({ length: 5 }, (_, index) => `src/area-${index}.ts`)];
  const risks = [
    risk("PR-RISK-SCHEMA", "schema_contract_change", contractPath),
    ...paths.slice(1).map((path, index) => risk(`PR-RISK-${index}`, "untested_changed_impl", path))
  ];
  const input = {
    packet: packet(),
    prSurface: surface(paths, risks),
    semanticFacts: {
      ...emptySemanticFacts,
      schema_changes: [{
        path: contractPath,
        properties_added: [], properties_removed: ["legacy"], required_added: [], required_removed: [], type_changes: [], enum_changes: []
      }]
    }
  };
  const first = buildHumanReview(input);
  const second = buildHumanReview(input);
  assert.equal(first.decision_projection?.findings.length, 3);
  assert.equal(first.decision_projection?.findings.filter((finding) => finding.root_cause === `persisted_contract:${contractPath}`).length, 1);
  assert.deepEqual(first.decision_projection, second.decision_projection);
  assert.equal(first.decision_projection?.supporting_detail_counts.projected_queue_items, 4);
  assert.ok((first.decision_projection?.supporting_detail_counts.supporting_queue_items ?? 0) > 0);
  const counts = first.decision_projection?.supporting_detail_counts;
  assert.equal(counts?.total_queue_items, (counts?.projected_queue_items ?? 0) + (counts?.supporting_queue_items ?? 0));
});

test("review-surfaces.REVIEWER_VALUE.8 leads with the reviewer goal and retains affected requirement anchors", () => {
  const conversationAnalysis: ConversationAnalysis = {
    status: "analyzed",
    provider: "agent-file",
    summary: "Conversation analyzed.",
    intent: [{ text: "An advisory interpretation.", event_ids: ["EVT-2"] }],
    refinements: [], decisions: [], constraints: [], non_goals: [], rejected_alternatives: [],
    claims: [], validation_claims: [], known_gaps: [], quality_flags: []
  };
  const authoritative = buildHumanReview({ packet: packet(), prSurface: surface(["src/reviewer.ts"]), conversationAnalysis });
  assert.equal(authoritative.decision_projection?.active_intent.source, "conversation_advisory");
  assert.match(authoritative.decision_projection?.active_intent.summary ?? "", /Reviewer goal: An advisory interpretation/);
  assert.ok(authoritative.decision_projection?.active_intent.requirement_ids.includes("REQ-DECISION"));

  const advisory = buildHumanReview({ packet: packet(), prSurface: surface(["src/reviewer.ts"], [], false), conversationAnalysis });
  assert.deepEqual(advisory.decision_projection?.active_intent, {
    summary: "Reviewer goal: An advisory interpretation.",
    source: "conversation_advisory",
    requirement_ids: [],
    event_ids: ["EVT-2"]
  });
});

test("review-surfaces.REVIEWER_VALUE.8 summarizes broad affected intent as areas instead of a requirement wall", () => {
  const value = packet();
  value.intent.requirements = Array.from({ length: 5 }, (_, index) => ({
    ...requirement(`REQ-${index}`),
    requirement: `${`Reviewer-visible requirement ${index} `.repeat(40)}finishes cleanly.`
  }));
  const pr = surface(["src/reviewer.ts"]);
  pr.scope.affected_requirements = value.intent.requirements.map((entry) => ({
    requirement_id: entry.id,
    acai_id: entry.acai_id,
    reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "src/reviewer.ts" }]
  }));

  const summary = buildHumanReview({ packet: value, prSurface: pr }).decision_projection?.active_intent.summary ?? "";
  assert.match(summary, /^Reviewed change affects 5 requirement\(s\) across/);
  assert.match(summary, /REQ-0 \(review-surfaces\.REQ-0\)/);
  assert.match(summary, /\(\+2 more areas\)\.$/);
  assert.doesNotMatch(summary, /Reviewer-visible requirement/, "long requirement prose stays out of the primary intent summary");
  assert.ok(summary.length <= 900);
});

test("review-surfaces.REVIEWER_VALUE.8 keeps distinct requirement groups that share a display title", () => {
  const value = packet();
  value.intent.requirements = [
    { ...requirement("ALPHA-1"), acai_id: "review-surfaces.ALPHA.1", title: "Shared reviewer title" },
    { ...requirement("BETA-1"), acai_id: "review-surfaces.BETA.1", title: "Shared reviewer title" }
  ];
  const pr = surface(["src/reviewer.ts"]);
  pr.scope.affected_requirements = value.intent.requirements.map((entry) => ({
    requirement_id: entry.id,
    acai_id: entry.acai_id,
    reasons: [{ rule: "changed_path_requirement_group", confidence: "high", path: "src/reviewer.ts" }]
  }));
  const summary = buildHumanReview({ packet: value, prSurface: pr }).decision_projection?.active_intent.summary ?? "";
  assert.match(summary, /Shared reviewer title \(review-surfaces\.ALPHA\)/);
  assert.match(summary, /Shared reviewer title \(review-surfaces\.BETA\)/);
});

test("review-surfaces.REVIEWER_VALUE.10 keeps generic requirement gaps as questions, not postable comments", () => {
  const value = packet();
  value.evaluation.results = [{
    requirement_id: "REQ-DECISION",
    acai_id: "review-surfaces.HUMAN_TRUST.2",
    status: "partial",
    summary: "Implementation exists but proof is incomplete.",
    evidence: [fileEvidence("src/reviewer.ts")],
    missing_evidence: [missingEvidence("Focused behavioral proof is missing.")],
    review_focus: "Check the behavior.",
    confidence: "medium"
  }];
  const model = buildHumanReview({ packet: value, prSurface: surface(["src/reviewer.ts"]) });
  assert.ok(model.questions.some((question) => question.question.includes("validation evidence or explicit deferral")));
  assert.ok(!model.suggested_comments.some((comment) => comment.body.includes("validation evidence or explicit deferral")));
});

test("review-surfaces.REVIEWER_VALUE.4 repo mode derives active intent from changed requirement text", () => {
  const value = packet();
  value.intent.requirements.push(requirement("REQ-UNRELATED"));
  value.evaluation.results = value.intent.requirements.map((entry) => ({
    requirement_id: entry.id,
    acai_id: entry.acai_id,
    status: "unknown" as const,
    summary: "Not evaluated in this fixture.",
    evidence: [],
    missing_evidence: [missingEvidence("Fixture omits compliance evidence.")],
    review_focus: "Supporting compliance only.",
    confidence: "unknown" as const
  }));
  const diff = parseStructuredDiff([
    "diff --git a/features/review-surfaces.feature.yaml b/features/review-surfaces.feature.yaml",
    "--- a/features/review-surfaces.feature.yaml",
    "+++ b/features/review-surfaces.feature.yaml",
    "@@ -1,1 +1,2 @@",
    " feature: review-surfaces",
    "+          Deliver the reviewer outcome for REQ-DECISION."
  ].join("\n"));
  const model = buildHumanReview({ packet: value, diff });
  assert.equal(model.decision_projection?.active_intent.source, "affected_requirements");
  assert.deepEqual(model.decision_projection?.active_intent.requirement_ids, ["REQ-DECISION", "review-surfaces.REVIEWER_VALUE.4"]);
  assert.equal(model.decision_projection?.supporting_detail_counts.affected_requirement_count, 1);
  assert.equal(model.decision_projection?.supporting_detail_counts.supporting_requirement_count, 1);
});
