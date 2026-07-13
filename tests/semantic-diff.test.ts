import test from "node:test";
import assert from "node:assert/strict";
import { parseStructuredDiff } from "../src/collector/diff-hunks";
import { classifyApiContractSurface } from "../src/risks/contract-surface";
import { computeSemanticChangeFacts, isBreakingApiChange, isExplicitApiContractChange, isSupportedApiContractChange, SemanticDiffSources } from "../src/risks/semantic-diff";

test("review-surfaces.REVIEWER_VALUE.7 optional interface additions remain supporting API facts", () => {
  assert.equal(isBreakingApiChange({
    path: "src/contracts/value.ts",
    exports_added: [],
    exports_removed: [],
    signatures_changed: [{
      name: "Value",
      from: "export interface Value { id: string; }",
      to: "export interface Value { id: string; note?: string; }"
    }]
  }), false);
  assert.equal(isBreakingApiChange({
    path: "src/contracts/value.ts",
    exports_added: [],
    exports_removed: [],
    signatures_changed: [{
      name: "Value",
      from: "export interface Value { id: string; }",
      to: "export interface Value { id: string; note: string; }"
    }]
  }), true);
  for (const [from, to] of [
    ["export interface Value extends A { id: string; }", "export interface Value extends B { id: string; }"],
    ["export interface Value<T> { id: T; }", "export interface Value<T, U> { id: T; }"],
    ["export interface Value { get(id: string): string; get(id: number): string; }", "export interface Value { get(id: number): string; }" ]
  ]) {
    assert.equal(isBreakingApiChange({
      path: "src/contracts/value.ts", exports_added: [], exports_removed: [],
      signatures_changed: [{ name: "Value", from, to }]
    }), true);
  }
});

test("review-surfaces.REVIEWER_VALUE.7 optional additions to namespaced interfaces remain supporting", () => {
  assert.equal(isBreakingApiChange({
    path: "types/public.d.ts",
    exports_added: [],
    exports_removed: [],
    signatures_changed: [{
      name: "N.Value",
      from: "export interface Value { required: string; }",
      to: "export interface Value { required: string; optional?: number; }"
    }]
  }), false);
  assert.equal(isBreakingApiChange({
    path: "types/public.d.ts",
    exports_added: [],
    exports_removed: [],
    signatures_changed: [{
      name: "N.Value",
      from: "export interface Value { required: string }",
      to: "export interface Value { required: string; optional?: number; }"
    }]
  }), false, "format-only semicolons on existing members do not make an optional addition breaking");
  assert.equal(isBreakingApiChange({
    path: "types/public.d.ts",
    exports_added: [],
    exports_removed: [],
    signatures_changed: [{
      name: "N.Value",
      from: "export interface Value { required: string, }",
      to: "export interface Value { required: string; optional?: number; }"
    }]
  }), false, "format-only member delimiter changes do not make an optional addition breaking");
});

test("review-surfaces.REVIEWER_VALUE.7 only appended optional object members are compatible", () => {
  const breaking = (from: string, to: string): boolean => isBreakingApiChange({
    path: "types/public.d.ts",
    exports_added: [],
    exports_removed: [],
    signatures_changed: [{ name: "Value", from, to }]
  });

  assert.equal(breaking(
    "export interface Value { call(value: string): string; call(value: number): number; }",
    "export interface Value { call(value: number): number; call(value: string): string; }"
  ), true, "overload order affects resolution");
  assert.equal(breaking(
    "export interface Value { first: string; second: string; }",
    "export interface Value { second: string; first: string; }"
  ), true, "existing member order is preserved");
  assert.equal(breaking(
    "export interface Value { first: string; second: string; }",
    "export interface Value { first: string; optional?: number; second: string; }"
  ), true, "optional members must be appended, not inserted");
  assert.equal(breaking(
    "export type Value = { id: string }",
    "export type Value = { id: string; note?: string }"
  ), false, "optional object-type members are additive");
  assert.equal(breaking(
    "export type Value = { id: string }",
    "export type Value = { id: string; note: string }"
  ), true, "required object-type members are breaking");
  assert.equal(breaking(
    "export type Value = string",
    "export type Value = string | number"
  ), true, "unsupported aliases remain conservative");
});

// ---------------------------------------------------------------------------
// review-surfaces.SEMANTIC_DIFF.1-3 — semantic facts from the meaning of the diff.
// ---------------------------------------------------------------------------

function sources(diffText: string, base: Record<string, string>, head: Record<string, string>): SemanticDiffSources {
  return {
    diff: parseStructuredDiff(diffText),
    readBase: (path) => base[path],
    readHead: (path) => head[path]
  };
}

test("review-surfaces.REVIEWER_VALUE.11 classifies package exports and configured paths as explicit contracts", () => {
  const paths = ["src/public.ts", "src/internal.ts", "src/extensions/plugin.ts"];
  const diffText = paths.flatMap((filePath) => [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1 +1 @@",
    "-export function value(input: string): string { return input; }",
    "+export function value(input: number): string { return String(input); }"
  ]).join("\n");
  const base = {
    ...Object.fromEntries(paths.map((filePath) => [filePath, "export function value(input: string): string { return input; }"])),
    "package.json": JSON.stringify({ exports: { ".": "./dist/src/public.js" } })
  };
  const head = {
    ...Object.fromEntries(paths.map((filePath) => [filePath, "export function value(input: number): string { return String(input); }"])),
    "package.json": JSON.stringify({ exports: { ".": "./dist/src/public.js" } })
  };
  const facts = computeSemanticChangeFacts({
    ...sources(diffText, base, head),
    contractPaths: ["src/extensions/**"]
  });
  const byPath = new Map(facts.api_changes.map((change) => [change.path, change]));
  assert.deepEqual(byPath.get("src/public.ts")?.contract_surface?.kind, "package_export");
  assert.deepEqual(byPath.get("src/extensions/plugin.ts")?.contract_surface?.kind, "configured");
  assert.equal(isExplicitApiContractChange(byPath.get("src/internal.ts")!), false);

  const removedExportManifest = computeSemanticChangeFacts({
    ...sources(diffText, base, { ...head, "package.json": JSON.stringify({}) }),
    contractPaths: ["src/extensions/**"]
  });
  assert.equal(
    removedExportManifest.api_changes.find((change) => change.path === "src/public.ts")?.contract_surface?.kind,
    "package_export",
    "the base manifest preserves public-surface evidence when an export is removed in the same range"
  );
});

test("review-surfaces.REVIEWER_VALUE.11 reads each package manifest once and maps declaration entries to source", () => {
  const path = "src/public.ts";
  const diffText = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-export function value(input: string): string { return input; }",
    "+export function value(input: number): string { return String(input); }"
  ].join("\n");
  let basePackageReads = 0;
  let headPackageReads = 0;
  const facts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(diffText),
    readBase: (filePath) => {
      if (filePath === "package.json") {
        basePackageReads += 1;
        return JSON.stringify({ types: "./dist/src/public.d.ts" });
      }
      return filePath === path ? "export function value(input: string): string { return input; }" : undefined;
    },
    readHead: (filePath) => {
      if (filePath === "package.json") {
        headPackageReads += 1;
        return JSON.stringify({ types: "./dist/src/public.d.ts" });
      }
      return filePath === path ? "export function value(input: number): string { return String(input); }" : undefined;
    }
  });
  assert.equal(basePackageReads, 1);
  assert.equal(headPackageReads, 1);
  assert.equal(facts.api_changes[0]?.contract_surface?.kind, "package_entry");
});

test("review-surfaces.REVIEWER_VALUE.11 maps common dist package targets back to src contracts", () => {
  const main = classifyApiContractSurface("src/index.ts", {
    packageJson: JSON.stringify({ main: "dist/index.js" })
  });
  const wildcard = classifyApiContractSurface("src/widgets/button.ts", {
    packageJson: JSON.stringify({ exports: { "./*": "./dist/widgets/*.js" } })
  });
  assert.equal(main?.kind, "package_entry");
  assert.equal(wildcard?.kind, "package_export");
  assert.equal(classifyApiContractSurface("source/index.ts", {
    packageJson: JSON.stringify({ main: "dist/index.js" }),
    sourceRoots: ["source"]
  })?.kind, "package_entry");
  assert.equal(classifyApiContractSurface("src/index.ts", {
    packageJson: JSON.stringify({ main: "lib/index.js" }),
    sourceRoots: ["src"]
  })?.kind, "package_entry");
  assert.equal(classifyApiContractSurface("src/index.ts", {
    packageJson: JSON.stringify({ main: "dist/index" }),
    sourceRoots: ["src"]
  })?.kind, "package_entry", "extensionless runtime entries expand to TypeScript source candidates");
  assert.equal(classifyApiContractSurface("src/index.ts", {
    packageJson: JSON.stringify({ exports: { ".": "./dist/index" } }),
    sourceRoots: ["src"]
  }), undefined, "extensionless exports remain exact and do not invent a TypeScript contract");
  assert.equal(classifyApiContractSurface("src/index.tsx", {
    packageJson: JSON.stringify({ exports: { ".": "./dist/index.jsx" } }),
    sourceRoots: ["src"]
  })?.kind, "package_export", "preserved JSX package output maps back to its TSX source contract");
  assert.equal(classifyApiContractSurface("index.ts", {
    packageJson: JSON.stringify({ main: "dist/index.js" }),
    sourceRoots: ["."]
  })?.kind, "package_entry", "a sole root-level source sentinel projects compiled entries to root source files");
  assert.equal(classifyApiContractSurface("src/index.ts", {
    packageJson: JSON.stringify({ main: "dist/index.js" }),
    sourceRoots: ["."]
  }), undefined, "the root-level sentinel does not promote a nested namesake");
  assert.equal(classifyApiContractSurface("index.ts", {
    packageJson: JSON.stringify({ main: "dist/index.js" }),
    sourceRoots: ["src"]
  }), undefined, "an explicit source root prevents a compiled target from promoting a root-level namesake");
  const ambiguousOptions = {
    packageJson: JSON.stringify({ main: "dist/index.js" }),
    sourceRoots: ["bin", "lib", "src", "source"]
  };
  assert.equal(classifyApiContractSurface("bin/index.ts", ambiguousOptions), undefined);
  assert.equal(classifyApiContractSurface("source/index.ts", ambiguousOptions), undefined, "ambiguous root fan-out never promotes multiple internal modules");
  assert.equal(classifyApiContractSurface("index.ts", ambiguousOptions), undefined, "ambiguous roots do not fall back to a root-level namesake");
  const nested = classifyApiContractSurface("src/features/admin/panel.ts", {
    packageJson: JSON.stringify({ exports: { "./*": "./src/*.ts" } }),
    sourceRoots: ["src"]
  });
  assert.equal(nested?.binding, "export:./features/admin/panel", "package wildcards bind nested consumer subpaths");
  const repeated = classifyApiContractSurface("src/foo/index/foo.ts", {
    packageJson: JSON.stringify({ exports: { "./*": "./src/*/index/*.ts" } }),
    sourceRoots: ["src"]
  });
  assert.equal(repeated?.binding, "export:./foo", "repeated target stars use the same consumer-subpath binding");
  const digitLiteral = classifyApiContractSurface("src/foo/index/foo2.ts", {
    packageJson: JSON.stringify({ exports: { "./*": "./src/*/index/*2.ts" } }),
    sourceRoots: ["src"]
  });
  assert.equal(digitLiteral?.binding, "export:./foo", "a digit after a repeated star cannot become an ambiguous numeric backreference");
});

