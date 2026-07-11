import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectInputs } from "../src/collector/collect";
import { collectChangedFiles, MAX_UNTRACKED_REVIEW_BYTES, MAX_UNTRACKED_REVIEW_FILES } from "../src/collector/git";
import { defaultConfig } from "../src/config/config";

test("collector bounds untracked review scope and reports deterministic omissions", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-untracked-budget-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "README.md"), "# base\n");
    execFileSync("git", ["add", "README.md"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
    for (let index = 0; index < MAX_UNTRACKED_REVIEW_FILES + 2; index += 1) {
      fs.writeFileSync(path.join(tmp, `untracked-${String(index).padStart(3, "0")}.ts`), `export const n = ${index};\n`);
    }
    const result = collectChangedFiles(tmp, "HEAD", "HEAD");
    assert.equal(result.files.length, MAX_UNTRACKED_REVIEW_FILES);
    assert.match(result.diagnostics.join("\n"), /omitted 2 untracked file\(s\).*review budget/);
    assert.equal(result.files[0].path, "untracked-000.ts");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectInputs uses one bounded untracked selection for changed files and diff", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-untracked-shared-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "README.md"), "# base\n");
    execFileSync("git", ["add", "README.md"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "candidate-000.ts"), "export const n = 0;\n");
    fs.writeFileSync(path.join(tmp, "candidate-001.bin"), Buffer.alloc(MAX_UNTRACKED_REVIEW_BYTES + 1));
    const result = await collectInputs({
      cwd: tmp,
      config: { ...defaultConfig, specs: [], docs: [], tests: [], output_dir: ".review-surfaces" },
      baseRef: "HEAD",
      headRef: "HEAD",
      dogfood: false
    });
    const selected = result.changedFiles.filter((file) => file.path.startsWith("candidate-")).map((file) => file.path);
    const patchText = fs.readFileSync(path.join(tmp, ".review-surfaces", "inputs", "diff.patch"), "utf8");
    assert.deepEqual(selected, ["candidate-000.ts"]);
    assert.equal(result.manifest.uncommitted_files, 1);
    assert.equal(result.manifest.omitted_untracked_files, 1);
    for (const filePath of selected) assert.match(patchText, new RegExp(filePath.replace(".", "\\.")));
    assert.doesNotMatch(patchText, /candidate-001\.bin/);
    assert.equal(result.diagnostics.filter((line) => line.includes("untracked file(s)")).length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("privacy-ignored untracked files cannot consume the review budget", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-untracked-ignore-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "README.md"), "# base\n");
    fs.writeFileSync(path.join(tmp, ".review-surfacesignore"), "ignored-*.ts\n");
    execFileSync("git", ["add", "README.md", ".review-surfacesignore"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: tmp, stdio: "ignore" });
    for (let index = 0; index < MAX_UNTRACKED_REVIEW_FILES + 1; index += 1) {
      fs.writeFileSync(path.join(tmp, `ignored-${String(index).padStart(3, "0")}.ts`), "secret fixture\n");
    }
    fs.writeFileSync(path.join(tmp, "z-reviewable.ts"), "export const reviewed = true;\n");
    const result = await collectInputs({
      cwd: tmp,
      config: { ...defaultConfig, specs: [], docs: [], tests: [], output_dir: ".review-surfaces" },
      baseRef: "HEAD",
      headRef: "HEAD",
      dogfood: false
    });
    assert.ok(result.changedFiles.some((file) => file.path === "z-reviewable.ts"));
    assert.ok(result.privacy.ignored_changed_files.includes("ignored-000.ts"));
    assert.ok(!result.diagnostics.some((line) => line.includes("review budget")));
    const patchText = fs.readFileSync(path.join(tmp, ".review-surfaces", "inputs", "diff.patch"), "utf8");
    assert.match(patchText, /z-reviewable\.ts/);
    assert.doesNotMatch(patchText, /ignored-\d+\.ts|secret fixture/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

