// review-surfaces.SEMANTIC_DIFF.1-4: deterministic facts computed from the
// MEANING of the diff rather than from path/filename matching.
//
//   .1 semantic JSON-schema diff (properties/required/type/enum changes)
//   .2 exported TypeScript API-surface diff (symbols added/removed/changed)
//   .3 test-weakening signals (deleted test files, newly skipped tests, removed
//      assertions, regenerated snapshots)
//   .4 the facts carry concrete language for the queue / lenses / comments.
//
// The base/head file readers are injected so the analysis is a pure function of
// (diff, file contents) — the CLI provides git-backed (base) and working-tree
// (head) readers; tests provide fakes. Schema/API diffs need both file versions;
// test-weakening is computed from the diff hunks alone.

import * as ts from "typescript";
import { StructuredDiff, StructuredDiffFile } from "../pr/contract";
import { isTestPath } from "../scope/pr-scope";

export interface SchemaContractChange {
  path: string;
  properties_added: string[];
  properties_removed: string[];
  /** Fields that BECAME required — the common backward-incompatible change. */
  required_added: string[];
  required_removed: string[];
  type_changes: Array<{ field: string; from: string; to: string }>;
  enum_changes: Array<{ field: string; added: string[]; removed: string[] }>;
}

export interface ApiSurfaceChange {
  path: string;
  exports_added: string[];
  exports_removed: string[];
  signatures_changed: Array<{ name: string; from: string; to: string }>;
  // review-surfaces.BLAST_RADIUS.2: in-repo reference resolution for the changed
  // or removed exports — how many files import this module and reference the
  // symbols, with the top paths (alphabetical, bounded). Absent when the import
  // graph was not computed; truncated graphs carry the note instead of "0".
  used_by?: { count: number; top: string[]; truncated?: boolean };
}

export type TestWeakeningKind = "deleted_test_file" | "skipped_test" | "removed_assertion" | "regenerated_snapshot";

export interface TestWeakeningSignal {
  kind: TestWeakeningKind;
  path: string;
  detail: string;
}

export interface SemanticChangeFacts {
  schema_changes: SchemaContractChange[];
  api_changes: ApiSurfaceChange[];
  test_weakening: TestWeakeningSignal[];
}

export interface SemanticDiffSources {
  diff: StructuredDiff;
  /** Read the OLD (base) content of a path, or undefined when it did not exist. */
  readBase: (path: string) => string | undefined;
  /** Read the NEW (head) content of a path, or undefined when deleted. */
  readHead: (path: string) => string | undefined;
}

export function emptySemanticChangeFacts(): SemanticChangeFacts {
  return { schema_changes: [], api_changes: [], test_weakening: [] };
}

export function isBreakingSchemaChange(change: SchemaContractChange): boolean {
  return change.properties_removed.length > 0 ||
    change.required_added.length > 0 ||
    change.type_changes.length > 0 ||
    change.enum_changes.some((entry) => entry.removed.length > 0);
}

export function isBreakingApiChange(change: ApiSurfaceChange): boolean {
  return change.exports_removed.length > 0 || change.signatures_changed.some(signatureChangeIsBreaking);
}

function signatureChangeIsBreaking(change: ApiSurfaceChange["signatures_changed"][number]): boolean {
  const before = interfaceShape(change.from, change.name);
  const after = interfaceShape(change.to, change.name);
  if (!before || !after) {
    return true;
  }
  if (before.header !== after.header) return true;
  const remaining = new Map<string, { count: number; optional: boolean }>();
  for (const member of after.members) {
    const entry = remaining.get(member.text);
    remaining.set(member.text, { count: (entry?.count ?? 0) + 1, optional: member.optional });
  }
  for (const oldMember of before.members) {
    const entry = remaining.get(oldMember.text);
    if (!entry) return true;
    if (entry.count === 1) remaining.delete(oldMember.text);
    else entry.count -= 1;
  }
  return [...remaining.values()].some((member) => !member.optional);
}

