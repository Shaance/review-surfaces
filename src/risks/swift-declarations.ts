// review-surfaces.SEMANTIC_DIFF.5 — a bounded Swift declaration scanner over the
// comment/string-cleaned source (see swift-lexer.ts). It extracts only SUPPORTED
// declaration heads at type/top level and never descends into a function /
// initializer / subscript / closure body, so local `let`/`var`/`case` statements
// can never be mistaken for declarations (goal contract D3). Unsupported or
// ambiguous syntax produces no declaration rather than a guess.

import { cleanSwiftSource } from "./swift-lexer";

export type SwiftDeclarationKind =
  | "class"
  | "struct"
  | "enum"
  | "protocol"
  | "actor"
  | "extension"
  | "typealias"
  | "function"
  | "initializer"
  | "subscript"
  | "property"
  | "case";

export type SwiftVisibility = "open" | "public" | "package" | "internal" | "private" | "fileprivate";

export interface SwiftDeclaration {
  name: string;
  kind: SwiftDeclarationKind;
  visibility: SwiftVisibility;
  container?: string;
  // Normalized declaration head text (keyword..body/EOL), whitespace-collapsed.
  signature: string;
  attributes: string[];
  conformances: string[];
  protocol_requirements?: string[];
  enum_cases?: string[];
  line: number;
}

const DECL_KEYWORDS = new Set([
  "class",
  "struct",
  "enum",
  "protocol",
  "actor",
  "extension",
  "typealias",
  "associatedtype",
  "func",
  "init",
  "subscript",
  "var",
  "let",
  "case"
]);

// Keywords that may precede a real declaration keyword as modifiers. `class` is
// dual-use (a `class` modifier on a member vs. a `class` type) — handled below.
const MODIFIERS = new Set([
  "public",
  "private",
  "fileprivate",
  "internal",
  "open",
  "package",
  "static",
  "final",
  "lazy",
  "weak",
  "unowned",
  "mutating",
  "nonmutating",
  "override",
  "required",
  "convenience",
  "dynamic",
  "optional",
  "indirect",
  "infix",
  "prefix",
  "postfix",
  "distributed",
  "isolated",
  "nonisolated",
  "async",
  "class" // a `class` modifier (e.g. `class func`) — disambiguated when reading the head
]);

const VISIBILITIES: Record<string, SwiftVisibility> = {
  open: "open",
  public: "public",
  package: "package",
  internal: "internal",
  private: "private",
  fileprivate: "fileprivate"
};

const TYPE_KINDS = new Set<SwiftDeclarationKind>(["class", "struct", "enum", "protocol", "actor", "extension"]);

interface Frame {
  // "type" — its body holds member declarations; "value" — its body is code we skip.
  kind: "type" | "value";
  decl?: SwiftDeclaration; // the type declaration this frame belongs to
  openDepth: number;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

export function extractSwiftDeclarations(source: string): SwiftDeclaration[] {
  const cleaned = cleanSwiftSource(source);
  const decls: SwiftDeclaration[] = [];
  const stack: Frame[] = [];
  let depth = 0;
  let i = 0;
  const n = cleaned.length;

  // Precompute line starts for line-number lookup.
  const lineAt = (offset: number): number => {
    let line = 1;
    for (let k = 0; k < offset && k < n; k += 1) {
      if (cleaned[k] === "\n") {
        line += 1;
      }
    }
    return line;
  };

  // Whether new declarations may be parsed at the current position: top level, or
  // directly inside a "type" frame. Inside a "value" frame we only track braces.
  const inDeclContext = (): boolean => stack.length === 0 || stack[stack.length - 1].kind === "type";

  while (i < n) {
    const ch = cleaned[i];
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      // Close frames opened at this depth.
      while (stack.length > 0 && stack[stack.length - 1].openDepth === depth) {
        stack.pop();
      }
      i += 1;
      continue;
    }
    if (/\s/.test(ch) || ch === ";") {
      i += 1;
      continue;
    }
    if (!inDeclContext()) {
      i += 1;
      continue;
    }
    // At a declaration context: try to read a (possibly modifier-prefixed) head.
    if (/[A-Za-z_@]/.test(ch)) {
      const head = readHead(cleaned, i);
      if (head) {
        const built = buildDeclaration(head, stack, lineAt(head.start));
        if (built) {
          attachToContainer(built.decl, stack);
          // Enum cases are recorded ONLY on their enum's enum_cases (above); they
          // are not emitted as standalone declarations, so a removed case is one
          // fact on the enum, not a duplicate per-case fact.
          if (built.decl.kind !== "case") {
            decls.push(built.decl);
          }
          if (built.opensBody) {
            // The next `{` belongs to this declaration's body.
            const bodyDepth = depth;
            // Skip to the `{` if the head was a type/value with a body; the brace
            // handler pushes the frame.
            stack.push({ kind: built.frameKind, decl: built.frameKind === "type" ? built.decl : undefined, openDepth: bodyDepth });
            // Mark the pending frame so the NEXT `{` at bodyDepth is its open. We
            // implement this by leaving the frame on the stack with openDepth =
            // bodyDepth; when `{` increments depth to bodyDepth+1 the frame is the
            // innermost, and its matching `}` (back to bodyDepth) pops it.
          }
        }
        i = head.end;
        continue;
      }
    }
    i += 1;
  }
  return decls;
}

