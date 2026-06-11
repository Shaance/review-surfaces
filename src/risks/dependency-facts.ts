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
  // review-surfaces.DEP_FACTS.4: the DIRECT dependency that pulled this new
  // transitive, attributed by walking the lockfile's dependency edges from the
  // head manifest's direct dependencies. Absent when the edges could not be
  // resolved — the render then falls back to the honest flat grouping, never a
  // guessed attribution.
  via?: string;
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
  // review-surfaces.DEP_FACTS.4: attribute each new transitive to the direct
  // dependency that pulled it by walking the head lockfile's dependency edges.
  attributeTransitives(facts, input);
  facts.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0) || (a.kind < b.kind ? -1 : 1));
  return facts;
}

// review-surfaces.DEP_FACTS.4: attribute each new transitive by walking the
// head lockfile's dependency edges at INSTANCE level (versioned pnpm keys /
// nested node_modules paths), so two versions of the same intermediate package
// never collapse into one node and misattribute a transitive. Direct roots come
// from the lockfile's importers/workspace manifests when present (monorepos),
// falling back to the lockfile's sibling head package.json. Roots are walked in
// alphabetical order, so attribution is deterministic when several direct deps
// reach the same package. Anything unresolvable stays unattributed — the flat
// fallback, never a guess.
interface LockGraph {
  // instance key -> dependency instance keys (ambiguous targets are dropped).
  edges: Map<string, Set<string>>;
  // package name -> instance keys.
  instancesByName: Map<string, Set<string>>;
  // direct dependency names from importers/workspace manifest entries.
  directNames: Set<string>;
  nameOf: (instanceKey: string) => string;
}

function attributeTransitives(facts: DependencyFact[], input: ComputeDependencyFactsInput): void {
  const targets = facts.filter((fact) => fact.kind === "transitive_added" && fact.via === undefined);
  if (targets.length === 0) {
    return;
  }
  const bySource = new Map<string, DependencyFact[]>();
  for (const fact of targets) {
    const list = bySource.get(fact.source_path) ?? [];
    list.push(fact);
    bySource.set(fact.source_path, list);
  }
  for (const [sourcePath, sourceFacts] of bySource) {
    const headText = input.readHead(sourcePath);
    const graph = sourcePath.endsWith("pnpm-lock.yaml") ? pnpmLockGraph(headText) : packageLockGraph(headText);
    if (!graph) {
      continue;
    }
    // Direct roots: lockfile importers/workspace manifests first (monorepos),
    // plus the lockfile's sibling head package.json.
    const manifestPath = sourcePath.replace(/[^/]+$/, "package.json");
    const manifest = parseJsonSafe(input.readHead(manifestPath));
    const direct = [...new Set([...graph.directNames, ...depsByGroup(manifest).keys()])].sort();
    if (direct.length === 0) {
      continue;
    }
    // Reachability over instances: the first (alphabetical) direct dep that
    // reaches ANY instance of a package attributes that package.
    const viaByPackage = new Map<string, string>();
    for (const root of direct) {
      const rootInstances = [...(graph.instancesByName.get(root) ?? [])].sort();
      const queue = [...rootInstances];
      const seen = new Set<string>(rootInstances);
      while (queue.length > 0) {
        const instance = queue.shift() as string;
        const name = graph.nameOf(instance);
        if (!viaByPackage.has(name)) {
          viaByPackage.set(name, root);
        }
        for (const next of [...(graph.edges.get(instance) ?? [])].sort()) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
    }
    for (const fact of sourceFacts) {
      const via = viaByPackage.get(fact.package);
      // Self-attribution is meaningless: a direct dep "pulled by itself" stays flat.
      if (via && via !== fact.package) {
        fact.via = via;
      }
    }
  }
}

// pnpm-lock.yaml instance graph. pnpm v9 records dependency edges under
// `snapshots:` (packages: holds resolution/metadata only); older formats carry
// `dependencies` on packages: entries — read both. Dependency targets resolve
// to the versioned key `name@version`; when that exact key is absent the edge
// resolves only if the name is unambiguous (one instance), else it is dropped.
// Direct roots come from the `importers:` section (workspace-aware).
function pnpmLockGraph(text: string | undefined): LockGraph | undefined {
  if (!text) {
    return undefined;
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = parseYaml(text) as Record<string, unknown> | null;
  } catch {
    return undefined;
  }
  const sections = [parsed?.packages, parsed?.snapshots].filter(
    (section): section is Record<string, unknown> => typeof section === "object" && section !== null
  );
  if (sections.length === 0) {
    return undefined;
  }
  const instancesByName = new Map<string, Set<string>>();
  const allKeys = new Set<string>();
  for (const section of sections) {
    for (const key of Object.keys(section)) {
      allKeys.add(key);
      const name = pnpmPackageName(key);
      const instances = instancesByName.get(name) ?? new Set<string>();
      instances.add(key);
      instancesByName.set(name, instances);
    }
  }
  const resolveTarget = (depName: string, version: unknown): string | undefined => {
    if (typeof version === "string") {
      // Snapshot versions may carry a peer suffix: 1.2.3(peer@2.0.0).
      for (const candidate of [`${depName}@${version}`, `/${depName}@${version}`]) {
        if (allKeys.has(candidate)) {
          return candidate;
        }
      }
    }
    const instances = instancesByName.get(depName);
    return instances && instances.size === 1 ? [...instances][0] : undefined;
  };
  const edges = new Map<string, Set<string>>();
  for (const section of sections) {
    for (const [key, entry] of Object.entries(section)) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const deps = (entry as Record<string, unknown>).dependencies;
      if (typeof deps !== "object" || deps === null) {
        continue;
      }
      const targets = edges.get(key) ?? new Set<string>();
      for (const [depName, version] of Object.entries(deps as Record<string, unknown>)) {
        const target = resolveTarget(depName, version);
        if (target) {
          targets.add(target);
        }
      }
      edges.set(key, targets);
    }
  }
  if (edges.size === 0) {
    return undefined;
  }
  const directNames = new Set<string>();
  const importers = parsed?.importers;
  if (typeof importers === "object" && importers !== null) {
    for (const importer of Object.values(importers as Record<string, unknown>)) {
      if (typeof importer !== "object" || importer === null) {
        continue;
      }
      for (const group of DEP_GROUPS) {
        const deps = (importer as Record<string, unknown>)[group];
        if (typeof deps === "object" && deps !== null) {
          for (const name of Object.keys(deps as Record<string, unknown>)) {
            directNames.add(name);
          }
        }
      }
    }
  }
  return { edges, instancesByName, directNames, nameOf: pnpmPackageName };
}

