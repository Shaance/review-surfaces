import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRuntimeImportResolver } from "../src/collector/compiler-options";

test("architecture runtime imports honor the nearest package tsconfig and its relative extends", () => {
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { verbatimModuleSyntax: false } }),
    "packages/app/common.json": JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
    "packages/app/first.json": JSON.stringify({
      extends: "./common.json",
      compilerOptions: { verbatimModuleSyntax: false }
    }),
    "packages/app/second.json": JSON.stringify({ extends: "./common.json" }),
    "packages/app/tsconfig.json": JSON.stringify({
      extends: ["../../tsconfig.json", "./first.json", "./second.json"]
    }),
    "packages/app/types.ts": "export interface Options { enabled: boolean }",
    "src/types.ts": "export interface Options { enabled: boolean }"
  };
  const resolver = createRuntimeImportResolver((filePath) => files[filePath], process.cwd());
  const exists = (filePath: string): boolean => filePath in files;

  assert.deepEqual(
    resolver("packages/app/main.ts", 'import { Options } from "./types"; export type Config = Options;', exists),
    ["packages/app/types.ts"]
  );
  assert.deepEqual(
    resolver("src/main.ts", 'import { Options } from "./types"; export type Config = Options;', exists),
    []
  );
});

test("architecture runtime imports resolve package and repo-absolute tsconfig bases", () => {
  const files: Record<string, string> = {
    "node_modules/@config/base/tsconfig.json": JSON.stringify({ compilerOptions: { verbatimModuleSyntax: false } }),
    "packages/app/node_modules/@config/base/tsconfig.json": JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
    "packages/app/tsconfig.json": JSON.stringify({ extends: "@config/base/tsconfig.json" }),
    "packages/app/types.ts": "export interface Options { enabled: boolean }",
    "configs/absolute.json": JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
    "packages/absolute/tsconfig.json": JSON.stringify({ extends: path.join(process.cwd(), "configs/absolute.json") }),
    "packages/absolute/types.ts": "export interface Options { enabled: boolean }",
    "packages/new/tsconfig.json": JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
    "packages/new/types.ts": "export interface Options { enabled: boolean }"
  };
  const reads = new Map<string, number>();
  const reader = (filePath: string): string | undefined => {
    reads.set(filePath, (reads.get(filePath) ?? 0) + 1);
    return files[filePath];
  };
  const resolver = createRuntimeImportResolver(reader, process.cwd(), { reviewedPaths: new Set(Object.keys(files)) });
  const exists = (filePath: string): boolean => filePath in files;
  const source = 'import { Options } from "./types"; export type Config = Options;';

  assert.deepEqual(resolver("packages/app/main.ts", source, exists), ["packages/app/types.ts"]);
  assert.deepEqual(resolver("packages/absolute/main.ts", source, exists), ["packages/absolute/types.ts"]);
  resolver("packages/app/other.ts", source, exists);
  assert.equal(reads.get("packages/app/node_modules/@config/base/tsconfig.json"), 1, "resolved package configs are read once");

  const withoutInstalledPackage = createRuntimeImportResolver(reader, process.cwd(), {
    reviewedPaths: new Set(Object.keys(files).filter((filePath) => !filePath.includes("node_modules")))
  });
  assert.deepEqual(
    withoutInstalledPackage("packages/app/untracked-package.ts", source, exists),
    [],
    "an installed but unreviewed package config cannot change architecture evidence"
  );

  const withIgnoredPackageConfig = createRuntimeImportResolver(reader, process.cwd(), {
    reviewedPaths: new Set(Object.keys(files)),
    isIgnored: (filePath) => filePath.includes("node_modules")
  });
  assert.deepEqual(
    withIgnoredPackageConfig("packages/app/ignored-package.ts", source, exists),
    [],
    "an ignored config cannot influence architecture evidence even when tracked"
  );

  const withReviewedUntrackedConfig = createRuntimeImportResolver(reader, process.cwd(), {
    reviewedPaths: new Set(["packages/new/tsconfig.json", "packages/new/types.ts"])
  });
  assert.deepEqual(
    withReviewedUntrackedConfig("packages/new/main.ts", source, exists),
    ["packages/new/types.ts"],
    "an untracked config explicitly included in the review still governs architecture evidence"
  );
});
