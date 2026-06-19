// review-surfaces.BLAST_RADIUS.4 — bounded Package.swift target reader. Package
// manifests are Swift CODE; we do NOT execute them (goal contract D2). We scan the
// comment-stripped source for `.target` / `.testTarget` / `.executableTarget`
// declarations and read their `name:` and optional `path:`. Source roots follow
// the SwiftPM convention (Sources/<name>, Tests/<name>) when no explicit path is
// given. Anything we cannot read produces no target rather than a guess.

import { cleanSwiftSource } from "../../risks/swift-lexer";
import { AppleTarget, AppleTargetKind, normalizeRepoRelativePath } from "./model";

export interface SwiftPackageResult {
  targets: AppleTarget[];
}

const TARGET_CALL = /\.(testTarget|executableTarget|target|macro|plugin|systemLibraryTarget)\s*\(/g;

function kindForCall(call: string): AppleTargetKind {
  if (call === "testTarget") {
    return "unit_test";
  }
  if (call === "executableTarget") {
    return "application";
  }
  if (call === "plugin" || call === "macro") {
    return "other";
  }
  return "library";
}

// Balanced-paren slice starting at the `(` index.
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

// Join a manifest-relative path to the package dir and normalize `.`/`..`/`//` so an
// explicit `path: "../Shared"` matches the git-normalized tracked path (and an absolute
// or repo-escaping path is dropped rather than persisted).
function repoJoin(dir: string, relative: string): string | undefined {
  return normalizeRepoRelativePath(dir ? `${dir}/${relative}` : relative);
}

export function parseSwiftPackage(path: string, content: string): SwiftPackageResult {
  // Keep string literals (target names live in them) but drop comments so a
  // commented-out `.target(...)` is ignored.
  const source = cleanSwiftSource(content, { keepStrings: true });
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const targets: AppleTarget[] = [];
  TARGET_CALL.lastIndex = 0;
  // A `.target(name: "Core")` nested inside another target's `dependencies:` list is a
  // DEPENDENCY reference, not a target declaration. matchAll runs in source order, so a
  // call whose start falls within the previous target's argument span is nested — skip
  // it (the dependency name is still captured by bareDependencyTargets).
  let consumedUntil = -1;
  for (const match of source.matchAll(TARGET_CALL)) {
    const startIdx = match.index ?? 0;
    if (startIdx < consumedUntil) {
      continue;
    }
    const call = match[1];
    const openParen = startIdx + match[0].length - 1;
    const args = balancedArgs(source, openParen);
    if (args === undefined) {
      continue;
    }
    consumedUntil = openParen + 1 + args.length + 1;
    const name = /name:\s*"([^"]+)"/.exec(args)?.[1];
    if (!name) {
      continue;
    }
    const explicitPath = /\bpath:\s*"([^"]+)"/.exec(args)?.[1];
    const kind = kindForCall(call);
    const defaultRoot = kind === "unit_test" ? `Tests/${name}` : `Sources/${name}`;
    const root = repoJoin(dir, explicitPath ?? defaultRoot);
    targets.push({
      id: name,
      name,
      kind,
      source_paths: root ? [root] : [],
      dependency_target_ids: bareDependencyTargets(args),
      provenance: ["swiftpm"]
    });
  }
  targets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { targets };
}

// Bare-string dependencies inside a `dependencies: [ ... ]` list (sibling target
// names). `.product(...)` / `.package(...)` package deps are out of scope here.
function bareDependencyTargets(args: string): string[] {
  const depsMatch = /dependencies:\s*\[([^\]]*)\]/.exec(args);
  if (!depsMatch) {
    return [];
  }
  const ids = [...depsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(ids)].sort();
}
