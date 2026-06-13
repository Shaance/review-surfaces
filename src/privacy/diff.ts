import { parseDiffGitHeader } from "../collector/diff-hunks";

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
// `diff --git` header is ambiguous and nothing disambiguates it.
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
  // True when the `diff --git` header alone is ambiguous (an unquoted path can
  // itself contain " b/") AND no unambiguous body path line disambiguates it.
  ambiguous: boolean;
}

// Collect candidate file paths for a diff section from the most reliable sources:
//   1. The quote-aware `diff --git` header parser (handles quoted non-ASCII paths).
//   2. The `--- a/`, `+++ b/`, and rename/copy body lines — UNAMBIGUOUS, because
//      everything after the a/ or b/ prefix is the full path, so a path that
//      itself contains " b/" (which makes the header ambiguous) is recovered
//      correctly here.
function candidatePaths(section: string[]): SectionPaths {
  const paths: string[] = [];
  const header = section[0] ?? "";

  const parsed = parseDiffGitHeader(header);
  if (parsed?.oldPath) paths.push(parsed.oldPath);
  if (parsed?.newPath) paths.push(parsed.newPath);

  let sawBodyPath = false;
  for (const line of section) {
    const bodyPath = bodyPathFromLine(line);
    if (bodyPath !== undefined) {
      paths.push(bodyPath);
      sawBodyPath = true;
    }
  }

  // An unquoted header with more than one " b/" is ambiguous (the path may
  // contain " b/"); only the body path lines can resolve it. If none exist, we
  // cannot trust the header split, so treat the section as un-readable -> drop.
  const unquotedRest = header.startsWith("diff --git ") && !header.includes('"')
    ? header.slice("diff --git ".length)
    : "";
  const ambiguousHeader = occurrences(unquotedRest, " b/") > 1;

  return { paths, ambiguous: ambiguousHeader && !sawBodyPath };
}

// Recover the full path from an unambiguous body line. `--- a/<path>` /
// `+++ b/<path>` and `rename|copy from|to <path>` carry exactly one path with no
// second operand to split on, so a path containing " b/" is returned intact.
// /dev/null and quoted forms (handled by the header parser) are skipped here.
function bodyPathFromLine(line: string): string | undefined {
  for (const prefix of ["--- a/", "+++ b/"]) {
    if (line.startsWith(prefix)) {
      return stripTrailingTab(line.slice(prefix.length));
    }
  }
  for (const prefix of ["rename from ", "rename to ", "copy from ", "copy to "]) {
    if (line.startsWith(prefix)) {
      const value = line.slice(prefix.length).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
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
