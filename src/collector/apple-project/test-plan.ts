// review-surfaces.CONFIG_FACTS.5 / SEMANTIC_DIFF.6 — *.xctestplan reader. The file
// is JSON: read the selected (enabled) test targets and any explicitly skipped
// tests so a removed/disabled selected target and newly skipped tests are
// observable. A non-JSON or unexpected shape yields an empty plan.

import { isRecord } from "../../core/guards";
import { AppleTestPlan } from "./model";

export function parseTestPlan(path: string, content: string): AppleTestPlan {
  const empty: AppleTestPlan = { path, test_target_ids: [], skipped_tests: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.testTargets)) {
    return empty;
  }
  const targets = new Set<string>();
  const skipped = new Set<string>();
  for (const entry of parsed.testTargets) {
    if (!isRecord(entry)) {
      continue;
    }
    // An entry is selected unless explicitly disabled (`enabled: false`).
    const enabled = entry.enabled !== false;
    const target = isRecord(entry.target) ? entry.target : undefined;
    const name = target && typeof target.name === "string" ? target.name : undefined;
    if (name && enabled) {
      targets.add(name);
    }
    for (const skip of Array.isArray(entry.skippedTests) ? entry.skippedTests : []) {
      if (typeof skip === "string") {
        // Keep the skip identifier verbatim (it is already a class/method id within
        // the target); prefix the target only when the id is not already qualified.
        skipped.add(name && !skip.startsWith(`${name}/`) ? `${name}/${skip}` : skip);
      }
    }
  }
  return { path, test_target_ids: [...targets].sort(), skipped_tests: [...skipped].sort() };
}
