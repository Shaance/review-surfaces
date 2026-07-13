import { compareStrings } from "./compare";

export type PackageManifestTargetKind = "export" | "entry" | "file";

export interface PackageManifestTarget {
  kind: PackageManifestTargetKind;
  field: string;
  target: string;
  /** Stable consumer-facing slot, distinct from the build target path. */
  identity: string;
  /** Consumer subpath whose condition order participates in resolution priority. */
  priority_group?: string;
  /** Raw consumer-facing export key used for wildcard precedence/exclusions. */
  consumer_path?: string;
}

/** Stable key for source projections that distinguishes consumer contracts sharing one build target. */
export function packageManifestTargetProjectionKey(
  target: Pick<PackageManifestTarget, "identity" | "target">
): string {
  return `${target.identity}\0${target.target}`;
}

export function packageTargetPrefersRootSource(
  target: Pick<PackageManifestTarget, "kind" | "field" | "consumer_path">
): boolean {
  return target.consumer_path === "." || (target.kind === "entry" && target.field !== "bin");
}

export interface CompiledPackageTarget {
  outputRoot: "dist" | "build" | "out" | "lib";
  relativePath: string;
}

export function parseCompiledPackageTarget(target: string): CompiledPackageTarget | undefined {
  const normalized = target.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const match = /^(dist|build|out|lib)\/(.+)$/u.exec(normalized);
  return match ? {
    outputRoot: match[1] as CompiledPackageTarget["outputRoot"],
    relativePath: match[2]
  } : undefined;
}

export function packageTargetSourceVariants(
  value: string,
  probeExtensionlessLegacyEntry: boolean
): string[] {
  const candidates = new Set<string>([value]);
  if (probeExtensionlessLegacyEntry && !value.includes("*") && !/\.[^/]+$/u.test(value)) {
    for (const extension of ["ts", "tsx", "mts", "cts"]) candidates.add(`${value}.${extension}`);
  }
  if (/\.jsx$/u.test(value)) {
    candidates.add(`${value.slice(0, -4)}.tsx`);
  } else if (/\.(mjs|cjs|js)$/u.test(value)) {
    const stem = value.replace(/\.(mjs|cjs|js)$/u, "");
    for (const extension of ["ts", "tsx", "mts", "cts"]) candidates.add(`${stem}.${extension}`);
  }
  if (/\.d\.(mts|cts|ts)$/u.test(value)) {
    const stem = value.replace(/\.d\.(mts|cts|ts)$/u, "");
    for (const extension of ["ts", "tsx", "mts", "cts"]) candidates.add(`${stem}.${extension}`);
  }
  return [...candidates].filter(Boolean).sort(compareStrings);
}

export function compilePackageTargetPathMatcher(
  pattern: string
): (value: string) => { capture?: string } | undefined {
  const parts = pattern.split("*");
  if (parts.length < 2) return (value) => value === pattern ? {} : undefined;
  const tail = escapeRegExp(parts[1]) + parts.slice(2).map((part) => `\\k<binding>${escapeRegExp(part)}`).join("");
  const expression = new RegExp(`^${escapeRegExp(parts[0])}(?<binding>.+?)${tail}$`, "u");
  return (value) => {
    const capture = expression.exec(value)?.groups?.binding;
    return capture === undefined ? undefined : { capture };
  };
}

