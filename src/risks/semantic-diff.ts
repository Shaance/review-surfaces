// review-surfaces.SEMANTIC_DIFF.1-4: deterministic facts computed from the
// MEANING of the diff rather than from path/filename matching.
//
//   .1 semantic JSON-schema diff (properties/required/type/enum changes)
//   .2 exported TypeScript API-surface diff (symbols added/removed/changed)
//   .3 test-weakening signals (deleted test files, newly skipped tests, removed
//      assertions, regenerated snapshots)
//   .4 the facts carry concrete language for the queue / lenses / comments.
//
// The base/head file readers are injected so the analysis is a pure function of
// (diff, file contents) — the CLI provides git-backed (base) and working-tree
// (head) readers; tests provide fakes. Schema/API diffs need both file versions;
// test-weakening is computed from the diff hunks alone.

import * as ts from "typescript";
import { StructuredDiff, StructuredDiffFile } from "../pr/contract";
import { isTestPath } from "../scope/pr-scope";
import { createApiContractSurfaceClassifier, isExplicitContractSurfacePath, listPackageConditionalContractExclusions, listPackageContractEntries, listPackageContractExclusions, listUniversalPackageExportConditionParents, packageExclusionRemovesContract, selectEffectivePackageContractEntries, type ApiContractSurface, type PackageContractEntry } from "./contract-surface";

export interface SchemaContractChange {
  path: string;
  properties_added: string[];
  properties_removed: string[];
  /** Fields that BECAME required — the common backward-incompatible change. */
  required_added: string[];
  required_removed: string[];
  type_changes: Array<{ field: string; from: string; to: string }>;
  enum_changes: Array<{ field: string; added: string[]; removed: string[] }>;
}

export interface ApiSurfaceChange {
  path: string;
  exports_added: string[];
  exports_removed: string[];
  signatures_changed: Array<{ name: string; from: string; to: string }>;
  // review-surfaces.BLAST_RADIUS.2: in-repo reference resolution for the changed
  // or removed exports — how many files import this module and reference the
  // symbols, with the top paths (alphabetical, bounded). Absent when the import
  // graph was not computed; truncated graphs carry the note instead of "0".
  used_by?: { count: number; top: string[]; truncated?: boolean };
  /** Deterministic evidence that this module is an externally supported contract. */
  contract_surface?: ApiContractSurface;
  /** Base-side supported contract moved away without a matching head-side contract. */
  contract_removed?: boolean;
  contract_target_changed?: boolean;
  contract_name?: string;
  renamed_from?: string;
}

export type TestWeakeningKind = "deleted_test_file" | "skipped_test" | "removed_assertion" | "regenerated_snapshot";

export interface TestWeakeningSignal {
  kind: TestWeakeningKind;
  path: string;
  detail: string;
}

export interface SemanticChangeFacts {
  schema_changes: SchemaContractChange[];
  api_changes: ApiSurfaceChange[];
  test_weakening: TestWeakeningSignal[];
}

export interface SemanticDiffSources {
  diff: StructuredDiff;
  /** Read the OLD (base) content of a path, or undefined when it did not exist. */
  readBase: (path: string) => string | undefined;
  /** Read the NEW (head) content of a path, or undefined when deleted. */
  readHead: (path: string) => string | undefined;
  /** Optional explicit contract globs from review-surfaces config. */
  contractPaths?: readonly string[];
  /** Target-repository implementation roots used to map compiled package entries to source. */
  sourceRoots?: readonly string[];
  baseSourceRoots?: readonly string[];
  headSourceRoots?: readonly string[];
  basePackageSourcePatterns?: ReadonlyMap<string, readonly string[]>;
  headPackageSourcePatterns?: ReadonlyMap<string, readonly string[]>;
}

export function emptySemanticChangeFacts(): SemanticChangeFacts {
  return { schema_changes: [], api_changes: [], test_weakening: [] };
}

export function isBreakingSchemaChange(change: SchemaContractChange): boolean {
  return change.properties_removed.length > 0 ||
    change.required_added.length > 0 ||
    change.type_changes.length > 0 ||
    change.enum_changes.some((entry) => entry.removed.length > 0);
}

export function isBreakingApiChange(change: ApiSurfaceChange): boolean {
  return change.contract_removed === true || change.contract_target_changed === true || change.exports_removed.length > 0 || change.signatures_changed.some(signatureChangeIsBreaking);
}

export function isExplicitApiContractChange(change: ApiSurfaceChange): boolean {
  return change.contract_surface !== undefined;
}

export function isSupportedApiContractChange(change: ApiSurfaceChange): boolean {
  return isExplicitApiContractChange(change) || isExplicitContractSurfacePath(change.path);
}

function signatureChangeIsBreaking(change: ApiSurfaceChange["signatures_changed"][number]): boolean {
  const before = objectContractShape(change.from, change.name);
  const after = objectContractShape(change.to, change.name);
  if (!before || !after) {
    return true;
  }
  if (before.header !== after.header) return true;
  if (after.members.length < before.members.length) return true;
  if (before.members.some((member, index) => member.text !== after.members[index]?.text)) return true;
  return after.members.slice(before.members.length).some((member) => !member.optional);
}