// Interface signatures are emitted as valid TypeScript by the semantic
// extractor. Adding optional members is backward-compatible for both callers
// and implementers, so it remains a supporting fact instead of review work.
// Any removed/changed member or newly required member stays conservative.
function interfaceShape(signature: string, expectedName: string): {
  header: string;
  members: Array<{ text: string; optional: boolean }>;
} | undefined {
  const source = ts.createSourceFile("contract.ts", signature, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const localName = expectedName.split(".").at(-1) ?? expectedName;
  const declaration = source.statements.find((statement): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === localName
  );
  if (!declaration) return undefined;
  const header = [
    declaration.typeParameters?.map((parameter) => parameter.getText(source).replace(/\s+/gu, " ").trim()).join(",") ?? "",
    declaration.heritageClauses?.map((clause) => clause.getText(source).replace(/\s+/gu, " ").trim()).join(" ") ?? ""
  ].join("|");
  const members: Array<{ text: string; optional: boolean }> = [];
  for (const member of declaration.members) {
    const optional = Boolean(member.questionToken);
    const normalized = member.getText(source).replace(/\s+/gu, " ").trim();
    if (!normalized) return undefined;
    members.push({ text: normalized, optional });
  }
  return { header, members };
}

// Shared, surface-agnostic renderings of the two compound schema-change fields,
// so the queue/comment prose (human-review.ts) and the rendered facts section
// (render.ts) cannot drift on the same data shape.
export function formatTypeChanges(changes: SchemaContractChange["type_changes"]): string {
  return changes.map((t) => `${t.field} ${t.from}→${t.to}`).join(", ");
}

export function formatEnumChanges(changes: SchemaContractChange["enum_changes"]): string {
  return changes
    .map((e) => `${e.field}${e.added.length ? ` +[${e.added.join(", ")}]` : ""}${e.removed.length ? ` -[${e.removed.join(", ")}]` : ""}`)
    .join(", ");
}

export function computeSemanticChangeFacts(sources: SemanticDiffSources): SemanticChangeFacts {
  const schema_changes: SchemaContractChange[] = [];
  const api_changes: ApiSurfaceChange[] = [];
  for (const file of sources.diff.files) {
    if (isJsonSchemaPath(file.path)) {
      const change = diffSchemaFile(file, sources);
      if (change) {
        schema_changes.push(change);
      }
    } else if (isTypeScriptSourcePath(file.path)) {
      const change = diffApiSurfaceFile(file, sources);
      if (change) {
        api_changes.push(change);
      }
    }
  }
  return {
    schema_changes,
    api_changes,
    test_weakening: detectTestWeakening(sources.diff)
  };
}

// --- .1 semantic JSON-schema diff ------------------------------------------

function isJsonSchemaPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".json") && (lower.includes("schema") || lower.includes("/schemas/"));
}

// For a renamed file the previous content lives at old_path; everything else is
// read at its own path.
function baseReadPath(file: StructuredDiffFile): string {
  return file.old_path && file.old_path !== file.path ? file.old_path : file.path;
}

function diffSchemaFile(file: StructuredDiffFile, sources: SemanticDiffSources): SchemaContractChange | undefined {
  const path = file.path;
  const oldSchema = parseJson(sources.readBase(baseReadPath(file)));
  const newSchema = parseJson(sources.readHead(path));
  // A pure add or delete is not a CONTRACT change to diff (the path-touched risk
  // already covers it); only a modified schema with both versions is diffed.
  if (oldSchema === undefined || newSchema === undefined) {
    return undefined;
  }
  const change: SchemaContractChange = {
    path,
    properties_added: [],
    properties_removed: [],
    required_added: [],
    required_removed: [],
    type_changes: [],
    enum_changes: []
  };
  diffSchemaNode(oldSchema, newSchema, "", change);
  return isEmptySchemaChange(change) ? undefined : change;
}

