// review-surfaces.CHANGE_MAP.3/.4: the ONE shared embed helper for the change
// map — redaction runs before render and the body-level fence-close guard is
// kept at every embed point (a body line that could close the ```mermaid fence
// omits the whole diagram rather than spilling raw markdown into the surface).
// The redaction BLOCK signal is preserved so a high-confidence secret inside a
// rendered label still trips the sticky's postability gate (a downstream
// whole-body pass only ever sees the already-redacted placeholder).
import { renderChangeMapMermaid } from "../diagrams/change-map";
import { ChangeGraph } from "../human/contract";
import { redactSecrets } from "../privacy/secrets";

const MAX_EMBED_CHARS = 12_000;

export interface ChangeMapEmbed {
  body?: string;
  blocked: boolean;
}

export function changeMapMermaidEmbed(graph: ChangeGraph): ChangeMapEmbed {
  const rendered = renderChangeMapMermaid(graph);
  if (!rendered) {
    return { blocked: false };
  }
  const redaction = redactSecrets(rendered);
  if (redaction.text.length > MAX_EMBED_CHARS || /^\s*```/m.test(redaction.text)) {
    return { blocked: redaction.blocked };
  }
  return { body: redaction.text, blocked: redaction.blocked };
}

export function changeMapMermaidBody(graph: ChangeGraph): string | undefined {
  return changeMapMermaidEmbed(graph).body;
}

// Collapsed <details> form for the comment surfaces (sticky + PR comment).
export function changeMapDetailsBlock(graph: ChangeGraph): string | undefined {
  const body = changeMapMermaidBody(graph);
  if (!body) {
    return undefined;
  }
  return `<details><summary>Change map</summary>\n\n\`\`\`mermaid\n${body}\n\`\`\`\n\n</details>`;
}
