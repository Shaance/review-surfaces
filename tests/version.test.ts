import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "../src/core/version";

// review-surfaces R7: VERSION must stay byte-identical to package.json so the
// manifest tool_version, help banner, and scaffolded feature-spec version never
// drift. Read package.json from the repo root (tests run with cwd = repo root).
test("core/version VERSION equals package.json version", () => {
  const pkgPath = path.resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.equal(VERSION, pkg.version);
});
