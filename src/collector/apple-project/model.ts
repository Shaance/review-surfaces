// review-surfaces.BLAST_RADIUS.4 — the internal Apple project model. One model is
// assembled with PROVENANCE from whatever sources the repository contains
// (XcodeGen project.yml, Package.swift, *.xcodeproj/project.pbxproj, *.xcscheme,
// *.xctestplan). Disagreements between author intent (project.yml) and observed
// output (the generated .xcodeproj) become diagnostics, never invented certainty
// (goal contract D4/D10). All lists are sorted for byte-stable output.

export type AppleTargetKind =
  | "application"
  | "framework"
  | "library"
  | "unit_test"
  | "ui_test"
  | "extension"
  | "other";

export type AppleProvenance = "xcodegen" | "swiftpm" | "pbxproj";

export interface AppleTarget {
  id: string;
  name: string;
  kind: AppleTargetKind;
  // Repo-relative source file paths (or source roots) attributed to this target.
  source_paths: string[];
  // Target names this target depends on (best-effort, by name).
  dependency_target_ids: string[];
  provenance: AppleProvenance[];
}

export interface AppleScheme {
  name: string;
  // Target names referenced by the scheme's test action.
  test_target_ids: string[];
  // Referenced .xctestplan paths (repo-relative), if any.
  test_plan_paths: string[];
  provenance: AppleProvenance[];
}

export interface AppleTestPlan {
  path: string;
  // Target names selected for testing.
  test_target_ids: string[];
  // Test identifiers explicitly skipped/disabled in the plan.
  skipped_tests: string[];
}

export type AppleDiagnosticKind =
  | "unparsed_section"
  | "truncated"
  | "possible_drift"
  | "unsupported_input";

export interface AppleProjectDiagnostic {
  kind: AppleDiagnosticKind;
  path: string;
  detail: string;
}

export interface AppleProjectSource {
  path: string;
  provenance: AppleProvenance;
}

export interface AppleProjectModel {
  projects: AppleProjectSource[];
  targets: AppleTarget[];
  schemes: AppleScheme[];
  test_plans: AppleTestPlan[];
  diagnostics: AppleProjectDiagnostic[];
  // True when a bounded parser hit a cap or skipped a section, so consumers must
  // not treat the model as complete (never emit a false "used_by: 0").
  truncated: boolean;
}

export function emptyAppleProjectModel(): AppleProjectModel {
  return { projects: [], targets: [], schemes: [], test_plans: [], diagnostics: [], truncated: false };
}

// Whether the repository contains ANY Apple project input worth modeling — lets the
// pipeline skip the whole module on a non-Apple repo with zero cost.
export function hasAppleProjectInputs(paths: readonly string[]): boolean {
  return paths.some(
    (p) =>
      /(^|\/)project\.ya?ml$/.test(p) ||
      /(^|\/)Package\.swift$/.test(p) ||
      /\.xcodeproj\/project\.pbxproj$/.test(p) ||
      /\.xcscheme$/.test(p) ||
      /\.xctestplan$/.test(p)
  );
}
