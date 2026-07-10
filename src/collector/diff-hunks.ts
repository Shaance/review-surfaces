import {
  StructuredDiff,
  StructuredDiffFile,
  StructuredDiffHunk,
  StructuredDiffLine
} from "../contracts/pr-review";

// ---------------------------------------------------------------------------
// Unified-diff parser -> StructuredDiff (review-surfaces.pr_surface.v1).
//
// Parses standard `git diff` unified output (the redacted
// .review-surfaces/inputs/diff.patch shape): `diff --git a/X b/Y` section
// headers, extended headers (new/deleted/rename/copy/index/mode/Binary),
// `--- a/..` / `+++ b/..` path lines, `@@ -os,ol +ns,nl @@` hunk headers, and
// body lines prefixed with ' ' (context), '+' (add), '-' (delete).
//
// Hard determinism rules for this repo:
//   - File order is the order files appear in the diff (no sorting).
//   - No clocks / randomness / IO; a pure (string) -> StructuredDiff function.
//   - Robust: never throws. Binary/empty/malformed sections degrade to a
//     hunk-less file or are skipped; '\ No newline at end of file' is ignored.
// ---------------------------------------------------------------------------

const DEV_NULL = "/dev/null";

// Mutable accumulator for the file section currently being parsed.
interface FileAccumulator {
  // Paths captured from the `diff --git a/X b/Y` header (used as a fallback when
  // no `---`/`+++` lines appear, e.g. pure-rename or binary sections).
  headerOldPath?: string;
  headerNewPath?: string;
  // Paths captured from explicit `rename from`/`rename to` / `copy from`/`copy to`.
  renameFrom?: string;
  renameTo?: string;
  // Paths captured from the `---`/`+++` lines (authoritative when present).
  minusPath?: string; // a/.. side; "/dev/null" when this is an add
  plusPath?: string; // b/.. side; "/dev/null" when this is a delete
  sawNewFile: boolean;
  sawDeletedFile: boolean;
  sawRename: boolean;
  sawCopy?: boolean;
  hunks: StructuredDiffHunk[];
}

/**
 * Parse a unified diff string into the StructuredDiff contract. Never throws:
 * malformed input yields whatever files/hunks could be recovered (possibly an
 * empty `files` array).
 */
export function parseStructuredDiff(diffText: string): StructuredDiff {
  const files: StructuredDiffFile[] = [];
  if (typeof diffText !== "string" || diffText.length === 0) {
    return { files };
  }

  const lines = diffText.split("\n");
  let acc: FileAccumulator | undefined;
  // Hunk currently being filled, plus the running old/new line cursors.
  let hunk: StructuredDiffHunk | undefined;
  let oldCursor = 0;
  let newCursor = 0;

  const closeHunk = (): void => {
    if (acc && hunk) {
      acc.hunks.push(hunk);
    }
    hunk = undefined;
  };

  const closeFile = (): void => {
    closeHunk();
    if (acc) {
      const built = buildFile(acc);
      if (built) {
        files.push(built);
      }
    }
    acc = undefined;
  };

  for (const rawLine of lines) {
    // Strip a trailing CR so CRLF diffs parse identically to LF ones.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      // New file section begins: flush the previous one.
      closeFile();
      acc = { sawNewFile: false, sawDeletedFile: false, sawRename: false, hunks: [] };
      const parsed = parseDiffGitHeader(line);
      if (parsed) {
        acc.headerOldPath = parsed.oldPath;
        acc.headerNewPath = parsed.newPath;
      }
      continue;
    }

    if (!acc) {
      // Preamble before any `diff --git` header (or unrelated text): skip.
      continue;
    }

    if (line.startsWith("@@")) {
      closeHunk();
      const header = parseHunkHeader(line);
      if (!header) {
        // Malformed hunk header: skip it but keep the file. Body lines until the
        // next recognizable header are ignored because `hunk` stays undefined.
        continue;
      }
      hunk = {
        old_start: header.oldStart,
        old_lines: header.oldLines,
        new_start: header.newStart,
        new_lines: header.newLines,
        lines: []
      };
      oldCursor = header.oldStart;
      newCursor = header.newStart;
      continue;
    }

    if (!hunk) {
      // We are in a file section but not inside a hunk: parse extended headers.
      if (line.startsWith("--- ")) {
        acc.minusPath = parsePathLine(line.slice(4));
        continue;
      }
      if (line.startsWith("+++ ")) {
        acc.plusPath = parsePathLine(line.slice(4));
        continue;
      }
      if (line.startsWith("new file mode")) {
        acc.sawNewFile = true;
        continue;
      }
      if (line.startsWith("deleted file mode")) {
        acc.sawDeletedFile = true;
        continue;
      }
      if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
        // Copies are NOT renames: the source still exists, so the copy is an
        // additional file (status C) and old_path stays rename-only.
        if (line.startsWith("copy from ")) {
          acc.sawCopy = true;
        } else {
          acc.sawRename = true;
        }
        acc.renameFrom = afterPrefix(line, "from ");
        continue;
      }
      if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
        if (line.startsWith("copy to ")) {
          acc.sawCopy = true;
        } else {
          acc.sawRename = true;
        }
        acc.renameTo = afterPrefix(line, "to ");
        continue;
      }
      // `index ..`, `Binary files ..`, `old mode`, `new mode`, `similarity
      // index`, `GIT binary patch`, blank lines, etc. carry no per-line data —
      // ignore them. Binary sections simply never open a hunk, so they degrade
      // to a hunk-less file (handled in buildFile).
      continue;
    }

    // Inside a hunk: classify the body line by its leading marker.
    if (line.startsWith("\\")) {
      // `\ No newline at end of file` marker: not a content line. Ignore.
      continue;
    }

    if (line.length === 0) {
      // A zero-length line is NOT a diff body line: a genuine blank context line
      // in git output is a single space (" "), not "". An empty line is the
      // trailing-newline artifact from split("\n") or a blank between sections,
      // so it ends the current hunk rather than emitting a phantom context line.
      closeHunk();
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);

    if (marker === "+") {
      hunk.lines.push(makeLine("add", text, undefined, newCursor));
      newCursor += 1;
      continue;
    }
    if (marker === "-") {
      hunk.lines.push(makeLine("delete", text, oldCursor, undefined));
      oldCursor += 1;
      continue;
    }
    if (marker === " ") {
      hunk.lines.push(makeLine("context", text, oldCursor, newCursor));
      oldCursor += 1;
      newCursor += 1;
      continue;
    }

    // An unexpected marker inside a hunk (e.g. a stray line from a malformed
    // section). Treat it as end-of-hunk and ignore the line rather than throw.
    closeHunk();
  }

  closeFile();
  return { files };
}

