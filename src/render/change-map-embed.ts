// review-surfaces.CHANGE_MAP.3/.4: the ONE shared embed helper for the change
// map — redaction runs before render and the body-level fence-close guard is
// kept at every embed point (a body line that could close the ```mermaid fence
// omits the whole diagram rather than spilling raw markdown into the surface).
// The redaction BLOCK signal is preserved so a high-confidence secret inside a
// rendered label still trips the sticky's postability gate (a downstream
// whole-body pass only ever sees the already-redacted placeholder).
import { renderChangeMapMermaid, renderChangeMapOverviewMermaid } from "../diagrams/change-map";
import { renderDependencyTreeMermaid } from "../diagrams/dep-tree";
import { ChangeGraph, DependencyChain } from "../human/contract";
import { changeMapLeadLevel } from "../human/legibility-budget";
import { redactSecrets } from "../privacy/secrets";

const MAX_EMBED_CHARS = 12_000;

export interface ChangeMapEmbed {
  body?: string;
  blocked: boolean;
  // review-surfaces.MAP_SCALE.2: which level the legibility budget chose —
  // surfaces title the block honestly ("Change map" vs "Change map (overview)").
  level: "file" | "overview";
}

export function changeMapMermaidEmbed(graph: ChangeGraph): ChangeMapEmbed {
  // review-surfaces.MAP_SCALE.2: the legibility budget decides which level
  // leads — the SAME decision on every mermaid surface (md, sticky, PR
  // comment); this helper carries no threshold of its own.
  const level = changeMapLeadLevel(graph);
  const rendered = level === "overview" ? renderChangeMapOverviewMermaid(graph.overview) : renderChangeMapMermaid(graph);
  if (!rendered) {
    return { blocked: false, level };
  }
  const redaction = redactSecrets(rendered);
  if (redaction.text.length > MAX_EMBED_CHARS || /^\s*```/m.test(redaction.text)) {
    return { blocked: redaction.blocked, level };
  }
  return { body: redaction.text, blocked: redaction.blocked, level };
}

export function changeMapTitle(level: "file" | "overview"): string {
  return level === "overview" ? "Change map (overview)" : "Change map";
}

// Collapsed <details> form for the comment surfaces (sticky + PR comment).
export function changeMapDetailsBlock(graph: ChangeGraph): string | undefined {
  const embed = changeMapMermaidEmbed(graph);
  if (!embed.body) {
    return undefined;
  }
  return mermaidDetailsBlock(changeMapTitle(embed.level), embed.body);
}

// Shared collapsed-details mermaid wrapper (the blank line after <summary> is
// required for GitHub to render the inner fence). Callers must pass an
// already-redacted, fence-guarded body AND a constant title (the title is not
// HTML-escaped here; never interpolate untrusted text into it).
export function mermaidDetailsBlock(title: string, body: string): string {
  return `<details><summary>${title}</summary>\n\n\`\`\`mermaid\n${body}\n\`\`\`\n\n</details>`;
}

// review-surfaces.RENDER.13: the dependency-chain mermaid for GitHub comment
// surfaces — same redaction + fence-close guard as the change map.
export function dependencyTreeEmbed(chains: DependencyChain[] | undefined): { body?: string; blocked: boolean } {
  const rendered = renderDependencyTreeMermaid(chains ?? []);
  if (!rendered) {
    return { blocked: false };
  }
  const redaction = redactSecrets(rendered);
  if (redaction.text.length > MAX_EMBED_CHARS || /^\s*```/m.test(redaction.text)) {
    return { blocked: redaction.blocked };
  }
  return { body: redaction.text, blocked: redaction.blocked };
}