// Recursively compare two schema nodes, recording property/required/type/enum
// changes keyed by a readable field path (e.g. "properties.foo" or
// "$defs.bar.baz"). Bounded by the schema's own nesting.
function diffSchemaNode(oldNode: unknown, newNode: unknown, pointer: string, change: SchemaContractChange): void {
  if (!isRecord(oldNode) || !isRecord(newNode)) {
    return;
  }

  // required arrays at this node.
  const oldRequired = stringArray(oldNode.required);
  const newRequired = stringArray(newNode.required);
  for (const field of newRequired) {
    if (!oldRequired.includes(field)) {
      change.required_added.push(fieldPath(pointer, field));
    }
  }
  for (const field of oldRequired) {
    if (!newRequired.includes(field)) {
      change.required_removed.push(fieldPath(pointer, field));
    }
  }

  // type change at this node.
  const oldType = typeLabel(oldNode.type);
  const newType = typeLabel(newNode.type);
  if (oldType !== undefined && newType !== undefined && oldType !== newType) {
    change.type_changes.push({ field: pointer || "(root)", from: oldType, to: newType });
  }

  // enum change at this node. Enum members may be strings, numbers, booleans, or
  // null — compare them as JSON values (so `[1, 2]` → `[1, 3]` is detected) and
  // stringify only for the recorded/displayed value.
  const oldEnum = enumValues(oldNode.enum);
  const newEnum = enumValues(newNode.enum);
  if (oldEnum.length > 0 || newEnum.length > 0) {
    const oldKeys = new Set(oldEnum.map(enumKey));
    const newKeys = new Set(newEnum.map(enumKey));
    const added = newEnum.filter((value) => !oldKeys.has(enumKey(value))).map(enumDisplay);
    const removed = oldEnum.filter((value) => !newKeys.has(enumKey(value))).map(enumDisplay);
    if (added.length > 0 || removed.length > 0) {
      change.enum_changes.push({ field: pointer || "(root)", added, removed });
    }
  }

  // properties / $defs children.
  for (const container of ["properties", "$defs", "definitions"]) {
    const oldChildren = isRecord(oldNode[container]) ? (oldNode[container] as Record<string, unknown>) : {};
    const newChildren = isRecord(newNode[container]) ? (newNode[container] as Record<string, unknown>) : {};
    for (const key of Object.keys(newChildren)) {
      if (!(key in oldChildren)) {
        if (container === "properties") {
          change.properties_added.push(fieldPath(pointer, key));
        }
      } else {
        diffSchemaNode(oldChildren[key], newChildren[key], childPointer(pointer, container, key), change);
      }
    }
    for (const key of Object.keys(oldChildren)) {
      if (!(key in newChildren) && container === "properties") {
        change.properties_removed.push(fieldPath(pointer, key));
      }
    }
  }

  // Subschema keywords whose value is itself a schema (or, for `items`, possibly a
  // tuple array of schemas). Recurse so a contract change inside an array element
  // (e.g. `properties.tags.items.type` string→number) is not invisible.
  for (const keyword of ["items", "additionalItems", "contains", "additionalProperties", "propertyNames", "not"]) {
    const oldChild = oldNode[keyword];
    const newChild = newNode[keyword];
    if (Array.isArray(oldChild) && Array.isArray(newChild)) {
      const count = Math.min(oldChild.length, newChild.length);
      for (let index = 0; index < count; index += 1) {
        diffSchemaNode(oldChild[index], newChild[index], `${pointer ? `${pointer}.` : ""}${keyword}[${index}]`, change);
      }
    } else {
      diffSchemaNode(oldChild, newChild, fieldPath(pointer, keyword), change);
    }
  }

  // Schema composition keywords (arrays of subschemas): recurse positionally, and
  // diff added/removed branches against an empty schema so a NEW `allOf` branch
  // that introduces required fields or properties (or a removed branch that
  // relaxes them) still feeds the contract facts rather than being invisible
  // whenever the composition array grows or shrinks.
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const oldBranch = Array.isArray(oldNode[keyword]) ? (oldNode[keyword] as unknown[]) : [];
    const newBranch = Array.isArray(newNode[keyword]) ? (newNode[keyword] as unknown[]) : [];
    const branchCount = Math.max(oldBranch.length, newBranch.length);
    for (let index = 0; index < branchCount; index += 1) {
      diffSchemaNode(oldBranch[index] ?? {}, newBranch[index] ?? {}, `${pointer ? `${pointer}.` : ""}${keyword}[${index}]`, change);
    }
  }
}

