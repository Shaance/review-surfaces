import path from "node:path";
import { CollectionResult } from "../collector/collect";
import { isRegularFile, readText } from "../core/files";
import { walkFiles } from "../core/glob";
import { EvidenceRef, fileEvidence, isLlmProposed, missingEvidence, specEvidence, testEvidence } from "../evidence/evidence";
import { validateRequirementResultEvidence } from "../evidence/validate";
import { FileClassification, RepoIndex } from "../indexer/indexer";
import { IntentModel, IntentRequirement } from "../intent/intent";
import { buildReviewAreas, groupsForReviewPath, isLaterProviderGroup, ReviewArea, ReviewAreasMode, strictGroupsForReviewPath } from "../review-areas/areas";
import { NormalizedTestCase, TestResults } from "../tests-evidence/junit";
import { countRequirementStatuses, formatRequirementStatusSummary } from "./status";

const ACID_PATTERN = /[a-z0-9_-]+\.[A-Z0-9_]+\.[0-9]+(?:-[0-9]+)?/g;

export type RequirementStatus = "satisfied" | "partial" | "missing" | "unknown" | "overreach" | "invalid_evidence";

// review-surfaces.EVAL: structured sub-reason for a partial status. The
// evaluator already distinguishes these cases in prose; this lifts that
// distinction into a small, deterministic enum so downstream surfaces can group
// and prioritize partials without parsing summary strings. Only set when
// status === "partial".
export type PartialReason =
  | "impl_no_test"
  | "test_no_impl"
  | "impl_broad_no_exact_test"
  | "exact_impl_broad_test"
  | "broad_area_only"
  | "other";

export interface RequirementResult {
  requirement_id: string;
  acai_id?: string;
  status: RequirementStatus;
  summary: string;
  partial_reason?: PartialReason;
  evidence: EvidenceRef[];
  missing_evidence: EvidenceRef[];
  review_focus: string;
  confidence: "high" | "medium" | "low" | "unknown";
}

export interface EvaluationModel {
  summary: string;
  results: RequirementResult[];
  overreach: RequirementResult[];
  acai_coverage: Record<string, string>;
}

interface EvidenceIndex {
  byAcid: Map<string, EvidenceRef[]>;
  implementationByAcid: Map<string, EvidenceRef[]>;
  testsByAcid: Map<string, EvidenceRef[]>;
  changedByGroup: Map<string, EvidenceRef[]>;
  testsByGroup: Map<string, EvidenceRef[]>;
  allChangedFiles: string[];
  allFiles: Set<string>;
  areas: ReviewArea[];
  areasMode: ReviewAreasMode;
  repoIndex?: RepoIndex;
  classificationByPath: Map<string, FileClassification>;
}

export interface EvaluateOptions {
  areas?: ReviewArea[];
}

