import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// Shared CLI/git harness. The 5 CLI integration test files each carried a
// byte-identical copy of these; consolidating here removes that duplication
// while keeping the exact same git flags, commit identity, and runCli shape so
// behavior is unchanged. Compiled tests run from dist/tests/*.test.js and this
// helper compiles to dist/tests/helpers/cli-repo.js, so `./helpers/cli-repo`
// resolves the same way the existing review-areas/review-packet helpers do.
export const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");

const LOCAL_RUNTIME_ARTIFACT_ROOTS = [
  "node_modules",
  ".claude",
  ".codex",
  ".pnpm-store",
  "bench/.cache",
  "tmp"
];

export function isLocalRuntimeArtifactPath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  return normalized === ".env.local" || normalized === ".DS_Store" ||
    LOCAL_RUNTIME_ARTIFACT_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function initGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd, stdio: "ignore" });
}

export function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args, "--out", ".review-surfaces"], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
