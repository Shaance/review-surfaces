// review-surfaces.CONFIG_FACTS.5 — shared *.xcscheme reader. Bounded: it reads the
// TestAction's referenced test plans and testable target blueprint names so a
// removed test action / test target is observable. Unsupported shapes yield an
// empty scheme rather than a guess.

import { isRecord } from "../../core/guards";
import { AppleScheme } from "./model";

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function attr(node: unknown, name: string): string | undefined {
  if (isRecord(node)) {
    const value = node[`@_${name}`];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function schemeNameFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.xcscheme$/, "");
}

export function parseScheme(path: string, content: string): AppleScheme {
  const empty: AppleScheme = { name: schemeNameFromPath(path), test_target_ids: [], test_plan_paths: [], provenance: ["pbxproj"] };
  let document: unknown;
  try {
    // fast-xml-parser is a CommonJS module per the project guidance.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { XMLParser } = require("fast-xml-parser");
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseAttributeValue: false, trimValues: true });
    document = parser.parse(content);
  } catch {
    return empty;
  }
  if (!isRecord(document)) {
    return empty;
  }
  const scheme = isRecord(document.Scheme) ? document.Scheme : undefined;
  const testAction = scheme && isRecord(scheme.TestAction) ? scheme.TestAction : undefined;
  if (!testAction) {
    return empty;
  }

  const testTargets = new Set<string>();
  const testablesNode = isRecord(testAction.Testables) ? testAction.Testables.TestableReference : undefined;
  for (const testable of toArray(testablesNode)) {
    if (!isRecord(testable)) {
      continue;
    }
    const buildableRefs = toArray(testable.BuildableReference);
    for (const ref of buildableRefs) {
      const blueprint = attr(ref, "BlueprintName");
      if (blueprint) {
        testTargets.add(blueprint);
      }
    }
  }

  const testPlans = new Set<string>();
  const plansNode = isRecord(testAction.TestPlans) ? testAction.TestPlans.TestPlanReference : undefined;
  for (const plan of toArray(plansNode)) {
    const reference = attr(plan, "reference");
    if (reference) {
      // "container:Plans/Unit.xctestplan" -> "Plans/Unit.xctestplan".
      testPlans.add(reference.replace(/^container:/, ""));
    }
  }

  return {
    name: schemeNameFromPath(path),
    test_target_ids: [...testTargets].sort(),
    test_plan_paths: [...testPlans].sort(),
    provenance: ["pbxproj"]
  };
}
