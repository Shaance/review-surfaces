import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ConversationAnalysis } from "../src/contracts/conversation-review";
import { fileEvidence, missingEvidence } from "../src/evidence/evidence";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { buildHumanReview } from "../src/human/human-review";
import { buildDecisionProjection } from "../src/human/decision-projection";
import type { ReviewQueueItem } from "../src/human/contract";
import { renderDecisionProjectionMarkdown } from "../src/human/render";
import { buildDecisionScope, schemaChangeDisposition } from "../src/human/decision-admission";
import { validateJsonSchema } from "../src/schema/json-schema";
import type { SemanticChangeFacts } from "../src/risks/semantic-diff";
import { decisionPacket as packet, decisionRisk as risk, decisionSurface as surface, emptyDecisionSemanticFacts as emptySemanticFacts, requirement } from "./helpers/decision-projection";

test("schema disposition indexes a semantic-fact set once across repeated decisions", () => {
  let pathReads = 0;
  const schemaChanges = Array.from({ length: 1_000 }, (_, index) => {
    const change = {
      properties_added: ["added"],
      properties_removed: [],
      required_added: [],
      required_removed: [],
      type_changes: [],
      enum_changes: []
    } as Record<string, unknown>;
    Object.defineProperty(change, "path", {
      enumerable: true,
      get() {
        pathReads += 1;
        return `schemas/${index}.json`;
      }
    });
    return change;
  }) as unknown as SemanticChangeFacts["schema_changes"];

  assert.equal(schemaChangeDisposition(["schemas/999.json"], schemaChanges), "additive");
  const readsAfterIndexBuild = pathReads;
  assert.equal(schemaChangeDisposition(["schemas/1.json", "schemas/999.json"], schemaChanges), "additive");
  assert.equal(pathReads, readsAfterIndexBuild, "later decisions reuse the normalized path index");
});

test("broad requirement scope preserves the packet goal instead of presenting an inventory as intent", () => {
  const value = packet();
  value.intent.requirements = Array.from({ length: 10 }, (_, index) => requirement(`REQ-${index}`, `review-surfaces.BROAD.${index}`));
  value.intent.requirements.forEach((item) => { item.title = "Reviewer decision quality uplift"; });
  value.agent_handoff = { summary: "Current milestone.", current_milestone: "usefulness-M1", next_tasks: [] };
  value.evaluation.results = value.intent.requirements.map((item) => ({
    requirement_id: item.id,
    acai_id: item.acai_id,
    status: "partial" as const,
    summary: "Needs review.",
    partial_reason: "other" as const,
    evidence: [],
    missing_evidence: [],
    review_focus: "Review the affected behavior.",
    confidence: "medium" as const
  }));
  const affected = new Set(value.intent.requirements.flatMap((item) => [item.id, item.acai_id! ]));
  const projection = buildDecisionProjection({
    packet: value,
    scope: { mode: "pr", changed_paths: new Set(["features/review-surfaces.feature.yaml"]), affected_requirement_ids: affected, head_sha: "head", working_tree_dirty: false },
    reviewQueue: [],
    blockers: [],
    semanticFacts: emptySemanticFacts
  });
  assert.equal(projection.active_intent.source, "packet");
  assert.match(projection.active_intent.summary, /^Make the review immediately useful to an approver\./);
  assert.match(projection.active_intent.summary, /Current milestone: usefulness-M1\./);
  assert.match(projection.active_intent.summary, /Affected areas: Reviewer decision quality uplift\./);
  assert.match(projection.active_intent.summary, /Scope: 10 of 10 requirements are affected\./);
  assert.doesNotMatch(projection.active_intent.summary, /^Reviewed change affects/);
});

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
  assert.ok(findings.some((finding) => finding.root_cause === `secret_boundary:${path}`), "independent secret root on the same path must remain separate");
});

