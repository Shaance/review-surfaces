// review-surfaces.DEP_FACTS.6 — deterministic SwiftPM/Xcode package facts. Compares
// DIRECT package requirements (Package.swift, XcodeGen project.yml packages,
// pbxproj XCRemoteSwiftPackageReference) and RESOLVED pins (Package.resolved
// v2/v3), without executing manifests or guessing transitive attribution. Reuses
// the DependencyFact shape + supply_chain lens. A benign originHash-only rewrite,
// or formatting/key-order churn, produces no fact (goal contract noise controls).

import { isRecord } from "../core/guards";
import { cleanSwiftSource } from "./swift-lexer";
import { parsePbxproj } from "../collector/apple-project/pbxproj";
import { DependencyFact } from "./dependency-facts";

export interface ComputeSwiftPackageFactsInput {
  changedFiles: Array<{ path: string; old_path?: string }>;
  readBase: (filePath: string) => string | undefined;
  readHead: (filePath: string) => string | undefined;
}

// A direct package requirement, normalized for diffing.
interface Requirement {
  // version-range kinds carry a version; moving kinds (branch/revision/local) do not.
  kind: "from" | "exact" | "range" | "upToNextMajor" | "upToNextMinor" | "branch" | "revision" | "local" | "unknown";
  value: string;
}

function describeRequirement(req: Requirement): string {
  switch (req.kind) {
    case "from":
    case "upToNextMajor":
      return `from ${req.value}`;
    case "upToNextMinor":
      return `up to next minor from ${req.value}`;
    case "exact":
      return `exact ${req.value}`;
    case "range":
      return `range ${req.value}`;
    case "branch":
      return `branch ${req.value}`;
    case "revision":
      return `revision ${req.value}`;
    case "local":
      return `local path ${req.value}`;
    default:
      return req.value || "unspecified";
  }
}

const PINNED_KINDS = new Set<Requirement["kind"]>(["from", "exact", "range", "upToNextMajor", "upToNextMinor"]);
const MOVING_KINDS = new Set<Requirement["kind"]>(["branch", "revision", "local"]);

function majorOf(version: string): string | undefined {
  const match = /(\d+)\./.exec(version) ?? /^(\d+)$/.exec(version);
  return match?.[1];
}

// --- Package.swift direct packages ------------------------------------------

function balancedArgs(source: string, openParen: number): string | undefined {
  let depth = 0;
  for (let i = openParen; i < source.length; i += 1) {
    if (source[i] === "(") {
      depth += 1;
    } else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openParen + 1, i);
      }
    }
  }
  return undefined;
}

function requirementFromArgs(args: string): Requirement {
  const exact = /(?:exact:\s*"([^"]+)"|\.exact\(\s*"([^"]+)"\s*\))/.exec(args);
  if (exact) {
    return { kind: "exact", value: exact[1] ?? exact[2] };
  }
  const branch = /(?:branch:\s*"([^"]+)"|\.branch\(\s*"([^"]+)"\s*\))/.exec(args);
  if (branch) {
    return { kind: "branch", value: branch[1] ?? branch[2] };
  }
  const revision = /(?:revision:\s*"([^"]+)"|\.revision\(\s*"([^"]+)"\s*\))/.exec(args);
  if (revision) {
    return { kind: "revision", value: revision[1] ?? revision[2] };
  }
  const upToMinor = /\.upToNextMinor\(\s*from:\s*"([^"]+)"\s*\)/.exec(args);
  if (upToMinor) {
    return { kind: "upToNextMinor", value: upToMinor[1] };
  }
  const upToMajor = /\.upToNextMajor\(\s*from:\s*"([^"]+)"\s*\)/.exec(args);
  if (upToMajor) {
    // `.upToNextMajor(from: X)` is EXACTLY SwiftPM's `from: X` shorthand — normalize to
    // the same kind so a pure syntax rewrite between the two forms is not a false change.
    return { kind: "from", value: upToMajor[1] };
  }
  const range = /"([0-9][^"]*)"\s*\.\.[.<]\s*"([0-9][^"]*)"/.exec(args);
  if (range) {
    return { kind: "range", value: `${range[1]}..<${range[2]}` };
  }
  const from = /\bfrom:\s*"([^"]+)"/.exec(args);
  if (from) {
    return { kind: "from", value: from[1] };
  }
  return { kind: "unknown", value: "" };
}

