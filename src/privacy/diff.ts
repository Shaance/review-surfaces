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

function appendIfAllowed(section: string[], isIgnored: (filePath: string) => boolean, output: string[]): void {
  const header = section[0] ?? "";
  const match = header.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!match || (!isIgnored(match[1]) && !isIgnored(match[2]))) {
    output.push(section.join("\n"));
  }
}
