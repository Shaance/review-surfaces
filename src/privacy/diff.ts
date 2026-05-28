export function filterIgnoredDiff(diff: string, isIgnored: (filePath: string) => boolean): string {
  const lines = diff.split(/\r?\n/);
  const sections: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current.length > 0) {
        sections.push(current);
      }
      current = [line];
      continue;
    }
    current.push(line);
  }

  if (current.length > 0) {
    sections.push(current);
  }

  return sections
    .filter((section) => {
      const header = section[0] ?? "";
      const match = header.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!match) {
        return true;
      }
      return !isIgnored(match[1]) && !isIgnored(match[2]);
    })
    .map((section) => section.join("\n"))
    .join("\n")
    .trimEnd();
}