// identity (url or local path) -> requirement, from Package.swift `.package(...)`.
function parsePackageSwift(content: string): Map<string, Requirement> {
  const source = cleanSwiftSource(content, { keepStrings: true });
  const result = new Map<string, Requirement>();
  for (const match of source.matchAll(/\.package\s*\(/g)) {
    const args = balancedArgs(source, (match.index ?? 0) + match[0].length - 1);
    if (args === undefined) {
      continue;
    }
    const localPath = /\bpath:\s*"([^"]+)"/.exec(args)?.[1];
    if (localPath) {
      result.set(normalizeIdentity(localPath), { kind: "local", value: localPath });
      continue;
    }
    const url = /\burl:\s*"([^"]+)"/.exec(args)?.[1];
    if (!url) {
      continue;
    }
    result.set(normalizeIdentity(url), requirementFromArgs(args));
  }
  return result;
}

// XcodeGen project.yml `packages:` map -> identity -> requirement.
function parseXcodegenPackages(content: string): Map<string, Requirement> {
  // Bounded line scan rather than a full YAML load: read each package's url/from/
  // exact/branch/revision under the top-level `packages:` block.
  const result = new Map<string, Requirement>();
  const lines = content.split("\n");
  let inPackages = false;
  let baseIndent = 0;
  let currentUrl: string | undefined;
  let currentReq: Requirement | undefined;
  const flush = (): void => {
    if (currentUrl) {
      result.set(normalizeIdentity(currentUrl), currentReq ?? { kind: "unknown", value: "" });
    }
    currentUrl = undefined;
    currentReq = undefined;
  };
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      baseIndent = 0;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    if (/^\S/.test(line)) {
      // A new top-level key ends the packages block.
      flush();
      inPackages = false;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const keyMatch = /^(\s*)([A-Za-z0-9_.-]+):/.exec(line);
    if (keyMatch && (baseIndent === 0 || indent <= baseIndent)) {
      // A package entry header (e.g. "  SomeLib:").
      baseIndent = indent;
      flush();
      continue;
    }
    const url = /\b(?:url|github):\s*"?([^"\s]+)"?/.exec(line)?.[1];
    if (url) {
      currentUrl = url.startsWith("http") || url.includes("/") ? url : `https://github.com/${url}`;
    }
    // A LOCAL package (`path: ../Foo`) has no url — use its path as the identity so an
    // added/changed local dependency still produces a fact.
    const localPath = /\bpath:\s*"?([^"\s]+)"?/.exec(line)?.[1];
    if (localPath && !currentUrl) {
      currentUrl = localPath;
    }
    const from = /\bfrom:\s*"?([0-9][^"\s]*)"?/.exec(line)?.[1];
    if (from) {
      currentReq = { kind: "from", value: from };
    }
    // XcodeGen `majorVersion: X` == SwiftPM `.upToNextMajor(from: X)` == `from: X`;
    // `minorVersion: X` == `.upToNextMinor(from: X)`.
    const majorVersion = /\bmajorVersion:\s*"?([0-9][^"\s]*)"?/.exec(line)?.[1];
    if (majorVersion) {
      currentReq = { kind: "from", value: majorVersion };
    }
    const minorVersion = /\bminorVersion:\s*"?([0-9][^"\s]*)"?/.exec(line)?.[1];
    if (minorVersion) {
      currentReq = { kind: "upToNextMinor", value: minorVersion };
    }
    const exact = /\b(?:exactVersion|exact):\s*"?([0-9][^"\s]*)"?/.exec(line)?.[1];
    if (exact) {
      currentReq = { kind: "exact", value: exact };
    }
    const branch = /\bbranch:\s*"?([^"\s]+)"?/.exec(line)?.[1];
    if (branch) {
      currentReq = { kind: "branch", value: branch };
    }
    const revision = /\brevision:\s*"?([^"\s]+)"?/.exec(line)?.[1];
    if (revision) {
      currentReq = { kind: "revision", value: revision };
    }
  }
  flush();
  return result;
}