// Object-contract signatures are emitted as valid TypeScript by the semantic
// extractor. Only appended optional members are treated as compatible: member
// order can affect overload resolution, so reordering or insertion stays
// conservative. Direct object type aliases follow the same compatibility rule.
function objectContractShape(signature: string, expectedName: string): {
  header: string;
  members: Array<{ text: string; optional: boolean }>;
} | undefined {
  const source = ts.createSourceFile("contract.ts", signature, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const localName = expectedName.split(".").at(-1) ?? expectedName;
  const declaration = source.statements.find((statement): statement is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
    (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === localName
  );
  if (!declaration) return undefined;
  const typeLiteral = ts.isTypeAliasDeclaration(declaration) && ts.isTypeLiteralNode(declaration.type)
    ? declaration.type
    : undefined;
  if (ts.isTypeAliasDeclaration(declaration) && !typeLiteral) return undefined;
  const header = [
    ts.isInterfaceDeclaration(declaration) ? "interface" : "type",
    declaration.typeParameters?.map((parameter) => parameter.getText(source).replace(/\s+/gu, " ").trim()).join(",") ?? "",
    ts.isInterfaceDeclaration(declaration)
      ? declaration.heritageClauses?.map((clause) => clause.getText(source).replace(/\s+/gu, " ").trim()).join(" ") ?? ""
      : ""
  ].join("|");
  const members: Array<{ text: string; optional: boolean }> = [];
  for (const member of ts.isInterfaceDeclaration(declaration) ? declaration.members : typeLiteral?.members ?? []) {
    const optional = Boolean(member.questionToken);
    const normalized = member.getText(source).replace(/\s+/gu, " ").trim().replace(/[;,]$/u, "");
    if (!normalized) return undefined;
    members.push({ text: normalized, optional });
  }
  return { header, members };
}

// Shared, surface-agnostic renderings of the two compound schema-change fields,
// so the queue/comment prose (human-review.ts) and the rendered facts section
// (render.ts) cannot drift on the same data shape.
export function formatTypeChanges(changes: SchemaContractChange["type_changes"]): string {
  return changes.map((t) => `${t.field} ${t.from}→${t.to}`).join(", ");
}

export function formatEnumChanges(changes: SchemaContractChange["enum_changes"]): string {
  return changes
    .map((e) => `${e.field}${e.added.length ? ` +[${e.added.join(", ")}]` : ""}${e.removed.length ? ` -[${e.removed.join(", ")}]` : ""}`)
    .join(", ");
}

export function computeSemanticChangeFacts(sources: SemanticDiffSources): SemanticChangeFacts {
  sources = {
    ...sources,
    readBase: memoizeFileReader(sources.readBase),
    readHead: memoizeFileReader(sources.readHead)
  };
  const schema_changes: SchemaContractChange[] = [];
  const api_changes: ApiSurfaceChange[] = [];
  const headPackageJson = sources.readHead("package.json");
  const basePackageJson = sources.readBase("package.json");
  const baseEntries = listPackageContractEntries(
    basePackageJson,
    sources.baseSourceRoots ?? sources.sourceRoots ?? [],
    sources.basePackageSourcePatterns
  );
  const headEntries = listPackageContractEntries(
    headPackageJson,
    sources.headSourceRoots ?? sources.sourceRoots ?? [],
    sources.headPackageSourcePatterns
  );
  const effectiveBaseEntries = selectEffectivePackageContractEntries(baseEntries);
  const effectiveHeadEntries = selectEffectivePackageContractEntries(headEntries);
  const baseEntriesByIdentity = groupPackageEntriesByIdentity(baseEntries);
  const headEntriesByIdentity = groupPackageEntriesByIdentity(headEntries);
  const headConditionIndex = indexPackageConditionDescendants(headEntriesByIdentity);
  const headUniversalConditionParents = new Set(listUniversalPackageExportConditionParents(headPackageJson));
  const basePackageExclusions = listPackageContractExclusions(basePackageJson);
  const baseExclusionPatterns = basePackageExclusions.map((exclusion) => exclusion.consumer_path);
  const baseExclusionIdentities = new Set(basePackageExclusions.map(({ surface }) => surface.identity));
  const addedPackageExclusions = listPackageContractExclusions(headPackageJson)
    .filter(({ surface }) => surface.identity !== undefined && !baseExclusionIdentities.has(surface.identity));
  const baseConditionalExclusionIdentities = new Set(
    listPackageConditionalContractExclusions(basePackageJson).map(({ surface }) => surface.identity)
  );
  const addedConditionalExclusions = listPackageConditionalContractExclusions(headPackageJson)
    .filter(({ surface }) => surface.identity !== undefined && !baseConditionalExclusionIdentities.has(surface.identity));
  const headPackageSurfaces = effectiveHeadEntries.map((entry) => entry.surface);
  const headPackageIdentities = new Set(headPackageSurfaces.map((surface) => surface.identity).filter((identity): identity is string => Boolean(identity)));
  const headPackageSourceKeys = new Set(headPackageSurfaces
    .filter((surface): surface is ApiContractSurface & { identity: string } => surface.identity !== undefined)
    .map((surface) => `${surface.identity}\0${surface.source}`));
  const basePackageSurfaces = [...new Map(
    effectiveBaseEntries.map(({ surface }) => [surface.identity ?? surface.source, surface])
  ).values()];
  const removedPackageSurfaces = basePackageSurfaces
    .filter((surface) => surface.identity !== undefined &&
      !headPackageIdentities.has(surface.identity) &&
      !headUniversalConditionParents.has(surface.identity));
  const removedPackageIdentities = new Set(removedPackageSurfaces.map((surface) => surface.identity as string));
  const representedRemovedIdentities = new Set<string>();
  const baseChangedPathByIdentity = new Map<string, string>();
  const headChangedPathByIdentity = new Map<string, string>();
  const baseChangedSurfaceByIdentity = new Map<string, ApiContractSurface>();
  const headChangedSurfaceByIdentity = new Map<string, ApiContractSurface>();
  const headContractSurface = createApiContractSurfaceClassifier({
    packageJson: headPackageJson,
    configuredPaths: sources.contractPaths,
    sourceRoots: sources.headSourceRoots ?? sources.sourceRoots,
    packageSourcePatterns: sources.headPackageSourcePatterns
  });
  const baseContractSurface = createApiContractSurfaceClassifier({
    packageJson: basePackageJson,
    configuredPaths: sources.contractPaths,
    sourceRoots: sources.baseSourceRoots ?? sources.sourceRoots,
    packageSourcePatterns: sources.basePackageSourcePatterns
  });
  for (const file of sources.diff.files) {
    if (isJsonSchemaPath(file.path)) {
      const change = diffSchemaFile(file, sources);
      if (change) {
        schema_changes.push(change);
      }
    } else if (isTypeScriptSourcePath(file.path)) {
      const headExists = sources.readHead(file.path) !== undefined;
      const headSurface = headExists ? headContractSurface(file.path) : undefined;
      const oldPath = baseReadPath(file);
      const baseSurface = baseContractSurface(oldPath);
      if (baseSurface?.identity) {
        const identity = baseSurface.binding ?? baseSurface.identity;
        baseChangedPathByIdentity.set(identity, oldPath);
        baseChangedSurfaceByIdentity.set(identity, baseSurface);
      }
      if (headSurface?.identity) {
        const identity = headSurface.binding ?? headSurface.identity;
        headChangedPathByIdentity.set(identity, file.path);
        headChangedSurfaceByIdentity.set(identity, headSurface);
      }
      const packageTargetUnchanged = baseSurface?.identity !== undefined &&
        headPackageSourceKeys.has(`${baseSurface.identity}\0${baseSurface.source}`);
      const baseConsumerIdentity = baseSurface?.binding ?? baseSurface?.identity;
      const headConsumerIdentity = headSurface?.binding ?? headSurface?.identity;
      const wildcardBindingRemoved = baseSurface?.binding !== undefined && oldPath !== file.path && baseConsumerIdentity !== headConsumerIdentity;
      const packageContractRemoved = baseSurface?.identity !== undefined && (
        removedPackageIdentities.has(baseSurface.identity) ||
        (packageTargetUnchanged && (wildcardBindingRemoved || (!headSurface && (!headExists || oldPath !== file.path))))
      );
      const pathContractRemoved = baseSurface?.identity === undefined && Boolean(baseSurface && (
        (oldPath !== file.path && file.old_path) ||
        (!headSurface && !headExists)
      ));
      const contractRemoved = packageContractRemoved || pathContractRemoved;
      const change = diffApiSurfaceFile(file, sources) ?? (
        contractRemoved
          ? {
              path: file.path,
              exports_added: [],
              exports_removed: [],
              signatures_changed: [],
              contract_removed: true,
              ...(oldPath !== file.path ? { renamed_from: oldPath } : {}),
              ...(baseConsumerIdentity ? { contract_name: baseConsumerIdentity } : {})
            }
          : undefined
      );
      if (change) {
        if (contractRemoved) {
          change.contract_removed = true;
          if (oldPath !== file.path) change.renamed_from = oldPath;
          if (baseConsumerIdentity) {
            change.contract_name = baseConsumerIdentity;
          }
          // A concrete wildcard binding represents only that binding; retain
          // the package-level wildcard removal as a separate contract fact.
          if (baseSurface?.identity && baseSurface.binding === undefined) {
            representedRemovedIdentities.add(baseSurface.identity);
          }
        }
        const baseSurfaceStillApplies = baseSurface?.identity === undefined ||
          removedPackageIdentities.has(baseSurface.identity) ||
          packageTargetUnchanged;
        const contractSurface = contractRemoved ? baseSurface : headSurface ?? (baseSurfaceStillApplies ? baseSurface : undefined);
        if (contractSurface) change.contract_surface = contractSurface;
        api_changes.push(change);
      }
    }
  }
  const reconciledPairs = new Set<string>();
  const packageChanged = sources.diff.files.some((file) => file.path === "package.json");
  const changedHeadPaths = new Set(sources.diff.files.map((file) => file.path));
  const comparePackageTargets = (
    identity: string,
    baseEntry: PackageContractEntry,
    headEntry: PackageContractEntry
  ): void => {
    const basePath = resolvePackageEntryPath(baseEntry, sources.readBase);
    const headPath = resolvePackageEntryPath(headEntry, sources.readHead);
    if (!basePath || !headPath) {
      if (packageChanged) api_changes.push(unresolvedPackageTargetChange(identity, headEntry.surface));
      return;
    }
    const pairKey = `${identity}\0${basePath}\0${headPath}`;
    if (reconciledPairs.has(pairKey)) return;
    reconciledPairs.add(pairKey);
    const crossTargetChange = diffApiSurfaceTexts(headPath, sources.readBase(basePath), sources.readHead(headPath), basePath);
    removeReconciledPathFacts(api_changes, identity, basePath, headPath, sources.readBase, sources.readHead);
    if (!crossTargetChange) return;
    // If only the manifest selected a different existing source, keep the
    // approval-changing fact inside the changed PR range.
    if (packageChanged && !changedHeadPaths.has(headPath)) crossTargetChange.path = "package.json";
    crossTargetChange.contract_surface = headEntry.surface;
    api_changes.push(crossTargetChange);
  };
  for (const [identity, basePath] of baseChangedPathByIdentity) {
    const headPath = headChangedPathByIdentity.get(identity);
    const baseSurface = baseChangedSurfaceByIdentity.get(identity);
    const headSurface = headChangedSurfaceByIdentity.get(identity);
    if (!headPath || !baseSurface || !headSurface || baseSurface.source === headSurface.source) continue;
    const pairKey = `${identity}\0${basePath}\0${headPath}`;
    if (reconciledPairs.has(pairKey)) continue;
    reconciledPairs.add(pairKey);
    const alreadyCorrelated = sources.diff.files.some((file) => file.path === headPath && baseReadPath(file) === basePath);
    if (alreadyCorrelated) continue;
    const crossTargetChange = diffApiSurfaceTexts(
      headPath,
      sources.readBase(basePath),
      sources.readHead(headPath),
      basePath
    );
    removeReconciledPathFacts(api_changes, identity, basePath, headPath, sources.readBase, sources.readHead);
    if (crossTargetChange) {
      crossTargetChange.contract_surface = headSurface;
      api_changes.push(crossTargetChange);
    }
  }
  for (const { group, surface } of changedPackagePriorityGroups(baseEntries, headEntries)) {
    if (packageChanged) api_changes.push(unresolvedPackageTargetChange(group, surface));
  }
  for (const [identity, baseGroup] of baseEntriesByIdentity) {
    const headGroup = headEntriesByIdentity.get(identity);
    if (!headGroup) {
      // A uniform reachable-default condition map is represented by its parent
      // identity. If a later revision makes one condition diverge, compare the
      // old uniform target against each authored condition instead of reporting
      // that the whole parent contract disappeared.
      if (headUniversalConditionParents.has(identity)) {
        for (const [headIdentity, conditionalHeadGroup] of headConditionIndex.byParent.get(identity) ?? []) {
          comparePackageTargets(headIdentity, baseGroup[0], conditionalHeadGroup[0]);
        }
      }
      continue;
    }
    const baseSources = baseGroup.map((entry) => entry.surface.source);
    const headSources = headGroup.map((entry) => entry.surface.source);
    // A stable first fallback remains the selected target. Later entries are
    // shadowed, so replacing or deleting them cannot change the public API.
    if (baseSources[0] === headSources[0]) continue;
    if (isOrderedSubsequence(headSources, baseSources)) {
      // Removing later fallbacks does not change the selected target. Removing
      // the first fallback does, so compare the old and newly selected APIs.
      comparePackageTargets(identity, baseGroup[0], headGroup[0]);
      continue;
    }
    const sharedPriorityChanged = sharedPackageEntryPriorityChanged(baseGroup, headGroup);
    if (sharedPriorityChanged) {
      if (packageChanged) api_changes.push(unresolvedPackageTargetChange(identity, headGroup[0].surface));
      continue;
    }
    // No shared target changed priority, so only the selected transition is
    // observable; later replacements/deletions remain shadowed.
    comparePackageTargets(identity, baseGroup[0], headGroup[0]);
  }
  if (packageChanged) {
    for (const { surface, priority_group: priorityGroup } of addedConditionalExclusions) {
      if (surface.identity && removedPackageIdentities.has(surface.identity)) continue;
      if (!baseEntries.some((entry) => entry.priority_group === priorityGroup)) continue;
      api_changes.push({
        path: "package.json",
        exports_added: [],
        exports_removed: [],
        signatures_changed: [],
        contract_removed: true,
        contract_name: surface.identity,
        contract_surface: surface
      });
    }
    for (const { surface, consumer_path: consumerPath } of addedPackageExclusions) {
      if (surface.identity && [...removedPackageIdentities].some((identity) =>
        identity === surface.identity || identity.startsWith(`${surface.identity}:`)
      )) continue;
      if (!packageExclusionRemovesContract(
        baseEntries,
        headEntries,
        consumerPath,
        baseExclusionPatterns
      )) continue;
      api_changes.push({
        path: "package.json",
        exports_added: [],
        exports_removed: [],
        signatures_changed: [],
        contract_removed: true,
        contract_name: surface.identity,
        contract_surface: surface
      });
    }
    for (const surface of removedPackageSurfaces) {
      if (surface.identity === undefined || representedRemovedIdentities.has(surface.identity)) continue;
      api_changes.push({
        path: "package.json",
        exports_added: [],
        exports_removed: [],
        signatures_changed: [],
        contract_removed: true,
        contract_name: surface.identity,
        contract_surface: surface
      });
    }
  }
  return {
    schema_changes,
    api_changes,
    test_weakening: detectTestWeakening(sources.diff)
  };
}

function indexPackageConditionDescendants(
  entriesByIdentity: ReadonlyMap<string, PackageContractEntry[]>
): { byParent: Map<string, Array<[string, PackageContractEntry[]]>> } {
  const byParent = new Map<string, Array<[string, PackageContractEntry[]]>>();
  for (const [identity, entries] of entriesByIdentity) {
    if (!identity.startsWith("export:")) continue;
    const exportSeparator = identity.indexOf(":");
    const conditionSeparator = identity.indexOf(":", exportSeparator + 1);
    if (conditionSeparator < 0) continue;
    const root = identity.slice(0, conditionSeparator);
    const conditions = identity.slice(conditionSeparator + 1).split(".");
    for (let index = 0; index < conditions.length; index += 1) {
      const parent = index === 0 ? root : `${root}:${conditions.slice(0, index).join(".")}`;
      const descendants = byParent.get(parent) ?? [];
      descendants.push([identity, entries]);
      byParent.set(parent, descendants);
    }
  }
  return { byParent };
}

function isOrderedSubsequence(orderedSubset: readonly string[], sequence: readonly string[]): boolean {
  let subsetIndex = 0;
  for (const value of sequence) {
    if (value === orderedSubset[subsetIndex]) subsetIndex += 1;
  }
  return subsetIndex === orderedSubset.length;
}

function sharedPackageEntryPriorityChanged(
  baseEntries: readonly PackageContractEntry[],
  headEntries: readonly PackageContractEntry[]
): boolean {
  const remainingHeadIndexes = new Map<string, number[]>();
  headEntries.forEach((entry, index) => {
    const indexes = remainingHeadIndexes.get(entry.surface.source) ?? [];
    indexes.push(index);
    remainingHeadIndexes.set(entry.surface.source, indexes);
  });
  return baseEntries.some((entry, baseIndex) => {
    const indexes = remainingHeadIndexes.get(entry.surface.source);
    const headIndex = indexes?.shift();
    return headIndex !== undefined && headIndex !== baseIndex;
  });
}

function groupPackageEntriesByIdentity(entries: readonly PackageContractEntry[]): Map<string, PackageContractEntry[]> {
  const groups = new Map<string, PackageContractEntry[]>();
  for (const entry of entries) {
    const identity = entry.surface.identity;
    if (!identity) continue;
    const group = groups.get(identity) ?? [];
    group.push(entry);
    groups.set(identity, group);
  }
  return groups;
}

function changedPackagePriorityGroups(
  baseEntries: readonly PackageContractEntry[],
  headEntries: readonly PackageContractEntry[]
): Array<{ group: string; surface: ApiContractSurface }> {
  const grouped = (entries: readonly PackageContractEntry[]): Map<string, PackageContractEntry[]> => {
    const groups = new Map<string, PackageContractEntry[]>();
    for (const entry of entries) {
      if (!entry.priority_group) continue;
      const group = groups.get(entry.priority_group) ?? [];
      group.push(entry);
      groups.set(entry.priority_group, group);
    }
    return groups;
  };
  const baseGroups = grouped(baseEntries);
  const headGroups = grouped(headEntries);
  const changes: Array<{ group: string; surface: ApiContractSurface }> = [];
  for (const [group, baseGroup] of baseGroups) {
    const headGroup = headGroups.get(group);
    if (!headGroup) continue;
    const orderedTargetsUnchanged = baseGroup.length === headGroup.length &&
      baseGroup.every((entry, index) => entry.surface.source === headGroup[index]?.surface.source);
    // Equal target order is only a no-op when each condition still owns the
    // same target; otherwise consumers can observe a condition reassignment.
    const baseAssignments = baseGroup.map((entry) => `${entry.surface.identity}\0${entry.surface.source}`).sort();
    const headAssignments = headGroup.map((entry) => `${entry.surface.identity}\0${entry.surface.source}`).sort();
    const assignmentsUnchanged = baseAssignments.length === headAssignments.length &&
      baseAssignments.every((assignment, index) => assignment === headAssignments[index]);
    if (orderedTargetsUnchanged && assignmentsUnchanged) continue;
    const baseOrder = [...new Set(baseGroup.map((entry) => entry.surface.identity).filter((value): value is string => Boolean(value)))];
    const headOrder = [...new Set(headGroup.map((entry) => entry.surface.identity).filter((value): value is string => Boolean(value)))];
    if (baseOrder.some((identity) => !headOrder.includes(identity))) continue;
    const onlyAppended = baseOrder.every((identity, index) => headOrder[index] === identity);
    if (!onlyAppended) changes.push({ group, surface: headGroup[0].surface });
  }
  return changes;
}

function removeReconciledPathFacts(
  changes: ApiSurfaceChange[],
  identity: string,
  basePath: string,
  headPath: string,
  readBase: (path: string) => string | undefined,
  readHead: (path: string) => string | undefined
): void {
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index];
    const changeIdentity = change.contract_surface?.binding ?? change.contract_surface?.identity;
    const oneSidedArtifact = changeIdentity === undefined && (readBase(change.path) === undefined || readHead(change.path) === undefined);
    if ((oneSidedArtifact || changeIdentity === identity) && (change.path === basePath || change.path === headPath)) {
      changes.splice(index, 1);
    }
  }
}

