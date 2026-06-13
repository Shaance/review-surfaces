import { parseDiffGitHeader, decodeGitQuotedPath } from "../collector/diff-hunks";

export function filterIgnoredDiff(diff: string, isIgnored: (filePath: string) => boolean): string {
  const lines = diff.split(/\r?\n/);
  const keptSections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current.length > 0) {
        appendIfAllowed(current, isIgnored, keptSections);
      }
      current = [line];
      continue;
    }
    current.push(line);
  }

  if (current.length > 0) {
    appendIfAllowed(current, isIgnored, keptSections);
  }

  return keptSections.join("\n").trimEnd();
}

// review-surfaces.PRIVACY.6: fail CLOSED. The previous greedy regex
// (/^diff --git a\/(.+) b\/(.+)$/) silently FAILED to match git's quoted/space
// header forms, and a non-match KEPT the section — leaking an ignored file's
// contents into diff.patch. We now gather EVERY path the section can reveal and
// drop the section if any is ignored, if no path can be recovered, or if the
// `diff --git` header is ambiguous/quoted and no unambiguous body path
// disambiguates it.
function appendIfAllowed(section: string[], isIgnored: (filePath: string) => boolean, output: string[]): void {
  const candidates = candidatePaths(section);
  // Drop when we cannot positively read a path (fail closed) or any candidate is ignored.
  if (candidates.paths.length === 0 || candidates.ambiguous) {
    return;
  }
  if (candidates.paths.some(isIgnored)) {
    return;
  }
  output.push(section.join("\n"));
}

interface SectionPaths {
  paths: string[];
  // True when the `diff --git` header cannot be trusted on its own (an unquoted
  // path can contain " b/"; a quoted header's escapes can defeat the parser) AND
  // no unambiguous body path line disambiguates it.
  ambiguous: boolean;
}

// Collect candidate file paths for a diff section from the most reliable sources:
//   1. The quote-aware `diff --git` header parser (handles quoted non-ASCII paths).
//   2. The `--- a/`, `+++ b/` (quoted or unquoted), and rename/copy body lines —
//      UNAMBIGUOUS, because each carries exactly one path with no second operand
//      to split on, so a path containing " b/" or a quoted/escaped path is
//      recovered correctly here.
function candidatePaths(section: string[]): SectionPaths {
  const paths: string[] = [];
  const header = section[0] ?? "";

  const parsed = parseDiffGitHeader(header);
  if (parsed?.oldPath) paths.push(parsed.oldPath);
  if (parsed?.newPath) paths.push(parsed.newPath);

  let sawBodyPath = false;
  for (const line of section) {
    // Path metadata (---/+++, rename/copy) only appears in the section HEADER,
    // before the first @@ hunk. Stop there so hunk CONTENT — an added line whose
    // text begins with "++ b/…" renders in the unified diff as "+++ b/…", and a
    // removed "-- a/…" as "--- a/…" — is never mis-read as a path and made to
    // drop a real, non-ignored file.
    if (line.startsWith("@@")) break;
    const bodyPath = bodyPathFromLine(line);
    if (bodyPath !== undefined) {
      paths.push(bodyPath);
      sawBodyPath = true;
    }
  }

  // The header alone cannot be trusted when it is unquoted with more than one
  // " b/" (the path may contain " b/") OR quoted (escaped quotes can make the
  // parser stop early). Only the body path lines resolve those; if none exist,
  // treat the section as un-readable -> drop (fail closed).
  const isGitHeader = header.startsWith("diff --git ");
  const unquotedRest = isGitHeader && !header.includes('"') ? header.slice("diff --git ".length) : "";
  const ambiguousHeader = occurrences(unquotedRest, " b/") > 1;
  const quotedHeader = isGitHeader && header.includes('"');

  return { paths, ambiguous: (ambiguousHeader || quotedHeader) && !sawBodyPath };
}

// Recover the full path from an unambiguous body line. `--- a/<path>` /
// `+++ b/<path>` (or their quoted `--- "a/<path>"` forms) and `rename|copy
// from|to <path>` carry exactly one path, so a path containing " b/", a quote,
// or non-ASCII bytes is returned intact. /dev/null is skipped.
function bodyPathFromLine(line: string): string | undefined {
  for (const marker of ["--- ", "+++ "]) {
    if (!line.startsWith(marker)) continue;
    const operand = stripTrailingTab(line.slice(marker.length));
    if (operand === "/dev/null") return undefined;
    // Quoted: `"a/<escaped>"` — git quotes the whole a//b/ path when it has
    // special chars; decode the escapes then strip the a//b/ prefix.
    if (operand.startsWith('"') && operand.endsWith('"') && operand.length >= 2) {
      return stripAbPrefix(decodeGitQuotedPath(operand.slice(1, -1)));
    }
    if (operand.startsWith("a/") || operand.startsWith("b/")) {
      return operand.slice(2);
    }
    return undefined;
  }
  for (const prefix of ["rename from ", "rename to ", "copy from ", "copy to "]) {
    if (line.startsWith(prefix)) {
      const value = stripTrailingTab(line.slice(prefix.length)).trim();
      if (value.length === 0) return undefined;
      // Rename/copy operands are bare paths (no a//b/ prefix) but ARE quoted when
      // the name has special chars; decode so an ignored quoted-name rename
      // (which has no ---/+++ lines) is still recognized and dropped.
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        return decodeGitQuotedPath(value.slice(1, -1));
      }
      return value;
    }
  }
  return undefined;
}

function stripAbPrefix(value: string): string {
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

// Some diff tools append a tab + timestamp to a `---`/`+++` operand.
function stripTrailingTab(value: string): string {
  const tab = value.indexOf("\t");
  return tab >= 0 ? value.slice(0, tab) : value;
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    count += 1;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return count;
}