// pbxproj XCRemoteSwiftPackageReference -> identity -> requirement.
function parsePbxPackages(path: string, content: string): Map<string, Requirement> {
  const result = new Map<string, Requirement>();
  const parsed = parsePbxproj(path, content);
  for (const pkg of parsed.remote_packages) {
    const requirement = pkg.requirement;
    const kindStr = typeof requirement.kind === "string" ? requirement.kind : "";
    let req: Requirement = { kind: "unknown", value: "" };
    const minVersion = typeof requirement.minimumVersion === "string" ? requirement.minimumVersion : undefined;
    const exactVersion = typeof requirement.version === "string" ? requirement.version : undefined;
    const branch = typeof requirement.branch === "string" ? requirement.branch : undefined;
    const revision = typeof requirement.revision === "string" ? requirement.revision : undefined;
    if (kindStr === "exactVersion" && exactVersion) {
      req = { kind: "exact", value: exactVersion };
    } else if (kindStr === "branch" && branch) {
      req = { kind: "branch", value: branch };
    } else if (kindStr === "revision" && revision) {
      req = { kind: "revision", value: revision };
    } else if (minVersion) {
      req = { kind: kindStr === "upToNextMinorVersion" ? "upToNextMinor" : "from", value: minVersion };
    }
    result.set(normalizeIdentity(pkg.url), req);
  }
  return result;
}

function normalizeIdentity(urlOrPath: string): string {
  return urlOrPath.trim().replace(/\.git$/, "").replace(/\/+$/, "");
}

// --- Package.resolved pins (v2/v3) ------------------------------------------

interface Pin {
  version?: string;
  revision?: string;
  location?: string;
}

function parsePackageResolved(content: string): Map<string, Pin> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  // v1: object.pins; v2/v3: top-level pins array.
  const pinsArray = Array.isArray(parsed.pins)
    ? parsed.pins
    : isRecord(parsed.object) && Array.isArray(parsed.object.pins)
      ? parsed.object.pins
      : [];
  const result = new Map<string, Pin>();
  for (const entry of pinsArray) {
    if (!isRecord(entry)) {
      continue;
    }
    const identity = typeof entry.identity === "string" ? entry.identity : typeof entry.package === "string" ? entry.package : undefined;
    if (!identity) {
      continue;
    }
    const state = isRecord(entry.state) ? entry.state : {};
    result.set(identity, {
      version: typeof state.version === "string" ? state.version : undefined,
      revision: typeof state.revision === "string" ? state.revision : undefined,
      location: typeof entry.location === "string" ? entry.location : typeof entry.repositoryURL === "string" ? entry.repositoryURL : undefined
    });
  }
  return result;
}

// --- diffs ------------------------------------------------------------------

function diffDirect(sourcePath: string, base: Map<string, Requirement>, head: Map<string, Requirement>): DependencyFact[] {
  const facts: DependencyFact[] = [];
  for (const identity of new Set([...base.keys(), ...head.keys()])) {
    const b = base.get(identity);
    const h = head.get(identity);
    if (!b && h) {
      facts.push({ kind: "swift_package_added", package: identity, detail: `Swift package added: \`${identity}\` (${describeRequirement(h)}).`, source_path: sourcePath });
      continue;
    }
    if (b && !h) {
      facts.push({ kind: "swift_package_removed", package: identity, detail: `Swift package removed: \`${identity}\`.`, source_path: sourcePath });
      continue;
    }
    if (!b || !h) {
      continue;
    }
    if (b.kind === h.kind && b.value === h.value) {
      continue;
    }
    // A pinned requirement becoming a moving ref (branch/revision/local) is the
    // highest-risk loosening.
    if (PINNED_KINDS.has(b.kind) && MOVING_KINDS.has(h.kind)) {
      facts.push({
        kind: "swift_package_requirement_loosened",
        package: identity,
        detail: `Swift package \`${identity}\` requirement loosened: ${describeRequirement(b)} → ${describeRequirement(h)}.`,
        source_path: sourcePath
      });
      continue;
    }
    // A semantic major-version change (either direction) on version requirements.
    const baseMajor = majorOf(b.value);
    const headMajor = majorOf(h.value);
    if (baseMajor && headMajor && baseMajor !== headMajor && PINNED_KINDS.has(b.kind) && PINNED_KINDS.has(h.kind)) {
      facts.push({
        kind: "swift_package_major_change",
        package: identity,
        detail: `Swift package \`${identity}\` major version ${baseMajor} → ${headMajor} (${describeRequirement(b)} → ${describeRequirement(h)}).`,
        source_path: sourcePath
      });
      continue;
    }
    facts.push({
      kind: "swift_package_changed",
      package: identity,
      detail: `Swift package \`${identity}\` requirement changed: ${describeRequirement(b)} → ${describeRequirement(h)}.`,
      source_path: sourcePath
    });
  }
  return facts;
}

