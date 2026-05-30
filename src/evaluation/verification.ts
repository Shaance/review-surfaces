import { CollectionResult } from "../collector/collect";
import { EvidenceRef, isLlmProposed } from "../evidence/evidence";
import { IntentModel } from "../intent/intent";
import { buildReviewAreas, createReviewAreaMatcher, ReviewAreaMatcher } from "../review-areas/areas";
import { NormalizedTestCase } from "../tests-evidence/junit";
import {
  ACID_PATTERN,
  groupFromAcid,
  isImplementationEvidencePath,
  isTestOnlyRequirement,
  mentionsGroupToken,
  unique,
  uniqueEvidence
} from "./evidence-rules";
import type { EvaluateOptions, EvaluationModel, RequirementResult } from "./evaluate";
import { countRequirementStatuses, formatRequirementStatusSummary } from "./status";

// ---------------------------------------------------------------------------
// VERIFICATION LOOP (#2): partial -> satisfied ONLY via a real PASSING test that
// proves THIS SPECIFIC requirement.
//
// This deliberately loosens the satisfied guardrail, so it is conservative by
// construction and runs AFTER the reasoning stage (so it can see any
// LLM-pinpointed test names attached as llm_proposed test evidence). A
// requirement may be promoted partial->satisfied ONLY when ALL hold:
//   1. collection.testResults is present and non-empty (--test-output supplied).
//      With NO results this is a COMPLETE no-op (baseline byte-unchanged).
//   2. There is a PARSED PASSING test case (not failed, not skipped) that maps to
//      THIS SPECIFIC requirement (NOT merely to its broad group), where the
//      per-requirement mapping means EITHER:
//        (a) EXACT-ACID: the passing test's name/classname/suite references the
//            requirement's EXACT ACID (e.g. contains "review-surfaces.RENDER.1").
//            A passing test that only maps to the requirement GROUP (its
//            classname names the group token, or it references a DIFFERENT ACID
//            in the same group) is INTENTIONALLY NOT enough: a passing "render"
//            area test does not prove RENDER.5 specifically. OR
//        (b) LLM-PINPOINTED-AND-CORROBORATED: the reasoning stage proposed that
//            specific test for this specific requirement (an llm_proposed test
//            ref with a matching test_name) AND that test is ALSO at least
//            group-mapped (corroborated). A pure cross-area LLM claim with NO
//            group corroboration MUST NOT qualify. The LLM word alone NEVER
//            promotes.
//   3. The requirement already has IMPLEMENTATION evidence (exact or broad),
//      UNLESS it is a test-only requirement (isTestOnlyRequirement) which may be
//      satisfied by the verified test alone. A verified test must NEVER satisfy a
//      requirement that still lacks implementation (except test-only).
//
// On promotion: attach the passing test as VERIFIED evidence (kind: test,
// validation_status "valid", verified=true, the REAL test_name), set status
// satisfied, confidence high for the exact-ACID mapping / medium for the
// LLM-pinpointed mapping, and clear partial_reason.
//
// A passing test that maps ONLY to the requirement GROUP (no exact ACID, no LLM
// pinpoint) does NOT promote. Instead it is attached as VERIFIED-but-BROAD test
// evidence (kind: test, validation_status "valid", verified=true, the REAL
// test_name, a note explaining it is broad / not requirement-specific) and the
// requirement STAYS partial with partial_reason "broad_area_only". This records
// that a real passing area test exists without overstating per-requirement
// coverage.
//
// The pass mutates evaluation.results in place and re-derives acai_coverage and
// the summary so promotions are reflected downstream. It is idempotent: a result
// already carrying verified test evidence is left untouched.
export function verifyRequirementsWithTests(
  collection: CollectionResult,
  intent: IntentModel,
  evaluation: EvaluationModel,
  options: EvaluateOptions = {}
): EvaluationModel {
  const testResults = collection.testResults;
  if (!testResults || testResults.cases.length === 0) {
    return evaluation;
  }

  const passingCases = testResults.cases.filter((testCase) => testCase.status === "passed");
  if (passingCases.length === 0) {
    return evaluation;
  }

  const areas = options.areas ?? buildReviewAreas({ repoIndex: collection.repoIndex }).areas;
  const matcher = createReviewAreaMatcher(areas);
  const knownAcids = new Set(intent.requirements.map((requirement) => requirement.acai_id).filter(Boolean) as string[]);
  const knownGroups = new Set(
    intent.requirements.map((requirement) => groupFromAcid(requirement.acai_id)).filter(Boolean) as string[]
  );
  const requirementById = new Map(intent.requirements.map((requirement) => [requirement.id, requirement]));
  // The actual COLLECTED test files. A passing case's classname only contributes
  // a group mapping when it IS one of these real test paths (not an arbitrary
  // free-text classname), so a misleadingly named classname cannot promote.
  const collectedTestPaths = new Set(collection.tests.map((test) => test.path));

  // Pre-compute, per passing case, the deterministic mapping facts: which ACIDs
  // it references and which groups it maps to. "Maps to a group" is intentionally
  // STRICTER than the partial-nudge mapping: the case's group must be revealed by
  // an ACID it references, a group token in its classname/suite (NOT its
  // human-readable name), or a classname that is a real collected test path
  // mapping to the group via the strict review-area mapping.
  const mappedCases = passingCases.map((testCase) => {
    const acids = passingCaseAcids(testCase, knownAcids);
    return {
      testCase,
      acids,
      groups: passingCaseGroups(testCase, knownGroups, acids, matcher, collectedTestPaths)
    };
  });
  const mappedCaseIndex = indexMappedPassingCases(mappedCases);

  let mutated = false;
  for (const result of evaluation.results) {
    if (result.status !== "partial") {
      continue;
    }
    // Idempotent: never re-process a result that already carries verified proof
    // (either a satisfied promotion or a previously-attached verified-broad ref).
    if (result.evidence.some((ref) => ref.verified === true)) {
      continue;
    }
    const requirement = requirementById.get(result.requirement_id);
    const group = groupFromAcid(result.acai_id);

    const match = findVerifyingCase(result, group, mappedCaseIndex, matcher);
    if (match) {
      // Invariant #3: implementation evidence is required unless test-only.
      const testOnly = requirement ? isTestOnlyRequirement(requirement, group) : false;
      if (!testOnly && !resultHasImplementationEvidence(result, collectedTestPaths)) {
        continue; // A verified test alone may NEVER satisfy a non-test-only requirement.
      }
      promoteToVerified(result, match);
      mutated = true;
      continue;
    }

    // No per-requirement proof. A passing test that maps ONLY to the broad group
    // (no exact ACID, no LLM pinpoint) must NOT promote: a passing "render" area
    // test does not prove RENDER.5 specifically. Record it as VERIFIED-but-BROAD
    // test evidence so the real passing area test is auditable, but keep the
    // requirement partial (broad_area_only). The implementation gate is NOT
    // relevant here: nothing is being satisfied, only evidence is being attached.
    const broadCase = findGroupOnlyVerifyingCase(group, mappedCaseIndex);
    if (broadCase) {
      attachVerifiedBroadTestEvidence(result, broadCase);
      mutated = true;
    }
  }

  if (!mutated) {
    return evaluation;
  }

  // Re-derive coverage + summary so the promotions are reflected downstream.
  for (const result of evaluation.results) {
    if (result.acai_id) {
      evaluation.acai_coverage[result.acai_id] = result.status;
    }
  }
  const statusCounts = countRequirementStatuses(evaluation.results);
  evaluation.summary = `${formatRequirementStatusSummary(statusCounts, evaluation.overreach.length)}. Statuses are conservative and evidence-backed.`;
  return evaluation;
}