interface ParsedHead {
  start: number;
  end: number;
  attributes: string[];
  modifiers: string[];
  keyword: string;
  // Text from the keyword to the head terminator (`{`, `\n`, or EOF), collapsed.
  body: string;
  // True when a `{` body follows on this head (type body or accessor/func body).
  hasBrace: boolean;
}

// Read attributes + modifiers + a declaration keyword + the head text up to the
// terminating `{`/newline. Returns undefined when the run is not a declaration.
function readHead(s: string, start: number): ParsedHead | undefined {
  let i = start;
  const n = s.length;
  const attributes: string[] = [];
  const modifiers: string[] = [];

  const skipSpacesNoNewline = (): void => {
    while (i < n && (s[i] === " " || s[i] === "\t")) {
      i += 1;
    }
  };
  const skipSpaces = (): void => {
    while (i < n && /\s/.test(s[i])) {
      i += 1;
    }
  };

  // Attributes: @Name optionally followed by (...) balanced.
  for (;;) {
    skipSpaces();
    if (s[i] === "@") {
      let j = i + 1;
      IDENT.lastIndex = j;
      const m = IDENT.exec(s);
      if (!m || m.index !== j) {
        return undefined;
      }
      j = IDENT.lastIndex;
      let attr = s.slice(i, j);
      // Balanced (...) argument list.
      let k = j;
      while (k < n && /\s/.test(s[k])) {
        k += 1;
      }
      if (s[k] === "(") {
        const close = matchParen(s, k);
        if (close < 0) {
          return undefined;
        }
        attr = s.slice(i, close + 1).replace(/\s+/g, " ");
        j = close + 1;
      }
      attributes.push(attr.trim());
      i = j;
      continue;
    }
    break;
  }

  // Modifiers (including `private(set)` form) then the declaration keyword.
  let keyword = "";
  for (;;) {
    skipSpaces();
    IDENT.lastIndex = i;
    const m = IDENT.exec(s);
    if (!m || m.index !== i) {
      return undefined;
    }
    const word = m[0];
    let wordEnd = IDENT.lastIndex;
    // `private(set)` / `public(set)` access modifier with a setter scope.
    if (VISIBILITIES[word]) {
      let k = wordEnd;
      while (k < n && /\s/.test(s[k])) {
        k += 1;
      }
      if (s[k] === "(") {
        const close = matchParen(s, k);
        if (close >= 0) {
          wordEnd = close + 1;
        }
      }
    }
    if (DECL_KEYWORDS.has(word) && !(word === "class" && isClassModifierContext(s, wordEnd))) {
      keyword = word;
      i = wordEnd;
      break;
    }
    if (MODIFIERS.has(word) || VISIBILITIES[word]) {
      modifiers.push(s.slice(m.index, wordEnd).replace(/\s+/g, " "));
      i = wordEnd;
      continue;
    }
    // Not an attribute/modifier/keyword run — not a declaration head.
    return undefined;
  }

  // associatedtype is parsed but not emitted as a supported kind below; still
  // consume its head so its name is not rescanned.
  // Read head text until the terminating `{` at this level or a newline.
  skipSpacesNoNewline();
  let depth = 0;
  let hasBrace = false;
  let j = i;
  for (; j < n; j += 1) {
    const c = s[j];
    if (c === "(" || c === "[" || c === "<") {
      depth += 1;
    } else if (c === ")" || c === "]" || c === ">") {
      if (depth > 0) {
        depth -= 1;
      }
    } else if (c === "{" && depth === 0) {
      hasBrace = true;
      break;
    } else if (c === "}" && depth === 0) {
      // A closing brace at depth 0 ends a one-line member (e.g. `enum E { case a }`)
      // WITHOUT being consumed, so the main scanner still sees it and pops the
      // enclosing frame. Not consuming it is what keeps the container stack honest.
      break;
    } else if (c === "\n" && depth === 0) {
      break;
    } else if (c === ";" && depth === 0) {
      break;
    }
  }
  const headText = `${keyword} ${s.slice(i, j)}`.replace(/\s+/g, " ").trim();
  return { start, end: j, attributes, modifiers, keyword, body: headText, hasBrace };
}