test("the interdependent PR and human review schemas form one artifact-reset decision", () => {
  const paths = ["schemas/human_review.schema.json", "schemas/pr_review_surface.schema.json"];
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface(paths, paths.map((path, index) => risk(`PR-RISK-SCHEMA-${index}`, "schema_contract_change", path))),
    semanticFacts: {
      ...emptySemanticFacts,
      schema_changes: paths.map((path) => ({
        path,
        properties_added: [],
        properties_removed: ["legacy"],
        required_added: [],
        required_removed: [],
        type_changes: [],
        enum_changes: []
      }))
    }
  });

  const resets = model.decision_projection?.findings.filter((finding) => finding.root_cause === "review_artifact_contract") ?? [];
  assert.equal(resets.length, 1);
  assert.equal(resets[0].path, undefined);
  assert.deepEqual([...new Set(resets[0].evidence.flatMap((ref) => ref.path))].sort(), paths);
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

test("review-surfaces.REVIEWER_VALUE.6 keeps distinct package contracts in distinct decision roots", () => {
  const packagePath = "package.json";
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface([packagePath]),
    semanticFacts: {
      ...emptySemanticFacts,
      api_changes: ["export:./alpha", "export:./beta"].map((contractName, index) => ({
        path: packagePath,
        contract_removed: true,
        // The second fact exercises the contract-surface identity fallback.
        ...(index === 0 ? { contract_name: contractName } : {}),
        contract_surface: {
          kind: "package_export" as const,
          source: `package.json#exports:${contractName}`,
          identity: contractName
        },
        exports_added: [],
        exports_removed: [],
        signatures_changed: []
      }))
    }
  });
  const roots = model.decision_projection?.findings.map((finding) => finding.root_cause) ?? [];
  assert.ok(roots.includes("public_contract:package.json:export:./alpha"));
  assert.ok(roots.includes("public_contract:package.json:export:./beta"));
  assert.equal(
    model.review_queue.some((item) => item.path === packagePath && item.title === "Changed implementation file"),
    false,
    "a precise semantic contract item prunes the generic changed-file fallback"
  );
  const packageFindings = model.decision_projection?.findings
    .filter((finding) => finding.root_cause.startsWith("public_contract:package.json:")) ?? [];
  assert.equal(packageFindings.length, 2);
});

test("approval decisions are not truncated by the supporting review-queue limit", () => {
  const paths = Array.from({ length: 25 }, (_, index) => `types/public-${index}.d.ts`);
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface(paths),
    semanticFacts: {
      ...emptySemanticFacts,
      api_changes: paths.map((path) => ({
        path,
        exports_added: [],
        exports_removed: ["legacyExport"],
        signatures_changed: []
      }))
    }
  });

  assert.equal(model.review_queue.length, 20, "the supporting queue remains bounded for scanability");
  assert.equal(model.decision_projection?.findings.length, 25, "every independent public contract remains an approval decision");
  assert.deepEqual(
    model.decision_projection?.findings.map((finding) => finding.path).sort(),
    [...paths].sort()
  );
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

test("review-surfaces.REVIEWER_VALUE.6 merged roots preserve complete decision evidence", () => {
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
  assert.ok((finding?.evidence.length ?? 0) >= 8);
  for (let index = 0; index < 8; index += 1) {
    assert.ok(finding?.evidence.some((ref) => ref.note === `Independent contract evidence ${index}.`));
  }
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "human_review.schema.json"), "utf8"));
  assert.equal(validateJsonSchema(schema, model).valid, true);
});

