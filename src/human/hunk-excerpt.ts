// review-surfaces.HUMAN_REVIEW.20: render a bounded inline diff excerpt for a
// review-queue item that carries hunk/line anchors, so a reviewer can act
// without opening another tool.
//
// The excerpt is sourced from the collected StructuredDiff (parsed from the
// already privacy-redacted .review-surfaces/inputs/diff.patch), and every
// rendered line is re-run through secret redaction as a defense-in-depth pass.
// Excerpts are bounded to ~10-15 lines so the queue stays scannable
// (review-surfaces.HUMAN_TRUST.4).

import { StructuredDiff, StructuredDiffFile, StructuredDiffHunk, StructuredDiffLine } from "../pr/contract";
import { formatHunkHeader, hunkOverlapsRange } from "../collector/diff-hunks";
import { redactSecrets } from "../privacy/secrets";

export const DEFAULT_HUNK_EXCERPT_MAX_LINES = 14;
const MAX_EXCERPT_LINE_CHARS = 200;

export interface HunkAnchor {
  path: string;
  old_path?: string;
  hunk_header?: string;
  line_start?: number;
  line_end?: number;
}

// Return a fenced ```diff excerpt for the anchor, or undefined when no diff,
// matching file, or hunk is available (the caller then renders no excerpt).
export function renderHunkExcerpt(
  diff: StructuredDiff | undefined,
  anchor: HunkAnchor,
  maxLines: number = DEFAULT_HUNK_EXCERPT_MAX_LINES
): string | undefined {
  if (!diff || diff.files.length === 0) {
    return undefined;
  }
  const file = findFile(diff, anchor);
  if (!file) {
    return undefined;
  }
  const side: "old" | "new" = file.status === "D" ? "old" : "new";
  const hunk = selectHunk(file, anchor, side);
  if (!hunk) {
    return undefined;
  }
  const body = excerptLines(hunk, Math.max(4, maxLines));
  if (body.length === 0) {
    return undefined;
  }
  const header = anchor.hunk_header ?? formatHunkHeader(hunk);
  return ["```diff", header, ...body, "```"].join("\n");
}

function findFile(diff: StructuredDiff, anchor: HunkAnchor): StructuredDiffFile | undefined {
  const wanted = normalizePath(anchor.path);
  const oldWanted = anchor.old_path ? normalizePath(anchor.old_path) : undefined;
  return diff.files.find((file) => {
    const candidates = [normalizePath(file.path)];
    if (file.old_path) {
      candidates.push(normalizePath(file.old_path));
    }
    return candidates.includes(wanted) || (oldWanted !== undefined && candidates.includes(oldWanted));
  });
}

function selectHunk(
  file: StructuredDiffFile,
  anchor: HunkAnchor,
  side: "old" | "new"
): StructuredDiffHunk | undefined {
  if (anchor.hunk_header) {
    const byHeader = file.hunks.find((hunk) => formatHunkHeader(hunk) === anchor.hunk_header);
    if (byHeader) {
      return byHeader;
    }
  }
  if (typeof anchor.line_start === "number" && anchor.line_start > 0) {
    const lineEnd = anchor.line_end && anchor.line_end >= anchor.line_start ? anchor.line_end : anchor.line_start;
    const overlapping = file.hunks.find((hunk) => hunkOverlapsRange(hunk, side, anchor.line_start as number, lineEnd));
    if (overlapping) {
      return overlapping;
    }
  }
  return file.hunks.find((hunk) => hunk.lines.some((line) => line.kind === "add" || line.kind === "delete"));
}

// Format the hunk body, bounded to maxLines. When the hunk is longer, keep a
// window centered on the changed lines and mark the elided context.
function excerptLines(hunk: StructuredDiffHunk, maxLines: number): string[] {
  const formatted = hunk.lines.map(formatDiffLine);
  if (formatted.length <= maxLines) {
    return formatted;
  }
  const changed = hunk.lines
    .map((line, index) => (line.kind === "add" || line.kind === "delete" ? index : -1))
    .filter((index) => index >= 0);
  const firstChanged = changed.length > 0 ? changed[0] : 0;
  let start = Math.max(0, firstChanged - 2);
  let end = Math.min(formatted.length, start + maxLines);
  start = Math.max(0, end - maxLines);
  const window = formatted.slice(start, end);
  if (start > 0) {
    window.unshift(`@@ … ${start} earlier line(s) elided @@`);
  }
  if (end < formatted.length) {
    window.push(`@@ … ${formatted.length - end} more line(s) elided @@`);
  }
  return window;
}

function formatDiffLine(line: StructuredDiffLine): string {
  const marker = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
  const text = redactSecrets(line.text).text.replace(/\r?\n/g, " ");
  const bounded = text.length <= MAX_EXCERPT_LINE_CHARS ? text : `${text.slice(0, MAX_EXCERPT_LINE_CHARS - 1)}…`;
  return `${marker}${bounded}`;
}

function normalizePath(value: string): string {
  return value.replace(/^\.\//, "").replace(/^\/+/, "");
}
