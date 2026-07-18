import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { LockOptions } from "proper-lockfile";
import { runAgreementAuditCli } from "../src/audit/cli";
import {
  AGREEMENT_BENCH_ROOT,
  agreementCandidate as agreement,
  readJson
} from "./helpers/agreement-audit";

test("milestone-one CLI finalizes a candidate into grounded JSON and adaptive Markdown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agreement-audit-"));
  try {
    const candidatePath = path.join(root, "candidate.json");
    const outputPath = path.join(root, "out");
    fs.writeFileSync(candidatePath, JSON.stringify(candidate()));
    const args = finalizeArgs(candidatePath, outputPath);
    const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readJson<{ status: string }>(path.join(outputPath, "audit.json")).status, "needs_human_decision");
    const markdown = fs.readFileSync(path.join(outputPath, "audit.md"), "utf8");
    assert.match(markdown, /Restore the default/);
    assert.match(markdown, /session-1/);
    assert.match(markdown, /Keep DerivedData/);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(outputPath, "audit.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(outputPath, "audit.md")).mode & 0o777, 0o600);

    const unknownFlag = spawnSync(process.execPath, [...args, "--bogus", "ignored"], {
      cwd: process.cwd(), encoding: "utf8"
    });
    assert.equal(unknownFlag.status, 1);
    assert.match(unknownFlag.stderr, /Unknown flag --bogus/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("milestone-one CLI preserves existing output-directory permissions and refuses symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agreement-audit-output-"));
  try {
    const candidatePath = path.join(root, "candidate.json");
    fs.writeFileSync(candidatePath, JSON.stringify(candidate()));
    fs.chmodSync(root, 0o755);
    const args = finalizeArgs(candidatePath, root);
    const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(root).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(root, "audit.json")).mode & 0o777, 0o600);
    let priorJson = fs.readFileSync(path.join(root, "audit.json"), "utf8");

    fs.chmodSync(path.join(root, "audit.json"), 0o644);
    fs.chmodSync(path.join(root, "audit.md"), 0o644);
    const tightened = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(tightened.status, 0, tightened.stderr);
    assert.equal(fs.statSync(path.join(root, "audit.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, "audit.md")).mode & 0o777, 0o600);

    const replacementCandidate = readJson<Record<string, unknown>>(candidatePath);
    (replacementCandidate.final_goal as Record<string, unknown>).text = "Atomic replacement reached both artifacts.";
    fs.writeFileSync(candidatePath, JSON.stringify(replacementCandidate));
    fs.chmodSync(path.join(root, "audit.md"), 0o400);
    const replaced = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.equal(
      readJson<{ final_goal: { text: string } }>(path.join(root, "audit.json")).final_goal.text,
      "Atomic replacement reached both artifacts."
    );
    assert.match(fs.readFileSync(path.join(root, "audit.md"), "utf8"), /Atomic replacement reached both artifacts/);
    assert.equal(fs.statSync(path.join(root, "audit.md")).mode & 0o777, 0o600);
    priorJson = fs.readFileSync(path.join(root, "audit.json"), "utf8");

    const target = path.join(root, "target.md");
    fs.writeFileSync(target, "keep\n");
    fs.rmSync(path.join(root, "audit.md"));
    fs.symlinkSync(target, path.join(root, "audit.md"));
    const changedCandidate = readJson<Record<string, unknown>>(candidatePath);
    (changedCandidate.final_goal as Record<string, unknown>).text = "This rejected run must not replace the prior JSON.";
    fs.writeFileSync(candidatePath, JSON.stringify(changedCandidate));
    const rejected = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /refusing to write through symbolic link audit\.md/);
    assert.equal(fs.readFileSync(target, "utf8"), "keep\n");
    assert.equal(fs.readFileSync(path.join(root, "audit.json"), "utf8"), priorJson);

    fs.rmSync(path.join(root, "audit.md"));
    const missingTarget = path.join(root, "missing.md");
    fs.symlinkSync(missingTarget, path.join(root, "audit.md"));
    const rejectedDanglingLink = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(rejectedDanglingLink.status, 1);
    assert.match(rejectedDanglingLink.stderr, /refusing to write through symbolic link audit\.md/);
    assert.equal(fs.existsSync(missingTarget), false);
    assert.equal(fs.readFileSync(path.join(root, "audit.json"), "utf8"), priorJson);

    fs.rmSync(path.join(root, "audit.md"));
    fs.mkdirSync(path.join(root, "audit.md"));
    const rejectedDirectory = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(rejectedDirectory.status, 1);
    assert.match(rejectedDirectory.stderr, /refusing to replace non-file artifact audit\.md/);
    assert.equal(fs.readFileSync(path.join(root, "audit.json"), "utf8"), priorJson);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("milestone-one CLI rolls both artifacts back when the second publish fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agreement-audit-rollback-"));
  const originalRename = fs.renameSync;
  try {
    const candidatePath = path.join(root, "candidate.json");
    const outputPath = path.join(root, "out");
    fs.writeFileSync(candidatePath, JSON.stringify(candidate()));
    const args = finalizeArgs(candidatePath, outputPath);
    const seeded = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stderr);
    const priorJson = fs.readFileSync(path.join(outputPath, "audit.json"), "utf8");
    const priorMarkdown = fs.readFileSync(path.join(outputPath, "audit.md"), "utf8");

    const replacementCandidate = readJson<Record<string, unknown>>(candidatePath);
    (replacementCandidate.final_goal as Record<string, unknown>).text = "This publish must roll back.";
    fs.writeFileSync(candidatePath, JSON.stringify(replacementCandidate));
    let injected = false;
    fs.renameSync = ((source, destination) => {
      if (!injected && path.basename(String(source)) === "audit.md" && path.basename(String(destination)) === "audit.md") {
        injected = true;
        throw new Error("simulated second publish failure");
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync;

    await assert.rejects(
      runAgreementAuditCli(["finalize", ...args.slice(2)]),
      /simulated second publish failure/
    );
    assert.equal(fs.readFileSync(path.join(outputPath, "audit.json"), "utf8"), priorJson);
    assert.equal(fs.readFileSync(path.join(outputPath, "audit.md"), "utf8"), priorMarkdown);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("milestone-one CLI rejects a concurrent publisher before replacing either artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agreement-audit-lock-"));
  try {
    const candidatePath = path.join(root, "candidate.json");
    const outputPath = path.join(root, "out");
    fs.writeFileSync(candidatePath, JSON.stringify(candidate()));
    const args = finalizeArgs(candidatePath, outputPath);
    const seeded = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stderr);
    const priorJson = fs.readFileSync(path.join(outputPath, "audit.json"), "utf8");
    const priorMarkdown = fs.readFileSync(path.join(outputPath, "audit.md"), "utf8");

    const replacementCandidate = readJson<Record<string, unknown>>(candidatePath);
    (replacementCandidate.final_goal as Record<string, unknown>).text = "A concurrent publisher must not land.";
    fs.writeFileSync(candidatePath, JSON.stringify(replacementCandidate));
    const release = lockfile.lockSync(outputPath, artifactLockOptions(outputPath));
    try {
      const blocked = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /another agreement-audit finalize is already writing/);
      assert.equal(fs.readFileSync(path.join(outputPath, "audit.json"), "utf8"), priorJson);
      assert.equal(fs.readFileSync(path.join(outputPath, "audit.md"), "utf8"), priorMarkdown);
    } finally {
      release();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("milestone-one CLI reclaims a stale publisher lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agreement-audit-stale-lock-"));
  try {
    const candidatePath = path.join(root, "candidate.json");
    const outputPath = path.join(root, "out");
    fs.writeFileSync(candidatePath, JSON.stringify(candidate()));
    const args = finalizeArgs(candidatePath, outputPath);
    const seeded = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stderr);

    const replacementCandidate = readJson<Record<string, unknown>>(candidatePath);
    (replacementCandidate.final_goal as Record<string, unknown>).text = "A stale lock must be reclaimed.";
    fs.writeFileSync(candidatePath, JSON.stringify(replacementCandidate));
    const lockPath = path.join(outputPath, ".agreement-audit.lock");
    fs.mkdirSync(lockPath);
    const staleTime = new Date(Date.now() - 180_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    const recovered = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(
      readJson<{ final_goal: { text: string } }>(path.join(outputPath, "audit.json")).final_goal.text,
      "A stale lock must be reclaimed."
    );
    assert.equal(fs.existsSync(path.join(outputPath, ".agreement-audit.lock")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function candidate(): unknown {
  return {
    final_goal: { text: "Remove Swift analysis while retaining privacy defaults.", conversation_event_ids: ["u1", "u2"] },
    agreements: [
      agreement({
        key: "remove-swift-code",
        statement: "The Swift analysis implementation was removed.",
        conversation_event_ids: ["u1"],
        diff_citations: [{ path: "src/swift/project.ts", side: "delete", line: 1, contains: "inspectSwiftProject" }]
      }),
      agreement({ key: "remove-swift-docs", statement: "Swift analysis documentation removal is not evidenced.", state: "unresolved", conversation_event_ids: ["u1"], reviewer_action: "Confirm or remove the documentation." }),
      agreement({ key: "remove-swift-tests", statement: "Dedicated Swift analysis test removal is not evidenced.", state: "unresolved", conversation_event_ids: ["u1"], reviewer_action: "Confirm or remove the dedicated tests." }),
      agreement({
        key: "privacy-boundary",
        kind: "human_boundary",
        statement: "The privacy boundary was crossed.",
        state: "diverged",
        conversation_event_ids: ["u2"],
        diff_citations: [{ path: "src/privacy/ignore.ts", side: "delete", line: 4, contains: "DerivedData" }],
        reviewer_action: "Restore the default."
      })
    ],
    complete: true,
    limitations: []
  };
}

function finalizeArgs(candidatePath: string, outputPath: string): string[] {
  return [
    "bin/agreement-audit.js", "finalize",
    "--input", path.join(AGREEMENT_BENCH_ROOT, "cases", "late-correction.input.json"),
    "--candidate", candidatePath,
    "--out", outputPath
  ];
}

function artifactLockOptions(outputPath: string): LockOptions {
  return {
    lockfilePath: path.join(outputPath, ".agreement-audit.lock"),
    realpath: false,
    stale: 120_000,
    update: 40_000
  };
}
