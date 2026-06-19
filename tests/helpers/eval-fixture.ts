// review-surfaces.EVAL_HARNESS.1: a programmatic fixture builder. Each case
// creates a temp git repo with a small base project, commits it, applies a
// seeded mutation, commits again, then runs the REAL pipeline (--provider mock)
// against base..head and returns the parsed human_review.json. No committed
// fixture repos — every case is a few readable builder calls in the test file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { HumanReviewModel } from "../../src/human/contract";

const CLI = path.join(process.cwd(), "dist", "src", "cli", "index.js");

export interface EvalFixture {
  dir: string;
  baseSha: string;
  write: (relativePath: string, content: string) => void;
  remove: (relativePath: string) => void;
  rename: (from: string, to: string) => void;
  commit: (message: string) => string;
  run: (extraArgs?: string[]) => HumanReviewModel;
  cleanup: () => void;
}

const BASE_FILES: Record<string, string> = {
  "features/app.feature.yaml": `feature:
  name: app
  product: app
  description: Tiny fixture app.
components:
  CORE:
    name: Core math
    description: Arithmetic helpers.
    requirements:
      1:
        requirement: add must sum two numbers.
`,
  "src/calc.ts": `export function add(left: number, right: number): number {
  return left + right;
}
`,
  "src/util.ts": `export function double(value: number): number {
  return value * 2;
}
`,
  "src/options.ts": `export interface Options {
  retries: number;
  timeout?: number;
}
`,
  "schemas/thing.schema.json": `{
  "type": "object",
  "required": ["name"],
  "properties": {
    "name": { "type": "string" },
    "size": { "type": "integer" }
  }
}
`,
  "tests/calc.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/calc";

test("app.CORE.1 add sums two numbers", () => {
  assert.equal(add(1, 2), 3);
});
`,
  // review-surfaces.SEMANTIC_DIFF.5/.6: a Swift implementation + matching XCTest
  // in the base so a later mutation is a real CHANGE diff (not an addition).
  // Unchanged in cases that do not touch them, so they never enter those diffs.
  "Sources/App/Greeting.swift": `public struct Greeting {
  public func greet(name: String) -> String {
    return "Hi \\(name)"
  }
}
`,
  // Path is "AppTests/" not "Tests/" on purpose: a case-insensitive macOS FS would
  // otherwise collapse "Tests/" into the existing lowercase "tests/" dir, making the
  // path nondeterministic across platforms. The basename ...Tests.swift is what
  // classifies it as a Swift test, so the directory name is free to differ.
  "AppTests/GreetingTests.swift": `import XCTest
@testable import App

final class GreetingTests: XCTestCase {
  func testGreet() {
    XCTAssertEqual(Greeting().greet(name: "a"), "Hi a")
  }
}
`,
  "README.md": "# fixture app\n"
};

export interface EvalFixtureOptions {
  // review-surfaces.COLD_START.4: when false, the fixture repo has NO Acai spec
  // and the pipeline runs without --spec — the spec-less cold-start case.
  spec?: boolean;
}

export function createEvalFixture(prefix: string, options: EvalFixtureOptions = {}): EvalFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rs-eval-${prefix}-`));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.email=eval@test", "-c", "user.name=eval", ...args], {
      cwd: dir,
      encoding: "utf8"
    }).trim();

  const write = (relativePath: string, content: string): void => {
    const absolute = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  };

  const withSpec = options.spec !== false;
  for (const [relativePath, content] of Object.entries(BASE_FILES)) {
    if (!withSpec && relativePath === "features/app.feature.yaml") {
      continue;
    }
    write(relativePath, content);
  }
  git("init", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");

  return {
    dir,
    baseSha,
    write,
    remove: (relativePath) => fs.rmSync(path.join(dir, relativePath), { force: true }),
    rename: (from, to) => {
      fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      git("mv", from, to);
    },
    commit: (message) => {
      git("add", "-A");
      git("commit", "-qm", message);
      return git("rev-parse", "HEAD");
    },
    run: (extraArgs = []) => {
      execFileSync(
        "node",
        [
          CLI,
          "all",
          "--provider",
          "mock",
          "--review-scope",
          "pr",
          "--base",
          baseSha,
          "--head",
          "HEAD",
          ...(withSpec ? ["--spec", "features/app.feature.yaml"] : []),
          "--out",
          ".rs",
          ...extraArgs
        ],
        { cwd: dir, stdio: "ignore" }
      );
      return JSON.parse(fs.readFileSync(path.join(dir, ".rs", "human_review.json"), "utf8")) as HumanReviewModel;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}