function unresolvedPackageTargetChange(identity: string, surface: ApiContractSurface): ApiSurfaceChange {
  return {
    path: "package.json",
    exports_added: [],
    exports_removed: [],
    signatures_changed: [],
    contract_target_changed: true,
    contract_name: identity,
    contract_surface: surface
  };
}

function memoizeFileReader(read: (path: string) => string | undefined): (path: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (path) => {
    if (!cache.has(path)) cache.set(path, read(path));
    return cache.get(path);
  };
}

function resolvePackageEntryPath(
  entry: PackageContractEntry,
  read: (path: string) => string | undefined
): string | undefined {
  return entry.patterns.find((pattern) => !/[*?[\]{}!]/u.test(pattern) && read(pattern) !== undefined);
}

// --- .1 semantic JSON-schema diff ------------------------------------------

function isJsonSchemaPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".json") && (lower.includes("schema") || lower.includes("/schemas/"));
}

// For a renamed file the previous content lives at old_path; everything else is
// read at its own path.
function baseReadPath(file: StructuredDiffFile): string {
  return file.old_path && file.old_path !== file.path ? file.old_path : file.path;
}

function diffSchemaFile(file: StructuredDiffFile, sources: SemanticDiffSources): SchemaContractChange | undefined {
  const path = file.path;
  const oldSchema = parseJson(sources.readBase(baseReadPath(file)));
  const newSchema = parseJson(sources.readHead(path));
  // A pure add or delete is not a CONTRACT change to diff (the path-touched risk
  // already covers it); only a modified schema with both versions is diffed.
  if (oldSchema === undefined || newSchema === undefined) {
    return undefined;
  }
  const change: SchemaContractChange = {
    path,
    properties_added: [],
    properties_removed: [],
    required_added: [],
    required_removed: [],
    type_changes: [],
    enum_changes: []
  };
  diffSchemaNode(oldSchema, newSchema, "", change);
  return isEmptySchemaChange(change) ? undefined : change;
}

