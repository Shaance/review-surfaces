// review-surfaces.CHANGE_MAP.3/.4: the ONE shared embed helper for the change
// map — redaction runs before render and the body-level fence-close guard is
// kept at every embed point (a body line that could close the ```mermaid fence
// omits the whole diagram rather than spilling raw markdown into the surface).
import { renderChangeMapMermaid } from "../diagrams/change-map";
import { ChangeGraph } from "../human/contract";
import { redactSecrets } from "../privacy/secrets";

const MAX_EMBED_CHARS = 12_000;

export function changeMapMermaidBody(graph: ChangeGraph): string | undefined {
  const rendered = renderChangeMapMermaid(graph);
  if (!rendered) {
    return undefined;
  }
  const body = redactSecrets(rendered).text;
  if (body.length > MAX_EMBED_CHARS || /^\s*```/m.test(body)) {
    return undefined;
  }
  return body;
}

// Collapsed <details> form for the comment surfaces (sticky + PR comment).
export function changeMapDetailsBlock(graph: ChangeGraph): string | undefined {
  const body = changeMapMermaidBody(graph);
  if (!body) {
    return undefined;
  }
  return `<details><summary>Change map</summary>\n\n\`\`\`mermaid\n${body}\n\`\`\`\n\n</details>`;
}