// package-lock.json v2/v3 instance graph: instance keys are the nested
// node_modules paths, and a dependency resolves like Node does — the nearest
// enclosing scope that contains node_modules/<name>. Workspace manifest
// entries (keys NOT under node_modules, including the "" root) contribute the
// direct root names.
function packageLockGraph(text: string | undefined): LockGraph | undefined {
  const packages = parseJsonSafe(text)?.packages as Record<string, unknown> | undefined;
  if (!packages) {
    return undefined;
  }
  const keys = new Set(Object.keys(packages));
  const nameOf = (key: string): string => key.replace(/^.*node_modules\//, "");
  const instancesByName = new Map<string, Set<string>>();
  for (const key of keys) {
    if (!key.includes("node_modules/")) {
      continue;
    }
    const name = nameOf(key);
    const instances = instancesByName.get(name) ?? new Set<string>();
    instances.add(key);
    instancesByName.set(name, instances);
  }
  const resolveFrom = (fromKey: string, depName: string): string | undefined => {
    // Walk Node's resolution scopes: <scope>/node_modules/<dep>, where scope
    // peels one node_modules level at a time down to the root.
    let scope = fromKey;
    for (;;) {
      const candidate = scope === "" ? `node_modules/${depName}` : `${scope}/node_modules/${depName}`;
      if (keys.has(candidate)) {
        return candidate;
      }
      const cut = scope.lastIndexOf("/node_modules/");
      if (cut < 0) {
        return keys.has(`node_modules/${depName}`) ? `node_modules/${depName}` : undefined;
      }
      scope = scope.slice(0, cut);
    }
  };
  const edges = new Map<string, Set<string>>();
  const directNames = new Set<string>();
  for (const [key, entry] of Object.entries(packages)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    if (!key.includes("node_modules/")) {
      // Workspace manifest entry (incl. the "" root): direct dependency names.
      for (const group of DEP_GROUPS) {
        const deps = (entry as Record<string, unknown>)[group];
        if (typeof deps === "object" && deps !== null) {
          for (const name of Object.keys(deps as Record<string, unknown>)) {
            directNames.add(name);
          }
        }
      }
      continue;
    }
    const deps = (entry as Record<string, unknown>).dependencies;
    if (typeof deps !== "object" || deps === null) {
      continue;
    }
    const targets = edges.get(key) ?? new Set<string>();
    for (const depName of Object.keys(deps as Record<string, unknown>)) {
      const target = resolveFrom(key, depName);
      if (target) {
        targets.add(target);
      }
    }
    edges.set(key, targets);
  }
  if (edges.size === 0) {
    return undefined;
  }
  return { edges, instancesByName, directNames, nameOf };
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
  // Keys look like /name@1.2.3, /@scope/name@1.2.3, or v9 name@1.2.3 with an
  // optional peer suffix: name@1.2.3(peer@2.0.0). Strip the peer suffix BEFORE
  // locating the version separator, or scoped+peer keys slice mid-name.
  const cleaned = key.replace(/^\//, "").replace(/\(.*$/, "");
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
