// review-surfaces.SEMANTIC_DIFF.5 — a small, deterministic Swift lexer.
//
// Its only job is to remove the parts of Swift source that must NOT leak into the
// declaration scanner: comments (line + nested block) and string literals
// (ordinary, multiline, and raw with any hash count, including their interpolated
// segments). Everything removed is replaced with SPACES of the same length and
// newlines are preserved, so byte offsets and line numbers in the cleaned string
// line up with the original (the declaration scanner reports real lines).
//
// This is NOT a compiler (goal contract D3): it never evaluates code, and an
// interpolation `\(expr)` inside a string is blanked wholesale rather than
// re-scanned, which is the conservative choice — we would rather miss a fact than
// invent one from string contents.

export interface SwiftCleanResult {
  // Source with comments/strings blanked to spaces; same length as the input.
  cleaned: string;
}

type State =
  | { kind: "code" }
  | { kind: "line_comment" }
  | { kind: "block_comment"; depth: number }
  | { kind: "string"; hashes: number; multiline: boolean };

// Replace [start,end) of `out` with spaces, preserving any newline characters so
// line numbers are unchanged.
function blank(source: string, out: string[], start: number, end: number): void {
  for (let i = start; i < end; i += 1) {
    out[i] = source[i] === "\n" ? "\n" : " ";
  }
}

export interface CleanSwiftOptions {
  // When true, string literals are tracked (so a `//` inside one is not read as a
  // comment) but their contents are PRESERVED. Used by readers that need string
  // values (e.g. Package.swift target names) while still dropping comments.
  keepStrings?: boolean;
}

export function cleanSwiftSource(source: string, options: CleanSwiftOptions = {}): string {
  const keepStrings = options.keepStrings === true;
  const out = source.split("");
  let state: State = { kind: "code" };
  let segmentStart = 0;
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : "";

    switch (state.kind) {
      case "code": {
        if (ch === "/" && next === "/") {
          state = { kind: "line_comment" };
          segmentStart = i;
          i += 2;
          continue;
        }
        if (ch === "/" && next === "*") {
          state = { kind: "block_comment", depth: 1 };
          segmentStart = i;
          i += 2;
          continue;
        }
        // Raw string: one or more `#` then `"` (and `"""` for multiline raw).
        if (ch === "#") {
          let hashes = 0;
          let j = i;
          while (j < n && source[j] === "#") {
            hashes += 1;
            j += 1;
          }
          if (source[j] === '"') {
            const multiline = source.slice(j, j + 3) === '"""';
            state = { kind: "string", hashes, multiline };
            segmentStart = i;
            i = j + (multiline ? 3 : 1);
            continue;
          }
          i += 1;
          continue;
        }
        if (ch === '"') {
          const multiline = source.slice(i, i + 3) === '"""';
          state = { kind: "string", hashes: 0, multiline };
          segmentStart = i;
          i += multiline ? 3 : 1;
          continue;
        }
        i += 1;
        continue;
      }
      case "line_comment": {
        if (ch === "\n") {
          blank(source, out, segmentStart, i);
          state = { kind: "code" };
          segmentStart = i;
          i += 1;
          continue;
        }
        i += 1;
        continue;
      }
      case "block_comment": {
        if (ch === "/" && next === "*") {
          state = { kind: "block_comment", depth: state.depth + 1 };
          i += 2;
          continue;
        }
        if (ch === "*" && next === "/") {
          const depth: number = state.depth - 1;
          if (depth === 0) {
            blank(source, out, segmentStart, i + 2);
            state = { kind: "code" };
            segmentStart = i + 2;
            i += 2;
            continue;
          }
          state = { kind: "block_comment", depth };
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      case "string": {
        const { hashes, multiline } = state;
        // Escapes apply only with zero hashes; with N hashes the escape is `\`
        // followed by N `#`s. We just skip an escaped char so an escaped closing
        // quote does not end the string early.
        if (ch === "\\") {
          if (hashes === 0) {
            i += 2;
            continue;
          }
          const escapeTail = source.slice(i + 1, i + 1 + hashes);
          if (escapeTail === "#".repeat(hashes)) {
            i += 1 + hashes + 1;
            continue;
          }
          i += 1;
          continue;
        }
        const closer = multiline ? '"""' : '"';
        if (source.slice(i, i + closer.length) === closer && source.slice(i + closer.length, i + closer.length + hashes) === "#".repeat(hashes)) {
          const end = i + closer.length + hashes;
          if (!keepStrings) {
            blank(source, out, segmentStart, end);
          }
          state = { kind: "code" };
          segmentStart = end;
          i = end;
          continue;
        }
        i += 1;
        continue;
      }
    }
  }

  // An unterminated comment/string runs to EOF — blank the trailing segment so its
  // contents never reach the scanner (a kept string is left intact).
  if (state.kind !== "code" && !(keepStrings && state.kind === "string")) {
    blank(source, out, segmentStart, n);
  }
  return out.join("");
}
