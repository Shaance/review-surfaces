import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRepoIndex, classifyFile, detectLanguage, RepoIndex } from "../src/indexer/indexer";
import { ChangedFile } from "../src/collector/git";

function changed(paths: string[]): ChangedFile[] {
  return paths.map((p) => ({ path: p, status: "M", source: "diff" as const }));
}

test("classifies changed files per TRD section 10.2 heuristics", () => {
  assert.equal(classifyFile("src/indexer/indexer.ts"), "source");
  assert.equal(classifyFile("tests/indexer.test.ts"), "test");
  assert.equal(classifyFile("src/foo.spec.ts"), "test");
  assert.equal(classifyFile("test/legacy.js"), "test");
  assert.equal(classifyFile("README.md"), "docs");
  assert.equal(classifyFile("docs/guide.txt"), "docs");
  assert.equal(classifyFile("package.json"), "config");
  assert.equal(classifyFile("tsconfig.json"), "config");
  assert.equal(classifyFile(".eslintrc"), "config");
  assert.equal(classifyFile("vite.config.ts"), "config");
  assert.equal(classifyFile("review-surfaces.config.yaml"), "config");
  assert.equal(classifyFile("settings.toml"), "config");
  assert.equal(classifyFile("pnpm-lock.yaml"), "lockfile");
  assert.equal(classifyFile("go.sum"), "lockfile");
  assert.equal(classifyFile("Cargo.lock"), "lockfile");
  assert.equal(classifyFile("dist/bundle.js"), "generated");
  assert.equal(classifyFile("build/out.ts"), "generated");
  assert.equal(classifyFile("vendor/lib.min.js"), "generated");
  assert.equal(classifyFile("LICENSE"), "unknown");
  assert.equal(classifyFile("data.bin"), "unknown");
});

test("detects language from extension", () => {
  assert.equal(detectLanguage("src/a.ts"), "typescript");
  assert.equal(detectLanguage("src/a.tsx"), "typescript");
  assert.equal(detectLanguage("src/a.js"), "javascript");
  assert.equal(detectLanguage("main.py"), "python");
  assert.equal(detectLanguage("main.go"), "go");
  assert.equal(detectLanguage("main.rs"), "rust");
  assert.equal(detectLanguage("data.json"), "json");
  assert.equal(detectLanguage("config.yaml"), "yaml");
  assert.equal(detectLanguage("README.md"), "markdown");
  assert.equal(detectLanguage("run.sh"), "shell");
  assert.equal(detectLanguage("LICENSE"), "other");
});

test("detects ecosystems from manifest files in repository", () => {
  const index = buildRepoIndex({
    cwd: "/nonexistent",
    changedFiles: [],
    repositoryFiles: [
      "package.json",
      "pnpm-lock.yaml",
      "service/pyproject.toml",
      "tooling/go.mod",
      "crate/Cargo.toml",
      "src/index.ts"
    ]
  });
  assert.deepEqual(
    index.ecosystems.map((e) => e.id),
    ["go", "node", "python", "rust"]
  );
  const node = index.ecosystems.find((e) => e.id === "node");
  assert.equal(node?.evidence, "package.json");
  const python = index.ecosystems.find((e) => e.id === "python");
  assert.equal(python?.evidence, "service/pyproject.toml");
});

test("detects node ecosystem from requirements.txt and python from pyproject", () => {
  const index = buildRepoIndex({
    cwd: "/nonexistent",
    changedFiles: [],
    repositoryFiles: ["app/requirements.txt"]
  });
  assert.deepEqual(index.ecosystems.map((e) => e.id), ["python"]);
  assert.equal(index.ecosystems[0].evidence, "app/requirements.txt");
});

test("clusters group by directory and sort deterministically", () => {
  const index = buildRepoIndex({
    cwd: "/nonexistent",
    changedFiles: changed([
      "src/billing/charge.ts",
      "src/billing/refund.ts",
      "src/auth/login.ts",
      "README.md",
      "package.json"
    ]),
    repositoryFiles: []
  });
  // docs and config files are excluded from clusters.
  const allFiles = index.clusters.flatMap((c) => c.files);
  assert.ok(!allFiles.includes("README.md"));
  assert.ok(!allFiles.includes("package.json"));

  assert.deepEqual(
    index.clusters.map((c) => c.id),
    ["cluster:src/auth", "cluster:src/billing"]
  );
  const billing = index.clusters.find((c) => c.id === "cluster:src/billing");
  assert.deepEqual(billing?.files, ["src/billing/charge.ts", "src/billing/refund.ts"]);
  assert.deepEqual(billing?.dirs, ["src/billing"]);
  assert.equal(billing?.language, "typescript");
});

test("output is deterministic regardless of input order", () => {
  const build = (paths: string[]): RepoIndex =>
    buildRepoIndex({ cwd: "/nonexistent", changedFiles: changed(paths), repositoryFiles: ["package.json"] });
  const a = build(["src/b/two.ts", "src/a/one.ts", "src/a/two.ts"]);
  const b = build(["src/a/two.ts", "src/b/two.ts", "src/a/one.ts"]);
  assert.deepEqual(a, b);
});

test("import adjacency merges tightly-coupled directory clusters", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-indexer-merge-"));
  fs.mkdirSync(path.join(tmp, "src", "core"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "feature"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src", "standalone"), { recursive: true });

  // feature imports core via a relative specifier -> the two dirs merge.
  fs.writeFileSync(
    path.join(tmp, "src", "feature", "handler.ts"),
    `import { helper } from "../core/util";\nexport const handle = () => helper();\n`
  );
  fs.writeFileSync(path.join(tmp, "src", "core", "util.ts"), `export const helper = () => 1;\n`);
  // standalone imports only a bare package -> stays separate.
  fs.writeFileSync(
    path.join(tmp, "src", "standalone", "alone.ts"),
    `import path from "node:path";\nexport const p = path;\n`
  );

  const index = buildRepoIndex({
    cwd: tmp,
    changedFiles: changed([
      "src/feature/handler.ts",
      "src/core/util.ts",
      "src/standalone/alone.ts"
    ]),
    repositoryFiles: []
  });

  // feature + core merge into one cluster keyed by the smaller root (src/core).
  const merged = index.clusters.find((c) => c.files.includes("src/feature/handler.ts"));
  assert.ok(merged, "expected a cluster containing the feature handler");
  assert.ok(merged?.files.includes("src/core/util.ts"), "expected core merged into feature cluster");
  assert.deepEqual(merged?.dirs, ["src/core", "src/feature"]);
  assert.equal(merged?.id, "cluster:src/core");

  // standalone is not pulled in by a bare specifier.
  const standalone = index.clusters.find((c) => c.id === "cluster:src/standalone");
  assert.ok(standalone, "standalone cluster should remain separate");
  assert.deepEqual(standalone?.files, ["src/standalone/alone.ts"]);

  assert.equal(index.clusters.length, 2);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("unreadable import sources are skipped gracefully", () => {
  // file referenced in changedFiles does not exist on disk; build must not throw.
  const index = buildRepoIndex({
    cwd: "/nonexistent-root",
    changedFiles: changed(["src/ghost/missing.ts"]),
    repositoryFiles: []
  });
  assert.deepEqual(index.clusters.map((c) => c.id), ["cluster:src/ghost"]);
});