// `class` is a TYPE keyword unless it is immediately followed by another decl
// keyword (`class func`, `class var`) — then it is a modifier.
function isClassModifierContext(s: string, afterClass: number): boolean {
  let k = afterClass;
  while (k < s.length && /\s/.test(s[k])) {
    k += 1;
  }
  IDENT.lastIndex = k;
  const m = IDENT.exec(s);
  if (!m || m.index !== k) {
    return false;
  }
  return m[0] === "func" || m[0] === "var" || m[0] === "let" || m[0] === "subscript";
}

function matchParen(s: string, open: number): number {
  const openCh = s[open];
  const closeCh = openCh === "(" ? ")" : openCh === "[" ? "]" : openCh === "<" ? ">" : "";
  if (!closeCh) {
    return -1;
  }
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === openCh) {
      depth += 1;
    } else if (s[i] === closeCh) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

interface BuiltDeclaration {
  decl: SwiftDeclaration;
  opensBody: boolean;
  frameKind: "type" | "value";
}

function buildDeclaration(head: ParsedHead, stack: Frame[], line: number): BuiltDeclaration | undefined {
  const container = stack.length > 0 ? stack[stack.length - 1].decl?.name : undefined;
  const visibility = resolveVisibility(head.modifiers, stack);
  const body = head.body;

  switch (head.keyword) {
    case "class":
    case "struct":
    case "enum":
    case "protocol":
    case "actor":
    case "extension": {
      const name = typeName(body, head.keyword);
      if (!name) {
        return undefined;
      }
      const decl: SwiftDeclaration = {
        name,
        kind: head.keyword as SwiftDeclarationKind,
        visibility,
        ...(container ? { container } : {}),
        signature: body,
        attributes: head.attributes,
        conformances: conformancesFrom(body, name),
        ...(head.keyword === "protocol" ? { protocol_requirements: [] } : {}),
        ...(head.keyword === "enum" ? { enum_cases: [] } : {}),
        line
      };
      return { decl, opensBody: head.hasBrace, frameKind: "type" };
    }
    case "func":
    case "init":
    case "subscript": {
      const name = head.keyword === "func" ? memberName(body, "func") : head.keyword === "init" ? "init" : "subscript";
      if (!name) {
        return undefined;
      }
      const kind: SwiftDeclarationKind = head.keyword === "func" ? "function" : head.keyword === "init" ? "initializer" : "subscript";
      const decl: SwiftDeclaration = {
        name,
        kind,
        visibility,
        ...(container ? { container } : {}),
        signature: body,
        attributes: head.attributes,
        conformances: [],
        line
      };
      return { decl, opensBody: head.hasBrace, frameKind: "value" };
    }
    case "var":
    case "let": {
      const name = memberName(body, head.keyword);
      if (!name) {
        return undefined;
      }
      const decl: SwiftDeclaration = {
        name,
        kind: "property",
        visibility,
        ...(container ? { container } : {}),
        signature: body,
        attributes: head.attributes,
        conformances: [],
        line
      };
      // A `{ ... }` after a property is an accessor block (code) — skip its interior.
      return { decl, opensBody: head.hasBrace, frameKind: "value" };
    }
    case "typealias": {
      const name = memberName(body, "typealias");
      if (!name) {
        return undefined;
      }
      const decl: SwiftDeclaration = {
        name,
        kind: "typealias",
        visibility,
        ...(container ? { container } : {}),
        signature: body,
        attributes: head.attributes,
        conformances: [],
        line
      };
      return { decl, opensBody: false, frameKind: "value" };
    }
    case "case": {
      // Enum cases (only meaningful directly inside an enum). `case` elsewhere
      // (switch) never reaches here because switch bodies are inside func/value
      // frames which we skip.
      const top = stack[stack.length - 1];
      if (!top || top.decl?.kind !== "enum") {
        return undefined;
      }
      const names = enumCaseNames(body);
      if (names.length === 0) {
        return undefined;
      }
      // Represent the FIRST name as the declaration anchor; all names are attached
      // to the enum's enum_cases via attachToContainer.
      const decl: SwiftDeclaration = {
        name: names[0],
        kind: "case",
        visibility,
        ...(container ? { container } : {}),
        signature: body,
        attributes: head.attributes,
        conformances: [],
        enum_cases: names,
        line
      };
      return { decl, opensBody: false, frameKind: "value" };
    }
    default:
      return undefined; // associatedtype and anything else: consumed, not emitted
  }
}