interface MappedPassingCase {
  testCase: NormalizedTestCase;
  acids: string[];
  groups: Set<string>;
}

interface MappedPassingCaseIndex {
  firstByAcid: Map<string, MappedPassingCase>;
  byName: Map<string, MappedPassingCase[]>;
  firstByGroup: Map<string, MappedPassingCase>;
}

type VerifyBasis = "exact_acid" | "llm_pinpointed";

interface VerifyingMatch {
  testCase: NormalizedTestCase;
  basis: VerifyBasis;
}

function findVerifyingCase(
  result: RequirementResult,
  group: string | undefined,
  mappedCases: MappedPassingCaseIndex,
  matcher: ReviewAreaMatcher
): VerifyingMatch | undefined {
  if (result.acai_id) {
    const exactMatch = mappedCases.firstByAcid.get(result.acai_id);
    if (exactMatch) {
      return { testCase: exactMatch.testCase, basis: "exact_acid" };
    }
  }

  if (!group) {
    return undefined;
  }
  const pinpoints = llmPinpointedTests(result);
  if (pinpoints.length === 0) {
    return undefined;
  }
  for (const pinpoint of pinpoints) {
    if (
      typeof pinpoint.path !== "string" ||
      !matcher.groupsForPath(pinpoint.path, { purpose: "requirement_proof" }).includes(group)
    ) {
      continue;
    }
    const candidates = mappedCases.byName.get(pinpoint.testName);
    if (!candidates || candidates.length === 0) {
      continue;
    }
    const ownGroupMatch = candidates.find((mapped) => mapped.groups.has(group));
    if (ownGroupMatch) {
      return { testCase: ownGroupMatch.testCase, basis: "llm_pinpointed" };
    }
    const neutral = candidates.find((mapped) => mapped.groups.size === 0);
    if (neutral) {
      return { testCase: neutral.testCase, basis: "llm_pinpointed" };
    }
  }
  return undefined;
}

function findGroupOnlyVerifyingCase(
  group: string | undefined,
  mappedCases: MappedPassingCaseIndex
): NormalizedTestCase | undefined {
  if (!group) {
    return undefined;
  }
  return mappedCases.firstByGroup.get(group)?.testCase;
}