test("review-surfaces.REVIEWER_VALUE.11 preserves base contract evidence across rename-out changes", () => {
  const oldPath = "src/public.ts";
  const newPath = "src/private.ts";
  const baseManifest = JSON.stringify({ exports: { ".": "./src/public.ts" } });
  const renamedWithBreak = [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 70%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    "@@ -1 +1 @@",
    "-export function value(input: string): string { return input; }",
    "+export function value(input: number): string { return String(input); }"
  ].join("\n");
  const breakingFacts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(renamedWithBreak),
    readBase: (path) => path === oldPath ? "export function value(input: string): string { return input; }" : path === "package.json" ? baseManifest : undefined,
    readHead: (path) => path === newPath ? "export function value(input: number): string { return String(input); }" : path === "package.json" ? "{}" : undefined
  });
  assert.equal(breakingFacts.api_changes[0]?.contract_surface?.kind, "package_export");
  assert.equal(isBreakingApiChange(breakingFacts.api_changes[0]), true);

  const renamedWithAddition = [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 80%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    "@@ -1 +1,2 @@",
    " export const value = 1;",
    "+export const extra = 2;"
  ].join("\n");
  const additiveFacts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(renamedWithAddition),
    readBase: (path) => path === oldPath ? "export const value = 1;" : path === "package.json" ? baseManifest : undefined,
    readHead: (path) => path === newPath ? "export const value = 1;\nexport const extra = 2;" : path === "package.json" ? "{}" : undefined
  });
  assert.deepEqual(additiveFacts.api_changes[0]?.exports_added, ["extra"]);
  assert.equal(additiveFacts.api_changes[0]?.contract_removed, true, "contract removal remains breaking even when the semantic diff is otherwise additive");
  assert.equal(isBreakingApiChange(additiveFacts.api_changes[0]), true);

  const pureRename = [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 100%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`
  ].join("\n");
  const renameFacts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(pureRename),
    readBase: (path) => path === oldPath ? "export const value = 1;" : path === "package.json" ? baseManifest : undefined,
    readHead: (path) => path === newPath ? "export const value = 1;" : path === "package.json" ? "{}" : undefined
  });
  assert.equal(renameFacts.api_changes[0]?.contract_removed, true);
  assert.equal(renameFacts.api_changes[0]?.renamed_from, oldPath);
  assert.equal(isBreakingApiChange(renameFacts.api_changes[0]), true);
});

test("review-surfaces.REVIEWER_VALUE.11 wildcard and path-only renames remove the old consumer contract", () => {
  const renameDiff = (oldPath: string, newPath: string): string => [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 100%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`
  ].join("\n");

  const wildcardManifest = JSON.stringify({ exports: { "./*": "./src/*.ts" } });
  const wildcard = computeSemanticChangeFacts({
    diff: parseStructuredDiff(renameDiff("src/foo.ts", "src/bar.ts")),
    readBase: (path) => path === "package.json" ? wildcardManifest : path === "src/foo.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? wildcardManifest : path === "src/bar.ts" ? "export const value = 1;" : undefined
  });
  assert.equal(wildcard.api_changes[0]?.contract_removed, true);
  assert.equal(wildcard.api_changes[0]?.contract_name, "export:./foo");
  assert.equal(wildcard.api_changes[0]?.contract_surface?.binding, "export:./foo");
  assert.equal(wildcard.api_changes[0]?.renamed_from, "src/foo.ts");

  const declaration = computeSemanticChangeFacts({
    diff: parseStructuredDiff(renameDiff("types/a.d.ts", "types/b.d.ts")),
    readBase: (path) => path === "types/a.d.ts" ? "export interface Value {}" : undefined,
    readHead: (path) => path === "types/b.d.ts" ? "export interface Value {}" : undefined
  });
  assert.equal(declaration.api_changes[0]?.contract_removed, true);
  assert.equal(declaration.api_changes[0]?.contract_surface?.source, "types/a.d.ts");

  const configured = computeSemanticChangeFacts({
    diff: parseStructuredDiff(renameDiff("src/public/a.ts", "src/public/b.ts")),
    readBase: (path) => path === "src/public/a.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "src/public/b.ts" ? "export const value = 1;" : undefined,
    contractPaths: ["src/public/**"]
  });
  assert.equal(configured.api_changes[0]?.contract_removed, true);
  assert.equal(configured.api_changes[0]?.renamed_from, "src/public/a.ts");
});