// Recursively compare two schema nodes, recording property/required/type/enum
// changes keyed by a readable field path (e.g. "properties.foo" or
// "$defs.bar.baz"). Bounded by the schema's own nesting.
function diffSchemaNode(oldNode: unknown, newNode: unknown, pointer: string, change: SchemaContractChange): void {
  if (!isRecord(oldNode) || !isRecord(newNode)) {
    return;
  }

  // required arrays at this node.
  const oldRequired = stringArray(oldNode.required);
  const newRequired = stringArray(newNode.required);
  for (const field of newRequired) {
    if (!oldRequired.includes(field)) {
      change.required_added.push(fieldPath(pointer, field));
    }
  }
  for (const field of oldRequired) {
    if (!newRequired.includes(field)) {
      change.required_removed.push(fieldPath(pointer, field));
    }
  }

  // type change at this node.
  const oldType = typeLabel(oldNode.type);
  const newType = typeLabel(newNode.type);
  if (oldType !== undefined && newType !== undefined && oldType !== newType) {
    change.type_changes.push({ field: pointer || "(root)", from: oldType, to: newType });
  }

  // enum change at this node. Enum members may be strings, numbers, booleans, or
  // null — compare them as JSON values (so `[1, 2]` → `[1, 3]` is detected) and
  // stringify only for the recorded/displayed value.
  const oldEnum = enumValues(oldNode.enum);
  const newEnum = enumValues(newNode.enum);
  if (oldEnum.length > 0 || newEnum.length > 0) {
    const oldKeys = new Set(oldEnum.map(enumKey));
    const newKeys = new Set(newEnum.map(enumKey));
    const added = newEnum.filter((value) => !oldKeys.has(enumKey(value))).map(enumDisplay);
    const removed = oldEnum.filter((value) => !newKeys.has(enumKey(value))).map(enumDisplay);
    if (added.length > 0 || removed.length > 0) {
      change.enum_changes.push({ field: pointer || "(root)", added, removed });
    }
  }

  // properties / $defs children.
  for (const container of ["properties", "$defs", "definitions"]) {
    const oldChildren = isRecord(oldNode[container]) ? (oldNode[container] as Record<string, unknown>) : {};
    const newChildren = isRecord(newNode[container]) ? (newNode[container] as Record<string, unknown>) : {};
    for (const key of Object.keys(newChildren)) {
      if (!(key in oldChildren)) {
        if (container === "properties") {
          change.properties_added.push(fieldPath(pointer, key));
        }
      } else {
        diffSchemaNode(oldChildren[key], newChildren[key], childPointer(pointer, container, key), change);
      }
    }
    for (const key of Object.keys(oldChildren)) {
      if (!(key in newChildren) && container === "properties") {
        change.properties_removed.push(fieldPath(pointer, key));
      }
    }
  }

  // Subschema keywords whose value is itself a schema (or, for `items`, possibly a
  // tuple array of schemas). Recurse so a contract change inside an array element
  // (e.g. `properties.tags.items.type` string→number) is not invisible.
  for (const keyword of ["items", "additionalItems", "contains", "additionalProperties", "propertyNames", "not"]) {
    const oldChild = oldNode[keyword];
    const newChild = newNode[keyword];
    if (Array.isArray(oldChild) && Array.isArray(newChild)) {
      const count = Math.min(oldChild.length, newChild.length);
      for (let index = 0; index < count; index += 1) {
        diffSchemaNode(oldChild[index], newChild[index], `${pointer ? `${pointer}.` : ""}${keyword}[${index}]`, change);
      }
    } else {
      diffSchemaNode(oldChild, newChild, fieldPath(pointer, keyword), change);
    }
  }

  // Schema composition keywords (arrays of subschemas): recurse positionally, and
  // diff added/removed branches against an empty schema so a NEW `allOf` branch
  // that introduces required fields or properties (or a removed branch that
  // relaxes them) still feeds the contract facts rather than being invisible
  // whenever the composition array grows or shrinks.
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const oldBranch = Array.isArray(oldNode[keyword]) ? (oldNode[keyword] as unknown[]) : [];
    const newBranch = Array.isArray(newNode[keyword]) ? (newNode[keyword] as unknown[]) : [];
    const branchCount = Math.max(oldBranch.length, newBranch.length);
    for (let index = 0; index < branchCount; index += 1) {
      diffSchemaNode(oldBranch[index] ?? {}, newBranch[index] ?? {}, `${pointer ? `${pointer}.` : ""}${keyword}[${index}]`, change);
    }
  }
}