function isEmptySchemaChange(change: SchemaContractChange): boolean {
  return (
    change.properties_added.length === 0 &&
    change.properties_removed.length === 0 &&
    change.required_added.length === 0 &&
    change.required_removed.length === 0 &&
    change.type_changes.length === 0 &&
    change.enum_changes.length === 0
  );
}

// --- .3 test-weakening signals (from the diff alone) -----------------------

// A test declaration that is skipped, anchored at the start of the (trimmed)
// line so a `.skip(` inside a STRING literal (e.g. a test fixture describing a
// skipped test) does not count as a real skip.
const SKIP_PATTERN = /^\s*(?:(?:describe|it|test|context)\.skip|x(?:it|describe|test|context))\s*\(/;
const ASSERTION_PATTERN = /\b(?:expect|assert)\s*\(|\bassert\.[a-zA-Z]|\.(?:toBe|toEqual|toMatch|toThrow|toContain|deepEqual|strictEqual|ok|equal)\s*\(/;

function detectTestWeakening(diff: StructuredDiff): TestWeakeningSignal[] {
  const signals: TestWeakeningSignal[] = [];
  for (const file of diff.files) {
    if (isSnapshotPath(file.path)) {
      // A regeneration that could mask a regression requires a prior baseline:
      // fire for a MODIFIED snapshot, and for a RENAMED one that was also edited
      // (status "R" with hunks). A newly-added snapshot (status "A") is a new
      // test's first snapshot — no prior baseline — so it is not weakening.
      const editedRename = file.status === "R" && file.hunks.length > 0;
      if (file.status === "modified" || editedRename) {
        signals.push({ kind: "regenerated_snapshot", path: file.path, detail: "Snapshot file changed; confirm it was regenerated for an intended behavior change, not to mask a regression." });
      }
      continue;
    }
    if (!isTestPath(file.path)) {
      continue;
    }
    if (file.status === "D") {
      signals.push({ kind: "deleted_test_file", path: file.path, detail: "Test file deleted; confirm its coverage moved elsewhere and was not silently dropped." });
      continue;
    }
    // Skip/assertion weakening needs a prior version to weaken. A brand-new test
    // file (status "A") has none — treating its added lines as "newly skipped" /
    // "removed assertions" would be noise (and its `.skip(` fixture strings would
    // false-fire). A modified OR renamed file does carry prior coverage, so a
    // rename that also disables a test or drops assertions is still inspected.
    if (file.status === "A") {
      continue;
    }
    const added = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "add").map((line) => line.text));
    const removed = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "delete").map((line) => line.text));

    // A newly-skipped test: a skip marker added that was not merely moved.
    const addedSkips = added.filter((text) => SKIP_PATTERN.test(text)).length;
    const removedSkips = removed.filter((text) => SKIP_PATTERN.test(text)).length;
    if (addedSkips > removedSkips) {
      signals.push({ kind: "skipped_test", path: file.path, detail: `${addedSkips - removedSkips} test(s) newly skipped; confirm the disabled coverage is intentional.` });
    }

    // Removed assertions: more assertion lines deleted than added. A pure edit
    // (assertion modified, or unrelated change) nets to zero and does NOT fire.
    const addedAsserts = added.filter((text) => ASSERTION_PATTERN.test(text)).length;
    const removedAsserts = removed.filter((text) => ASSERTION_PATTERN.test(text)).length;
    if (removedAsserts > addedAsserts) {
      signals.push({ kind: "removed_assertion", path: file.path, detail: `${removedAsserts - addedAsserts} assertion(s) removed; confirm the checks were not weakened to pass.` });
    }
  }
  return signals;
}

function isSnapshotPath(path: string): boolean {
  return path.endsWith(".snap") || path.endsWith(".snapshot");
}

// --- .2 exported TypeScript API-surface diff -------------------------------

// `.ts`/`.tsx` and `.d.ts` declaration files (often the published API contract),
// excluding tests. `.d.ts` content is parsed the same way; its `export declare`
// forms are ordinary exported declarations to the TS parser.
function isTypeScriptSourcePath(path: string): boolean {
  return /\.tsx?$/.test(path) && !isTestPath(path);
}

