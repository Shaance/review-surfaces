#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const root = resolve(dirname(__filename), "..");
const compiledEntry = resolve(root, "dist/src/cli/index.js");
if (!existsSync(compiledEntry)) {
  console.error("review-surfaces is not built. Run `pnpm run build` first.");
  process.exit(1);
}

const args = [compiledEntry, ...process.argv.slice(2)];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
