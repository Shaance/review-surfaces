// review-surfaces.DEP_FACTS.1/.2: deterministic, offline dependency/supply-chain
// facts from manifest and lockfile changes, modeled on the semantic-diff shape
// (base/head content in, typed facts out). Registry metadata (age, downloads) is
// deliberately NOT here — it is optional provider enrichment that may adorn
// facts later but never creates or removes one (DEP_FACTS.3).
import { parse as parseYaml } from "yaml";

export type DependencyFactKind =
  | "dependency_added"
  | "dependency_removed"
  | "dependency_group_moved"
  | "major_version_bump"
  | "version_range_loosened"
  | "transitive_added"
  | "install_scripts";

export interface DependencyFact {
  kind: DependencyFactKind;
  package: string;
  detail: string;
  // The manifest/lockfile path the fact came from.
  source_path: string;
}

const DEP_GROUPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

export interface ComputeDependencyFactsInput {
  // Changed files in the diff (the detector only reads manifests/lockfiles that
  // actually changed). old_path lets a renamed/moved manifest read its BASE
  // content from the rename source instead of reporting every dep as added.
  changedFiles: Array<{ path: string; old_path?: string }>;
  readBase: (filePath: string) => string | undefined;
  readHead: (filePath: string) => string | undefined;
}

export function computeDependencyFacts(input: ComputeDependencyFactsInput): DependencyFact[] {
  const facts: DependencyFact[] = [];
  const matching = (suffix: string) => input.changedFiles.filter((file) => file.path === suffix || file.path.endsWith(`/${suffix}`));
  for (const file of matching("package.json")) {
    facts.push(...diffPackageJson(file.path, input.readBase(file.old_path ?? file.path), input.readHead(file.path)));
  }
  for (const file of matching("pnpm-lock.yaml")) {
    facts.push(...diffPnpmLock(file.path, input.readBase(file.old_path ?? file.path), input.readHead(file.path)));
  }
  for (const file of matching("package-lock.json")) {
    facts.push(...diffPackageLock(file.path, input.readBase(file.old_path ?? file.path), input.readHead(file.path)));
  }
  // Unsupported lockfiles (yarn.lock, ...) yield NO lockfile facts — never guess.
  facts.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0) || (a.kind < b.kind ? -1 : 1));
  return facts;
}

// Deterministic severity ordering for rendering/queue language (DEP_FACTS.2):
// install scripts > new dep > major bump > range loosening > the rest.
export function dependencyFactSeverityRank(kind: DependencyFactKind): number {
  switch (kind) {
    case "install_scripts":
      return 0;
    case "dependency_added":
    case "transitive_added":
      return 1;
    case "major_version_bump":
      return 2;
    case "version_range_loosened":
      return 3;
    case "dependency_removed":
    case "dependency_group_moved":
      return 4;
  }
}

function parseJsonSafe(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function depsByGroup(manifest: Record<string, unknown> | undefined): Map<string, { group: string; range: string }> {
  const result = new Map<string, { group: string; range: string }>();
  for (const group of DEP_GROUPS) {
    const deps = manifest?.[group];
    if (typeof deps !== "object" || deps === null) {
      continue;
    }
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range === "string" && !result.has(name)) {
        result.set(name, { group, range });
      }
    }
  }
  return result;
}