function diffApiSurfaceFile(file: StructuredDiffFile, sources: SemanticDiffSources): ApiSurfaceChange | undefined {
  const path = file.path;
  // For a renamed module the previous content lives at old_path, so an export
  // dropped during the rename is surfaced (not silently treated as absent).
  // Deliberate scope: a PURE rename that preserves every export is not emitted as
  // a wholesale removal+addition of all symbols — the moved import path is already
  // surfaced as a renamed changed file, and re-listing every symbol on both sides
  // would be noise. Only symbol-level adds/removes/signature changes are facts here.
  const oldText = sources.readBase(baseReadPath(file));
  const newText = sources.readHead(path);
  // A file present on neither side is not analyzable.
  if (oldText === undefined && newText === undefined) {
    return undefined;
  }
  // An ADDED module (no base) makes all its exports new API surface; a DELETED
  // module (no head) removes all of its exports. Both are concrete add/remove
  // facts SEMANTIC_DIFF.2 should surface, so treat the missing side as no
  // exports rather than skipping the file.
  const oldExports = oldText === undefined ? new Map<string, string>() : extractExports(oldText, baseReadPath(file));
  const newExports = newText === undefined ? new Map<string, string>() : extractExports(newText, path);
  const change: ApiSurfaceChange = { path, exports_added: [], exports_removed: [], signatures_changed: [] };
  for (const [name, signature] of newExports) {
    const previous = oldExports.get(name);
    if (previous === undefined) {
      change.exports_added.push(name);
    } else if (previous !== signature) {
      change.signatures_changed.push({ name, from: previous, to: signature });
    }
  }
  for (const name of oldExports.keys()) {
    if (!newExports.has(name)) {
      change.exports_removed.push(name);
    }
  }
  if (change.exports_added.length === 0 && change.exports_removed.length === 0 && change.signatures_changed.length === 0) {
    return undefined;
  }
  return change;
}

