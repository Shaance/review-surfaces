import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateJsonFile } from "../src/schema/json-schema";

// Generality proof: a small, non-review-surfaces JS project with NO `areas`
// config still produces a valid packet, classifies its changed files, derives
// clusters, and reports REVIEW-SIZED overreach (not one finding per file).

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "foreign-repo");

function copyForeignFixture(targetDir: string): void {
  fs.cpSync(FIXTURE_ROOT, targetDir, { recursive: true });
  // Schemas live at the review-surfaces repo root; the CLI resolves the schema
  // relative to cwd, so make it available inside the foreign repo too.
  fs.mkdirSync(path.join(targetDir, "schemas"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "schemas", "review_packet.schema.json"),
    path.join(targetDir, "schemas", "review_packet.schema.json")
  );
}

test("review-surfaces works on a foreign repo with no areas config", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-foreign-"));
  copyForeignFixture(tmp);

  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tmp, stdio: "ignore" });

  // Make a real change so the diff has content: edit two source files and the
  // test. These changes do not map to any spec group (no areas configured), so
  // they should be reported as a small number of review-sized overreach
  // clusters rather than one finding per file.
  fs.appendFileSync(path.join(tmp, "src", "api.js"), "\nexport function removeTodo(store, id) {\n  return store.update(id, { done: false });\n}\n");
  fs.appendFileSync(path.join(tmp, "src", "store.js"), "\n// touch storage layer\n");
  fs.appendFileSync(path.join(tmp, "test", "api.test.js"), "\n// touch test\n");

  execFileSync(
    "node",
    [
      path.join(process.cwd(), "dist", "src", "cli", "index.js"),
      "dogfood",
      "--provider",
      "mock",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--out",
      ".review-surfaces"
    ],
    { cwd: tmp, stdio: "ignore" }
  );

  // (a) The packet validates against the shared schema.
  const validation = await validateJsonFile(
    path.join(tmp, "schemas", "review_packet.schema.json"),
    path.join(tmp, ".review-surfaces", "review_packet.json")
  );
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));

  // (b) Changed files are classified in repo.index.json.
  const repoIndex = JSON.parse(
    fs.readFileSync(path.join(tmp, ".review-surfaces", "inputs", "repo.index.json"), "utf8")
  );
  const indexedPaths = new Map<string, string>(repoIndex.files.map((file: { path: string; classification: string }) => [file.path, file.classification]));
  assert.equal(indexedPaths.get("src/api.js"), "source");
  assert.equal(indexedPaths.get("src/store.js"), "source");
  assert.equal(indexedPaths.get("test/api.test.js"), "test");

  // (c) Clusters are derived (at least one), and source/test land in clusters.
  assert.ok(Array.isArray(repoIndex.clusters));
  assert.ok(repoIndex.clusters.length >= 1);
  const allClusterFiles = repoIndex.clusters.flatMap((cluster: { files: string[] }) => cluster.files);
  assert.ok(allClusterFiles.includes("src/api.js"));
  assert.ok(allClusterFiles.includes("test/api.test.js"));

  // (d) Overreach is review-sized: far fewer findings than changed files, and
  // never one finding per file. With no areas, all changed source/test files
  // are unmapped, so they collapse into per-cluster overreach findings.
  const packet = JSON.parse(fs.readFileSync(path.join(tmp, ".review-surfaces", "review_packet.json"), "utf8"));
  const overreach = packet.evaluation.overreach as Array<{ summary: string }>;
  const changedSourceTest = repoIndex.files.filter(
    (file: { classification: string }) => file.classification === "source" || file.classification === "test"
  ).length;
  assert.ok(changedSourceTest >= 3, `expected >= 3 changed source/test files, got ${changedSourceTest}`);
  assert.ok(overreach.length >= 1, "expected at least one overreach finding");
  assert.ok(
    overreach.length < changedSourceTest,
    `overreach must be review-sized, got ${overreach.length} findings for ${changedSourceTest} files`
  );
  assert.ok(
    overreach.length <= repoIndex.clusters.length + 1,
    `overreach (${overreach.length}) must be bounded by cluster count (${repoIndex.clusters.length})`
  );
  assert.ok(
    overreach.every((finding) => finding.summary.includes("Unmapped cluster")),
    "fallback overreach must be reported as unmapped clusters"
  );

  // The packet's architecture cards/diagrams still render generically.
  assert.ok(packet.architecture.diagram_validation.every((result: { status: string }) => result.status === "valid"));
});