function indexMappedPassingCases(mappedCases: MappedPassingCase[]): MappedPassingCaseIndex {
  const firstByAcid = new Map<string, MappedPassingCase>();
  const byName = new Map<string, MappedPassingCase[]>();
  const firstByGroup = new Map<string, MappedPassingCase>();

  for (const mapped of mappedCases) {
    for (const acid of mapped.acids) {
      if (!firstByAcid.has(acid)) {
        firstByAcid.set(acid, mapped);
      }
    }
    const bucket = byName.get(mapped.testCase.name) ?? [];
    bucket.push(mapped);
    byName.set(mapped.testCase.name, bucket);
    for (const group of mapped.groups) {
      if (!firstByGroup.has(group)) {
        firstByGroup.set(group, mapped);
      }
    }
  }

  return { firstByAcid, byName, firstByGroup };
}

interface LlmPinpoint {
  testName: string;
  path?: string;
}

function llmPinpointedTests(result: RequirementResult): LlmPinpoint[] {
  const pinpoints: LlmPinpoint[] = [];
  for (const ref of result.evidence) {
    if (ref.kind === "test" && isLlmProposed(ref) && typeof ref.test_name === "string" && ref.test_name.length > 0) {
      pinpoints.push({ testName: ref.test_name, path: ref.path });
    }
  }
  return pinpoints;
}

function passingCaseAcids(testCase: NormalizedTestCase, knownAcids: Set<string>): string[] {
  const haystack = [testCase.name, testCase.classname, testCase.suite].filter(Boolean).join(" ");
  return unique(haystack.match(ACID_PATTERN) ?? []).filter((acid) => knownAcids.has(acid));
}

function passingCaseGroups(
  testCase: NormalizedTestCase,
  knownGroups: Set<string>,
  acids: string[],
  matcher: ReviewAreaMatcher,
  collectedTestPaths: Set<string>
): Set<string> {
  const groups = new Set<string>();
  // The group-token haystack is the case's CLASSNAME and SUITE only. The
  // human-readable test NAME is deliberately excluded: a free-text name that
  // merely contains a group token as a word is not provenance and must not be a
  // basis for a SATISFIED promotion. ACID references in the name still count.
  const tokenHaystack = [testCase.classname, testCase.suite].filter(Boolean).join(" ");

  for (const acid of acids) {
    const group = groupFromAcid(acid);
    if (group) {
      groups.add(group);
    }
  }
  for (const group of knownGroups) {
    if (mentionsGroupToken(tokenHaystack, group)) {
      groups.add(group);
    }
  }
  if (typeof testCase.classname === "string" && collectedTestPaths.has(testCase.classname)) {
    for (const group of matcher.groupsForPath(testCase.classname, { purpose: "requirement_proof" })) {
      groups.add(group);
    }
  }
  return groups;
}

function resultHasImplementationEvidence(result: RequirementResult, collectedTestPaths: Set<string>): boolean {
  return result.evidence.some(
    (ref) =>
      (ref.kind === "file" || ref.kind === "diff") &&
      !isLlmProposed(ref) &&
      typeof ref.path === "string" &&
      isImplementationEvidencePath(ref.path, collectedTestPaths)
  );
}

function promoteToVerified(result: RequirementResult, match: VerifyingMatch): void {
  const exactAcid = match.basis === "exact_acid";
  const note = exactAcid
    ? "Requirement verified by a passing parsed test that references its exact ACID."
    : "Requirement verified by a passing parsed test; test pinpointed by LLM and corroborated by the requirement group's test set.";
  const verifiedEvidence: EvidenceRef = {
    kind: "test",
    test_name: match.testCase.name,
    note,
    confidence: exactAcid ? "high" : "medium",
    validation_status: "valid",
    verified: true
  };
  const exists = result.evidence.some(
    (ref) => ref.verified === true && ref.test_name === verifiedEvidence.test_name
  );
  if (!exists) {
    result.evidence = uniqueEvidence([verifiedEvidence, ...result.evidence]);
  }
  result.status = "satisfied";
  result.confidence = exactAcid ? "high" : "medium";
  result.summary = exactAcid
    ? "Requirement promoted to satisfied: a passing parsed test references its exact ACID."
    : "Requirement promoted to satisfied: a passing parsed test verifies it (test pinpointed by LLM, group-corroborated).";
  result.partial_reason = undefined;
  result.review_focus =
    "Spot-check the verified passing test actually exercises the required behavior, not just file presence.";
  result.missing_evidence = result.missing_evidence.filter((ref) => ref.validation_status === "invalid");
}

function attachVerifiedBroadTestEvidence(result: RequirementResult, testCase: NormalizedTestCase): void {
  const verifiedEvidence: EvidenceRef = {
    kind: "test",
    test_name: testCase.name,
    note: "verified passing area test (broad, not requirement-specific)",
    confidence: "medium",
    validation_status: "valid",
    verified: true
  };
  const exists = result.evidence.some(
    (ref) => ref.verified === true && ref.test_name === verifiedEvidence.test_name
  );
  if (!exists) {
    result.evidence = uniqueEvidence([verifiedEvidence, ...result.evidence]);
  }
  result.status = "partial";
  result.partial_reason = "broad_area_only";
}
