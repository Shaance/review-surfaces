import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateJsonFile } from "../src/schema/json-schema";

// Generality proof on a NON-TS, mixed node+python repo: the indexer must detect
// the `python` ecosystem (keyed on pyproject.toml), classify .py source/test
// files, derive clusters, and still produce a schema-valid packet. This is the
// first test asserting repoIndex.ecosystems on a non-node repo; it mirrors the
// foreign-repo.test.ts structure (copy fixture to tmp, git init, copy schema,
// run dogfood --provider mock). Because the fixture keeps package.json too, the
// ecosystems list is id-sorted to ['node', 'python'].

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "foreign-repo-python");

function copyForeignFixture(targetDir: string): void {
  fs.cpSync(FIXTURE_ROOT, targetDir, { recursive: true });
  // The CLI resolves the schema relative to cwd; make it available inside the
  // foreign repo too.
  fs.mkdirSync(path.join(targetDir, "schemas"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "schemas", "review_packet.schema.json"),
    path.join(targetDir, "schemas", "review_packet.schema.json")
  );
}

test("review-surfaces detects the python ecosystem and classifies .py files on a foreign repo", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-foreign-python-"));
  copyForeignFixture(tmp);

  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tmp, stdio: "ignore" });

  // Real changes so the diff has content: touch the python source and test.
  fs.appendFileSync(
    path.join(tmp, "src", "app.py"),
    "\n\ndef remove_todo(store, todo_id):\n    return store.update(todo_id, {\"done\": False})\n"
  );
  fs.appendFileSync(path.join(tmp, "tests", "test_app.py"), "\n\n# touch the test\n");

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

  const repoIndex = JSON.parse(
    fs.readFileSync(path.join(tmp, ".review-surfaces", "inputs", "repo.index.json"), "utf8")
  ) as {
    files: Array<{ path: string; classification: string; language?: string }>;
    ecosystems: Array<{ id: string; evidence?: string }>;
    clusters: Array<{ files: string[] }>;
  };

  // (b) The ecosystems list CONTAINS an entry with id 'python' (keyed on the
  // committed pyproject.toml). The mixed fixture also detects 'node'.
  const ecosystemIds = repoIndex.ecosystems.map((eco) => eco.id);
  assert.ok(ecosystemIds.includes("python"), `ecosystems must contain python, got ${JSON.stringify(ecosystemIds)}`);
  assert.ok(ecosystemIds.includes("node"), `the mixed fixture also detects node, got ${JSON.stringify(ecosystemIds)}`);
  // Deterministic id-sort: node before python.
  assert.deepEqual(
    ecosystemIds.filter((id) => id === "node" || id === "python"),
    ["node", "python"],
    "ecosystems are id-sorted so node precedes python"
  );

  // (c) The changed .py files are classified source/test.
  const classification = new Map(repoIndex.files.map((file) => [file.path, file.classification]));
  assert.equal(classification.get("src/app.py"), "source");
  assert.equal(classification.get("tests/test_app.py"), "test");

  // (d) Clusters are derived, and the changed .py files land in clusters.
  assert.ok(Array.isArray(repoIndex.clusters));
  assert.ok(repoIndex.clusters.length >= 1, "at least one cluster is derived");
  const clusteredFiles = repoIndex.clusters.flatMap((cluster) => cluster.files);
  assert.ok(clusteredFiles.includes("src/app.py"), "the python source file lands in a cluster");
  assert.ok(clusteredFiles.includes("tests/test_app.py"), "the python test file lands in a cluster");
});