function isEmptySchemaChange(change: SchemaContractChange): boolean {
  return (
    change.properties_added.length === 0 &&
    change.properties_removed.length === 0 &&
    change.required_added.length === 0 &&
    change.required_removed.length === 0 &&
    change.type_changes.length === 0 &&
    change.enum_changes.length === 0
  );
}

// --- .3 test-weakening signals (from the diff alone) -----------------------

// A test declaration that is skipped, anchored at the start of the (trimmed)
// line so a `.skip(` inside a STRING literal (e.g. a test fixture describing a
// skipped test) does not count as a real skip.
const SKIP_PATTERN = /^\s*(?:(?:describe|it|test|context)\.skip|x(?:it|describe|test|context))\s*\(/;
const ASSERTION_PATTERN = /\b(?:expect|assert)\s*\(|\bassert\.[a-zA-Z]|\.(?:toBe|toEqual|toMatch|toThrow|toContain|deepEqual|strictEqual|ok|equal)\s*\(/;

function detectTestWeakening(diff: StructuredDiff): TestWeakeningSignal[] {
  const signals: TestWeakeningSignal[] = [];
  for (const file of diff.files) {
    if (isSnapshotPath(file.path)) {
      // A regeneration that could mask a regression requires a prior baseline:
      // fire for a MODIFIED snapshot, and for a RENAMED one that was also edited
      // (status "R" with hunks). A newly-added snapshot (status "A") is a new
      // test's first snapshot — no prior baseline — so it is not weakening.
      const editedRename = file.status === "R" && file.hunks.length > 0;
      if (file.status === "modified" || editedRename) {
        signals.push({ kind: "regenerated_snapshot", path: file.path, detail: "Snapshot file changed; confirm it was regenerated for an intended behavior change, not to mask a regression." });
      }
      continue;
    }
    if (!isTestPath(file.path)) {
      continue;
    }
    if (file.status === "D") {
      signals.push({ kind: "deleted_test_file", path: file.path, detail: "Test file deleted; confirm its coverage moved elsewhere and was not silently dropped." });
      continue;
    }
    // Skip/assertion weakening needs a prior version to weaken. A brand-new test
    // file (status "A") has none — treating its added lines as "newly skipped" /
    // "removed assertions" would be noise (and its `.skip(` fixture strings would
    // false-fire). A modified OR renamed file does carry prior coverage, so a
    // rename that also disables a test or drops assertions is still inspected.
    if (file.status === "A") {
      continue;
    }
    const added = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "add").map((line) => line.text));
    const removed = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "delete").map((line) => line.text));

    // A newly-skipped test: a skip marker added that was not merely moved.
    const addedSkips = added.filter((text) => SKIP_PATTERN.test(text)).length;
    const removedSkips = removed.filter((text) => SKIP_PATTERN.test(text)).length;
    if (addedSkips > removedSkips) {
      signals.push({ kind: "skipped_test", path: file.path, detail: `${addedSkips - removedSkips} test(s) newly skipped; confirm the disabled coverage is intentional.` });
    }

    // Removed assertions: more assertion lines deleted than added. A pure edit
    // (assertion modified, or unrelated change) nets to zero and does NOT fire.
    const addedAsserts = added.filter((text) => ASSERTION_PATTERN.test(text)).length;
    const removedAsserts = removed.filter((text) => ASSERTION_PATTERN.test(text)).length;
    if (removedAsserts > addedAsserts) {
      signals.push({ kind: "removed_assertion", path: file.path, detail: `${removedAsserts - addedAsserts} assertion(s) removed; confirm the checks were not weakened to pass.` });
    }
  }
  return signals;
}

