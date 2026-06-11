// review-surfaces.RENDER.13: render attributed dependency chains. Two forms:
// an indented text tree for the local supply-chain lens surfaces, and a small
// mermaid graph for GitHub comment surfaces where a chain exists. Both render
// ONLY chains the lockfile edges actually resolved (DEP_FACTS.4) — the honest
// flat grouping remains the fallback when no chains exist.
import { DependencyChain } from "../human/contract";
import { diagramLabel } from "./diagrams";

export function renderDependencyTreeText(chains: DependencyChain[]): string[] {
  const lines: string[] = [];
  for (const chain of chains) {
    lines.push(`${chain.via} (direct, ${chain.source_path})`);
    for (const transitive of chain.transitives) {
      lines.push(`  └─ ${transitive.package}${transitive.install_scripts ? " ⚠ install scripts" : ""}`);
    }
  }
  return lines;
}

export function renderDependencyTreeMermaid(chains: DependencyChain[]): string | undefined {
  if (chains.length === 0) {
    return undefined;
  }
  const lines = ["flowchart TD"];
  let nodeIndex = 0;
  for (const [chainIndex, chain] of chains.entries()) {
    const rootId = `d${chainIndex}`;
    lines.push(`  ${rootId}["${diagramLabel(chain.via)} direct"]`);
    for (const transitive of chain.transitives) {
      const id = `t${nodeIndex}`;
      nodeIndex += 1;
      const flag = transitive.install_scripts ? " — install scripts" : "";
      lines.push(`  ${id}["${diagramLabel(`${transitive.package}${flag}`)}"]`);
      lines.push(`  ${rootId} --> ${id}`);
      if (transitive.install_scripts) {
        lines.push(`  class ${id} depwarn`);
      }
    }
  }
  lines.push("  classDef depwarn fill:#fde2e2,stroke:#b91c1c");
  return lines.join("\n");
}
