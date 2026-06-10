// review-surfaces.RANKING.1: deterministic per-changed-impl-path evidence used to
// modulate review-queue ranking. The IO-dependent signal — which changed test
// file imports which changed implementation file — is computed here (it needs the
// head file contents); the transcript/area signal is derived in the build from
// the PR surface's untested_changed_impl risks, so this module stays focused on
// the import mapping.
import path from "node:path";
import { StructuredDiff } from "../pr/contract";
import { resolveRelativeImports } from "../collector/import-graph";

export interface RankingEvidence {
  // repo-relative changed IMPL path -> sorted changed test files that import it
  // (or basename-map to it). Empty map means no test-change signal applied.
  changed_tests_by_impl: Record<string, string[]>;
}

export function emptyRankingEvidence(): RankingEvidence {
  return { changed_tests_by_impl: {} };
}

export function computeRankingEvidence(options: {
  diff: StructuredDiff;
  isTestPath: (filePath: string) => boolean;
  readHead: (filePath: string) => string | undefined;
  exists: (repoRelativePath: string) => boolean;
}): RankingEvidence {
  const changedPaths = options.diff.files.map((file) => file.path);
  const changedImpl = new Set(changedPaths.filter((p) => !options.isTestPath(p)));
  const changedTests = changedPaths.filter((p) => options.isTestPath(p));
  // Index changed impl files by basename stem once, so the basename fallback is an
  // O(1) lookup per test instead of scanning every changed impl per test.
  const implByStem = new Map<string, string[]>();
  for (const impl of changedImpl) {
    const stem = basenameStem(impl);
    if (stem) {
      const bucket = implByStem.get(stem);
      if (bucket) {
        bucket.push(impl);
      } else {
        implByStem.set(stem, [impl]);
      }
    }
  }

  const byImpl: Record<string, Set<string>> = {};
  for (const testPath of changedTests) {
    const matched = new Set<string>();
    const content = options.readHead(testPath);
    if (content) {
      for (const target of resolveRelativeImports(testPath, content, options.exists)) {
        if (changedImpl.has(target)) {
          matched.add(target);
        }
      }
    }
    // Fallback ONLY when imports identified no changed-impl target: otherwise a
    // resolved `tests/foo.test.ts -> src/foo.ts` would also falsely claim every
    // other same-stem changed impl (e.g. src/legacy/foo.ts). When imports did
    // resolve, trust them and skip the ambiguous basename heuristic.
    if (matched.size === 0) {
      for (const impl of implByStem.get(testStem(testPath)) ?? []) {
        matched.add(impl);
      }
    }
    for (const impl of matched) {
      (byImpl[impl] ??= new Set()).add(testPath);
    }
  }

  const changed_tests_by_impl: Record<string, string[]> = {};
  for (const impl of Object.keys(byImpl).sort()) {
    changed_tests_by_impl[impl] = [...byImpl[impl]].sort();
  }
  return { changed_tests_by_impl };
}

function basenameStem(filePath: string): string {
  return path.posix.basename(filePath.replace(/\\/g, "/")).replace(/\.[^.]+$/, "");
}

function testStem(testPath: string): string {
  return path.posix.basename(testPath.replace(/\\/g, "/")).replace(/\.(test|spec)\.[^.]+$/i, "").replace(/\.[^.]+$/, "");
}