function isSnapshotPath(path: string): boolean {
  return path.endsWith(".snap") || path.endsWith(".snapshot");
}

// --- .2 exported TypeScript API-surface diff -------------------------------

// `.ts`/`.tsx` and `.d.ts` declaration files (often the published API contract),
// excluding tests. `.d.ts` content is parsed the same way; its `export declare`
// forms are ordinary exported declarations to the TS parser.
function isTypeScriptSourcePath(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/u.test(path) && !isTestPath(path);
}

function diffApiSurfaceFile(file: StructuredDiffFile, sources: SemanticDiffSources): ApiSurfaceChange | undefined {
  const path = file.path;
  // For a renamed module the previous content lives at old_path, so an export
  // dropped during the rename is surfaced (not silently treated as absent).
  // Deliberate scope: a PURE rename that preserves every export is not emitted as
  // a wholesale removal+addition of all symbols — the moved import path is already
  // surfaced as a renamed changed file, and re-listing every symbol on both sides
  // would be noise. Only symbol-level adds/removes/signature changes are facts here.
  const oldText = sources.readBase(baseReadPath(file));
  const newText = sources.readHead(path);
  return diffApiSurfaceTexts(path, oldText, newText, baseReadPath(file));
}

function diffApiSurfaceTexts(
  path: string,
  oldText: string | undefined,
  newText: string | undefined,
  oldPath = path
): ApiSurfaceChange | undefined {
  // A file present on neither side is not analyzable.
  if (oldText === undefined && newText === undefined) {
    return undefined;
  }
  // An ADDED module (no base) makes all its exports new API surface; a DELETED
  // module (no head) removes all of its exports. Both are concrete add/remove
  // facts SEMANTIC_DIFF.2 should surface, so treat the missing side as no
  // exports rather than skipping the file.
  const oldExports = oldText === undefined ? new Map<string, string>() : extractExports(oldText, oldPath);
  const newExports = newText === undefined ? new Map<string, string>() : extractExports(newText, path);
  const change: ApiSurfaceChange = { path, exports_added: [], exports_removed: [], signatures_changed: [] };
  for (const [name, signature] of newExports) {
    const previous = oldExports.get(name);
    if (previous === undefined) {
      change.exports_added.push(name);
    } else if (previous !== signature) {
      change.signatures_changed.push({ name, from: previous, to: signature });
    }
  }
  for (const name of oldExports.keys()) {
    if (!newExports.has(name)) {
      change.exports_removed.push(name);
    }
  }
  if (change.exports_added.length === 0 && change.exports_removed.length === 0 && change.signatures_changed.length === 0) {
    return undefined;
  }
  return change;
}