test("large adaptive decision sets merge one shared root without losing evidence", () => {
  const count = 1_000;
  const paths = Array.from({ length: count }, (_, index) => `src/render/surface-${index}.ts`);
  const risks = paths.map((filePath, index) => risk(`PR-RISK-${index}`, "comment_surface_change", filePath));
  const reviewQueue: ReviewQueueItem[] = risks.map((item, index) => ({
    id: `REVIEW-${index}`,
    rank: index + 1,
    title: `Reviewer surface ${index}`,
    path: paths[index],
    reviewer_action: "Inspect the reviewer-facing output.",
    reason: "The reviewer-facing output changed.",
    ranking_reasons: ["Reviewer-facing change."],
    evidence: item.evidence,
    requirement_ids: [],
    risk_ids: [item.id],
    confidence: "high",
    priority: "medium"
  }));
  const projection = buildDecisionProjection({
    packet: packet(),
    prSurface: surface(paths, risks),
    scope: {
      mode: "pr",
      changed_paths: new Set(paths),
      affected_requirement_ids: new Set(),
      head_sha: "head",
      working_tree_dirty: false
    },
    reviewQueue,
    blockers: [],
    semanticFacts: emptySemanticFacts
  });

  assert.equal(projection.findings.length, 1);
  assert.equal(projection.findings[0].root_cause, "review_surface");
  assert.equal(projection.findings[0].evidence.length, count);
  assert.deepEqual(
    projection.findings[0].evidence.map((ref) => ref.path),
    paths
  );
});

