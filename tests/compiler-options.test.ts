import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeImportResolver } from "../src/collector/compiler-options";

test("architecture runtime imports honor the nearest package tsconfig and its relative extends", () => {
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { verbatimModuleSyntax: false } }),
    "packages/app/emit.json": JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
    "packages/app/tsconfig.json": JSON.stringify({
      extends: ["../../tsconfig.json", "./emit.json"]
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
