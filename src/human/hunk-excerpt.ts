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
  const side = sideForAnchor(file, anchor);
  const hunk = selectHunk(file, anchor, side);
  if (!hunk) {
    return undefined;
  }
  const body = excerptLines(hunk, side, anchor, Math.max(4, maxLines));
  if (body.length === 0) {
    return undefined;
  }
  // Always print the SELECTED hunk's header. A stale anchor.hunk_header may have
  // failed the header lookup and been replaced by a line-overlap match, so
  // echoing the anchor header could name a different hunk than the body shown.
  const header = formatHunkHeader(hunk);
  // Use a fence longer than any backtick run in the content so a diff line that
  // itself contains ``` (common in Markdown/test changes) cannot prematurely
  // close the excerpt and corrupt the surrounding review surface.
  const fence = "`".repeat(Math.max(3, longestBacktickRun([header, ...body]) + 1));
  return [`${fence}diff`, header, ...body, fence].join("\n");
}

// Choose which side's line numbers the excerpt should use. A deletion lives on
// the old side; a rename whose anchor points at the old path is also old-side
// (its old/new hunk line numbers differ). Everything else is new-side.
function sideForAnchor(file: StructuredDiffFile, anchor: HunkAnchor): "old" | "new" {
  if (file.status === "D") {
    return "old";
  }
  if (file.old_path) {
    const anchorPath = normalizePath(anchor.path);
    if (normalizePath(file.old_path) === anchorPath && normalizePath(file.path) !== anchorPath) {
      return "old";
    }
  }
  return "new";
}

function longestBacktickRun(lines: string[]): number {
  let max = 0;
  for (const line of lines) {
    for (const match of line.matchAll(/`+/g)) {
      max = Math.max(max, match[0].length);
    }
  }
  return max;
}

function findFile(diff: StructuredDiff, anchor: HunkAnchor): StructuredDiffFile | undefined {
  const matches = (file: StructuredDiffFile, wanted: string): boolean => {
    if (normalizePath(file.path) === wanted) {
      return true;
    }
    return Boolean(file.old_path) && normalizePath(file.old_path as string) === wanted;
  };
  // Prefer a match on the anchor's primary (new) path first, so a
  // replacement-rename (rename A->B plus a new A) resolves the excerpt to B
  // rather than the unrelated A that happens to appear earlier in the diff. Only
  // then fall back to the anchor's old_path.
  const byPath = diff.files.find((file) => matches(file, normalizePath(anchor.path)));
  if (byPath) {
    return byPath;
  }
  if (anchor.old_path) {
    return diff.files.find((file) => matches(file, normalizePath(anchor.old_path as string)));
  }
  return undefined;
}

function selectHunk(
  file: StructuredDiffFile,
  anchor: HunkAnchor,
  side: "old" | "new"
): StructuredDiffHunk | undefined {
  const hasAnchor = Boolean(anchor.hunk_header) || (typeof anchor.line_start === "number" && anchor.line_start > 0);
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
  // When the item carried a hunk/line anchor but nothing matched (stale, out of
  // range, or wrong-side), omit the excerpt rather than showing an unrelated
  // first-changed hunk — a plausible-but-wrong excerpt is worse than none. The
  // first-changed-hunk fallback only applies to items with no usable anchor.
  if (hasAnchor) {
    return undefined;
  }
  return file.hunks.find((hunk) => hunk.lines.some((line) => line.kind === "add" || line.kind === "delete"));
}

// Format the hunk body, bounded to maxLines. When the hunk is longer, keep a
// window centered on the queue item's anchored line(s) — not merely the first
// change in the hunk — so an item anchored to a later cluster in the same hunk
// still shows the line the reviewer must inspect. Falls back to the first
// changed line when the anchor carries no usable range.
function excerptLines(
  hunk: StructuredDiffHunk,
  side: "old" | "new",
  anchor: HunkAnchor,
  maxLines: number
): string[] {
  const formatted = hunk.lines.map(formatDiffLine);
  if (formatted.length <= maxLines) {
    return formatted;
  }
  // Reserve up to two lines for the leading/trailing elision markers so the
  // returned body never exceeds maxLines once the markers are added.
  const budget = Math.max(1, maxLines - 2);
  const focus = focusIndexForAnchor(hunk, side, anchor);
  let start = Math.max(0, focus - Math.floor(budget / 2));
  let end = Math.min(formatted.length, start + budget);
  start = Math.max(0, end - budget);
  const window = formatted.slice(start, end);
  if (start > 0) {
    window.unshift(`@@ … ${start} earlier line(s) elided @@`);
  }
  if (end < formatted.length) {
    window.push(`@@ … ${formatted.length - end} more line(s) elided @@`);
  }
  return window;
}

// Pick the line index to center the excerpt window on: the first line whose
// side-specific line number falls within the anchor's [line_start, line_end]
// range, else the first changed line in the hunk, else the start of the hunk.
function focusIndexForAnchor(hunk: StructuredDiffHunk, side: "old" | "new", anchor: HunkAnchor): number {
  if (typeof anchor.line_start === "number" && anchor.line_start > 0) {
    const lineEnd = anchor.line_end && anchor.line_end >= anchor.line_start ? anchor.line_end : anchor.line_start;
    const anchored = hunk.lines.findIndex((line) => {
      const lineNumber = side === "old" ? line.old_line : line.new_line;
      return typeof lineNumber === "number" && lineNumber >= (anchor.line_start as number) && lineNumber <= lineEnd;
    });
    if (anchored >= 0) {
      return anchored;
    }
  }
  const firstChanged = hunk.lines.findIndex((line) => line.kind === "add" || line.kind === "delete");
  return firstChanged >= 0 ? firstChanged : 0;
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