// Export extractor: maps an exported symbol name to a normalized signature
// string, parsed from the real TypeScript AST (ts.createSourceFile). The
// signature carries enough of each declaration to detect breaking shape changes:
//   - function: name + type params + parameter list + return type (NOT the body),
//     so a param- or return-type change is a signature change and an
//     implementation edit is not. Overload sets keep every signature.
//   - class: name + type params + heritage (extends/implements), excluding members.
//   - interface/type/enum: the full declaration text (a member addition or alias
//     change is a signature change).
//   - const/let/var: name + type annotation; for an arrow/function-expression
//     initializer, its parameter list + return type (excluding the body).
//   - `export default function/class`, default expressions (keyed `default`),
//     `export =` (keyed `export=`), named re-exports, and `export *`/`export * as`.
// Parsing is pure and deterministic, so base and head are extracted by the same
// rule: a real change is detected and a non-change is not.
function extractExports(source: string, path = "module.ts"): Map<string, string> {
  const scriptKind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const exports = new Map<string, string>();
  // review-surfaces.COLD_START.3: signatures are compared comment-stripped and
  // whitespace-normalized. Slices are raw source text, so without stripping, a
  // doc-comment-only edit inside an exported type reads as a signature change
  // (the got cold-start false positive: two TSDoc lines became the #1 review
  // item). The TS scanner walks the fragment and drops comment trivia; both
  // sides pass through the same rule, so a real change is still detected.
  const stripComments = (text: string): string => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.Standard, text);
    let out = "";
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      out += token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia ? " " : scanner.getTokenText();
      token = scanner.scan();
    }
    return out;
  };
  const norm = (text: string): string => stripComments(text).replace(/\s+/g, " ").trim();
  // The declaration text from its first token to a stop offset, excluding any
  // implementation body so only the contract is compared.
  const slice = (node: ts.Node, stop: number): string => norm(source.slice(node.getStart(sourceFile), stop));
  const hasModifier = (node: ts.HasModifiers, kind: ts.SyntaxKind): boolean =>
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
  const isExported = (node: ts.HasModifiers): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword);
  const defaultOr = (node: ts.HasModifiers, name: string | undefined): string | undefined =>
    hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : name;
  // The offset where a declaration's implementation body begins (its start when
  // bodyless, e.g. an overload, an ambient `.d.ts` declaration, or a namespace
  // head). Slicing up to it compares the contract, not the body.
  const bodyStop = (node: { body?: ts.Node }, fallback: number): number => (node.body ? node.body.getStart(sourceFile) : fallback);

  // Declaration text up to `stop` with the declared name spliced out — identity
  // comes from the export key, so a default export's local name, a function
  // expression's inner name, or a class's own name (which a default importer
  // cannot observe) never create noisy signature changes.
  const sliceExcludingName = (node: ts.Node, nameNode: ts.Node | undefined, stop: number): string =>
    nameNode
      ? norm(source.slice(node.getStart(sourceFile), nameNode.getStart(sourceFile)) + source.slice(nameNode.end, stop))
      : slice(node, stop);

  // A function-like signature is the SHAPE — type params, parameters, return type
  // — name-independent and with the body excluded. `export`/`default`/`async`
  // modifiers before the name are kept.
  const functionLikeSignature = (node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression, prefix: string): string =>
    norm(`${prefix} ${sliceExcludingName(node, node.name, bodyStop(node, node.end))}`);

  // Peel redundant parentheses so `((x) => {})` is recognized as a function.
  const unwrap = (expression: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression;

  // A class's head — type params + extends/implements — name-independent and
  // excluding the member bodies. For an anonymous default class with no heritage
  // the boundary is the body's opening brace.
  const classHeadSignature = (node: ts.ClassDeclaration): string => {
    const headEnd = node.heritageClauses?.at(-1)?.end ?? node.typeParameters?.end ?? node.name?.end;
    const stop = headEnd ?? (node.members.length > 0 ? node.members[0].getStart(sourceFile) : node.end);
    return sliceExcludingName(node, node.name, stop).replace(/\s*\{\s*$/, "");
  };

  // The SHAPE of one variable binding target — name-independent (identity is the
  // export key): an explicit type annotation, a function/arrow initializer's
  // signature (body excluded), or a destructured leaf's own member type.
  const variableLeafSignature = (keyword: string, declaration: ts.VariableDeclaration, target: BindingTarget): string => {
    if (ts.isIdentifier(declaration.name)) {
      if (declaration.type) {
        return norm(`${keyword} ${sliceExcludingName(declaration, declaration.name, declaration.type.end)}`);
      }
      const initializer = declaration.initializer ? unwrap(declaration.initializer) : undefined;
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        return functionLikeSignature(initializer, keyword);
      }
      return keyword;
    }
    const memberType = target.property ? memberTypeText(declaration.type, target.property, slice) : undefined;
    const annotation = memberType ?? (declaration.type ? slice(declaration.type, declaration.type.end) : "");
    return norm(`${keyword}${annotation ? `: ${annotation}` : ""}`);
  };

  // The name-independent signature of a top-level declaration named `name`
  // (exported or not), so an `export default <ident>` or a local `export { ident }`
  // is compared by what the identifier refers to rather than by its text.
  const resolveLocalSignature = (name: string): string | undefined => {
    // Function overloads: aggregate all matching declarations (the public overloads
    // when a set exists, else the standalone function).
    const functions = sourceFile.statements.filter(
      (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name
    );
    if (functions.length > 0) {
      const overloaded = functions.some((fn) => fn.body === undefined);
      const surface = functions.filter((fn) => !(overloaded && fn.body !== undefined));
      return (surface.length > 0 ? surface : functions).map((fn) => functionLikeSignature(fn, "function")).join(" ;; ");
    }
    for (const statement of sourceFile.statements) {
      if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
        return classHeadSignature(statement);
      }
      if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name.text === name) {
        return slice(statement, statement.end);
      }
      if (ts.isVariableStatement(statement)) {
        const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? "const" : statement.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
        for (const declaration of statement.declarationList.declarations) {
          for (const target of bindingTargets(declaration.name)) {
            if (target.name === name) {
              return variableLeafSignature(keyword, declaration, target);
            }
          }
        }
      }
    }
    return undefined;
  };

  // Collect exports from a statement list under a name prefix; recursed for the
  // body of an exported namespace so nested members are part of the surface.
  const collect = (statements: readonly ts.Statement[], prefix: string): void => {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
        const name = defaultOr(statement, statement.name?.text);
        // When an overload SET exists (sibling bodyless declarations of the same
        // name), the bodied declaration is the private implementation — not callable
        // from outside — so its signature is excluded; the public overloads define
        // the surface. A standalone bodied function is the surface and is kept.
        const isOverloadImpl = statement.body !== undefined && statements.some((sibling) =>
          sibling !== statement && ts.isFunctionDeclaration(sibling) && sibling.body === undefined && sibling.name?.text === statement.name?.text && isExported(sibling));
        if (name && !isOverloadImpl) {
          // An overload set shares one name across several signatures; concatenate so
          // adding/removing/altering any overload is a signature change. The
          // signature is name-independent (identity is the key), so a default
          // export's local rename is not a spurious change.
          const key = `${prefix}${name}`;
          const previous = exports.get(key);
          const signature = functionLikeSignature(statement, "function");
          exports.set(key, previous ? `${previous} ;; ${signature}` : signature);
        }
        continue;
      }
      if (ts.isClassDeclaration(statement) && isExported(statement)) {
        const name = defaultOr(statement, statement.name?.text);
        if (name) {
          exports.set(`${prefix}${name}`, classHeadSignature(statement));
        }
        continue;
      }
      if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && isExported(statement)) {
        exports.set(`${prefix}${statement.name.text}`, slice(statement, statement.end));
        continue;
      }
      if (ts.isModuleDeclaration(statement) && isExported(statement) && ts.isIdentifier(statement.name)) {
        // `export namespace N {}` — record its presence/head, then recurse so a
        // change to a nested exported member (N.foo) is part of the API surface.
        // A dotted `namespace A.B {}` nests another ModuleDeclaration as its body;
        // follow the chain so A.B's members are reached under the `A.B.` prefix.
        let moduleName = statement.name.text;
        let body: ts.ModuleBody | undefined = statement.body;
        while (body && ts.isModuleDeclaration(body) && ts.isIdentifier(body.name)) {
          moduleName += `.${body.name.text}`;
          body = body.body;
        }
        exports.set(`namespace:${prefix}${moduleName}`, slice(statement, bodyStop(statement, statement.end)));
        if (body && ts.isModuleBlock(body)) {
          collect(body.statements, `${prefix}${moduleName}.`);
        }
        continue;
      }
      if (ts.isVariableStatement(statement) && isExported(statement)) {
        const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? "const" : statement.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
        for (const declaration of statement.declarationList.declarations) {
          for (const target of bindingTargets(declaration.name)) {
            exports.set(`${prefix}${target.name}`, variableLeafSignature(keyword, declaration, target));
          }
        }
        continue;
      }
      if (ts.isExportAssignment(statement)) {
        // `export default <expr>` (isExportEquals false) or `export = <expr>`.
        // A function/arrow expression is compared by its signature shape (body
        // excluded), so an implementation-only edit is not a spurious change; any
        // other value expression is compared by its full text.
        const word = statement.isExportEquals ? "export=" : "default";
        const key = `${prefix}${word}`;
        const expr = unwrap(statement.expression);
        if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
          exports.set(key, functionLikeSignature(expr, word));
        } else if (ts.isIdentifier(expr)) {
          // `export default handler` — compare by what `handler` refers to (the
          // common local-then-export pattern), falling back to the identifier text.
          exports.set(key, resolveLocalSignature(expr.text) ?? slice(statement, statement.end));
        } else {
          exports.set(key, slice(statement, statement.end));
        }
        continue;
      }
      if (ts.isExportDeclaration(statement)) {
        // Fold the source module into the signature so a re-export's origin change is
        // a fact, and a local `export { x }` and `export { x } from "y"` do not collide.
        const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? ` from ${statement.moduleSpecifier.text}` : "";
        // `type` (statement-level) drops the runtime export — a real contract change
        // for value importers — so it is part of every signature below.
        const statementType = statement.isTypeOnly ? "type " : "";
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const typeOnly = statement.isTypeOnly || element.isTypeOnly ? "type " : "";
            const local = element.propertyName?.text ?? element.name.text;
            // A local `export { handler }` / `export type { Options }` (no `from`)
            // refers to a declaration in this file — compare by what it refers to
            // (resolving local types too) so a change to the local's shape is seen.
            // The type-only marker is kept so a runtime→type-only switch still shows.
            const resolved = from ? undefined : resolveLocalSignature(local);
            // `propertyName` (the binding before `as`) makes an alias-target change
            // (`{ a as x }` → `{ b as x }`) a fact.
            const target = element.propertyName ? `${element.propertyName.text} as ` : "";
            exports.set(`${prefix}${element.name.text}`, resolved ? `${typeOnly}${resolved}` : `named ${typeOnly}${target}${element.name.text}${from}`);
          }
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
          exports.set(`${prefix}${statement.exportClause.name.text}`, `namespace-reexport ${statementType}${statement.exportClause.name.text}${from}`);
        } else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          // `export * from "./x"` — keyed by the source module so adding/removing the
          // star re-export is detected even though the names cannot be enumerated.
          exports.set(`*:${prefix}${statement.moduleSpecifier.text}`, `export-star ${statementType}${statement.moduleSpecifier.text}`);
        }
        continue;
      }
    }
  };

  collect(sourceFile.statements, "");
  return exports;
}