// Export extractor: maps an exported symbol name to a normalized signature
// string, parsed from the real TypeScript AST (ts.createSourceFile). The
// signature carries enough of each declaration to detect breaking shape changes:
//   - function: name + type params + parameter list + return type (NOT the body),
//     so a param- or return-type change is a signature change and an
//     implementation edit is not. Overload sets keep every signature.
//   - class: name + type params + heritage (extends/implements), excluding members.
//   - interface/type/enum: the full declaration text (a member addition or alias
//     change is a signature change).
//   - const/let/var: name + type annotation; for an arrow/function-expression
//     initializer, its parameter list + return type (excluding the body).
//   - `export default function/class`, default expressions (keyed `default`),
//     `export =` (keyed `export=`), named re-exports, and `export *`/`export * as`.
// Parsing is pure and deterministic, so base and head are extracted by the same
// rule: a real change is detected and a non-change is not.
function extractExports(source: string, path = "module.ts"): Map<string, string> {
  const scriptKind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const exports = new Map<string, string>();
  // review-surfaces.COLD_START.3: signatures are compared comment-stripped and
  // whitespace-normalized. Slices are raw source text, so without stripping, a
  // doc-comment-only edit inside an exported type reads as a signature change
  // (the got cold-start false positive: two TSDoc lines became the #1 review
  // item). The TS scanner walks the fragment and drops comment trivia; both
  // sides pass through the same rule, so a real change is still detected.
  const stripComments = (text: string): string => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.Standard, text);
    let out = "";
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      out += token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia ? " " : scanner.getTokenText();
      token = scanner.scan();
    }
    return out;
  };
  const norm = (text: string): string => stripComments(text).replace(/\s+/g, " ").trim();
  // The declaration text from its first token to a stop offset, excluding any
  // implementation body so only the contract is compared.
  const slice = (node: ts.Node, stop: number): string => norm(source.slice(node.getStart(sourceFile), stop));
  const hasModifier = (node: ts.HasModifiers, kind: ts.SyntaxKind): boolean =>
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
  const isExported = (node: ts.HasModifiers): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword);
  const defaultOr = (node: ts.HasModifiers, name: string | undefined): string | undefined =>
    hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : name;
  // The offset where a declaration's implementation body begins (its start when
  // bodyless, e.g. an overload, an ambient `.d.ts` declaration, or a namespace
  // head). Slicing up to it compares the contract, not the body.
  const bodyStop = (node: { body?: ts.Node }, fallback: number): number => (node.body ? node.body.getStart(sourceFile) : fallback);

  // Declaration text up to `stop` with the declared name spliced out — identity
  // comes from the export key, so a default export's local name, a function
  // expression's inner name, or a class's own name (which a default importer
  // cannot observe) never create noisy signature changes.
  const sliceExcludingName = (node: ts.Node, nameNode: ts.Node | undefined, stop: number): string =>
    nameNode
      ? norm(source.slice(node.getStart(sourceFile), nameNode.getStart(sourceFile)) + source.slice(nameNode.end, stop))
      : slice(node, stop);

  // A function-like signature is the SHAPE — type params, parameters, return type
  // — name-independent and with the body excluded. `export`/`default`/`async`
  // modifiers before the name are kept.
  const functionLikeSignature = (node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression, prefix: string): string =>
    norm(`${prefix} ${sliceExcludingName(node, node.name, bodyStop(node, node.end))}`);

  // Peel redundant parentheses so `((x) => {})` is recognized as a function.
  const unwrap = (expression: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression;

  // A class's head — type params + extends/implements — name-independent and
  // excluding the member bodies. For an anonymous default class with no heritage
  // the boundary is the body's opening brace.
  const classHeadSignature = (node: ts.ClassDeclaration): string => {
    const headEnd = node.heritageClauses?.at(-1)?.end ?? node.typeParameters?.end ?? node.name?.end;
    const stop = headEnd ?? (node.members.length > 0 ? node.members[0].getStart(sourceFile) : node.end);
    return sliceExcludingName(node, node.name, stop).replace(/\s*\{\s*$/, "");
  };

  // The SHAPE of one variable binding target — name-independent (identity is the
  // export key): an explicit type annotation, a function/arrow initializer's
  // signature (body excluded), or a destructured leaf's own member type.
  const variableLeafSignature = (keyword: string, declaration: ts.VariableDeclaration, target: BindingTarget): string => {
    if (ts.isIdentifier(declaration.name)) {
      if (declaration.type) {
        return norm(`${keyword} ${sliceExcludingName(declaration, declaration.name, declaration.type.end)}`);
      }
      const initializer = declaration.initializer ? unwrap(declaration.initializer) : undefined;
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        return functionLikeSignature(initializer, keyword);
      }
      return keyword;
    }
    const memberType = target.property ? memberTypeText(declaration.type, target.property, slice) : undefined;
    const annotation = memberType ?? (declaration.type ? slice(declaration.type, declaration.type.end) : "");
    return norm(`${keyword}${annotation ? `: ${annotation}` : ""}`);
  };

  // The name-independent signature of a top-level declaration named `name`
  // (exported or not), so an `export default <ident>` or a local `export { ident }`
  // is compared by what the identifier refers to rather than by its text.
  const resolveLocalSignature = (name: string): string | undefined => {
    // Function overloads: aggregate all matching declarations (the public overloads
    // when a set exists, else the standalone function).
    const functions = sourceFile.statements.filter(
      (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name
    );
    if (functions.length > 0) {
      const overloaded = functions.some((fn) => fn.body === undefined);
      const surface = functions.filter((fn) => !(overloaded && fn.body !== undefined));
      return (surface.length > 0 ? surface : functions).map((fn) => functionLikeSignature(fn, "function")).join(" ;; ");
    }
    for (const statement of sourceFile.statements) {
      if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
        return classHeadSignature(statement);
      }
      if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name.text === name) {
        return slice(statement, statement.end);
      }
      if (ts.isVariableStatement(statement)) {
        const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? "const" : statement.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
        for (const declaration of statement.declarationList.declarations) {
          for (const target of bindingTargets(declaration.name)) {
            if (target.name === name) {
              return variableLeafSignature(keyword, declaration, target);
            }
          }
        }
      }
    }
    return undefined;
  };

  // Collect exports from a statement list under a name prefix; recursed for the
  // body of an exported namespace so nested members are part of the surface.
  const collect = (statements: readonly ts.Statement[], prefix: string): void => {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
        const name = defaultOr(statement, statement.name?.text);
        // When an overload SET exists (sibling bodyless declarations of the same
        // name), the bodied declaration is the private implementation — not callable
        // from outside — so its signature is excluded; the public overloads define
        // the surface. A standalone bodied function is the surface and is kept.
        const isOverloadImpl = statement.body !== undefined && statements.some((sibling) =>
          sibling !== statement && ts.isFunctionDeclaration(sibling) && sibling.body === undefined && sibling.name?.text === statement.name?.text && isExported(sibling));
        if (name && !isOverloadImpl) {
          // An overload set shares one name across several signatures; concatenate so
          // adding/removing/altering any overload is a signature change. The
          // signature is name-independent (identity is the key), so a default
          // export's local rename is not a spurious change.
          const key = `${prefix}${name}`;
          const previous = exports.get(key);
          const signature = functionLikeSignature(statement, "function");
          exports.set(key, previous ? `${previous} ;; ${signature}` : signature);
        }
        continue;
      }
      if (ts.isClassDeclaration(statement) && isExported(statement)) {
        const name = defaultOr(statement, statement.name?.text);
        if (name) {
          exports.set(`${prefix}${name}`, classHeadSignature(statement));
        }
        continue;
      }
      if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && isExported(statement)) {
        exports.set(`${prefix}${statement.name.text}`, slice(statement, statement.end));
        continue;
      }
      if (ts.isModuleDeclaration(statement) && isExported(statement) && ts.isIdentifier(statement.name)) {
        // `export namespace N {}` — record its presence/head, then recurse so a
        // change to a nested exported member (N.foo) is part of the API surface.
        // A dotted `namespace A.B {}` nests another ModuleDeclaration as its body;
        // follow the chain so A.B's members are reached under the `A.B.` prefix.
        let moduleName = statement.name.text;
        let body: ts.ModuleBody | undefined = statement.body;
        while (body && ts.isModuleDeclaration(body) && ts.isIdentifier(body.name)) {
          moduleName += `.${body.name.text}`;
          body = body.body;
        }
        exports.set(`namespace:${prefix}${moduleName}`, slice(statement, bodyStop(statement, statement.end)));
        if (body && ts.isModuleBlock(body)) {
          collect(body.statements, `${prefix}${moduleName}.`);
        }
        continue;
      }
      if (ts.isVariableStatement(statement) && isExported(statement)) {
        const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? "const" : statement.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
        for (const declaration of statement.declarationList.declarations) {
          for (const target of bindingTargets(declaration.name)) {
            exports.set(`${prefix}${target.name}`, variableLeafSignature(keyword, declaration, target));
          }
        }
        continue;
      }
      if (ts.isExportAssignment(statement)) {
        // `export default <expr>` (isExportEquals false) or `export = <expr>`.
        // A function/arrow expression is compared by its signature shape (body
        // excluded), so an implementation-only edit is not a spurious change; any
        // other value expression is compared by its full text.
        const word = statement.isExportEquals ? "export=" : "default";
        const key = `${prefix}${word}`;
        const expr = unwrap(statement.expression);
        if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
          exports.set(key, functionLikeSignature(expr, word));
        } else if (ts.isIdentifier(expr)) {
          // `export default handler` — compare by what `handler` refers to (the
          // common local-then-export pattern), falling back to the identifier text.
          exports.set(key, resolveLocalSignature(expr.text) ?? slice(statement, statement.end));
        } else {
          exports.set(key, slice(statement, statement.end));
        }
        continue;
      }
      if (ts.isExportDeclaration(statement)) {
        // Fold the source module into the signature so a re-export's origin change is
        // a fact, and a local `export { x }` and `export { x } from "y"` do not collide.
        const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? ` from ${statement.moduleSpecifier.text}` : "";
        // `type` (statement-level) drops the runtime export — a real contract change
        // for value importers — so it is part of every signature below.
        const statementType = statement.isTypeOnly ? "type " : "";
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const typeOnly = statement.isTypeOnly || element.isTypeOnly ? "type " : "";
            const local = element.propertyName?.text ?? element.name.text;
            // A local `export { handler }` / `export type { Options }` (no `from`)
            // refers to a declaration in this file — compare by what it refers to
            // (resolving local types too) so a change to the local's shape is seen.
            // The type-only marker is kept so a runtime→type-only switch still shows.
            const resolved = from ? undefined : resolveLocalSignature(local);
            // `propertyName` (the binding before `as`) makes an alias-target change
            // (`{ a as x }` → `{ b as x }`) a fact.
            const target = element.propertyName ? `${element.propertyName.text} as ` : "";
            exports.set(`${prefix}${element.name.text}`, resolved ? `${typeOnly}${resolved}` : `named ${typeOnly}${target}${element.name.text}${from}`);
          }
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
          exports.set(`${prefix}${statement.exportClause.name.text}`, `namespace-reexport ${statementType}${statement.exportClause.name.text}${from}`);
        } else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          // `export * from "./x"` — keyed by the source module so adding/removing the
          // star re-export is detected even though the names cannot be enumerated.
          exports.set(`*:${prefix}${statement.moduleSpecifier.text}`, `export-star ${statementType}${statement.moduleSpecifier.text}`);
        }
        continue;
      }
    }
  };

  collect(sourceFile.statements, "");
  return exports;
}

