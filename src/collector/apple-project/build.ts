// review-surfaces.BLAST_RADIUS.4 — assemble ONE Apple project model from every
// source present (XcodeGen project.yml, Package.swift, *.xcodeproj/project.pbxproj,
// *.xcscheme, *.xctestplan), merging targets by name WITH provenance. A target
// XcodeGen declares (author intent) but the generated .xcodeproj does not observe
// (or vice versa) becomes a possible-drift diagnostic, never an invented certainty
// (goal contract D4). Pure over the injected reader.

import { compareStrings } from "../../core/compare";
import {
  AppleProjectModel,
  AppleProjectSource,
  AppleScheme,
  AppleTarget,
  AppleProjectDiagnostic,
  AppleTestPlan,
  emptyAppleProjectModel,
  hasAppleProjectInputs
} from "./model";
import { parsePbxproj } from "./pbxproj";
import { parseScheme } from "./scheme";
import { parseSwiftPackage } from "./swiftpm";
import { parseTestPlan } from "./test-plan";
import { parseXcodegenProject } from "./xcodegen";

const DEFAULT_PROJECT_FILE_CAP = 200;

// A file the project-model parser actually consumes (XcodeGen spec, SwiftPM manifest,
// the .pbxproj, a shared scheme, or a test plan). Filtering to these before the cap
// keeps the cap meaningful on large repos.
function isAppleProjectModelInput(file: string): boolean {
  return (
    /(^|\/)project\.ya?ml$/.test(file) ||
    /(^|\/)Package\.swift$/.test(file) ||
    /\.xcodeproj\/project\.pbxproj$/.test(file) ||
    (/\.xcscheme$/.test(file) && /xcshareddata\//.test(file)) ||
    /\.xctestplan$/.test(file)
  );
}

export interface BuildAppleProjectOptions {
  files: string[];
  read: (filePath: string) => string | undefined;
  fileCap?: number;
}

export function buildAppleProjectModel(options: BuildAppleProjectOptions): AppleProjectModel {
  if (!hasAppleProjectInputs(options.files)) {
    return emptyAppleProjectModel();
  }
  const cap = options.fileCap ?? DEFAULT_PROJECT_FILE_CAP;
  const model = emptyAppleProjectModel();
  const projects: AppleProjectSource[] = [];
  const diagnostics: AppleProjectDiagnostic[] = [];
  const schemes: AppleScheme[] = [];
  const testPlans: AppleTestPlan[] = [];
  // name -> merged target.
  const targetsByName = new Map<string, AppleTarget>();
  const xcodegenTargetNames = new Set<string>();
  const pbxprojTargetNames = new Set<string>();

  const mergeTarget = (target: AppleTarget): void => {
    const existing = targetsByName.get(target.name);
    if (!existing) {
      targetsByName.set(target.name, {
        ...target,
        source_paths: [...new Set(target.source_paths)].sort(compareStrings),
        dependency_target_ids: [...new Set(target.dependency_target_ids)].sort(compareStrings),
        provenance: [...new Set(target.provenance)].sort()
      });
      return;
    }
    existing.source_paths = [...new Set([...existing.source_paths, ...target.source_paths])].sort(compareStrings);
    existing.dependency_target_ids = [...new Set([...existing.dependency_target_ids, ...target.dependency_target_ids])].sort(compareStrings);
    existing.provenance = [...new Set([...existing.provenance, ...target.provenance])].sort() as AppleTarget["provenance"];
    // Prefer a concrete kind over "other".
    if (existing.kind === "other" && target.kind !== "other") {
      existing.kind = target.kind;
    }
  };

  // Filter to project-MODEL inputs BEFORE the cap, so a large `Sources/...` tree that
  // sorts ahead of `project.yml` cannot slice the actual Apple inputs out of range.
  const candidates = options.files.filter(isAppleProjectModelInput).sort(compareStrings);
  const sorted = candidates.slice(0, cap);
  let truncated = candidates.length > cap;

  for (const file of sorted) {
    const read = (): string | undefined => options.read(file);
    if (/(^|\/)project\.ya?ml$/.test(file)) {
      const content = read();
      if (content === undefined) {
        continue;
      }
      const result = parseXcodegenProject(file, content);
      if (result.isXcodegen) {
        projects.push({ path: file, provenance: "xcodegen" });
        for (const target of result.targets) {
          xcodegenTargetNames.add(target.name);
          mergeTarget(target);
        }
      }
    } else if (/(^|\/)Package\.swift$/.test(file)) {
      const content = read();
      if (content === undefined) {
        continue;
      }
      const result = parseSwiftPackage(file, content);
      projects.push({ path: file, provenance: "swiftpm" });
      // A manifest present but yielding NO literal targets (names built from constants,
      // a helper returning the array, etc.) means target membership is UNKNOWN — mark the
      // model partial so the Swift graph reports "unknown", not a false complete model.
      if (result.targets.length === 0) {
        diagnostics.push({ kind: "unparsed_section", path: file, detail: "Package.swift has no statically-recoverable targets; target membership is unknown for this package." });
        truncated = true;
      }
      for (const target of result.targets) {
        mergeTarget(target);
      }
    } else if (/\.xcodeproj\/project\.pbxproj$/.test(file)) {
      const content = read();
      if (content === undefined) {
        continue;
      }
      const result = parsePbxproj(file, content);
      if (result.parsed) {
        projects.push({ path: file, provenance: "pbxproj" });
        for (const target of result.targets) {
          pbxprojTargetNames.add(target.name);
          mergeTarget(target);
        }
      } else {
        diagnostics.push({ kind: "unparsed_section", path: file, detail: "project.pbxproj could not be parsed; target membership is unknown for this project." });
        truncated = true;
      }
    } else if (/\.xcscheme$/.test(file) && /xcshareddata\//.test(file)) {
      const content = read();
      if (content !== undefined) {
        schemes.push(parseScheme(file, content));
      }
    } else if (/\.xctestplan$/.test(file)) {
      const content = read();
      if (content !== undefined) {
        testPlans.push(parseTestPlan(file, content));
      }
    }
  }

  // Possible XcodeGen-vs-generated drift: a target in one source set but not the
  // other (only meaningful when BOTH sources are present). Advisory, never a block.
  if (xcodegenTargetNames.size > 0 && pbxprojTargetNames.size > 0) {
    for (const name of [...xcodegenTargetNames].sort()) {
      if (!pbxprojTargetNames.has(name)) {
        diagnostics.push({ kind: "possible_drift", path: "project.yml", detail: `Target "${name}" is declared in project.yml but not observed in the generated .xcodeproj; run the repository drift check.` });
      }
    }
    for (const name of [...pbxprojTargetNames].sort()) {
      if (!xcodegenTargetNames.has(name)) {
        diagnostics.push({ kind: "possible_drift", path: "project.pbxproj", detail: `Target "${name}" is observed in the generated .xcodeproj but not declared in project.yml; run the repository drift check.` });
      }
    }
  }

  model.projects = projects.sort((a, b) => compareStrings(a.path, b.path));
  model.targets = [...targetsByName.values()].sort((a, b) => compareStrings(a.name, b.name));
  model.schemes = schemes.sort((a, b) => compareStrings(a.name, b.name));
  model.test_plans = testPlans.sort((a, b) => compareStrings(a.path, b.path));
  model.diagnostics = diagnostics.sort((a, b) => compareStrings(`${a.kind}:${a.path}:${a.detail}`, `${b.kind}:${b.path}:${b.detail}`));
  model.truncated = truncated;
  return model;
}
