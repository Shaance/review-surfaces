import path from "node:path";
import { CollectionResult } from "../collector/collect";
import { isRegularFile, readText } from "../core/files";
import { walkFiles } from "../core/glob";
import { EvidenceRef, fileEvidence, missingEvidence, specEvidence, testEvidence } from "../evidence/evidence";
import { validateRequirementResultEvidence } from "../evidence/validate";
import { FileClassification, RepoIndex } from "../indexer/indexer";
import { IntentModel, IntentRequirement } from "../intent/intent";
import { buildReviewAreas, groupsForReviewPath, isLaterProviderGroup, ReviewArea, ReviewAreasMode } from "../review-areas/areas";
import { NormalizedTestCase, TestResults } from "../tests-evidence/junit";
import { countRequirementStatuses, formatRequirementStatusSummary } from "./status";

const ACID_PATTERN = /[a-z0-9_-]+\.[A-Z0-9_]+\.[0-9]+(?:-[0-9]+)?/g;

export type RequirementStatus = "satisfied" | "partial" | "missing" | "unknown" | "overreach" | "invalid_evidence";

export interface RequirementResult {
  requirement_id: string;
  acai_id?: string;
  status: RequirementStatus;
  summary: string;
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
    missing.push(missingEvidence("No exact implementation ACID evidence was found for this requirement."));
  } else if (hasExactImplementation && hasBroadTest) {
    status = "partial";
    summary = "Exact implementation ACID evidence and broad test-path evidence exist, but no exact test ACID evidence was found.";
    confidence = "medium";
    missing.push(missingEvidence("No exact test ACID evidence was found for this requirement."));
  } else if (implementationEvidence.length > 0 && tests.length > 0) {
    status = "partial";
    summary = "Implementation and test-path evidence exist for this broad area, but no requirement-specific proof was found.";
    confidence = "medium";
    missing.push(missingEvidence("No exact implementation or test ACID evidence was found for this requirement."));
  } else if (hasImplementation) {
    status = "partial";
    summary = "Implementation evidence exists, but direct test evidence is missing or weak.";
    confidence = "medium";
    missing.push(missingEvidence("No direct test evidence was found for this requirement area."));
  } else if (hasExactTest || hasBroadTest) {
    status = "partial";
    summary = "Test evidence exists, but implementation evidence is missing or weak.";
    confidence = "medium";
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
