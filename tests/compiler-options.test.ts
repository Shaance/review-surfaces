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
    "packages/absolute/types.ts": "export interface Options { enabled: boolean }"
  };
  const reads = new Map<string, number>();
  const resolver = createRuntimeImportResolver((filePath) => {
    reads.set(filePath, (reads.get(filePath) ?? 0) + 1);
    return files[filePath];
  }, process.cwd());
  const exists = (filePath: string): boolean => filePath in files;
  const source = 'import { Options } from "./types"; export type Config = Options;';

  assert.deepEqual(resolver("packages/app/main.ts", source, exists), ["packages/app/types.ts"]);
  assert.deepEqual(resolver("packages/absolute/main.ts", source, exists), ["packages/absolute/types.ts"]);
  resolver("packages/app/other.ts", source, exists);
  assert.equal(reads.get("packages/app/node_modules/@config/base/tsconfig.json"), 1, "resolved package configs are read once");
});