export function parsePackageManifest(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** Deterministically collect package entry targets shared by source-root and contract analysis. */
export function collectPackageManifestTargets(manifest: Record<string, unknown>): PackageManifestTarget[] {
  const targets: PackageManifestTarget[] = [];
  const hasExports = manifest.exports !== null && Object.prototype.hasOwnProperty.call(manifest, "exports");
  for (const entry of collectExportTargets(manifest.exports)) {
    targets.push({
      kind: "export",
      field: "exports",
      target: entry.target,
      identity: entry.identity,
      priority_group: entry.priority_group,
      consumer_path: entry.consumer_path
    });
  }
  for (const field of ["main", "module", "types", "typings"] as const) {
    // Node package resolution gives a non-null authored `exports` field
    // precedence over the legacy `main` root. A top-level JSON null behaves as
    // an absent exports field, while `{ ".": null }` explicitly blocks root.
    // Keep bundler/declaration metadata independent: `module`, `types`, and
    // `typings` remain distinct supported consumer surfaces.
    if (hasExports && field === "main") continue;
    const target = manifest[field];
    if (typeof target === "string") {
      targets.push({
        kind: "entry",
        field,
        target,
        // `main` and the root `exports` key are two resolution mechanisms for
        // the same consumer slot. Canonicalizing that slot lets semantic diff
        // compare their targets instead of reporting a fake remove/add pair.
        identity: field === "main" ? packageExportSubpathIdentity(".") : `entry:${field}`,
        consumer_path: "."
      });
    }
  }
  const bin = manifest.bin;
  const binTargets: Array<{ key: string; target: unknown }> = typeof bin === "string"
    ? [{ key: "bin", target: bin }]
    : bin && typeof bin === "object" && !Array.isArray(bin)
      ? Object.keys(bin as Record<string, unknown>)
          .sort(compareStrings)
          .map((key) => ({ key, target: (bin as Record<string, unknown>)[key] }))
      : [];
  for (const { key, target } of binTargets) {
    if (typeof target === "string") targets.push({ kind: "entry", field: "bin", target, identity: `bin:${key}` });
  }
  for (const target of stringArray(manifest.files)) {
    targets.push({ kind: "file", field: "files", target, identity: `file:${target}` });
  }
  return targets;
}

/** Unconditional consumer subpaths explicitly blocked with a top-level null target. */
export function collectPackageExportExclusions(manifest: Record<string, unknown>): string[] {
  const value = manifest.exports;
  if (value === null) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const subpathKeys = Object.keys(record).filter((key) => key.startsWith("."));
  if (subpathKeys.length === 0) {
    return isNullOnlyTargetTree(record) ? ["."] : [];
  }
  return Object.keys(record)
    .filter((key) => key.startsWith(".") && isNullOnlyTargetTree(record[key]))
    .sort(compareStrings);
}

export interface PackageExportConditionExclusion {
  identity: string;
  consumer_path: string;
  priority_group: string;
}

/** Effective conditional null branches that block a previously available later fallback. */
export function collectPackageExportConditionExclusions(
  manifest: Record<string, unknown>
): PackageExportConditionExclusion[] {
  return collectExportResolution(manifest.exports).conditionalExclusions;
}

/** Conditional export identities whose reachable default chain resolves to a terminal target. */
export function collectUniversalPackageExportConditionParents(manifest: Record<string, unknown>): string[] {
  return [...new Set(collectExportResolution(manifest.exports).universalParents)].sort(compareStrings);
}

function isNullOnlyTargetTree(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(isNullOnlyTargetTree);
  if (!value || typeof value !== "object") return false;
  const values = Object.values(value as Record<string, unknown>);
  return values.length > 0 && values.every(isNullOnlyTargetTree);
}

type CollectedExportTarget = { identity: string; target: string; priority_group: string; consumer_path: string };
type CollectedExportResolution = {
  targets: CollectedExportTarget[];
  conditionalExclusions: PackageExportConditionExclusion[];
  universalParents: string[];
};

function collectExportTargets(value: unknown, subpath = ".", conditions: string[] = []): CollectedExportTarget[] {
  return collectExportResolution(value, subpath, conditions).targets;
}

function collectExportResolution(
  value: unknown,
  subpath = ".",
  conditions: string[] = []
): CollectedExportResolution {
  const encodedSubpath = encodeSubpathIdentityPart(subpath);
  const identity = `${packageExportSubpathIdentity(subpath)}${conditions.length > 0 ? `:${conditions.map(encodeConditionIdentityPart).join(".")}` : ""}`;
  // Node package exports accept only package-relative targets. Invalid entries
  // in fallback arrays are skipped during resolution and must not become the
  // apparent selected contract target.
  if (typeof value === "string") return {
    targets: validPackageExportTarget(value)
      ? [{ identity, target: value, priority_group: `export:${encodedSubpath}`, consumer_path: subpath }]
      : [],
    conditionalExclusions: [],
    universalParents: []
  };
  if (Array.isArray(value)) {
    const entries = value.filter((entry) => entry !== null).map((entry) => collectExportResolution(entry, subpath, conditions));
    const exclusionsByIdentity = new Map<string, PackageExportConditionExclusion>();
    for (const exclusion of entries.flatMap((entry) => entry.conditionalExclusions)) {
      exclusionsByIdentity.set(`${exclusion.consumer_path}\0${exclusion.identity}`, exclusion);
    }
    const conditionalExclusions = [...exclusionsByIdentity.values()].filter((exclusion) =>
      !entries.some((entry) => entryResolvesExcludedCondition(entry, exclusion))
    );
    return {
      targets: entries.flatMap((entry) => entry.targets),
      conditionalExclusions,
      universalParents: entries.flatMap((entry) => entry.universalParents)
    };
  }
  if (!value || typeof value !== "object") return { targets: [], conditionalExclusions: [], universalParents: [] };
  const record = value as Record<string, unknown>;
  const insertionKeys = Object.keys(record);
  const subpathMap = insertionKeys.some((key) => key.startsWith("."));
  // Subpath key order is not priority, so keep deterministic sorting there.
  // Condition key order is runtime-significant and must remain authored order.
  const orderedKeys = subpathMap ? [...insertionKeys].sort(compareStrings) : insertionKeys;
  const defaultIndex = subpathMap ? -1 : orderedKeys.indexOf("default");
  const keys = defaultIndex >= 0 ? orderedKeys.slice(0, defaultIndex + 1) : orderedKeys;
  const soleDefault = !subpathMap && keys.length === 1 && keys[0] === "default";
  const branches = keys.map((key) => subpathMap && key.startsWith(".")
    ? collectExportResolution(record[key], key, [])
    : collectExportResolution(record[key], subpath, soleDefault ? conditions : [...conditions, key]));
  const conditionalExclusions = branches.flatMap((branch) => branch.conditionalExclusions);
  const universalParents = branches.flatMap((branch) => branch.universalParents);
  if (!subpathMap && isUniversallyResolvingExportTarget(value)) universalParents.push(identity);
  if (!subpathMap) {
    let laterTargetAvailable = false;
    for (let index = branches.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (record[key] === null && laterTargetAvailable) {
        const branchConditions = [...conditions, key];
        conditionalExclusions.push({
          identity: `${packageExportSubpathIdentity(subpath)}:${branchConditions.map(encodeConditionIdentityPart).join(".")}`,
          consumer_path: subpath,
          priority_group: `export:${encodedSubpath}`
        });
      }
      if (branches[index].targets.length > 0) laterTargetAvailable = true;
    }
  }
  const targetBranches = branches.filter((branch, index) => branch.targets.length > 0 || record[keys[index]] !== null);
  if (!subpathMap && keys.length > 1 && defaultIndex >= 0 &&
    isUniversallyResolvingExportTarget(record.default) &&
    targetBranches.every((branch) => branch.targets.length > 0)) {
    const effectiveTargets = targetBranches.map((branch) => uniformEffectiveTarget(branch.targets));
    const target = effectiveTargets[0];
    if (target && effectiveTargets.every((candidate) => candidate === target)) {
      return {
        targets: [{ identity, target, priority_group: `export:${encodedSubpath}`, consumer_path: subpath }],
        conditionalExclusions,
        universalParents
      };
    }
  }
  return { targets: branches.flatMap((branch) => branch.targets), conditionalExclusions, universalParents };
}

function isUniversallyResolvingExportTarget(value: unknown): boolean {
  if (typeof value === "string") return validPackageExportTarget(value);
  if (Array.isArray(value)) return value.some(isUniversallyResolvingExportTarget);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key.startsWith("."))) return false;
  return Object.hasOwn(record, "default") && isUniversallyResolvingExportTarget(record.default);
}

