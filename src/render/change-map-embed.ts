// review-surfaces.CHANGE_MAP.3/.4: the ONE shared embed helper for the change
// map — redaction runs before render and the body-level fence-close guard is
// kept at every embed point (a body line that could close the ```mermaid fence
// omits the whole diagram rather than spilling raw markdown into the surface).
// The redaction BLOCK signal is preserved so a high-confidence secret inside a
// rendered label still trips the sticky's postability gate (a downstream
// whole-body pass only ever sees the already-redacted placeholder).
import { renderChangeMapMermaid, renderChangeMapOverviewMermaid } from "../diagrams/change-map";
import { renderDependencyTreeMermaid } from "../diagrams/dep-tree";
import { buildGroupDetailViews, detailViewSubGraph } from "../human/change-graph";
import { ChangeGraph, DependencyChain, RISK_LENS_METADATA } from "../human/contract";
import { changeMapLeadLevel, ChangeMapLevel } from "../human/legibility-budget";
import { redactSecrets } from "../privacy/secrets";

const MAX_EMBED_CHARS = 12_000;
const MAX_COMMENT_GROUPS = 8;
const MAX_COMMENT_EDGES = 5;

export interface ChangeMapEmbed {
  body?: string;
  blocked: boolean;
  // review-surfaces.MAP_SCALE.2: which level the legibility budget chose —
  // surfaces title the block honestly ("Change map" vs "Change map (overview)").
  level: ChangeMapLevel;
}

export function changeMapMermaidEmbed(graph: ChangeGraph): ChangeMapEmbed {
  // review-surfaces.MAP_SCALE.2: the legibility budget decides which level
  // leads — the SAME decision on every mermaid surface (md, sticky, PR
  // comment); this helper carries no threshold of its own.
  const level = changeMapLeadLevel(graph, "mermaid");
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

export function changeMapTitle(level: ChangeMapLevel): string {
  return level === "overview" ? "Change map (overview)" : "Change map";
}

/**
 * GitHub comment surfaces need a compact scan aid, not an overview Mermaid
 * made of disconnected prose-heavy boxes. Wide maps therefore render as a
 * bounded Markdown table with optional relationship bullets. Markdown tables
 * are stable in GitHub dark mode and remain useful when the graph has no
 * provider-backed edges. Small maps keep the file-level Mermaid.
 */
export function changeMapCommentBlock(graph: ChangeGraph): { body?: string; blocked: boolean } {
  const level = changeMapLeadLevel(graph, "mermaid");
  if (level !== "overview") {
    const embed = changeMapMermaidEmbed(graph);
    return {
      body: embed.body ? mermaidDetailsBlock(changeMapTitle(embed.level), embed.body) : undefined,
      blocked: embed.blocked
    };
  }
  if (graph.overview.groups.length === 0) {
    return { blocked: false };
  }
  let blocked = false;
  const safeCell = (value: string, compact = false): string => {
    const redaction = redactSecrets(value);
    blocked ||= redaction.blocked;
    return markdownCell(compact ? compactFocus(redaction.text) : redaction.text);
  };

  const groups = graph.overview.groups
    .map((group, index) => ({ group, index }))
    .sort((left, right) =>
      Number(right.group.queue_count > 0) - Number(left.group.queue_count > 0) ||
      right.group.queue_count - left.group.queue_count ||
      lensRank(left.group.lens) - lensRank(right.group.lens) ||
      left.index - right.index
    )
    .slice(0, MAX_COMMENT_GROUPS)
    .sort((left, right) => left.index - right.index)
    .map(({ group }) => group);
  const totalFiles = graph.overview.groups.reduce((sum, group) => sum + group.file_count, 0);
  const totalQueue = graph.overview.groups.reduce((sum, group) => sum + group.queue_count, 0);
  const title = `Change map — ${totalFiles} ${plural(totalFiles, "file")} · ${graph.overview.groups.length} ${plural(graph.overview.groups.length, "area")} · ${totalQueue} review ${plural(totalQueue, "item")}`;
  const lines = [
    `<details><summary>${title}</summary>`,
    "",
    "| Area | Files | Churn | Review focus |",
    "| --- | ---: | ---: | --- |",
    ...groups.map((group) => {
      const focus = [
        group.queue_count > 0 ? `${group.queue_count} queued` : undefined,
        group.summary,
        group.lens ? group.lens.replace(/_/g, " ") : undefined
      ].filter((value): value is string => Boolean(value)).join(" · ");
      return `| ${safeCell(group.name)} | ${group.file_count} | +${group.churn_added}/-${group.churn_removed} | ${safeCell(focus, true)} |`;
    })
  ];
  const omitted = graph.overview.groups.length - groups.length;
  if (omitted > 0) {
    lines.push(`| +${omitted} more ${plural(omitted, "area")} |  |  | Full map in artifact |`);
  }

  const eligibleRelationships = graph.overview.edges.filter((edge) =>
    edge.insight_source === "provider" || edge.has_new || edge.has_removed
  );
  const relationships = [...eligibleRelationships]
    .sort((left, right) =>
      Number(right.has_new || right.has_removed) - Number(left.has_new || left.has_removed) ||
      right.weight - left.weight ||
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to)
    )
    .slice(0, MAX_COMMENT_EDGES);
  if (relationships.length > 0) {
    lines.push("", "**Key relationships**", "");
    for (const edge of relationships) {
      const marker = edge.has_new && edge.has_removed
        ? "changed · "
        : edge.has_new
          ? "new · "
          : edge.has_removed
            ? "removed · "
            : "";
      const explanation = safeCell(edge.summary, true);
      lines.push(`- ${safeCell(edge.to)} → ${safeCell(edge.from)} (${marker}${edge.weight} ${plural(edge.weight, "link")})${explanation ? ` — ${explanation}` : ""}`);
    }
    const omittedRelationships = eligibleRelationships.length - relationships.length;
    if (omittedRelationships > 0) {
      lines.push(`- +${omittedRelationships} more ${plural(omittedRelationships, "relationship")}; see the full artifact.`);
    }
  }
  lines.push("", "</details>");

  const redaction = redactSecrets(lines.join("\n"));
  return { body: redaction.text, blocked: blocked || redaction.blocked };
}

function markdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;")
    .replace(/@/g, "&#64;")
    .replace(/\|/g, "\\|")
    .replace(/([!*_[\]{}()+.~\-])/g, "\\$1")
    .replace(/\b(https?|ftp|mailto):/gi, "$1&#58;")
    .replace(/\bwww\./gi, "www&#46;")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function compactFocus(value: string): string {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/\s+across \d+ files?/iu, "")
    .replace(/;\s*\d+ review-queue items?/iu, "")
    .replace(/;\s*[a-z /-]+ focus(?=\.|$)/iu, "")
    .trim();
  if (normalized.length <= 96) return normalized;
  const candidate = normalized.slice(0, 95);
  const boundary = candidate.lastIndexOf(" ");
  return `${boundary >= 60 ? candidate.slice(0, boundary) : candidate}…`;
}

function lensRank(lens: ChangeGraph["overview"]["groups"][number]["lens"]): number {
  return lens ? RISK_LENS_METADATA[lens].rank : Number.MAX_SAFE_INTEGER;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

// review-surfaces.MAP_SCALE.4/.6: per-group detail mermaid bodies for
// human_review.md — one embed-guarded block per overview group, in the
// model's deterministic group order. A body that trips the size cap or the
// fence-close guard comes back undefined so the caller can say so honestly;
// the redaction block signal is preserved per block.
export interface ChangeMapDetailEmbed {
  group: string;
  file_count: number;
  topic_count: number;
  body?: string;
  blocked: boolean;
}

export function changeMapDetailEmbeds(graph: ChangeGraph): ChangeMapDetailEmbed[] {
  return buildGroupDetailViews(graph).map((view) => {
    const group = graph.overview.groups.find((candidate) => candidate.name === view.group);
    const base = {
      group: view.group,
      file_count: group?.file_count ?? 0,
      topic_count: view.topics.length > 0 ? view.topics.length : group?.cluster_count ?? 0
    };
    const rendered = renderChangeMapMermaid(detailViewSubGraph(graph, view), { stubs: view.stubs });
    if (!rendered) {
      return { ...base, blocked: false };
    }
    const redaction = redactSecrets(rendered);
    if (redaction.text.length > MAX_EMBED_CHARS || /^\s*```/m.test(redaction.text)) {
      return { ...base, blocked: redaction.blocked };
    }
    return { ...base, body: redaction.text, blocked: redaction.blocked };
  });
}

// Collapsed <details> form for the comment surfaces (sticky + PR comment).
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
