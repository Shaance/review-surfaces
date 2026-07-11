// Conservatively discard heredoc bodies before segmenting executed shell
// commands. A command mentioned only inside stdin must not become test evidence.
function stripHeredocBodies(command: string): string {
  return command.replace(
    /<<-?\s*(['"]?)([A-Za-z_]\w*)\1([^\n]*)(?:\r?\n[\s\S]*?\r?\n[ \t]*\2[ \t]*(?=\r?\n|$)|\r?\n[\s\S]*$)?/g,
    "<<$2$3"
  );
}

export function commandSegments(command: string): string[] {
  const source = stripHeredocBodies(command);
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? undefined : quote ?? character;
      continue;
    }
    if (quote) continue;

    const operatorLength = source.startsWith("&&", index) || source.startsWith("||", index) ? 2 :
      character === "|" || character === ";" || character === "\n" || character === "\r" ? 1 : 0;
    if (operatorLength === 0) continue;
    segments.push(source.slice(start, index).trim());
    index += operatorLength - 1;
    start = index + 1;
  }
  segments.push(source.slice(start).trim());
  return segments;
}
