// review-surfaces.BLAST_RADIUS.4 — XcodeGen project.yml reader (author intent).
// Bounded: it reads target name/type/sources/dependencies and declared packages
// from the common project.yml shape and ignores everything else. A file that does
// not parse as a mapping with a `targets` map is treated as "not XcodeGen" and
// yields nothing (so an unrelated project.yml is not misread).

import { parse as parseYaml } from "yaml";
import { isRecord } from "../../core/guards";
import { AppleTarget, AppleTargetKind } from "./model";

export interface XcodegenResult {
  isXcodegen: boolean;
  targets: AppleTarget[];
  // Declared SwiftPM packages: name -> raw requirement record (for Phase 4a).
  packages: Array<{ name: string; spec: Record<string, unknown> }>;
}

const TYPE_TO_KIND: Array<[RegExp, AppleTargetKind]> = [
  [/ui-test/i, "ui_test"],
  [/unit-test/i, "unit_test"],
  [/app-extension|extensionkit-extension/i, "extension"],
  [/^application/i, "application"],
  [/framework/i, "framework"],
  [/library/i, "library"]
];

function kindFromType(type: string): AppleTargetKind {
  for (const [pattern, kind] of TYPE_TO_KIND) {
    if (pattern.test(type)) {
      return kind;
    }
  }
  return "other";
}

function sourcePaths(sources: unknown, dir: string): string[] {
  const list = Array.isArray(sources) ? sources : sources === undefined ? [] : [sources];
  const paths: string[] = [];
  for (const entry of list) {
    const raw = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.path === "string" ? entry.path : undefined;
    if (raw) {
      paths.push(joinRepoPath(dir, raw));
    }
  }
  return [...new Set(paths)].sort();
}

function dependencyTargets(dependencies: unknown): string[] {
  if (!Array.isArray(dependencies)) {
    return [];
  }
  const ids: string[] = [];
  for (const dep of dependencies) {
    if (isRecord(dep) && typeof dep.target === "string") {
      ids.push(dep.target);
    }
  }
  return [...new Set(ids)].sort();
}

// project.yml lives at `dir/project.yml`; its source paths are repo-relative to dir.
function joinRepoPath(dir: string, relative: string): string {
  const clean = relative.replace(/^\.\//, "").replace(/\/$/, "");
  return dir ? `${dir}/${clean}` : clean;
}

export function parseXcodegenProject(path: string, content: string): XcodegenResult {
  const empty: XcodegenResult = { isXcodegen: false, targets: [], packages: [] };
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || !isRecord(parsed.targets)) {
    return empty;
  }
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const targets: AppleTarget[] = [];
  for (const [name, raw] of Object.entries(parsed.targets)) {
    if (!isRecord(raw)) {
      continue;
    }
    const type = typeof raw.type === "string" ? raw.type : "";
    targets.push({
      id: name,
      name,
      kind: kindFromType(type),
      source_paths: sourcePaths(raw.sources, dir),
      dependency_target_ids: dependencyTargets(raw.dependencies),
      provenance: ["xcodegen"]
    });
  }
  targets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const packages: XcodegenResult["packages"] = [];
  if (isRecord(parsed.packages)) {
    for (const [name, spec] of Object.entries(parsed.packages)) {
      if (isRecord(spec)) {
        packages.push({ name, spec });
      }
    }
    packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  return { isXcodegen: true, targets, packages };
}
