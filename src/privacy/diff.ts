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
// (/^diff --git a\/(.+) b\/(.+)$/) silently FAILED to match a git-quoted header
// (`diff --git "a/secret café.env" "b/..."`) or a space-containing path, and a
// failed match KEPT the section — leaking an ignored file's contents into
// diff.patch. We now reuse the quote-aware parseDiffGitHeader (the same parser
// the structured-diff path uses, so they cannot drift) and drop the section
// whenever it cannot be parsed into BOTH paths or either path is ignored.
function appendIfAllowed(section: string[], isIgnored: (filePath: string) => boolean, output: string[]): void {
  const header = section[0] ?? "";
  const parsed = parseDiffGitHeader(header);
  const oldPath = parsed?.oldPath;
  const newPath = parsed?.newPath;
  // A header we cannot resolve into both a/ and b/ paths is treated as ignored:
  // for a privacy filter, dropping an unparseable section is the safe default.
  if (oldPath === undefined || newPath === undefined) {
    return;
  }
  if (!isIgnored(oldPath) && !isIgnored(newPath)) {
    output.push(section.join("\n"));
  }
}