function diffResolved(sourcePath: string, base: Map<string, Pin>, head: Map<string, Pin>): DependencyFact[] {
  const facts: DependencyFact[] = [];
  for (const identity of new Set([...base.keys(), ...head.keys()])) {
    const b = base.get(identity);
    const h = head.get(identity);
    if (!b && h) {
      facts.push({ kind: "swift_package_pin_changed", package: identity, detail: `Resolved pin added: \`${identity}\`${h.version ? ` @ ${h.version}` : h.revision ? ` @ ${h.revision.slice(0, 8)}` : ""}.`, source_path: sourcePath });
      continue;
    }
    if (b && !h) {
      facts.push({ kind: "swift_package_pin_changed", package: identity, detail: `Resolved pin removed: \`${identity}\`.`, source_path: sourcePath });
      continue;
    }
    if (!b || !h) {
      continue;
    }
    // An originHash-only rewrite (identical version+revision+location) is NO fact.
    if (b.version === h.version && b.revision === h.revision && b.location === h.location) {
      continue;
    }
    const parts: string[] = [];
    if (b.version !== h.version) {
      parts.push(`version ${b.version ?? "none"} → ${h.version ?? "none"}`);
    }
    if (b.revision !== h.revision) {
      parts.push(`revision ${(b.revision ?? "none").slice(0, 8)} → ${(h.revision ?? "none").slice(0, 8)}`);
    }
    if (b.location !== h.location) {
      parts.push(`location changed`);
    }
    facts.push({ kind: "swift_package_pin_changed", package: identity, detail: `Resolved pin \`${identity}\` ${parts.join(", ")}.`, source_path: sourcePath });
  }
  return facts;
}

export function computeSwiftPackageFacts(input: ComputeSwiftPackageFactsInput): DependencyFact[] {
  const facts: DependencyFact[] = [];
  const base = (file: { path: string; old_path?: string }): string | undefined => input.readBase(file.old_path ?? file.path);
  const head = (file: { path: string; old_path?: string }): string | undefined => input.readHead(file.path);
  const match = (predicate: (path: string) => boolean) => input.changedFiles.filter((file) => predicate(file.path));

  for (const file of match((p) => p === "Package.swift" || p.endsWith("/Package.swift"))) {
    const b = base(file);
    const h = head(file);
    facts.push(...diffDirect(file.path, b ? parsePackageSwift(b) : new Map(), h ? parsePackageSwift(h) : new Map()));
  }
  for (const file of match((p) => /(^|\/)project\.ya?ml$/.test(p))) {
    const b = base(file);
    const h = head(file);
    facts.push(...diffDirect(file.path, b ? parseXcodegenPackages(b) : new Map(), h ? parseXcodegenPackages(h) : new Map()));
  }
  for (const file of match((p) => p.endsWith(".xcodeproj/project.pbxproj"))) {
    const b = base(file);
    const h = head(file);
    facts.push(...diffDirect(file.path, b ? parsePbxPackages(file.path, b) : new Map(), h ? parsePbxPackages(file.path, h) : new Map()));
  }
  for (const file of match((p) => p === "Package.resolved" || p.endsWith("/Package.resolved"))) {
    const b = base(file);
    const h = head(file);
    const basePins = b ? parsePackageResolved(b) : undefined;
    const headPins = h ? parsePackageResolved(h) : undefined;
    if (basePins !== undefined || headPins !== undefined) {
      facts.push(...diffResolved(file.path, basePins ?? new Map(), headPins ?? new Map()));
    }
  }
  facts.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.source_path < b.source_path ? -1 : 1));
  return facts;
}