// The identifier leaves bound by a variable declaration name: the single
// identifier itself, or each identifier in a destructuring `{ a, b }` / `[a, b]`
// pattern — so `export const { a, b } = x` records both `a` and `b`. `property` is
// the source property name a DIRECT object-pattern leaf reads (so its type can be
// looked up in a type-literal annotation); undefined for nested or array leaves.
interface BindingTarget {
  name: string;
  node: ts.Node;
  property?: string;
}

function bindingTargets(name: ts.BindingName): BindingTarget[] {
  if (ts.isIdentifier(name)) {
    return [{ name: name.text, node: name }];
  }
  const targets: BindingTarget[] = [];
  for (const element of name.elements) {
    if (!ts.isBindingElement(element)) {
      continue;
    }
    const property = ts.isObjectBindingPattern(name)
      ? (element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : undefined)
      : undefined;
    for (const leaf of bindingTargets(element.name)) {
      // Only a DIRECT leaf (the element's own identifier) gets this element's
      // property; a nested-pattern leaf keeps its own (undefined) property.
      targets.push({ ...leaf, property: leaf.node === element.name ? property : leaf.property });
    }
  }
  return targets;
}

// The text of the member type for `property` within a type-literal annotation, so
// a destructured leaf's signature reflects only its own member. Undefined when the
// annotation is absent, not a type literal, or has no matching member.
function memberTypeText(typeNode: ts.TypeNode | undefined, property: string, slice: (node: ts.Node, stop: number) => string): string | undefined {
  if (!typeNode || !ts.isTypeLiteralNode(typeNode)) {
    return undefined;
  }
  for (const member of typeNode.members) {
    if (ts.isPropertySignature(member) && member.type && ts.isIdentifier(member.name) && member.name.text === property) {
      // Keep optionality (`a?: string` widens the leaf's type to include undefined)
      // so a required↔optional change is a real, detected contract change.
      return `${member.questionToken ? "?" : ""}${slice(member.type, member.type.end)}`;
    }
  }
  return undefined;
}

// --- helpers ---------------------------------------------------------------

function parseJson(text: string | undefined): unknown {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function enumValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// A canonical identity key for an enum member, so members are compared as JSON
// values rather than by string identity (`1` and `"1"` are distinct members).
function enumKey(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

// The recorded/displayed form of an enum member: strings as-is, everything else
// (numbers, booleans, null) as its JSON literal.
function enumDisplay(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

function typeLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string").join("|") || undefined;
  }
  return undefined;
}

function fieldPath(pointer: string, field: string): string {
  return pointer ? `${pointer}.${field}` : field;
}

function childPointer(pointer: string, container: string, key: string): string {
  const head = pointer ? `${pointer}.${container}` : container;
  return `${head}.${key}`;
}
