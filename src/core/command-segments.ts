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

interface CommandAnalysis extends CommandChain {
  outer_group_body?: string;
  outer_group_redirected?: boolean;
  has_redirection?: boolean;
}

interface SubstitutionFrame {
  close: ")" | "}" | "`";
  quote?: "'" | '"';
  escaped: boolean;
  comment: boolean;
}

const MAX_COMMAND_ANALYSIS_CHARS = 4_000;

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

function analyzeCommand(command: string): CommandAnalysis {
  if (command.length > MAX_COMMAND_ANALYSIS_CHARS) return { segments: [], operators: [] };
  const source = stripHeredocBodies(command);
  const segmentRanges: Array<[number, number]> = [];
  const commentRanges: Array<[number, number]> = [];
  const operators: CommandOperator[] = [];
  const substitutions: SubstitutionFrame[] = [];
  const groupingClosers: Array<{ close: ")" | "}"; grouping: boolean; open: number; kind: "(" | "{" }> = [];
  const groupPairs = new Map<number, { close: number; kind: "(" | "{" }>();
  const firstNonWhitespace = source.search(/\S/);
  let rootGroup: { open: number; close?: number; kind: "(" | "{" } | undefined;
  let groupingDepth = 0;
  let start = 0;
  let closedGroupingAt = -1;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let hasRedirection = false;

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
      groupingClosers.push({
        close: character === "(" ? ")" : "}",
        grouping,
        open: index,
        kind: character
      });
      if (grouping && groupingDepth === 0 && index === firstNonWhitespace) {
        rootGroup = { open: index, kind: character };
      }
      if (grouping) groupingDepth += 1;
    } else if (character === ")" || character === "}") {
      const opener = groupingClosers.pop();
      if (opener?.grouping) groupingDepth -= 1;
      if (opener?.close === character && opener.grouping) {
        groupPairs.set(opener.open, { close: index, kind: opener.kind });
        closedGroupingAt = index;
        if (groupingDepth === 0 && rootGroup && rootGroup.close === undefined) rootGroup.close = index;
      }
    }
    if (character === "#" && isCommentBoundary(source, index, closedGroupingAt)) {
      const commentStart = index;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      commentRanges.push([commentStart, index]);
      index -= 1;
      continue;
    }
    if (groupingDepth > 0) continue;
    if (character === "<" || character === ">") hasRedirection = true;

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
  const rootSuffix = rootGroup?.close === undefined
    ? undefined
    : visible.slice(rootGroup.close + 1).join("").trim();
  const neutralSuffix = rootSuffix !== undefined && isStatusNeutralGroupSuffix(rootSuffix);
  let outerGroupBody: string | undefined;
  let outerGroupRedirected = rootSuffix !== undefined && isRedirectionGroupSuffix(rootSuffix);
  if (rootGroup?.close !== undefined && neutralSuffix) {
    let bodyStart = rootGroup.open + 1;
    let bodyEnd = rootGroup.close;
    const trimBody = (): void => {
      while (bodyStart < bodyEnd && /\s/.test(source[bodyStart] ?? "")) bodyStart += 1;
      while (bodyEnd > bodyStart && /\s/.test(source[bodyEnd - 1] ?? "")) bodyEnd -= 1;
    };
    let kind = rootGroup.kind;
    while (true) {
      trimBody();
      if (kind === "{" && source[bodyEnd - 1] === ";") {
        bodyEnd -= 1;
        trimBody();
      }
      const nested = groupPairs.get(bodyStart);
      const nestedSuffix = nested && nested.close < bodyEnd
        ? visible.slice(nested.close + 1, bodyEnd).join("").trim()
        : undefined;
      if (!nested || nestedSuffix === undefined || !isStatusNeutralGroupSuffix(nestedSuffix)) break;
      outerGroupRedirected ||= isRedirectionGroupSuffix(nestedSuffix);
      bodyStart += 1;
      bodyEnd = nested.close;
      kind = nested.kind;
    }
    outerGroupBody = source.slice(bodyStart, bodyEnd);
  }
  return {
    segments,
    operators,
    outer_group_body: outerGroupBody,
    outer_group_redirected: outerGroupBody === undefined ? undefined : outerGroupRedirected,
    has_redirection: hasRedirection
  };
}

function isStatusNeutralGroupSuffix(suffix: string): boolean {
  return suffix === "" || suffix === ";" || isRedirectionGroupSuffix(suffix);
}

function isRedirectionGroupSuffix(suffix: string): boolean {
  return /^(?:(?:\d+|&)?(?:>>?|<<?|<>|>\||<&|>&)\s*(?:[^\s;|&<>'"\\]|\\.|'[^']*'|"(?:\\.|[^"])*")+\s*)+;?$/.test(suffix);
}

export function commandChain(command: string): CommandChain {
  const { segments, operators } = analyzeCommand(command);
  return { segments, operators };
}

export function commandSegments(command: string): string[] {
  const pending = [command];
  const result: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    const analysis = analyzeCommand(current);
    if (analysis.outer_group_body !== undefined) {
      pending.push(analysis.outer_group_body);
    } else if (analysis.segments.length > 1) {
      pending.push(...[...analysis.segments].reverse());
    } else {
      result.push(...analysis.segments);
    }
  }
  return result;
}

export function statusBearingCommandSegments(
  command: string,
  status: "passed" | "failed" | "unknown"
): string[] {
  if (status === "unknown") return commandSegments(command);
  const pending = [command];
  const result: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    const analysis = analyzeCommand(current);
    if (analysis.outer_group_body !== undefined) {
      if (status === "failed" && analysis.outer_group_redirected) continue;
      pending.push(analysis.outer_group_body);
      continue;
    }
    if (analysis.segments.length <= 1) {
      if (status === "failed" && analysis.has_redirection) continue;
      result.push(...analysis.segments);
      continue;
    }
    if (analysis.operators.includes("&")) continue;
    let supported: string[];
    if (analysis.operators.every((operator) => operator === "&&")) {
      supported = status === "passed" ? analysis.segments : [];
    } else if (analysis.operators.every((operator) => operator === "||")) {
      supported = status === "failed" ? analysis.segments : [];
    } else if (analysis.operators.every((operator) => operator === "|")) {
      supported = status === "passed" ? [analysis.segments.at(-1) ?? ""] : [];
    } else if (analysis.operators.every((operator) => operator === ";" || operator === "newline")) {
      supported = [analysis.segments.at(-1) ?? ""];
    } else {
      supported = [];
    }
    pending.push(...[...supported].reverse());
  }
  return result;
}
