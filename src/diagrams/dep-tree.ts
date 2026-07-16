// review-surfaces.RENDER.13: render attributed dependency chains. Two forms:
// an indented text tree for the local supply-chain lens surfaces, and a small
// mermaid graph for supporting human artifacts where a chain exists. Both render
// ONLY chains the lockfile edges actually resolved (DEP_FACTS.4) — the honest
// flat grouping remains the fallback when no chains exist.
import { DependencyChain } from "../human/contract";

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
