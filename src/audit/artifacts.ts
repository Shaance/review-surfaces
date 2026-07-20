import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  AGREEMENT_AUDIT_ARTIFACTS,
  AGREEMENT_AUDIT_FINAL_ARTIFACTS,
  AGREEMENT_AUDIT_WORKING_ARTIFACTS
} from "../artifacts/agreement-audit";
import type { AgreementAudit } from "./contract";
import { renderAgreementAuditMarkdown } from "./render";

export function writePrivateJson(file: string, value: unknown): string {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writePrivateFile(file, bytes);
  return bytes;
}

export function clearAgreementAuditWorkingArtifacts(out: string): void {
  for (const name of AGREEMENT_AUDIT_WORKING_ARTIFACTS) {
    clearAuditArtifact(out, name);
  }
}

export function clearFinalAgreementAuditArtifacts(out: string): void {
  for (const name of AGREEMENT_AUDIT_FINAL_ARTIFACTS) {
    clearAuditArtifact(out, name);
  }
}

function clearAuditArtifact(out: string, name: string): void {
  const file = path.join(out, name);
  const metadata = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!metadata) return;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`refusing to clear non-file audit artifact ${name}`);
  }
  fs.rmSync(file);
}

export function acquireAgreementAuditRunLock(out: string): () => void {
  if (fs.existsSync(out)) ensureOutputDirectory(out);
  const lockPath = agreementAuditLockPath(out);
  ensureLockDirectory(path.dirname(lockPath));
  return acquireArtifactLock(path.dirname(lockPath), lockPath);
}

export function agreementAuditLockPath(out: string): string {
  const identity = crypto.createHash("sha256").update(canonicalOutputIdentity(out)).digest("hex").slice(0, 20);
  const userIdentity = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `review-surfaces-agreement-audit-locks-${userIdentity}`, `${identity}.lock`);
}

function canonicalOutputIdentity(out: string): string {
  let ancestor = path.resolve(out);
  const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("could not find an existing parent directory for --out");
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const canonicalAncestor = fs.realpathSync(ancestor);
  // Conservative on case-sensitive filesystems: two genuinely distinct paths
  // may contend, but aliases for one physical destination can never split locks.
  return path.join(canonicalAncestor, ...suffix).toLowerCase();
}

export function publishAgreementAuditArtifacts(
  out: string,
  audit: AgreementAudit,
  options: { lockHeld?: boolean } = {}
): string {
  ensureOutputDirectory(out);
  const jsonPath = path.join(out, AGREEMENT_AUDIT_ARTIFACTS.json);
  const markdownPath = path.join(out, AGREEMENT_AUDIT_ARTIFACTS.markdown);
  assertWritableArtifactPath(jsonPath);
  assertWritableArtifactPath(markdownPath);
  const staged = stageArtifactPair([
    [jsonPath, `${JSON.stringify(audit, null, 2)}\n`],
    [markdownPath, renderAgreementAuditMarkdown(audit)]
  ]);
  try {
    if (options.lockHeld) {
      assertWritableArtifactPath(jsonPath);
      assertWritableArtifactPath(markdownPath);
      staged.publish();
    } else {
      const releaseLock = acquireAgreementAuditRunLock(out);
      try {
        assertWritableArtifactPath(jsonPath);
        assertWritableArtifactPath(markdownPath);
        staged.publish();
      } finally {
        releaseLock();
      }
    }
  } finally {
    staged.discard();
  }
  return markdownPath;
}

function ensureOutputDirectory(directory: string): void {
  if (fs.existsSync(directory)) {
    const metadata = fs.lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("--out must name a real directory, not a file or symbolic link");
    }
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writePrivateFile(file: string, content: string): void {
  assertWritableArtifactPath(file);
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function stageArtifactPair(artifacts: readonly [
  readonly [file: string, content: string],
  readonly [file: string, content: string]
]): { publish: () => void; discard: () => void } {
  const directory = path.dirname(artifacts[0][0]);
  if (artifacts.some(([file]) => path.dirname(file) !== directory)) {
    throw new Error("artifact pair must share one output directory");
  }
  const stagingDirectory = fs.mkdtempSync(path.join(directory, ".agreement-audit-"));
  fs.chmodSync(stagingDirectory, 0o700);
  try {
    const staged = artifacts.map(([file, content]) => {
      const temporary = path.join(stagingDirectory, path.basename(file));
      writePrivateFile(temporary, content);
      const backup = path.join(stagingDirectory, `.previous-${path.basename(file)}`);
      return { file, temporary, backup };
    });
    return {
      publish: () => {
        const published: string[] = [];
        for (const { file, backup } of staged) {
          if (fs.existsSync(file)) fs.linkSync(file, backup);
        }
        try {
          for (const { file, temporary } of staged) {
            fs.renameSync(temporary, file);
            published.push(file);
          }
        } catch (error) {
          for (const { file, backup } of staged) {
            if (fs.existsSync(backup)) fs.renameSync(backup, file);
            else if (published.includes(file)) fs.rmSync(file, { force: true });
          }
          throw error;
        }
      },
      discard: () => {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function acquireArtifactLock(directory: string, lockPath: string): () => void {
  try {
    return lockfile.lockSync(directory, {
      lockfilePath: lockPath,
      realpath: false,
      stale: 120_000,
      update: 40_000
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Error("another agreement-audit finalize is already writing this output directory");
    }
    throw error;
  }
}

function ensureLockDirectory(directory: string): void {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("agreement-audit lock root must be a real directory");
  }
  fs.chmodSync(directory, 0o700);
}

function assertWritableArtifactPath(file: string): void {
  const metadata = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!metadata) return;
  if (metadata.isSymbolicLink()) throw new Error(`refusing to write through symbolic link ${path.basename(file)}`);
  if (!metadata.isFile()) throw new Error(`refusing to replace non-file artifact ${path.basename(file)}`);
}