function makeLine(
  kind: StructuredDiffLine["kind"],
  text: string,
  oldLine: number | undefined,
  newLine: number | undefined
): StructuredDiffLine {
  const out: StructuredDiffLine = { kind, text };
  // Omit undefined fields (byte-stability requirement) by only assigning when set.
  if (oldLine !== undefined) {
    out.old_line = oldLine;
  }
  if (newLine !== undefined) {
    out.new_line = newLine;
  }
  return out;
}

// Resolve the final file record from the accumulated section, or undefined when
// no usable path could be determined (a truly malformed section to skip).
function buildFile(acc: FileAccumulator): StructuredDiffFile | undefined {
  const newPath = resolveNewPath(acc);
  const oldPath = resolveOldPath(acc);

  if (newPath === undefined && oldPath === undefined) {
    // Nothing identifiable: skip gracefully.
    return undefined;
  }

  // For a deletion, b/ is /dev/null so the surviving "path" is the old a/ path;
  // the contract's `path` is always the (new) path, falling back to old when the
  // new side is /dev/null or absent (deletion).
  const isDelete = acc.sawDeletedFile || acc.plusPath === DEV_NULL;
  const isAdd = acc.sawNewFile || acc.minusPath === DEV_NULL;
  // A rename requires distinct, REAL (non-/dev/null) old and new paths. Without
  // the /dev/null guard a delete (new = /dev/null) or add (old = /dev/null)
  // would look like a rename because the two sides differ.
  const isCopy = !isAdd && !isDelete && Boolean(acc.sawCopy);
  const isRename =
    !isAdd &&
    !isDelete &&
    !isCopy &&
    (acc.sawRename ||
      (oldPath !== undefined &&
        newPath !== undefined &&
        oldPath !== DEV_NULL &&
        newPath !== DEV_NULL &&
        oldPath !== newPath));

  const path = pickPrimaryPath(newPath, oldPath, isDelete);
  if (path === undefined) {
    return undefined;
  }

  const file: StructuredDiffFile = {
    path,
    status: resolveStatus({ isAdd, isDelete, isRename, isCopy }),
    hunks: acc.hunks
  };

  // old_path is only meaningful for a rename (a/ != b/). For add/delete/modify
  // it is omitted (undefined fields are never serialized).
  if (isRename && oldPath !== undefined && oldPath !== newPath && oldPath !== DEV_NULL) {
    file.old_path = oldPath;
  }

  return file;
}