// The identifier leaves bound by a variable declaration name: the single
// identifier itself, or each identifier in a destructuring `{ a, b }` / `[a, b]`
// pattern — so `export const { a, b } = x` records both `a` and `b`. `property` is
// the source property name a DIRECT object-pattern leaf reads (so its type can be
// looked up in a type-literal annotation); undefined for nested or array leaves.
interface BindingTarget {
  name: string;
  node: ts.Node;
  property?: string;
}

function bindingTargets(name: ts.BindingName): BindingTarget[] {
  if (ts.isIdentifier(name)) {
    return [{ name: name.text, node: name }];
  }
  const targets: BindingTarget[] = [];
  for (const element of name.elements) {
    if (!ts.isBindingElement(element)) {
      continue;
    }
    const property = ts.isObjectBindingPattern(name)
      ? (element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : undefined)
      : undefined;
    for (const leaf of bindingTargets(element.name)) {
      // Only a DIRECT leaf (the element's own identifier) gets this element's
      // property; a nested-pattern leaf keeps its own (undefined) property.
      targets.push({ ...leaf, property: leaf.node === element.name ? property : leaf.property });
    }
  }
  return targets;
}

// The text of the member type for `property` within a type-literal annotation, so
// a destructured leaf's signature reflects only its own member. Undefined when the
// annotation is absent, not a type literal, or has no matching member.
function memberTypeText(typeNode: ts.TypeNode | undefined, property: string, slice: (node: ts.Node, stop: number) => string): string | undefined {
  if (!typeNode || !ts.isTypeLiteralNode(typeNode)) {
    return undefined;
  }
  for (const member of typeNode.members) {
    if (ts.isPropertySignature(member) && member.type && ts.isIdentifier(member.name) && member.name.text === property) {
      // Keep optionality (`a?: string` widens the leaf's type to include undefined)
      // so a required↔optional change is a real, detected contract change.
      return `${member.questionToken ? "?" : ""}${slice(member.type, member.type.end)}`;
    }
  }
  return undefined;
}

// --- helpers ---------------------------------------------------------------

function parseJson(text: string | undefined): unknown {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function enumValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// A canonical identity key for an enum member, so members are compared as JSON
// values rather than by string identity (`1` and `"1"` are distinct members).
function enumKey(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

// The recorded/displayed form of an enum member: strings as-is, everything else
// (numbers, booleans, null) as its JSON literal.
function enumDisplay(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

function typeLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string").join("|") || undefined;
  }
  return undefined;
}

function fieldPath(pointer: string, field: string): string {
  return pointer ? `${pointer}.${field}` : field;
}

function childPointer(pointer: string, container: string, key: string): string {
  const head = pointer ? `${pointer}.${container}` : container;
  return `${head}.${key}`;
}