export async function evaluateIntent(
  cwd: string,
  collection: CollectionResult,
  intent: IntentModel,
  options: EvaluateOptions = {}
): Promise<EvaluationModel> {
  const resolved = options.areas ?? buildReviewAreas({ repoIndex: collection.repoIndex }).areas;
  const areasMode: ReviewAreasMode = options.areas ? "config" : "fallback";
  const index = await buildEvidenceIndex(cwd, collection, resolved, areasMode, intent.requirements);
  const knownAcids = new Set(intent.requirements.map((requirement) => requirement.acai_id).filter(Boolean) as string[]);
  const knownPaths = new Set([...index.allFiles, ...index.allChangedFiles]);
  const evidenceContext = { cwd, knownAcids, knownPaths };
  const results = intent.requirements
    .map((requirement) => evaluateRequirement(requirement, index))
    .map((result) => validateRequirementResultEvidence(result, evidenceContext));
  const overreach = detectOverreach(index, intent.requirements).map((result) =>
    validateRequirementResultEvidence(result, evidenceContext)
  );
  const acai_coverage = Object.fromEntries(
    results.filter((result) => result.acai_id).map((result) => [result.acai_id as string, result.status])
  );

  const statusCounts = countRequirementStatuses(results);

  return {
    summary: `${formatRequirementStatusSummary(statusCounts, overreach.length)}. Statuses are conservative and evidence-backed.`,
    results,
    overreach,
    acai_coverage
  };
}

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
  // Invariant #1: no test results => complete no-op. Baseline unchanged.
  const testResults = collection.testResults;
  if (!testResults || testResults.cases.length === 0) {
    return evaluation;
  }

  const passingCases = testResults.cases.filter((testCase) => testCase.status === "passed");
  if (passingCases.length === 0) {
    return evaluation;
  }

  const areas = options.areas ?? buildReviewAreas({ repoIndex: collection.repoIndex }).areas;
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
  const mappedCases = passingCases.map((testCase) => ({
    testCase,
    acids: passingCaseAcids(testCase, knownAcids),
    groups: passingCaseGroups(testCase, knownGroups, knownAcids, areas, collectedTestPaths)
  }));

  let mutated = false;
  for (const result of evaluation.results) {
    if (result.status !== "partial") {
      continue; // VERIFICATION LOOP only promotes partial -> satisfied.
    }
    // Idempotent: never re-process a result that already carries verified proof
    // (either a satisfied promotion or a previously-attached verified-broad ref).
    if (result.evidence.some((ref) => ref.verified === true)) {
      continue;
    }
    const requirement = requirementById.get(result.requirement_id);
    const group = groupFromAcid(result.acai_id);

    const match = findVerifyingCase(result, group, mappedCases, areas);
    if (match) {
      // Invariant #3: implementation evidence is required unless test-only.
      const testOnly = requirement ? isTestOnlyRequirement(requirement, group) : false;
      if (!testOnly && !resultHasImplementationEvidence(result)) {
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
    const broadCase = findGroupOnlyVerifyingCase(group, mappedCases);
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

type VerifyBasis = "exact_acid" | "llm_pinpointed";

interface VerifyingMatch {
  testCase: NormalizedTestCase;
  basis: VerifyBasis;
}

// Find a passing test case that proves THIS SPECIFIC requirement, preferring the
// stronger EXACT-ACID mapping over the LLM-pinpointed-and-corroborated one. A
// passing test that maps ONLY to the requirement's broad group is deliberately
// NOT a verifying case here (see findGroupOnlyVerifyingCase): it is too coarse to
// promote a specific requirement.
function findVerifyingCase(
  result: RequirementResult,
  group: string | undefined,
  mappedCases: MappedPassingCase[],
  areas: ReviewArea[]
): VerifyingMatch | undefined {
  // (a) EXACT-ACID: the passing test's name/classname/suite references THIS
  // requirement's exact ACID. Group membership alone (a different ACID in the
  // same group, or a classname that merely names the group token) is NOT enough
  // and is handled separately as verified-but-broad evidence.
  if (result.acai_id) {
    for (const mapped of mappedCases) {
      if (mapped.acids.includes(result.acai_id)) {
        return { testCase: mapped.testCase, basis: "exact_acid" };
      }
    }
  }

  // (b) LLM-PINPOINTED-AND-CORROBORATED: the reasoning stage proposed a specific
  // test (an llm_proposed test ref carrying a test_name + the cited test FILE
  // path) for this requirement, that exact passing test is present in the parsed
  // results, AND the MATCHED passing case's OWN provenance (its classname/suite/
  // ACID, via the same strict case->group mapping used deterministically) maps to
  // the requirement group. We corroborate on the parsed case the LLM named, NOT
  // on the LLM's word about which file the test lives in. This rejects two unsound
  // paths: (1) a pure cross-area LLM claim with no group corroboration, and (2) a
  // name-collision where the LLM cites a same-group file but the ONLY passing case
  // with that name actually belongs to a different area.
  if (!group) {
    return undefined;
  }
  const pinpoints = llmPinpointedTests(result);
  if (pinpoints.length === 0) {
    return undefined;
  }
  // Group every passing case by name so a name collision across suites is visible:
  // if ANY case with the pinpointed name has its OWN provenance contradicting the
  // requirement group, we must not silently pick a different one as "verified".
  const mappedByName = new Map<string, MappedPassingCase[]>();
  for (const mapped of mappedCases) {
    const bucket = mappedByName.get(mapped.testCase.name) ?? [];
    bucket.push(mapped);
    mappedByName.set(mapped.testCase.name, bucket);
  }
  for (const pinpoint of pinpoints) {
    // Corroboration #1: the LLM-cited test FILE must map to the requirement group
    // under the STRICT mapping (no substring/`medieval`-style false positives).
    if (typeof pinpoint.path !== "string" || !strictGroupsForReviewPath(pinpoint.path, areas).includes(group)) {
      continue;
    }
    const candidates = mappedByName.get(pinpoint.testName);
    if (!candidates || candidates.length === 0) {
      continue; // the pinpointed test is not a real PASSING parsed case
    }
    // Corroboration #2: the MATCHED case's OWN provenance must not point at a
    // DIFFERENT area. Prefer a case whose own classname/suite/ACID maps to the
    // requirement group; otherwise accept a group-NEUTRAL case (one that maps to
    // no group at all) corroborated by the cited path. A case whose own
    // provenance maps to OTHER groups but not this one is rejected: it belongs to
    // a different area, so a name-only collision must never promote on it.
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

// A passing test that maps to the requirement's broad GROUP but NOT to its exact
// ACID. This is the case that USED to promote the whole group; it now only
// produces verified-but-broad test evidence (the requirement stays partial). We
// require true group provenance (an ACID in the group, a group token in the
// classname/suite, or a collected test path mapping to the group) -- the same
// passingCaseGroups provenance used everywhere else -- so a merely
// similarly-named test does not attach. The requirement must NOT already have an
// exact-ACID match (that path promotes instead) and the group must be known.
function findGroupOnlyVerifyingCase(
  group: string | undefined,
  mappedCases: MappedPassingCase[]
): NormalizedTestCase | undefined {
  if (!group) {
    return undefined;
  }
  for (const mapped of mappedCases) {
    if (mapped.groups.has(group)) {
      return mapped.testCase;
    }
  }
  return undefined;
}

interface LlmPinpoint {
  testName: string;
  path?: string;
}

// The tests the reasoning stage pinpointed for this requirement: llm_proposed
// test evidence refs carrying a real test_name (and the cited test file path used
// for group corroboration). The caller intersects testName with the parsed
// PASSING cases and requires group corroboration before any of this counts.
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
  knownAcids: Set<string>,
  areas: ReviewArea[],
  collectedTestPaths: Set<string>
): Set<string> {
  const groups = new Set<string>();
  // The group-token haystack is the case's CLASSNAME and SUITE only. The
  // human-readable test NAME is deliberately excluded: a free-text name that
  // merely contains a group token as a word (e.g. "EVAL of latency budget") is
  // not provenance and must not be a basis for a SATISFIED promotion (it was only
  // ever meant to nudge a PARTIAL). ACID references in the name still count below.
  const tokenHaystack = [testCase.classname, testCase.suite].filter(Boolean).join(" ");

  // Any ACID the case references (anywhere, incl. the name) puts it in that
  // ACID's group: an exact ACID reference IS sound provenance.
  for (const acid of passingCaseAcids(testCase, knownAcids)) {
    const group = groupFromAcid(acid);
    if (group) {
      groups.add(group);
    }
  }
  // A group token named directly in the case's classname/suite (mirrors the
  // conservative attachParsedTestEvidence group fallback, minus the name).
  for (const group of knownGroups) {
    if (mentionsGroupToken(tokenHaystack, group)) {
      groups.add(group);
    }
  }
  // A classname that is an ACTUAL COLLECTED test path maps through the STRICT
  // review-area path mapping (true directory prefixes + whole-token keywords).
  // A free-text classname that is not a real test path contributes nothing here,
  // so a path-like-but-unrelated classname (e.g. tests/medieval_history.test.ts
  // not in the test set) can no longer corroborate a promotion via substrings.
  if (typeof testCase.classname === "string" && collectedTestPaths.has(testCase.classname)) {
    for (const group of strictGroupsForReviewPath(testCase.classname, areas)) {
      groups.add(group);
    }
  }
  return groups;
}

function resultHasImplementationEvidence(result: RequirementResult): boolean {
  // Implementation evidence is a deterministically-discovered (not LLM-proposed)
  // file/diff ref whose PATH is a real implementation path. This reuses the
  // evaluator's own notion of implementation (isImplementationEvidencePath), which
  // EXCLUDES docs/, features/, .agents/, AGENTS.md, CLAUDE.md, README*, etc. A
  // spec-referenced doc attached as a file ref (directFileEvidence) must therefore
  // NOT satisfy Invariant #3: a verified test may never satisfy a requirement the
  // evaluator itself determined has no implementation. A ref without a path is
  // conservatively NOT counted as implementation.
  return result.evidence.some(
    (ref) =>
      (ref.kind === "file" || ref.kind === "diff") &&
      !isLlmProposed(ref) &&
      typeof ref.path === "string" &&
      isImplementationEvidencePath(ref.path, EMPTY_PATH_SET)
  );
}

// isImplementationEvidencePath also rejects collected test paths; in the
// verification loop a test path would arrive as kind "test", not "file"/"diff",
// so a shared empty set is sufficient and keeps the path-class check.
const EMPTY_PATH_SET = new Set<string>();

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
  // De-duplicate against any existing identical verified ref (idempotency guard).
  const exists = result.evidence.some(
    (ref) => ref.verified === true && ref.test_name === verifiedEvidence.test_name
  );
  if (!exists) {
    // The verified ref makes the promotion auditable, so it MUST survive the
    // evidence cap. uniqueEvidence keeps the first N refs; prepending the verified
    // ref guarantees the cap drops a lower-value pre-existing ref instead of the
    // proof of the promotion (a requirement can already carry 8 deterministic/LLM
    // refs before verification, e.g. directFileEvidence + candidate-evidence).
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
  // The promotion satisfied the requirement, so its prior partial gap note no
  // longer applies; drop missing-evidence entries that merely recorded the gap.
  result.missing_evidence = result.missing_evidence.filter((ref) => ref.validation_status === "invalid");
}

// Attach a passing area test that maps only to the requirement's broad GROUP as
// VERIFIED-but-BROAD test evidence. This does NOT promote: a passing "render"
// area test does not prove a specific RENDER.N requirement. The verified marker
// records that a real passing test for the area exists (auditable, valid), while
// the requirement STAYS partial with partial_reason "broad_area_only" so per-
// requirement coverage is not overstated.
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
    // Prepend so the verified-broad ref survives the 8-ref evidence cap, mirroring
    // promoteToVerified: the marker must remain auditable even on a capped result.
    result.evidence = uniqueEvidence([verifiedEvidence, ...result.evidence]);
  }
  // Status stays partial. Reflect that a broad verified test now exists; the
  // requirement still lacks requirement-specific proof.
  result.status = "partial";
  result.partial_reason = "broad_area_only";
}

function evaluateRequirement(requirement: IntentRequirement, index: EvidenceIndex): RequirementResult {
  const group = groupFromAcid(requirement.acai_id);
  const exactEvidence = requirement.acai_id ? index.byAcid.get(requirement.acai_id) ?? [] : [];
  const exactImplementationEvidence = requirement.acai_id ? index.implementationByAcid.get(requirement.acai_id) ?? [] : [];
  const exactTestEvidence = requirement.acai_id ? index.testsByAcid.get(requirement.acai_id) ?? [] : [];
  const directEvidence = directFileEvidence(requirement, index);
  const implementationEvidence = group ? index.changedByGroup.get(group) ?? [] : [];
  const tests = group ? index.testsByGroup.get(group) ?? [] : [];
  const evidence = uniqueEvidence([
    ...(requirement.acai_id ? [specEvidence(sourcePath(requirement), requirement.acai_id)] : []),
    ...directEvidence,
    ...exactEvidence,
    ...exactImplementationEvidence,
    ...exactTestEvidence,
    ...implementationEvidence,
    ...tests
  ]);

  let status: RequirementStatus;
  let summary: string;
  let confidence: "high" | "medium" | "low" | "unknown";
  let partialReason: PartialReason | undefined;
  const missing: EvidenceRef[] = [];
  const hasExactImplementation = exactImplementationEvidence.length > 0;
  const hasImplementation = hasExactImplementation || implementationEvidence.length > 0;
  const hasExactTest = exactTestEvidence.length > 0;
  const hasBroadTest = tests.length > 0;
  const testOnlyRequirement = isTestOnlyRequirement(requirement, group);

  if (hasInvalidSpecRef(requirement)) {
    status = "invalid_evidence";
    summary = "Requirement source reference is invalid.";
    confidence = "high";
  } else if (directEvidence.length > 0 && isRepositoryPresenceRequirement(requirement)) {
    status = "satisfied";
    summary = "Referenced repository file evidence exists for this requirement.";
    confidence = "high";
  } else if (group && isLaterProviderGroup(group)) {
    status = "unknown";
    summary = "This requirement targets a later provider surface and is not implemented in the local MVP.";
    confidence = "unknown";
    missing.push(missingEvidence("Provider integrations are explicitly deferred until after local artifacts are useful."));
  } else if (testOnlyRequirement && hasExactTest) {
    status = "satisfied";
    summary = "Exact test ACID evidence exists for this test-focused requirement.";
    confidence = "high";
  } else if (hasExactImplementation && hasExactTest) {
    status = "satisfied";
    summary = "Exact implementation ACID evidence and exact test ACID evidence exist.";
    confidence = "high";
  } else if (hasImplementation && hasExactTest) {
    status = "partial";
    summary = "Requirement-specific test evidence exists, but implementation evidence is broad rather than exact.";
    confidence = "medium";
    partialReason = "impl_broad_no_exact_test";
    missing.push(missingEvidence("No exact implementation ACID evidence was found for this requirement."));
  } else if (hasExactImplementation && hasBroadTest) {
    status = "partial";
    summary = "Exact implementation ACID evidence and broad test-path evidence exist, but no exact test ACID evidence was found.";
    confidence = "medium";
    partialReason = "exact_impl_broad_test";
    missing.push(missingEvidence("No exact test ACID evidence was found for this requirement."));
  } else if (implementationEvidence.length > 0 && tests.length > 0) {
    status = "partial";
    summary = "Implementation and test-path evidence exist for this broad area, but no requirement-specific proof was found.";
    confidence = "medium";
    partialReason = "broad_area_only";
    missing.push(missingEvidence("No exact implementation or test ACID evidence was found for this requirement."));
  } else if (hasImplementation) {
    status = "partial";
    summary = "Implementation evidence exists, but direct test evidence is missing or weak.";
    confidence = "medium";
    partialReason = "impl_no_test";
    missing.push(missingEvidence("No direct test evidence was found for this requirement area."));
  } else if (hasExactTest || hasBroadTest) {
    status = "partial";
    summary = "Test evidence exists, but implementation evidence is missing or weak.";
    confidence = "medium";
    partialReason = "test_no_impl";
    missing.push(missingEvidence("No implementation evidence was found for this requirement area."));
  } else {
    status = "missing";
    summary = "No implementation or test evidence was found for this requirement.";
    confidence = "medium";
    missing.push(missingEvidence("No changed file, ACID mention, or test path mapped to this requirement."));
  }

  return {
    requirement_id: requirement.id,
    acai_id: requirement.acai_id,
    status,
    summary,
    // Only surface a structured sub-reason for partial results; every partial
    // branch above sets it, so the "other" fallback only guards future drift.
    ...(status === "partial" ? { partial_reason: partialReason ?? "other" } : {}),
    evidence,
    missing_evidence: missing,
    review_focus:
      status === "satisfied"
        ? "Spot-check evidence quality and ensure tests cover behavior, not just file presence."
        : "Review whether this requirement needs implementation, tests, or an explicit deferral.",
    confidence
  };
}

async function buildEvidenceIndex(
  cwd: string,
  collection: CollectionResult,
  areas: ReviewArea[],
  areasMode: ReviewAreasMode,
  requirements: IntentRequirement[]
): Promise<EvidenceIndex> {
  const byAcid = new Map<string, EvidenceRef[]>();
  const implementationByAcid = new Map<string, EvidenceRef[]>();
  const testsByAcid = new Map<string, EvidenceRef[]>();
  const changedByGroup = new Map<string, EvidenceRef[]>();
  const testsByGroup = new Map<string, EvidenceRef[]>();
  const testPaths = new Set(collection.tests.map((test) => test.path));
  const changedImplementationPaths = new Set(
    collection.changedFiles.filter((changedFile) => isImplementationEvidencePath(changedFile.path, testPaths)).map((changedFile) => changedFile.path)
  );
  const allFiles = (collection.repositoryFiles.length ? collection.repositoryFiles : await walkFiles(cwd)).filter(
    (filePath) => !filePath.startsWith(".review-surfaces/")
  );
  const candidateFiles = [
    ...collection.changedFiles.map((file) => file.path),
    ...collection.tests.map((test) => test.path),
    ...collection.docs.map((doc) => doc.path),
    ...allFiles.filter((file) => file.startsWith(".review-surfaces/agent_handoff.md"))
  ];

  for (const filePath of unique(candidateFiles)) {
    if (filePath.startsWith(".review-surfaces/")) {
      continue;
    }
    const absolutePath = path.resolve(cwd, filePath);
    if (!isRegularFile(absolutePath)) {
      continue;
    }
    const text = await readText(absolutePath);
    const acidMatches = text.match(/[a-z0-9_-]+\.[A-Z0-9_]+\.[0-9]+(?:-[0-9]+)?/g) ?? [];
    for (const acid of acidMatches) {
      const evidenceRef = evidenceForPath(filePath, `Mentions ${acid}.`, testPaths);
      pushMap(byAcid, acid, evidenceRef);
      if (evidenceRef.kind === "test") {
        pushMap(testsByAcid, acid, evidenceRef);
      } else if (changedImplementationPaths.has(filePath)) {
        pushMap(implementationByAcid, acid, evidenceRef);
      }
    }
  }

  for (const changedFile of collection.changedFiles) {
    if (testPaths.has(changedFile.path)) {
      continue;
    }
    for (const group of groupsForReviewPath(changedFile.path, areas)) {
      pushMap(changedByGroup, group, fileEvidence(changedFile.path, `Changed file mapped to ${group}.`));
    }
  }

  for (const test of collection.tests) {
    for (const group of groupsForReviewPath(test.path, areas)) {
      pushMap(testsByGroup, group, testEvidence(test.path, `Test path mapped to ${group}.`));
    }
  }

  // Phase 5a: attach parsed JUnit cases as REAL test evidence. A passing case
  // whose name/classname clearly references an ACID becomes EXACT test ACID
  // evidence (with the real test_name); a passing case whose name/classname
  // names a known requirement group strengthens that group. Conservative: only
  // PASSING cases that clearly map are attached as proof.
  attachParsedTestEvidence(collection.testResults, requirements, { testsByAcid, testsByGroup });

  const classificationByPath = new Map<string, FileClassification>(
    (collection.repoIndex?.files ?? []).map((file) => [file.path, file.classification])
  );

  return {
    byAcid,
    implementationByAcid,
    testsByAcid,
    changedByGroup,
    testsByGroup,
    allChangedFiles: collection.changedFiles.map((file) => file.path),
    allFiles: new Set(allFiles),
    areas,
    areasMode,
    repoIndex: collection.repoIndex,
    classificationByPath
  };
}

// Classifications that are never review surfaces in their own right; suppress
// them from overreach so noise files do not get flagged one-by-one.
const NON_REVIEW_CLASSIFICATIONS = new Set<FileClassification>(["lockfile", "generated"]);

function detectOverreach(index: EvidenceIndex, requirements: IntentRequirement[]): RequirementResult[] {
  const knownGroups = new Set(requirements.map((requirement) => groupFromAcid(requirement.acai_id)).filter(Boolean) as string[]);
  const unmapped = index.allChangedFiles.filter(
    (filePath) =>
      !NON_REVIEW_CLASSIFICATIONS.has(index.classificationByPath.get(filePath) ?? "unknown") &&
      groupsForReviewPath(filePath, index.areas).every((group) => !knownGroups.has(group))
  );

  // Fallback (no configured areas): report overreach as review-sized UNMAPPED
  // CLUSTERS, never one finding per file. Files that fall outside every cluster
  // (docs/config that the index did not cluster) collapse into a single bucket.
  if (index.areasMode === "fallback") {
    return overreachClusters(index, unmapped);
  }

  return unmapped.map((filePath, index) => ({
    requirement_id: `OVERREACH-${String(index + 1).padStart(3, "0")}`,
    status: "overreach" as const,
    summary: `Changed file does not map to an Acai requirement group: ${filePath}`,
    evidence: [fileEvidence(filePath, "Changed file did not map to a known requirement group.", "medium")],
    missing_evidence: [],
    review_focus: "Confirm whether this file is in scope or the spec needs an explicit requirement.",
    confidence: "medium" as const
  }));
}

function overreachClusters(index: EvidenceIndex, unmapped: string[]): RequirementResult[] {
  if (unmapped.length === 0) {
    return [];
  }
  const unmappedSet = new Set(unmapped);
  const clusters = index.repoIndex?.clusters ?? [];
  const buckets: Array<{ label: string; files: string[] }> = [];
  const accountedFor = new Set<string>();

  for (const cluster of clusters) {
    const files = cluster.files.filter((filePath) => unmappedSet.has(filePath));
    if (files.length === 0) {
      continue;
    }
    for (const filePath of files) {
      accountedFor.add(filePath);
    }
    buckets.push({ label: cluster.label, files: files.sort((left, right) => left.localeCompare(right)) });
  }

  const leftover = unmapped.filter((filePath) => !accountedFor.has(filePath)).sort((left, right) => left.localeCompare(right));
  if (leftover.length > 0) {
    buckets.push({ label: "unclustered changes", files: leftover });
  }

  return buckets.map((bucket, position) => ({
    requirement_id: `OVERREACH-${String(position + 1).padStart(3, "0")}`,
    status: "overreach" as const,
    summary: `Unmapped cluster (${bucket.files.length} file(s)) does not map to any requirement: ${bucket.label}`,
    evidence: bucket.files
      .slice(0, 8)
      .map((filePath) => fileEvidence(filePath, "Changed file is in a cluster with no requirement coverage.", "medium")),
    missing_evidence: [],
    review_focus: "Confirm whether this cluster is in scope or the spec needs requirements for it.",
    confidence: "medium" as const
  }));
}

function groupFromAcid(acaiId: string | undefined): string | undefined {
  return acaiId?.split(".")[1];
}

function directFileEvidence(requirement: IntentRequirement, index: EvidenceIndex): EvidenceRef[] {
  return pathLikeTokens(requirement.requirement)
    .filter((filePath) => index.allFiles.has(filePath))
    .slice(0, 5)
    .map((filePath) => fileEvidence(filePath, `Repository file referenced by ${requirement.acai_id ?? requirement.id} exists.`, "high"));
}

function pathLikeTokens(text: string): string[] {
  return [...new Set(text.replace(/`/g, "").match(/(?:[\w.-]+\/)+[\w.-]+|AGENTS\.md|README(?:\.[\w.-]+)?|package\.json|review-surfaces\.config\.yaml/g) ?? [])];
}

function isRepositoryPresenceRequirement(requirement: IntentRequirement): boolean {
  const lower = requirement.requirement.toLowerCase();
  return lower.includes("repository must contain") || lower.includes("repo must contain");
}

function isTestOnlyRequirement(requirement: IntentRequirement, group: string | undefined): boolean {
  return group === "QUALITY" && /\btests?\b/i.test(requirement.requirement);
}

function sourcePath(requirement: IntentRequirement): string {
  return requirement.source_refs[0]?.ref ?? "unknown";
}

function hasInvalidSpecRef(requirement: IntentRequirement): boolean {
  return requirement.source_refs.some((ref) => ref.kind === "unknown");
}

function evidenceForPath(filePath: string, note: string, testPaths: Set<string>): EvidenceRef {
  return testPaths.has(filePath) ? testEvidence(filePath, note, "high") : fileEvidence(filePath, note, "high");
}

// Phase 5a: attach PASSING parsed JUnit cases as real test evidence, carrying
// the actual test_name. We only attach a case when it CLEARLY maps:
//   - any ACID it references (in name or classname) -> exact test ACID evidence
//   - else a known requirement group token in its classname/name -> group test
// Failing/skipped cases are intentionally NOT treated as proof here (the risks
// surface reports them); the evaluator stays conservative.
function attachParsedTestEvidence(
  testResults: TestResults | undefined,
  requirements: IntentRequirement[],
  maps: { testsByAcid: Map<string, EvidenceRef[]>; testsByGroup: Map<string, EvidenceRef[]> }
): void {
  if (!testResults || testResults.cases.length === 0) {
    return;
  }
  const knownAcids = new Set(requirements.map((requirement) => requirement.acai_id).filter(Boolean) as string[]);
  const knownGroups = new Set(requirements.map((requirement) => groupFromAcid(requirement.acai_id)).filter(Boolean) as string[]);

  for (const testCase of testResults.cases) {
    if (testCase.status !== "passed") {
      continue;
    }
    const haystack = [testCase.name, testCase.classname, testCase.suite].filter(Boolean).join(" ");
    const acids = unique(haystack.match(ACID_PATTERN) ?? []).filter((acid) => knownAcids.has(acid));
    if (acids.length > 0) {
      for (const acid of acids) {
        pushMap(maps.testsByAcid, acid, parsedTestEvidenceRef(testCase, `Parsed JUnit case mentions ${acid}.`));
      }
      continue;
    }
    // No ACID match: fall back to a conservative group-token match so a case
    // whose classname/name clearly names a requirement group still strengthens
    // that group. Token boundaries avoid accidental substring matches.
    for (const group of knownGroups) {
      if (mentionsGroupToken(haystack, group)) {
        pushMap(maps.testsByGroup, group, parsedTestEvidenceRef(testCase, `Parsed JUnit case maps to ${group}.`));
      }
    }
  }
}

function parsedTestEvidenceRef(testCase: NormalizedTestCase, note: string): EvidenceRef {
  return {
    kind: "test",
    test_name: testCase.name,
    note,
    confidence: "high",
    validation_status: "valid"
  };
}

function mentionsGroupToken(haystack: string, group: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(group)}([^A-Za-z0-9_]|$)`).test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isImplementationEvidencePath(filePath: string, testPaths: Set<string>): boolean {
  if (testPaths.has(filePath)) {
    return false;
  }
  if (
    filePath.startsWith("docs/") ||
    filePath.startsWith("features/") ||
    filePath.startsWith(".agents/") ||
    filePath.startsWith(".review-surfaces/") ||
    filePath === "AGENTS.md" ||
    filePath === "CLAUDE.md" ||
    filePath.startsWith("README")
  ) {
    return false;
  }
  return true;
}

function pushMap(map: Map<string, EvidenceRef[]>, key: string, value: EvidenceRef): void {
  const existing = map.get(key) ?? [];
  existing.push(value);
  map.set(key, existing);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueEvidence(values: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const result: EvidenceRef[] = [];
  for (const value of values) {
    const key = `${value.kind}:${value.path ?? ""}:${value.acai_id ?? ""}:${value.note ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result.slice(0, 8);
}
