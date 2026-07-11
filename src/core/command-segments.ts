// Conservatively discard heredoc bodies before segmenting executed shell
// commands. A command mentioned only inside stdin must not become test evidence.
function stripHeredocBodies(command: string): string {
  return command.replace(
    /<<-?\s*(['"]?)([A-Za-z_]\w*)\1([^\n]*)(?:\r?\n[\s\S]*?\r?\n[ \t]*\2[ \t]*(?=\r?\n|$)|\r?\n[\s\S]*$)?/g,
    "<<$2$3"
  );
}

export type CommandOperator = "&&" | "||" | "&" | "|" | ";" | "newline";

export interface CommandChain {
  segments: string[];
  operators: CommandOperator[];
}

interface SubstitutionFrame {
  close: ")" | "}" | "`";
  quote?: "'" | '"';
  escaped: boolean;
  comment: boolean;
}

function startsSubstitution(source: string, index: number): ")" | "}" | undefined {
  const character = source[index];
  const next = source[index + 1];
  if ((character === "$" || character === "<" || character === ">" || character === "=") && next === "(") return ")";
  if (character === "$" && next === "{") return "}";
  return undefined;
}

function isCommentBoundary(source: string, index: number, closedGroupingAt: number): boolean {
  const previous = source[index - 1];
  return previous === undefined || /\s/.test(previous) || previous === ";" || previous === "|" ||
    previous === "&" || previous === "(" || closedGroupingAt === index - 1;
}

export function commandChain(command: string): CommandChain {
  const source = stripHeredocBodies(command);
  const segmentRanges: Array<[number, number]> = [];
  const commentRanges: Array<[number, number]> = [];
  const operators: CommandOperator[] = [];
  const substitutions: SubstitutionFrame[] = [];
  const groupingClosers: Array<{ close: ")" | "}"; grouping: boolean }> = [];
  let start = 0;
  let closedGroupingAt = -1;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const substitution = substitutions.at(-1);
    if (substitution) {
      if (substitution.comment) {
        if (character === "\n" || character === "\r") substitution.comment = false;
        continue;
      }
      if (substitution.escaped) {
        substitution.escaped = false;
        continue;
      }
      if (character === "\\" && substitution.quote !== "'") {
        substitution.escaped = true;
        continue;
      }
      if (character === "'" || character === '"') {
        substitution.quote = substitution.quote === character ? undefined : substitution.quote ?? character;
        continue;
      }
      if (substitution.quote) continue;
      if (substitution.close !== "}" && character === "#" && isCommentBoundary(source, index, -1)) {
        substitution.comment = true;
        continue;
      }
      if (character === substitution.close) {
        substitutions.pop();
        continue;
      }
      if (character === "`" && substitution.close !== "`") {
        substitutions.push({ close: "`", escaped: false, comment: false });
        continue;
      }
      const nestedClose = startsSubstitution(source, index);
      if (nestedClose) {
        substitutions.push({ close: nestedClose, escaped: false, comment: false });
        index += 1;
        continue;
      }
      if (character === "(" && substitution.close === ")") {
        substitutions.push({ close: ")", escaped: false, comment: false });
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'") {
      quote = quote === "'" ? undefined : quote ?? "'";
      continue;
    }
    if (quote === "'") continue;
    if (character === "`") {
      substitutions.push({ close: "`", escaped: false, comment: false });
      continue;
    }
    const substitutionClose = startsSubstitution(source, index);
    if (substitutionClose) {
      substitutions.push({ close: substitutionClose, escaped: false, comment: false });
      index += 1;
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? undefined : quote ?? '"';
      continue;
    }
    if (quote) continue;
    if (character === "(" || character === "{") {
      const previous = source[index - 1];
      const next = source[index + 1];
      const grouping = (character === "(" || next === undefined || /\s/.test(next)) &&
        (previous === undefined || /\s/.test(previous) || previous === ";" || previous === "|" ||
          previous === "&" || previous === "(" || previous === "{");
      groupingClosers.push({ close: character === "(" ? ")" : "}", grouping });
    } else if (character === ")" || character === "}") {
      const opener = groupingClosers.pop();
      if (opener?.close === character && opener.grouping) closedGroupingAt = index;
    }
    if (character === "#" && isCommentBoundary(source, index, closedGroupingAt)) {
      const commentStart = index;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      commentRanges.push([commentStart, index]);
      index -= 1;
      continue;
    }

    const pipeBoth = source.startsWith("|&", index);
    const background = character === "&" && source[index - 1] !== ">" && source[index - 1] !== "<" &&
      source[index + 1] !== ">";
    const operator: CommandOperator | undefined = source.startsWith("&&", index) ? "&&" :
      source.startsWith("||", index) ? "||" : pipeBoth || character === "|" ? "|" :
        background ? "&" : character === ";" ? ";" :
          character === "\n" || character === "\r" ? "newline" : undefined;
    if (!operator) continue;
    const operatorLength = operator === "&&" || operator === "||" || pipeBoth ||
      character === "\r" && source[index + 1] === "\n" ? 2 : 1;
    segmentRanges.push([start, index]);
    operators.push(operator);
    index += operatorLength - 1;
    start = index + 1;
  }
  segmentRanges.push([start, source.length]);
  const visible = source.split("");
  for (const [commentStart, commentEnd] of commentRanges) {
    visible.fill(" ", commentStart, commentEnd);
  }
  const segments = segmentRanges.map(([segmentStart, segmentEnd]) =>
    visible.slice(segmentStart, segmentEnd).join("").trim()
  );

  while (segments.length > 1 && segments.at(-1) === "" &&
    (operators.at(-1) === ";" || operators.at(-1) === "newline")) {
    segments.pop();
    operators.pop();
  }
  let leadingSeparators = 0;
  while (leadingSeparators < segments.length - 1 && segments[leadingSeparators] === "" &&
    (operators[leadingSeparators] === ";" || operators[leadingSeparators] === "newline")) {
    leadingSeparators += 1;
  }
  if (leadingSeparators > 0) {
    segments.splice(0, leadingSeparators);
    operators.splice(0, leadingSeparators);
  }
  return { segments, operators };
}

export function commandSegments(command: string): string[] {
  return commandChain(command).segments;
}

export function statusBearingCommandSegments(
  command: string,
  status: "passed" | "failed" | "unknown"
): string[] {
  const chain = commandChain(command);
  if (chain.segments.length <= 1 || status === "unknown") return chain.segments;
  if (chain.operators.includes("&")) return [];
  if (chain.operators.every((operator) => operator === "&&")) {
    return status === "passed" ? chain.segments : [];
  }
  if (chain.operators.every((operator) => operator === "||")) {
    return status === "failed" ? chain.segments : [];
  }
  if (chain.operators.every((operator) => operator === "|")) {
    return status === "passed" ? [chain.segments.at(-1) ?? ""] : [];
  }
  if (chain.operators.every((operator) => operator === ";" || operator === "newline")) {
    return [chain.segments.at(-1) ?? ""];
  }
  return [];
}
