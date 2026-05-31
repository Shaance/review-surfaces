import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateJsonFile } from "../src/schema/json-schema";
import { initGitRepo, runCli } from "./helpers/cli-repo";

// Exercises the Lane C/E git-degradation observability: CollectionResult now
// carries diagnostics[] + diff_source, surfaced to stderr (never to the
// byte-stable artifacts). These cases assert that the three degraded-git modes
// exit cleanly (no crash/stack), emit a diagnostic, and still produce a valid
// packet. Assertions are membership/exit-code/sentinel based, not exact wording.

const DOGFOOD_ARGS = ["dogfood", "--provider", "mock", "--base", "HEAD", "--head", "HEAD"];

function copySchema(targetDir: string): void {
  fs.mkdirSync(path.join(targetDir, "schemas"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "schemas", "review_packet.schema.json"),
    path.join(targetDir, "schemas", "review_packet.schema.json")
  );
}

// A clean DEGRADATION exits 0 (these dogfood runs fail gently without --strict),
// NOT a crash: a signal exit is status null and a thrown runtime error exits 1
// (runtimeError) — both are rejected here, so a caught-but-real failure cannot
// masquerade as a clean degradation. We also reject an uncaught stack trace.
function assertCleanExit(result: { status: number | null; stderr: string }, context: string): void {
  assert.equal(result.status, 0, `${context}: a degraded-but-clean run must exit 0, got ${result.status}\n${result.stderr}`);
  assert.doesNotMatch(
    result.stderr,
    /at Object\.|at process\.|Error: .*\n\s+at /,
    `${context}: stderr must be a diagnostic, not an uncaught stack trace:\n${result.stderr}`
  );
}

test("git-failure-mode: running OUTSIDE a git repo exits cleanly with a diagnostic", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-gitfail-norepo-"));
  try {
    copySchema(tmp);
    // No initGitRepo: tmp is not a git repository.
    const result = runCli(tmp, DOGFOOD_ARGS);
    assertCleanExit(result, "outside a git repo");

    // A diagnostic about the missing repo is surfaced to stderr.
    assert.match(result.stderr, /not a git repository/, `expected a no-git diagnostic, got:\n${result.stderr}`);

    // The packet is still produced and the head_sha falls back to the sentinel.
    const validation = await validateJsonFile(
      path.join(tmp, "schemas", "review_packet.schema.json"),
      path.join(tmp, ".review-surfaces", "review_packet.json")
    );
    assert.equal(validation.valid, true, JSON.stringify(validation.issues));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmp, ".review-surfaces", "manifest.json"), "utf8")
    ) as { head_sha?: string };
    assert.equal(manifest.head_sha, "unknown", "outside a git repo head_sha falls back to the unknown sentinel");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("git-failure-mode: an unknown --base ref exits cleanly, warns, and still emits a valid packet", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-gitfail-base-"));
  try {
    fs.writeFileSync(path.join(tmp, "README.md"), "# repo\n");
    fs.writeFileSync(path.join(tmp, ".gitignore"), ".review-surfaces/\n");
    copySchema(tmp);
    initGitRepo(tmp);

    const result = runCli(tmp, ["dogfood", "--provider", "mock", "--base", "does-not-exist", "--head", "HEAD"]);
    assertCleanExit(result, "unknown --base");

    // A diagnostic names the unresolved base ref and the working-tree fallback.
    assert.match(result.stderr, /does-not-exist/, `the diagnostic must name the unresolved base ref:\n${result.stderr}`);
    assert.match(
      result.stderr,
      /did not resolve|working[- ]tree/,
      `the diagnostic must describe the unresolved base / working-tree fallback:\n${result.stderr}`
    );

    // The emitted packet is still schema-valid (the run degrades, it does not fail).
    const validation = await validateJsonFile(
      path.join(tmp, "schemas", "review_packet.schema.json"),
      path.join(tmp, ".review-surfaces", "review_packet.json")
    );
    assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("git-failure-mode: an empty repo (init, no commit) exits cleanly with a diagnostic", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-gitfail-empty-"));
  try {
    copySchema(tmp);
    // git init only; no commit, so HEAD does not resolve.
    execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });

    const result = runCli(tmp, DOGFOOD_ARGS);
    assertCleanExit(result, "empty repo");

    // Some git diagnostic is surfaced (the unresolved HEAD / empty range).
    assert.match(
      result.stderr,
      /did not resolve|working[- ]tree|not a git repository|could not/,
      `an empty repo must surface a git diagnostic, got:\n${result.stderr}`
    );

    // Positive assertion (matches the other two cases): the run actually SUCCEEDS
    // and writes a schema-valid packet, so a caught-but-real failure that happened
    // to print a matching word cannot pass as a clean degradation.
    const validation = await validateJsonFile(
      path.join(tmp, "schemas", "review_packet.schema.json"),
      path.join(tmp, ".review-surfaces", "review_packet.json")
    );
    assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