function entryResolvesExcludedCondition(
  entry: { targets: readonly CollectedExportTarget[]; conditionalExclusions: readonly PackageExportConditionExclusion[] },
  requested: PackageExportConditionExclusion
): boolean {
  if (entry.conditionalExclusions.length > 0) return false;
  return entry.targets.some((target) => targetCoversConditionalExclusion(target.identity, requested));
}

function targetCoversConditionalExclusion(
  targetIdentity: string,
  exclusion: PackageExportConditionExclusion
): boolean {
  const baseIdentity = packageExportSubpathIdentity(exclusion.consumer_path);
  if (targetIdentity === baseIdentity) return true;
  if (!targetIdentity.startsWith(`${baseIdentity}:`) || !exclusion.identity.startsWith(`${baseIdentity}:`)) return false;
  const targetConditions = targetIdentity.slice(baseIdentity.length + 1).split(".");
  const excludedConditions = exclusion.identity.slice(baseIdentity.length + 1).split(".");
  const targetIsPrefix = targetConditions.every((condition, index) => condition === excludedConditions[index]);
  if (targetIsPrefix) return true;
  return targetConditions.at(-1) === "default" &&
    targetConditions.slice(0, -1).every((condition, index) => condition === excludedConditions[index]);
}

function uniformEffectiveTarget(
  entries: readonly { identity: string; target: string }[]
): string | undefined {
  const selected = new Map<string, string>();
  for (const entry of entries) {
    if (!selected.has(entry.identity)) selected.set(entry.identity, entry.target);
  }
  const targets = new Set(selected.values());
  return targets.size === 1 ? targets.values().next().value : undefined;
}

function validPackageExportTarget(target: string): boolean {
  if (!target.startsWith("./") || /%2f|%5c/iu.test(target)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return false;
  }
  const relative = decoded.slice(2).replace(/\\/gu, "/");
  if (!relative || relative.startsWith("/")) return false;
  return !relative.split("/").some((segment) =>
    segment === "." || segment === ".." || segment.toLowerCase() === "node_modules"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

export function packageExportSubpathIdentity(subpath: string): string {
  return `export:${encodeSubpathIdentityPart(subpath)}`;
}

function encodeSubpathIdentityPart(value: string): string {
  return value.replaceAll("%", "%25").replaceAll(":", "%3A");
}

function encodeConditionIdentityPart(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll(".", "%2E")
    .replaceAll(":", "%3A")
    .replaceAll("*", "%2A");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
