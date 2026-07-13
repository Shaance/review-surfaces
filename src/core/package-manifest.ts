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
  const hasExports = Object.prototype.hasOwnProperty.call(manifest, "exports");
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
    // Node package resolution gives an authored `exports` field precedence
    // over the legacy `main` root, even when `exports` is empty or null. Keep
    // bundler/declaration metadata independent: `module`, `types`, and
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
  if (value === null) return ["."];
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

function isNullOnlyTargetTree(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(isNullOnlyTargetTree);
  if (!value || typeof value !== "object") return false;
  const values = Object.values(value as Record<string, unknown>);
  return values.length > 0 && values.every(isNullOnlyTargetTree);
}

function collectExportTargets(value: unknown, subpath = ".", conditions: string[] = []): Array<{ identity: string; target: string; priority_group: string; consumer_path: string }> {
  const encodedSubpath = encodeSubpathIdentityPart(subpath);
  const identity = `${packageExportSubpathIdentity(subpath)}${conditions.length > 0 ? `:${conditions.map(encodeConditionIdentityPart).join(".")}` : ""}`;
  if (typeof value === "string") return [{ identity, target: value, priority_group: `export:${encodedSubpath}`, consumer_path: subpath }];
  if (Array.isArray(value)) return value.flatMap((entry) => collectExportTargets(entry, subpath, conditions));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const insertionKeys = Object.keys(record);
  const subpathMap = insertionKeys.some((key) => key.startsWith("."));
  // Subpath key order is not priority, so keep deterministic sorting there.
  // Condition key order is runtime-significant and must remain authored order.
  const keys = subpathMap ? [...insertionKeys].sort(compareStrings) : insertionKeys;
  return keys.flatMap((key) => subpathMap && key.startsWith(".")
    ? collectExportTargets(record[key], key, [])
    : collectExportTargets(record[key], subpath, [...conditions, key]));
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