function majorOf(range: string): number | undefined {
  const match = range.match(/^[\^~>=\s]*v?(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function isPinned(range: string): boolean {
  return /^\d/.test(range.trim());
}

function diffPackageJson(sourcePath: string, baseText: string | undefined, headText: string | undefined): DependencyFact[] {
  const base = depsByGroup(parseJsonSafe(baseText));
  const head = depsByGroup(parseJsonSafe(headText));
  const facts: DependencyFact[] = [];
  for (const [name, headEntry] of head) {
    const baseEntry = base.get(name);
    if (!baseEntry) {
      facts.push({
        kind: "dependency_added",
        package: name,
        detail: `adds \`${name}@${headEntry.range}\` to ${headEntry.group}`,
        source_path: sourcePath
      });
      continue;
    }
    if (baseEntry.group !== headEntry.group) {
      facts.push({
        kind: "dependency_group_moved",
        package: name,
        detail: `moves \`${name}\` from ${baseEntry.group} to ${headEntry.group}`,
        source_path: sourcePath
      });
    }
    const baseMajor = majorOf(baseEntry.range);
    const headMajor = majorOf(headEntry.range);
    if (baseMajor !== undefined && headMajor !== undefined && headMajor > baseMajor) {
      facts.push({
        kind: "major_version_bump",
        package: name,
        detail: `bumps \`${name}\` ${baseEntry.range} -> ${headEntry.range} (major)`,
        source_path: sourcePath
      });
    }
    if (isPinned(baseEntry.range) && !isPinned(headEntry.range)) {
      facts.push({
        kind: "version_range_loosened",
        package: name,
        detail: `loosens \`${name}\` from pinned ${baseEntry.range} to ${headEntry.range}`,
        source_path: sourcePath
      });
    }
  }
  for (const [name, baseEntry] of base) {
    if (!head.has(name)) {
      facts.push({
        kind: "dependency_removed",
        package: name,
        detail: `removes \`${name}\` from ${baseEntry.group}`,
        source_path: sourcePath
      });
    }
  }
  return facts;
}

// pnpm-lock.yaml: compare the packages section for new entries; flag
// requiresBuild (install scripts) on NEW entries.
function diffPnpmLock(sourcePath: string, baseText: string | undefined, headText: string | undefined): DependencyFact[] {
  const basePackages = pnpmPackages(baseText);
  const headPackages = pnpmPackages(headText);
  if (!headPackages) {
    return [];
  }
  const facts: DependencyFact[] = [];
  for (const [key, entry] of headPackages) {
    if (basePackages?.has(key)) {
      continue;
    }
    const name = pnpmPackageName(key);
    facts.push({
      kind: "transitive_added",
      package: name,
      detail: `lockfile adds \`${key}\``,
      source_path: sourcePath
    });
    if (entry && typeof entry === "object" && (entry as Record<string, unknown>).requiresBuild === true) {
      facts.push({
        kind: "install_scripts",
        package: name,
        detail: `new lockfile entry \`${key}\` requires a build/install script`,
        source_path: sourcePath
      });
    }
  }
  return facts;
}

function pnpmPackages(text: string | undefined): Map<string, unknown> | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const parsed = parseYaml(text) as Record<string, unknown> | null;
    const packages = parsed?.packages;
    if (typeof packages !== "object" || packages === null) {
      return new Map();
    }
    return new Map(Object.entries(packages as Record<string, unknown>));
  } catch {
    return undefined;
  }
}

function pnpmPackageName(key: string): string {
  // Keys look like /name@1.2.3 or /@scope/name@1.2.3 (or name@1.2.3 in v9).
  const cleaned = key.replace(/^\//, "");
  const at = cleaned.lastIndexOf("@");
  return at > 0 ? cleaned.slice(0, at) : cleaned;
}

// package-lock.json (v2/v3): packages map keyed by node_modules paths; flag new
// entries and hasInstallScript.
function diffPackageLock(sourcePath: string, baseText: string | undefined, headText: string | undefined): DependencyFact[] {
  const base = parseJsonSafe(baseText)?.packages as Record<string, unknown> | undefined;
  const head = parseJsonSafe(headText)?.packages as Record<string, unknown> | undefined;
  if (!head) {
    return [];
  }
  const facts: DependencyFact[] = [];
  for (const [key, entry] of Object.entries(head)) {
    if (!key.startsWith("node_modules/") || (base && key in base)) {
      continue;
    }
    const name = key.replace(/^.*node_modules\//, "");
    facts.push({ kind: "transitive_added", package: name, detail: `lockfile adds \`${name}\``, source_path: sourcePath });
    if (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).hasInstallScript === true) {
      facts.push({
        kind: "install_scripts",
        package: name,
        detail: `new lockfile entry \`${name}\` has an install script`,
        source_path: sourcePath
      });
    }
  }
  return facts;
}