// The contract's `path` is the new (b/) path. For a deletion the b/ side is
// /dev/null, so the meaningful identifier is the old (a/) path.
function pickPrimaryPath(
  newPath: string | undefined,
  oldPath: string | undefined,
  isDelete: boolean
): string | undefined {
  if (isDelete) {
    if (oldPath !== undefined && oldPath !== DEV_NULL) {
      return oldPath;
    }
    if (newPath !== undefined && newPath !== DEV_NULL) {
      return newPath;
    }
    return undefined;
  }
  if (newPath !== undefined && newPath !== DEV_NULL) {
    return newPath;
  }
  if (oldPath !== undefined && oldPath !== DEV_NULL) {
    return oldPath;
  }
  return undefined;
}

function resolveStatus(flags: { isAdd: boolean; isDelete: boolean; isRename: boolean; isCopy: boolean }): string {
  if (flags.isDelete) {
    return "D";
  }
  if (flags.isAdd) {
    return "A";
  }
  if (flags.isCopy) {
    return "C";
  }
  if (flags.isRename) {
    return "R";
  }
  return "modified";
}

// Prefer the explicit `+++ b/..` path, then the `rename to`/`copy to` target,
// then the `diff --git` b/ side. /dev/null is preserved so callers can detect a
// deletion; it is filtered out only when choosing the primary path.
function resolveNewPath(acc: FileAccumulator): string | undefined {
  if (acc.plusPath !== undefined) {
    return acc.plusPath;
  }
  if (acc.renameTo !== undefined) {
    return acc.renameTo;
  }
  return acc.headerNewPath;
}

function resolveOldPath(acc: FileAccumulator): string | undefined {
  if (acc.minusPath !== undefined) {
    return acc.minusPath;
  }
  if (acc.renameFrom !== undefined) {
    return acc.renameFrom;
  }
  return acc.headerOldPath;
}

export interface DiffGitHeader {
  oldPath?: string;
  newPath?: string;
}

// Parse the `diff --git a/X b/Y` header. X and Y may contain spaces, which makes
// this ambiguous in the general case; we use the conventional `a/`...` b/` split
// and fall back to a midpoint split for equal-length names. Returns whatever
// could be recovered (best-effort, never throws). Exported so the privacy
// ignore-diff filter (src/privacy/diff.ts) reuses the SAME quote-aware parser
// and the two cannot drift (review-surfaces.PRIVACY.6).
export function parseDiffGitHeader(line: string): DiffGitHeader | undefined {
  const rest = line.slice("diff --git ".length).trim();
  if (rest.length === 0) {
    return undefined;
  }

  // Quoted form: `diff --git "a/x" "b/y"` (git quotes paths with special chars).
  if (rest.startsWith('"')) {
    const quoted = splitQuotedPair(rest);
    if (quoted) {
      return {
        oldPath: decodeGitQuotedPath(stripAbPrefix(quoted.first)),
        newPath: decodeGitQuotedPath(stripAbPrefix(quoted.second))
      };
    }
  }

  // Common case: split on " b/" preceded by an "a/" prefix.
  const marker = rest.indexOf(" b/");
  if (rest.startsWith("a/") && marker > 0) {
    const first = rest.slice(0, marker);
    const second = rest.slice(marker + 1);
    return { oldPath: stripAbPrefix(first), newPath: stripAbPrefix(second) };
  }

  // Fallback: if the line is `a/... b/...` without spaces in names, a plain
  // whitespace split recovers both halves.
  const parts = rest.split(" ");
  if (parts.length === 2) {
    return { oldPath: stripAbPrefix(parts[0]), newPath: stripAbPrefix(parts[1]) };
  }

  // Last resort: equal-length symmetric split around the midpoint space.
  const mid = Math.floor(rest.length / 2);
  if (rest[mid] === " ") {
    return { oldPath: stripAbPrefix(rest.slice(0, mid)), newPath: stripAbPrefix(rest.slice(mid + 1)) };
  }

  return { newPath: stripAbPrefix(rest) };
}

function splitQuotedPair(rest: string): { first: string; second: string } | undefined {
  // Find the closing quote of the first token, then the opening quote of the
  // second. We do not unescape git's octal escapes; the raw inner text is kept.
  const firstEnd = rest.indexOf('"', 1);
  if (firstEnd < 0) {
    return undefined;
  }
  const first = rest.slice(1, firstEnd);
  const remainder = rest.slice(firstEnd + 1).trim();
  if (remainder.startsWith('"')) {
    const secondEnd = remainder.indexOf('"', 1);
    if (secondEnd > 0) {
      return { first, second: remainder.slice(1, secondEnd) };
    }
  }
  // Second token unquoted.
  if (remainder.length > 0) {
    return { first, second: remainder };
  }
  return undefined;
}

