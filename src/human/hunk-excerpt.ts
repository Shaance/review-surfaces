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
  // The diff side the anchor path matched (old for a deletion / rename source).
  // When set it overrides the path heuristic and orders candidate files, so a
  // path shared by a new file and a rename source resolves unambiguously.
  side?: "old" | "new";
}

// Return a fenced ```diff excerpt for the anchor, or undefined when no diff,
// matching file, or hunk is available (the caller then renders no excerpt).
// Optional sink for the redaction block signal: formatDiffLine redacts each line
// and, when given a state, records whether any line held a high-confidence secret
// so a caller (the sticky comment) can refuse to post a blocked excerpt.
export interface ExcerptRedactionState {
  blocked: boolean;
}

export function renderHunkExcerpt(
  diff: StructuredDiff | undefined,
  anchor: HunkAnchor,
  maxLines: number = DEFAULT_HUNK_EXCERPT_MAX_LINES,
  redactionState?: ExcerptRedactionState
): string | undefined {
  if (!diff || diff.files.length === 0) {
    return undefined;
  }
  // Resolve the (file, side, hunk) the anchor actually points at. Several files
  // can share a path in a replacement/chain rename (a new A plus a rename
  // A->B), so try the candidates in precision order and pick the FIRST whose
  // hunk matches the anchor. Letting the hunk match disambiguate handles both a
  // new-side anchor (resolves to the rename target) and an old-side anchor
  // (resolves to the rename source) without guessing from the path alone.
  let resolved: { side: "old" | "new"; hunk: StructuredDiffHunk } | undefined;
  for (const candidate of candidateFiles(diff, anchor)) {
    const side = sideForAnchor(candidate, anchor);
    const hunk = selectHunk(candidate, anchor, side);
    if (hunk) {
      resolved = { side, hunk };
      break;
    }
  }
  if (!resolved) {
    return undefined;
  }
  const { side, hunk } = resolved;
  const body = excerptLines(hunk, side, anchor, Math.max(4, maxLines), redactionState);
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
  // An explicit side from the queue anchor is authoritative.
  if (anchor.side) {
    return anchor.side;
  }
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

// Candidate files the anchor might refer to, ordered most- to least-precise and
// de-duplicated. The caller picks the first whose hunk matches the anchor, so a
// path shared by a new file and a rename source both appear and the hunk match
// decides between them.
function candidateFiles(diff: StructuredDiff, anchor: HunkAnchor): StructuredDiffFile[] {
  const wantedNew = normalizePath(anchor.path);
  const wantedOld = anchor.old_path ? normalizePath(anchor.old_path) : undefined;
  const byNewPath = diff.files.filter((file) => normalizePath(file.path) === wantedNew);
  const byRenameSource = diff.files.filter((file) => Boolean(file.old_path) && normalizePath(file.old_path as string) === wantedNew);
  const byOldPath = wantedOld === undefined
    ? []
    : diff.files.filter(
        (file) => normalizePath(file.path) === wantedOld || (Boolean(file.old_path) && normalizePath(file.old_path as string) === wantedOld)
      );
  // For an OLD-side anchor, a rename whose source is the anchor path is the
  // intended file, so try it before an exact new-path match (which would be an
  // unrelated replacement file re-adding the same path). Otherwise prefer the
  // exact new-path match.
  const ordered: StructuredDiffFile[] =
    anchor.side === "old"
      ? [...byRenameSource, ...byNewPath, ...byOldPath]
      : [...byNewPath, ...byRenameSource, ...byOldPath];
  const seen = new Set<StructuredDiffFile>();
  return ordered.filter((file) => (seen.has(file) ? false : (seen.add(file), true)));
}

function selectHunk(
  file: StructuredDiffFile,
  anchor: HunkAnchor,
  side: "old" | "new"
): StructuredDiffHunk | undefined {
  const hasAnchor = Boolean(anchor.hunk_header) || (typeof anchor.line_start === "number" && anchor.line_start > 0);
  // Prefer a SIDE-AWARE line-overlap match when a line range is present. A shared
  // hunk header/range (common for one-line top-of-file changes) can otherwise let
  // a new-side candidate win for an old-side anchor; the line overlap is computed
  // on the resolved side, so it disambiguates the intended file before a
  // header-only match is accepted.
  if (typeof anchor.line_start === "number" && anchor.line_start > 0) {
    const lineEnd = anchor.line_end && anchor.line_end >= anchor.line_start ? anchor.line_end : anchor.line_start;
    const overlapping = file.hunks.find((hunk) => hunkOverlapsRange(hunk, side, anchor.line_start as number, lineEnd));
    if (overlapping) {
      return overlapping;
    }
  }
  if (anchor.hunk_header) {
    const byHeader = file.hunks.find((hunk) => formatHunkHeader(hunk) === anchor.hunk_header);
    if (byHeader) {
      return byHeader;
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
// review-surfaces.COVERAGE.6: a structured excerpt variant for renderers that
// need per-line metadata — the HTML cockpit's coverage gutter keys off each
// line's kind and new-side line number. The text is the SAME redacted,
// prefix-formatted line the plain excerpt renders.
export interface StructuredExcerptLine {
  text: string;
  kind: StructuredDiffLine["kind"] | "elision";
  new_line?: number;
}

export interface StructuredExcerpt {
  header: string;
  lines: StructuredExcerptLine[];
}

// review-surfaces.PRIVACY.6: accepts an optional redaction-state sink, at API
// parity with renderHunkExcerpt. structuredWindow already redacts each line and
// can record a high-confidence secret hit; before, resolveStructuredExcerpt
// dropped that signal on the floor, so the cockpit excerpt path (render-html)
// could not detect a blocked excerpt the way the plain path can.
export function resolveStructuredExcerpt(
  diff: StructuredDiff | undefined,
  anchor: HunkAnchor,
  maxLines: number = DEFAULT_HUNK_EXCERPT_MAX_LINES,
  redactionState?: ExcerptRedactionState
): StructuredExcerpt | undefined {
  if (!diff || diff.files.length === 0) {
    return undefined;
  }
  for (const candidate of candidateFiles(diff, anchor)) {
    const side = sideForAnchor(candidate, anchor);
    const hunk = selectHunk(candidate, anchor, side);
    if (hunk) {
      const lines = structuredWindow(hunk, side, anchor, Math.max(4, maxLines), redactionState);
      return lines.length > 0 ? { header: formatHunkHeader(hunk), lines } : undefined;
    }
  }
  return undefined;
}

function structuredWindow(
  hunk: StructuredDiffHunk,
  side: "old" | "new",
  anchor: HunkAnchor,
  maxLines: number,
  redactionState?: ExcerptRedactionState
): StructuredExcerptLine[] {
  const formatted: StructuredExcerptLine[] = hunk.lines.map((line) => ({
    text: formatDiffLine(line, redactionState),
    kind: line.kind,
    ...(typeof line.new_line === "number" ? { new_line: line.new_line } : {})
  }));
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
    window.unshift({ text: `@@ … ${start} earlier line(s) elided @@`, kind: "elision" });
  }
  if (end < formatted.length) {
    window.push({ text: `@@ … ${formatted.length - end} more line(s) elided @@`, kind: "elision" });
  }
  return window;
}

function excerptLines(
  hunk: StructuredDiffHunk,
  side: "old" | "new",
  anchor: HunkAnchor,
  maxLines: number,
  redactionState?: ExcerptRedactionState
): string[] {
  return structuredWindow(hunk, side, anchor, maxLines, redactionState).map((line) => line.text);
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

function formatDiffLine(line: StructuredDiffLine, redactionState?: ExcerptRedactionState): string {
  const marker = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
  const redaction = redactSecrets(line.text);
  if (redaction.blocked && redactionState) {
    redactionState.blocked = true;
  }
  const text = redaction.text.replace(/\r?\n/g, " ");
  const bounded = text.length <= MAX_EXCERPT_LINE_CHARS ? text : `${text.slice(0, MAX_EXCERPT_LINE_CHARS - 1)}…`;
  return `${marker}${bounded}`;
}

function normalizePath(value: string): string {
  return value.replace(/^\.\//, "").replace(/^\/+/, "");
}