// Members of a protocol/enum are recorded onto the container declaration so a
// protocol requirement removed or an enum case removed is a contract fact even
// without a separate per-member diff.
function attachToContainer(decl: SwiftDeclaration, stack: Frame[]): void {
  const top = stack[stack.length - 1];
  if (!top || !top.decl) {
    return;
  }
  if (top.decl.kind === "protocol" && top.decl.protocol_requirements && decl.kind !== "case") {
    top.decl.protocol_requirements.push(decl.name);
  }
  if (top.decl.kind === "enum" && top.decl.enum_cases && decl.kind === "case") {
    top.decl.enum_cases.push(...(decl.enum_cases ?? [decl.name]));
  }
}

function resolveVisibility(modifiers: string[], stack: Frame[]): SwiftVisibility {
  for (const modifier of modifiers) {
    const base = modifier.split("(")[0];
    if (VISIBILITIES[base]) {
      return VISIBILITIES[base];
    }
  }
  // A protocol's requirements inherit the protocol's visibility surface.
  const top = stack[stack.length - 1];
  if (top?.decl?.kind === "protocol") {
    return top.decl.visibility;
  }
  return "internal";
}

function typeName(body: string, keyword: string): string | undefined {
  const rest = body.slice(keyword.length).trim();
  const match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  return match?.[1];
}

function memberName(body: string, keyword: string): string | undefined {
  const rest = body.slice(keyword.length).trim();
  // func name, var name, typealias name, possibly with generics `<...>` after.
  const match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  if (match) {
    return match[1];
  }
  // Operator functions: `func == (...)` etc.
  const op = /^([^\sA-Za-z_({<][^\s({<]*)/.exec(rest);
  return op?.[1];
}

function enumCaseNames(body: string): string[] {
  const rest = body.replace(/^case\b/, "").trim();
  const names: string[] = [];
  // Split top-level commas; each item is `name` or `name(...)` or `name = value`.
  let depth = 0;
  let current = "";
  for (const ch of rest) {
    if (ch === "(" || ch === "[" || ch === "<") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === ">") {
      depth = Math.max(0, depth - 1);
    }
    if (ch === "," && depth === 0) {
      names.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  names.push(current);
  return names
    .map((item) => /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(item)?.[1])
    .filter((name): name is string => Boolean(name));
}

// `: A, B & C` conformance/inheritance clause after the type name (before any
// `where`). The first entry may be a superclass; we keep the raw list — the diff
// only cares about additions/removals.
function conformancesFrom(body: string, name: string): string[] {
  const afterName = body.slice(body.indexOf(name) + name.length);
  // Drop a generic parameter clause immediately after the name.
  let rest = afterName.replace(/^\s*<[^>]*>/, "");
  const colon = rest.indexOf(":");
  if (colon < 0) {
    return [];
  }
  rest = rest.slice(colon + 1);
  const whereIndex = rest.search(/\bwhere\b/);
  if (whereIndex >= 0) {
    rest = rest.slice(0, whereIndex);
  }
  return rest
    .split(/[,&]/)
    .map((entry) => entry.trim().replace(/<.*$/, "").trim())
    .filter((entry) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(entry));
}