// Parse a `---`/`+++` path operand: strip a single `a/` or `b/` prefix, decode a
// quoted path's outer quotes, and pass `/dev/null` through verbatim.
function parsePathLine(operand: string): string | undefined {
  // Drop a trailing tab + timestamp that some diff tools append (`path\t2026-..`).
  let value = operand;
  const tab = value.indexOf("\t");
  if (tab >= 0) {
    value = value.slice(0, tab);
  }
  value = value.trim();
  if (value.length === 0) {
    return undefined;
  }
  let wasQuoted = false;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
    wasQuoted = true;
  }
  if (value === DEV_NULL) {
    return DEV_NULL;
  }
  const stripped = stripAbPrefix(value);
  // A quoted path keeps git's C-style escapes (\t, \", octal \NNN for non-ASCII
  // bytes); decode them to the real filename so it matches the repo-indexed
  // anchor path and the inline excerpt resolves.
  return wasQuoted ? decodeGitQuotedPath(stripped) : stripped;
}

// Decode the inner text of a git-quoted path: C escapes (\t \n \r \" \\ \a \b
// \f \v) and octal \NNN byte runs (git escapes each UTF-8 byte of a non-ASCII
// name), reassembled as UTF-8. Pure and never throws. Exported so the privacy
// ignore filter (src/privacy/diff.ts) decodes quoted `---`/`+++` body paths too
// (review-surfaces.PRIVACY.6).
export function decodeGitQuotedPath(input: string): string {
  const bytes: number[] = [];
  let i = 0;
  const simple: Record<string, number> = { t: 9, n: 10, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 0x22, "\\": 0x5c };
  while (i < input.length) {
    const ch = input[i];
    if (ch !== "\\") {
      for (const byte of Buffer.from(ch, "utf8")) {
        bytes.push(byte);
      }
      i += 1;
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }
    if (next >= "0" && next <= "7") {
      let oct = "";
      let j = i + 1;
      while (j < input.length && oct.length < 3 && input[j] >= "0" && input[j] <= "7") {
        oct += input[j];
        j += 1;
      }
      bytes.push(Number.parseInt(oct, 8) & 0xff);
      i = j;
      continue;
    }
    if (simple[next] !== undefined) {
      bytes.push(simple[next]);
      i += 2;
      continue;
    }
    // Unknown escape: keep the escaped character literally.
    for (const byte of Buffer.from(next, "utf8")) {
      bytes.push(byte);
    }
    i += 2;
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripAbPrefix(value: string): string {
  if (value === DEV_NULL) {
    return DEV_NULL;
  }
  if (value.startsWith("a/") || value.startsWith("b/")) {
    return value.slice(2);
  }
  return value;
}

function afterPrefix(line: string, prefix: string): string | undefined {
  const idx = line.indexOf(prefix);
  if (idx < 0) {
    return undefined;
  }
  const value = line.slice(idx + prefix.length).trim();
  return value.length > 0 ? stripAbPrefix(value) : undefined;
}

interface HunkHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

// Parse `@@ -oldStart[,oldLines] +newStart[,newLines] @@[ optional section]`.
// Counts default to 1 when the `,N` portion is omitted (git convention).
function parseHunkHeader(line: string): HunkHeader | undefined {
  const match = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return undefined;
  }
  const oldStart = toInt(match[1]);
  const newStart = toInt(match[3]);
  if (oldStart === undefined || newStart === undefined) {
    return undefined;
  }
  // When `,N` is omitted the count is 1; when present (even `0`) use that value.
  const oldLines = match[2] === undefined ? 1 : toInt(match[2]) ?? 1;
  const newLines = match[4] === undefined ? 1 : toInt(match[4]) ?? 1;
  return { oldStart, oldLines, newStart, newLines };
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Hunk geometry helpers, shared by the human-review queue anchoring
// (src/human/human-review.ts) and the inline hunk excerpt renderer
// (src/human/hunk-excerpt.ts) so the header format and overlap math stay in one
// place.
// ---------------------------------------------------------------------------

/** Reconstruct the `@@ -os,ol +ns,nl @@` header for a structured hunk. */
export function formatHunkHeader(hunk: StructuredDiffHunk): string {
  return `@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@`;
}

/**
 * True when the hunk's range on the given side overlaps the inclusive
 * [lineStart, lineEnd] window. Counts below 1 are clamped to a single line.
 */
export function hunkOverlapsRange(
  hunk: StructuredDiffHunk,
  side: "old" | "new",
  lineStart: number,
  lineEnd: number
): boolean {
  const hunkStart = side === "old" ? hunk.old_start : hunk.new_start;
  const hunkLines = side === "old" ? hunk.old_lines : hunk.new_lines;
  const hunkEnd = hunkStart + Math.max(hunkLines, 1) - 1;
  return hunkStart > 0 && hunkStart <= lineEnd && hunkEnd >= lineStart;
}
