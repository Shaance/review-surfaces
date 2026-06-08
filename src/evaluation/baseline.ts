import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectInputs } from "../collector/collect";
import { ReviewSurfacesConfig } from "../config/config";
import { buildIntent } from "../intent/intent";
import { buildReviewAreas } from "../review-areas/areas";
import { EvaluationModel, evaluateIntent } from "./evaluate";

// ---------------------------------------------------------------------------
// Base-ref evaluation for the PR coverage DELTA. Runs the deterministic
// collect -> intent -> evaluate pipeline against the base SHA in a throwaway git
// worktree so PR-scoped coverage can compare base vs head. Best-effort: any
// failure (shallow clone, unresolved ref, worktree denied) returns undefined and
// the coverage degrades to current-status-only rather than blocking.
// ---------------------------------------------------------------------------

export interface BaselineEvaluationInput {
  cwd: string;
  baseRef: string;
  config: ReviewSurfacesConfig;
  specFlag?: string;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export async function evaluateBaseline(input: BaselineEvaluationInput): Promise<EvaluationModel | undefined> {
  const baseSha = git(input.cwd, ["rev-parse", "--verify", `${input.baseRef}^{commit}`]);
  if (!baseSha) {
    return undefined;
  }
  // mkdtempSync can throw (read-only/full tmpdir, EMFILE). Keep it inside the
  // try so ANY failure here degrades to undefined (head-only coverage) per the
  // best-effort contract, rather than escaping and aborting the whole run.
  let worktree: string | undefined;
  try {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "review-surfaces-base-"));
    if (git(input.cwd, ["worktree", "add", "--detach", worktree, baseSha]) === undefined) {
      fs.rmSync(worktree, { recursive: true, force: true });
      return undefined;
    }
    const runConfig = input.specFlag ? { ...input.config, specs: [input.specFlag] } : input.config;
    const collection = await collectInputs({
      cwd: worktree,
      config: runConfig,
      baseRef: baseSha,
      headRef: baseSha, // base..base: evaluate the base STATE (empty diff)
      outputDir: path.join(worktree, ".review-surfaces-base"),
      dogfood: false
    });
    const intent = await buildIntent(worktree, collection);
    const areas = buildReviewAreas({ config: runConfig, repoIndex: collection.repoIndex });
    const options = areas.mode === "config" ? { areas: areas.areas } : {};
    return await evaluateIntent(worktree, collection, intent, options);
  } catch {
    return undefined;
  } finally {
    // worktree is undefined only if mkdtempSync itself threw; nothing to clean up.
    if (worktree !== undefined) {
      git(input.cwd, ["worktree", "remove", "--force", worktree]);
      try {
        fs.rmSync(worktree, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; never let teardown throw out of evaluateBaseline.
      }
    }
  }
}