test("review-surfaces.REVIEWER_VALUE.11 null package exports exclude private wildcard bindings", () => {
  const excludedManifest = JSON.stringify({
    exports: {
      "./features/*.js": "./src/features/*.js",
      "./features/private-internal/*": null
    }
  });
  assert.equal(classifyApiContractSurface("src/features/private-internal/value.ts", {
    packageJson: excludedManifest,
    sourceRoots: ["src"]
  }), undefined);
  assert.equal(classifyApiContractSurface("src/features/public.ts", {
    packageJson: excludedManifest,
    sourceRoots: ["src"]
  })?.kind, "package_export");

  const conditionalExclusion = JSON.stringify({
    exports: {
      "./*": "./src/*.ts",
      "./private/*": { node: null, default: null }
    }
  });
  assert.equal(classifyApiContractSurface("src/private/value.ts", {
    packageJson: conditionalExclusion,
    sourceRoots: ["src"]
  }), undefined, "a null-only conditional tree excludes the subpath");

  const nulledLegacyRoot = JSON.stringify({ main: "./src/index.js", exports: { ".": null } });
  assert.equal(classifyApiContractSurface("src/index.ts", {
    packageJson: nulledLegacyRoot,
    sourceRoots: ["src"]
  }), undefined, "a root exports exclusion takes precedence over the legacy main entry");

  const narrowerPositive = JSON.stringify({
    exports: {
      "./features/*": null,
      "./features/safe/*": "./src/features/safe/*.ts"
    }
  });
  assert.equal(classifyApiContractSurface("src/features/safe/value.ts", {
    packageJson: narrowerPositive,
    sourceRoots: ["src"]
  })?.kind, "package_export", "a more-specific positive export overrides a broad exclusion");

  for (const packageJson of [
    JSON.stringify({ exports: { ".": { node: null, default: "./src/index.ts" } } }),
    JSON.stringify({ exports: { ".": [null, "./src/index.ts"] } })
  ]) {
    assert.equal(classifyApiContractSurface("src/index.ts", { packageJson, sourceRoots: ["src"] })?.kind, "package_export");
  }

  const privateDiff = [
    "diff --git a/src/features/private-internal/value.ts b/src/features/private-internal/value.ts",
    "--- a/src/features/private-internal/value.ts",
    "+++ b/src/features/private-internal/value.ts",
    "@@ -1 +1 @@",
    "-export function value(input: string): string { return input; }",
    "+export function value(input: number): string { return String(input); }"
  ].join("\n");
  const internal = computeSemanticChangeFacts({
    diff: parseStructuredDiff(privateDiff),
    readBase: (path) => path === "package.json" ? excludedManifest : path.includes("private-internal") ? "export function value(input: string): string { return input; }" : undefined,
    readHead: (path) => path === "package.json" ? excludedManifest : path.includes("private-internal") ? "export function value(input: number): string { return String(input); }" : undefined,
    sourceRoots: ["src"]
  });
  assert.equal(internal.api_changes[0]?.contract_surface, undefined);

  const packageDiff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n");
  const broadManifest = JSON.stringify({ exports: { "./features/*.js": "./src/features/*.js" } });
  const addedExclusion = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? broadManifest : undefined,
    readHead: (path) => path === "package.json" ? excludedManifest : undefined
  });
  assert.equal(addedExclusion.api_changes.some((change) => change.contract_removed && change.contract_name === "export:./features/private-internal/*"), true);

  const unmatchedExclusion = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./public/*": "./src/public/*.ts" } })
      : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./public/*": "./src/public/*.ts", "./private/*": null } })
      : undefined
  });
  assert.equal(unmatchedExclusion.api_changes.some((change) => change.contract_removed), false, "an exclusion that matches no base export is not breaking");

  const preservedNarrowExport = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./private/safe": "./src/safe.ts" } })
      : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./private/*": null, "./private/safe": "./src/safe.ts" } })
      : undefined
  });
  assert.equal(preservedNarrowExport.api_changes.some((change) => change.contract_removed), false, "a narrower positive export preserved in head overrides the broad exclusion");

  const redundantNarrowExclusion = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./*": "./src/*.ts", "./private/*": null } })
      : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./*": "./src/*.ts", "./private/*": null, "./private/foo": null } })
      : undefined
  });
  assert.equal(
    redundantNarrowExclusion.api_changes.some((change) => change.contract_removed),
    false,
    "a narrower null exclusion already covered in the base manifest removes no new contract"
  );

  const crossingExclusionLeavesExactBoundaryPublic = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./feature/*-impl": "./src/*.ts", "./feature/private-*-impl": null } })
      : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./feature/*-impl": "./src/*.ts", "./feature/private-*-impl": null, "./feature/private-*": null } })
      : undefined
  });
  assert.equal(
    crossingExclusionLeavesExactBoundaryPublic.api_changes.some((change) => change.contract_removed),
    true,
    "crossing wildcard exclusions still remove an exact boundary path when wildcard captures are non-empty"
  );

  const redundantCrossingExclusion = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./feature/*-impl": "./src/*.ts", "./feature/private-*-impl": null, "./feature/private--impl": null, "./feature/private-impl": null } })
      : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./feature/*-impl": "./src/*.ts", "./feature/private-*-impl": null, "./feature/private--impl": null, "./feature/private-impl": null, "./feature/private-*": null } })
      : undefined
  });
  assert.equal(
    redundantCrossingExclusion.api_changes.some((change) => change.contract_removed),
    false,
    "a crossing wildcard exclusion is redundant when its wildcard and every exact boundary region were already excluded"
  );

  const overlappingLiteralBoundary = (includeExactBoundaries: boolean) => computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ exports: {
        "./a*defg": "./src/*.ts",
        "./abcd*defg": null,
        ...(includeExactBoundaries ? { "./abcdefg": null, "./abcddefg": null } : {})
      } })
      : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ exports: {
        "./a*defg": "./src/*.ts",
        "./abcd*defg": null,
        ...(includeExactBoundaries ? { "./abcdefg": null, "./abcddefg": null } : {}),
        "./abcd*g": null
      } })
      : undefined
  });
  assert.equal(
    overlappingLiteralBoundary(false).api_changes.some((change) => change.contract_removed),
    true,
    "overlapping wildcard literals still expose exact boundary spellings"
  );
  assert.equal(
    overlappingLiteralBoundary(true).api_changes.some((change) => change.contract_removed),
    false,
    "covering the wildcard and all overlapping exact boundaries makes the new exclusion redundant"
  );

  const exclusionReplacingNarrowPositive = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./*": "./src/*.ts", "./private/*": null, "./private/foo": "./src/foo.ts" } })
      : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./*": "./src/*.ts", "./private/*": null, "./private/foo": null } })
      : undefined
  });
  assert.equal(
    exclusionReplacingNarrowPositive.api_changes.some((change) => change.contract_removed && change.contract_name === "export:./private/foo"),
    true,
    "a narrower positive that overrode the broad base exclusion remains a real removal"
  );

  const emptyWildcardCapture = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./feature/*-impl": "./src/*-impl.ts" } })
      : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./feature/*-impl": "./src/*-impl.ts", "./feature/-impl": null } })
      : undefined
  });
  assert.equal(emptyWildcardCapture.api_changes.some((change) => change.contract_removed), false, "an exact exclusion cannot remove the empty binding of a wildcard export because empty wildcard captures are not exported");

  const removedExclusion = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? excludedManifest : undefined,
    readHead: (path) => path === "package.json" ? broadManifest : undefined
  });
  assert.equal(removedExclusion.api_changes.some((change) => change.contract_removed), false, "removing an exclusion is additive");
});

test("review-surfaces.REVIEWER_VALUE.11 detects package-only removals but not stable export target moves", () => {
  const packageDiff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n");
  const removed = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { "./feature": "./dist/feature.js" } }) : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: {} }) : undefined
  });
  assert.equal(removed.api_changes.length, 1);
  assert.equal(removed.api_changes[0].path, "package.json");
  assert.equal(removed.api_changes[0].contract_name, "export:./feature");
  assert.equal(isBreakingApiChange(removed.api_changes[0]), true);

  const sameRootThroughExports = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ main: "./dist/index.js" })
      : path === "src/index.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ main: "./dist/index.js", exports: { ".": "./dist/index.js" } })
      : path === "src/index.ts" ? "export const value = 1;" : undefined,
    sourceRoots: ["src"]
  });
  assert.deepEqual(
    sameRootThroughExports.api_changes,
    [],
    "moving the same root target from main to exports preserves the consumer contract"
  );

  const changedRootThroughExports = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ main: "./dist/a.js" })
      : path === "src/a.ts" ? "export function value(input: string): string { return input; }" : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ main: "./dist/a.js", exports: { ".": "./dist/b.js" } })
      : path === "src/b.ts" ? "export function value(input: number): string { return String(input); }" : undefined,
    sourceRoots: ["src"]
  });
  assert.equal(changedRootThroughExports.api_changes.length, 1);
  assert.equal(changedRootThroughExports.api_changes[0].contract_surface?.identity, "export:.");
  assert.equal(changedRootThroughExports.api_changes[0].signatures_changed[0]?.name, "value");

  const rootHiddenBySubpathExports = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ main: "./dist/index.js" }) : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ main: "./dist/index.js", exports: { "./feature": "./dist/feature.js" } })
      : undefined,
    sourceRoots: ["src"]
  });
  assert.deepEqual(
    rootHiddenBySubpathExports.api_changes.map((change) => change.contract_name),
    ["export:."],
    "an authored exports map without a root key removes the legacy main root"
  );

  const moved = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { "./feature": "./dist/old.js" } }) : path === "src/old.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { "./feature": "./dist/new.js" } }) : path === "src/new.ts" ? "export const value = 1;" : undefined,
    baseSourceRoots: ["src"],
    headSourceRoots: ["src"]
  });
  assert.deepEqual(moved.api_changes, [], "changing the build target behind a stable export identity is not a removed consumer contract");

  const removedCondition = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { import: "./dist/index.mjs", require: "./dist/index.cjs" } } }) : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { import: "./dist/index.mjs" } } }) : undefined
  });
  assert.equal(removedCondition.api_changes[0]?.contract_name, "export:.:require", "conditional consumer slots are tracked independently");

  const nulledLegacyRoot = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ main: "./src/index.js" }) : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ main: "./src/index.js", exports: { ".": null } }) : undefined,
    sourceRoots: ["src"]
  });
  assert.deepEqual(nulledLegacyRoot.api_changes.map((change) => change.contract_name), ["export:."]);

  const nulledConditionalExport = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./feature": { import: "./dist/feature.mjs", require: "./dist/feature.cjs" } } })
      : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { "./feature": null } }) : undefined
  });
  assert.deepEqual(
    nulledConditionalExport.api_changes.map((change) => change.contract_name).sort(),
    ["export:./feature:import", "export:./feature:require"],
    "the generic null exclusion must not duplicate condition-specific removals for the same consumer path"
  );

  const packageAndFooDiff = parseStructuredDiff([
    packageDiff,
    "diff --git a/src/foo.ts b/src/foo.ts",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1 +1,2 @@",
    " export const value = 1;",
    "+// implementation-only edit"
  ].join("\n"));
  const wildcardRemovalWithChangedBinding = computeSemanticChangeFacts({
    diff: packageAndFooDiff,
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./*": "./src/*.ts" } })
      : path === "src/foo.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ exports: {} })
      : path === "src/foo.ts" ? "export const value = 1;\n// implementation-only edit" : undefined,
    sourceRoots: ["src"]
  });
  const wildcardRemovedNames = wildcardRemovalWithChangedBinding.api_changes
    .filter((change) => change.contract_removed)
    .map((change) => change.contract_name);
  assert.ok(wildcardRemovedNames.includes("export:./foo"), "the changed concrete binding remains visible");
  assert.ok(wildcardRemovedNames.includes("export:./*"), "the package-wide wildcard removal remains visible too");

  const exactRemovalWithChangedFile = computeSemanticChangeFacts({
    diff: packageAndFooDiff,
    readBase: (path) => path === "package.json"
      ? JSON.stringify({ exports: { "./foo": "./src/foo.ts" } })
      : path === "src/foo.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json"
      ? JSON.stringify({ exports: {} })
      : path === "src/foo.ts" ? "export const value = 1;\n// implementation-only edit" : undefined,
    sourceRoots: ["src"]
  });
  assert.deepEqual(
    exactRemovalWithChangedFile.api_changes.filter((change) => change.contract_removed).map((change) => change.contract_name),
    ["export:./foo"],
    "an exact export removal is represented once rather than duplicated as package and file facts"
  );

  const incompatibleRepoint = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": "./src/v1.ts" } }) : path === "src/v1.ts" ? "export function value(input: string): string { return input; }" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": "./src/v2.ts" } }) : path === "src/v2.ts" ? "export function value(input: number): string { return String(input); }" : undefined
  });
  assert.equal(incompatibleRepoint.api_changes[0]?.path, "package.json", "a package-only target break stays in the changed PR scope");
  assert.equal(incompatibleRepoint.api_changes[0]?.signatures_changed[0]?.name, "value");
  assert.equal(isBreakingApiChange(incompatibleRepoint.api_changes[0]), true);
});

test("review-surfaces.REVIEWER_VALUE.11 detects ambient/configured deletion and stale-target rename removals", () => {
  const path = "types/ambient.d.ts";
  const deletion = [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    `--- a/${path}`,
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-declare global { interface Window { feature: string } }"
  ].join("\n");
  const deletedFacts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(deletion),
    readBase: (filePath) => filePath === path ? "declare global { interface Window { feature: string } }" : undefined,
    readHead: () => undefined
  });
  assert.equal(deletedFacts.api_changes[0]?.contract_removed, true);
  assert.equal(deletedFacts.api_changes[0]?.contract_surface?.kind, "declaration");

  const configuredPath = "src/extension-hook.ts";
  const configuredDeletion = deletion.replaceAll(path, configuredPath).replace(
    "declare global { interface Window { feature: string } }",
    "const extensionHook = 1;"
  );
  const configuredFacts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(configuredDeletion),
    readBase: (filePath) => filePath === configuredPath ? "const extensionHook = 1;" : undefined,
    readHead: () => undefined,
    contractPaths: [configuredPath]
  });
  assert.equal(configuredFacts.api_changes[0]?.contract_removed, true);
  assert.equal(configuredFacts.api_changes[0]?.contract_surface?.kind, "configured");

  const oldPath = "src/public.ts";
  const newPath = "src/private.ts";
  const staleRename = [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 100%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`
  ].join("\n");
  const packageJson = JSON.stringify({ exports: { ".": `./${oldPath}` } });
  const staleFacts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(staleRename),
    readBase: (filePath) => filePath === oldPath ? "export const value = 1;" : filePath === "package.json" ? packageJson : undefined,
    readHead: (filePath) => filePath === newPath ? "export const value = 1;" : filePath === "package.json" ? packageJson : undefined
  });
  assert.equal(staleFacts.api_changes[0]?.contract_removed, true, "a surviving identity whose target still names the removed path is broken");
});

test("review-surfaces.REVIEWER_VALUE.11 stable package target moves do not promote delete/add source facts", () => {
  const oldPath = "src/old.ts";
  const newPath = "src/new.ts";
  const diffText = [
    `diff --git a/${oldPath} b/${oldPath}`,
    "deleted file mode 100644",
    `--- a/${oldPath}`,
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export const value = 1;",
    `diff --git a/${newPath} b/${newPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${newPath}`,
    "@@ -0,0 +1 @@",
    "+export const value = 1;"
  ].join("\n");
  const facts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(diffText),
    readBase: (path) => path === oldPath ? "export const value = 1;" : path === "package.json" ? JSON.stringify({ exports: { ".": `./${oldPath}` } }) : undefined,
    readHead: (path) => path === newPath ? "export const value = 1;" : path === "package.json" ? JSON.stringify({ exports: { ".": `./${newPath}` } }) : undefined
  });
  assert.equal(facts.api_changes.some((change) => isSupportedApiContractChange(change) && isBreakingApiChange(change)), false);
  assert.deepEqual(facts.api_changes, [], "an identity-preserving source move with the same API is not a contract change");

  const incompatible = computeSemanticChangeFacts({
    diff: parseStructuredDiff(diffText),
    readBase: (path) => path === oldPath ? "export function value(input: string): string { return input; }" : path === "package.json" ? JSON.stringify({ exports: { ".": `./${oldPath}` } }) : undefined,
    readHead: (path) => path === newPath ? "export function value(input: number): string { return String(input); }" : path === "package.json" ? JSON.stringify({ exports: { ".": `./${newPath}` } }) : undefined
  });
  const contractChange = incompatible.api_changes.find(isSupportedApiContractChange);
  assert.equal(contractChange?.path, newPath);
  assert.equal(contractChange?.signatures_changed[0]?.name, "value");
  assert.equal(contractChange ? isBreakingApiChange(contractChange) : false, true);
});

test("review-surfaces.REVIEWER_VALUE.11 moving one identity preserves breaks on another identity sharing its old module", () => {
  const path = "src/a.ts";
  const packageDiff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-export function value(input: string): string { return input; }",
    "+export function value(input: number): string { return String(input); }"
  ].join("\n");
  const baseManifest = JSON.stringify({ exports: { ".": `./${path}`, "./alias": `./${path}` } });
  const headManifest = JSON.stringify({ exports: { ".": "./src/b.ts", "./alias": `./${path}` } });
  const facts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (filePath) => filePath === "package.json" ? baseManifest : filePath === path ? "export function value(input: string): string { return input; }" : undefined,
    readHead: (filePath) => filePath === "package.json" ? headManifest : filePath === path ? "export function value(input: number): string { return String(input); }" : filePath === "src/b.ts" ? "export function value(input: string): string { return input; }" : undefined
  });
  const aliasBreak = facts.api_changes.find((change) => change.path === path && change.contract_surface?.identity === "export:./alias");
  assert.equal(aliasBreak ? isBreakingApiChange(aliasBreak) : false, true, "reconciling export:. cannot erase the still-public alias break");
});

test("review-surfaces.REVIEWER_VALUE.11 matches unchanged package fallback targets before reconciling replacements", () => {
  const packageDiff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n");
  const baseManifest = JSON.stringify({ exports: { ".": ["./src/a.ts", "./src/b.ts"] } });
  const headManifest = JSON.stringify({ exports: { ".": ["./src/c.ts", "./src/b.ts"] } });
  const facts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? baseManifest : path === "src/a.ts" ? "export function value(input: string): string { return input; }" : path === "src/b.ts" ? "export function value(input: number): string { return String(input); }" : undefined,
    readHead: (path) => path === "package.json" ? headManifest : path === "src/c.ts" ? "export function value(input: string): string { return input; }" : path === "src/b.ts" ? "export function value(input: number): string { return String(input); }" : undefined
  });
  assert.deepEqual(facts.api_changes, [], "the unchanged b fallback is not incorrectly compared with replacement c");

  const reordered = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/a.ts", "./src/b.ts"] } }) : path === "src/a.ts" || path === "src/b.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/b.ts", "./src/a.ts"] } }) : path === "src/a.ts" || path === "src/b.ts" ? "export const value = 1;" : undefined
  });
  assert.equal(reordered.api_changes.some((change) => change.contract_target_changed), true, "fallback reorder changes first-match resolution");

  const removedCompatibleFirstFallback = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/a.ts", "./src/b.ts"] } }) : path === "src/a.ts" || path === "src/b.ts" ? "export function value(input: string): string { return input; }" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/b.ts"] } }) : path === "src/b.ts" ? "export function value(input: string): string { return input; }" : undefined
  });
  assert.deepEqual(removedCompatibleFirstFallback.api_changes, [], "deleting the first fallback compares the newly selected API before reporting a target change");

  const removedIncompatibleFirstFallback = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/a.ts", "./src/b.ts"] } }) : path === "src/a.ts" ? "export function value(input: string): string { return input; }" : path === "src/b.ts" ? "export function value(input: number): string { return String(input); }" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/b.ts"] } }) : path === "src/b.ts" ? "export function value(input: number): string { return String(input); }" : undefined
  });
  assert.equal(removedIncompatibleFirstFallback.api_changes.length, 1);
  assert.equal(removedIncompatibleFirstFallback.api_changes[0]?.path, "package.json");
  assert.equal(removedIncompatibleFirstFallback.api_changes[0]?.contract_target_changed, undefined);
  assert.equal(isBreakingApiChange(removedIncompatibleFirstFallback.api_changes[0]), true);

  const prepended = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/b.ts"] } }) : path === "src/b.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/c.ts", "./src/b.ts"] } }) : path === "src/b.ts" || path === "src/c.ts" ? "export const value = 1;" : undefined
  });
  assert.equal(prepended.api_changes.some((change) => change.contract_target_changed), true, "a new first fallback cannot be treated as an additive tail");

  const replacementAndReorder = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/a.ts", "./src/b.ts"] } }) : path === "src/a.ts" || path === "src/c.ts" ? "export const value = 1;" : path === "src/b.ts" ? "export const other = 2;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/b.ts", "./src/c.ts"] } }) : path === "src/a.ts" || path === "src/c.ts" ? "export const value = 1;" : path === "src/b.ts" ? "export const other = 2;" : undefined
  });
  assert.equal(replacementAndReorder.api_changes.some((change) => change.contract_target_changed), true, "a shared fallback moving priority cannot hide behind a compatible replacement");

  const movedSourceDiff = [
    packageDiff,
    "diff --git a/src/a.ts b/src/a.ts",
    "deleted file mode 100644",
    "--- a/src/a.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export const value = 1;",
    "diff --git a/src/c.ts b/src/c.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/c.ts",
    "@@ -0,0 +1 @@",
    "+export const value = 1;"
  ].join("\n");
  const replacementReorderWithFiles = computeSemanticChangeFacts({
    diff: parseStructuredDiff(movedSourceDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/a.ts", "./src/b.ts"] } }) : path === "src/a.ts" ? "export const value = 1;" : path === "src/b.ts" ? "export const other = 2;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/b.ts", "./src/c.ts"] } }) : path === "src/c.ts" ? "export const value = 1;" : path === "src/b.ts" ? "export const other = 2;" : undefined
  });
  assert.equal(replacementReorderWithFiles.api_changes.some((change) => change.contract_target_changed), true, "source-file reconciliation cannot suppress fallback priority analysis");

  const duplicateFallback = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/a.ts", "./src/a.ts"] } }) : path === "src/a.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": ["./src/a.ts", "./src/a.ts"] } }) : path === "src/a.ts" ? "export const value = 1;" : undefined
  });
  assert.deepEqual(duplicateFallback.api_changes, [], "duplicate unchanged fallbacks are matched occurrence by occurrence");

  const defaultOnlyWrapper = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": "./src/index.ts" } }) : path === "src/index.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { default: "./src/index.ts" } } }) : path === "src/index.ts" ? "export const value = 1;" : undefined
  });
  assert.deepEqual(defaultOnlyWrapper.api_changes, [], "a sole default wrapper preserves the unconditioned root contract identity");

  const nestedDefaultOnlyWrapper = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { node: "./src/index.ts" } } }) : path === "src/index.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { node: { default: "./src/index.ts" } } } }) : path === "src/index.ts" ? "export const value = 1;" : undefined
  });
  assert.deepEqual(nestedDefaultOnlyWrapper.api_changes, [], "a nested sole default wrapper preserves its parent condition identity");

  const reorderedConditions = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { import: "./src/a.ts", default: "./src/b.ts" } } }) : path === "src/a.ts" || path === "src/b.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { default: "./src/b.ts", import: "./src/a.ts" } } }) : path === "src/a.ts" || path === "src/b.ts" ? "export const value = 1;" : undefined
  });
  assert.equal(reorderedConditions.api_changes.some((change) => change.contract_name === "export:." && change.contract_target_changed), true, "condition key order participates in package resolution priority");

  const reorderedEquivalentConditions = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { node: "./src/index.ts", default: "./src/index.ts" } } }) : path === "src/index.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { default: "./src/index.ts", node: "./src/index.ts" } } }) : path === "src/index.ts" ? "export const value = 1;" : undefined
  });
  assert.equal(
    reorderedEquivalentConditions.api_changes.some((change) => change.contract_target_changed),
    false,
    "reordering conditions with identical resolved targets is unobservable"
  );

  const reassignedConditionsWithStableTargetOrder = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { node: "./src/a.ts", default: "./src/b.ts" } } }) : path === "src/a.ts" || path === "src/b.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { default: "./src/a.ts", node: "./src/b.ts" } } }) : path === "src/a.ts" || path === "src/b.ts" ? "export const value = 1;" : undefined
  });
  assert.equal(
    reassignedConditionsWithStableTargetOrder.api_changes.some((change) => change.contract_target_changed),
    true,
    "stable target order cannot hide targets reassigned to different conditions"
  );

  const dottedCondition = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { "a.b": "./src/a.ts" } } }) : path === "src/a.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { ".": { a: { b: "./src/b.ts" } } } }) : path === "src/b.ts" ? "export const value = 1;" : undefined
  });
  assert.equal(dottedCondition.api_changes.some((change) => change.contract_removed && change.contract_name === "export:.:a%2Eb"), true, "literal dotted and nested condition vectors have distinct identities");

  const colonSubpath = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (path) => path === "package.json" ? JSON.stringify({ exports: { "./feature:import": "./src/a.ts" } }) : path === "src/a.ts" ? "export const value = 1;" : undefined,
    readHead: (path) => path === "package.json" ? JSON.stringify({ exports: { "./feature": { import: "./src/b.ts" } } }) : path === "src/b.ts" ? "export const value = 1;" : undefined
  });
  assert.equal(colonSubpath.api_changes.some((change) => change.contract_removed && change.contract_name === "export:./feature%3Aimport"), true, "subpath delimiters cannot collide with condition delimiters");

  const wildcardCondition = classifyApiContractSurface("src/foo.ts", {
    packageJson: JSON.stringify({ exports: { "./*": { "custom*": "./src/*.ts" } } }),
    sourceRoots: ["src"]
  });
  assert.equal(wildcardCondition?.binding, "export:./foo:custom%2A", "literal condition stars are not replaced as subpath wildcards");
});

test("review-surfaces.REVIEWER_VALUE.11 target reconciliation preserves surviving internal module facts", () => {
  const path = "src/a.ts";
  const packageDiff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-export function internal(input: string): string { return input; }",
    "+export function internal(input: number): string { return String(input); }"
  ].join("\n");
  const facts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(packageDiff),
    readBase: (filePath) => filePath === "package.json" ? JSON.stringify({ exports: { ".": `./${path}` } }) : filePath === path ? "export function internal(input: string): string { return input; }" : filePath === "src/b.ts" ? "export const value = 1;" : undefined,
    readHead: (filePath) => filePath === "package.json" ? JSON.stringify({ exports: { ".": "./src/b.ts" } }) : filePath === path ? "export function internal(input: number): string { return String(input); }" : filePath === "src/b.ts" ? "export function internal(input: string): string { return input; }" : undefined
  });
  const internal = facts.api_changes.find((change) => change.path === path);
  assert.equal(internal?.signatures_changed[0]?.name, "internal");
  assert.equal(internal?.contract_surface, undefined, "the old target's surviving module remains supporting, not public");
});

test("review-surfaces.REVIEWER_VALUE.11 reconciles every concrete wildcard export binding", () => {
  const names = ["foo", "bar"];
  const diffText = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    ...names.flatMap((name) => [
      `diff --git a/src/${name}.ts b/src/${name}.ts`,
      "deleted file mode 100644",
      `--- a/src/${name}.ts`,
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export function value(input: string): string { return input; }",
      `diff --git a/lib/${name}.ts b/lib/${name}.ts`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/lib/${name}.ts`,
      "@@ -0,0 +1 @@",
      `+export function value(input: ${name === "foo" ? "number" : "string"}): string { return String(input); }`
    ])
  ].join("\n");
  const baseManifest = JSON.stringify({ exports: { "./*": "./src/*.ts" } });
  const headManifest = JSON.stringify({ exports: { "./*": "./lib/*.ts" } });
  const facts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(diffText),
    readBase: (path) => path === "package.json" ? baseManifest : names.some((name) => path === `src/${name}.ts`) ? "export function value(input: string): string { return input; }" : undefined,
    readHead: (path) => path === "package.json" ? headManifest : names.some((name) => path === `lib/${name}.ts`) ? `export function value(input: ${path.includes("foo") ? "number" : "string"}): string { return String(input); }` : undefined,
    baseSourceRoots: ["src"],
    headSourceRoots: ["lib"]
  });
  const supported = facts.api_changes.filter(isSupportedApiContractChange);
  const concrete = supported.find((change) => change.path === "lib/foo.ts");
  assert.equal(concrete?.contract_surface?.binding, "export:./foo");
  assert.equal(concrete ? isBreakingApiChange(concrete) : false, true);
  assert.equal(
    supported.some((change) => change.path === "package.json" && change.contract_target_changed),
    true,
    "changed concrete bindings cannot prove every unchanged binding behind a wildcard target is compatible"
  );
});

test("review-surfaces.REVIEWER_VALUE.11 uses independent base and head source roots", () => {
  const oldPath = "source/index.ts";
  const newPath = "src/index.ts";
  const diffText = [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 70%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    "@@ -1 +1 @@",
    "-export function value(input: string): string { return input; }",
    "+export function value(input: number): string { return String(input); }"
  ].join("\n");
  const facts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(diffText),
    readBase: (path) => path === oldPath ? "export function value(input: string): string { return input; }" : path === "package.json" ? JSON.stringify({ main: "dist/index.js" }) : undefined,
    readHead: (path) => path === newPath ? "export function value(input: number): string { return String(input); }" : path === "package.json" ? JSON.stringify({ main: "dist/index.js" }) : undefined,
    baseSourceRoots: ["source"],
    headSourceRoots: ["src"]
  });
  assert.equal(facts.api_changes[0]?.contract_surface?.kind, "package_entry");
  assert.equal(facts.api_changes[0]?.contract_removed, undefined, "the stable package entry identity survived the source-root move");
  assert.equal(isBreakingApiChange(facts.api_changes[0]), true);
});

test("review-surfaces.REVIEWER_VALUE.11 analyzes mts, cts, d.mts, and d.cts contract sources", () => {
  const paths = ["src/public.mts", "src/public.cts", "types/public.d.mts", "types/public.d.cts"];
  const diffText = paths.flatMap((path) => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-export function value(input: string): string;",
    "+export function value(input: number): string;"
  ]).join("\n");
  const oldText = "export function value(input: string): string;";
  const newText = "export function value(input: number): string;";
  const packageJson = JSON.stringify({ exports: { "./esm": "./src/public.mjs", "./cjs": "./src/public.cjs" } });
  const facts = computeSemanticChangeFacts({
    diff: parseStructuredDiff(diffText),
    readBase: (path) => path === "package.json" ? packageJson : paths.includes(path) ? oldText : undefined,
    readHead: (path) => path === "package.json" ? packageJson : paths.includes(path) ? newText : undefined
  });
  assert.deepEqual(facts.api_changes.map((change) => change.path), paths);
  assert.ok(facts.api_changes.every((change) => change.contract_surface !== undefined));
});

// review-surfaces.SEMANTIC_DIFF.1: a schema change making a field required is
// reported with the field name and the kind of change.
test("review-surfaces.SEMANTIC_DIFF.1 reports a field that became required", () => {
  const path = "schemas/thing.schema.json";
  const oldSchema = JSON.stringify({ type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "string" } } });
  const newSchema = JSON.stringify({ type: "object", required: ["a", "b"], properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "string" } } });
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n");
  const facts = computeSemanticChangeFacts(sources(diffText, { [path]: oldSchema }, { [path]: newSchema }));
  assert.equal(facts.schema_changes.length, 1);
  const change = facts.schema_changes[0];
  assert.deepEqual(change.required_added, ["b"], "field b became required");
  assert.deepEqual(change.properties_added, ["c"], "property c was added");
  assert.ok(change.type_changes.some((t) => t.field === "properties.b" && t.from === "string" && t.to === "number"), "b changed type");
});

// review-surfaces.SEMANTIC_DIFF.1: an enum change is reported.
test("review-surfaces.SEMANTIC_DIFF.1 reports enum additions and removals", () => {
  const path = "schemas/status.schema.json";
  const oldSchema = JSON.stringify({ properties: { status: { enum: ["open", "closed"] } } });
  const newSchema = JSON.stringify({ properties: { status: { enum: ["open", "merged"] } } });
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const facts = computeSemanticChangeFacts(sources(diffText, { [path]: oldSchema }, { [path]: newSchema }));
  const enumChange = facts.schema_changes[0].enum_changes.find((e) => e.field === "properties.status");
  assert.ok(enumChange);
  assert.deepEqual(enumChange!.added, ["merged"]);
  assert.deepEqual(enumChange!.removed, ["closed"]);
});

// A pure schema ADD (no base version) is not diffed as a contract change.
test("review-surfaces.SEMANTIC_DIFF.1 does not diff a newly added schema", () => {
  const path = "schemas/new.schema.json";
  const diffText = [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1,1 @@", "+{}", ""].join("\n");
  const facts = computeSemanticChangeFacts(sources(diffText, {}, { [path]: "{}" }));
  assert.equal(facts.schema_changes.length, 0);
});

// review-surfaces.SEMANTIC_DIFF.3: a test file with an assertion removed fires
// the test-weakening signal; an unrelated test edit does not.
test("review-surfaces.SEMANTIC_DIFF.3 fires on a removed assertion, not on unrelated edits", () => {
  const path = "tests/sample.test.ts";
  const removedAssert = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,4 +1,3 @@",
    " test('x', () => {",
    "-  assert.equal(a, 1);",
    "   doSomething();",
    " });",
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(removedAssert, {}, {})).test_weakening;
  assert.ok(weakening.some((s) => s.kind === "removed_assertion" && s.path === path), "removed assertion fires");

  const unrelatedEdit = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    " test('x', () => {",
    "-  const a = 1;",
    "+  const a = 2;",
    "   assert.equal(a, a);",
    " });",
    ""
  ].join("\n");
  const noWeakening = computeSemanticChangeFacts(sources(unrelatedEdit, {}, {})).test_weakening;
  assert.ok(!noWeakening.some((s) => s.kind === "removed_assertion"), "an unrelated edit does not fire");
});

// A modified assertion (deleted + added) nets to zero and does not fire.
test("review-surfaces.SEMANTIC_DIFF.3 a modified assertion does not fire removed_assertion", () => {
  const path = "tests/mod.test.ts";
  const diffText = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    " test('x', () => {",
    "-  assert.equal(a, 1);",
    "+  assert.equal(a, 2);",
    " });",
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(diffText, {}, {})).test_weakening;
  assert.ok(!weakening.some((s) => s.kind === "removed_assertion"), "a modified assertion nets to zero");
});

// review-surfaces.SEMANTIC_DIFF.3: deleted test files, newly skipped tests, and
// regenerated snapshots are detected.
test("review-surfaces.SEMANTIC_DIFF.3 detects deleted tests, skips, and snapshots", () => {
  const deleted = [`diff --git a/tests/gone.test.ts b/tests/gone.test.ts`, "deleted file mode 100644", `--- a/tests/gone.test.ts`, "+++ /dev/null", "@@ -1,1 +0,0 @@", "-test('x',()=>{});", ""].join("\n");
  assert.ok(computeSemanticChangeFacts(sources(deleted, {}, {})).test_weakening.some((s) => s.kind === "deleted_test_file"));

  const skipped = [`diff --git a/tests/s.test.ts b/tests/s.test.ts`, `--- a/tests/s.test.ts`, `+++ b/tests/s.test.ts`, "@@ -1,1 +1,1 @@", "-test('x', () => {});", "+test.skip('x', () => {});", ""].join("\n");
  assert.ok(computeSemanticChangeFacts(sources(skipped, {}, {})).test_weakening.some((s) => s.kind === "skipped_test"));

  const snap = [`diff --git a/tests/__snapshots__/a.snap b/tests/__snapshots__/a.snap`, `--- a/tests/__snapshots__/a.snap`, `+++ b/tests/__snapshots__/a.snap`, "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n");
  assert.ok(computeSemanticChangeFacts(sources(snap, {}, {})).test_weakening.some((s) => s.kind === "regenerated_snapshot"));
});

// A brand-new test file (status "A") whose added lines happen to contain
// `.skip(` or fixture assertion text inside string literals must NOT fire a
// skip/removed-assertion signal — it has no prior coverage to weaken. This
// guards the dogfood false positive where tests/semantic-diff.test.ts's own
// `test.skip(` fixture strings were flagged as "1 test newly skipped".
test("review-surfaces.SEMANTIC_DIFF.3 does not fire on a newly added test file", () => {
  const path = "tests/brand-new.test.ts";
  const diffText = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,5 @@",
    "+test('describes a skip fixture', () => {",
    "+  const fixture = \"+test.skip('x', () => {});\";",
    "+  assert.ok(detect(fixture));",
    "+});",
    "+test.skip('a genuinely skipped new test', () => {});",
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(diffText, {}, {})).test_weakening;
  assert.equal(weakening.length, 0, "a new test file weakens no prior coverage");
});

// review-surfaces.SEMANTIC_DIFF.2: an exported function signature change is
// reported as an API-surface fact.
test("review-surfaces.SEMANTIC_DIFF.2 reports exported signature, add, and remove changes", () => {
  const path = "src/api.ts";
  const oldText = "export function foo(a: string): void {}\nexport const bar = 1;\nexport function gone() {}\n";
  const newText = "export function foo(a: string, b: number): void {}\nexport const bar = 1;\nexport function added() {}\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const facts = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText }));
  assert.equal(facts.api_changes.length, 1);
  const api = facts.api_changes[0];
  assert.ok(api.signatures_changed.some((s) => s.name === "foo"), "foo signature changed");
  assert.deepEqual(api.exports_added, ["added"]);
  assert.deepEqual(api.exports_removed, ["gone"]);
});

// review-surfaces.SEMANTIC_DIFF.1: enum members that are not strings (numbers,
// booleans, null) are compared as JSON values, not dropped.
test("review-surfaces.SEMANTIC_DIFF.1 detects non-string enum changes", () => {
  const path = "schemas/code.schema.json";
  const oldSchema = JSON.stringify({ properties: { code: { enum: [1, 2] } } });
  const newSchema = JSON.stringify({ properties: { code: { enum: [1, 3] } } });
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldSchema }, { [path]: newSchema })).schema_changes[0];
  const enumChange = change.enum_changes.find((e) => e.field === "properties.code");
  assert.ok(enumChange, "a numeric enum change is reported");
  assert.deepEqual(enumChange!.added, ["3"]);
  assert.deepEqual(enumChange!.removed, ["2"]);
});

// review-surfaces.SEMANTIC_DIFF.3: a newly-added snapshot file is a new test's
// first snapshot, not a regeneration that could mask a regression.
test("review-surfaces.SEMANTIC_DIFF.3 ignores an added snapshot but flags a modified one", () => {
  const added = [`diff --git a/tests/__snapshots__/new.snap b/tests/__snapshots__/new.snap`, "new file mode 100644", "--- /dev/null", `+++ b/tests/__snapshots__/new.snap`, "@@ -0,0 +1,1 @@", "+exports['x'] = `1`;", ""].join("\n");
  assert.equal(computeSemanticChangeFacts(sources(added, {}, {})).test_weakening.length, 0, "an added snapshot is not weakening");

  const modified = [`diff --git a/tests/__snapshots__/a.snap b/tests/__snapshots__/a.snap`, `--- a/tests/__snapshots__/a.snap`, `+++ b/tests/__snapshots__/a.snap`, "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n");
  assert.ok(computeSemanticChangeFacts(sources(modified, {}, {})).test_weakening.some((s) => s.kind === "regenerated_snapshot"), "a modified snapshot is flagged");
});

// review-surfaces.SEMANTIC_DIFF.3: a renamed test file still carries prior
// coverage, so a rename that also skips a test or drops an assertion fires.
test("review-surfaces.SEMANTIC_DIFF.3 inspects renamed test files for weakening", () => {
  const path = "tests/renamed.test.ts";
  const diffText = [
    `diff --git a/tests/old.test.ts b/${path}`,
    "similarity index 80%",
    `rename from tests/old.test.ts`,
    `rename to ${path}`,
    `--- a/tests/old.test.ts`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    "-test('x', () => { assert.equal(a, 1); });",
    "+test.skip('x', () => {});",
    " keep();",
    ""
  ].join("\n");
  const weakening = computeSemanticChangeFacts(sources(diffText, {}, {})).test_weakening;
  assert.ok(weakening.some((s) => s.kind === "skipped_test"), "a renamed test that adds .skip fires");
});

// review-surfaces.SEMANTIC_DIFF.2: an added exported module reports its exports
// as additions; a deleted one reports removals.
test("review-surfaces.SEMANTIC_DIFF.2 reports added and deleted exported modules", () => {
  const addedPath = "src/added.ts";
  const addedDiff = [`diff --git a/${addedPath} b/${addedPath}`, "new file mode 100644", "--- /dev/null", `+++ b/${addedPath}`, "@@ -0,0 +1,1 @@", "+export const fresh = 1;", ""].join("\n");
  const addedChange = computeSemanticChangeFacts(sources(addedDiff, {}, { [addedPath]: "export const fresh = 1;\nexport function go() {}\n" })).api_changes[0];
  assert.ok(addedChange, "an added module produces an API change");
  assert.deepEqual(addedChange.exports_added.sort(), ["fresh", "go"]);

  const deletedPath = "src/gone.ts";
  const deletedDiff = [`diff --git a/${deletedPath} b/${deletedPath}`, "deleted file mode 100644", `--- a/${deletedPath}`, "+++ /dev/null", "@@ -1,1 +0,0 @@", "-export const old = 1;", ""].join("\n");
  const deletedChange = computeSemanticChangeFacts(sources(deletedDiff, { [deletedPath]: "export const old = 1;" }, {})).api_changes[0];
  assert.ok(deletedChange, "a deleted module produces an API change");
  assert.deepEqual(deletedChange.exports_removed, ["old"]);
});

// review-surfaces.SEMANTIC_DIFF.2: a changed interface body or type-alias RHS is
// a signature change (the common breaking TS API edit), not invisible.
test("review-surfaces.SEMANTIC_DIFF.2 detects interface body and type alias changes", () => {
  const path = "src/types.ts";
  const oldText = "export interface Options {\n  a: string;\n}\nexport type Result = A | B;\n";
  const newText = "export interface Options {\n  a: string;\n  b: number;\n}\nexport type Result = A | B | C;\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change, "an interface/type change produces an API change");
  assert.ok(change.signatures_changed.some((s) => s.name === "Options"), "interface member addition is a signature change");
  assert.ok(change.signatures_changed.some((s) => s.name === "Result"), "type alias RHS change is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.1: a contract change inside an array field's
// `items` schema is not invisible.
test("review-surfaces.SEMANTIC_DIFF.1 recurses into array item schemas", () => {
  const path = "schemas/tags.schema.json";
  const oldSchema = JSON.stringify({ properties: { tags: { type: "array", items: { type: "string" } } } });
  const newSchema = JSON.stringify({ properties: { tags: { type: "array", items: { type: "number" } } } });
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldSchema }, { [path]: newSchema })).schema_changes[0];
  assert.ok(change, "a change inside items is reported");
  assert.ok(change.type_changes.some((t) => t.field === "properties.tags.items" && t.from === "string" && t.to === "number"), "items.type change captured");
});

// review-surfaces.SEMANTIC_DIFF.2: a renamed module surfaces the removed old
// import path as well as the added new one.
test("review-surfaces.SEMANTIC_DIFF.2 reports removed exports at a renamed module's old path", () => {
  const oldPath = "src/api.ts";
  const newPath = "src/api2.ts";
  const diffText = [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 90%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    "@@ -1,1 +1,1 @@",
    "-export const moved = 1;",
    "+export const moved = 2;",
    ""
  ].join("\n");
  // Base content lives at the OLD path; head content at the new path.
  const change = computeSemanticChangeFacts({
    diff: parseStructuredDiff(diffText),
    readBase: (p) => (p === oldPath ? "export const moved = 1;\nexport const dropped = 9;" : undefined),
    readHead: (p) => (p === newPath ? "export const moved = 2;" : undefined)
  }).api_changes[0];
  assert.ok(change, "a renamed module produces an API change");
  assert.deepEqual(change.exports_removed, ["dropped"], "the export only in the old version is reported removed");
});

// review-surfaces.SEMANTIC_DIFF.2: a multi-line exported function signature is
// captured whole (param/return type changes on continuation lines are detected).
test("review-surfaces.SEMANTIC_DIFF.2 captures multi-line function signatures", () => {
  const path = "src/build.ts";
  const oldText = "export function build(\n  a: string,\n  b: number\n): Result {\n  return x;\n}\n";
  const newText = "export function build(\n  a: string,\n  b: string\n): Result {\n  return x;\n}\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "build"), "param-type change on a continuation line is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: default-exported function/class APIs are
// tracked under the `default` import contract (not the internal local name, so
// renaming only the local name of a default export is not a breaking change).
test("review-surfaces.SEMANTIC_DIFF.2 detects default-exported signature changes", () => {
  const path = "src/handler.ts";
  const oldText = "export default function handler(req: Req): void {}\n";
  const newText = "export default function handler(req: Req, res: Res): void {}\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "default"), "default export signature change captured");
});

// review-surfaces.SEMANTIC_DIFF.2: a semicolon-less type alias does not swallow
// the exports that follow it.
test("review-surfaces.SEMANTIC_DIFF.2 a semicolonless type alias does not swallow later exports", () => {
  const path = "src/nosemi.ts";
  // No semicolons (e.g. a project with ASI/no-semi style).
  const oldText = "export type Result = A | B\nexport const after = 1\n";
  const newText = "export type Result = A | B\nexport const after = 2\nexport const added = 3\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change, "an API change is reported");
  // `added` must be seen as a new export, not swallowed into the type alias.
  assert.deepEqual(change.exports_added, ["added"]);
  // The type alias itself did not change, so it must NOT be a fabricated signature change.
  assert.ok(!change.signatures_changed.some((s) => s.name === "Result"), "the unchanged alias is not a fabricated change");
});

// review-surfaces.SEMANTIC_DIFF.1: a renamed-and-edited schema is diffed against
// its old path, not silently skipped.
test("review-surfaces.SEMANTIC_DIFF.1 diffs a renamed schema against its old path", () => {
  const oldPath = "schemas/old.schema.json";
  const newPath = "schemas/new.schema.json";
  const diffText = [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 90%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    "@@ -1,1 +1,1 @@",
    "-x",
    "+y",
    ""
  ].join("\n");
  const change = computeSemanticChangeFacts({
    diff: parseStructuredDiff(diffText),
    readBase: (p) => (p === oldPath ? JSON.stringify({ required: ["a"], properties: { a: {} } }) : undefined),
    readHead: (p) => (p === newPath ? JSON.stringify({ required: ["a", "b"], properties: { a: {}, b: {} } }) : undefined)
  }).schema_changes[0];
  assert.ok(change, "a renamed schema is diffed");
  assert.deepEqual(change.required_added, ["b"]);
});

// review-surfaces.SEMANTIC_DIFF.2: a function whose return type is an inline
// object literal does not get truncated at the type-literal brace.
test("review-surfaces.SEMANTIC_DIFF.2 does not stop a signature at a return-type object brace", () => {
  const path = "src/ret.ts";
  const oldText = "export function f(): { a: string } {\n  return { a: '' };\n}\n";
  const newText = "export function f(): { a: number } {\n  return { a: 0 };\n}\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "f"), "return-type object field change is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: declaration (.d.ts) files are part of the API
// surface.
test("review-surfaces.SEMANTIC_DIFF.2 includes .d.ts declaration files", () => {
  const path = "src/public.d.ts";
  const oldText = "export declare interface Options { a: string; }\n";
  const newText = "export declare interface Options { a: string; b: number; }\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "Options"), "a .d.ts interface change is an API change");
});

// review-surfaces.SEMANTIC_DIFF.2: exported abstract classes are recognized.
test("review-surfaces.SEMANTIC_DIFF.2 recognizes exported abstract classes", () => {
  const path = "src/base.ts";
  const oldText = "export abstract class Base extends Foo {}\n";
  const newText = "export abstract class Base extends Bar {}\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "Base"), "abstract class extends change is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.1: a newly-added allOf branch that introduces a
// required field is surfaced, not invisible because the array grew.
test("review-surfaces.SEMANTIC_DIFF.1 diffs an added schema composition branch", () => {
  const path = "schemas/compose.schema.json";
  const oldSchema = JSON.stringify({ allOf: [{ required: ["a"] }] });
  const newSchema = JSON.stringify({ allOf: [{ required: ["a"] }, { required: ["b"], properties: { b: {} } }] });
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldSchema }, { [path]: newSchema })).schema_changes[0];
  assert.ok(change, "the added branch produces a contract change");
  assert.ok(change.required_added.some((f) => f.includes("allOf[1].b")), "the new branch's required field is reported");
});

// review-surfaces.SEMANTIC_DIFF.2: a changed overload in an overload set is a
// signature change (the AST keeps every signature for the shared name).
test("review-surfaces.SEMANTIC_DIFF.2 tracks overload set changes", () => {
  const path = "src/overload.ts";
  const oldText = "export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: any): any { return a; }\n";
  const newText = "export function f(a: string): string;\nexport function f(a: boolean): boolean;\nexport function f(a: any): any { return a; }\n";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "f"), "an altered overload is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: an exported const arrow function's parameter
// change is a signature change; its body is not.
test("review-surfaces.SEMANTIC_DIFF.2 captures const arrow-function signatures, not bodies", () => {
  const path = "src/arrow.ts";
  const paramChange = computeSemanticChangeFacts(sources(
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n"),
    { [path]: "export const f = (a: string): void => { run(a); };" },
    { [path]: "export const f = (a: number): void => { run(a); };" }
  )).api_changes[0];
  assert.ok(paramChange && paramChange.signatures_changed.some((s) => s.name === "f"), "arrow param-type change is a signature change");

  const bodyOnly = computeSemanticChangeFacts(sources(
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n"),
    { [path]: "export const f = (a: string): void => { run(a); };" },
    { [path]: "export const f = (a: string): void => { walk(a); };" }
  )).api_changes;
  assert.equal(bodyOnly.length, 0, "an arrow body-only change is not an API signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: adding/removing an `export *` re-export is a
// surface change keyed by the source module.
test("review-surfaces.SEMANTIC_DIFF.2 detects added star re-exports", () => {
  const path = "src/barrel.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export * from \"./a\";" }, { [path]: "export * from \"./a\";\nexport * from \"./b\";" })).api_changes[0];
  assert.ok(change, "a new star re-export is reported");
  assert.ok(change.exports_added.some((e) => e.includes("./b")), "the added star re-export is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: an exported namespace's presence is tracked.
test("review-surfaces.SEMANTIC_DIFF.2 tracks added/removed exported namespaces", () => {
  const path = "src/ns.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export const x = 1;" }, { [path]: "export const x = 1;\nexport namespace N { export const y = 2; }" })).api_changes[0];
  assert.ok(change && change.exports_added.some((e) => e.includes("N")), "an added exported namespace is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: a re-export whose source module changes is a
// fact (and does not collide with a local export of the same name).
test("review-surfaces.SEMANTIC_DIFF.2 detects a changed re-export source module", () => {
  const path = "src/barrel.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export { thing } from \"./a\";" }, { [path]: "export { thing } from \"./b\";" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "thing"), "the re-export origin change is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: destructuring exports record each bound name.
test("review-surfaces.SEMANTIC_DIFF.2 records destructuring exports", () => {
  const path = "src/destructure.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export const { a } = src;" }, { [path]: "export const { a, b } = src;" })).api_changes[0];
  assert.ok(change && change.exports_added.includes("b"), "a newly destructured export name is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: a re-export whose alias TARGET changes (same
// public name) is a fact.
test("review-surfaces.SEMANTIC_DIFF.2 detects a changed re-export alias target", () => {
  const path = "src/alias.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export { oldName as publicName } from \"./mod\";" }, { [path]: "export { newName as publicName } from \"./mod\";" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "publicName"), "the alias target change is a signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: an anonymous default class body edit is NOT a
// signature change (only API signatures are compared, not member bodies).
test("review-surfaces.SEMANTIC_DIFF.2 ignores anonymous default class body edits", () => {
  const path = "src/anon.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const facts = computeSemanticChangeFacts(sources(diffText, { [path]: "export default class { run() { return 1; } }" }, { [path]: "export default class { run() { return 2; } }" }));
  assert.equal(facts.api_changes.length, 0, "a default-class member body edit is not an API signature change");
});

// review-surfaces.SEMANTIC_DIFF.2: a const with an explicit callable type
// annotation surfaces a type change even when the initializer is unchanged.
test("review-surfaces.SEMANTIC_DIFF.2 preserves declared callable types on const exports", () => {
  const path = "src/typed.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export const f: (x: string) => void = (x) => {};" }, { [path]: "export const f: (x: number) => void = (x) => {};" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "f"), "the declared callable type change is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: a change to a nested exported namespace member
// is part of the API surface.
test("review-surfaces.SEMANTIC_DIFF.2 diffs exported namespace members", () => {
  const path = "src/nsmembers.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export namespace N { export function foo(a: string): void {} }" }, { [path]: "export namespace N { export function foo(a: number): void {} }" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "N.foo"), "a nested namespace member signature change is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: a function/expression signature is compared by
// SHAPE, not by names callers cannot observe or by implementation bodies.
test("review-surfaces.SEMANTIC_DIFF.2 ignores local/inner names and bodies in signatures", () => {
  const path = "src/names.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");

  // A default export's local name is invisible to importers — renaming it is a no-op.
  assert.equal(
    computeSemanticChangeFacts(sources(diffText, { [path]: "export default function handler(req: Req): void {}" }, { [path]: "export default function renamed(req: Req): void {}" })).api_changes.length,
    0,
    "renaming a default export's local name is not a change"
  );

  // A default arrow expression's body edit is not a signature change.
  assert.equal(
    computeSemanticChangeFacts(sources(diffText, { [path]: "export default (req: Req): number => { return 1; }" }, { [path]: "export default (req: Req): number => { return 2; }" })).api_changes.length,
    0,
    "a default arrow body edit is not a signature change"
  );

  // A named function expression's inner name is not part of the const's surface.
  assert.equal(
    computeSemanticChangeFacts(sources(diffText, { [path]: "export const f = function internal(x: string): void {};" }, { [path]: "export const f = function renamed(x: string): void {};" })).api_changes.length,
    0,
    "renaming a function expression's inner name is not a change"
  );

  // ...but the actual parameter shape change IS still detected.
  const real = computeSemanticChangeFacts(sources(diffText, { [path]: "export default function h(req: Req): void {}" }, { [path]: "export default function h(req: Req, res: Res): void {}" })).api_changes[0];
  assert.ok(real && real.signatures_changed.some((s) => s.name === "default"), "a real default signature change is still detected");
});

// review-surfaces.SEMANTIC_DIFF.2: a default class local rename is a no-op, but a
// heritage change is still a fact.
test("review-surfaces.SEMANTIC_DIFF.2 ignores default class local names", () => {
  const path = "src/dc.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  assert.equal(
    computeSemanticChangeFacts(sources(diffText, { [path]: "export default class Handler extends Base {}" }, { [path]: "export default class Renamed extends Base {}" })).api_changes.length,
    0,
    "renaming a default class is not a change"
  );
  const real = computeSemanticChangeFacts(sources(diffText, { [path]: "export default class C extends Base {}" }, { [path]: "export default class C extends Other {}" })).api_changes[0];
  assert.ok(real && real.signatures_changed.some((s) => s.name === "default"), "a heritage change is still a fact");
});

// review-surfaces.SEMANTIC_DIFF.2: a destructured export's type annotation change
// is surfaced.
test("review-surfaces.SEMANTIC_DIFF.2 surfaces destructured export type changes", () => {
  const path = "src/dt.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export const { a }: { a: string } = src;" }, { [path]: "export const { a }: { a: number } = src;" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "a"), "the destructured type change is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: a re-export switching to type-only drops the
// runtime export — a fact for value importers.
test("review-surfaces.SEMANTIC_DIFF.2 tracks type-only re-export markers", () => {
  const path = "src/to.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export { Foo } from \"./mod\";" }, { [path]: "export { type Foo } from \"./mod\";" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "Foo"), "the runtime→type-only change is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: a dotted namespace's nested members are reached.
test("review-surfaces.SEMANTIC_DIFF.2 recurses into dotted namespaces", () => {
  const path = "src/dn.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export namespace A.B { export function f(x: string): void {} }" }, { [path]: "export namespace A.B { export function f(x: number): void {} }" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "A.B.f"), "a dotted-namespace member change is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: `export default <identifier>` is compared by
// what the identifier refers to.
test("review-surfaces.SEMANTIC_DIFF.2 resolves identifier default exports", () => {
  const path = "src/id.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "const handler = (req: Req): void => {};\nexport default handler;" }, { [path]: "const handler = (req: Req, res: Res): void => {};\nexport default handler;" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "default"), "a change to the referenced local is a default-export change");
});

// review-surfaces.SEMANTIC_DIFF.2: a star/namespace re-export switching to
// type-only drops the runtime export.
test("review-surfaces.SEMANTIC_DIFF.2 tracks type-only star re-exports", () => {
  const path = "src/star.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export * from \"./mod\";" }, { [path]: "export type * from \"./mod\";" })).api_changes[0];
  assert.ok(change && change.signatures_changed.length > 0, "the runtime→type-only star change is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: a typed default-var local rename is a no-op.
test("review-surfaces.SEMANTIC_DIFF.2 ignores typed default-var local names", () => {
  const path = "src/tdv.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  assert.equal(
    computeSemanticChangeFacts(sources(diffText, { [path]: "const handler: Handler = make();\nexport default handler;" }, { [path]: "const renamed: Handler = make();\nexport default renamed;" })).api_changes.length,
    0,
    "renaming a typed default-export local is not a change"
  );
});

// review-surfaces.SEMANTIC_DIFF.2: a local `export { handler }` is compared by
// what the local refers to.
test("review-surfaces.SEMANTIC_DIFF.2 resolves local named exports", () => {
  const path = "src/lne.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "const handler = (req: Req): void => {};\nexport { handler };" }, { [path]: "const handler = (req: Req, res: Res): void => {};\nexport { handler };" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "handler"), "a change to the local export's shape is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: an overload implementation edit is not an API
// change when the public overloads are unchanged.
test("review-surfaces.SEMANTIC_DIFF.2 excludes overload implementation signatures", () => {
  const path = "src/ovl.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const oldText = "export function f(x: string): string;\nexport function f(x: number): number;\nexport function f(x: any): any { return x; }";
  const newText = "export function f(x: string): string;\nexport function f(x: number): number;\nexport function f(x: unknown): unknown { return x; }";
  assert.equal(
    computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes.length,
    0,
    "editing only the overload implementation is not an API change"
  );
});

// review-surfaces.SEMANTIC_DIFF.2: a destructured type change is attributed to the
// changed leaf, not its siblings.
test("review-surfaces.SEMANTIC_DIFF.2 attributes destructured type changes to the changed leaf", () => {
  const path = "src/dla.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export const { a, b }: { a: string; b: number } = src;" }, { [path]: "export const { a, b }: { a: string; b: string } = src;" })).api_changes[0];
  assert.ok(change, "the change is reported");
  const changedNames = change.signatures_changed.map((s) => s.name);
  assert.ok(changedNames.includes("b"), "the changed leaf b is reported");
  assert.ok(!changedNames.includes("a"), "the unchanged leaf a is NOT reported");
});

// review-surfaces.SEMANTIC_DIFF.2: a locally-exported type's body change is seen.
test("review-surfaces.SEMANTIC_DIFF.2 resolves local type-only exports", () => {
  const path = "src/lt.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "interface Options { a: string; }\nexport type { Options };" }, { [path]: "interface Options { a: string; b: number; }\nexport type { Options };" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "Options"), "a local interface body change behind a type-only export is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: a destructured local re-exported via a list is
// compared by its leaf shape.
test("review-surfaces.SEMANTIC_DIFF.2 resolves destructured locals in export lists", () => {
  const path = "src/dlx.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "const { handler }: { handler: (a: string) => void } = mod;\nexport { handler };" }, { [path]: "const { handler }: { handler: (a: number) => void } = mod;\nexport { handler };" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "handler"), "a destructured local's type change behind an export list is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: optionality on a destructured member type is
// part of the contract.
test("review-surfaces.SEMANTIC_DIFF.2 preserves optionality on destructured member types", () => {
  const path = "src/opt.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export const { a }: { a?: string } = src;" }, { [path]: "export const { a }: { a: string } = src;" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "a"), "optional→required on a destructured member is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: a parenthesized function initializer is
// recognized.
test("review-surfaces.SEMANTIC_DIFF.2 unwraps parenthesized function initializers", () => {
  const path = "src/paren.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: "export const f = ((x: string): void => {});" }, { [path]: "export const f = ((x: number): void => {});" })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "f"), "a parenthesized arrow's param change is surfaced");
});

// review-surfaces.SEMANTIC_DIFF.2: all overloads of a locally-exported function
// contribute to the signature.
test("review-surfaces.SEMANTIC_DIFF.2 aggregates overloads for local export lists", () => {
  const path = "src/ovx.ts";
  const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
  const oldText = "function f(x: string): string;\nfunction f(x: number): number;\nfunction f(x: any): any { return x; }\nexport { f };";
  const newText = "function f(x: string): string;\nfunction f(x: boolean): boolean;\nfunction f(x: any): any { return x; }\nexport { f };";
  const change = computeSemanticChangeFacts(sources(diffText, { [path]: oldText }, { [path]: newText })).api_changes[0];
  assert.ok(change && change.signatures_changed.some((s) => s.name === "f"), "a change to a later overload behind an export list is surfaced");
});

// A test file is not treated as an API surface.
test("review-surfaces.SEMANTIC_DIFF.2 ignores test files for API surface", () => {
  const path = "tests/x.test.ts";
  const facts = computeSemanticChangeFacts(
    sources([`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n"), { [path]: "export const a = 1;" }, { [path]: "export const a = 2;\nexport const b = 3;" })
  );
  assert.equal(facts.api_changes.length, 0);
});