test("large adaptive untested sets index changed-file validation areas", () => {
  const count = 1_000;
  const paths = Array.from({ length: count }, (_, index) => `src/validation/area-${index}.ts`);
  const risks = paths.map((filePath, index) => risk(`PR-RISK-UNTESTED-${index}`, "untested_changed_impl", filePath));
  const prSurface = surface(paths, risks);
  prSurface.scope.changed_files.forEach((file, index) => { file.areas = [`VALIDATION_${index}`]; });
  const reviewQueue: ReviewQueueItem[] = risks.map((item, index) => ({
    id: `REVIEW-UNTESTED-${index}`,
    rank: index + 1,
    title: `Untested validation area ${index}`,
    path: paths[index],
    reviewer_action: "Confirm focused validation at the current head.",
    reason: "No current-head validation transcript covers this area.",
    ranking_reasons: ["Current-head validation is missing."],
    evidence: item.evidence,
    requirement_ids: [],
    risk_ids: [item.id],
    confidence: "high",
    priority: "medium"
  }));
  const projection = buildDecisionProjection({
    packet: packet(),
    prSurface,
    scope: {
      mode: "pr",
      changed_paths: new Set(paths),
      affected_requirement_ids: new Set(),
      head_sha: "head",
      working_tree_dirty: false
    },
    reviewQueue,
    blockers: [],
    semanticFacts: emptySemanticFacts
  });

  assert.equal(projection.findings.length, count);
  assert.equal(projection.findings[0].root_cause, "test_validation_area:VALIDATION_0");
  assert.ok(projection.findings.some((finding) => finding.root_cause === `test_validation_area:VALIDATION_${count - 1}`));
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

test("review-surfaces.REVIEWER_VALUE.12 deduplicates roots without hiding independent approval decisions", () => {
  const contractPath = "schemas/public.schema.json";
  const paths = [contractPath, ...Array.from({ length: 5 }, (_, index) => `src/area-${index}.ts`)];
  const risks = [
    risk("PR-RISK-SCHEMA", "schema_contract_change", contractPath),
    ...paths.slice(1).map((path, index) => risk(`PR-RISK-${index}`, "untested_changed_impl", path))
  ];
  const prSurface = surface(paths, risks);
  prSurface.scope.changed_files
    .filter((file) => file.path !== contractPath)
    .forEach((file, index) => { file.areas = [`INDEPENDENT_AREA_${index}`]; });
  const input = {
    packet: packet(),
    prSurface,
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
  assert.equal(first.decision_projection?.findings.length, paths.length);
  assert.equal(first.decision_projection?.findings.filter((finding) => finding.root_cause === `persisted_contract:${contractPath}`).length, 1);
  assert.deepEqual(first.decision_projection, second.decision_projection);
});

test("product reset M1 decision count scales with approval choices, not changed-file count", () => {
  const mechanicalPaths = Array.from({ length: 6 }, (_, index) => `src/generated/part-${index}.ts`);
  const mechanicalSurface = surface(
    mechanicalPaths,
    mechanicalPaths.map((path, index) => risk(`PR-RISK-MECHANICAL-${index}`, "untested_changed_impl", path))
  );
  for (const file of mechanicalSurface.scope.changed_files) file.areas = ["GENERATED_CLIENT"];
  const oneDecision = buildHumanReview({
    packet: packet(),
    prSurface: mechanicalSurface
  });
  assert.equal(oneDecision.decision_projection?.findings.length, 1, "many files with one validation choice produce one approval decision");
  assert.equal(oneDecision.decision_projection?.findings[0].title, "Current-head test evidence");

  const independentPaths = Array.from({ length: 14 }, (_, index) => `src/boundary-${index}.ts`);
  const independentSurface = surface(
    independentPaths,
    independentPaths.map((path, index) => risk(`PR-RISK-${index}`, "untested_changed_impl", path))
  );
  independentSurface.scope.changed_files.forEach((file, index) => { file.areas = [`BOUNDARY_${index}`]; });
  const independentDecisions = buildHumanReview({
    packet: packet(),
    prSurface: independentSurface
  });
  assert.equal(independentDecisions.decision_projection?.findings.length, 14, "every independent validation area survives beyond twelve");
});

test("coverage regression remains a coverage decision rather than a grouped transcript decision", () => {
  const coverageRisk = risk("PR-RISK-COVERAGE", "coverage_regression", "features/review-surfaces.feature.yaml");
  coverageRisk.evidence.push(fileEvidence("tests/pr-surface-e2e.test.ts", "The affected requirement previously had test evidence here."));
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface(["features/review-surfaces.feature.yaml", "tests/pr-surface-e2e.test.ts"], [coverageRisk])
  });
  const finding = model.decision_projection?.findings[0];
  assert.equal(finding?.root_cause, "test_coverage:features/review-surfaces.feature.yaml");
  assert.match(finding?.title ?? "", /coverage[_ ]regression/i);
  assert.doesNotMatch(finding?.title ?? "", /current-head test evidence/i);
});

test("product reset M1 keeps test heuristics supporting and admits one reviewer-surface contract", () => {
  const paths = ["src/render/sticky-summary.ts", "tests/sticky-summary.test.ts"];
  const model = buildHumanReview({
    packet: packet(),
    prSurface: surface(paths, [
      risk("PR-RISK-SURFACE", "comment_surface_change", paths[0]),
      risk("PR-RISK-TEST", "failed_or_skipped_test", paths[1])
    ]),
    semanticFacts: {
      ...emptySemanticFacts,
      test_weakening: paths.slice(1).map((testPath) => ({
        kind: "removed_assertion" as const,
        path: testPath,
        detail: "An assertion was removed."
      }))
    }
  });

  assert.equal(model.decision_projection?.findings.length, 1);
  assert.equal(model.decision_projection?.findings[0].root_cause, "review_surface");
  assert.equal(model.decision_projection?.findings[0].title, "Reviewer brief contract");
  assert.ok(model.review_queue.some((item) => /removed assertion/i.test(item.title)), "test heuristics remain available as supporting evidence");
  assert.ok(model.suggested_comments.every((comment) => !/assertion was removed|removed assertion/i.test(comment.body)));
});

test("product reset M1 uses author-provided PR context as the change purpose", () => {
  const prSurface = surface(["src/reviewer.ts"]);
  prSurface.change_context = {
    title: "Make reviewer decisions legible",
    description: "## Summary\n\n- Explain the approval decisions before diagnostic detail.\n\n## Validation\n\n- pnpm test",
    source: "github",
    redaction_blocked: false
  };
  const model = buildHumanReview({ packet: packet(), prSurface });
  assert.equal(model.decision_projection?.active_intent.source, "pull_request");
  assert.match(model.decision_projection?.active_intent.summary ?? "", /^Make reviewer decisions legible\./);
  assert.match(model.decision_projection?.active_intent.summary ?? "", /Explain the approval decisions/);
  assert.doesNotMatch(model.decision_projection?.active_intent.summary ?? "", /pnpm test/);
});

test("product reset M1 reads a standard Description section without absorbing later validation", () => {
  const prSurface = surface(["src/reviewer.ts"]);
  prSurface.change_context = {
    title: "Make reviewer decisions legible",
    description: "## Description:\n\nExplain the approval decisions before diagnostic detail.\n\n## Validation\n\npnpm test",
    source: "github",
    redaction_blocked: false
  };
  const model = buildHumanReview({ packet: packet(), prSurface });
  assert.match(model.decision_projection?.active_intent.summary ?? "", /Explain the approval decisions/);
  assert.doesNotMatch(model.decision_projection?.active_intent.summary ?? "", /pnpm test/);
});

test("product reset M1 reads a case-insensitive Purpose section without absorbing later testing", () => {
  const prSurface = surface(["src/reviewer.ts"]);
  prSurface.change_context = {
    title: "Make reviewer decisions legible",
    description: "## PURPOSE —\n\nHelp reviewers decide whether the change is safe.\n\n## Testing\n\npnpm test",
    source: "github",
    redaction_blocked: false
  };
  const model = buildHumanReview({ packet: packet(), prSurface });
  assert.match(model.decision_projection?.active_intent.summary ?? "", /Help reviewers decide whether the change is safe/);
  assert.doesNotMatch(model.decision_projection?.active_intent.summary ?? "", /pnpm test/);
});

test("product reset M1 does not mistake PR template testing sections for the change purpose", () => {
  const prSurface = surface(["src/reviewer.ts"]);
  prSurface.change_context = {
    title: "Make reviewer decisions legible",
    description: "<!-- Describe the user-facing change above. -->\n## Testing\n\n- pnpm test\n\n## Screenshots\n\nNot applicable.",
    source: "github",
    redaction_blocked: false
  };
  const model = buildHumanReview({ packet: packet(), prSurface });
  assert.equal(model.decision_projection?.active_intent.summary, "Make reviewer decisions legible");
});

test("product reset M1 stops an empty summary section before the testing section", () => {
  const prSurface = surface(["src/reviewer.ts"]);
  prSurface.change_context = {
    title: "Make reviewer decisions legible",
    description: "## Summary\n\n## Testing\n\n- pnpm test",
    source: "github",
    redaction_blocked: false
  };
  const model = buildHumanReview({ packet: packet(), prSurface });
  assert.equal(model.decision_projection?.active_intent.summary, "Make reviewer decisions legible");
});

test("author-provided purpose renders as literal prose on the full Markdown surface", () => {
  const prSurface = surface(["src/reviewer.ts"]);
  prSurface.change_context = {
    title: "<!-- hide decisions --> # Fake heading [click](https://attacker.invalid) *owned*",
    source: "github",
    redaction_blocked: false
  };
  const markdown = renderDecisionProjectionMarkdown(buildHumanReview({ packet: packet(), prSurface }));

  assert.doesNotMatch(markdown, /<!-- hide decisions -->/);
  assert.match(markdown, /&lt;!-- hide decisions --&gt;/);
  assert.match(markdown, /## Approval decisions/);
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
    redaction_blocked: false,
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
  assert.match(summary, /^Make the review immediately useful to an approver\./);
  assert.match(summary, /Affected areas: REQ-0, REQ-1, REQ-2 \(\+2 more\)\./);
  assert.match(summary, /Scope: 5 of 5 requirements are affected\.$/);
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

test("review-surfaces.REVIEWER_VALUE.10 keeps generic requirement gaps in diagnostics, not author actions", () => {
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
  assert.ok(!model.questions.some((question) => question.question.includes("validation evidence or explicit deferral")));
  assert.ok(!model.suggested_comments.some((comment) => comment.body.includes("validation evidence or explicit deferral")));
  assert.ok(!model.test_plan.some((item) => item.maps_to_requirements.includes("review-surfaces.HUMAN_TRUST.2")));
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
});
